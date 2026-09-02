/**
 * The encode tail shared by every plugin that encodes video into MPEG-TS:
 *
 *   [queue] ! [scale/convert] ! <encoder branch> ! mpegtsmux ! <sink>
 *
 * The transcoder emits one of these per rendition off its shared decode tee;
 * the video-encoder emits exactly one off its V4L2 capture source. Everything
 * upstream of the tail (decode, capture, fan-out) stays with the plugin — this
 * builder holds only the part where the two were byte-identical.
 *
 * Pure string assembly: no probing, no defaults. `encoder` is already fully
 * resolved by the caller (`buildEncoderBranch` owns the encode defaults) and
 * `scaleStage`/`sink` are pre-built fragments, so this file never has to know
 * about renditions, ports or hardware availability.
 */

import { buildEncoderBranch, type EncoderBranchOptions } from './encoderElements.js';

/**
 * Bounded LEAKY queue at the head of a leaf fed from a shared decode tee, so a
 * slow encoder sheds whole frames instead of stalling the tee and starving its
 * sibling leaves. Also the leaf's thread boundary — scale + convert + encode of
 * every branch then runs on its own core.
 *
 * 4 buffers (80 ms @50 fps), not 2: vah264enc accepts frames in GPU batch
 * cycles, and with only 40 ms of slack every cycle shed frames — measured on
 * gate01 (file-paced replica, per-stage probes): videorate feeds a clean 50/s,
 * encoder-out was 38/s at buffers=2 vs 48.4/s at buffers=4 (8/16 add nothing;
 * encoder preset and vapostproc change nothing — the 40 ms admission window was
 * the choke). Kept BUFFERS-bounded and small on purpose: these queues hold
 * DECODER-POOL frames, and a deep time-bound queue here (300 ms ≈ 15 frames ×
 * N leaves) exhausted avdec's buffer pool and froze the whole transcode chain.
 * 4 × 3 leaves = 12 refs is well inside the pool.
 */
const DECODER_POOL_QUEUE = 'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0';

export interface EncodeLeafOptions {
    /** Fully-resolved encoder settings — forwarded to `buildEncoderBranch`. */
    encoder: EncoderBranchOptions;
    /**
     * Pre-built scale/convert fragment, or omitted when the source already
     * delivers the encoder's format and size. Hardware where the encoder impl
     * has its scaler installed (`vapostproc ! video/x-raw(memory:VAMemory),…`,
     * `v4l2convert ! video/x-raw,…`), else software
     * `videoscale ! video/x-raw,… ! videoconvert` — videoconvert AFTER the
     * scale so the pixel-format conversion runs on the small downscaled frame
     * instead of the full-size source.
     */
    scaleStage?: string;
    /**
     * Head-of-leaf queue.
     *
     * `'decoder-pool'` — leaf hangs off a decode tee and its buffers are frames
     * from the decoder's pool: emit the bounded leaky queue (see
     * {@link DECODER_POOL_QUEUE} for the buffer count and why it is
     * buffers-bounded rather than time-bounded).
     *
     * `'none'` — NO queue. A leaky queue anywhere on this path would drop a
     * mid-stream TS slice and corrupt decode at the receiver. Capture paths use
     * this: their source already has its own leaky queue immediately after
     * v4l2src, where it protects the V4L2 kernel ringbuffer from filling under
     * back-pressure, and a second one here would only add a drop point.
     */
    inputQueue: 'decoder-pool' | 'none';
    /** `name=` of the mpegtsmux (`mux`, or `mux_0`… when several coexist). */
    muxName: string;
    /** Pre-built sink fragment — `buildBusSink(port)`, or a fakesink when the
     *  module has no bus channel assigned yet. */
    sink: string;
}

/** Assemble one encode leaf. */
export function buildEncodeLeaf(opts: EncodeLeafOptions): string {
    const stages: string[] = [];
    if (opts.inputQueue === 'decoder-pool') stages.push(DECODER_POOL_QUEUE);
    if (opts.scaleStage) stages.push(opts.scaleStage);
    stages.push(buildEncoderBranch(opts.encoder));
    stages.push(`mpegtsmux name=${opts.muxName} latency=0 alignment=7`);
    stages.push(opts.sink);
    return stages.join(' ! ');
}
