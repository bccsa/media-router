import * as fs from 'fs';
import { buildBusDemux, tsQueueByteCap } from '@media-router/engine';
import type { KmsDriver } from './kmsDriver.js';
import {
    DECODEBIN_SELECTION,
    resolveCpuDecodeThreading,
    type DecoderSelection,
} from './decoderSelection.js';

/**
 * Surface size used when the output's own mode can't be resolved (headless,
 * autovideosink, nothing plugged in). Prefer the connector's preferred mode —
 * see `surfaceCaps` and `resolveConnectorMode`.
 */
export const DEFAULT_SURFACE: SurfaceSize = { width: 1280, height: 720 };

export interface SurfaceSize {
    width: number;
    height: number;
}

/**
 * Caps for the FALLBACK surface (SMPTE bars / still image). That card has no
 * size of its own — neither `videotestsrc` nor a single `imagefreeze` frame
 * implies one — so this is where its dimensions come from. The LIVE path is
 * deliberately unconstrained: it renders at source resolution and lets the
 * compositor scale (see `buildLivePipeline`).
 *
 * Size the card to the output's own mode rather than a constant: a fixed
 * 1280×720 card on a 1080p panel is upscaled by the compositor, which lands
 * the text overlay soft. See `resolveConnectorMode` / `resolveWestonSurface`.
 *
 * `pixel-aspect-ratio=1/1` is load-bearing: it makes `videoscale
 * add-borders=true` emit real square-pixel black bars rather than
 * satisfying the display aspect ratio with non-square pixels (which would
 * stretch everything drawn downstream, e.g. the text overlay).
 */
export function surfaceCaps(surface: SurfaceSize = DEFAULT_SURFACE): string {
    return `video/x-raw,width=${surface.width},height=${surface.height},pixel-aspect-ratio=1/1`;
}

/**
 * Map the `cpuDecodeThreading` config value onto the runner's own vocabulary
 * (`PipelineDescription.decoderThreadType`), which governs the decoders the
 * runner hooks rather than the ones we name: the `decodebin3` bootstrap rung,
 * and any explicit `avdec_*` we left bare.
 *
 * The two vocabularies do NOT share the meaning of `'auto'`, which is why this
 * mapping exists rather than passing the value straight through: to the runner
 * `'auto'` means "don't force a thread-type" (ffmpeg picks, and picks
 * single-core on a live path), while the setting's `'auto'` means multi-core.
 * So every setting except `'single'` asks the runner for `'frame'` — that is
 * what keeps the bootstrap rung and the explicit software rungs decoding the
 * same way. `'single'` is the one that leaves ffmpeg's live default alone.
 */
export function resolveDecoderThreadType(value: unknown): 'auto' | 'frame' {
    return resolveCpuDecodeThreading(value) === 'single' ? 'auto' : 'frame';
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
    /** The connector's DRM driver when kmssink's own pick cannot open it (`kmsDriverFor`). */
    kmsDriver?: KmsDriver;
}

/** Every basesink's timing: it never waits for a timestamp nor drops a frame as late. */
const SINK_TIMING = 'sync=false qos=false';

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
 *   2. KMS direct, targeting a specific connector by numeric id, on its DRM
 *      driver by name when kmssink's own pick cannot reach it (`kmsDriverFor`).
 *   3. KMS direct, auto-pick connector (used when the user picked a name we
 *      can't resolve to an id, or didn't pick at all).
 *   4. autovideosink (dev machines without DRM, last resort).
 *
 * Every sink shows each frame as it comes (B-169): `sync=false`, never waiting or dropping late;
 * `qos=false`, no QoS event for a decoder's hurry-up (B-160); waylandsink `present-every-frame`
 * (Yocto 0008, B-163). autovideosink is a bin: `sync` only.
 */
