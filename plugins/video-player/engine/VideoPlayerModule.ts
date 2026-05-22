import * as fs from 'fs';
import * as path from 'path';
import {
    GstPluginBase,
    buildTsUdpInput,
    probeGstElement,
    type EngineServices,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import { listDrmConnectors, pickActiveDisplay } from '@media-router/engine';

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
    /** Per-instance latch so concurrent socket events don't stack restarts. */
    private waylandRestartInProgress = false;

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
        VideoPlayerModule.registerForWaylandRestartWatch(this);
    }

    async onStop(): Promise<void> {
        VideoPlayerModule.unregisterForWaylandRestartWatch(this);
        await super.onStop();
    }

    /**
     * Trigger a clean pipeline restart against the *current* wayland session.
     * Invoked by the runtime-dir watcher when the compositor socket is
     * replaced. Latched so a flurry of file events during a Weston restart
     * only kicks off one cycle.
     */
    private async restartForWaylandSessionChange(): Promise<void> {
        if (this.waylandRestartInProgress) return;
        this.waylandRestartInProgress = true;
        try {
            this.log.info('Wayland session changed — restarting video pipeline');
            await this.onStop();
            await this.onStart();
        } catch (err) {
            this.log.warn({ err }, 'Wayland-restart cycle failed');
        } finally {
            this.waylandRestartInProgress = false;
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
                inst.restartForWaylandSessionChange().catch(() => {
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
            // (videotestsrc branch when no source is connected). Skip the
            // live push when a source is connected — the property doesn't
            // exist on the live pipeline, and the new text takes effect the
            // next time the fallback pipeline is built (source disconnect,
            // module restart).
            const instanceId = this.services?.instanceId ?? '';
            const hasSource = !!this.services?.mediaRouter?.getModuleUdpSource(instanceId);
            if (!hasSource) {
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
        const sinkElement = buildSink(active.name, sinkEnv);
        const env = buildPipelineEnv(active.name, sinkEnv);

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);

        if (active.substituted) {
            this.setHealth(
                'warning',
                `Display "${requestedDisplay}" not connected — using "${active.name}"`,
            );
        } else if (!udpSource) {
            this.setHealth('warning', 'No video connected');
        } else {
            this.setHealth('ok');
        }

        if (!udpSource) {
            return {
                pipeline: buildFallbackOnlyPipeline(fallback, sinkElement),
                liveElements: { nov: ['text'] },
                restartOnError: true,
                env,
            };
        }

        return {
            pipeline: buildLivePipeline(sinkElement, udpSource),
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

// --- pure helpers (exported for tests) ---

export interface SinkSelectionEnv {
    /** Whether `waylandsink` is installed. */
    wayland: boolean;
    /** Whether `kmssink` is installed. */
    kms: boolean;
    /** Whether a Wayland compositor socket is reachable from this process. */
    waylandSession: boolean;
    /**
     * Numeric DRM connector id for the user-selected display, resolved from
     * sysfs. `kmssink` takes `connector-id` (a number) — older GStreamer
     * builds (1.22 / Yocto) don't expose a `connector-name` property at all,
     * so passing the name directly produced "no property connector-name in
     * element kmssink" parse errors. Falls back to auto-pick when undefined.
     */
    connectorId?: number;
}

/**
 * Sink-selection priority:
 *   1. Wayland (waylandsink). Preferred when a compositor is running because
 *      kmssink can't take the DRM master while Weston/labwc holds it. The
 *      sink itself doesn't take a connector argument — output pinning is
 *      delegated to kiosk-shell's per-output `app-ids=` whitelists in
 *      weston.ini, which match the surface's wayland `app_id`. The engine
 *      sets `MR_GLIB_PRGNAME=local.mr.<connector>` on the runner spawn so
 *      the child's `GLib.set_prgname` lands the surface on the user-picked
 *      output. See `buildPipelineEnv` and the pre-`Gst.init` block in
 *      `gst-pipeline-runner.py`.
 *   2. KMS direct, targeting a specific connector by numeric id.
 *   3. KMS direct, auto-pick connector (used when the user picked a name we
 *      can't resolve to an id, or didn't pick at all).
 *   4. autovideosink (dev machines without DRM, last resort).
 */
export function buildSink(display: string, env: SinkSelectionEnv): string {
    if (env.wayland && env.waylandSession) {
        return 'waylandsink name=sink sync=false';
    }
    if (display && env.kms && env.connectorId !== undefined) {
        return `kmssink name=sink connector-id=${env.connectorId} sync=false`;
    }
    if (env.kms) {
        return 'kmssink name=sink sync=false';
    }
    return 'autovideosink sync=false';
}

/**
 * Build the per-pipeline env for the GStreamer runner. The engine exposes a
 * generic `MR_GLIB_PRGNAME` hook (applied via `GLib.set_prgname` before
 * `Gst.init`); video-player uses it to set the Wayland surface app_id,
 * because waylandsink derives the surface app_id from the GLib program
 * name. Kiosk-shell then matches that app_id against the per-output
 * `app-ids=` whitelist in weston.ini to pin the surface to the user-
 * selected DRM connector — see the comment on `buildSink`. Gated on the
 * wayland branch of the sink selection: on KMS or autovideosink hosts
 * the prgname has no useful effect and would only show up confusingly in
 * process listings. Returns an empty object when no display is configured,
 * or when the pipeline isn't going to render via a Wayland compositor.
 */
export function buildPipelineEnv(display: string, env: SinkSelectionEnv): Record<string, string> {
    if (!display) return {};
    if (!(env.wayland && env.waylandSession)) return {};
    return { MR_GLIB_PRGNAME: `local.mr.${display}` };
}

/**
 * Identity string for the wayland session that's currently reachable from
 * this runtime dir: `<socket-filename>:<inode>`. Empty string when no socket
 * is present. Inode is in the identity because Weston restarts often reuse
 * the same `wayland-1` filename — only the inode changes, and that's the
 * signal that the underlying compositor process is different.
 */
export function currentWaylandSessionIdent(runtimeDir: string): string {
    try {
        const sock = fs
            .readdirSync(runtimeDir)
            .find((entry) => /^wayland-\d+$/.test(entry));
        if (!sock) return '';
        const st = fs.statSync(path.join(runtimeDir, sock));
        return `${sock}:${st.ino}`;
    } catch {
        return '';
    }
}

/**
 * Probe the user runtime dir for a Wayland socket. We can't rely on
 * `WAYLAND_DISPLAY` being set when the engine is launched outside a desktop
 * session (systemd-user, SSH-spawned dev runs); the socket file existing is
 * the source of truth. `ensureWaylandEnv` populates the env before we get
 * here, so by build-pipeline time both signals agree.
 */
export function hasWaylandSession(): boolean {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return false;
    try {
        return fs
            .readdirSync(runtime)
            .some((entry) => /^wayland-\d+$/.test(entry));
    } catch {
        return false;
    }
}

/**
 * Poll until a Wayland socket appears in the user runtime dir, or `timeoutMs`
 * elapses. Re-runs `ensureWaylandEnv` between polls so `XDG_RUNTIME_DIR` /
 * `WAYLAND_DISPLAY` get set as soon as the compositor is ready. Returns
 * `true` if Wayland became available, `false` if the timeout was hit.
 */
export async function waitForWaylandSocket(timeoutMs: number, intervalMs = 250): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        ensureWaylandEnv();
        if (hasWaylandSession()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

/**
 * Best-effort: if a Wayland socket is present in the user runtime dir but
 * `WAYLAND_DISPLAY` isn't exported (e.g. systemd-user launch with no inherited
 * session env), set it on the parent process so child gst-runner inherits.
 * Also seeds `XDG_RUNTIME_DIR` if missing — we use `/run/user/<uid>` which
 * exists for any logged-in user.
 */
export function ensureWaylandEnv(): void {
    if (!process.env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
        const candidate = `/run/user/${process.getuid()}`;
        try {
            if (fs.statSync(candidate).isDirectory()) {
                process.env.XDG_RUNTIME_DIR = candidate;
            }
        } catch {
            /* /run/user/<uid> not present — nothing to do */
        }
    }
    if (process.env.WAYLAND_DISPLAY) return;
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return;
    try {
        const socket = fs
            .readdirSync(runtime)
            .find((entry) => /^wayland-\d+$/.test(entry));
        if (socket) {
            process.env.WAYLAND_DISPLAY = path.basename(socket);
        }
    } catch {
        /* runtime dir unreadable */
    }
}

export function buildFallbackOnlyPipeline(fallbackText: string, sinkElement: string): string {
    return (
        `videotestsrc is-live=true pattern=smpte ! video/x-raw,width=1280,height=720,framerate=30/1 ` +
        `! textoverlay name=nov text="${fallbackText}" valignment=center halignment=center font-desc="Sans Bold 48" ` +
        `! videoconvert ! ${sinkElement}`
    );
}

/**
 * Active-source pipeline. Goes straight from `udpsrc` to the configured sink
 * with no fallback branch — the test-pattern fallback only runs when the
 * module has no source assigned (`buildFallbackOnlyPipeline`). Stream drops
 * trigger the engine's `restartOnError` loop, which gets re-armed by the
 * 5s `udpsrc` timeout below: if the source goes silent for 5s the runner
 * tears the pipeline down and rebuilds with a fresh demuxer/decoder, so
 * when the stream comes back we don't try to resume a stale state.
 *
 * Inbound chain is `udpsrc ! queue ! tsparse ! tsdemux` (via `buildTsUdpInput`)
 * — `tsparse` re-anchors PCR to the local clock so multi-stage encode/remux
 * paths don't accumulate clock drift as session latency. `decodebin` handles
 * any codec inside the MPEG-TS; the post-tsdemux `queue leaky=2` drops oldest
 * if the decoder falls behind so latency doesn't accumulate on slow renderers.
 */
const UDP_STREAM_TIMEOUT_NS = 5_000_000_000;

export function buildLivePipeline(
    sinkElement: string,
    udpSource: { host: string; port: number },
): string {
    const tsInput = buildTsUdpInput({
        host: udpSource.host,
        port: udpSource.port,
        timeoutNs: UDP_STREAM_TIMEOUT_NS,
    });
    return (
        `${tsInput} ! tsdemux latency=0 ` +
        `! queue leaky=2 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 ! decodebin ` +
        `! videoconvert ! videoscale ! ${sinkElement}`
    );
}
