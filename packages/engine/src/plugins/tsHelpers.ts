/**
 * Shared MPEG-TS pipeline helpers used by every plugin that builds mrtsdemux /
 * mpegtsmux chains (muxer, demuxer, future remux plugins).
 *
 * Centralises three host-machine assumptions:
 *   - which video codec → parser element name to use,
 *   - the bounded-queue shapes (time bound + optional byte cap, ADR-0015)
 *     used after every dynamic pad,
 *   - the default `mpegtsmux alignment` (=7, packed UDP).
 */

import { tsQueueByteCap } from './queueBounds.js';

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
 *
 * `maxBytes` (default 0 = unlimited) adds a byte ceiling that holds even when
 * the time bound cannot — see `queueBounds.ts` for why, the sizing helper
 * `tsQueueByteCap`, and which callers still run time-only. Never set it on a
 * raw-video queue.
 */
export function buildLeakyQueue(bufferMs: number, maxBytes = 0): string {
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
    return `queue leaky=2 max-size-time=${ns} max-size-buffers=0 max-size-bytes=${maxBytes}`;
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
 *
 * `maxBytes` (default 0 = unlimited): byte ceiling that back-pressures even
 * when stalled timestamps defeat the time bound (see `queueBounds.ts`).
 */
export function buildBackpressureQueue(bufferMs: number, maxBytes = 0): string {
    // Same 20 ms floor as buildLeakyQueue: all-zero bounds mean UNLIMITED, so
    // a stuck consumer would grow this queue without ever back-pressuring —
    // the opposite of this helper's contract.
    const clamped = Math.max(20, Math.min(5000, bufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=0 max-size-time=${ns} max-size-buffers=0 max-size-bytes=${maxBytes}`;
}

/** `name=` of a network ingest's queue; the native runner reports the sheds of a queue so named. */
export const INGEST_QUEUE_NAME = 'ingestq';
/** The plugin event of one episode of that queue shedding (`shed_watch.cpp`). */
export const QUEUE_SHED_EVENT = 'queue_shed';
/** Its bound: this long at 64 Mbit/s, 800 ms at 40 Mbit/s (B-182). */
export const INGEST_QUEUE_MS = 500;

/**
 * The queue between a network ingest's restamp and its bus sink (B-182). Leaky, so a stall never
 * holds the transport's thread the restamp reads arrival on; bounded by bytes alone, as its time
 * level is the transport's own stamps (srtsrc: send time) and 200 buffers are 75 ms at 28 Mbit/s.
 */
export function buildIngestQueue(): string {
    return (
        `queue name=${INGEST_QUEUE_NAME} leaky=2 max-size-time=0 max-size-buffers=0 ` +
        `max-size-bytes=${tsQueueByteCap(INGEST_QUEUE_MS)} flush-on-eos=true`
    );
}

/**
 * Re-slice bus buffers to `packets` TS packets per buffer for a datagram sink
 * that does not split on its own (udpsink; srtsink slices itself — ADR-0011
 * rule 2). `set-timestamps=false` makes this a pure re-chunk: the producer's
 * house stamps ride through, no PCR re-timing (the one thing tsparse must never
 * do mid-pipeline under ADR-0005).
 */
export function buildTsRechunk(packets: number): string {
    return `tsparse alignment=${packets} set-timestamps=false`;
}
