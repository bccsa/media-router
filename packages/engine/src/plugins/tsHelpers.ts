/**
 * Shared MPEG-TS pipeline helpers used by every plugin that builds tsdemux /
 * mpegtsmux chains (muxer, demuxer, future remux plugins).
 *
 * Centralises three host-machine assumptions:
 *   - which video codec → parser element name to use,
 *   - the leaky-queue shape we use after every dynamic pad,
 *   - the default `mpegtsmux alignment` (=7, packed UDP).
 */

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
