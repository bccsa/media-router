import * as dgram from 'dgram';
import * as fs from 'fs';
import {
    GstPluginBase,
    isMulticast,
    probeGstElement,
    type EngineServices,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import { listDrmConnectors, pickActiveDisplay } from '@media-router/engine';
import {
    COG_POLL_INTERVAL_MS,
    currentWaylandSessionIdent,
    ensureWaylandEnv,
    findCogPidForDisplay,
    hasWaylandSession,
    waitForWaylandSocket,
} from './helpers/wayland.js';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildPipelineEnv,
    buildSink,
    resolveFallbackImagePath,
    type SinkSelectionEnv,
} from './helpers/pipelines.js';

type SinkAvailability = { wayland: boolean; kms: boolean };

/**
 * Video Player plugin.
 *
 * Terminal sink module. Consumes an MPEG-TS stream from the UDP multicast
 * routing layer, decodes it, and renders to a DRM/KMS display. When no
 * source is connected (or when the connected source stops flowing), it
 * shows a SMPTE test pattern with a "No video detected" overlay so the
 * display never goes blank.
 *
 * Owns the `drm-connector` device type.
 */
export class VideoPlayerModule extends GstPluginBase {
    // `fallbackText` is "live" only in the *fallback* pipeline — the `nov`
    // textoverlay element doesn't exist in the live (udpsrc → decodebin)
    // pipeline. With a source connected, a fallbackText change is silently
    // deferred to the next fallback render. See onLiveConfigUpdate for the
    // hasSource guard that enforces this.
    protected liveUpdatableParams = ['fallbackText'];

    /** Probed once at plugin load — set by `initManifest`. */
    private static sinks: SinkAvailability = { wayland: false, kms: false };

    // Wayland-restart tracking. When Weston/labwc restarts the wayland socket
    // is replaced (new inode, possibly new name). gst-runner children built
    // against the old socket keep "playing" against a dead connection — the
    // pipeline doesn't report an error because waylandsink doesn't observe
    // the broken socket until it tries to draw the next buffer, by which
    // time the compositor restart has reattached our surface to nothing.
    // Watching the runtime dir for socket replacement lets us proactively
    // restart the pipeline against the fresh session.
    private static runningInstances = new Set<VideoPlayerModule>();
    private static waylandWatcher: fs.FSWatcher | null = null;
    private static waylandDebounceTimer: NodeJS.Timeout | null = null;
    /** `<filename>:<inode>` of the currently-known compositor socket. Empty when none. */
    private static waylandSessionIdent: string = '';
    /**
     * Per-instance latch so concurrent restart triggers (wayland session
     * change, cog respawn, UDP stall) collapse to one onStop+onStart cycle.
     * Also doubles as "we're in an internal restart, don't clear state that
     * needs to survive the rebuild" — `onStop` checks this before clearing
     * the UDP-stall latch.
     */
    private pipelineRestartInProgress = false;
    // Kiosk-browser (cog) PID tracking. Kiosk-shell stacks toplevels by
    // surface-creation time — when the cog browser on our output respawns
    // (URL change, crash, etc.) its new surface ends up above the video's,
    // making the player look frozen even though the pipeline is still
    // happily decoding. We can't observe wayland surface stacking from
    // outside the compositor, but we can observe cog process restarts via
    // /proc and use that as a proxy: when the PID of the cog instance
    // pinned to our active display changes, kick a pipeline restart so
    // our surface becomes the newest one and lands back on top.
    private cogPollTimer: NodeJS.Timeout | null = null;
    private lastCogPid: number | undefined = undefined;

