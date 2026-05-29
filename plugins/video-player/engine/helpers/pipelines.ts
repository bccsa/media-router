import * as fs from 'fs';
import { buildTsUdpInput } from '@media-router/engine';

/**
 * Single source of truth for the rendered surface size. The wayland
 * fullscreen path (kiosk-shell) requires every surface committed to an
 * output to agree on dimensions — if the live path and the fallback path
 * disagree, kiosk-shell rejects the second one and weston logs
 * `libwayland: error in client communication`. Keeping the caps in one
 * constant is what enforces that invariant; do not inline the literals.
 */
const SURFACE_WIDTH = 1280;
const SURFACE_HEIGHT = 720;
/**
 * `pixel-aspect-ratio=1/1` is load-bearing: it makes `videoscale
 * add-borders=true` emit real square-pixel black bars rather than
 * satisfying the display aspect ratio with non-square pixels (which would
 * stretch everything drawn downstream, e.g. the text overlay).
 */
const SURFACE_CAPS = `video/x-raw,width=${SURFACE_WIDTH},height=${SURFACE_HEIGHT},pixel-aspect-ratio=1/1`;

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
export interface SinkOpts {
    /**
     * GStreamer QoS — when `true`, sinks send QoS events upstream telling the
     * decoder to drop frames if it's late. Useful for live (SRT/RIST) where
     * keeping up with the clock matters more than presenting every frame. For
     * HLS / paced sources where you want every frame, set `false` so the
     * decoder isn't pressured to skip frames mid-GOP. Default `true` matches
     * GStreamer's own default — existing instances keep their current behaviour.
     */
    qos?: boolean;
}

export function buildSink(display: string, env: SinkSelectionEnv, opts: SinkOpts = {}): string {
    const qosClause = ` qos=${opts.qos ?? true}`;
    if (env.wayland && env.waylandSession) {
        // `fullscreen=true` does two things we need on a kiosk-shell output:
        //  1. Z-order — it takes the xdg_toplevel fullscreen role, prompting
        //     kiosk-shell to raise the video to the output's active/top slot.
        //     Without it the video renders *behind* an interactive cog
        //     browser (the local-panel LCP) that holds input focus. A passive
        //     `background` cog doesn't hold focus, so video won there already
        //     — this makes the behaviour consistent across both.
        //  2. Rotation — as the fullscreen surface, the compositor applies
        //     the output's `transform=` (e.g. rotate-90) itself. So we do
        //     NOT pre-rotate client-side; an earlier `videoflip` approach
        //     double-rotated once fullscreen was in play.
        return `waylandsink name=sink sync=false fullscreen=true${qosClause}`;
    }
    if (display && env.kms && env.connectorId !== undefined) {
        return `kmssink name=sink connector-id=${env.connectorId} sync=false${qosClause}`;
    }
    if (env.kms) {
        return `kmssink name=sink sync=false${qosClause}`;
    }
    return `autovideosink sync=false${qosClause}`;
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
 * Validate a user-supplied fallback-image path. Returns the path on success,
 * or `undefined` when it isn't safe to splice into a gst-launch pipeline.
 * Rules:
 *  - must be absolute (relative paths are too easy to get wrong on the engine
 *    box and silently miss),
 *  - must exist and be readable (otherwise the pipeline will refuse to
 *    transition to PLAYING and we want to know at config-build time),
 *  - must not contain characters that would terminate or escape the
 *    `location="…"` clause in the gst-launch string (`"`, `\`, newlines).
 *    File paths on a kiosk-style Yocto box never need these in practice.
 */
export function resolveFallbackImagePath(raw: string): string | undefined {
    if (!raw) return undefined;
    if (!raw.startsWith('/')) return undefined;
    if (/["\\\r\n]/.test(raw)) return undefined;
    try {
        fs.accessSync(raw, fs.constants.R_OK);
    } catch {
        return undefined;
    }
    return raw;
}

/**
 * Fallback pipeline for SMPTE bars OR a still image. Aspect-preserving:
 * `videoscale add-borders=true` letterboxes / pillarboxes the image into
 * the 1280×720 surface instead of stretching it (a 9:16 portrait shot
 * stays portrait with black bars on the sides). `decodebin` covers PNG /
 * JPEG / WebP / etc.; `imagefreeze` turns a single decoded frame into a
 * continuous live stream so the rest of the chain (sink, text overlay)
 * doesn't have to handle EOS.
 *
 * For *video* fallback, use `buildFallbackVideoPipeline` instead — that
 * path needs decodebin dynamic-pad linking and a `loopOnEos` flag on the
 * containing `PipelineDescription`.
 */
export function buildFallbackOnlyPipeline(
    fallbackText: string,
    sinkElement: string,
    imagePath?: string,
): string {
    // Fixed surface size (+ explicit framerate, since neither videotestsrc
    // nor a single imagefreeze frame implies one). Always constrained: the
    // fallback is a static card, so downscaling it to the surface size is
    // free of quality concerns even on a native-res KMS panel, and the
    // wayland path needs the fixed size to match the live path.
    const source = imagePath
        ? `filesrc location="${imagePath}" ! decodebin ! imagefreeze ! videoconvert ! videoscale add-borders=true ! ${SURFACE_CAPS},framerate=30/1`
        : `videotestsrc is-live=true pattern=smpte ! ${SURFACE_CAPS},framerate=30/1`;
    return (
        `${source} ` +
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
    constrainSurface = false,
    /**
     * Pre-decode buffer (ms). 200 ms is right for live SRT/RIST where latency
     * is the dominant constraint. Bump on HLS/VOD chains (e.g. 1500 ms) where
     * the source bursts a segment at a time and the decoder needs lookahead
     * until the next I-frame after a mid-stream join.
     */
    bufferMs = 200,
): string {
    const tsInput = buildTsUdpInput({
        host: udpSource.host,
        port: udpSource.port,
        timeoutNs: UDP_STREAM_TIMEOUT_NS,
    });
    // `constrainSurface` pins the live output to the same surface dimensions
    // the fallback uses (NOT full caps parity — fallback also sets a framerate;
    // live deliberately omits it since there's no videorate element). This is
    // only wanted on the wayland-fullscreen path: kiosk-shell rejects a
    // fullscreen surface whose dimensions don't match the one the fallback
    // committed, logging `libwayland: error in client communication`. On
    // KMS-direct / autovideosink there's no such constraint and forcing 720p
    // would needlessly downscale a native-res broadcast panel, so we pass the
    // source resolution straight through.
    const scale = constrainSurface
        ? `videoscale add-borders=true ! ${SURFACE_CAPS}`
        : 'videoscale';
    return (
        `${tsInput} ! tsdemux latency=0 ` +
        `! queue leaky=2 max-size-time=${bufferMs * 1_000_000} max-size-buffers=0 max-size-bytes=0 ! decodebin ` +
        `! videoconvert ! ${scale} ! ${sinkElement}`
    );
}
