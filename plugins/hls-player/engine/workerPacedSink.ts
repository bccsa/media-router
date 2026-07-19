/*
 * Worker-thread wrapper for the paced TS sinks.
 *
 * The paced drain loop used to share the runner's main thread with the
 * extractor's per-segment work (fetch/decrypt/demux/mux), which runs as one
 * macrotask — sink.write() resolves through microtasks when the read-ahead
 * buffer isn't full, so timers never fired mid-segment and the wire stalled
 * ~100 ms at every segment boundary (measured at the SRT receiver; small
 * receiver buffers drop frames on it). Moving the sink — queue, drain timer
 * and transport socket — onto a worker thread makes wire cadence immune to
 * ANY main-thread block (segment work, GC, future features).
 *
 * DATA PLANE: a SharedArrayBuffer ring buffer, NOT per-chunk postMessage
 * transfers. The first deployment transferred every chunk's ArrayBuffer
 * (~50/s); transferred backing stores are EXTERNAL memory to the worker's
 * isolate — its tiny JS heap never accumulates allocation pressure, so its
 * GC effectively never runs and the externals pile up unreclaimed (~the
 * media rate; two Pi collapses in ~12-14 min correlate). With the ring, the
 * main thread copies bytes into the SAB and the worker copies them out into
 * Buffers IT allocates — Node's Buffer accounting charges the worker isolate
 * (adjustAmountOfExternalAllocatedMemory), so its GC feels every byte.
 * Copy cost is trivial at wire rates (~0.9 MB/s, two memcpys).
 *
 * Flow control is end-to-end and fail-closed:
 *   - ring full → main-side `write` waits (worker stopped copying because
 *     the inner sink's own 60 s read-ahead back-pressured its chain);
 *   - main-side ledger additionally caps outstanding media at the same
 *     ~60 s budget the inner sink uses, verified against the worker's
 *     shared bytes-sent counter;
 *   - a dead worker makes `write` THROW (runner exits non-zero → bounded
 *     ManagedProcess restart), and a wedged worker (no counter progress for
 *     60 s while full) aborts the same way — never a silent no-op sink.
 *
 * Ring layout (single-producer/single-consumer): BigInt64Array header
 * [writeTotal, readTotal] of MONOTONIC byte counters (offset = total % cap),
 * then the data region. Frames are 8-byte aligned: u32 len, u32 flags
 * (bit0 = end-of-stream), f64 mediaSeconds, then payload. A frame never
 * wraps: when the tail can't hold it contiguously, a len=0xFFFFFFFF marker
 * sends the reader back to offset 0.
 *
 * The worker source is embedded as a string and spawned with `eval: true`:
 * the plugin ships TS-compiled to dist and its tests run from TS sources, so
 * there is no stable on-disk .js path to point a Worker at in both worlds.
 * Engine sink modules are resolved to absolute paths HERE (main thread) and
 * passed in via workerData.
 */
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/** Mirrors the inner PacedTsSink read-ahead budget (not exported there). */
const MAX_BUFFER_SEC = 60;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/** Conveyor ring: ~10 s at 6.7 Mbps. Fills only when the worker's inner
 *  sink is already back-pressuring; then the main side waits. */
const DEFAULT_RING_BYTES = 8 * 1024 * 1024;

const FRAME_HEADER_BYTES = 16;
const WRAP_MARKER = 0xffffffff;
const END_FLAG = 1;

const align8 = (n: number): number => (n + 7) & ~7;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type PacedSinkDescriptor =
    | { kind: 'udp'; port: number; host: string }
    | { kind: 'unixfd'; ingestPath: string };

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const counters = new BigInt64Array(workerData.counters);
const head = new BigInt64Array(workerData.ring, 0, 2);
const cap = workerData.ringDataBytes;
const data = new Uint8Array(workerData.ring, 16, cap);
const view = new DataView(workerData.ring, 16, cap);
const desc = workerData.sink;
const sink = desc.kind === 'unixfd'
    ? new (require(workerData.unixSinkPath).PacedUnixStreamTsSink)(desc.ingestPath)
    : new (require(workerData.udpSinkPath).PacedUdpTsSink)(desc.port, desc.host);
