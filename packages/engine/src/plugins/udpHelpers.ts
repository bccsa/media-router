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
 * Inter-module bus transport. `MR_BUS_TRANSPORT=unixfd` swaps the loopback
 * multicast bus (udpsink/udpsrc) for GStreamer's unixfd IPC — fd-passed
 * memfd buffers over a unix socket, so buffer boundaries, caps, and
 * timestamps survive the hop and nothing can be dropped by a kernel socket
 * buffer. Requires GStreamer ≥ 1.24 with the copy-to-shm backport (test
 * prefix: `source ~/gst-1.24/env.sh`).
 *
 * Only the gst↔gst loopback-bus hops flip; consumers that read the bus with
 * their own UDP sockets stay on UDP and go silent under unixfd: the rist
 * CLI relays, hls-player's PacedUdpTsSink, and video-player's dgram resume
 * probe. Network-facing builders (`buildNetUdpSrc`/`buildNetUdpSink`) are
 * never affected.
 *
 * Read per call (not cached) so tests and module rebuilds see env changes.
 */
export type BusTransport = 'udp' | 'unixfd';

export function busTransport(): BusTransport {
    return process.env.MR_BUS_TRANSPORT === 'unixfd' ? 'unixfd' : 'udp';
}

/**
 * Socket path for one bus channel under unixfd transport. The UDP port
 * number remains the channel identity — `UdpPortManager` still allocates
 * it, with all its sticky-reacquire semantics — it just names a socket
 * instead of binding one. Keep the dir short: AF_UNIX paths cap at ~108
 * chars.
 *
 * Used only as the fallback socket for a bus channel with no per-consumer
 * fan-out; the live path is `busEdgeSocketPath` (one socket per consumer
 * edge — see the fan-out note on `buildUdpSink`).
 */
export function busSocketPath(port: number): string {
    const dir = process.env.MR_BUS_SOCKET_DIR ?? '/tmp';
    return `${dir}/mr-bus-${port}.sock`;
}

/**
 * Element name of a producer's bus-egress fan-out `tee`, derived from its
 * allocated channel port. Deterministic so the engine-side fan-out
 * coordinator can address the tee (`bus_attach`/`bus_detach`) knowing only
 * the port, without the producer registering its element names. Also the
 * throughput-probe target (the tee's sink pad carries the full output rate,
 * consumers or not).
 */
export function busTeeName(port: number): string {
    return `busout_${port}`;
}

/** 32-bit FNV-1a → 6 hex chars. Keeps per-edge socket paths short (AF_UNIX
 *  ~108-char cap) and collision-safe within a channel's connection set. */
function shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(6, '0').slice(-6);
}

/**
 * Socket path for one CONSUMER EDGE under unixfd. Each `muxed/mpegts`
 * connection gets its own socket off the producer's `tee`, so a consumer
 * that stops draining (restart, crash-loop, preroll) only backs up its own
 * `queue leaky=2 ! unixfdsink` branch — the tee never blocks and sibling
 * consumers are untouched. Keyed by (channel port, connection id) so the
 * producer-side coordinator and the consumer-side `buildUdpSrc` derive the
 * identical path independently.
 */
export function busEdgeSocketPath(port: number, connectionId: string): string {
    const dir = process.env.MR_BUS_SOCKET_DIR ?? '/tmp';
    return `${dir}/mr-bus-${port}-${shortHash(connectionId)}.sock`;
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
    /**
     * Explicit unixfd bus socket to connect to (a per-consumer EDGE socket
     * from `busEdgeSocketPath`). When set, overrides the channel-level
     * `busSocketPath(port)` so this consumer reads its own dedicated fan-out
     * branch. Ignored under UDP transport. See the fan-out note on
     * `buildUdpSink`.
     */
    socketPath?: string;
}

export function buildUdpSrc(opts: UdpSrcOpts): string {
    if (isMulticast(opts.host) && busTransport() === 'unixfd') {
        // caps, buffer-size, and timeout don't apply here: caps arrive over
        // the socket from the producer, there is no kernel rcvbuf to size,
        // and a dead producer surfaces as a connection error (which trips
        // the runner's restart path) rather than a silent stall.
        //
        // The leaky queue is the consumer's drain contract. This consumer
        // connects to its OWN per-edge fan-out branch on the producer (see
        // buildUdpSink), so a stall here can only back up this one branch's
        // queue — never the producer or a sibling consumer. The queue
        // guarantees unixfdsrc keeps draining its socket; a stalled consumer
        // sheds its own buffers instead — same loss-locality UDP gave us.
        const nameClause = opts.name ? ` name=${opts.name}` : '';
        const socket = opts.socketPath ?? busSocketPath(opts.port);
        // NON-leaky bounded ingress: a shed here cuts a muxed TS mid-stream
        // (receiver-visible corruption). With per-consumer fan-out the
        // producer no longer needs consumer-side shedding — a stalled
        // consumer back-pressures only its own producer-edge branch, whose
        // leaky queue is the (sole, whole-branch) shed point.
        return (
            `unixfdsrc${nameClause} socket-path=${socket}` +
            ' ! queue leaky=0 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0'
        );
    }
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
    if (isMulticast(opts.host) && busTransport() === 'unixfd') {
        // Fan-out point. The producer's egress is a `tee` (named
        // deterministically from the port so the engine coordinator can
        // address it); the actual `unixfdsink` branches are attached ONE PER
        // CONSUMER at runtime via the `bus_attach` command
        // (`gst-pipeline-runner.py`), each `tee. ! queue leaky=2 ! unixfdsink`
        // on its own edge socket. This is what isolates consumers: unixfdsink
        // sends under its object lock with blocking sockets, so a shared sink
        // froze every sibling when one consumer stalled; a per-consumer branch
        // with a leaky queue sheds only its own buffers instead.
        //
        // `allow-not-linked=true` lets the producer run with zero consumers
        // attached (buffers dropped at the tee) — consumers wire in later
        // without a producer rebuild. The capsfilter pins TS caps (unixfd
        // transports caps; tsdemux rejects caps-less buffers), inherited by
        // every attached branch. No `unixfdsink` here means no sink-name to
        // poll for throughput — the tee's sink pad is the probe target.
        return (
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
            `tee name=${busTeeName(opts.port)} allow-not-linked=true`
        );
    }
    // UDP multicast bus (legacy transport, kept for the non-GStreamer raw-socket
    // users): unchanged — multicast fans out on its own, so no tee is needed and
    // the element keeps the caller's name for throughput polling.
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
