/**
 * Inter-module bus helpers — GStreamer unixfd IPC on the local host.
 *
 * The bus moves media between modules as fd-passed memfd buffers over unix
 * sockets (`unixfdsink`/`unixfdsrc`), so buffer boundaries, caps, and
 * timestamps survive the hop and nothing can be dropped by a kernel socket
 * buffer. Requires GStreamer ≥ 1.24 with the copy-to-shm backport.
 *
 * A producer's egress is a fan-out `tee` (`buildBusSink`); the actual
 * `unixfdsink` branches are attached ONE PER CONSUMER at runtime by the
 * engine's `BusFanoutCoordinator` (`bus_attach`/`bus_detach` runner commands),
 * each on its own edge socket. Consumers read their own branch
 * (`buildBusSrc`). Non-GStreamer producers (hls-player's Node child) publish
 * through the `unixfd-fanout.py` sidecar via `busIngestSocketPath`.
 *
 * Channel identity: the allocated bus port NUMBER (from the channel manager,
 * with its sticky-reacquire semantics) — it no longer binds a socket, it keys
 * every socket path and tee name below. Keep socket dirs short: AF_UNIX paths
 * cap at ~108 chars.
 *
 * Network-facing fragments live in `netUdpHelpers.ts` — never mix the two.
 */

/**
 * Channel-level socket path for one bus channel. Used only as the fallback
 * socket for a channel with no per-consumer fan-out; the live path is
 * `busEdgeSocketPath` (one socket per consumer edge).
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
 * Socket path for one CONSUMER EDGE. Each `muxed/mpegts` connection gets its
 * own socket off the producer's `tee`, so a consumer that stops draining
 * (restart, crash-loop, preroll) only backs up its own
 * `queue leaky=2 ! unixfdsink` branch — the tee never blocks and sibling
 * consumers are untouched. Keyed by (channel port, connection id) so the
 * producer-side coordinator and the consumer-side `buildBusSrc` derive the
 * identical path independently.
 */
export function busEdgeSocketPath(port: number, connectionId: string): string {
    const dir = process.env.MR_BUS_SOCKET_DIR ?? '/tmp';
    return `${dir}/mr-bus-${port}-${shortHash(connectionId)}.sock`;
}

/**
 * Ingest socket path for a non-GStreamer bus PRODUCER (today: hls-player).
 * The producer's data process (hls-pipe's Node child) streams raw TS into
 * this socket; the module's `unixfd-fanout.py` sidecar listens here and fans
 * the stream out to the per-consumer edge sockets (`busEdgeSocketPath`)
 * speaking the GstUnixFd protocol. Keyed by the channel port like every other
 * bus path so it survives module restarts with the sticky port.
 */
export function busIngestSocketPath(port: number): string {
    const dir = process.env.MR_BUS_SOCKET_DIR ?? '/tmp';
    return `${dir}/mr-bus-${port}-ingest.sock`;
}

/** Element name of the stall watchdog `buildBusSrc` inserts for
 *  `stallTimeoutMs`. The python runner matches this prefix on error messages
 *  to tag them `kind: 'bus_stall'` (source-silent, not a hard failure). */
export const BUS_WATCHDOG_PREFIX = 'buswd';

export interface BusSrcOpts {
    /** Allocated bus channel port (identity only — names the socket). */
    port: number;
    /** Optional element name (`name=...`) on the unixfdsrc. */
    name?: string;
    /**
     * Per-consumer EDGE socket to connect to (from `busEdgeSocketPath`, handed
     * out by `MediaRouter`). Falls back to the channel-level
     * `busSocketPath(port)` when absent (fan-out-less channels).
     */
    socketPath?: string;
    /**
     * If set, insert a `watchdog` element right after the unixfdsrc that posts
     * an ERROR when no buffer arrives for this many milliseconds. The runner
     * tags that error `kind: 'bus_stall'` (via `BUS_WATCHDOG_PREFIX`) so
     * modules can treat a silent-but-connected producer differently from a
     * hard failure — the unixfd replacement for udpsrc's `timeout`. A DEAD
     * producer needs no watchdog: the socket closes and unixfdsrc errors out.
     */
    stallTimeoutMs?: number;
}

/**
 * Bus ingress for one consumer edge:
 *   unixfdsrc [! watchdog] ! queue leaky=2 (5 s)
 *
 * Caps arrive over the socket from the producer, so no caps/buffer sizing
 * applies here. A dead producer surfaces as a connection error (which trips
 * the runner's restart path) rather than a silent stall.
 *
 * The leaky queue is the consumer's drain contract. This consumer connects to
 * its OWN per-edge fan-out branch on the producer (see `buildBusSink`), so a
 * stall here can only back up this one branch's queue — never the producer or
 * a sibling consumer. The queue guarantees unixfdsrc keeps draining its
 * socket; a stalled consumer sheds its own buffers instead — the same
 * loss-locality UDP multicast gave.
 *
 * LEAKY deep ingress (5 s, never approached in steady state — mux latency
 * budget is 1.2 s — so it adds no latency and never sheds during normal
 * skew). Non-leaky ingress deadlocked gate01: stock unixfdsink sends on
 * BLOCKING client sockets under its object lock, so when THIS module's own
 * output edge stalls, a non-leaky input queue fills, unixfdsrc stops draining
 * its socket, the upstream producer's sink blocks in send holding its lock,
 * and the freeze propagates producer-by-producer through the whole graph (and
 * any bus_attach then deadlocks that runner's mainloop in gst_bin_add →
 * gst_object_check_uniqueness). Shedding after 5 s of stall cuts a muxed TS
 * mid-stream, but a stall that long has already lost the data — corruption on
 * one branch beats a wedged graph.
 */
export function buildBusSrc(opts: BusSrcOpts): string {
    const nameClause = opts.name ? ` name=${opts.name}` : '';
    const socket = opts.socketPath ?? busSocketPath(opts.port);
    // Watchdog sits BEFORE the queue so it sees exactly what the socket
    // delivers — downstream back-pressure can't fake a source stall.
    const watchdogClause = opts.stallTimeoutMs
        ? ` ! watchdog name=${BUS_WATCHDOG_PREFIX}_${opts.name ?? opts.port} timeout=${opts.stallTimeoutMs}`
        : '';
    return (
        `unixfdsrc${nameClause} socket-path=${socket}${watchdogClause}` +
        ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0'
    );
}

/**
 * Bus egress (fan-out point) for a producer:
 *   capsfilter (pinned TS caps) ! tee busout_<port> allow-not-linked=true
 *
 * The actual `unixfdsink` branches are attached one per consumer at runtime
 * via `bus_attach` (`gst-pipeline-runner.py`), each
 * `tee. ! queue leaky=2 ! unixfdsink` on its own edge socket. This is what
 * isolates consumers: unixfdsink sends under its object lock with blocking
 * sockets, so a shared sink froze every sibling when one consumer stalled; a
 * per-consumer branch with a leaky queue sheds only its own buffers instead.
 *
 * `allow-not-linked=true` lets the producer run with zero consumers attached
 * (buffers dropped at the tee) — consumers wire in later without a producer
 * rebuild. The capsfilter pins TS caps (unixfd transports caps; tsdemux
 * rejects caps-less buffers), inherited by every attached branch. The tee's
 * sink pad is the throughput-probe target (`busTeeName`).
 */
export function buildBusSink(port: number): string {
    return (
        'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
        `tee name=${busTeeName(port)} allow-not-linked=true`
    );
}
