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

/**
 * Normalise the `cpuDecodeThreading` config value to the thread-type the runner
 * understands. Only `'frame'` opts into multi-core (frame-parallel) software
 * decode — which adds latency; anything else — unset or junk — resolves to the
 * latency-safe `'auto'` default. Validating here keeps a bad config value from
 * reaching GStreamer.
 */
export function resolveDecoderThreadType(value: unknown): 'auto' | 'frame' {
    return value === 'frame' ? 'frame' : 'auto';
}

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
    /**
     * Honour buffer PTS on the sink. When `true` the sink waits to present each
     * frame at its PTS against the pipeline clock — required when the upstream
     * feed has accurate timestamps (HLS via tsparse) and you want playback
     * at the media's intended rate. When `false` the sink presents frames as
     * fast as upstream delivers them: that's right for live SRT/RIST where
     * latency dominates, but on a paced HLS feed it surfaces as periods of
     * "too fast" (segment burst arrives → sink renders the burst) followed by
     * "too slow" (segment gap → sink stalls waiting). Default `false`
     * preserves the pre-existing low-latency behaviour for SRT/RIST instances.
     */
    sync?: boolean;
    /**
     * Lip-sync trim in nanoseconds applied to the video sink's `ts-offset`.
     * Positive **delays** video (to meet audio that's playing late — the audio
     * path carries more buffering latency than video). Only has effect with
     * `sync=true` (the sink must honour timing for ts-offset to mean anything).
     * 0 = no trim. The named `sink` element makes it live-updatable.
     */
    tsOffsetNs?: number;
}

export function buildSink(display: string, env: SinkSelectionEnv, opts: SinkOpts = {}): string {
    const qosClause = ` qos=${opts.qos ?? true}`;
    const sync = opts.sync ?? false;
    // Pair `max-lateness` with `sync=true` between two failure modes:
    //   - basesink default (20 ms) is tight enough that software-decoded 1080p
    //     on Pi 5 (per-frame decode 30-50 ms, IDR frames 60-80 ms) loses every
    //     GOP-boundary frame — surfaces as a low frame rate even with QoS off.
    //   - `-1` (disabled) never drops, so any sustained decode lag (consistent
    //     5 %-slow software decode) accumulates as growing latency that doesn't
    //     recover — surfaces as "smooth at first then progressively laggy".
    // 1 s is the compromise: the sink absorbs IDR-frame jitter without dropping
    // (50-80 ms ≪ 1 s) but caps unbounded lag from sustained decode shortfall.
    // QoS stays off so the decoder isn't asked to drop per-frame — drops only
    // happen at the sink, only when a buffer is genuinely 1 s late.
    // `sync=false` (the live SRT/RIST default) has no clock anchor, so the
    // basesink's late-drop logic doesn't apply — leave it unspecified.
    const syncClause = sync ? ' sync=true max-lateness=1000000000' : ' sync=false';
    // Lip-sync trim — only meaningful with sync=true (a non-syncing sink
    // ignores timing). `autovideosink` is a bin, not a basesink, so it has no
    // ts-offset; skip it there.
    const tsOffset = opts.tsOffsetNs && sync ? ` ts-offset=${opts.tsOffsetNs}` : '';
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
        return `waylandsink name=sink${syncClause}${tsOffset} fullscreen=true${qosClause}`;
    }
    if (display && env.kms && env.connectorId !== undefined) {
        return `kmssink name=sink connector-id=${env.connectorId}${syncClause}${tsOffset}${qosClause}`;
    }
    if (env.kms) {
        return `kmssink name=sink${syncClause}${tsOffset}${qosClause}`;
    }
    return `autovideosink${syncClause}${qosClause}`;
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
/** Element name of the fallback pipeline's bus-resume tap sink — the module
 *  polls its sink-pad byte counter to detect the source flowing again. */
export const RESUME_SINK_NAME = 'resume_sink';

