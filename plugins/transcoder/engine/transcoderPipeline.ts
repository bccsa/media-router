/**
 * Pure pipeline-assembly helpers for the video transcoder.
 *
 * Kept free of GStreamer / engine-runtime imports (only types + the shared
 * encoder-branch builder) so they unit-test with plain inputs.
 */

import { buildTsUdpInput, buildUdpSink, buildLeakyQueue } from '@media-router/engine';
import {
    buildEncoderBranch,
    type CodecId,
    type H264Profile,
    type ImplId,
    type RateControl,
    type SpeedPreset,
} from './encoderBranch.js';

export type PortDirection = 'input' | 'output';

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
    /** Output ports carry MPEG-TS, so downstream consumers must wait for this
     *  pipeline to be PLAYING before they can be wired — same contract as the
     *  encoder / muxer outputs. */
    requiresOrderedApply?: boolean;
}

/** One configured output rendition. */
export interface Rendition {
    name: string;
    width: number;
    height: number;
    bitrate: number;
}

/** A rendition with its allocated UDP endpoint + stable port id. */
export interface TranscoderOutput {
    portId: string;
    host: string;
    port: number;
    rendition: Rendition;
}

const INPUT_PORT_ID = 'mpegts-in';
const OUTPUT_PORT_PREFIX = 'out-';
const MAX_RENDITIONS = 8;

/**
 * Provisional rendition used only when config carries none. The engine resolves
 * `getDynamicPorts` once BEFORE the module starts — at which point the plugin's
 * `this.config` is still empty (config is applied in `onInit`, during start).
 * Returning at least one rendition here means the node shows an output port
 * immediately on add (the engine re-resolves with the real config once the
 * module is running, e.g. on connection-apply). Mirrors how the MPEG-TS muxer's
 * `?? 1` stream-count default keeps its ports visible pre-start. Kept in sync
 * with the first entry of the manifest's `renditions` default.
 */
const DEFAULT_RENDITION: Rendition = { name: '720p', width: 1280, height: 720, bitrate: 2500 };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

/**
 * Read + sanitise the rendition list from config. Coerces the numeric fields
 * and clamps the count, so a malformed config can never splice junk into the
 * gst-launch string. A blank/missing name is left empty (the caller falls back
 * to a positional label).
 */
export function readRenditions(config: Record<string, unknown>): Rendition[] {
    const arr = config.renditions;
    // Key absent → unconfigured/pre-start: surface one provisional rendition so a
    // port exists (see DEFAULT_RENDITION). An explicit array (even empty) is the
    // operator's real choice and is honoured as-is.
    if (!Array.isArray(arr)) return [{ ...DEFAULT_RENDITION }];
    return arr.slice(0, MAX_RENDITIONS).map((raw, i) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        return {
            name: typeof e.name === 'string' ? e.name : '',
            width: toPositiveInt(e.width, 1280),
            height: toPositiveInt(e.height, 720),
            bitrate: toPositiveInt(e.bitrate, 2500),
        };
    });
}

