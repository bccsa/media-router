import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PTS_WRAP,
    STEP,
    fillerPacket,
    pesPacket,
    rungs,
    toNs,
} from '../../mpegts-core/tests/tsFixtures';

/** The fan-out sidecar (built by `make native` on Linux / build-native-dev.sh). */
const SIDECAR = join(__dirname, '../native/mr-bus-fanout/mr-bus-fanout');
const CLIENT = join(__dirname, '../py/unixfd-fanout.test-client.py');
const CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';
/** Must match the sidecar's BUFFER_BYTES (128 TS packets). */
const BUFFER_BYTES = 128 * 188;

const havePython = spawnSync('python3', ['--version']).status === 0;
// The protocol needs Linux on the sidecar side (memfd_create, SCM_RIGHTS).
const haveSidecar = process.platform === 'linux' && existsSync(SIDECAR);

const PCR_MODULO = PTS_WRAP * 300n;
const MUX_BASE_90K = 3600n * 90000n;
const floorMod = (a: bigint, m: bigint) => ((a % m) + m) % m;

/** Synthetic TS: 0x47 sync + 187×0xAA per packet, so all-0x47 data can't
 *  fake the client's stride alignment check. */
function tsPackets(count: number): Buffer {
    const buf = Buffer.alloc(count * 188, 0xaa);
    for (let i = 0; i < count; i++) buf[i * 188] = 0x47;
    return buf;
}

/** Adaptation-only packet with a PCR, encoded as mrts::build_pcr_packet writes it. */
function pcrPacket(pid: number, pcr27: bigint): Buffer {
    const p = Buffer.alloc(188, 0xff);
    const base = (pcr27 / 300n) & (PTS_WRAP - 1n);
    const ext = Number(pcr27 % 300n);
    p.set([0x47, (pid >> 8) & 0x1f, pid & 0xff, 0x20, 183, 0x10], 0);
    p.set(
        [
            Number(base >> 25n) & 0xff,
            Number(base >> 17n) & 0xff,
            Number(base >> 9n) & 0xff,
            Number(base >> 1n) & 0xff,
            (Number(base & 1n) << 7) | 0x7e | (ext >> 8),
            ext & 0xff,
        ],
        6,
    );
    return p;
}

/**
 * The A/V ladder with a program clock: per rung a PES on 0x100, one on 0x101 (by default
 * 1 ms later) and a PCR on 0x100 100 ms behind, padded to one sidecar buffer, so buffer
 * k is rung k.
 */
function avPcrLadder(ladder: bigint[], second = ladder.map((pts) => pts + 90n)): Buffer {
    return Buffer.concat(
        ladder.flatMap((pts, k) => [
            pesPacket(0x100, pts),
            pesPacket(0x101, second[k]),
            pcrPacket(0x100, floorMod((pts - 9000n) * 300n, PCR_MODULO)),
            ...Array.from({ length: BUFFER_BYTES / 188 - 3 }, () => fillerPacket()),
        ]),
    );
}

/** One rung, one sidecar buffer: two 0x101 PES half a frame apart, before or after 0x100's. */
function twoAudioRung(vpts: bigint, apts: bigint, audioFirst: boolean): Buffer {
    const audio = [pesPacket(0x101, apts), pesPacket(0x101, apts + STEP / 2n)];
    const video = pesPacket(0x100, vpts);
    return Buffer.concat([
        ...(audioFirst ? [...audio, video] : [video, ...audio]),
        pcrPacket(0x100, floorMod((vpts - 9000n) * 300n, PCR_MODULO)),
        ...Array.from({ length: BUFFER_BYTES / 188 - 4 }, () => fillerPacket()),
    ]);
}

const packetsOf = (b: Buffer) =>
    Array.from({ length: b.length / 188 }, (_, i) => b.subarray(i * 188, (i + 1) * 188));

/** Every PES PTS on `pid`, in order. */
const ptsOn = (b: Buffer, pid: number) =>
    packetsOf(b)
        .filter((p) => (((p[1] & 0x1f) << 8) | p[2]) === pid && ptsOf(p) !== undefined)
        .map((p) => ptsOf(p)!);

/** Offset of the PTS field of the PES starting in `p`, or -1. */
function ptsOffset(p: Buffer): number {
    if (!(p[1] & 0x40) || !(p[3] & 0x10)) return -1;
    const off = p[3] & 0x20 ? 5 + p[4] : 4;
    if (off + 14 > 188 || p[off] !== 0 || p[off + 1] !== 0 || p[off + 2] !== 1) return -1;
    return p[off + 7] & 0x80 ? off + 9 : -1;
}