    // Source-silent fallback. When the UDP source's `timeout` fires the
    // Python runner tags the error with `kind: 'udp_timeout'`. We latch
    // a flag so the next pipeline build returns the colour-bars fallback
    // instead of looping on a live pipeline that's just going to time
    // out again. The latch is cleared by `udpResumeProbe` below the
    // moment a real packet arrives on the source port.
    private udpStallDetected = false;
    /**
     * Passive UDP listener bound to the source port while we're on the
     * colour-bars fallback. The moment a single packet arrives we know the
     * source has resumed and can switch the pipeline back to live — no
     * periodic retry (which would tear down the visible fallback every
     * cycle and leave a black gap during the 5s udpsrc probe).
     */
    private udpResumeProbe: dgram.Socket | null = null;
    /**
     * Watchdog interval — checks once a second that the resume probe is
     * still alive while we're latched in fallback, recreating it if not.
     * Runs on all hosts (not just wayland), since UDP stall can happen on
     * any sink path.
     */
    private udpResumeWatchdog: NodeJS.Timeout | null = null;

    static registerServices(services: EngineServices): void {
        services.deviceProviders.register({
            type: 'drm-connector',
            list: () => listDrmConnectors(),
            pollMs: 2000,
        });
        // Engines launched via SSH inherit no Wayland env. If a compositor
        // socket exists in the user runtime dir, point the engine (and its
        // gst-runner children) at it so `waylandsink` can connect. Idempotent
        // for desktop sessions where these are already set.
        ensureWaylandEnv();
    }

    static async initManifest(_manifest: Record<string, unknown>): Promise<void> {
        const [wayland, kms] = await Promise.all([
            probeGstElement('waylandsink'),
            probeGstElement('kmssink'),
        ]);
        VideoPlayerModule.sinks = { wayland, kms };
    }

    static getSinkAvailability(): SinkAvailability {
        return VideoPlayerModule.sinks;
    }

    static setSinkAvailability(value: SinkAvailability): void {
        VideoPlayerModule.sinks = value;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        // If waylandsink is installed (i.e. this host is *expected* to render
        // through a Wayland compositor) but the wayland socket isn't here
        // yet, give the compositor a brief window to come up. Without this
        // an engine that boots before labwc/Weston picks the KMS fallback
        // and stays there for the lifetime of the pyProcess — even when the
        // compositor appears 2s later. Seen in production after a power
        // outage on 10.9.1.166: kmssink then either parse-errors (older
        // builds without `connector-name`) or loses the DRM master fight
        // with the compositor. 10s is plenty of headroom for a normal boot
        // and bounded enough that genuinely-headless hosts still fall
        // through promptly.
        if (VideoPlayerModule.sinks.wayland) {
            await waitForWaylandSocket(10_000);
        }
        await super.onStart();
        this.updateStatusData();
        this.installUdpStallListener();
        VideoPlayerModule.registerForWaylandRestartWatch(this);
        this.startCogPollWatch();
    }

    async onStop(): Promise<void> {
        this.stopCogPollWatch();
        this.stopUdpResumeWatchdog();
        // During an *internal* restart cycle (latched by pipelineRestartInProgress)
        // we deliberately keep the UDP-stall latch + its resume probe alive so
        // the rebuilt pipeline picks the fallback path that triggered this
        // very restart. On an external stop (user disabled, engine shutdown)
        // we wipe the state — a fresh start should never inherit a stale
        // fallback decision.
        if (!this.pipelineRestartInProgress) {
            this.clearUdpStallState();
        }
        VideoPlayerModule.unregisterForWaylandRestartWatch(this);
        await super.onStop();
    }

    /**
     * Subscribe to the fresh childProcess created by super.onStart() so we
     * can react to UDP-timeout events with a fallback switch instead of
     * looping on the live pipeline.
     */
    private installUdpStallListener(): void {
        if (!this.childProcess) return;
        this.childProcess.on('error', (data: { kind?: string; message?: string }) => {
            if (data?.kind !== 'udp_timeout') return;
            if (this.udpStallDetected) return;
            this.log.info('UDP source went silent — switching to fallback pattern');
            this.udpStallDetected = true;
            this.startUdpResumeProbe();
            this.startUdpResumeWatchdog();
            // gst-runner's restartOnError will replay the *same* live pipeline
            // desc — it doesn't ask the plugin for a new one. Trigger a full
            // restart so buildPipeline is re-called with udpStallDetected set
            // and the colour-bars fallback is actually built. The latch in
            // restartPipeline coalesces this with any other in-flight restart.
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        });
    }

