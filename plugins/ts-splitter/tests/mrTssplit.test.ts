import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PTS_WRAP } from '../../mpegts-core/tests/tsFixtures';

/**
 * End-to-end integration of the native mr-tssplit child over real GstUnixFd
 * sockets (Linux only): a python unixfdsink stand-in feeds the phase-1
 * fixture upstream (verifying RELEASE_BUFFER for every buffer), capture
 * clients drain each output edge, and the captured SPTS streams must be
 * byte-identical (sha256) to the python SplitterCore reference over the same
 * chunking. Also covers: wired-only gating (late attach starts with PSI),
 * make-before-break reinput continuity, input stall events, and the
 * pass-through on a field capture (plan ch. 6 WI-P2-4): PES and PCR copied,
 * each output stamped by identity, gap markers forwarded.
 */

const PLUGINS_DIR = join(__dirname, '../..');
const MR_TSSPLIT = join(__dirname, '../native/mr-tssplit/mr-tssplit');
const SERVER = join(PLUGINS_DIR, 'unixfdbus-core/py/unixfd-test-server.py');
const CLIENT = join(PLUGINS_DIR, 'unixfdbus-core/py/unixfd-fanout.test-client.py');
const FIXTURE_GEN = join(PLUGINS_DIR, 'mpegts-core/py/native_parity_fixture.py');
const REF_RUNNER = join(PLUGINS_DIR, 'mpegts-core/py/native_parity_ref.py');
const MRTS_CLI = join(PLUGINS_DIR, 'mpegts-core/native/mrts/mrts_cli');
const CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';
const CHUNK = 1316;

const PIDS = [0x65, 0xc9, 0xca, 0x1f0];
const outArgs = (pids: number[]) =>
    pids.flatMap((pid) => ['--out', `0x${pid.toString(16)}:busout_${pid}`]);

/** The OCC feed's first 2 MB (2026-07-17): H.264 1080i with B-frames, 21 AAC PIDs, teletext;
 *  its PMT comes before its first PAT. Its dump, reviewed against ffprobe: .expect.jsonl. */
const OCC = join(PLUGINS_DIR, 'mpegts-core/tests/fixtures/cap-occ-1080i-h264-21aac-ttx.ts');
/** Video (the program's PCR PID), one AAC PID, teletext (private, no PCR of its own). */
const OCC_OUTS = [0x65, 0xc9, 0x20];
const OCC_PCR_PID = 0x65;
const GST_GAP = 0x800;      // GST_BUFFER_FLAG_GAP
const GST_DISCONT = 0x40;   // GST_BUFFER_FLAG_DISCONT

const havePython = spawnSync('python3', ['--version']).status === 0;
const haveBinary = process.platform === 'linux' && existsSync(MR_TSSPLIT);
const haveCli = existsSync(MRTS_CLI);

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
                /* noise */
            }
        }
    });
    return out;
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 10000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

function sha256(path: string): string {
    return sha256Of(readFileSync(path));
}

