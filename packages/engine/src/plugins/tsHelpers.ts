/**
 * Shared MPEG-TS pipeline helpers used by every plugin that builds tsdemux /
 * mpegtsmux chains (muxer, demuxer, future remux plugins).
 *
 * Centralises three host-machine assumptions:
 *   - which video codec → parser element name to use,
 *   - the leaky-queue shape we use after every dynamic pad,
 *   - the default `mpegtsmux alignment` (=7, packed UDP).
 */

import { buildBusSrc } from './busHelpers.js';

/** Default `mpegtsmux alignment`. 7 = pack 7 TS packets per buffer (1316 B). */
export const DEFAULT_MPEGTS_ALIGNMENT = 7;

/**
 * Deterministic PID scheme (plan D3) for streams muxed by `mpegtsmux`.
 *
 * The PID is the stable join key between stream detection and in-band naming
 * (later phases) and keeps a demuxer's port identity stable across restarts —
 * mpegtsmux assigns a sink pad's PID directly from its request-pad name
 * `sink_<pid>`, so pinning the name pins the PID.
 *
 *   video-N → 0x100 + N   (0x100, 0x101, …)
 *   audio-N → 0x140 + N   (0x140, 0x141, …)
 *
 * Subtitle headroom sits above audio (reserved for Phase 4) and the metadata
 * PID is fixed (claimed in Phase 2). Ranges are spaced so a realistic stream
 * count never collides across media types.
 */
export const TS_VIDEO_PID_BASE = 0x100;
export const TS_AUDIO_PID_BASE = 0x140;

/**
 * Fixed PID for the in-band name channel (plan D2/D3, Phase 2). Sits above the
 * audio range (0x140..0x14f for 16 streams) and the subtitle headroom reserved
 * for Phase 4, so it never collides with an elementary stream. The muxer's KLV
 * appsrc pins this via `muxSinkPadName(TS_METADATA_PID)`; the demuxer reads the
 * carousel off the matching `meta/x-klv` pad.
 */
export const TS_METADATA_PID = 0x1f0;

/** PID for the Nth video stream (0-based) per the D3 scheme. */
export function videoStreamPid(index: number): number {
    return TS_VIDEO_PID_BASE + index;
}

/** PID for the Nth audio stream (0-based) per the D3 scheme. */
export function audioStreamPid(index: number): number {
    return TS_AUDIO_PID_BASE + index;
}

/**
 * `mpegtsmux` request-pad name that pins a stream to `pid`. Passed to the
 * runner as a `PadLinkRule.requestedPadName` so the runner requests that exact
 * sink pad instead of the implicit `sink_%d`.
 */
export function muxSinkPadName(pid: number): string {
    return `sink_${pid}`;
}

// Parser selection for re-mux pipelines lives in the Python pad-link runner
// (`gst-pipeline-runner.py`) and is driven by each pad's actual caps. The
// TS-side codec→parser table was removed when auto-detect landed.

/**
 * Format a leaky `queue` clamping its time-buffer to `bufferMs`. `leaky=2`
 * drops the oldest buffer under back-pressure rather than stalling the
 * upstream — that's the right policy for live broadcast pipelines.
 */