export function buildSink(display: string, env: SinkSelectionEnv): string {
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
        return `waylandsink name=sink ${SINK_TIMING} present-every-frame=true fullscreen=true`;
    }
    if (env.kms) {
        // A driver kmssink does not try itself is named; a plane that takes only the full
        // screen (the Pi 5 box's DSI) gets frames at the panel's size from the scaler upstream.
        const driver =
            display && env.kmsDriver
                ? ` driver-name=${env.kmsDriver.name}${env.kmsDriver.fullScreenOnly ? ' can-scale=false' : ''}`
                : '';
        const connector =
            display && env.connectorId !== undefined ? ` connector-id=${env.connectorId}` : '';
        return `kmssink name=sink${driver}${connector} ${SINK_TIMING}`;
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
    /** Size to render the card at — the output's mode; see `surfaceCaps`. */
    surface: SurfaceSize = DEFAULT_SURFACE,
): string {
    // Fixed surface size (+ explicit framerate, since neither videotestsrc
    // nor a single imagefreeze frame implies one). Always constrained: this
    // card has no intrinsic size to inherit, and it's static, so scaling it
    // costs nothing per-frame even on a native-res KMS panel. The LIVE path
    // takes the opposite decision — see `buildLivePipeline`, including the
    // accepted risk that the two surfaces can now differ in size.
    //
    const caps = surfaceCaps(surface);
    // Both cards live at 30 fps: the sink never waits (B-169), so a still that is not live would
    // be repeated as fast as the sink takes it.
    const source = imagePath
        ? `filesrc location="${imagePath}" ! decodebin ! imagefreeze is-live=true ! videoconvert ! videoscale add-borders=true ! ${caps},framerate=30/1`
        : `videotestsrc is-live=true pattern=smpte ! ${caps},framerate=30/1`;
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
 * Inbound chain is `unixfdsrc ! watchdog ! mrlateness ! queue ! tee ! mrtsdemux`
 * on either sink, the bus ingress alone before the demux (no `tsparse` since
 * WI-P3-18, no jitter queue since B-169). The decoder is `decodebin3` until the
 * TS probe reports a codec and an explicit `<parser> ! <decoder>` chain takes its
 * place (see `decoder` below). It plays as soon as it can (house-clock part 4.2,
 * B-169): the non-leaky `vp_esq` after the demux holds what a stall leaves, and
 * `mrvideopace` releases each frame on the content's cadence to a sink that
 * never waits.
 */
const STREAM_STALL_TIMEOUT_MS = 5_000;

/**
 * Element name of the live pipeline's TS video-info tap. The engine runner
 * attaches its report-only probe here (`PipelineDescription.tsProbe`) and
 * emits `tsprobe:videoinfo` plugin events; the module keys decoder selection
 * off the reported codec. See `VideoPlayerModule.onPluginEvent`.
 */
export const TS_PROBE_SINK_NAME = 'tsprobe';

/** Name of the tee that feeds the demux branch and the video-info tap. */
const PROBE_TEE_NAME = 'vp_ts';

/**
 * `name=` of the live pipeline's `mrtsdemux`: its `mrtsdemux:vpdemux` reports
 * (counters, unknown streams, off house time, no video) land on the video input.
 */
export const VP_DEMUX_NAME = 'vpdemux';

/** `name=` of the ES queue after the demux: the queue watch names it (OQ-30). */
const VP_ES_QUEUE_NAME = 'vp_esq';
/** Its bound, as the bus ingress's: 5 s of compressed video, byte-capped (ADR-0015). */
const ES_QUEUE_MS = 5_000;

/** `name=` of the live pipeline's `mrvideopace`: forwarded as `mrvideopace:vp_pace`. */
export const VIDEO_PACE_NAME = 'vp_pace';

export function buildLivePipeline(
    sinkElement: string,
    udpSource: { port: number; socketPath?: string },
    /**
     * True on the wayland-fullscreen path (`waylandsink fullscreen=true` under
     * a compositor). The compositor scales the surface for us, so the pipeline
     * drops its own scaler — see the `convert` branch below. False for KMS /
     * autovideosink, which have no compositor.
     */
    compositorScales = false,
    /**
     * Decoder chain to put in the `decodebin3` element position, from
     * `selectDecoder`. Defaults to `decodebin3` — the bootstrap build, before
     * the TS probe has reported a codec.
     */
    decoder: DecoderSelection = DECODEBIN_SELECTION,
    /**
     * Subtitle overlay element (subtitle-core `buildSubtitleOverlayElement`),
     * spliced between the convert stage and the pace ONLY when a subtitle
     * source is wired — with none, the string is byte-identical to before.
     * After `videoconvert` so it negotiates a system-memory format it can
     * blend into; the runner's subtitle bridge drives its `text` property.
     */
    overlay?: string,
    /**
     * Refresh of the output's mode in mHz (`resolveOutputRefreshHz`), when known:
     * `mrvideopace`'s prior until it measures the display (B-175).
     */
    refreshMhz?: number,
): string {
    // The bus ingress alone before the demux: its 5 s leaky queue is the drain contract
    // (OQ-30), and the demux re-frames the bus's buffers as sent (WI-P3-18).
    const busDemux = buildBusDemux({
        port: udpSource.port,
        socketPath: udpSource.socketPath,
        stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
        tee: { name: PROBE_TEE_NAME },
        name: VP_DEMUX_NAME,
        media: 'video',
    });
    // NON-LEAKY (part 4.4): an IDR burst and a stall's backlog wait here, compressed, while
    // mrvideopace plays them on the content's cadence; nothing is dropped for lateness. Full,
    // it holds the demux and the bus ingress sheds what comes next (OQ-30).
    const esQueue =
        `queue name=${VP_ES_QUEUE_NAME} leaky=0 max-size-time=${ES_QUEUE_MS * 1_000_000}` +
        ` max-size-buffers=0 max-size-bytes=${tsQueueByteCap(ES_QUEUE_MS)}`;
    // Scaling policy — who resizes the picture, per sink:
    //
    // COMPOSITOR PATH (waylandsink under kiosk-shell): nothing here does. The
    // frames reach the sink at SOURCE resolution and Weston fit-scales the
    // fullscreen surface onto the output on the GPU, letterboxing per the
    // fullscreen protocol — free, and better filtering than videoscale. So no
    // `videoscale` and no size caps at all; `videoconvert` stays only as the
    // format fixup the software decode path may need. It also passes
    // `video/x-raw(memory:DMABuf), format=DMA_DRM` through untouched (verified
    // on GStreamer 1.28), which is what lets the stateless V4L2 decoders
    // (`v4l2slh265dec` on the Pi's rpivid — they emit DMA_DRM and nothing else)
    // negotiate straight to waylandsink and be imported zero-copy. Dropping
    // the caps is what makes that unconditional: the previous two-structure
    // filter needed an explicit no-constraint DMABuf structure to let hardware
    // buffers past a size that only the software path could satisfy.
    //
    // KMS / autovideosink: `videoconvert ! videoscale`, no caps — there is no
    // compositor to scale for them, so the sink negotiates the size it wants
    // and videoscale is there to serve it (passthrough when that is the source
    // size). Deliberately SOFTWARE, never `v4l2convert` (the bcm2835-codec-isp
    // hardware converter): measured on a Pi 400 (GStreamer 1.28, hw-decoded
    // 1080p50), the ISP in-path caps at ~46 fps at 1080p regardless of output
    // size/format — it cannot sustain 1080p50 — where the sw elements run
    // ~60 fps at near-zero CPU whenever input caps equal output caps
    // (basetransform goes passthrough).
    //
    // The cost of scaling in software, from that same Pi 400 measurement:
    // ~25 fps at 2.6× decode CPU once the elements were actively resizing
    // (surface ≠ source). That is what a pinned surface charged on every
    // mismatched source, and the reason the compositor path now scales nothing.
    //
    // ACCEPTED RISK: the live surface is now SOURCE-sized while the fallback
    // card stays surface-sized (`surfaceCaps`). Weston's kiosk-shell wants
    // every surface committed to an output to agree on dimensions and rejects
    // a fullscreen surface whose size differs from the one already committed,
    // logging `libwayland: error in client communication` — so a live↔fallback
    // transition between differing dimensions can trip it. Taken deliberately:
    // hardware decode plus zero software scaling is the bigger win. Revisit
    // with the fallback-sizing strategy (handover Q5: the fallback should
    // inherit the last live surface).
    const convert = compositorScales ? 'videoconvert' : 'videoconvert ! videoscale';
    // DECODER POSITION. `decoder.chain` is either the bootstrap `decodebin3` or
    // an explicit `<parser> ! <decoder>` picked from the codec the TS probe
    // reported (see decoderSelection.ts). Nothing else about the chain moves.
    //
    // On the `decodebin3` rung: still decodebin3, never decodebin. On an
    // ABR/HLS source the resolution changes mid-stream at every variant switch;
    // decodebin replugs a fresh decoder on each change — a hard stall the
    // viewer sees as a hitch — while decodebin3 reuses the existing decoder.
    // With no caps filter downstream the new resolution renegotiates straight
    // through to the sink and the compositor re-fits the surface, so a variant
    // switch costs neither a replug nor a failed negotiation. (A CODEC change
    // is a different animal: decodebin3's in-place decoder switch is what
    // wedged an h265→h264 feed on hardware, so the module rebuilds the whole
    // pipeline for that — it never relies on the replug.)
    //
    // `media=video` (Q18): no audio or data PID gets a pad, so the ANY-caps queue can
    // never take one. An explicit rung keeps its codec filter on the demux pad, where the
    // delayed link is made: a pad of another codec stays unlinked until the rebuild.
    const caps = decoder.caps ? `${decoder.caps} ! ` : '';
    // Video-info tap. The runner's report-only TS probe needs an appsink fed
    // with the muxed TS (it does its own PSI discovery + SPS parse), so the
    // ingress is tee'd off just before `mrtsdemux`, straight off the bus
    // ingress queue (no tsparse since WI-P3-18, no jitter queue since B-169).
    //
    // ALIGNMENT is a BUS property, not a tsparse one — which is what makes the
    // tap correct without a re-framer. `ts_psi.iter_packets` strides a fixed
    // 188 from offset 0 and skips any offset not on a 0x47 sync byte; it does
    // NOT resync, so a buffer that doesn't START on a packet boundary yields
    // nothing (the runner calls that out and swallows it — report-only). It
    // never comes to that here: unixfd carries producer buffer boundaries
    // across the socket untouched, every bus producer emits whole-packet
    // buffers of ANY size (ADR-0011: one access unit per buffer from a gst
    // producer, 1316 B from relay producers, 128×188 from libmrbus ingest,
    // whole-packet batches from mr-tssplit — never assume a size), and neither
    // `watchdog` nor `queue` re-slices a buffer. Tapping off the ingress queue also puts the
    // branch downstream of the stall watchdog, so it cannot interfere with bus_stall
    // detection. The branch is leaky and the appsink drops
    // (runner sets max-buffers/drop), so a stalled tap can never back-pressure
    // the render path through the tee.
    const probeTap =
        ` ${PROBE_TEE_NAME}. ! queue leaky=downstream max-size-buffers=64` +
        ` ! appsink name=${TS_PROBE_SINK_NAME}`;
    // The pace after the convert stage and the overlay, right before the render lateness tap
    // and the sink: each frame leaves on the content's cadence, never before it arrives, and a
    // display slower than the content drops frames to keep up (B-162, B-175). It drains what
    // waits in the ES queue back to its target (B-179).
    const pace =
        `mrvideopace name=${VIDEO_PACE_NAME} backlog-queue=${VP_ES_QUEUE_NAME}` +
        `${refreshMhz ? ` refresh-mhz=${refreshMhz}` : ''}`;
    return (
        `${busDemux} ! ${caps}${esQueue} ! ${decoder.chain} ! ${convert} ! ` +
        `${overlay ? `${overlay} ! ` : ''}${pace} ! ${sinkElement}${probeTap}`
    );
}
