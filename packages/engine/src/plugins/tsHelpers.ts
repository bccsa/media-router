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
 * Pick the per-pad video parser element (with its required props) for an
 * upstream codec. Returns null when the codec is not supported by the local
 * GStreamer build / re-mux path.
 *
 * Used by:
 *   - mpegts-muxer: pick the parser per upstream encoder's `config.codec`.
 *   - mpegts-demuxer: pick the parser per its `videoCodec` config field.
 */
export function videoParserForCodec(codec: string | undefined): string | null {
    switch (codec) {
        case 'h264':
        case undefined: // legacy upstreams that don't surface a codec — assume h264
            return 'h264parse config-interval=1';
        case 'h265':
            return 'h265parse config-interval=1';
        case 'av1':
            return 'av1parse';
        default:
            return null;
    }
}

/**
 * Format a leaky `queue` clamping its time-buffer to `bufferMs`. `leaky=2`
 * drops the oldest buffer under back-pressure rather than stalling the
 * upstream — that's the right policy for live broadcast pipelines.
 */
export function buildLeakyQueue(bufferMs: number): string {
    const clamped = Math.max(0, Math.min(2000, bufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=2 max-size-time=${ns} max-size-buffers=0 max-size-bytes=0`;
}

export interface TsUdpInputOpts {
    host: string;
    port: number;
    /** Optional `udpsrc name=…` so callers can address it (e.g. for live props). */
    udpsrcName?: string;
    /** Jitter buffer length in milliseconds (default 50). Absorbs UDP delivery
     *  jitter so downstream tsdemux doesn't see late bursts as discontinuities. */
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
 *   - `queue leaky=2` (50 ms) absorbs UDP delivery jitter; without it a
 *     short burst of late packets is seen by tsdemux as a discontinuity
 *     and triggers a costly resync.
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
    const queue = buildLeakyQueue(opts.jitterMs ?? 50);
    return `${udpsrc} ! ${queue} ! tsparse set-timestamps=true`;
}
