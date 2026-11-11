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
 * (`buildBusSrc`), up to their demux with `buildBusDemux`. Non-GStreamer
 * producers (hls-player's Node child) publish through the `mr-bus-fanout`
 * sidecar via `busIngestSocketPath`.
 *
 * Channel identity: the allocated bus port NUMBER (from the channel manager,
 * with its sticky-reacquire semantics) — it no longer binds a socket, it keys
 * every socket path and tee name below. Keep socket dirs short: AF_UNIX paths
 * cap at ~108 chars.
 *
 * Network-facing fragments live in `netUdpHelpers.ts` — never mix the two.
 */

/**
 * The caps EVERY bus producer publishes — identity, not a hint. unixfd carries
 * caps across the socket and the demux (`mrtsdemux`) rejects caps-less
 * buffers, so both producer paths must publish exactly this and nothing more:
 * the GStreamer egress (`buildBusSink`) and the `mr-bus-fanout` sidecar (`--caps`).
 *
 * "Nothing more" is load-bearing — see the `capssetter` note in `buildBusSink`.
 */
import { tsQueueByteCap } from './queueBounds.js';
import { busEgressLatenessTap, busLatenessTap, LAT_IN_PREFIX } from './latenessTap.js';
import { buildBackpressureQueue } from './tsHelpers.js';

export const BUS_TS_CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';

/**
 * Channel-level socket path for one bus channel. Used only as the fallback
 * socket for a channel with no per-consumer fan-out; the live path is
 * `busEdgeSocketPath` (one socket per consumer edge).
 */
/**
 * Quote a string for a gst-launch pipeline description property value
 * (`prop="..."`): backslash-escapes `\\` and `"`, so URLs with `?&=`,
 * passphrases with spaces or quotes, etc. survive `Gst.parse_launch`.
 */
export function quoteGstString(value: string): string {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

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

/** The ingress lateness tap of bus source `busin` (its unixfdsrc name, or a
 *  port-derived key). Always `lat_busin…`, the prefix the reporter reads as an input. */
export function latInName(busin: string | number): string {
    const key = String(busin);
    return key.startsWith('busin') ? `lat_${key}` : `${LAT_IN_PREFIX}_${key}`;
}

/** The egress lateness tap in front of `busTeeName(port)`. */
export function latOutName(port: number): string {
    return `lat_${busTeeName(port)}`;
}

/** 32-bit FNV-1a → 6 hex chars. Keeps per-edge socket paths short (AF_UNIX
 *  ~108-char cap) and collision-safe within a channel's connection set. Also
 *  what an aggregator sink names its per-connection input branch bin from
 *  (`PluginModule.getLiveInputBranch`). */
export function shortHash(s: string): string {
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

/** The channel port a bus socket path is keyed by (`busSocketPath`, `busEdgeSocketPath`,
 *  `busIngestSocketPath`); undefined for any other path. */
export function busSocketPort(path: string): number | undefined {
    const m = /\/mr-bus-(\d+)(?:-[^/]*)?\.sock$/.exec(path);
    return m ? Number(m[1]) : undefined;
}

/**
 * Ingest socket path for a non-GStreamer bus PRODUCER (today: hls-player).
 * The producer's data process (hls-pipe's Node child) streams raw TS into
 * this socket; the module's `mr-bus-fanout` sidecar listens here and fans
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
 *   unixfdsrc [! watchdog] ! mrlateness ! queue leaky=2 (5 s, 40 MB byte cap — ADR-0015)
 * The tap (`latInName`) sits before the queue to read arrival, on `bus_input_add` branches too;
 * an unnamed source keys it by edge socket, so two edges of one channel never collide.
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
 *
 * It and the producer's fan-out branch stay `leaky=2` (OQ-30): a full one is a resource fault the
 * runners' queue watch reports (`queue_overrun`, B-170), not a lateness drop, and a real backlog
 * only on the image's queue, which starts its level afresh once drained (B-68).
 *
 * The byte bound (5 s at 64 Mbit/s = 40 MB) is the timestamp-independent
 * backstop — see `queueBounds.ts`. Everything on the bus is compressed TS or
 * 302M, so a healthy edge never reaches it.
 */
const BUS_INGRESS_QUEUE_MS = 5000;
const BUS_INGRESS_QUEUE_BYTES = tsQueueByteCap(BUS_INGRESS_QUEUE_MS);

/** The ingress lateness tap `buildBusSrc(opts)` puts after its unixfdsrc: what a runner probe
 *  of that input's TS (`PipelineDescription.catchUp`) finds and names it by (B-206). */
export function busSrcTapName(opts: Pick<BusSrcOpts, 'port' | 'name' | 'socketPath'>): string {
    const socket = opts.socketPath ?? busSocketPath(opts.port);
    return latInName(
        opts.name ?? (opts.socketPath ? `${opts.port}_${shortHash(socket)}` : opts.port),
    );
}

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
        busLatenessTap(busSrcTapName(opts)) +
        ` ! queue leaky=2 max-size-time=${BUS_INGRESS_QUEUE_MS * 1_000_000}` +
        ` max-size-buffers=0 max-size-bytes=${BUS_INGRESS_QUEUE_BYTES}`
    );
}

export interface TsUdpInputOpts {
    port: number;
    /** Optional element name so callers can address the ingress (e.g. for live props). */
    udpsrcName?: string;
    /** Jitter buffer length in milliseconds (default 200): holds delivery jitter
     *  and encoder I-frame bursts ahead of the demux. Sizes a BACK-PRESSURING
     *  queue (never leaky — see `buildTsUdpInput`), so a value that is too
     *  small costs a momentary stall, never a corrupted picture. */
    jitterMs?: number;
    /** Per-consumer edge socket (from MediaRouter). Falls back to the
     *  channel-level socket when absent. */
    socketPath?: string;
    /** Source-silent watchdog (ms) — see `BusSrcOpts.stallTimeoutMs`. */
    stallTimeoutMs?: number;
}

/**
 * Canonical inbound MPEG-TS bus receive chain, ahead of the consumer's demux:
 *   unixfdsrc (+ leaky ingress) ! queue (jitter, back-pressuring)
 *
 * Why each piece:
 *   - `buildBusSrc` connects this consumer's fan-out edge; caps arrive over
 *     the socket from the producer.
 *   - `queue leaky=0` (jitterMs) absorbs delivery jitter and encoder I-frame
 *     bursts and BACK-PRESSURES when it fills — it must never leak. This
 *     queue carries raw TS: a leaked chunk is a mid-slice hole that corrupts
 *     every dependent frame until the next IDR, which the operator sees as
 *     "packet loss on movement" while every counter (SRT loss, decoder
 *     errors on an independent tap) reads zero. Measured 2026-09-02, Pi 5
 *     player: a 30→25 fps source (66 ms between some frames) into a 50 ms
 *     LEAKY jitter queue smeared every moving object; 200 ms hid it; the
 *     leak is the fault, not the size. Raising the size was the previous
 *     answer (50→200 default) and merely moved the cliff. A full queue now
 *     pushes back into `buildBusSrc`'s 5 s ingress queue instead, which
 *     loses content only at capacity and reports `queue-full` (Phase 4 plays
 *     on arrival, nothing drops late). Same finding as the
 *     mpegts-muxer's input queues (leaky shed 11 % of audio, non-leaky zero).
 *   - No re-framer: the bus carries whole 188-byte packets (ADR-0011) and the demux
 *     re-frames any other split itself (`PacketWalker` carries a partial packet). The
 *     `tsparse` here until WI-P3-18 also cleared every buffer flag, a gap marker's too.
 */
export function buildTsUdpInput(opts: TsUdpInputOpts): string {
    const src = buildBusSrc({
        port: opts.port,
        name: opts.udpsrcName,
        socketPath: opts.socketPath,
        stallTimeoutMs: opts.stallTimeoutMs,
    });
    const queue = buildBackpressureQueue(opts.jitterMs ?? 200);
    return `${src} ! ${queue}`;
}

export interface BusDemuxOpts {
    /** Allocated bus channel port (`BusSrcOpts.port`). */
    port: number;
    /** Per-consumer edge socket (`BusSrcOpts.socketPath`). */
    socketPath?: string;
    /** `name=` of the unixfdsrc, which also keys its lateness tap (`BusSrcOpts.name`). */
    srcName?: string;
    /** Source-silent watchdog in ms (`BusSrcOpts.stallTimeoutMs`). */
    stallTimeoutMs?: number;
    /** Bound of the back-pressuring jitter queue after the bus source, in ms (`buildTsUdpInput`);
     *  unset, the demux takes the ingress queue's output. */
    jitterMs?: number;
    /** A `tee name=<name>` before the demux, for a tap the caller links off `<name>.`; `queue`
     *  puts a plain `queue` between the tee and the demux. */
    tee?: { name: string; queue?: boolean };
    /** `name=` of the mrtsdemux. */
    name: string;
    /** Select mode: the one stream of these caps on the src pad (`select=`). */
    select?: string;
    /** Demux mode: the pad classes, comma-separated (`media=`); unset, every class. */
    media?: string;
}

/**
 * Every bus consumer's input up to its demux, in one place (B-145):
 *   buildBusSrc [! jitter queue] [! tee [! queue]] ! mrtsdemux name=… [select=…] [media=…]
 * The module appends its own branch (` ! …`: decode, render, mux) and any tap off the tee.
 */
export function buildBusDemux(opts: BusDemuxOpts): string {
    const bus = {
        port: opts.port,
        socketPath: opts.socketPath,
        stallTimeoutMs: opts.stallTimeoutMs,
    };
    const input =
        opts.jitterMs === undefined
            ? buildBusSrc({ ...bus, name: opts.srcName })
            : buildTsUdpInput({ ...bus, udpsrcName: opts.srcName, jitterMs: opts.jitterMs });
    const tee = opts.tee ? ` ! tee name=${opts.tee.name}${opts.tee.queue ? ' ! queue' : ''}` : '';
    const select = opts.select ? ` select=${opts.select}` : '';
    const media = opts.media ? ` media=${opts.media}` : '';
    return `${input}${tee} ! mrtsdemux name=${opts.name}${select}${media}`;
}

/**
 * Bus egress (fan-out point) for a producer:
 *   capssetter (replace) ! capsfilter (pinned TS caps) ! mrlateness ! tee busout_<port>
 * The runners splice `mrtsstamp` in before the capssetter. The lateness tap (`latOutName`) reads
 * running time, which the stamp is written in, and the runners forward its windows only while a
 * consumer has the stamper armed: before that the PTS are the mux's own (B-26).
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
 * rebuild. The tee's sink pad is the throughput-probe target (`busTeeName`).
 *
 * The `capssetter … replace=true` DROPS incoming caps fields, and exists for
 * exactly one of them: `mpegtsmux` publishes the PAT/PMT it generated FIRST
 * into a `streamheader` caps field. That snapshot is taken before the
 * dynamically-linked media pads exist (mux pads are requested at the demux's
 * pad-added), so it can name the wrong PCR PID and omit whole streams — and it
 * is never refreshed when the live PMT is corrected. unixfd carries caps
 * verbatim across the socket, so the stale header reaches consumers, and
 * `srtsink` replays it to every newly connected caller for the pipeline's
 * lifetime: a receiver's FIRST PMT was a snapshot of a pipeline that no longer
 * exists. Stripping costs a new caller nothing — real PSI repeats ~10×/s.
 * A capsfilter alone cannot do this: caps intersection is a field UNION, so it
 * preserves upstream fields it does not mention. It stays behind the capssetter
 * as the negotiation guard (a producer that somehow emits non-TS caps must
 * still fail loudly rather than publish them).
 */
export function buildBusSink(port: number): string {
    return (
        `capssetter caps="${BUS_TS_CAPS}" replace=true ! ` +
        `capsfilter caps="${BUS_TS_CAPS}"${busEgressLatenessTap(latOutName(port))} ! ` +
        `tee name=${busTeeName(port)} allow-not-linked=true`
    );
}
