/**
 * Network-facing udpsrc/udpsink builders for MPEG-TS-over-IP plugins.
 *
 * These talk to a real, caller-chosen NIC (`multicast-iface=<iface>`) and are
 * deliberately separate from the loopback bus helpers (`busHelpers.ts`) — the
 * inter-module bus is unixfd IPC, while these fragments go on the wire.
 *
 * Multicast is detected over the full class-D range via `isMulticastAddr`,
 * because a network group can be anywhere in `224.`–`239.`.
 */

/**
 * Network-side multicast test covering the full 224.0.0.0/4 range
 * (`224.` – `239.`). Used by the MPEG-TS-over-IP plugins that talk to a real
 * NIC, where a group address may be anywhere in the class-D range.
 */
export function isMulticastAddr(host: string): boolean {
    const first = Number(host.split('.', 1)[0]);
    return first >= 224 && first <= 239;
}

/**
 * udpsrc kernel receive buffer (SO_RCVBUF), 8 MB — 2× the 4 MB helper default.
 *
 * Used by every plugin that reads a high-bitrate MPEG-TS off a network UDP
 * socket (mpegts-ip-input from the NIC). A 1080p keyframe is an 80 kB+ burst,
 * and a software H.264 decoder drains in bursts; a 4 MB socket buffer overruns
 * on those and the kernel silently drops datagrams, which surfaces downstream
 * as macroblocking / "packet loss". 8 MB absorbs the bursts and stays well
 * under the usual net.core.rmem_max (16 MB) so the kernel honours it. This is
 * the receive side only — udpsink buffers stay at the helper default.
 */
export const NET_UDP_RCV_BUF = 8 * 1024 * 1024;

export interface NetUdpSrcOpts {
    port: number;
    /** If set, join this multicast group (else plain unicast listen on `port`). */
    multicastGroup?: string;
    /** Network interface name for the multicast join (e.g. `eth0`); empty = default. */
    iface?: string;
    /** Explicit caps to declare on the src pad (e.g. MPEG-TS or RTP caps). */
    caps?: string;
    /** Element name (`name=...`). */
    name?: string;
    /** udpsrc `timeout` in nanoseconds — runner turns the timeout message into a bus error. */
    timeoutNs?: number;
    /** Kernel receive buffer in bytes (defaults to 4 MB). */
    bufferSize?: number;
}

export function buildNetUdpSrc(opts: NetUdpSrcOpts): string {
    const buf = opts.bufferSize ?? 4 * 1024 * 1024;
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const capsClause = opts.caps ? ` caps="${opts.caps}"` : '';
    const timeoutClause = opts.timeoutNs ? ` timeout=${opts.timeoutNs}` : '';
    if (opts.multicastGroup && isMulticastAddr(opts.multicastGroup)) {
        const ifaceClause = opts.iface ? ` multicast-iface=${opts.iface}` : '';
        return `udpsrc${nameClause} multicast-group=${opts.multicastGroup} port=${opts.port}${ifaceClause} auto-multicast=true buffer-size=${buf}${timeoutClause}${capsClause}`;
    }
    return `udpsrc${nameClause} port=${opts.port} buffer-size=${buf}${timeoutClause}${capsClause}`;
}

export interface NetUdpSinkOpts {
    host: string;
    port: number;
    /** Network interface name for multicast egress (e.g. `eth0`); empty = default. */
    iface?: string;
    /** TTL — applied as `ttl-mc` for multicast hosts, `ttl` for unicast. */
    ttl?: number;
    /** Element name (`name=...`). */
    name?: string;
    /** GStreamer `sync` flag — defaults to false (broadcast pipelines). */
    sync?: boolean;
    /** Kernel send buffer in bytes (defaults to 4 MB). */
    bufferSize?: number;
}

export function buildNetUdpSink(opts: NetUdpSinkOpts): string {
    const buf = opts.bufferSize ?? 4 * 1024 * 1024;
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const sync = opts.sync === true ? 'true' : 'false';
    if (isMulticastAddr(opts.host)) {
        const ifaceClause = opts.iface ? ` multicast-iface=${opts.iface}` : '';
        const ttlClause = opts.ttl !== undefined ? ` ttl-mc=${opts.ttl}` : '';
        return `udpsink${nameClause} host=${opts.host} port=${opts.port}${ifaceClause} auto-multicast=true${ttlClause} buffer-size=${buf} sync=${sync}`;
    }
    const ttlClause = opts.ttl !== undefined ? ` ttl=${opts.ttl}` : '';
    return `udpsink${nameClause} host=${opts.host} port=${opts.port}${ttlClause} buffer-size=${buf} sync=${sync}`;
}