    /**
     * Open a passive dgram socket on the source's UDP port and wait for the
     * first packet. Arrival = source resumed = switch back to live. Beats
     * the old periodic-retry approach because the colour-bars fallback
     * stays continuously visible while we wait (no 5 s black gap every
     * retry interval) and resume latency is bounded by the time of one
     * UDP packet rather than by an arbitrary timer.
     *
     * SO_REUSEADDR lets us share the bind with gst-runner's own udpsrc
     * (which, when live is *attempted*, also binds the same port). While
     * we're in fallback gst-runner isn't listening, so the probe is alone
     * on the port.
     */
    private startUdpResumeProbe(): void {
        if (this.udpResumeProbe) return;
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (!udpSource) return;
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        // Don't close the probe on a transient socket error. Reported bug:
        // player ran for hours on fallback, source resumed, player stayed
        // on fallback until manually restarted. Cause: a stray dgram
        // `error` (e.g. an ICMP unreachable echo on another mcast member)
        // tore down the probe; we then sat permanently deaf with no
        // recovery. Logging keeps the visibility; the watchdog
        // (`ensureUdpResumeProbe`, ticking every second alongside the
        // cog watcher) re-creates the probe if it really did die.
        sock.on('error', (err) => {
            this.log.debug({ err }, 'UDP resume probe socket error (keeping probe alive)');
        });
        let resumed = false;
        sock.on('message', () => {
            if (resumed) return;
            resumed = true;
            this.log.info('Source resumed — restarting live pipeline');
            this.stopUdpResumeProbe();
            this.udpStallDetected = false;
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        });
        sock.bind(udpSource.port, () => {
            try {
                if (isMulticast(udpSource.host)) {
                    // Engine-internal mcast traffic flows on loopback
                    // (`multicast-iface=lo` in the engine's udpsrc/udpsink
                    // pipelines). Calling `addMembership` without an
                    // interface picks the default route's interface
                    // (eth0/wlan0) and misses every packet — the probe
                    // sits silent forever and the player never returns
                    // from fallback. Join explicitly on 127.0.0.1.
                    sock.addMembership(udpSource.host, '127.0.0.1');
                }
            } catch (err) {
                this.log.debug({ err, host: udpSource.host }, 'addMembership failed on resume probe');
            }
        });
        this.udpResumeProbe = sock;
    }

    /**
     * Watchdog: when we're latched in fallback (`udpStallDetected`) but
     * the probe socket is gone — e.g. the dgram subsystem closed it
     * outside our control, or an addMembership renew failed — recreate
     * it. Without this safety net, a single missed probe meant the
     * player stayed on fallback forever, and the operator had to manually
     * restart the module to recover.
     */
    private ensureUdpResumeProbe(): void {
        if (!this.udpStallDetected) return;
        if (this.udpResumeProbe) return;
        this.startUdpResumeProbe();
    }

    private startUdpResumeWatchdog(): void {
        if (this.udpResumeWatchdog) return;
        // 1 Hz is plenty — worst case is one extra second of fallback
        // after a transient probe loss. Lifetime is bounded to "we're
        // latched in fallback": started in the udp-timeout listener
        // alongside `startUdpResumeProbe`, stopped in `stopUdpResumeProbe`.
        this.udpResumeWatchdog = setInterval(() => {
            this.ensureUdpResumeProbe();
        }, 1000);
    }

    private stopUdpResumeWatchdog(): void {
        if (this.udpResumeWatchdog) {
            clearInterval(this.udpResumeWatchdog);
            this.udpResumeWatchdog = null;
        }
    }

    private stopUdpResumeProbe(): void {
        if (!this.udpResumeProbe) return;
        try {
            this.udpResumeProbe.close();
        } catch {
            /* already closed */
        }
        this.udpResumeProbe = null;
        // The watchdog only exists to keep the probe alive while we're
        // latched in fallback. Once the probe is intentionally closed
        // (resume detected or external stop) there's nothing for it to do.
        this.stopUdpResumeWatchdog();
    }

