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
import { listDrmConnectors, resolveConnectorId } from '@media-router/engine';

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
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('fallbackText' in changes) {
            // The `nov` text overlay only exists in the *fallback* pipeline
            // (videotestsrc branch when no source is connected). When the
            // live pipeline is running, attempting to set its `text` property
            // would surface as a Python `Element not found` error — and the
            // gst-runner's `restartOnError` treats any error event as fatal,
            // tearing the live pipeline down for a setProperty miss. So skip
            // the live push entirely when a source is connected; the new
            // text takes effect automatically the next time the fallback
            // pipeline is built (e.g. source disconnects, module restarts).
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
        const display = (config.display as string) ?? '';
        const connectorId = display ? resolveConnectorId(display) : undefined;
        const sinkEnv: SinkSelectionEnv = {
            ...VideoPlayerModule.sinks,
            waylandSession: hasWaylandSession(),
            connectorId,
        };
        const sinkElement = buildSink(display, sinkEnv);
        const env = buildPipelineEnv(display, sinkEnv);

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);

        if (!udpSource) {
            this.setHealth('warning', 'No video connected');
            return {
                pipeline: buildFallbackOnlyPipeline(fallback, sinkElement),
                liveElements: { nov: ['text'] },
                restartOnError: true,
                env,
            };
        }

        this.setHealth('ok');
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
        const display = (this.config.display as string) ?? '';
        const env = {
            ...VideoPlayerModule.sinks,
            waylandSession: hasWaylandSession(),
        };
        let renderPath = 'autovideosink';
        let target = '—';
        let status = 'unavailable';
        if (env.wayland && env.waylandSession) {
            renderPath = 'waylandsink';
            target = process.env.WAYLAND_DISPLAY ?? 'wayland';
            status = 'compositor';
        } else if (display && env.kms) {
            const connector = listDrmConnectors().find((c) => c.name === display);
            renderPath = 'kmssink';
            target = display;
            status = (connector?.meta?.status as string) ?? 'unknown';
        } else if (env.kms) {
            const firstConnected = listDrmConnectors().find(
                (c) => (c.meta?.status as string) === 'connected',
            );
            renderPath = 'kmssink';
            target = firstConnected?.name ?? '(auto)';
            status = firstConnected ? 'connected' : 'no display';
        }
        this.setStatusData('display', {
            renderer: renderPath,
            target,
            status,
        });
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
 *      sets `MR_WAYLAND_APP_ID=local.mr.<connector>` on the runner spawn so
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