function ptsOf(p: Buffer): bigint | undefined {
    const o = ptsOffset(p);
    if (o < 0) return undefined;
    const f = p.subarray(o, o + 5);
    return (
        (BigInt((f[0] >> 1) & 7) << 30n) |
        (BigInt(f[1]) << 22n) |
        (BigInt(f[2] >> 1) << 15n) |
        (BigInt(f[3]) << 7n) |
        BigInt(f[4] >> 1)
    );
}

function pcrOf(p: Buffer): bigint | undefined {
    if (!(p[3] & 0x20) || p[4] < 7 || !(p[5] & 0x10)) return undefined;
    const base =
        (BigInt(p[6]) << 25n) |
        (BigInt(p[7]) << 17n) |
        (BigInt(p[8]) << 9n) |
        (BigInt(p[9]) << 1n) |
        BigInt(p[10] >> 7);
    return base * 300n + BigInt(((p[10] & 1) << 8) | p[11]);
}

const flaggedOf = (p: Buffer) => (p[3] & 0x20) !== 0 && p[4] >= 1 && (p[5] & 0x80) !== 0;

/** `p` with what the rebase may write zeroed: the PTS, the PCR, the discontinuity flag. */
function untimed(p: Buffer): Buffer {
    const q = Buffer.from(p);
    const o = ptsOffset(q);
    if (o >= 0) q.fill(0, o, o + 5);
    if (pcrOf(q) !== undefined) q.fill(0, 6, 12);
    if (q[3] & 0x20 && q[4] >= 1) q[5] &= 0x7f;
    return q;
}

/** mrts::house_from_mux_pts in BigInt: the house ns a bus PTS encodes, `PES - 1 h`
 *  unwrapped near `nearNs`, floor arithmetic as the C++. */
function houseFromMuxPts(pts33: bigint, nearNs: bigint): bigint {
    const raw = floorMod(pts33 - MUX_BASE_90K, PTS_WRAP);
    const ref = (nearNs * 9n) / 100000n;
    let d = floorMod(ref - raw, PTS_WRAP);
    if (d > PTS_WRAP / 2n) d -= PTS_WRAP;
    return ((ref - d) * 100000n) / 9n;
}