export function buildFallbackOnlyPipeline(
    fallbackText: string,
    sinkElement: string,
    imagePath?: string,
    /**
     * Consumer edge socket to keep draining while the fallback is up. When
     * set, a side chain `unixfdsrc ! queue leaky ! fakesink` taps this
     * module's own fan-out edge so the module can poll `resume_sink` for
     * bytes (source resumed → switch back to live) without tearing down the
     * visible fallback — the bus replacement for the old passive dgram
     * probe. Pass it ONLY when the socket currently exists: the runner's
     * bus-socket gate would otherwise hold the whole fallback pipeline (and
     * the colour bars) hostage waiting for a dead producer's socket.
     */
    resumeSocketPath?: string,
): string {
    // Fixed surface size (+ explicit framerate, since neither videotestsrc
    // nor a single imagefreeze frame implies one). Always constrained: the
    // fallback is a static card, so downscaling it to the surface size is
    // free of quality concerns even on a native-res KMS panel, and the
    // wayland path needs the fixed size to match the live path.
    const source = imagePath
        ? `filesrc location="${imagePath}" ! decodebin ! imagefreeze ! videoconvert ! videoscale add-borders=true ! ${SURFACE_CAPS},framerate=30/1`
        : `videotestsrc is-live=true pattern=smpte ! ${SURFACE_CAPS},framerate=30/1`;
    const resumeTap = resumeSocketPath
        ? ` unixfdsrc socket-path=${resumeSocketPath}` +
          ' ! queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0' +
          ` ! fakesink name=${RESUME_SINK_NAME} sync=false async=false`
        : '';
    return (
        `${source} ` +
        `! textoverlay name=nov text="${fallbackText}" valignment=center halignment=center font-desc="Sans Bold 48" ` +
        `! videoconvert ! ${sinkElement}${resumeTap}`
    );
}

/**
 * Active-source pipeline. Goes straight from the bus ingress to the
 * configured sink with no fallback branch — the test-pattern fallback only
 * runs when the module has no source assigned (`buildFallbackOnlyPipeline`).
 * A silent-but-connected source trips the 5 s stall watchdog below: the
 * runner tags it `kind: 'bus_stall'` and the module latches the colour-bars
 * fallback instead of looping on a live pipeline that will just stall again.
 * A DEAD producer needs no watchdog — its edge socket closes and unixfdsrc
 * errors out into the normal restart path.
 *
 * Inbound chain is `unixfdsrc ! queue ! tsparse ! tsdemux` (via
 * `buildTsUdpInput`) — `tsparse` re-anchors PCR to the local clock so
 * multi-stage encode/remux paths don't accumulate clock drift as session
 * latency. `decodebin` handles any codec inside the MPEG-TS; the post-tsdemux
 * `queue leaky=2` drops oldest if the decoder falls behind so latency doesn't
 * accumulate on slow renderers.
 */
const STREAM_STALL_TIMEOUT_MS = 5_000;

export function buildLivePipeline(
    sinkElement: string,
    udpSource: { port: number; socketPath?: string },
    constrainSurface = false,
    /**
     * Pre-decode buffer (ms). 200 ms is right for live SRT/RIST where latency
     * is the dominant constraint. Bump on HLS/VOD chains (e.g. 1500 ms) where
     * the source bursts a segment at a time and the decoder needs lookahead
     * until the next I-frame after a mid-stream join.
     */
    bufferMs = 200,
    /**
     * Cross-pipeline A/V sync: preserve the source PTS (no `tsparse
     * set-timestamps` re-anchoring) so this pipeline shares the timeline of the
     * audio-decoder it's clock-locked to. Default false = today's re-anchored
     * behaviour. The caller pairs this with a `sync=true` sink + `clockSync`.
     */
    preserveSourcePts = false,
): string {
    // Pre-tsparse jitter buffer scales with `bufferMs`: with a paced sender on
    // a busy Node loop (hls-pipe runner transmuxing the next segment), the
    // event-loop stalls for 50–100 ms and `drainLoop` catches up by bursting
    // datagrams. The default 200 ms queue leaks under that burst → frames lost
    // at every segment join. Tracking `bufferMs` (up to `buildLeakyQueue`'s 5 s
    // cap) gives HLS chains a multi-second jitter buffer that absorbs sender
    // bursts; SRT/RIST (`bufferMs=200`) keeps the original tight latency.
    const tsInput = buildTsUdpInput({
        port: udpSource.port,
        socketPath: udpSource.socketPath,
        stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
        jitterMs: bufferMs,
        // Keep source PTS when clock-locked to the audio pipeline; re-anchor
        // otherwise (the load-bearing default for standalone playout).
        setTimestamps: !preserveSourcePts,
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
    const q = `queue leaky=2 max-size-time=${bufferMs * 1_000_000} max-size-buffers=0 max-size-bytes=0`;
    const scale = constrainSurface
        ? `videoscale add-borders=true ! ${SURFACE_CAPS}`
        : 'videoscale';
    // `decodebin3` (not decodebin): on an ABR/HLS source the resolution changes
    // mid-stream at every variant switch. decodebin repluggs a fresh decoder on
    // each change — a hard stall the viewer sees as a hitch. decodebin3 reuses
    // the existing decoder across format changes, so switches are smooth. Paired
    // with the fixed `${SURFACE_CAPS}` on the wayland-fullscreen path the sink
    // surface also stays constant, so neither the decoder nor the compositor
    // hitches on a switch.
    return `${tsInput} ! tsdemux latency=0 ! ${q} ! decodebin3 ! videoconvert ! ${scale} ! ${sinkElement}`;
}