function sha256Of(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

/**
 * Cumulative fan-out shed count across every edge, from the child's `stats`
 * events. The fan-out drops any message left unsent past its 500 ms leaky
 * budget, so a capture client starved of CPU (a loaded CI box running many
 * suites in parallel) loses bytes by DESIGN — which would surface downstream
 * as an inscrutable sha256 mismatch. Asserting this first turns that into a
 * self-explaining failure. Zero when no stats line has arrived yet (short
 * tests): absence of evidence, so it never fails spuriously.
 */
function shedCount(events: Array<Record<string, unknown>>): number {
    const last = events.filter((e) => e.stats).at(-1)?.stats as
        | { drops?: Record<string, number> }
        | undefined;
    return Object.values(last?.drops ?? {}).reduce((a, b) => a + b, 0);
}

// --- TS reading for the pass-through cases, the layouts mrts parses ---

const PKT = 188;
const PCR_MODULO = PTS_WRAP * 300n;
const MUX_BASE = 3600n * 90000n;   // mpegtsmux's 1 h in 90 kHz ticks

const tsPid = (p: Buffer) => ((p[1] & 0x1f) << 8) | p[2];
const isAvSid = (sid: number) => (sid & 0xf0) === 0xe0 || (sid & 0xe0) === 0xc0;

function packetsOf(buf: Buffer, pid?: number): Buffer[] {
    const out: Buffer[] = [];
    for (let o = 0; o + PKT <= buf.length; o += PKT) {
        const p = buf.subarray(o, o + PKT);
        if (pid === undefined || tsPid(p) === pid) out.push(p);
    }
    return out;
}

/** The 27 MHz PCR in `p`'s adaptation field (mrts::read_pcr). */
function pcrOf(p: Buffer): bigint | undefined {
    if (!(p[3] & 0x20) || p[4] < 7 || !(p[5] & 0x10)) return undefined;
    const base = (BigInt(p[6]) << 25n) | (BigInt(p[7]) << 17n) | (BigInt(p[8]) << 9n) |
        (BigInt(p[9]) << 1n) | BigInt(p[10] >> 7);
    return base * 300n + BigInt(((p[10] & 1) << 8) | p[11]);
}

/** Adaptation only with a PCR: what the splitter injects on a non-PCR output. */
const isPcrOnly = (p: Buffer) => (p[3] & 0x30) === 0x20 && pcrOf(p) !== undefined;

/** The PES header starting in `p`: stream id, where its PTS sits, PTS/DTS count. */
function pesHeader(p: Buffer): { sid: number; at: number; fields: number } | undefined {
    if (!(p[1] & 0x40) || !(p[3] & 0x10)) return undefined;
    const o = p[3] & 0x20 ? 5 + p[4] : 4;
    if (o + 9 > PKT || p[o] !== 0 || p[o + 1] !== 0 || p[o + 2] !== 1) return undefined;
    const sid = p[o + 3];
    if ([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff].includes(sid)) return undefined;
    if ((p[o + 6] & 0xc0) !== 0x80) return undefined;
    const flags = p[o + 7] >> 6;
    return { sid, at: o + 9, fields: flags === 3 ? 2 : flags === 2 ? 1 : 0 };
}

const readTs = (p: Buffer, o: number) =>
    (BigInt((p[o] >> 1) & 7) << 30n) | (BigInt(p[o + 1]) << 22n) |
    (BigInt(p[o + 2] >> 1) << 15n) | (BigInt(p[o + 3]) << 7n) | BigInt(p[o + 4] >> 1);

function writeTs(p: Buffer, o: number, v: bigint): void {
    p[o] = (p[o] & 0xf0) | Number((v >> 29n) & 0x0en) | 1;
    p[o + 1] = Number((v >> 22n) & 0xffn);
    p[o + 2] = Number((v >> 14n) & 0xfen) | 1;
    p[o + 3] = Number((v >> 7n) & 0xffn);
    p[o + 4] = Number((v << 1n) & 0xfen) | 1;
}

function pesPts(p: Buffer): bigint | undefined {
    const h = pesHeader(p);
    return h && h.fields > 0 && h.at + 5 <= PKT ? readTs(p, h.at) : undefined;
}

const floorDiv = (a: bigint, b: bigint) => (a % b !== 0n && a < 0n ? a / b - 1n : a / b);
const floorMod = (a: bigint, m: bigint) => ((a % m) + m) % m;

/** mrts::house_from_mux_pts: `PES − 1 h` in ns, unwrapped nearest `nowNs`. */
function houseFromMuxPts(pts33: bigint, nowNs: bigint): bigint {
    const raw = floorMod(pts33 - MUX_BASE, PTS_WRAP);
    const ref = floorDiv(nowNs * 9n, 100000n);
    let d = floorMod(ref - raw, PTS_WRAP);
    if (d > PTS_WRAP / 2n) d -= PTS_WRAP;
    return floorDiv((ref - d) * 100000n, 9n);
}

/**
 * `src` with every PTS, DTS and PCR moved by one constant, its first PCR `leadNs`
 * after now on the bus convention (house + 1 h): the stream as Phase 1's ingest
 * restamp hands it on.
 */
function rebaseToHouse(src: Buffer, leadNs: bigint): Buffer {
    const out = Buffer.from(src);
    const pkts = packetsOf(out);
    const pcr0 = pkts.map(pcrOf).find((v) => v !== undefined)!;
    const target = floorDiv((process.hrtime.bigint() + leadNs) * 9n, 100000n) + MUX_BASE;
    const shift = floorMod(target - pcr0 / 300n, PTS_WRAP);
    for (const p of pkts) {
        const pcr = pcrOf(p);
        if (pcr !== undefined) {
            const b = floorMod(pcr / 300n + shift, PTS_WRAP);
            p[6] = Number(b >> 25n);
            p[7] = Number((b >> 17n) & 0xffn);
            p[8] = Number((b >> 9n) & 0xffn);
            p[9] = Number((b >> 1n) & 0xffn);
            p[10] = (p[10] & 0x7f) | (Number(b & 1n) << 7);
        }
        const h = pesHeader(p);
        if (!h) continue;
        if (h.at + 5 * h.fields > PKT) throw new Error('fixture: a PES header spans two packets');
        for (let i = 0; i < h.fields; i++) {
            const at = h.at + 5 * i;
            writeTs(p, at, floorMod(readTs(p, at) + shift, PTS_WRAP));
        }
    }
    return out;
}

/** mrts::build_gap_packet: adaptation only, the gap's length (ns, big-endian) as
 *  its transport_private_data (plan ch. 5 OQ-12). */
function gapPacket(pid: number, cc: number, lengthNs: bigint): Buffer {
    const p = Buffer.alloc(PKT, 0xff);
    p[0] = 0x47;
    p[1] = (pid >> 8) & 0x1f;
    p[2] = pid & 0xff;
    p[3] = 0x20 | (cc & 0x0f);
    p[4] = 183;
    p[5] = 0x02;
    p[6] = 8;
    p.writeBigUInt64BE(lengthNs, 7);
    return p;
}

/** `pid`'s last payload CC in `buf`, which an adaptation-only packet repeats. */
const lastCc = (buf: Buffer, pid: number) =>
    (packetsOf(buf, pid).filter((p) => p[3] & 0x10).at(-1)?.[3] ?? 0) & 0x0f;

interface WireBuffer {
    pts: bigint;
    flags: number;
    size: number;
    firstPes: number | null;
    tsAligned: boolean;
}

/** The per-buffer reports cut out of the same edge's capture. */
function withBytes(wire: WireBuffer[], capture: Buffer): Array<WireBuffer & { bytes: Buffer }> {
    let off = 0;
    const out = wire.map((b) => {
        const bytes = capture.subarray(off, off + b.size);
        off += b.size;
        return { ...b, bytes };
    });
    expect(off).toBe(capture.length);
    return out;
}

/**
 * mrts::IdentityStamp's rule on one output, buffer by buffer: the first timing PES
 * (video/audio, or on the first PCR carrier) gives `PES − 1 h`; a PES none timing,
 * arrival (in [t0, t1]); no PES, the last stamp; never below the last stamp.
 */
function checkIdentity(bufs: Array<{ pts: bigint; bytes: Buffer }>, t0: bigint, t1: bigint) {
    const now = process.hrtime.bigint();
    const n = { exact: 0, held: 0, arrival: 0, repeat: 0, carrier: -1 };
    let prev: bigint | undefined;
    bufs.forEach((b, i) => {
        const pkts = packetsOf(b.bytes);
        const pc = pkts.find((p) => pcrOf(p) !== undefined);
        if (n.carrier < 0 && pc) n.carrier = tsPid(pc);
        let first: bigint | undefined;
        let anyPes = false;
        for (const p of pkts) {
            const pts = pesPts(p);
            if (pts === undefined) continue;
            anyPes = true;
            if (isAvSid(pesHeader(p)!.sid) || tsPid(p) === n.carrier) {
                first = pts;
                break;
            }
        }
        const at = `buffer ${i}: ${b.pts}`;
        if (first !== undefined) {
            const want = houseFromMuxPts(first, now);
            expect(b.pts, at).toBe(prev !== undefined && prev > want ? prev : want);
            if (b.pts === want) n.exact++;
            else n.held++;
        } else if (anyPes || prev === undefined) {
            const arrival = b.pts >= t0 && b.pts <= t1;
            expect(arrival || b.pts === prev, `${at} outside [${t0}, ${t1}]`).toBe(true);
            expect(prev === undefined || b.pts >= prev, at).toBe(true);
            n.arrival++;
        } else {
            expect(b.pts, at).toBe(prev);
            n.repeat++;
        }
        prev = b.pts;
    });
    return n;
}

interface PesRec {
    pid: number;
    sid: number;
    pts: number | null;
    dts: number | null;
    len: number;
    crc32: string;
}

/** `mrts_cli dump`: every PES of the followed program (crc32 of its payload). */
function dumpPes(file: string): { pes: Map<number, PesRec[]>; counters: Record<string, number> } {
    const res = spawnSync(MRTS_CLI, ['dump', '--chunk', String(CHUNK), file], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    expect(res.status, res.stderr).toBe(0);
    const pes = new Map<number, PesRec[]>();
    let counters: Record<string, number> = {};
    for (const line of res.stdout.split('\n').filter(Boolean)) {
        const r = JSON.parse(line);
        if (r.counters) counters = r.counters;
        if (typeof r.pid !== 'number') continue;
        const { pid, sid, pts, dts, len, crc32 } = r;
        if (!pes.has(pid)) pes.set(pid, []);
        pes.get(pid)!.push({ pid, sid, pts, dts, len, crc32 });
    }
    return { pes, counters };
}

const SHED_MSG =
    'fan-out shed buffers — the capture client was starved of CPU, so the ' +
    'byte-exactness check below is meaningless (test-environment problem, ' +
    'not a splitter continuity defect)';

describe.skipIf(!havePython || !haveBinary)('mr-tssplit end-to-end', () => {
    let dir: string;
    let fixture: string;
    const expected: Record<number, string> = {};       // pid -> sha256 (python ref)
    const expectedSize: Record<number, number> = {};   // pid -> byte count (python ref)
    const cleanups: Array<() => void> = [];

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'mr-tssplit-test-'));
        fixture = join(dir, 'fixture.ts');
        expect(
            spawnSync('python3', [FIXTURE_GEN, fixture], { cwd: __dirname }).status,
        ).toBe(0);
        const refDir = join(dir, 'ref');
        mkdirSync(refDir);
        expect(
            spawnSync('python3', [
                REF_RUNNER, '--outputs', PIDS.map((p) => `0x${p.toString(16)}`).join(','),
                '--chunk', String(CHUNK), '--out-dir', refDir, fixture,
            ], { cwd: __dirname, encoding: 'utf8' }).status,
        ).toBe(0);
        for (const pid of PIDS) {
            const ref = join(refDir, `out_0x${pid.toString(16)}.ts`);
            expected[pid] = sha256(ref);
            expectedSize[pid] = statSync(ref).size;
        }
    }, 120_000);

    afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    interface Rig {
        split: ChildProcess;
        events: Array<Record<string, unknown>>;
        inputSock: string;
        edge: (pid: number) => string;
        attach: (pid: number) => Promise<void>;
        captureClient: (pid: number, file: string, expectBytes?: number) => Promise<ChildProcess>;
        verdictOf: (proc: ChildProcess) => Promise<{ buffers: number; bytes: number; sha256: string }>;
        /** Per-buffer client: wire pts, flags and size of every buffer, until killed. */
        bufferClient: (pid: number) => Promise<ChildProcess>;
        /** Its reports, once they add up to `bytes` (the same edge's capture size). */
        buffersOf: (proc: ChildProcess, bytes: number) => Promise<WireBuffer[]>;
        send: (cmd: Record<string, unknown>) => void;
    }

    let rigSeq = 0;
    async function rig(extraArgs: string[] = [], pids: number[] = PIDS): Promise<Rig> {
        const d = join(dir, `rig-${rigSeq++}`);
        mkdirSync(d);
        const inputSock = join(d, 'in.sock');
        const split = spawn(MR_TSSPLIT, [
            '--input', inputSock, '--caps', CAPS, ...outArgs(pids), ...extraArgs,
        ], { stdio: ['pipe', 'pipe', 'inherit'] });
        cleanups.push(() => split.kill('SIGKILL'));
        const events = jsonLines(split);
        await waitFor(() => events.find((e) => e.event === 'ready'), 'ready');
        const send = (cmd: Record<string, unknown>) =>
            split.stdin!.write(JSON.stringify(cmd) + '\n');
        const edge = (pid: number) => join(d, `edge-${pid}.sock`);
        const attach = async (pid: number) => {
            send({ cmd: 'bus_attach', tee: `busout_${pid}`, socket: edge(pid) });
            await waitFor(
                () => events.find((e) => e.event === 'attached' && e.socket === edge(pid)),
                `attached ${pid}`,
            );
        };
        const captureClient = async (pid: number, file: string, expectBytes?: number) => {
            // expectBytes ends the capture deterministically; without it the
            // client only stops when the edge is detached, which TRUNCATES
            // whatever the fan-out still had queued (see the client docstring).
            const args = [CLIENT, edge(pid), '--capture', file];
            if (expectBytes !== undefined) args.push('--expect-bytes', String(expectBytes));
            const c = spawn('python3', args, {
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            cleanups.push(() => c.kill('SIGKILL'));
            const evs = jsonLines(c);
            (c as ChildProcess & { evs: typeof evs }).evs = evs;
            // CAPS received = the fan-out ACCEPTED this client (connect alone
            // races the accept, and broadcasts only reach accepted clients).
            await waitFor(() => evs.find((e) => e.caps), 'client accepted (caps)');
            return c;
        };
        const verdictOf = async (proc: ChildProcess) => {
            const evs = (proc as ChildProcess & { evs: Array<Record<string, unknown>> }).evs;
            const v = await waitFor(() => evs.find((e) => e.captured), 'capture verdict');
            return v.captured as { buffers: number; bytes: number; sha256: string };
        };
        const bufferClient = async (pid: number) => {
            // A count no test reaches: it reports every buffer until it is killed.
            const c = spawn('python3', [CLIENT, edge(pid), '--buffers', '100000000'], {
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            cleanups.push(() => c.kill('SIGKILL'));
            const evs = jsonLines(c);
            (c as ChildProcess & { evs: typeof evs }).evs = evs;
            await waitFor(() => evs.find((e) => e.caps), 'client accepted (caps)');
            return c;
        };
        const buffersOf = async (proc: ChildProcess, bytes: number) => {
            type Result = { pts: string; flags: number; memSize: number; firstPes: number | null;
                            tsAligned: boolean };
            const evs = (proc as ChildProcess & { evs: Array<Record<string, unknown>> }).evs;
            const results = () =>
                evs.map((e) => e.result as Result | undefined).filter((v): v is Result => !!v);
            await waitFor(
                () => (results().reduce((a, v) => a + v.memSize, 0) >= bytes ? true : undefined),
                'every buffer reported',
                30000,
            );
            expect(evs.find((e) => e.error)?.error).toBeUndefined();
            return results().map((v) => ({
                pts: BigInt(v.pts), flags: v.flags, size: v.memSize, firstPes: v.firstPes,
                tsAligned: v.tsAligned,
            }));
        };
        return {
            split, events, inputSock, edge, attach, captureClient, verdictOf,
            bufferClient, buffersOf, send,
        };
    }

    function server(sock: string, file: string, ...args: string[]) {
        const s = spawn('python3', [SERVER, sock, file, '--chunk', String(CHUNK), ...args], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        cleanups.push(() => s.kill('SIGKILL'));
        const evs = jsonLines(s);
        return { proc: s, evs };
    }

    it('splits byte-identically to the python core, releasing every input buffer', async () => {
        const r = await rig();
        for (const pid of PIDS) await r.attach(pid);
        const caps = await Promise.all(
            PIDS.map((pid) =>
                r.captureClient(pid, join(dir, `cap-a-${pid}.ts`), expectedSize[pid]),
            ),
        );
        const srv = server(r.inputSock, fixture, '--hold');
        await waitFor(() => srv.evs.find((e) => e.event === 'done'), 'all buffers released', 60000);

        const discovered = await waitFor(
            () => r.events.find((e) => e.event === 'plugin_event' && e.channel === 'tssplit:discovered'),
            'discovery event',
        );
        const payload = discovered.payload as {
            streams: Array<{ pid: number; streamType: number; esInfo: string }>;
            pcrPid: number;
        };
        expect(payload.pcrPid).toBe(0x65);
        expect(payload.streams.map((s) => [s.pid, s.streamType])).toEqual([
            [0x65, 0x1b], [0xc9, 0x0f], [0xca, 0x06], [0x1f0, 0x15],
        ]);
        expect(payload.streams.find((s) => s.pid === 0xca)?.esInfo).toBe(
            '05044f707573' + '7f028002',
        );
        const vi = await waitFor(
            () => r.events.find((e) => e.event === 'plugin_event' && e.channel === 'tssplit:videoinfo'),
            'videoinfo event',
        );
        expect(vi.payload).toMatchObject({ pid: 0x65, codec: 'h264', width: 1920, height: 1080 });

        await waitFor(() => r.events.find((e) => 'stats' in e), 'stats event', 5000);

        // Verdicts first (the clients self-terminate on the expected byte
        // count), THEN detach — detaching first would discard queued output.
        const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
        expect(shedCount(r.events), SHED_MSG).toBe(0);
        for (const pid of PIDS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        verdicts.forEach((v, i) => {
            expect(v.sha256, `pid 0x${PIDS[i].toString(16)} differs from python core`).toBe(
                expected[PIDS[i]],
            );
        });
    }, 120_000);

    it('gates unwired outputs; a late attach starts with the PSI carousel', async () => {
        const r = await rig();
        await r.attach(0x65);
        const capVideo = await r.captureClient(0x65, join(dir, 'cap-b-video.ts'));

        // Half 1 (1316-aligned) with video wired only; audio 0xc9 stays dark.
        const data = readFileSync(fixture);
        const mid = Math.floor(data.length / 2 / CHUNK) * CHUNK;
        const half1 = join(dir, 'half1.ts');
        const half2 = join(dir, 'half2.ts');
        writeFileSync(half1, data.subarray(0, mid));
        writeFileSync(half2, data.subarray(mid));
        const s1 = server(r.inputSock, half1);
        await waitFor(() => s1.evs.find((e) => e.event === 'done'), 'half1 released', 60000);
        s1.proc.kill();   // producer gone; splitter reconnect loop takes over

        // Attach audio during the quiet gap — deterministic, no data races.
        await r.attach(0xc9);
        const capAudio = await r.captureClient(0xc9, join(dir, 'cap-b-audio.ts'));
        const s2 = server(r.inputSock, half2);
        await waitFor(() => s2.evs.find((e) => e.event === 'done'), 'half2 released', 60000);

        r.send({ cmd: 'bus_detach', socket: r.edge(0x65) });
        r.send({ cmd: 'bus_detach', socket: r.edge(0xc9) });
        const audio = await r.verdictOf(capAudio);
        await r.verdictOf(capVideo);
        expect(audio.bytes).toBeGreaterThan(0);
        // The late-attached output's very first packet is the PAT (the forced
        // PSI carousel), so a fresh consumer locks immediately.
        const audioBytes = readFileSync(join(dir, 'cap-b-audio.ts'));
        expect(audioBytes[0]).toBe(0x47);
        expect(((audioBytes[1] & 0x1f) << 8) | audioBytes[2]).toBe(0x0000);
    }, 120_000);

    it('reinput swaps the source make-before-break with byte continuity', async () => {
        const r = await rig();
        for (const pid of PIDS) await r.attach(pid);
        const caps = await Promise.all(
            PIDS.map((pid) =>
                r.captureClient(pid, join(dir, `cap-c-${pid}.ts`), expectedSize[pid]),
            ),
        );
        const data = readFileSync(fixture);
        const mid = Math.floor(data.length / 2 / CHUNK) * CHUNK;
        writeFileSync(join(dir, 'r-half1.ts'), data.subarray(0, mid));
        writeFileSync(join(dir, 'r-half2.ts'), data.subarray(mid));

        const s1 = server(r.inputSock, join(dir, 'r-half1.ts'), '--hold');
        await waitFor(() => s1.evs.find((e) => e.event === 'done'), 'half1 consumed', 60000);

        // New producer on a different edge; swap while the old one still holds.
        const inputB = r.inputSock + '.b';
        const s2 = server(inputB, join(dir, 'r-half2.ts'));
        await waitFor(() => s2.evs.find((e) => e.event === 'ready'), 'server B ready');
        r.send({ cmd: 'reinput', socket: inputB });
        await waitFor(
            () => r.events.find((e) => e.event === 'reinput_done' && e.socket === inputB),
            'reinput_done',
        );
        await waitFor(() => s2.evs.find((e) => e.event === 'done'), 'half2 consumed', 60000);

        const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
        expect(shedCount(r.events), SHED_MSG).toBe(0);
        for (const pid of PIDS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        // Continuity across the swap = identical bytes to the single-source
        // reference (splitter state, PSI cadence and CCs carry over).
        verdicts.forEach((v, i) => {
            expect(v.sha256, `pid 0x${PIDS[i].toString(16)} lost continuity`).toBe(
                expected[PIDS[i]],
            );
        });
    }, 120_000);

    it('add_output declares a PID mid-stream without disturbing flowing outputs', async () => {
        // Spawn knowing ONLY the video pid; 0xc9 arrives later (the
        // late-discovery case that used to force a module respawn).
        const d = join(dir, `addout-${rigSeq}`);
        mkdirSync(d);
        const inputSock = join(d, 'in.sock');
        const split = spawn(MR_TSSPLIT, [
            '--input', inputSock, '--caps', CAPS, '--out', '0x65:busout_101',
        ], { stdio: ['pipe', 'pipe', 'inherit'] });
        cleanups.push(() => split.kill('SIGKILL'));
        const events = jsonLines(split);
        const send = (cmd: Record<string, unknown>) =>
            split.stdin!.write(JSON.stringify(cmd) + '\n');
        await waitFor(() => events.find((e) => e.event === 'ready'), 'ready');

        const videoEdge = join(d, 'edge-video.sock');
        const audioEdge = join(d, 'edge-audio.sock');
        send({ cmd: 'bus_attach', tee: 'busout_101', socket: videoEdge });
        await waitFor(() => events.find((e) => e.event === 'attached'), 'video attached');

        const capVideo = spawn('python3', [
            CLIENT, videoEdge, '--capture', join(dir, 'cap-e-video.ts'),
            '--expect-bytes', String(expectedSize[0x65]),
        ], { stdio: ['ignore', 'pipe', 'inherit'] });
        cleanups.push(() => capVideo.kill('SIGKILL'));
        const videoEvs = jsonLines(capVideo);
        await waitFor(() => videoEvs.find((e) => e.caps), 'video client accepted');

        // An unknown tee is refused while the pid is undeclared.
        send({ cmd: 'bus_attach', tee: 'busout_201', socket: audioEdge });
        await waitFor(
            () => events.find((e) => e.event === 'warning' && String(e.message).includes('busout_201')),
            'unknown-tee warning',
        );

        // Pace the source: the fixture otherwise streams out in ~1 s, faster
        // than discovery -> add_output -> attach -> python client startup, and
        // the late output would join after the stream had already finished.
        // The pause is well inside the 2 s stall window, so no stall fires.
        const srv = server(inputSock, fixture, '--hold', '--pause-after', '150',
                           '--pause-ms', '2500');
        await waitFor(() => events.find((e) => e.channel === 'tssplit:discovered'), 'discovery');

        // Declare 0xc9 LIVE — no respawn.
        send({ cmd: 'add_output', pid: 0xc9, tee: 'busout_201' });
        const added = await waitFor(
            () => events.find((e) => e.event === 'output_added'),
            'output_added',
        );
        expect(added.pid).toBe(0xc9);
        send({ cmd: 'bus_attach', tee: 'busout_201', socket: audioEdge });
        await waitFor(
            () => events.find((e) => e.event === 'attached' && e.socket === audioEdge),
            'audio attached',
        );
        const capAudio = spawn('python3', [
            CLIENT, audioEdge, '--capture', join(dir, 'cap-e-audio.ts'),
        ], { stdio: ['ignore', 'pipe', 'inherit'] });
        cleanups.push(() => capAudio.kill('SIGKILL'));
        const audioEvs = jsonLines(capAudio);
        await waitFor(() => audioEvs.find((e) => e.caps), 'audio client accepted');

        // The video capture self-terminates on its expected byte count.
        const videoVerdict = await waitFor(
            () => videoEvs.find((e) => e.captured),
            'video verdict',
            60000,
        );
        // THE POINT: the pre-existing output is byte-identical to the
        // single-source reference — adding an output mid-stream disturbed
        // nothing that was already flowing.
        expect(
            (videoVerdict.captured as { sha256: string }).sha256,
            'flowing output was disturbed by add_output',
        ).toBe(expected[0x65]);
        expect(split.exitCode).toBeNull();   // one process throughout, no respawn

        send({ cmd: 'bus_detach', socket: audioEdge });
        const audioVerdict = await waitFor(() => audioEvs.find((e) => e.captured), 'audio verdict');
        const audioCap = audioVerdict.captured as { bytes: number };
        expect(audioCap.bytes).toBeGreaterThan(0);
        // The late output leads with its PSI carousel so a fresh consumer locks.
        const audioBytes = readFileSync(join(dir, 'cap-e-audio.ts'));
        expect(audioBytes[0]).toBe(0x47);
        expect(((audioBytes[1] & 0x1f) << 8) | audioBytes[2]).toBe(0x0000);
        srv.proc.kill();
    }, 120_000);

    it('emits input_stalled / input_resumed around a silence window', async () => {
        const r = await rig(['--stall-ms', '300']);
        await r.attach(0x65);
        const cap = await r.captureClient(0x65, join(dir, 'cap-d.ts'));
        // Small input + generous pause: the timing margin must survive a
        // fully loaded CI box running the whole suite in parallel.
        const small = join(dir, 'small.ts');
        writeFileSync(small, readFileSync(fixture).subarray(0, 400 * CHUNK));
        const srv = server(r.inputSock, small, '--pause-after', '20', '--pause-ms', '1500');
        await waitFor(() => r.events.find((e) => e.event === 'input_stalled'), 'stalled', 30000);
        await waitFor(() => r.events.find((e) => e.event === 'input_resumed'), 'resumed', 30000);
        await waitFor(() => srv.evs.find((e) => e.event === 'done'), 'stream finished', 60000);
        r.send({ cmd: 'bus_detach', socket: r.edge(0x65) });
        await r.verdictOf(cap);
    }, 120_000);

    /** The python core's output per PID over `file` at the rig's chunking. */
    function refSplit(file: string, pids: number[]): Record<number, Buffer> {
        const out = mkdtempSync(join(dir, 'ref-'));
        const res = spawnSync('python3', [
            REF_RUNNER, '--outputs', pids.map((p) => `0x${p.toString(16)}`).join(','),
            '--chunk', String(CHUNK), '--out-dir', out, file,
        ], { encoding: 'utf8' });
        expect(res.status, res.stderr).toBe(0);
        return Object.fromEntries(
            pids.map((pid) => [pid, readFileSync(join(out, `out_0x${pid.toString(16)}.ts`))]),
        );
    }

    describe.skipIf(!haveCli)('pass-through on a field capture', () => {
        it('the OCC fixture is the capture its dump expectation describes', () => {
            const res = spawnSync(MRTS_CLI, ['dump', '--chunk', String(CHUNK), OCC], {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
            });
            expect(res.status, res.stderr).toBe(0);
            expect(res.stdout).toBe(readFileSync(OCC.replace(/\.ts$/, '.expect.jsonl'), 'utf8'));
        });

        it('copies PES and PCR untouched and stamps each output by identity', async () => {
            // On this box's house time, 30 s ahead: no arrival stamp can then hold an
            // identity stamp at the floor, so every timing PES is checked exactly.
            const input = rebaseToHouse(readFileSync(OCC), 30_000_000_000n);
            const inFile = join(dir, 'occ-in.ts');
            writeFileSync(inFile, input);
            const ref = refSplit(inFile, OCC_OUTS);
            const r = await rig([], OCC_OUTS);
            for (const pid of OCC_OUTS) await r.attach(pid);
            const caps = await Promise.all(
                OCC_OUTS.map((pid) =>
                    r.captureClient(pid, join(dir, `occ-${pid}.ts`), ref[pid].length),
                ),
            );
            const per = await Promise.all(OCC_OUTS.map((pid) => r.bufferClient(pid)));
            const t0 = process.hrtime.bigint();
            // About a third of real time, so the 20 ms coalescing gives each output its
            // own cadence of buffers (unpaced, a sparse output gets two in all).
            const srv = server(r.inputSock, inFile, '--hold', '--pace-us', '1000');
            const done = () => srv.evs.find((e) => e.event === 'done');
            await waitFor(done, 'all buffers released', 60000);
            const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
            const t1 = process.hrtime.bigint();
            expect(shedCount(r.events), SHED_MSG).toBe(0);
            const outs = OCC_OUTS.map((pid) => readFileSync(join(dir, `occ-${pid}.ts`)));
            verdicts.forEach((v, i) =>
                expect(v.sha256, `0x${OCC_OUTS[i].toString(16)} vs the python core`).toBe(
                    sha256Of(ref[OCC_OUTS[i]]),
                ),
            );

            // (1) PES bytes are never written: an output's packets on its PID are the
            // input's, in order, plus the PCR packets injected on a non-PCR output.
            const inDump = dumpPes(inFile);
            OCC_OUTS.forEach((pid, i) => {
                const hex = `0x${pid.toString(16)}`;
                const inPkts = packetsOf(input, pid);
                if (pid !== OCC_PCR_PID) {
                    expect(inPkts.some((p) => pcrOf(p) !== undefined)).toBe(false);
                }
                const outPkts = packetsOf(outs[i], pid).filter(
                    (p) => pid === OCC_PCR_PID || !isPcrOnly(p),
                );
                expect(sha256Of(Buffer.concat(outPkts)), `${hex} packets`).toBe(
                    sha256Of(Buffer.concat(inPkts)),
                );
                // ...and PES for PES as `mrts_cli dump` reads both sides (crc32 each). The
                // input's dump starts at the PMT after its first PAT (B-13), so it is the tail.
                const outDump = dumpPes(join(dir, `occ-${pid}.ts`));
                expect(outDump.counters, hex).toMatchObject({
                    desyncBytes: 0, ccLost: 0, pesDroppedCc: 0,
                });
                const want = inDump.pes.get(pid) ?? [];
                const got = outDump.pes.get(pid) ?? [];
                expect(want.length, hex).toBeGreaterThan(0);
                expect(got.slice(got.length - want.length), `${hex} PES`).toEqual(want);
            });

            // (2) The program PCR is copied, never computed: each PCR injected on a non-PCR
            // output is an input PCR value, at least 10 ms after the one before.
            const inPcrs = new Set(
                packetsOf(input, OCC_PCR_PID).map((p) => String(pcrOf(p) ?? '')).filter(Boolean),
            );
            OCC_OUTS.forEach((pid, i) => {
                const pcrOnly = (b: Buffer) =>
                    packetsOf(b, pid).filter(isPcrOnly).map((p) => pcrOf(p)!);
                const injected = pcrOnly(outs[i]);
                if (pid === OCC_PCR_PID) {
                    expect(injected).toEqual(pcrOnly(input));   // only the source's own
                    return;
                }
                expect(injected.length).toBeGreaterThan(2);
                injected.forEach((v, k) => {
                    expect(inPcrs.has(String(v)), `0x${pid.toString(16)} PCR ${v}`).toBe(true);
                    if (k) expect(floorMod(v - injected[k - 1], PCR_MODULO) >= 270000n).toBe(true);
                });
            });

            // (3) Each buffer's wire stamp is `PES − 1 h` of its first timing PES (never
            // below the last), the teletext output's too: its PID carries the injected PCR.
            const wires = await Promise.all(
                OCC_OUTS.map(async (_, i) =>
                    withBytes(await r.buffersOf(per[i], outs[i].length), outs[i]),
                ),
            );
            per.forEach((c) => c.kill('SIGKILL'));   // before a detach ends their reads
            for (const w of wires) expect(w.every((b) => b.flags === 0 && b.tsAligned)).toBe(true);
            const [video, audio, ttx] = wires.map((w) => checkIdentity(w, t0, t1));
            expect(video.exact).toBeGreaterThan(2);   // B-frame buffers held at the floor
            expect(audio.held).toBe(0);
            expect(audio.exact).toBeGreaterThan(1);
            // Teletext is stamped at arrival until the splitter's discovery injects a PCR.
            expect(ttx.carrier).toBe(0x20);
            expect(ttx.held).toBe(0);
            expect(ttx.arrival).toBeGreaterThan(0);
            expect(ttx.exact).toBeGreaterThan(2);

            // (4) Nothing estimates time: no timeline_* events, no `timeline` in the stats
            // line, and P0's lateness window per output counts each buffer once.
            type Stats = { lateness?: Record<string, { count: number }> } | undefined;
            await waitFor(() => {
                const c: Record<string, number> = {};
                for (const e of r.events) {
                    for (const [tee, w] of Object.entries((e.stats as Stats)?.lateness ?? {})) {
                        c[tee] = (c[tee] ?? 0) + w.count;
                    }
                }
                const all = OCC_OUTS.every((pid, i) => c[`busout_${pid}`] === wires[i].length);
                return all ? c : undefined;
            }, 'a lateness window per output', 8000);
            const timeline = r.events.filter((e) => String(e.event ?? '').startsWith('timeline'));
            expect(timeline).toEqual([]);
            for (const e of r.events.filter((e) => e.stats)) {
                expect(e.stats).not.toHaveProperty('timeline');
            }
            for (const pid of OCC_OUTS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        }, 120_000);

        it('forwards a gap marker alone on its output, with its own PTS and flags', async () => {
            // Marker 1 before the splitter's discovery, on two outputs and a PID that is
            // no output; marker 2 after it, on teletext, GAP without DISCONT, beside a
            // PCR-only packet on the video PID that is no marker and goes nowhere.
            const data = readFileSync(OCC);
            const A = 400 * CHUNK;
            const AB = 1200 * CHUNK;
            const m1 = [0x65, 0xc9, 0x1ff].map((pid) =>
                gapPacket(pid, lastCc(data.subarray(0, A), pid), 1_500_000_000n),
            );
            const m2 = gapPacket(0x20, lastCc(data.subarray(0, AB), 0x20), 250_000_000n);
            const stray = gapPacket(0x65, 0, 0n);
            stray[5] = 0x10;   // PCR_flag instead of transport_private_data_flag
            const M1 = 7_000_000_000_001n;
            const M2 = 7_000_250_000_002n;
            writeFileSync(join(dir, 'm1.ts'), Buffer.concat(m1));
            writeFileSync(join(dir, 'm2.ts'), Buffer.concat([m2, stray]));
            writeFileSync(join(dir, 'occ-a.ts'), data.subarray(0, A));
            writeFileSync(join(dir, 'occ-ab.ts'), data.subarray(0, AB));
            // The core never sees a marker: each output is the python core's stream
            // with its marker where the prefix before it ends.
            const full = refSplit(OCC, OCC_OUTS);
            const refA = refSplit(join(dir, 'occ-a.ts'), OCC_OUTS);
            const refAB = refSplit(join(dir, 'occ-ab.ts'), OCC_OUTS);
            const GAP_DISCONT = GST_GAP | GST_DISCONT;
            type Marker = { at: number; pkt: Buffer; pts: bigint; flags: number };
            const marker: Record<number, Marker> = {
                [0x65]: { at: refA[0x65].length, pkt: m1[0], pts: M1, flags: GAP_DISCONT },
                [0xc9]: { at: refA[0xc9].length, pkt: m1[1], pts: M1, flags: GAP_DISCONT },
                [0x20]: { at: refAB[0x20].length, pkt: m2, pts: M2, flags: GST_GAP },
            };
            const expected: Record<number, Buffer> = {};
            for (const pid of OCC_OUTS) {
                const { at, pkt } = marker[pid];
                const out = full[pid];
                expected[pid] = Buffer.concat([out.subarray(0, at), pkt, out.subarray(at)]);
            }

            const r = await rig([], OCC_OUTS);
            for (const pid of OCC_OUTS) await r.attach(pid);
            const caps = await Promise.all(
                OCC_OUTS.map((pid) =>
                    r.captureClient(pid, join(dir, `gap-${pid}.ts`), expected[pid].length),
                ),
            );
            const per = await Promise.all(OCC_OUTS.map((pid) => r.bufferClient(pid)));
            const srv = server(r.inputSock, OCC, '--hold',
                '--insert', `${A}:${join(dir, 'm1.ts')}:${M1}:${GAP_DISCONT}`,
                '--insert', `${AB}:${join(dir, 'm2.ts')}:${M2}:${GST_GAP}`);
            const done = () => srv.evs.find((e) => e.event === 'done');
            await waitFor(done, 'all buffers released', 60000);
            const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
            expect(shedCount(r.events), SHED_MSG).toBe(0);
            verdicts.forEach((v, i) => {
                const pid = OCC_OUTS[i];
                expect(v.sha256, `0x${pid.toString(16)}`).toBe(sha256Of(expected[pid]));
            });
            for (const [i, pid] of OCC_OUTS.entries()) {
                const wire = await r.buffersOf(per[i], expected[pid].length);
                const flagged = wire.filter((b) => b.flags !== 0);
                expect(flagged, `0x${pid.toString(16)}`).toHaveLength(1);
                const { at, pts, flags } = marker[pid];
                const alone = { pts, flags, size: PKT, firstPes: null, tsAligned: true };
                expect(flagged[0]).toEqual(alone);
                const k = wire.indexOf(flagged[0]);
                expect(wire.slice(0, k).reduce((a, b) => a + b.size, 0)).toBe(at);
            }
            per.forEach((c) => c.kill('SIGKILL'));
            for (const pid of OCC_OUTS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        }, 120_000);
    });
});