/** Collect JSON lines from a child's stdout into an inspectable array. */
function jsonLines(proc: ChildProcess): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            try {
                out.push(JSON.parse(line));
            } catch {
                /* non-JSON noise */
            }
        }
    });
    return out;
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A python stand-in for unixfdsrc on `edge`; resolves once the sidecar has sent it CAPS. */
async function client(cleanups: Array<() => void>, args: string[]) {
    const proc = spawn('python3', [CLIENT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => proc.kill('SIGKILL'));
    proc.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
    const events = jsonLines(proc);
    /** Registered at spawn — awaiting `once('exit')` later races a fast-exiting client. */
    const exit = new Promise<number | null>((res) => proc.once('exit', res));
    // CAPS is sent on accept: no broadcast can precede it (there is no replay on the bus).
    await waitFor(() => events.find((e) => e.caps), 'client accepted');
    return { proc, events, exit };
}

interface Rig {
    sidecar: ChildProcess;
    sidecarEvents: Array<Record<string, unknown>>;
    clientEvents: Array<Record<string, unknown>>;
    clientExit: Promise<number | null>;
    /** The capture client's events and file, when asked for. */
    capture?: { events: Array<Record<string, unknown>>; file: string };
    ingest: string;
    edge: string;
}

/** Sidecar up, edge attached, a client expecting `buffers` connected (and a capture client). */
async function rig(cleanups: Array<() => void>, buffers: number, captureBytes = 0): Promise<Rig> {
    const dir = mkdtempSync(join(tmpdir(), 'mr-fanout-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ingest = join(dir, 'ingest.sock');
    const edge = join(dir, 'edge.sock');

    const sidecar = spawn(SIDECAR, ['--ingest', ingest, '--caps', CAPS], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => sidecar.kill('SIGKILL'));
    sidecar.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
    const sidecarEvents = jsonLines(sidecar);
    await waitFor(() => sidecarEvents.find((e) => e.event === 'ready'), 'sidecar ready');

    // Engine-side attach (the UnixFdFanoutController's wire format).
    sidecar.stdin!.write(
        JSON.stringify({ cmd: 'bus_attach', tee: 'busout_41000', socket: edge }) + '\n',
    );
    await waitFor(
        () => sidecarEvents.find((e) => e.event === 'attached' && e.socket === edge),
        'edge attached',
    );

    // Consumers connect BEFORE data flows (no replay on the bus).
    const c = await client(cleanups, [edge, '--buffers', String(buffers)]);
    let capture: Rig['capture'];
    if (captureBytes) {
        const file = join(dir, 'capture.ts');
        const cap = await client(cleanups, [
            edge,
            '--capture',
            file,
            '--expect-bytes',
            String(captureBytes),
        ]);
        capture = { events: cap.events, file };
    }
    return {
        sidecar,
        sidecarEvents,
        clientEvents: c.events,
        clientExit: c.exit,
        capture,
        ingest,
        edge,
    };
}

function producer(ingest: string): Promise<Socket> {
    const sock = connect(ingest);
    return new Promise((resolve, reject) => {
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
    });
}

interface Delivered {
    /** Wire pts per buffer — absolute CLOCK_MONOTONIC ns (u64, hence bigint). */
    stamps: bigint[];
    /** Each buffer's first PES PTS (90 kHz) as it left, read back from the payload. */
    firstPes: bigint[];
    /** Every byte the edge carried. */
    bytes: Buffer;
    /** The first stats line after delivery (the rebase counters are running totals). */
    stats: Record<string, unknown>;
    /** House time just before each write. */
    marks: bigint[];
    after: bigint;
}

/** Write `parts` (a number is a pause in ms) and collect what one edge carried. */
async function deliver(
    cleanups: Array<() => void>,
    parts: Array<Buffer | number>,
    buffers: number,
): Promise<Delivered> {
    const total = parts.reduce<number>((n, p) => n + (typeof p === 'number' ? 0 : p.length), 0);
    const r = await rig(cleanups, buffers, total);
    const p = await producer(r.ingest);
    cleanups.push(() => p.destroy());
    const marks: bigint[] = [];
    for (const part of parts) {
        if (typeof part === 'number') {
            await sleep(part);
            continue;
        }
        marks.push(process.hrtime.bigint()); // node's hrtime IS CLOCK_MONOTONIC
        p.write(part);
    }
    await waitFor(
        () => (r.clientEvents.filter((e) => e.result).length === buffers ? true : undefined),
        `${buffers} buffers`,
        15000,
    );
    await waitFor(() => r.capture!.events.find((e) => e.captured), 'the capture', 15000);
    const after = process.hrtime.bigint();
    expect(r.clientEvents.find((e) => e.error)?.error).toBeUndefined();
    const from = r.sidecarEvents.length;
    const stats = await waitFor(
        () => r.sidecarEvents.slice(from).find((e) => e.stats)?.stats as Record<string, unknown>,
        'a stats line after delivery',
        8000,
    );
    const results = r.clientEvents
        .map((e) => e.result as { pts: string; firstPes: number } | undefined)
        .filter((v): v is { pts: string; firstPes: number } => v !== undefined);
    return {
        stamps: results.map((v) => BigInt(v.pts)),
        firstPes: results.map((v) => BigInt(v.firstPes)),
        bytes: readFileSync(r.capture!.file),
        stats,
        marks,
        after,
    };
}

/**
 * Full GstUnixFd protocol round-trips against the real sidecar, with a python
 * stand-in for unixfdsrc on the consumer end (receiving SCM_RIGHTS fds needs
 * python — Node can't).
 */
describe.skipIf(!havePython || !haveSidecar)('mr-bus-fanout protocol', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    it('serves CAPS-first, then a spec-shaped NEW_BUFFER with the ingested bytes on a memfd', async () => {
        const r = await rig(cleanups, 1);

        const p = await producer(r.ingest);
        cleanups.push(() => p.destroy());
        p.write(tsPackets(128)); // exactly one sidecar buffer

        const verdict = await waitFor(
            () => r.clientEvents.find((e) => e.result || e.error),
            'client verdict',
        );
        expect(verdict.error).toBeUndefined();
        expect(verdict.result).toMatchObject({
            ptsValid: true, // absolute CLOCK_MONOTONIC ns
            noneFields: true, // dts/duration/offset/offset_end = CLOCK_TIME_NONE
            flags: 0,
            memType: 0, // MEMORY_TYPE_DEFAULT
            nMemory: 1,
            nMeta: 0,
            memSize: BUFFER_BYTES,
            memOffset: 0,
            tsAligned: true,
        });
        expect(r.clientEvents.find((e) => e.caps)?.caps).toBe(CAPS);

        // RELEASE_BUFFER was drained — the sidecar is still alive and serving.
        const exit = await r.clientExit;
        expect(exit).toBe(0);
        expect(r.sidecar.exitCode).toBeNull();

        // Clean detach unlinks the edge socket.
        r.sidecar.stdin!.write(JSON.stringify({ cmd: 'bus_detach', socket: r.edge }) + '\n');
        await waitFor(
            () => r.sidecarEvents.find((e) => e.event === 'detached' && e.socket === r.edge),
            'edge detached',
        );
    }, 15000);

    it('stays TS-aligned across a producer respawn that died mid-packet', async () => {
        const r = await rig(cleanups, 2);

        // Producer incarnation 1: one whole buffer + a truncated packet, then
        // dies (hls child killed mid-write). The stale sub-packet tail must be
        // DISCARDED — splicing it before the next incarnation's aligned bytes
        // would desync every buffer boundary from then on.
        const p1 = await producer(r.ingest);
        p1.write(Buffer.concat([tsPackets(128), tsPackets(1).subarray(0, 100)]));
        await waitFor(
            () => r.clientEvents.find((e) => (e.result as { n?: number })?.n === 0),
            'first buffer',
        );
        p1.destroy();
        await new Promise((res) => setTimeout(res, 100)); // let close_ingest run

        // Producer incarnation 2: clean aligned stream.
        const p2 = await producer(r.ingest);
        cleanups.push(() => p2.destroy());
        p2.write(tsPackets(128));

        const second = await waitFor(
            () =>
                r.clientEvents
                    .map((e) => e.result as { n?: number; tsAligned?: boolean } | undefined)
                    .find((res) => res?.n === 1),
            'second buffer',
        );
        expect(second).toMatchObject({ memSize: BUFFER_BYTES, tsAligned: true });

        const exit = await r.clientExit;
        expect(exit).toBe(0);
    }, 15000);

    it('detaches each attached edge by its own path at its exit: the sockets go, the clients see EOF (B-92)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mr-fanout-test-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const sidecar = spawn(SIDECAR, ['--ingest', join(dir, 'ingest.sock'), '--caps', CAPS], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        cleanups.push(() => sidecar.kill('SIGKILL'));
        sidecar.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
        const events = jsonLines(sidecar);
        // 'close', not 'exit': stdout is read to its end first.
        const closed = new Promise<[number | null, string | null]>((res) =>
            sidecar.once('close', (code, signal) => res([code, signal])),
        );
        await waitFor(() => events.find((e) => e.event === 'ready'), 'sidecar ready');

        const edges = [join(dir, 'edge-a.sock'), join(dir, 'edge-b.sock')];
        const clients: Array<Awaited<ReturnType<typeof client>>> = [];
        for (const [i, edge] of edges.entries()) {
            sidecar.stdin!.write(
                JSON.stringify({ cmd: 'bus_attach', tee: `busout_4100${i}`, socket: edge }) + '\n',
            );
            await waitFor(
                () => events.find((e) => e.event === 'attached' && e.socket === edge),
                `edge ${i} attached`,
            );
            clients.push(await client(cleanups, [edge, '--capture', join(dir, `capture-${i}.ts`)]));
        }

        // A systemd stop: the SIGTERM comes while both edges are attached.
        sidecar.kill('SIGTERM');
        expect(await closed).toEqual([0, null]);
        const detached = events.filter((e) => e.event === 'detached').map((e) => e.socket);
        expect(detached.sort()).toEqual(edges);
        expect(readdirSync(dir).filter((f) => f.endsWith('.sock'))).toEqual([]);
        for (const c of clients) {
            const verdict = await waitFor(() => c.events.find((e) => e.captured), 'client verdict');
            expect(verdict.captured).toMatchObject({ buffers: 0, end: 'eof' });
        }
    }, 15000);

    it("'--stamp-timeline' is a usage error now (the rebase is unconditional)", () => {
        const dir = mkdtempSync(join(tmpdir(), 'mr-fanout-test-'));
        try {
            const res = spawnSync(
                SIDECAR,
                ['--ingest', join(dir, 'in.sock'), '--caps', CAPS, '--stamp-timeline'],
                { encoding: 'utf8', timeout: 5000 },
            );
            expect(res.status).toBe(2);
            expect(res.stderr).toContain('unknown arg: --stamp-timeline');
            expect(res.stderr).toContain('usage: mr-bus-fanout --ingest <socket> --caps <caps>');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names a flag that comes without its value', () => {
        const res = spawnSync(SIDECAR, ['--caps', CAPS, '--ingest'], {
            encoding: 'utf8',
            timeout: 5000,
        });
        expect(res.status).toBe(2);
        expect(res.stderr).toContain('missing value for --ingest');
        expect(res.stderr).toContain('usage: mr-bus-fanout --ingest <socket> --caps <caps>');
    });
});

/**
 * hls-player's TS on house time (plan ch. 6 WI-P2-5): the first timing PES at
 * house now, every PES and the PCR moved by one shift, each buffer stamped by
 * identity. house_rebase_test.cpp covers the rule; these pin it on the wire.
 */
describe.skipIf(!havePython || !haveSidecar)('mr-bus-fanout on house time', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    it('stamps by identity: the wire stamp is the rewritten PES - 1 h, the first at house now', async () => {
        const ladder = rungs(12, 8_100_000n);
        const run = await deliver(cleanups, [avPcrLadder(ladder)], ladder.length);
        expect(run.stamps).toHaveLength(ladder.length);
        expect(run.stamps).toEqual(run.firstPes.map((pes) => houseFromMuxPts(pes, run.marks[0])));
        // Anchored on arrival: house now when the first PES came in, to the 90 kHz floor.
        expect(run.stamps[0]).toBeGreaterThanOrEqual(run.marks[0] - 11_112n);
        expect(run.stamps[0]).toBeLessThanOrEqual(run.after);
        // Buffer k carries rung k, moved by one shift.
        const shift = floorMod(run.firstPes[0] - ladder[0], PTS_WRAP);
        expect(run.firstPes).toEqual(ladder.map((pts) => floorMod(pts + shift, PTS_WRAP)));
        for (let i = 1; i < run.stamps.length; i++) {
            expect(run.stamps[i] - run.stamps[i - 1]).toBe(toNs(STEP));
        }
    }, 20000);

    it('moves every PES PTS of every PID, and the PCR, by one shift', async () => {
        const ladder = rungs(12, 8_100_000n);
        const input = avPcrLadder(ladder);
        const run = await deliver(cleanups, [input], ladder.length);
        expect(run.bytes.length).toBe(input.length);
        const ins = packetsOf(input);
        const outs = packetsOf(run.bytes);
        const shift = floorMod(ptsOf(outs[0])! - ptsOf(ins[0])!, PTS_WRAP);
        const pts = ins.flatMap((p, i) => {
            const v = ptsOf(p);
            return v === undefined ? [] : [[ptsOf(outs[i]), floorMod(v + shift, PTS_WRAP)]];
        });
        const pcr = ins.flatMap((p, i) => {
            const v = pcrOf(p);
            return v === undefined
                ? []
                : [[pcrOf(outs[i]), floorMod(v + shift * 300n, PCR_MODULO)]];
        });
        expect(pts).toHaveLength(24); // both PIDs
        expect(pts.map(([got]) => got)).toEqual(pts.map(([, want]) => want));
        expect(pcr).toHaveLength(12);
        expect(pcr.map(([got]) => got)).toEqual(pcr.map(([, want]) => want));
        // Nothing else moved, nothing flagged.
        expect(outs.every((q, i) => untimed(q).equals(untimed(ins[i])))).toBe(true);
        expect(outs.some(flaggedOf)).toBe(false);
        expect(run.stats.rebase).toMatchObject({
            reanchors: 0,
            kept: 0,
            dropped: 0,
            desyncBytes: 0,
        });
    }, 20000);

    it('re-anchors a ladder that loops to zero: no step in the stamps, the next PCR flagged', async () => {
        // A looping VOD rewinds its PES timeline to ~0 every pass. House time goes on:
        // the content skips, one spacing after the last PES.
        const PRE = 6;
        const ladder = [...rungs(PRE, 8_100_000n), ...rungs(10, 4500n)];
        const run = await deliver(cleanups, [avPcrLadder(ladder)], ladder.length);
        for (let i = 1; i < run.stamps.length; i++) {
            expect(run.stamps[i] - run.stamps[i - 1]).toBe(toNs(STEP));
        }
        const flagged = packetsOf(run.bytes)
            .filter((p) => pcrOf(p) !== undefined)
            .map(flaggedOf);
        expect(flagged).toEqual(ladder.map((_, k) => k === PRE));
        expect(run.stats.rebase).toMatchObject({ reanchors: 1, kept: 0 });
    }, 20000);

    it("keeps a PID that does not jump with the reference in place (hls-pipe's inline audio)", async () => {
        // hls-pipe keeps its inline audio continuous across an EXT-X-DISCONTINUITY while
        // the video jumps: after the video re-anchors, 0x101 stays on its own timeline.
        const PRE = 6;
        const video = [...rungs(PRE, 8_100_000n), ...rungs(10, 4500n)];
        const run = await deliver(cleanups, [avPcrLadder(video, rungs(16, 8_100_090n))], 16);
        const outs = packetsOf(run.bytes);
        for (const pid of [0x100, 0x101]) {
            const pts = outs
                .filter((p) => (((p[1] & 0x1f) << 8) | p[2]) === pid && ptsOf(p) !== undefined)
                .map((p) => ptsOf(p)!);
            expect(pts).toHaveLength(16);
            for (let i = 1; i < pts.length; i++) {
                expect(floorMod(pts[i] - pts[i - 1], PTS_WRAP)).toBe(STEP);
            }
        }
        expect(run.stats.rebase).toMatchObject({ reanchors: 1, kept: 1 });
    }, 20000);

    it('moves a PID that jumped before the reference with it (two of its PES first)', async () => {
        // TS passthrough at an EXT-X-DISCONTINUITY: both PIDs jump, and the mux writes two
        // 0x101 PES of the new timeline before 0x100's first. Those two leave on the old
        // mapping (the known edge); from the next rung on 0x101 is at the source's offset.
        const J = 90000n * 600n;
        const input = Buffer.concat(
            Array.from({ length: 16 }, (_, k) => {
                const v = 8_100_000n + BigInt(k) * STEP + (k < 6 ? 0n : J);
                return twoAudioRung(v, v + 90n, k >= 6);
            }),
        );
        const run = await deliver(cleanups, [input], 16);
        const v = ptsOn(run.bytes, 0x100);
        const a = ptsOn(run.bytes, 0x101);
        expect(v).toHaveLength(16);
        expect(a).toHaveLength(32);
        for (let k = 1; k < 16; k++) expect(floorMod(v[k] - v[k - 1], PTS_WRAP)).toBe(STEP);
        for (let k = 7; k < 16; k++) expect(floorMod(a[2 * k] - v[k], PTS_WRAP)).toBe(90n);
        expect(floorMod(a[12] - a[11], PTS_WRAP)).toBe(floorMod(STEP / 2n + J, PTS_WRAP));
        expect(run.stats.rebase).toMatchObject({ reanchors: 1, kept: 0 });
    }, 20000);

    it('puts a kept PID back on the reference mapping after a producer respawn', async () => {
        // hls-pipe's inline audio kept apart after a discontinuity, then the runner respawns:
        // the new process has both PIDs on the origin's timeline again.
        const first = avPcrLadder(
            [...rungs(6, 8_100_000n), ...rungs(10, 4500n)],
            rungs(16, 8_100_090n),
        );
        const second = avPcrLadder(rungs(8, 90000n * 3000n));
        const r = await rig(cleanups, 24, first.length + second.length);
        const delivered = (n: number) =>
            r.clientEvents.filter((e) => e.result).length === n ? true : undefined;
        const p1 = await producer(r.ingest);
        p1.write(first);
        await waitFor(() => delivered(16), 'the first producer', 15000);
        p1.destroy();
        await sleep(100);
        const p2 = await producer(r.ingest);
        cleanups.push(() => p2.destroy());
        p2.write(second);
        await waitFor(() => delivered(24), 'the respawned producer', 15000);
        await waitFor(() => r.capture!.events.find((e) => e.captured), 'the capture', 15000);
        const from = r.sidecarEvents.length;
        const stats = await waitFor(
            () =>
                r.sidecarEvents.slice(from).find((e) => e.stats)?.stats as Record<string, unknown>,
            'a stats line after delivery',
            8000,
        );
        const bytes = readFileSync(r.capture!.file);
        const v = ptsOn(bytes, 0x100);
        const a = ptsOn(bytes, 0x101);
        expect(v).toHaveLength(24);
        expect(a).toHaveLength(24);
        for (let k = 16; k < 24; k++) expect(floorMod(a[k] - v[k], PTS_WRAP)).toBe(90n);
        expect(stats.rebase).toMatchObject({ reanchors: 2, kept: 1 });
    }, 30000);

    it('carries a legal 2^33 PTS wrap as one continuous timeline', async () => {
        const ladder = rungs(8, PTS_WRAP - 3n * STEP);
        const run = await deliver(cleanups, [avPcrLadder(ladder)], ladder.length);
        for (let i = 1; i < run.stamps.length; i++) {
            expect(run.stamps[i] - run.stamps[i - 1]).toBe(toNs(STEP));
        }
        expect(run.stats.rebase).toMatchObject({ reanchors: 0 });
    }, 20000);

    it('starts a jump that follows a pause at house now, never late', async () => {
        // The first part's labels end 160 ms after the anchor; the pause outlasts them.
        const pre = rungs(4, 8_100_000n);
        const post = rungs(4, 8_100_000n + 90000n * 600n);
        const run = await deliver(cleanups, [avPcrLadder(pre), 1000, avPcrLadder(post)], 8);
        expect(run.stamps[4]).toBeGreaterThanOrEqual(run.marks[1] - 11_112n);
        expect(run.stamps[4] - run.stamps[3]).toBeGreaterThan(toNs(STEP));
        for (let i = 5; i < run.stamps.length; i++) {
            expect(run.stamps[i] - run.stamps[i - 1]).toBe(toNs(STEP));
        }
        expect(run.stats.rebase).toMatchObject({ reanchors: 1 });
    }, 20000);
});

/** Lateness of what the sidecar writes (WI-P0-8): one `mrts::LatenessWindow` over the
 *  stamped buffers, in the 2 s stats line. */
describe.skipIf(!havePython || !haveSidecar)('mr-bus-fanout lateness window', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    /** Every stats line from the write up to the first one after delivery: the
     *  ladder's window is in exactly one of them. */
    const statsOf = async () => {
        const ladder = rungs(12, 8_100_000n);
        const r = await rig(cleanups, ladder.length);
        const p = await producer(r.ingest);
        cleanups.push(() => p.destroy());
        const from = r.sidecarEvents.length;
        p.write(avPcrLadder(ladder));
        await waitFor(
            () =>
                r.clientEvents.filter((e) => e.result).length === ladder.length ? true : undefined,
            'the ladder delivered',
            15000,
        );
        const after = r.sidecarEvents.length;
        await waitFor(
            () => r.sidecarEvents.slice(after).find((e) => e.stats),
            'a stats line after data',
            15000,
        );
        return r.sidecarEvents
            .slice(from)
            .filter((e) => e.stats)
            .map((e) => e.stats as Record<string, unknown>);
    };

    it('reports count/untimed/min/mean/max in ms for the stamped buffers', async () => {
        const windows = (await statsOf()).filter((st) => st.lateness);
        expect(windows).toHaveLength(1);
        const lat = windows[0].lateness as Record<string, number>;
        expect(Object.keys(lat).sort()).toEqual(['count', 'max', 'mean', 'min', 'untimed']);
        expect(lat.count).toBe(12);
        expect(lat.untimed).toBe(0);
        // Written in one go, a 40 ms/rung ladder is early by up to 11 rungs.
        expect(lat.min).toBeLessThan(-400);
        expect(lat.min).toBeLessThanOrEqual(lat.mean);
        expect(lat.mean).toBeLessThanOrEqual(lat.max);
        expect(lat.max).toBeLessThan(50);
    }, 30000);

    it('leaves the key out while nothing was written, and the rebase unanchored', async () => {
        const r = await rig(cleanups, 1);
        const stats = await waitFor(
            () => r.sidecarEvents.find((e) => e.stats)?.stats as Record<string, unknown>,
            'a stats line',
            15000,
        );
        expect(stats.lateness).toBeUndefined();
        expect(stats.rebase).toEqual({
            shiftMs: null,
            reanchors: 0,
            kept: 0,
            dropped: 0,
            desyncBytes: 0,
        });
    }, 30000);
});