    /** Wipe stall state on an external stop — fresh start should never inherit a stale fallback decision. */
    private clearUdpStallState(): void {
        this.stopUdpResumeProbe();
        this.udpStallDetected = false;
    }

    /**
     * Begin polling /proc for the cog process pinned to our active display.
     * Only meaningful on the wayland path — on KMS we own the connector
     * directly and kiosk-shell isn't involved. Initial PID is captured
     * silently so the first poll doesn't trigger a spurious restart on
     * startup. Subsequent PID changes (cog respawning, e.g. after a URL
     * change) trigger a pipeline restart so the video surface gets
     * recreated on top of the new browser surface.
     */
    private startCogPollWatch(): void {
        if (this.cogPollTimer) return;
        if (!VideoPlayerModule.sinks.wayland || !hasWaylandSession()) return;
        const display = this.currentActiveDisplayName();
        if (!display) return;
        this.lastCogPid = findCogPidForDisplay(display);
        this.cogPollTimer = setInterval(() => {
            const activeDisplay = this.currentActiveDisplayName();
            if (!activeDisplay) return;
            const current = findCogPidForDisplay(activeDisplay);
            if (current === undefined) return; // cog mid-restart, wait
            if (this.lastCogPid === undefined) {
                this.lastCogPid = current;
                return;
            }
            if (current === this.lastCogPid) return;
            const previous = this.lastCogPid;
            this.lastCogPid = current;
            this.log.info(
                { display: activeDisplay, previousPid: previous, newPid: current },
                'Kiosk browser respawned on our output — restarting video pipeline',
            );
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        }, COG_POLL_INTERVAL_MS);
    }

    private stopCogPollWatch(): void {
        if (this.cogPollTimer) {
            clearInterval(this.cogPollTimer);
            this.cogPollTimer = null;
        }
        this.lastCogPid = undefined;
    }

    private currentActiveDisplayName(): string {
        const requested = (this.config?.display as string) ?? '';
        return pickActiveDisplay(requested).name;
    }


    /**
     * Trigger a clean pipeline restart against the *current* wayland session.
     * Used by both the runtime-dir watcher (compositor socket replaced) and
     * the cog-PID watcher (kiosk browser respawned). Callers log their own
     * trigger reason first; this method only logs failure. Latched so
     * overlapping triggers collapse to a single cycle.
     */
    private async restartPipeline(): Promise<void> {
        if (this.pipelineRestartInProgress) return;
        this.pipelineRestartInProgress = true;
        try {
            await this.onStop();
            await this.onStart();
        } catch (err) {
            this.log.warn({ err }, 'Pipeline restart cycle failed');
        } finally {
            this.pipelineRestartInProgress = false;
        }
    }

    private static registerForWaylandRestartWatch(instance: VideoPlayerModule): void {
        VideoPlayerModule.runningInstances.add(instance);
        VideoPlayerModule.installWaylandWatcher();
    }

    private static unregisterForWaylandRestartWatch(instance: VideoPlayerModule): void {
        VideoPlayerModule.runningInstances.delete(instance);
        if (VideoPlayerModule.runningInstances.size === 0) {
            VideoPlayerModule.teardownWaylandWatcher();
        }
    }

    /**
     * Watch the user runtime dir for wayland socket replacement. We can't use
     * the *socket file itself* as the watch target — when Weston restarts the
     * old inode is unlinked and fs.watch silently goes mute. Watching the
     * containing directory survives that.
     *
     * Exposed for tests via the public `_test_*` helpers below.
     */
    private static installWaylandWatcher(): void {
        if (VideoPlayerModule.waylandWatcher) return;
        const runtime = process.env.XDG_RUNTIME_DIR;
        if (!runtime) return;
        VideoPlayerModule.waylandSessionIdent = currentWaylandSessionIdent(runtime);
        try {
            VideoPlayerModule.waylandWatcher = fs.watch(runtime, (_event, filename) => {
                if (!filename || !/^wayland-\d+/.test(String(filename))) return;
                VideoPlayerModule.scheduleWaylandRestartCheck();
            });
            VideoPlayerModule.waylandWatcher.on('error', () => {
                /* runtime dir disappeared — watcher will be reinstalled on next start */
                VideoPlayerModule.teardownWaylandWatcher();
            });
        } catch {
            /* runtime dir not watchable — silently skip; pipeline still works,
               it just won't self-heal across a compositor restart */
        }
    }

