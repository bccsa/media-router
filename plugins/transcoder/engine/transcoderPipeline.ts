/**
 * GStreamer pipeline assembly for the video transcoder. The pure port/rendition
 * config helpers live in `transcoderPorts.ts`; this file only builds the
 * gst-launch string (with the shared UDP / TS / encoder helpers).
 */

import {
    buildTsUdpInput,
    buildUdpSink,
    buildLeakyQueue,
    buildEncoderBranch,
    busTransport,
    busTeeName,
} from '@media-router/engine';
import type { TranscoderOutput } from './transcoderPorts.js';

export interface TranscoderPipelineInputs {
    input: { host: string; port: number; socketPath?: string };
    /** One output per rendition. Each carries its own fully-resolved encoder
     *  settings (`encode`: codec / impl / rateControl / speedPreset / h264Profile
     *  / sceneCut) — resolved in TranscoderModule (override ?? global) so this
     *  builder never sees `auto`/undefined and holds no encode defaults itself. */
    outputs: TranscoderOutput[];
    framerate: number;
    /** Keyframe interval in FRAMES — passed straight to the encoder as
     *  key-int-max (the standard x264/x265 unit). Shared by all renditions to
     *  keep keyframes aligned for ABR. */
    gopFrames: number;
    /** Buffer in ms (default 200): sizes the input jitter queue AND a post-decode
     *  raw-frame queue that lets the frame-threaded decoder work ahead. The cost
     *  is this much latency. Never buffered leakily on the compressed stream —
     *  see buildPipeline. Shared: sizes the single decode chain. */
    bufferMs?: number;
    /** 'multi' (default) sets `avdec_h264 thread-type=frame max-threads=3` so the
     *  decode spreads across cores on the live feed; 'single' is GStreamer's
     *  default one-core live decode (lowest latency). Shared: one decoder. */
    decodeThreads?: 'multi' | 'single';
}