const publish = () => { Atomics.store(counters, 0, BigInt(sink.bytesSent)); };
const tick = setInterval(publish, 50);
let chain = Promise.resolve();
let pending = 0;
let ending = false;
let pendingWaiter = null;
const fail = (e) => {
    parentPort.postMessage({ t: 'error', message: String((e && e.message) || e) });
};
// Copy frames out of the ring while the inner sink keeps up; the pending
// bound keeps Buffers from piling in the chain when it back-pressures.
// Returns true when the END frame was consumed.
const drainAvailable = () => {
    while (pending < 64) {
        const w = Atomics.load(head, 0);
        const r = Atomics.load(head, 1);
        if (r >= w) return false;
        const off = Number(r % BigInt(cap));
        if (cap - off < ${FRAME_HEADER_BYTES} || view.getUint32(off, true) === ${WRAP_MARKER}) {
            Atomics.store(head, 1, r + BigInt(cap - off));
            continue;
        }
        const len = view.getUint32(off, true);
        const flags = view.getUint32(off + 4, true);
        const sec = view.getFloat64(off + 8, true);
        if (flags & ${END_FLAG}) {
            ending = true;
            Atomics.store(head, 1, r + BigInt(${FRAME_HEADER_BYTES}));
            chain = chain
                .then(() => sink.end())
                .catch(() => {})
                .then(() => { publish(); clearInterval(tick); parentPort.postMessage({ t: 'ended' }); });
            return true;
        }
        const buf = Buffer.allocUnsafe(len);
        buf.set(data.subarray(off + ${FRAME_HEADER_BYTES}, off + ${FRAME_HEADER_BYTES} + len));
        Atomics.store(head, 1, r + BigInt((${FRAME_HEADER_BYTES} + len + 7) & ~7));
        pending++;
        chain = chain.then(() => sink.write(buf, sec)).catch(fail).then(() => {
            pending--;
            if (pendingWaiter) { const w2 = pendingWaiter; pendingWaiter = null; w2(); }
        });
    }
    return false;
};
// Event-driven drain: sleep on the producer's write counter instead of a
// polling interval (a 5 ms tick burned measurable CPU on the Pi doing
// nothing 200x/s). Wakes: producer Atomics.notify per frame, or a chain
// slot freeing up while the pending bound had us paused.
(async () => {
    for (;;) {
        if (drainAvailable()) return; // END consumed
        if (pending >= 64) {
            await new Promise((res) => { pendingWaiter = res; });
            continue;
        }
        const w = Atomics.load(head, 0);
        if (Atomics.load(head, 1) < w) continue; // raced: more data already
        const res = Atomics.waitAsync(head, 0, w);
        if (res.async) await res.value;
    }
})().catch(fail);
`;

/**
 * SegmentSink façade whose pacing engine runs on a worker thread. Drop-in
 * for PacedUdpTsSink / PacedUnixStreamTsSink in the hls-pipe runner.
 */
export class WorkerPacedTsSink {
    private readonly worker: Worker;
    private readonly counters: BigInt64Array;
    private readonly head: BigInt64Array;
    private readonly cap: number;
    private readonly data: Uint8Array;
    private readonly view: DataView;
    /** FIFO of enqueued writes, drained against the shared sent counter. */
    private ledger: Array<{ bytes: number; sec: number }> = [];
    private ledgerBytes = 0;
    private enqueuedSec = 0;
    private drainedBytesAcc = 0;
    private drainedSec = 0;
    private dead = false;
    private ended: Promise<void> | null = null;
    private endedResolve: (() => void) | null = null;

    constructor(desc: PacedSinkDescriptor, ringBytes: number = DEFAULT_RING_BYTES) {
        this.cap = align8(ringBytes);
        const ring = new SharedArrayBuffer(16 + this.cap);
        this.head = new BigInt64Array(ring, 0, 2);
        this.data = new Uint8Array(ring, 16, this.cap);
        this.view = new DataView(ring, 16, this.cap);
        const sab = new SharedArrayBuffer(8);
        this.counters = new BigInt64Array(sab);
        const req = createRequire(__filename);
        this.worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: {
                counters: sab,
                ring,
                ringDataBytes: this.cap,
                sink: desc,
                udpSinkPath: req.resolve('@media-router/engine/dist/plugins/PacedUdpTsSink.js'),
                unixSinkPath: req.resolve(
                    '@media-router/engine/dist/plugins/PacedUnixStreamTsSink.js',
                ),
            },
        });
        this.worker.unref();
        this.worker.on('message', (m: { t: string; message?: string }) => {
            if (m.t === 'ended') this.endedResolve?.();
            else if (m.t === 'error') {
                process.stderr.write(`paced-sink worker: ${m.message}\n`);
            }
        });
        this.worker.on('error', (err: Error) => {
            process.stderr.write(`paced-sink worker died: ${err.message}\n`);
            this.dead = true;
            this.endedResolve?.();
        });
        this.worker.on('exit', () => {
            this.dead = true;
            this.endedResolve?.();
        });
    }

    /** Total bytes pushed to the transport (from the worker's shared counter). */
    get bytesSent(): number {
        return Number(Atomics.load(this.counters, 0));
    }

    /** Free contiguous-capacity check + frame write. Returns false when the
     *  ring can't take the frame yet. */
    private tryPutFrame(chunk: Uint8Array | null, sec: number, flags: number): boolean {
        const len = chunk?.byteLength ?? 0;
        const need = align8(FRAME_HEADER_BYTES + len);
        const w = Atomics.load(this.head, 0);
        const r = Atomics.load(this.head, 1);
        const free = this.cap - Number(w - r);
        let off = Number(w % BigInt(this.cap));
        const tail = this.cap - off;
        // The frame must be contiguous: a tail too small for it costs a wrap
        // marker (consuming the tail) plus the frame at offset 0.
        const needTotal = tail < need ? tail + need : need;
        if (free < needTotal) return false;
        let wNext = w;
        if (tail < need) {
            if (tail >= 4) this.view.setUint32(off, WRAP_MARKER, true);
            wNext += BigInt(tail);
            off = 0;
        }
        this.view.setUint32(off, len, true);
        this.view.setUint32(off + 4, flags, true);
        this.view.setFloat64(off + 8, sec, true);
        if (chunk && len > 0) this.data.set(chunk, off + FRAME_HEADER_BYTES);
        Atomics.store(this.head, 0, wNext + BigInt(need));
        Atomics.notify(this.head, 0); // wake the worker's waitAsync drain
        return true;
    }

    async write(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
        // FAIL CLOSED: a dead worker must abort the run (runner exits
        // non-zero → ManagedProcess restart with backoff), never silently
        // swallow writes — a no-op sink lets the extractor race through the
        // whole playlist at line speed with no pacing brake.
        if (this.dead) throw new Error('paced-sink worker is dead');
        if (this.ended) return;

        // Ring back-pressure: full means the worker's inner sink is already
        // holding its 60 s read-ahead. Same no-progress watchdog as below.
        let lastProgressAt = Date.now();
        let lastSent = this.bytesSent;
        while (!this.tryPutFrame(chunk, mediaSeconds, 0)) {
            if (this.dead) throw new Error('paced-sink worker died while ring full');
            if (this.ended) return;
            const sent = this.bytesSent;
            if (sent !== lastSent) {
                lastSent = sent;
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > 60_000) {
                throw new Error('paced-sink worker made no progress for 60 s (ring full)');
            }
            await sleep(50);
        }
        this.ledger.push({ bytes: chunk.byteLength, sec: mediaSeconds });
        this.ledgerBytes += chunk.byteLength;
        this.enqueuedSec += mediaSeconds;

        // Media back-pressure: let the extractor race ahead only up to the
        // budget, verified against the worker's ACTUALLY-SENT counter.
        lastProgressAt = Date.now();
        lastSent = this.bytesSent;
        for (;;) {
            if (this.dead) throw new Error('paced-sink worker died under back-pressure');
            if (this.ended) return;
            this.syncDrained();
            const outstandingSec = this.enqueuedSec - this.drainedSec;
            if (outstandingSec <= MAX_BUFFER_SEC && this.ledgerBytes <= MAX_BUFFER_BYTES) return;
            const sent = this.bytesSent;
            if (sent !== lastSent) {
                lastSent = sent;
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > 60_000) {
                throw new Error('paced-sink worker made no progress for 60 s while full');
            }
            await sleep(50);
        }
    }

    /** Advance the drained ledger against the worker's sent counter. */
    private syncDrained(): void {
        const sent = this.bytesSent;
        while (this.ledger.length > 0 && this.drainedBytesAcc + this.ledger[0]!.bytes <= sent) {
            const e = this.ledger.shift()!;
            this.ledgerBytes -= e.bytes;
            this.drainedBytesAcc += e.bytes;
            this.drainedSec += e.sec;
        }
    }

    /** Flush the buffered tail at media rate, then tear the worker down. */
    async end(): Promise<void> {
        if (this.ended) return this.ended;
        this.ended = (async () => {
            if (!this.dead) {
                // Re-ref for the drain: an unref'd worker doesn't keep the
                // process alive, and the buffered tail may take a while.
                this.worker.ref();
                const done = new Promise<void>((r) => {
                    this.endedResolve = r;
                });
                while (!this.dead && !this.tryPutFrame(null, 0, END_FLAG)) await sleep(20);
                await done;
            }
            await this.worker.terminate();
        })();
        return this.ended;
    }
}