    private static teardownWaylandWatcher(): void {
        if (VideoPlayerModule.waylandDebounceTimer) {
            clearTimeout(VideoPlayerModule.waylandDebounceTimer);
            VideoPlayerModule.waylandDebounceTimer = null;
        }
        if (VideoPlayerModule.waylandWatcher) {
            try { VideoPlayerModule.waylandWatcher.close(); } catch { /* already closed */ }
            VideoPlayerModule.waylandWatcher = null;
        }
        VideoPlayerModule.waylandSessionIdent = '';
    }

    /**
     * Debounce socket events: Weston's restart sequence usually fires
     * delete + create within a few hundred ms, sometimes with an intermediate
     * `.lock` rename. Coalescing to a single restart-decision avoids
     * tearing the pipeline down twice.
     */
    private static scheduleWaylandRestartCheck(): void {
        if (VideoPlayerModule.waylandDebounceTimer) {
            clearTimeout(VideoPlayerModule.waylandDebounceTimer);
        }
        VideoPlayerModule.waylandDebounceTimer = setTimeout(() => {
            VideoPlayerModule.waylandDebounceTimer = null;
            const runtime = process.env.XDG_RUNTIME_DIR;
            if (!runtime) return;
            const ident = currentWaylandSessionIdent(runtime);
            // No socket present (mid-restart) → wait for the next event.
            if (!ident) return;
            // Same session we already know about → spurious event, ignore.
            if (ident === VideoPlayerModule.waylandSessionIdent) return;
            VideoPlayerModule.waylandSessionIdent = ident;
            for (const inst of [...VideoPlayerModule.runningInstances]) {
                inst.log.info({ ident }, 'Wayland session changed — restarting video pipeline');
                inst.restartPipeline().catch(() => {
                    /* logged in the per-instance handler */
                });
            }
        }, 500);
    }