export interface TranscoderPipelineResult {
    pipeline: string;
    /** udpsink element names (one per rendition, `usink_0`…) — the module polls
     *  these for aggregate output throughput. Single source of truth for the
     *  names constructed in the leaf builder. */
    sinkNames: string[];
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
 * cores when it can run ahead of the consumers. `bufferMs` sizes two queues:
 * the input jitter queue (`buildTsUdpInput`, udpsrc → queue → tsparse) and a
 * leaky RAW-frame queue placed AFTER the decoder, in front of videorate/tee.
 *
 * The raw buffer must NOT sit on the compressed stream (an earlier version put
 * a `bufferMs` leaky queue between tsdemux and h264parse): tsdemux output
 * buffers carry sparse timestamps (PTS only at PES boundaries), so a
 * time-bounded leaky queue cannot measure its fill level there — it treats
 * itself as full and silently drops H.264 mid-GOP. On a long-GOP source every
 * drop poisons the decode until the next keyframe. Measured on-box (2026-07-02,
 * same live feed, simultaneous 30 s runs): compressed-side leaky queue ≈ 1.4 MB
 * out; the identical pipeline with the buffer post-decode ≈ 19 MB (full CBR
 * rate). Leaky shedding is only safe on decoded frames, where each buffer is an
 * independent, correctly-timestamped picture. The jitter queue on the raw TS
 * input is fine — udpsrc timestamps every buffer it emits.
 */
export function buildPipeline(input: TranscoderPipelineInputs): TranscoderPipelineResult | null {
    if (input.outputs.length === 0) return null;

    const fps = input.framerate;
    const kif = Math.max(1, Math.round(input.gopFrames));
    const bufferMs = input.bufferMs ?? 200;

    // setTimestamps=false: `tsparse set-timestamps=true` re-stamps from PCR and
    // must BUFFER until the next PCR arrives to interpolate. A spec-compliant
    // mux sends PCR every ≤100 ms, but real-world feeds (measured: MediaMTX SRT
    // relay, PCR every 2 s) turn that into 2-second batch-release — the whole
    // transcode then freezes/bursts at the PCR cadence and the bursts overflow
    // downstream receive buffers (visible as packet loss). The decode chain
    // takes per-frame PTS from the PES headers via tsdemux, so PCR re-stamping
    // buys nothing here.
    // No udpsrc `timeout`: a single-input loopback transcoder feeding a tee (fan-
    // out, not an aggregator) has nothing to freeze when its source goes silent —
    // it stalls, then resumes when the local producer returns. A timeout→restart
    // can't recover a loopback source and only restart-storms (re-spawning the
    // x264 encoders) at boot before the upstream has data. See the same rationale
    // in mpegtsDemuxerPipeline. The multi-source mpegts-muxer keeps its timeout.
    const tsInput = buildTsUdpInput({
        host: input.input.host,
        port: input.input.port,
        socketPath: input.input.socketPath,
        jitterMs: bufferMs,
        setTimestamps: false,
    });

    // Per-rendition leaf: a short leaky queue (so a slow encoder sheds whole
    // frames instead of stalling the shared tee and starving its siblings),
    // then scale → encode → mux → per-output udpsink.
    // videoconvert lives HERE (after videoscale), not before the tee: this way
    // the pixel-format conversion runs on the small, already-downscaled frame
    // (e.g. 854x480) instead of the full 1080p source — a fraction of the cost.
    // Each leaf is its own thread (the leading queue), so the scale+convert+encode
    // of every rendition runs on its own core.
    const sinkNames: string[] = [];
    const leaf = (out: TranscoderOutput, i: number): string => {
        const r = out.rendition;
        const e = out.encode;
        // 4 buffers (80 ms @50 fps), not 2: vah264enc accepts frames in GPU
        // batch cycles, and with only 40 ms of slack every cycle shed frames —
        // measured on gate01 (file-paced replica, per-stage probes): videorate
        // feeds a clean 50/s, encoder-out was 38/s at buffers=2 vs 48.4/s at
        // buffers=4 (8/16 add nothing; encoder preset and vapostproc change
        // nothing — the 40 ms admission window was the choke). Kept BUFFERS-
        // bounded and small on purpose: these queues hold DECODER-POOL frames,
        // and a deep time-bound queue here (300 ms ≈ 15 frames × N leaves)
        // exhausted avdec's buffer pool and froze the whole transcode chain.
        // 4 × 3 leaves = 12 refs is well inside the pool.
        const q = 'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0';
        const scale = `videoscale ! video/x-raw,width=${r.width},height=${r.height}`;
        // Every knob is per-rendition here: `out.encode` is already fully resolved
        // (override ?? global, impl picked for this rendition's codec) by the
        // module, so this builder just forwards it — no defaults to keep in sync.
        const encoder = buildEncoderBranch({
            codec: e.codec,
            impl: e.impl,
            bitrateKbps: r.bitrate,
            kif,
            name: `venc_${i}`,
            rateControl: e.rateControl,
            speedPreset: e.speedPreset,
            h264Profile: e.h264Profile,
            sceneCut: e.sceneCut,
        });
        const sink = buildUdpSink({ name: `usink_${i}`, host: out.host, port: out.port });
        // Throughput element differs by transport: the fan-out `tee`
        // (busTeeName) under unixfd, the named `usink_i` udpsink under UDP.
        sinkNames.push(busTransport() === 'unixfd' ? busTeeName(out.port) : `usink_${i}`);
        return `${q} ! ${scale} ! videoconvert ! ${encoder} ! mpegtsmux name=mux_${i} latency=0 alignment=7 ! ${sink}`;
    };

    // Video-only capsfilter on the tsdemux output — steers pad selection to the
    // H.264 video elementary stream so an audio pad (AAC, etc.) is never linked
    // into the decode chain (otherwise it reaches videoconvert and the pipeline
    // dies with "Internal data stream error").
    const videoCaps = 'capsfilter caps="video/x-h264"';
    // Raw-frame work-ahead buffer (thread boundary decoder ↔ videorate/tee).
    // Sits AFTER the decoder on purpose — see the buffering note above.
    const rawBuffer = buildLeakyQueue(bufferMs);

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
    // Shared pre-tee path: demux → decode → raw buffer (thread boundary) → drop
    // to the target framerate → tee. No videoconvert here (moved into the leaves
    // so it runs on the small downscaled frame). videorate runs on its own
    // thread via the raw buffer queue.
    const pipeline =
        `${tsInput} ! tsdemux latency=0 ! ${videoCaps} ! ${decoder} ! ${rawBuffer} ! ` +
        `videorate ! video/x-raw,framerate=${fps}/1 ! tee name=t ${teeBranches}`;

    return { pipeline, sinkNames };
}
