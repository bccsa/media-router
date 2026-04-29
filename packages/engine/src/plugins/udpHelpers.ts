/**
 * Shared udpsrc / udpsink string builders for media-routing plugins.
 *
 * Centralises two host-machine assumptions that need to flip in one place
 * when we move beyond single-host multicast:
 *   - the `239.x.x.x` prefix that classifies an address as multicast
 *   - the `multicast-iface=lo` choice (today's local-loop routing)
 *
 * Plugins should call these helpers instead of formatting their own udpsrc /
 * udpsink strings — both for consistency and so a future cross-host rollout
 * only edits this file.
 */

const MULTICAST_PREFIX = '239.';
const MULTICAST_IFACE = 'lo';

export function isMulticast(host: string): boolean {
    return host.startsWith(MULTICAST_PREFIX);
}

export interface UdpSrcOpts {
    host: string;
    port: number;
    /** udpsrc kernel buffer-size in bytes (defaults to 2 MB). */
    bufferSize?: number;
    /** Optional explicit caps to declare on the udpsrc src pad. */
    caps?: string;
    /** Optional element name (`name=...`). */
    name?: string;
    /**
     * If set, udpsrc posts a `GstUDPSrcTimeout` element message on the bus
     * when no packets arrive for this duration (nanoseconds). The Python
     * runner translates that to an `error` event so the gst-runner restart
     * path triggers — necessary because a stalled UDP source is otherwise
     * silent and never emits a bus error of its own.
     */
    timeoutNs?: number;
}

export function buildUdpSrc(opts: UdpSrcOpts): string {
    const buf = opts.bufferSize ?? 2_097_152;
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const capsClause = opts.caps ? ` caps="${opts.caps}"` : '';
    const timeoutClause = opts.timeoutNs ? ` timeout=${opts.timeoutNs}` : '';
    if (isMulticast(opts.host)) {
        return `udpsrc${nameClause} multicast-group=${opts.host} port=${opts.port} multicast-iface=${MULTICAST_IFACE} auto-multicast=true buffer-size=${buf}${timeoutClause}${capsClause}`;
    }
    return `udpsrc${nameClause} port=${opts.port} buffer-size=${buf}${timeoutClause}${capsClause}`;
}

export interface UdpSinkOpts {
    host: string;
    port: number;
    /** Optional element name (`name=...`). */
    name?: string;
    /** udpsink kernel buffer-size in bytes (defaults to 2 MB). */
    bufferSize?: number;
    /** GStreamer `sync` flag — defaults to false (broadcast pipelines). */
    sync?: boolean;
}

export function buildUdpSink(opts: UdpSinkOpts): string {
    const buf = opts.bufferSize ?? 2_097_152;
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const sync = opts.sync === true ? 'true' : 'false';
    if (isMulticast(opts.host)) {
        return `udpsink${nameClause} host=${opts.host} port=${opts.port} multicast-iface=${MULTICAST_IFACE} auto-multicast=true buffer-size=${buf} sync=${sync}`;
    }
    return `udpsink${nameClause} host=${opts.host} port=${opts.port} buffer-size=${buf} sync=${sync}`;
}
