import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkerPacedTsSink } from './workerPacedSink.js';

/** One paced datagram on the unix-stream transport: 128 TS packets. */
const CHUNK = 128 * 188;

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface Rig {
    server: Server;
    socketPath: string;
    dir: string;
    /** (monotonic ms, byteLength) per received data event. */
    arrivals: Array<{ at: number; bytes: number }>;
    received: Buffer[];
}

function rig(): Promise<Rig> {
    const dir = mkdtempSync(join(tmpdir(), 'wps-'));
    const socketPath = join(dir, 'ingest.sock');
    const arrivals: Rig['arrivals'] = [];
    const received: Buffer[] = [];
    const server = createServer((sock: Socket) => {
        sock.on('data', (d) => {
            arrivals.push({ at: performance.now(), bytes: d.length });
            received.push(d);
        });
    });
    return new Promise((resolve) => {
        server.listen(socketPath, () => resolve({ server, socketPath, dir, arrivals, received }));
    });
}

describe('WorkerPacedTsSink', () => {
    let r: Rig;
    let sink: WorkerPacedTsSink | null = null;

    beforeEach(async () => {
        r = await rig();
    });
    afterEach(async () => {
        await sink?.end();
        sink = null;
        r.server.close();
        rmSync(r.dir, { recursive: true, force: true });
    });

    it('delivers bytes intact through the worker and reports bytesSent', async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        // 3 chunks of exactly one datagram each, tiny media spans so the
        // paced drain releases them immediately (2 s prefill head-start).
        const chunks = [0, 1, 2].map((i) => {
            const c = new Uint8Array(CHUNK);
            c.fill(i + 1);
            return c;
        });
        const expected = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        for (const c of chunks) await sink.write(c, 0.05);
        await expect
            .poll(() => r.received.reduce((n, b) => n + b.length, 0), { timeout: 5000 })
            .toBe(3 * CHUNK);
        expect(Buffer.concat(r.received).equals(expected)).toBe(true);
        // The worker publishes bytesSent into the shared counter every 50 ms —
        // poll rather than assert instantly.
        await expect
            .poll(() => sink!.bytesSent, { timeout: 5000 })
            .toBeGreaterThanOrEqual(3 * CHUNK);
    });

    it('copies subarray views instead of detaching a shared backing buffer', async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        const pool = new Uint8Array(CHUNK * 2);
        pool.fill(7, CHUNK); // second half is "our" chunk
        const view = pool.subarray(CHUNK);
        await sink.write(view, 0.05);
        await expect
            .poll(() => r.received.reduce((n, b) => n + b.length, 0), { timeout: 5000 })
            .toBe(CHUNK);
        expect(r.received[0]![0]).toBe(7);
        // The pool must NOT have been detached by the transfer.
        expect(pool.byteLength).toBe(CHUNK * 2);
    });

    it('keeps sending while the main thread is synchronously blocked', async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        // Enqueue ~6 s of media: 24 chunks × 0.25 s each. The 2 s prefill
        // head-start drains instantly; the rest releases at ~4 datagrams/s.
        for (let i = 0; i < 24; i++) await sink.write(new Uint8Array(CHUNK), 0.25);
        // Let the worker connect + drain the prefill.
        await expect
            .poll(() => r.arrivals.length, { timeout: 5000 })
            .toBeGreaterThan(0);

        // Block THIS thread hard for 1 s and sample the worker's shared
        // bytesSent counter from inside the spin. Server-side timestamps
        // can't prove anything here (the server shares this blocked thread);
        // the cross-thread counter can: it only advances if the WORKER keeps
        // draining while we spin. The old in-thread sink froze exactly here.
        const before = sink.bytesSent;
        let advancedAfterMs = -1;
        const blockStart = performance.now();
        while (performance.now() - blockStart < 1000) {
            if (advancedAfterMs < 0 && sink.bytesSent > before) {
                advancedAfterMs = performance.now() - blockStart;
            }
        }
        expect(
            advancedAfterMs,
            'worker must keep draining during a main-thread block',
        ).toBeGreaterThanOrEqual(0);
        expect(advancedAfterMs).toBeLessThan(1000);
    });

    it('delivers byte-exact data across many ring wraparounds (tiny ring)', async () => {
        // 64 KB ring, 24 KB-ish frames → a wrap every ~2-3 writes. Patterned
        // payloads catch any offset/copy error at the wrap seam.
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath }, 64 * 1024);
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < 24; i++) {
            const c = new Uint8Array(CHUNK);
            for (let j = 0; j < c.length; j++) c[j] = (i * 31 + (j % 251)) & 0xff;
            chunks.push(c);
            await sink.write(c, 0.05);
        }
        const total = 24 * CHUNK;
        await expect
            .poll(() => r.received.reduce((n, b) => n + b.length, 0), { timeout: 15000 })
            .toBe(total);
        const got = Buffer.concat(r.received);
        const want = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        expect(got.equals(want)).toBe(true);
    });

    it('fails CLOSED when the worker dies: write() throws instead of no-oping', async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        await sink.write(new Uint8Array(CHUNK), 0.05);
        // Kill the worker out from under the façade (simulates a crash).
        await (sink as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
        await expect
            .poll(() => (sink as unknown as { dead: boolean }).dead, { timeout: 5000 })
            .toBe(true);
        // A dead pacing engine must abort the run loudly — a silent no-op
        // write would let the extractor race unpaced through the playlist.
        await expect(() => sink!.write(new Uint8Array(CHUNK), 0.05)).rejects.toThrow(/dead/);
        sink = null; // end() would hang on the terminated worker's ack
    });

    // -- abandon(): the SIGTERM path ---------------------------------------
    // The runner has 3 s of ManagedProcess grace before SIGKILL, and the
    // extractor is normally parked inside write() waiting for the 60 s
    // read-ahead budget to clear. Both must give way instantly.

    // A segment-sized chunk: 40 datagrams spread over 30 s of media. Single-
    // datagram writes can't model back-pressure — the drain queue runs dry
    // between them and re-anchors, so every datagram ships immediately.
    const SEGMENT = CHUNK * 40;
    const SEGMENT_SEC = 30;

    /** Feed segment-sized writes until one wedges on the 60 s budget. The
     *  wedged promise comes back BOXED — returning it bare would be adopted by
     *  the caller's `await` and this helper would block on it forever. */
    async function writeUntilParked(s: WorkerPacedTsSink): Promise<{ parked: Promise<void> }> {
        for (let i = 0; i < 10; i++) {
            const p = s.write(new Uint8Array(SEGMENT), SEGMENT_SEC);
            let settled = false;
            void p.then(
                () => (settled = true),
                () => (settled = true),
            );
            await sleep(250);
            if (!settled) return { parked: p };
            await p;
        }
        throw new Error('sink never applied back-pressure');
    }

    it('abandon() unparks a write wedged on back-pressure', { timeout: 20_000 }, async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        const { parked } = await writeUntilParked(sink);

        const t0 = performance.now();
        sink.abandon();
        // Resolves, does not reject: a deliberate stop must not look like a
        // fault to the runner (which would exit non-zero and be restarted).
        await parked;
        expect(performance.now() - t0, 'parked write must unpark on abandon()').toBeLessThan(500);
        // And it stays a quiet no-op for anything still in flight above us.
        await expect(sink.write(new Uint8Array(SEGMENT), SEGMENT_SEC)).resolves.toBeUndefined();
    });

    it('abandon() makes end() skip the media-rate tail drain', async () => {
        sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: r.socketPath });
        // ~60 s of buffered media: end() would pace this out over a minute.
        for (let i = 0; i < 2; i++) await sink.write(new Uint8Array(SEGMENT), SEGMENT_SEC);

        sink.abandon();
        const t0 = performance.now();
        await sink.end();
        expect(performance.now() - t0, 'end() must not drain after abandon()').toBeLessThan(200);
        sink = null; // already torn down
    });
});
