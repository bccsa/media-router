import * as fs from 'fs';
import {
    GstPluginBase,
    probeGstElement,
    probeUnixSocket,
    type EngineServices,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    firstConnectedDisplay,
    listDrmConnectors,
    pickActiveDisplay,
    resolveConnectorMode,
} from '@media-router/engine';
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
    DEFAULT_SURFACE,
    resolveDecoderThreadType,
    resolveFallbackImagePath,
    RESUME_SINK_NAME,
    type SinkSelectionEnv,
} from './helpers/pipelines.js';
import { resolveWestonSurface } from './helpers/westonOutput.js';

type SinkAvailability = { wayland: boolean; kms: boolean };

/**
 * Video Player plugin.
 *
 * Terminal sink module. Consumes an MPEG-TS stream from the inter-module
 * bus, decodes it, and renders to a DRM/KMS display. When no
 * source is connected (or when the connected source stops flowing), it
 * shows a SMPTE test pattern with a "No video detected" overlay so the
 * display never goes blank.
 *
 * Owns the `drm-connector` device type.
 */
export class VideoPlayerModule extends GstPluginBase {
    // `fallbackText` is "live" only in the *fallback* pipeline — the `nov`
    // textoverlay element doesn't exist in the live (bus → decodebin)
    // pipeline. With a source connected, a fallbackText change is silently
    // deferred to the next fallback render. See onLiveConfigUpdate for the
    // hasSource guard that enforces this.
    protected liveUpdatableParams = ['fallbackText', 'lipSyncMs'];

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
     * change, cog respawn, bus stall) collapse to one onStop+onStart cycle.
     * Also doubles as "we're in an internal restart, don't clear state that
     * needs to survive the rebuild" — `onStop` checks this before clearing
     * the bus-stall latch.
     */
    private pipelineRestartInProgress = false;
    /** A restart trigger arrived mid-cycle — run one follow-up cycle so the
     *  pipeline converges on the latest state (see restartPipeline). */
    private pipelineRestartPending = false;
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

    // Source-silent fallback. When the live pipeline's stall watchdog fires
    // (no buffer off the bus socket for 5 s) the Python runner tags the
    // error with `kind: 'bus_stall'`. We latch a flag so the next pipeline
    // build returns the colour-bars fallback instead of looping on a live
    // pipeline that's just going to stall again. The latch is cleared by
    // the resume poller below the moment bytes flow again.
    private busStallDetected = false;
    /**
     * Whether the current fallback pipeline carries the bus-resume tap
     * (`unixfdsrc ! fakesink resume_sink` draining this module's own
     * fan-out edge). Built in only when the edge socket existed at build
     * time — see buildPipeline.
     */
    private resumeTapActive = false;
    /** Last byte count read off the resume tap — advance = source resumed. */
    private lastResumeBytes: number | undefined;
    /**
     * 1 Hz resume poller, alive while we're latched in fallback. With the
     * tap active it reads the tap's byte counter (bytes advancing = source
     * resumed → switch back to live, colour bars visible the whole wait —
     * same no-black-gap property the old passive dgram probe had). Without
     * the tap (producer socket was missing) it probes for the edge socket
     * reappearing and then retries live directly.
     */
    private busResumeWatchdog: NodeJS.Timeout | null = null;

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
        this.installBusStallListener();
        VideoPlayerModule.registerForWaylandRestartWatch(this);
        this.startCogPollWatch();
    }

    async onStop(): Promise<void> {
        this.stopCogPollWatch();
        this.stopBusResumeWatchdog();
        // During an *internal* restart cycle (latched by pipelineRestartInProgress)
        // we deliberately keep the bus-stall latch alive so the rebuilt
        // pipeline picks the fallback path that triggered this very restart
        // (onStart re-arms the resume poller from the latch). On an external
        // stop (user disabled, engine shutdown) we wipe the state — a fresh
        // start should never inherit a stale fallback decision.
        if (!this.pipelineRestartInProgress) {
            this.clearBusStallState();
        }
        VideoPlayerModule.unregisterForWaylandRestartWatch(this);
        await super.onStop();
    }

    /**
     * Subscribe to the fresh childProcess created by super.onStart() so we
     * can react to bus-stall events with a fallback switch instead of
     * looping on the live pipeline. Also (re)arms the resume poller when a
     * restart cycle rebuilt the pipeline with the latch already set.
     */
    private installBusStallListener(): void {
        if (this.busStallDetected) this.startBusResumeWatchdog();
        if (!this.childProcess) return;
        this.childProcess.on('error', (data: { kind?: string; message?: string }) => {
            if (data?.kind !== 'bus_stall') return;
            if (this.busStallDetected) return;
            this.log.info('Bus source went silent — switching to fallback pattern');
            this.busStallDetected = true;
            this.startBusResumeWatchdog();
            // gst-runner's restartOnError will replay the *same* live pipeline
            // desc — it doesn't ask the plugin for a new one. Trigger a full
            // restart so buildPipeline is re-called with busStallDetected set
            // and the colour-bars fallback is actually built. The latch in
            // restartPipeline coalesces this with any other in-flight restart.
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        });
    }

    /**
     * One resume-poller tick. TAP MODE (fallback built with the resume tap):
     * read the tap's sink-pad byte counter via the runner's throughput
     * tracker; bytes advancing = the producer is emitting again → clear the
     * latch and rebuild live. The colour-bars fallback stays continuously
     * visible while we wait (no black gap), resume latency ≤ ~2 ticks.
     * NO-TAP MODE (edge socket was missing at build time — producer down):
     * probe for the socket reappearing (same connect-probe the consumer
     * start gate uses) and then retry live directly — a freshly respawned
     * producer is most likely flowing, and if it is dark the live
     * pipeline's stall watchdog just sends us back here within 5 s.
     */
    private async pollBusResume(): Promise<void> {
        if (!this.busStallDetected || this.pipelineRestartInProgress) return;
        const instanceId = this.services?.instanceId ?? '';
        const source = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        if (!source) return;
        let resumed = false;
        if (this.resumeTapActive) {
            const bytes = await this.readBusSinkBytes(RESUME_SINK_NAME);
            if (
                bytes !== undefined &&
                this.lastResumeBytes !== undefined &&
                bytes > this.lastResumeBytes
            ) {
                resumed = true;
            }
            if (bytes !== undefined) this.lastResumeBytes = bytes;
        } else if (source.socketPath && (await probeUnixSocket(source.socketPath))) {
            resumed = true;
        }
        if (!resumed || !this.busStallDetected) return;
        this.log.info('Source resumed — restarting live pipeline');
        this.busStallDetected = false;
        this.stopBusResumeWatchdog();
        this.restartPipeline().catch(() => {
            /* logged inside */
        });
    }

    private startBusResumeWatchdog(): void {
        if (this.busResumeWatchdog) return;
        this.lastResumeBytes = undefined;
        // 1 Hz is plenty — worst case is one extra second of fallback.
        // Lifetime is bounded to "we're latched in fallback": armed by the
        // bus_stall listener (and re-armed by installBusStallListener after
        // each internal restart), stopped on resume / external stop.
        this.busResumeWatchdog = setInterval(() => {
            this.pollBusResume().catch((err) => {
                this.log.debug({ err }, 'bus resume poll failed');
            });
        }, 1000);
    }

    private stopBusResumeWatchdog(): void {
        if (this.busResumeWatchdog) {
            clearInterval(this.busResumeWatchdog);
            this.busResumeWatchdog = null;
        }
        this.lastResumeBytes = undefined;
    }

    /** Wipe stall state on an external stop — fresh start should never inherit a stale fallback decision. */
    private clearBusStallState(): void {
        this.stopBusResumeWatchdog();
        this.busStallDetected = false;
        this.resumeTapActive = false;
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
     * Used by the runtime-dir watcher (compositor socket replaced), the
     * cog-PID watcher (kiosk browser respawned), and the bus stall/resume
     * switches. Callers log their own trigger reason first; this method only
     * logs failure.
     *
     * A trigger that lands while a cycle is mid-flight queues ONE follow-up
     * cycle instead of being dropped. Dropping it froze the player on a stale
     * build: source went silent → fallback restart started → source resumed
     * 2 s later (clearing `busStallDetected`) → the resume restart was
     * discarded by the old in-progress latch → the fallback pipeline (built
     * from the stale flag) stayed up forever with healthy data underneath.
     * The follow-up cycle re-runs buildPipeline against the LATEST state, so
     * back-to-back stall/resume flips always converge.
     */
    private async restartPipeline(): Promise<void> {
        if (this.pipelineRestartInProgress) {
            this.pipelineRestartPending = true;
            return;
        }
        this.pipelineRestartInProgress = true;
        try {
            do {
                this.pipelineRestartPending = false;
                try {
                    await this.onStop();
                    await this.onStart();
                } catch (err) {
                    this.log.warn({ err }, 'Pipeline restart cycle failed');
                }
            } while (this.pipelineRestartPending);
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
            // (videotestsrc branch). The fallback runs when there's no bus
            // source assigned, OR when the source is assigned but silent
            // (busStallDetected — colour-bars-while-source-down path). In
            // both states the element exists and the live push is safe.
            // With a healthy live source there's no `nov` element and the
            // new text takes effect the next time the fallback pipeline is
            // built (source disconnect, stall, module restart).
            const instanceId = this.services?.instanceId ?? '';
            const hasSource = !!this.services?.mediaRouter?.getModuleBusSource(instanceId);
            const fallbackPipelineActive = !hasSource || this.busStallDetected;
            if (fallbackPipelineActive) {
                const text = changes.fallbackText as string;
                await this.setElementProperty('nov', 'text', text).catch((err) =>
                    this.log.debug({ err }, 'Failed to update fallback text overlay'),
                );
            }
        }
        if ('lipSyncMs' in changes) {
            // Live lip-sync trim — push the new ts-offset to the running video
            // `sink` (no rebuild). Only bites when the sink is sync=true.
            const ns = Math.round(Number(changes.lipSyncMs ?? 0) * 1_000_000);
            await this.setElementProperty('sink', 'ts-offset', ns).catch((err) =>
                this.log.debug({ err }, 'Failed to update lip-sync ts-offset'),
            );
        }
        this.updateStatusData();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
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
        // Headless guard: this host has DRM connectors but none is a connected
        // physical output (`Writeback-*` is the compositor's virtual screencast
        // sink, not a screen) — there is nowhere to render. Return no pipeline
        // instead of letting a sink error-loop (kmssink has no connector to
        // drive, and waylandsink has no compositor since Weston itself can't
        // start without a display), and set health so the manager UI shows WHY
        // there's no video. Recovery is automatic: when a display is plugged
        // in the compositor comes up, the wayland-session watcher sees the
        // fresh socket and restartPipeline() re-evaluates this guard. An
        // explicitly selected connector that IS connected (even a virtual one
        // — an operator may deliberately target Writeback capture) is
        // honoured. Hosts with no DRM subsystem at all (dev machines) skip the
        // guard and keep the autovideosink path.
        const connectors = listDrmConnectors();
        const requestedConnected = connectors.some(
            (c) =>
                c.name === requestedDisplay &&
                (c.meta?.status as string | undefined) === 'connected',
        );
        if (connectors.length > 0 && !firstConnectedDisplay() && !requestedConnected) {
            this.setHealth('error', 'No display connected — video output unavailable');
            return null;
        }
        // Compositor gate: waylandsink installed means this host renders
        // through the compositor (multi-display and rotation are compositor
        // features — kmssink has neither). With a display CONNECTED but no
        // session yet (boot or hotplug window, compositor restarting), do NOT
        // fall back to kmssink: it takes the DRM master and then fights the
        // compositor's startup for it — observed after display hotplug as
        // video flashing over the console (kmssink letterboxing onto the raw
        // mode) and then vanishing while both sides restart. Idle with a
        // clear health state instead; the wayland-session watcher restarts
        // this module the moment the compositor's socket appears. Hosts
        // without waylandsink installed keep the KMS-direct path.
        if (VideoPlayerModule.sinks.wayland && !hasWaylandSession()) {
            this.setHealth('warning', 'Display connected — waiting for compositor');
            return null;
        }
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
        // Cross-pipeline A/V sync (opt-in): lock to the engine's shared clock so
        // video stays with an audio-decoder fed from the same source. Forces the
        // sink to sync=true and preserves source PTS (see buildLivePipeline);
        // `clockSync` in the returned description makes GstPluginBase resolve and
        // attach the shared clock. Off → today's behaviour.
        const clockSync = (this.config.clockSync as boolean | undefined) === true;
        const sinkElement = buildSink(active.name, sinkEnv, {
            qos: (this.config.qos as boolean | undefined) ?? true,
            sync: clockSync || ((this.config.sync as boolean | undefined) ?? false),
            // Positive lipSyncMs delays video to meet late audio (audio path has
            // more buffering latency). Live-updatable via the named `sink`.
            tsOffsetNs: Math.round(Number(this.config.lipSyncMs ?? 0) * 1_000_000),
        });
        const env = buildPipelineEnv(active.name, sinkEnv);
        // On the wayland (kiosk-shell fullscreen) path the compositor scales
        // our surface onto the output itself, so the live pipeline must not
        // scale in software. KMS / autovideosink have no compositor and keep
        // their own scaler. See buildLivePipeline.
        const waylandFullscreen = sinkEnv.wayland && sinkEnv.waylandSession;

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        const sourceSilent = !!udpSource && this.busStallDetected;
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
            // Resume tap: only when we latched on a SILENT source and its edge
            // socket is currently being served — a missing socket (producer
            // down, or no source at all) must not enter the pipeline, or the
            // runner's bus-socket gate would hold the colour bars hostage
            // waiting for it. existsSync is the best sync check available
            // here; a stale socket file only costs one restartOnError cycle.
            const resumeSocket =
                sourceSilent && udpSource.socketPath && fs.existsSync(udpSource.socketPath)
                    ? udpSource.socketPath
                    : undefined;
            this.resumeTapActive = !!resumeSocket;
            // Size the fallback card to the output's own mode (the live path
            // needs no size — it renders at source resolution). Falls back to
            // DEFAULT_SURFACE when the mode can't be read (nothing plugged
            // in), which is also all autovideosink/headless needs.
            //
            // `active.name` is empty when the user hasn't picked a display
            // (sink selection then lets the compositor choose), so fall back to
            // the first lit physical output — otherwise an unconfigured module
            // always got the default surface and, on a 1080p panel, drew a 720p
            // card that the compositor upscaled straight back.
            //
            // On the compositor path the size must be the output's LOGICAL
            // geometry (weston.ini `mode=` / `transform=`), not the kernel's
            // preferred mode: a rotated output swaps the canvas axes, and
            // fit-scaling a portrait surface into a rotated landscape canvas
            // renders the card as a small band. See resolveWestonSurface.
            // KMS / autovideosink have no compositor, so weston.ini must not
            // apply there — those keep the raw sysfs mode.
            const surfaceConnector = active.name || firstConnectedDisplay() || '';
            const surface =
                (waylandFullscreen
                    ? resolveWestonSurface(surfaceConnector)
                    : resolveConnectorMode(surfaceConnector)) ?? DEFAULT_SURFACE;
            return {
                pipeline: buildFallbackOnlyPipeline(
                    fallback,
                    sinkElement,
                    fallbackImage,
                    resumeSocket,
                    surface,
                ),
                restartOnError: true,
                env,
            };
        }
        this.resumeTapActive = false;

        return {
            pipeline: buildLivePipeline(
                sinkElement,
                udpSource,
                waylandFullscreen,
                Number(this.config.bufferMs ?? 200),
                clockSync,
            ),
            restartOnError: true,
            env,
            decoderThreadType: resolveDecoderThreadType(this.config.cpuDecodeThreading),
            ...(clockSync ? { clockSync: true } : {}),
        };
    }

    private updateStatusData(): void {
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        this.setStatusData('input', {
            source: udpSource ? `bus ${udpSource.port}` : '—',
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
