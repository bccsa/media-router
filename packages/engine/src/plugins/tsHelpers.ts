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
