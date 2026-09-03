import * as fs from 'fs';
import { buildBackpressureQueue, buildBusSrc, buildTsUdpInput } from '@media-router/engine';
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
    const source = imagePath
        ? `filesrc location="${imagePath}" ! decodebin ! imagefreeze ! videoconvert ! videoscale add-borders=true ! ${caps},framerate=30/1`
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
 * Inbound chain is `unixfdsrc ! watchdog ! queue ! queue ! tsdemux` by
 * default — WITHOUT `tsparse` — and gains `tsparse` back when the sink is
 * clock-paced (see the comment at the construction site below). The decoder is
 * `decodebin3` until the TS probe reports a codec and an explicit
 * `<parser> ! <decoder>` chain takes its place (see `decoder` below); the
 * post-tsdemux `queue leaky=2` drops oldest if the decoder falls behind so
 * latency doesn't accumulate on slow renderers.
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
     * Pre-decode buffer (ms). 200 ms is right for live SRT/RIST where latency
     * is the dominant constraint. Bump on HLS/VOD chains (e.g. 1500 ms) where
     * the source bursts a segment at a time and the decoder needs lookahead
     * until the next I-frame after a mid-stream join.
     */
    bufferMs = 200,
    /**
     * Retained from when this flag gated `tsparse` re-anchoring: it was set
     * (true) in `clockSync` mode to share the audio-decoder's timeline and
     * cleared otherwise. Both paced modes now ride the source PTS
     * unconditionally (see the tsInput comment below — re-anchoring bursts GOPs
     * on this fleet's muxes), so it no longer changes the tsparse recipe. Kept
     * as the 5th positional arg for the `clockSync` caller; `clockSync` itself
     * (see the description's `clockSync` flag in `planLivePipeline`) is what
     * still attaches the shared clock.
     */
    preserveSourcePts = false,
    /**
     * True when the sink honours buffer PTS (`sync=true` — the module's `sync`
     * config or `clockSync`). A clock-paced sink presents each frame at its
     * buffer PTS; pacing brings `tsparse` back into the chain for TS packet
     * alignment and the vp_ts probe tee — but NOT to re-anchor timestamps
     * (`set-timestamps=false`; it rides the source PTS, see the tsInput comment
     * below). Default false = the tsparse-free present-on-arrival fast path.
     */
    sinkPaced = false,
    /**
     * Decoder chain to put in the `decodebin3` element position, from
     * `selectDecoder`. Defaults to `decodebin3` — the bootstrap build, before
     * the TS probe has reported a codec.
     */
    decoder: DecoderSelection = DECODEBIN_SELECTION,
): string {
    // Pre-tsparse jitter buffer scales with `bufferMs`: with a paced sender on
    // a busy Node loop (hls-pipe runner transmuxing the next segment), the
    // event-loop stalls for 50–100 ms and `drainLoop` catches up by bursting
    // datagrams. Tracking `bufferMs` (up to the helper's 5 s cap) gives HLS
    // chains a multi-second jitter buffer; SRT/RIST (`bufferMs=200`) keeps the
    // tight latency. The queue BACK-PRESSURES rather than leaks, in both
    // variants: it carries raw TS, and a leaked chunk corrupts decode until the
    // next IDR — the "frames lost at every segment join" this comment used to
    // describe, and the "packet loss on movement" of 2026-09-02 (rationale and
    // measurements on `buildTsUdpInput`).
    // The inbound chain has two variants, chosen by how the SINK presents:
    //
    // DEFAULT (`sync=false`, presents on arrival): NO `tsparse` (field-
    // measured on a Pi 4, 2026-08-01). Its documented job — re-anchoring PCR
    // so multi-stage RE-MUX paths don't drift — doesn't apply to a terminal
    // display pipeline, timestamps go unused by a non-syncing sink, the leaky
    // jitter queue sits upstream of where tsparse sat anyway, and it was the
    // chain's single most expensive element (0.11 core at 1080p50; tsdemux
    // eats the raw bus buffers directly at +0.06).
    //
    // CLOCK-PACED (`sinkPaced` — the `sync` config or `clockSync`): tsparse
    // RETURNS, but only for TS packet alignment and the vp_ts probe tee —
    // NEVER to re-anchor (`set-timestamps=false`). The sink rides the SOURCE
    // PTS (PES PTS via tsdemux), which is what clockSync mode has always done.
    //
    // WHY NOT set-timestamps=true (field-measured on the Pi 4 fleet,
    // 10.9.16.107/.108, 2026-08-09): tsparse's set-timestamps mode interpolates
    // buffer timestamps from the TS PCR, so it must hold a full PCR-to-PCR
    // window before it can emit. This fleet's broadcast muxes carry PCR at up
    // to 2 s intervals (spec is ≤100 ms), so tsparse stalls ~2 s and then
    // bursts an ENTIRE GOP at once. That defeats pacing downstream: the 1 s
    // leaky ES queue sheds ~half of each burst and flags DISCONT, the keyframe
    // gate re-arms on the DISCONT and drops delta units until the next IDR, and
    // the picture crawls at ~1 fps. Riding the source PTS instead measured 49
    // fps with a single startup DISCONT on the same live feed — the re-anchor
    // was the whole fault. The 0.11 core for tsparse is still paid only when
    // pacing is on; it just no longer touches timestamps.
    const tsInput = sinkPaced
        ? buildTsUdpInput({
              port: udpSource.port,
              socketPath: udpSource.socketPath,
              stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
              jitterMs: bufferMs,
              // The helper never re-anchors (tsparse set-timestamps=false) —
              // see the comment above; there is no longer a knob to get wrong.
          })
        : `${buildBusSrc({
              port: udpSource.port,
              socketPath: udpSource.socketPath,
              stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
          })} ! ${buildBackpressureQueue(bufferMs)}`;
    // Post-demux ES queue: floored at 1 s regardless of `bufferMs`. This queue
    // absorbs the decoder-side stall while an IDR burst drains (keyframe AUs at
    // 8 Mbps span >200 ms on a Pi 4); at 200 ms it sheds the tail of nearly
    // every GOP, which the IRAP resync gate then drops until the next keyframe
    // (~10 fps playback).
    //
    // THIS QUEUE'S DEPTH IS RETAINED LATENCY, and the sentence that used to sit
    // here — "latency is unaffected in steady state; a leaky queue only holds
    // data while downstream is stalled" — was FALSIFIED by the time-sync
    // contract (.42, 2026-08-13/14). It was true for the sink it was written
    // for: `sync=false` presents on arrival, so it gulps any backlog at max
    // speed and drains itself. A `sync=true` sink drains at exactly MEDIA rate,
    // so whatever this queue absorbs during a hiccup it keeps — for ever, one
    // hiccup at a time, until frames start being dropped for lateness (field:
    // 50 fps decoded, 2.5 fps on the glass after ~16 h).
    //
    // The answer is NOT a smaller queue — this depth is field-measured IDR-burst
    // absorption and shrinking it puts the picture back at ~10 fps. It is the
    // backlog shedder (`PipelineDescription.backlogShed`, armed by the contract
    // in pipelinePlan.ts): retention past the route's playout budget D is
    // detected at the decoder's sink pad and the oldest data is dropped, up to
    // the next keyframe, until the leg is back at D.
    const esQueueMs = Math.max(bufferMs, 1_000);
    const q = `queue leaky=2 max-size-time=${esQueueMs * 1_000_000} max-size-buffers=0 max-size-bytes=0`;
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
    // CAPSFILTER, and why it sits DIRECTLY on tsdemux rather than after the
    // queue. `tsdemux` has sometimes-pads, so gst_parse_launch resolves this
    // link when the pad appears. The leaky queue's sink pad is ANY: it will
    // accept an AUDIO pad just as happily as the video one, and the audio then
    // reaches h26xparse/videoconvert and kills the pipeline with "Internal data
    // stream error" (the transcoder documents the same trap). Steering has to
    // happen at the first pad the demuxer can link to, so the filter goes
    // before the queue — the queue keeps its exact position and settings
    // otherwise. Verified locally against a real A/V TS: with the filter only
    // the video ES links; without it the outcome depends on pad-add order.
    // The decodebin3 rung carries no filter (we don't know the codec there, and
    // decodebin3 is what has always absorbed whatever pad it got).
    const caps = decoder.caps ? `${decoder.caps} ! ` : '';
    // Video-info tap. The runner's report-only TS probe needs an appsink fed
    // with the muxed TS (it does its own PSI discovery + SPS parse), so the
    // ingress is tee'd off just before `tsdemux` — after `tsparse` on the
    // clock-paced variant, straight off the leaky jitter queue on the default
    // tsparse-free one.
    //
    // ALIGNMENT is a BUS property, not a tsparse one — which is what makes the
    // one tap correct for both variants. `ts_psi.iter_packets` strides a fixed
    // 188 from offset 0 and skips any offset not on a 0x47 sync byte; it does
    // NOT resync, so a buffer that doesn't START on a packet boundary yields
    // nothing (the runner calls that out and swallows it — report-only). It
    // never comes to that here: unixfd carries producer buffer boundaries
    // across the socket untouched, every bus producer emits whole-packet
    // buffers of ANY size (ADR-0011: one access unit per buffer from a gst
    // producer, 1316 B from relay producers, 128×188 from libmrbus ingest,
    // whole-packet batches from mr-tssplit — never assume a size), and neither
    // `watchdog` nor `queue` re-slices a buffer. Tapping off tsInput also puts the branch
    // downstream of the stall watchdog in both variants, so it cannot interfere
    // with bus_stall detection. The branch is leaky and the appsink drops
    // (runner sets max-buffers/drop), so a stalled tap can never back-pressure
    // the render path through the tee.
    const probeTap =
        ` ${PROBE_TEE_NAME}. ! queue leaky=downstream max-size-buffers=64` +
        ` ! appsink name=${TS_PROBE_SINK_NAME}`;
    return (
        `${tsInput} ! tee name=${PROBE_TEE_NAME} ! tsdemux latency=0 ! ${caps}${q} ! ` +
        `${decoder.chain} ! ${convert} ! ${sinkElement}${probeTap}`
    );
}