function toPositiveInt(value: unknown, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Display label for a rendition's port: operator name, else `WxH`. */
export function renditionLabel(r: Rendition, index: number): string {
    if (r.name.trim()) return r.name.trim();
    return `${r.width}x${r.height}`;
}

/**
 * Build the dynamic port list: one MPEG-TS input + one output per rendition.
 * The input is always present so a source can be wired before any rendition is
 * configured.
 */
export function buildDynamicPorts(renditions: Rendition[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
    ];
    renditions.forEach((r, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: renditionLabel(r, i),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });
    return ports;
}

export interface TranscoderPipelineInputs {
    input: { host: string; port: number };
    outputs: TranscoderOutput[];
    codec: CodecId;
    impl: ImplId;
    framerate: number;
    /** Keyframe interval in FRAMES — passed straight to the encoder as
     *  key-int-max (the standard x264/x265 unit). */
    gopFrames: number;
    /** udpsrc timeout (ns) — runner turns the timeout into a bus error so a
     *  silent source triggers `restartOnError`. */
    timeoutNs?: number;
    /** Pre-decode buffer in ms (default 200). Jitter tolerance + lets the
     *  frame-threaded decoder work a little ahead. The cost is this much latency. */
    bufferMs?: number;
    /** 'multi' (default) sets `avdec_h264 thread-type=frame max-threads=3` so the
     *  decode spreads across cores on the live feed; 'single' is GStreamer's
     *  default one-core live decode (lowest latency). */
    decodeThreads?: 'multi' | 'single';
    /** Encoder rate control for every rendition: 'cbr' (default, constant — safest
     *  for fixed-bandwidth UDP/SRT) or 'vbr' (variable, better quality on motion). */
    rateControl?: RateControl;
    /** x264/x265 speed↔quality preset for every rendition (default 'ultrafast').
     *  Slower presets spend more CPU for cleaner motion at the same bitrate. */
    speedPreset?: SpeedPreset;
    /** H.264 output profile for every rendition (default 'auto'). Constrains
     *  encoder features for decoder compatibility. H.264 only. */
    h264Profile?: H264Profile;
    /** x264/x265 scene-cut threshold (default 40; 0 = off). Inserts an adaptive
     *  keyframe at detected scene changes so the picture snaps clean at a cut. */
    sceneCut?: number;
}

export interface TranscoderPipelineResult {
    pipeline: string;
}

/**
 * Assemble the transcode pipeline.
 *
 * The input MPEG-TS is decoded ONCE; the resulting raw video is conformed to a
 * single shared framerate and fanned out through a `tee`, with one
 * scale→encode→mux→udpsink branch per rendition. Decoding once and re-encoding
 * many is the whole point of an ABR transcoder — far cheaper than N independent
 * decode+encode chains.
 *
 * The whole graph is ONE static pipeline string (no `linkOnPadAdded`). The
 * runner parses it with `gst_parse_launch`, which resolves `tsdemux`'s
 * sometimes-pads by delayed linking exactly like `gst-launch`. It is deliberately
 * NOT split into a pad-added branch: an earlier version wrapped the
 * decode→tee→leaves fragment in a `parse_bin_from_description` bin, which handed
 * the bin multiple ambiguous ghost sink pads, so the demuxer pad linked to the
 * wrong one and the stream died with "Internal data stream error".
 *
 * The decoder is an EXPLICIT `h264parse ! avdec_h264` (see `decoder` below), NOT
 * `decodebin`/`decodebin3`: we need `thread-type=frame` set on `avdec_h264` at
 * construction to spread the software decode across cores on a live feed, and the
 * runner's decoder auto-plug hook does not reliably apply it. So the INPUT IS
 * H.264-ONLY — the output codec is configurable, the input is not. (`decodebin3`
 * was also measured and rejected: its adaptive `multiqueue` burned ~99% of a core
 * vs ~58% for a raw `avdec_h264` on a 1080p50 feed, buying only seamless
 * mid-stream resolution changes a broadcast transcode never sees.)
 *
 * A video-only capsfilter (`video/x-h264`) sits directly on `tsdemux`'s output so
 * ONLY the H.264 video elementary stream links downstream; an audio pad (e.g. AAC
 * in a broadcast SRT feed) is left unplugged — without it the audio pad reaches
 * `videoconvert` (raw-video-only) and the pipeline dies with "Internal data stream
 * error". This capsfilter is also what enforces the H.264-only input: an H.265 (or
 * other) source exposes no `video/x-h264` pad, nothing links, and the pipeline
 * silently produces no video. Returns null when there are no outputs — the caller
 * sets a health warning rather than starting an empty pipeline.
 *
 * Buffering / multicore decode: unlike a passthrough remux, this pipeline
 * DECODES, and frame-threaded software H.264 decode only parallelises across
 * cores when it has frames queued ahead to work on. So — exactly like the
 * video-player — we put a real buffer in front of the decoder: `buildTsUdpInput`
 * (udpsrc → jitter queue → tsparse) plus a `bufferMs` leaky queue after the
 * demux. With no buffer the decode collapses onto one pinned core and falls
 * behind; with ~200 ms it spreads and keeps up. The cost is that much latency,
 * so `bufferMs` is configurable (lower it for tighter latency if the CPU can
 * keep up single-core).
 */
export function buildPipeline(input: TranscoderPipelineInputs): TranscoderPipelineResult | null {
    if (input.outputs.length === 0) return null;

    const fps = input.framerate;
    const kif = Math.max(1, Math.round(input.gopFrames));
    const bufferMs = input.bufferMs ?? 200;

    const tsInput = buildTsUdpInput({
        host: input.input.host,
        port: input.input.port,
        timeoutNs: input.timeoutNs,
        jitterMs: bufferMs,
    });

    // Per-rendition leaf: a short leaky queue (so a slow encoder sheds whole
    // frames instead of stalling the shared tee and starving its siblings),
    // then scale → encode → mux → per-output udpsink.
    // videoconvert lives HERE (after videoscale), not before the tee: this way
    // the pixel-format conversion runs on the small, already-downscaled frame
    // (e.g. 854x480) instead of the full 1080p source — a fraction of the cost.
    // Each leaf is its own thread (the leading queue), so the scale+convert+encode
    // of every rendition runs on its own core.
    const leaf = (out: TranscoderOutput, i: number): string => {
        const r = out.rendition;
        const q = 'queue leaky=2 max-size-buffers=2 max-size-time=0 max-size-bytes=0';
        const scale = `videoscale ! video/x-raw,width=${r.width},height=${r.height}`;
        const encoder = buildEncoderBranch(
            input.codec, input.impl, r.bitrate, kif, `venc_${i}`,
            input.rateControl ?? 'cbr', input.speedPreset ?? 'ultrafast',
            input.h264Profile ?? 'auto', input.sceneCut ?? 40,
        );
        const sink = buildUdpSink({ name: `usink_${i}`, host: out.host, port: out.port });
        return `${q} ! ${scale} ! videoconvert ! ${encoder} ! mpegtsmux name=mux_${i} latency=0 alignment=7 ! ${sink}`;
    };

    // Video-only capsfilter on the tsdemux output — steers pad selection to the
    // H.264 video elementary stream so an audio pad (AAC, etc.) is never linked
    // into the decode chain (otherwise it reaches videoconvert and the pipeline
    // dies with "Internal data stream error").
    const videoCaps = 'capsfilter caps="video/x-h264"';
    const decodeQueue = buildLeakyQueue(bufferMs);

    // EXPLICIT decoder with the threading set INLINE — this is what actually
    // spreads the decode across cores on a LIVE feed. GStreamer single-threads
    // live decode by default (gstavviddec.c demotes to FF_THREAD_SLICE on a live
    // latency query; broadcast frames are single-slice → one core pins at 100%).
    // `thread-type=frame` forces FFmpeg frame threading regardless of liveness and
    // MUST be set at element creation. The engine runner has a decoder-threads
    // auto-plug hook, but it only fires for decoders GStreamer auto-plugs
    // (decodebin/decodebin3); this pipeline names `avdec_h264` explicitly, so we
    // set the threading here instead. Measured: decode goes from one 44% thread to
    // ~5 threads at 13-34% each, no core pinned. max-threads=3 spreads it while
    // bounding the per-thread frame latency. 'single' = GStreamer default one-core live decode.
    const decoder =
        input.decodeThreads === 'single'
            ? 'h264parse ! avdec_h264'
            : 'h264parse ! avdec_h264 thread-type=frame max-threads=3';

    const teeBranches = input.outputs.map((o, i) => `t. ! ${leaf(o, i)}`).join(' ');
    // Shared pre-tee path: decode → (queue/thread boundary) → drop to the target
    // framerate → tee. No videoconvert here (moved into the leaves so it runs on
    // the small downscaled frame). videorate runs on its own thread via the queue.
    const tq = 'queue max-size-buffers=4 max-size-time=0 max-size-bytes=0';
    const pipeline =
        `${tsInput} ! tsdemux latency=0 ! ${videoCaps} ! ${decodeQueue} ! ${decoder} ! ${tq} ! ` +
        `videorate ! video/x-raw,framerate=${fps}/1 ! tee name=t ${teeBranches}`;

    return { pipeline };
}
