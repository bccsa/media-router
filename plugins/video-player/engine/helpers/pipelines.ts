import * as fs from 'fs';
import { buildTsUdpInput } from '@media-router/engine';
import { westonTransformToGstRotate } from './weston.js';

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
    /**
     * Per-output transform string from weston.ini (e.g. `rotate-90`). The
     * default `'normal'` (or empty) means no compensation needed.
     */
    outputTransform?: string;
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
        // Note on rotation: previously we tried waylandsink's `rotate-method`
        // but that only rotates pixel content — the xdg_surface geometry
        // stays at the source caps size, so kiosk-shell errored on rotated
        // outputs with `xdg_surface geometry (1280 x 720) is larger than
        // the configured fullscreen state (1080 x 1920)`. The actual rotation
        // happens with a `videoflip` element prepended to the sink (see
        // `rotationElement`) so the caps also swap and the surface fits.
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
 * GStreamer pipeline fragment that pre-rotates the buffer to compensate for
 * a rotated weston output. Returns an empty string when no rotation is
 * needed so the pipeline string is byte-identical to before on normal
 * outputs.
 *
 * Uses `videoflip` rather than waylandsink's `rotate-method` because the
 * latter rotates pixels but keeps the surface geometry at the source caps
 * size — kiosk-shell then rejects the surface as too large for the rotated
 * fullscreen state. `videoflip` rotates AND swaps the WxH caps, producing
 * a buffer (and surface) of the correct rotated dimensions.
 */
export function rotationElement(outputTransform: string | undefined): string {
    const method = westonTransformToGstRotate(outputTransform);
    if (method === 'identity') return '';
    return `videoflip method=${method} ! `;
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
    outputTransform?: string,
): string {
    // pixel-aspect-ratio=1/1 in the caps is what makes `add-borders=true`
    // actually emit square-pixel black bars. Without it, videoscale satisfies
    // the requested DAR by emitting non-square pixels, and everything drawn
    // downstream (textoverlay) gets stretched to match — operators see the
    // image look right but the overlay text horizontally squashed.
    const source = imagePath
        ? `filesrc location="${imagePath}" ! decodebin ! imagefreeze ! videoconvert ! videoscale add-borders=true ! video/x-raw,width=1280,height=720,framerate=30/1,pixel-aspect-ratio=1/1`
        : `videotestsrc is-live=true pattern=smpte ! video/x-raw,width=1280,height=720,framerate=30/1,pixel-aspect-ratio=1/1`;
    return (
        `${source} ` +
        `! textoverlay name=nov text="${fallbackText}" valignment=center halignment=center font-desc="Sans Bold 48" ` +
        `! videoconvert ! ${rotationElement(outputTransform)}${sinkElement}`
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
    outputTransform?: string,
): string {
    const tsInput = buildTsUdpInput({
        host: udpSource.host,
        port: udpSource.port,
        timeoutNs: UDP_STREAM_TIMEOUT_NS,
    });
    return (
        `${tsInput} ! tsdemux latency=0 ` +
        `! queue leaky=2 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0 ! decodebin ` +
        `! videoconvert ! videoscale ! ${rotationElement(outputTransform)}${sinkElement}`
    );
}
