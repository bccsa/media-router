/**
 * Shared MPEG-TS pipeline helpers used by every plugin that builds tsdemux /
 * mpegtsmux chains (muxer, demuxer, future remux plugins).
 *
 * Centralises three host-machine assumptions:
 *   - which video codec → parser element name to use,
 *   - the leaky-queue shape we use after every dynamic pad,
 *   - the default `mpegtsmux alignment` (=7, packed UDP).
 */

import { buildUdpSrc } from './udpHelpers.js';

/** Default `mpegtsmux alignment`. 7 = pack 7 TS packets per UDP buffer (1316 B). */
export const DEFAULT_MPEGTS_ALIGNMENT = 7;

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
    const clamped = Math.max(0, Math.min(5000, bufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=2 max-size-time=${ns} max-size-buffers=0 max-size-bytes=0`;
}

export interface TsUdpInputOpts {
    host: string;
    port: number;
    /** Optional `udpsrc name=…` so callers can address it (e.g. for live props). */
    udpsrcName?: string;
    /** Jitter buffer length in milliseconds (default 200). Absorbs UDP delivery
     *  jitter so downstream tsdemux doesn't see late bursts as discontinuities.
     *  200 ms covers encoder I-frame bursts on fast motion; 50 ms (the previous
     *  default) routinely overflowed and surfaced as visible "packet loss". */
    jitterMs?: number;
    /** udpsrc timeout in nanoseconds; the runner translates the resulting
     *  `GstUDPSrcTimeout` element message into a bus error so the restart path
     *  triggers when a stream goes silent. */
    timeoutNs?: number;
}

/**
 * Canonical inbound MPEG-TS UDP receive chain:
 *   udpsrc ! queue (jitter) ! tsparse set-timestamps=true
 *
 * Why each piece:
 *   - `udpsrc` declares MPEG-TS caps so caps negotiation works before the
 *     first packet arrives.
 *   - `queue leaky=2` (200 ms) absorbs UDP delivery jitter and encoder
 *     I-frame bursts; without enough headroom here a short burst of late
 *     packets is seen by tsdemux as a discontinuity and triggers a costly
 *     resync — which the user perceives as packet loss on fast motion.
 *   - `tsparse set-timestamps=true` re-frames to TS packet boundaries and
 *     re-derives PTS/DTS from PCR, anchoring them to the local clock. This
 *     is the load-bearing fix for progressive latency growth across
 *     re-muxing stages: each downstream `mpegtsmux` would otherwise mix
 *     the upstream encoder's clock with its own and drift over time.
 */
export function buildTsUdpInput(opts: TsUdpInputOpts): string {
    const udpsrc = buildUdpSrc({
        host: opts.host,
        port: opts.port,
        caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
        name: opts.udpsrcName,
        timeoutNs: opts.timeoutNs,
    });
    const queue = buildLeakyQueue(opts.jitterMs ?? 200);
    return `${udpsrc} ! ${queue} ! tsparse set-timestamps=true`;
}
