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
/**
 * Dotted-quad address of `MULTICAST_IFACE` for Node `dgram` sockets —
 * GStreamer takes the interface name, dgram takes its address. Flip both
 * together when moving beyond local-loop multicast.
 */
export const MULTICAST_IFACE_ADDR = '127.0.0.1';

export function isMulticast(host: string): boolean {
    return host.startsWith(MULTICAST_PREFIX);
}

/**
 * Network-side (non-loopback) multicast test covering the full 224.0.0.0/4
 * range (`224.` – `239.`). Used by the MPEG-TS-over-IP plugins that talk to a
 * real NIC, where a group address may be anywhere in the class-D range — unlike
 * the loopback bus, which only ever uses the `239.` convention (`isMulticast`).
 */
export function isMulticastAddr(host: string): boolean {
    const first = Number(host.split('.', 1)[0]);
    return first >= 224 && first <= 239;
}

/**
 * udpsrc kernel receive buffer (SO_RCVBUF), 8 MB — 2× the 4 MB helper default.
 *
 * Used by every plugin that reads a high-bitrate MPEG-TS off a UDP socket
 * (mpegts-ip-input from the NIC; mpegts-muxer / mpegts-demuxer off the local
 * bus). A 1080p keyframe is an 80 kB+ burst, and a software H.264 decoder
 * drains in bursts; a 4 MB socket buffer overruns on those and the kernel
 * silently drops datagrams, which surfaces downstream as macroblocking /
 * "packet loss". 8 MB absorbs the bursts and stays well under the usual
 * net.core.rmem_max (16 MB) so the kernel honours it. This is the receive
 * side only — it does not hit the SO_SNDBUF-at-wmem_max issue that broke the
 * loopback sink, so udpsink buffers stay at the helper default.
 */
export const NET_UDP_RCV_BUF = 8 * 1024 * 1024;

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
    // 4 MB default — picked as a compromise:
    //   - Producer-restart UX: stale data buffered here plays out before the
    //     new stream's keyframe arrives. At 5 Mbps, 4 MB holds ~6 s, vs ~25 s
    //     at 16 MB. Smaller = shorter "old frames on top of new" window.
    //   - Loss tolerance: 2 MB showed ~10 RcvbufErrors/s even with hls-player's
    //     PacedUdpTsSink (pacing is approximate — micro-bursts still spike).
    //     4 MB absorbs those without growing the stale-restart window much.
    // Plugins with bursty sources can still pass an explicit larger `bufferSize`.
    const buf = opts.bufferSize ?? 4 * 1024 * 1024;
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
    /**
     * GStreamer `async` flag. Defaults to GStreamer's own default (`true`) when
     * unset. Set `false` for a sink that is added to an ALREADY-PLAYING pipeline
     * at runtime (e.g. the demuxer's per-pad branches, attached on pad-added):
     * an async sink holds its first buffer for preroll and emits
     * ASYNC_START/ASYNC_DONE, which on a sub-bin synced into a running pipeline
     * never completes — the sink stays in preroll and back-pressures the shared
     * upstream pad, stalling every sibling branch (the pipeline reaches PLAYING
     * but pumps nothing). `async=false` skips preroll so the sink renders
     * immediately. Harmless for statically-built pipelines (they preroll once at
     * startup), so callers that don't set it keep today's behaviour.
     */
    async?: boolean;
}

export function buildUdpSink(opts: UdpSinkOpts): string {
    // 4 MB SO_SNDBUF default, matching buildUdpSrc — symmetric with the
    // receiver-side default so the sender can absorb brief kernel scheduling
    // hiccups without blocking.
    const buf = opts.bufferSize ?? 4 * 1024 * 1024;
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const sync = opts.sync === true ? 'true' : 'false';
    const asyncClause = opts.async === false ? ' async=false' : '';
    if (isMulticast(opts.host)) {
        return `udpsink${nameClause} host=${opts.host} port=${opts.port} multicast-iface=${MULTICAST_IFACE} auto-multicast=true buffer-size=${buf} sync=${sync}${asyncClause}`;
    }
    return `udpsink${nameClause} host=${opts.host} port=${opts.port} buffer-size=${buf} sync=${sync}${asyncClause}`;
}

/**
 * Network-facing udpsrc/udpsink builders for MPEG-TS-over-IP plugins.
 *
 * These differ from the loopback `buildUdpSrc`/`buildUdpSink` above in two ways:
 *   - they bind to a real, caller-chosen NIC (`multicast-iface=<iface>`) instead
 *     of the hard-coded `lo` loopback the local bus uses,
 *   - the sink exposes multicast TTL (`ttl-mc`) / unicast TTL (`ttl`).
 *
 * Multicast is detected over the full class-D range via `isMulticastAddr`,
 * because a network group can be anywhere in `224.`–`239.` (the loopback bus is
 * always `239.`). Kept separate so the single-host loopback assumptions in the
 * helpers above never leak onto the wire.
 */
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
    /** Kernel receive buffer in bytes (defaults to 4 MB, matching the loopback helper). */
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
    /** Kernel send buffer in bytes (defaults to 4 MB, matching the loopback helper). */
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

export interface TsRepackRelayOpts {
    /** Receive side — a `239.x` loopback-bus group or a unicast loopback address. */
    in: { host: string; port: number };
    /** Send side. */
    out: { host: string; port: number };
    /** tsparse packets-per-buffer: 1 depacketizes to 188-byte packets, 7 packs to 1316 B. */
    alignment: number;
}

/**
 * `gst-launch-1.0` argv for a standalone TS packet-size relay:
 *   udpsrc(in) ! queue ! tsparse alignment=N set-timestamps=false ! udpsink(out)
 *
 * The RIST plugins' CLI tools (ristreceiver/ristsender) only speak UDP sockets —
 * no stdio — so packet-size normalization runs as a sidecar relay between the
 * CLI's private loopback port and the multicast bus. `239.x` hosts use loopback
 * multicast; any other host is treated as plain unicast (loopback). alignment=1
 * depacketizes an inbound bundle to 188 B; alignment=7 re-packs the 188-byte bus
 * to 1316 B. set-timestamps=false keeps the source PCR (pure relay).
 *
 * Returned as a token array (not a string) because gst-launch parses each argv
 * element as one pipeline token.
 */
export function buildTsRepackRelayArgs(opts: TsRepackRelayOpts): string[] {
    const src = isMulticast(opts.in.host)
        ? `udpsrc multicast-group=${opts.in.host} port=${opts.in.port} multicast-iface=${MULTICAST_IFACE} auto-multicast=true buffer-size=${NET_UDP_RCV_BUF}`
        : `udpsrc address=${opts.in.host} port=${opts.in.port} buffer-size=${NET_UDP_RCV_BUF}`;
    const sink = isMulticast(opts.out.host)
        ? `udpsink host=${opts.out.host} port=${opts.out.port} multicast-iface=${MULTICAST_IFACE} auto-multicast=true sync=false`
        : `udpsink host=${opts.out.host} port=${opts.out.port} sync=false`;
    const pipeline =
        `${src} ! queue leaky=0 max-size-buffers=0 max-size-bytes=0 max-size-time=200000000 ` +
        `! tsparse alignment=${opts.alignment} set-timestamps=false ! ${sink}`;
    return ['-q', ...pipeline.split(/\s+/).filter(Boolean)];
}