    // --- test-only hooks ---
    static _test_getRunningInstances(): ReadonlySet<VideoPlayerModule> {
        return VideoPlayerModule.runningInstances;
    }
    static _test_resetWaylandWatcher(): void {
        VideoPlayerModule.teardownWaylandWatcher();
        VideoPlayerModule.runningInstances.clear();
    }
    static _test_triggerWaylandCheck(): void {
        VideoPlayerModule.scheduleWaylandRestartCheck();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('fallbackText' in changes) {
            // The `nov` text overlay only exists in the *fallback* pipeline
            // (videotestsrc branch). The fallback runs when there's no UDP
            // source assigned, OR when the source is assigned but silent
            // (udpStallDetected — colour-bars-while-source-down path). In
            // both states the element exists and the live push is safe.
            // With a healthy live source there's no `nov` element and the
            // new text takes effect the next time the fallback pipeline is
            // built (source disconnect, stall, module restart).
            const instanceId = this.services?.instanceId ?? '';
            const hasSource = !!this.services?.mediaRouter?.getModuleUdpSource(instanceId);
            const fallbackPipelineActive = !hasSource || this.udpStallDetected;
            if (fallbackPipelineActive) {
                const text = changes.fallbackText as string;
                await this.setElementProperty('nov', 'text', text).catch((err) =>
                    this.log.debug({ err }, 'Failed to update fallback text overlay'),
                );
            }
        }
        this.updateStatusData();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        const fallback = (config.fallbackText as string) ?? 'No video detected';
        const rawImagePath = (config.fallbackImagePath as string) ?? '';
        const fallbackImage = resolveFallbackImagePath(rawImagePath);
        if (rawImagePath && !fallbackImage) {
            // Path was provided but unusable (missing / not readable / unsafe
            // characters). Don't tear the pipeline down — fall through to the
            // SMPTE pattern and surface the misconfiguration to the operator.
            this.log.warn(
                { path: rawImagePath },
                'fallbackImagePath not usable — falling back to SMPTE colour bars',
            );
        }
        const requestedDisplay = (config.display as string) ?? '';
        // If the user-picked connector isn't `connected`, fall through to the
        // first connector that is. Both kmssink (via connector-id) and
        // waylandsink (via the MR_GLIB_PRGNAME app_id that kiosk-shell pins
        // to per-output `app-ids=` in weston.ini) need the *active* display
        // name, otherwise the surface lands on an output that isn't lit and
        // looks the same to the user as "video player won't start".
        const active = pickActiveDisplay(requestedDisplay);
        const sinkEnv: SinkSelectionEnv = {
            ...VideoPlayerModule.sinks,
            waylandSession: hasWaylandSession(),
            connectorId: active.connectorId,
        };
        const sinkElement = buildSink(active.name, sinkEnv, {
            qos: (this.config.qos as boolean | undefined) ?? true,
            sync: (this.config.sync as boolean | undefined) ?? false,
        });
        const env = buildPipelineEnv(active.name, sinkEnv);
        // The wayland (kiosk-shell fullscreen) path needs the live surface
        // pinned to a fixed size so it matches the fallback surface; KMS /
        // autovideosink should keep native resolution. See buildLivePipeline.
        const waylandFullscreen = sinkEnv.wayland && sinkEnv.waylandSession;

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        const sourceSilent = !!udpSource && this.udpStallDetected;
        const useFallback = !udpSource || sourceSilent;

        if (active.substituted) {
            this.setHealth(
                'warning',
                `Display "${requestedDisplay}" not connected — using "${active.name}"`,
            );
        } else if (sourceSilent) {
            this.setHealth('warning', 'Source silent — showing fallback pattern');
        } else if (!udpSource) {
            this.setHealth('warning', 'No video connected');
        } else {
            this.setHealth('ok');
        }

        if (useFallback) {
            return {
                pipeline: buildFallbackOnlyPipeline(fallback, sinkElement, fallbackImage),
                liveElements: { nov: ['text'] },
                restartOnError: true,
                env,
            };
        }

        return {
            pipeline: buildLivePipeline(
                sinkElement,
                udpSource,
                waylandFullscreen,
                Number(this.config.bufferMs ?? 200),
            ),
            liveElements: {},
            restartOnError: true,
            env,
        };
    }

    private updateStatusData(): void {
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        this.setStatusData('input', {
            source: udpSource ? `${udpSource.host}:${udpSource.port}` : '—',
            state: udpSource ? 'connected' : 'no source',
        });

        // Mirror the selection logic in `buildSink` so the user sees the
        // render path that's actually being used, not a stale DRM assumption.
        // `status` carries only the renderer-reachability state (compositor /
        // connected / no display / unavailable). Target-mismatch is conveyed
        // by the optional `requested` field, only set when the user picked a
        // display and we substituted a different one — the substitution is
        // implicit in the presence of `requested`, so there's no separate
        // boolean to render as a noisy "substituted: —" row.
        const requestedDisplay = (this.config.display as string) ?? '';
        const active = pickActiveDisplay(requestedDisplay);
        const env = {
            ...VideoPlayerModule.sinks,
            waylandSession: hasWaylandSession(),
        };
        let renderPath = 'autovideosink';
        let target = '—';
        let status = 'unavailable';
        if (env.wayland && env.waylandSession) {
            renderPath = 'waylandsink';
            target = active.name || process.env.WAYLAND_DISPLAY || 'wayland';
            status = 'compositor';
        } else if (active.name && env.kms) {
            renderPath = 'kmssink';
            target = active.name;
            status = 'connected';
        } else if (env.kms) {
            const firstConnected = listDrmConnectors().find(
                (c) => (c.meta?.status as string) === 'connected',
            );
            renderPath = 'kmssink';
            target = firstConnected?.name ?? '(auto)';
            status = firstConnected ? 'connected' : 'no display';
        }
        const displayStatus: Record<string, string> = {
            renderer: renderPath,
            target,
            status,
        };
        if (active.substituted) displayStatus.requested = requestedDisplay;
        this.setStatusData('display', displayStatus);
    }
}