export function buildLeakyQueue(bufferMs: number): string {
    // 5000 ms cap matches the demuxer's slider ceiling. The cap is only there
    // to keep a runaway caller from queuing tens of seconds of latency; for
    // HLS chains the operator legitimately wants 2-3 s of jitter buffer here
    // to absorb sender-side event-loop stalls at segment boundaries.
    // 20 ms floor: `max-size-time=0` with the other bounds 0 is UNLIMITED in
    // GStreamer — the leaky policy silently never fires and any transient
    // consumer stall accumulates as permanent standing latency (and, on a
    // raw-video queue, unbounded memory). A 20 ms leaky bound adds no
    // steady-state latency (the queue sits near-empty); it only bites during
    // a stall, which is exactly when shedding is wanted.
    const clamped = Math.max(20, Math.min(5000, bufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=2 max-size-time=${ns} max-size-buffers=0 max-size-bytes=0`;
}

/**
 * Non-leaky bounded `queue` — back-pressures (blocks upstream) when full instead
 * of dropping the oldest buffer.
 *
 * Use this on the LOCAL redistribution stages (the mpegts-ip relay and the
 * demuxer's per-pad re-mux branches) where the tail is the bus-egress tee. The
 * tee always drains (`allow-not-linked=true`, per-edge branches shed on their
 * own leaky queues), so this queue sits near-empty — contributing ≈0 latency —
 * and only buffers a transient burst (a big I-frame, mpegtsmux aggregation, a
 * thread wakeup) instead of shedding a whole access unit the way `leaky=2`
 * does. On a lossless local hop shedding frames is pure damage: the transport
 * isn't dropping, so neither should we. The `bufferMs` bound is a memory/runaway safety cap that
 * a healthy clean-link path never approaches; reaching it (a genuinely stuck
 * consumer) back-pressures rather than silently corrupting the stream.
 *
 * Do NOT use this to feed a real decoder/render sink (e.g. the video-player's
 * pre-decode queue): there the consumer can legitimately fall behind and
 * dropping (leaky) is the correct bound — back-pressure would stall playout.
 */
export function buildBackpressureQueue(bufferMs: number): string {
    // Same 20 ms floor as buildLeakyQueue: all-zero bounds mean UNLIMITED, so
    // a stuck consumer would grow this queue without ever back-pressuring —
    // the opposite of this helper's contract.
    const clamped = Math.max(20, Math.min(5000, bufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=0 max-size-time=${ns} max-size-buffers=0 max-size-bytes=0`;
}

export interface TsUdpInputOpts {
    port: number;
    /** Optional element name so callers can address the ingress (e.g. for live props). */
    udpsrcName?: string;
    /** Jitter buffer length in milliseconds (default 200). Absorbs delivery
     *  jitter so downstream tsdemux doesn't see late bursts as discontinuities.
     *  200 ms covers encoder I-frame bursts on fast motion; 50 ms (the previous
     *  default) routinely overflowed and surfaced as visible "packet loss". */
    jitterMs?: number;
    /** Per-consumer edge socket (from MediaRouter). Falls back to the
     *  channel-level socket when absent. */
    socketPath?: string;
    /** Source-silent watchdog (ms) — see `BusSrcOpts.stallTimeoutMs`. */
    stallTimeoutMs?: number;
}

/**
 * Canonical inbound MPEG-TS bus receive chain:
 *   unixfdsrc (+ leaky ingress) ! queue (jitter) ! tsparse set-timestamps=false
 *
 * Why each piece:
 *   - `buildBusSrc` connects this consumer's fan-out edge; caps arrive over
 *     the socket from the producer.
 *   - `queue leaky=2` (200 ms) absorbs delivery jitter and encoder
 *     I-frame bursts; without enough headroom here a short burst of late
 *     packets is seen by tsdemux as a discontinuity and triggers a costly
 *     resync — which the user perceives as packet loss on fast motion.
 *   - `tsparse` re-frames to TS packet boundaries, and `set-timestamps=false`
 *     leaves the timestamps alone: the producer already stamped this stream
 *     onto the shared house timeline, and re-deriving from PCR here would
 *     replace one agreed timeline with this consumer's own arrival anchor — the
 *     exact divergence ADR-0005 exists to remove. NOT an option: it was one,
 *     defaulted false, and no caller ever passed true — a knob whose only
 *     setting re-introduces the fault it was kept for is a trap, not a knob.
 *     A genuinely self-contained chain that wants PCR re-anchoring builds its
 *     own tsparse rather than reaching for this helper.
 */
export function buildTsUdpInput(opts: TsUdpInputOpts): string {
    const src = buildBusSrc({
        port: opts.port,
        name: opts.udpsrcName,
        socketPath: opts.socketPath,
        stallTimeoutMs: opts.stallTimeoutMs,
    });
    const queue = buildLeakyQueue(opts.jitterMs ?? 200);
    return `${src} ! ${queue} ! tsparse set-timestamps=false`;
}
