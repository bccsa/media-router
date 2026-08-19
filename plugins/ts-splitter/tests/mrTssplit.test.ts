import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP, ladderFixture, pesPacket, rungs, toNs } from '../../mpegts-core/tests/tsFixtures';

/**
 * End-to-end integration of the native mr-tssplit child over real GstUnixFd
 * sockets (Linux only): a python unixfdsink stand-in feeds the phase-1
 * fixture upstream (verifying RELEASE_BUFFER for every buffer), capture
 * clients drain each output edge, and the captured SPTS streams must be
 * byte-identical (sha256) to the python SplitterCore reference over the same
 * chunking. Also covers: wired-only gating (late attach starts with PSI),
 * make-before-break reinput continuity, and input stall events.
 */

const PLUGINS_DIR = join(__dirname, '../..');
const MR_TSSPLIT = join(__dirname, '../native/mr-tssplit/mr-tssplit');
const SERVER = join(PLUGINS_DIR, 'unixfdbus-core/py/unixfd-test-server.py');
const CLIENT = join(PLUGINS_DIR, 'unixfdbus-core/py/unixfd-fanout.test-client.py');
const FIXTURE_GEN = join(PLUGINS_DIR, 'mpegts-core/py/native_parity_fixture.py');
const REF_RUNNER = join(PLUGINS_DIR, 'mpegts-core/py/native_parity_ref.py');
const CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';
const CHUNK = 1316;

const PIDS = [0x65, 0xc9, 0xca, 0x1f0];
const OUT_ARGS = PIDS.flatMap((pid) => [
    '--out',
    `0x${pid.toString(16)}:busout_${pid}`,
]);

const havePython = spawnSync('python3', ['--version']).status === 0;
const haveBinary = process.platform === 'linux' && existsSync(MR_TSSPLIT);

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
    return createHash('sha256').update(readFileSync(path)).digest('hex');
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

const LADDER_RUNGS = 20;
/** Audio leads video by a fixed 100 ms, so a shared anchor is distinguishable
 *  from two coincidental ones. */
const AV_SKEW = 9000n;

/**
 * Interleaved A/V PES ladder for the stamping test: one video packet then one
 * audio packet per rung, 40 ms apart. No PSI — the splitter routes by the
 * `--out` PIDs and injects its own PAT/PMT per output. (The parity fixture
 * can't serve here: its PES headers carry no PTS at all.)
 */
const avLadder = (count: number) =>
    ladderFixture(rungs(count, 8_100_000n), { pids: [0x65, 0xc9], skew: AV_SKEW });

/** Where the looping-VOD fixture below rewinds to — 50 ms, as the real source
 *  restarts near zero. A multiple of 9, like every other PTS here, so the
 *  90 kHz → ns conversion stays exact and implied anchors compare by equality. */
const LOOP_PTS = 4500n;

/**
 * The 2026-08-13 field topology: a looping VOD, and a video PID that emits
 * SEVERAL buffers between each audio one (which is what the splitter's
 * coalescing does to a real A/V feed — video fills a batch in tens of ms,
 * audio takes far longer). At the loop each output therefore sees a LONE
 * anomaly with clean buffers either side, so the cross-PID confirmation rule
 * — two anomalous buffers in a row — can never be satisfied on either. This
 * shape is the difference between reproducing the field freeze and not: a 1:1
 * A/V interleave would have confirmed on the audio buffer and recovered.
 */
function avLoopFixture(pre: number, post: number): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i < pre + post; i++) {
        const pts =
            i < pre ? 8_100_000n + BigInt(i) * STEP : LOOP_PTS + BigInt(i - pre) * STEP;
        parts.push(pesPacket(0x65, pts));
        if (i % 4 === 3) parts.push(pesPacket(0xc9, pts + AV_SKEW));
    }
    return Buffer.concat(parts);
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
        /** Per-buffer client (reports wire pts + the payload's first PES). */
        ladderClient: (pid: number, buffers: number) => Promise<ChildProcess>;
        stampsOf: (proc: ChildProcess) => Promise<Array<{ pts: bigint; firstPes: bigint }>>;
        send: (cmd: Record<string, unknown>) => void;
    }

    let rigSeq = 0;
    async function rig(extraArgs: string[] = []): Promise<Rig> {
        const d = join(dir, `rig-${rigSeq++}`);
        mkdirSync(d);
        const inputSock = join(d, 'in.sock');
        const split = spawn(MR_TSSPLIT, [
            '--input', inputSock, '--caps', CAPS, ...OUT_ARGS, ...extraArgs,
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
        const ladderClient = async (pid: number, buffers: number) => {
            const c = spawn('python3', [CLIENT, edge(pid), '--buffers', String(buffers)], {
                stdio: ['ignore', 'pipe', 'inherit'],
            });
            cleanups.push(() => c.kill('SIGKILL'));
            const evs = jsonLines(c);
            (c as ChildProcess & { evs: typeof evs }).evs = evs;
            await waitFor(() => evs.find((e) => e.caps), 'client accepted (caps)');
            return c;
        };
        const stampsOf = async (proc: ChildProcess) => {
            const evs = (proc as ChildProcess & { evs: Array<Record<string, unknown>> }).evs;
            await waitFor(() => evs.find((e) => e.event === 'done' || e.error), 'stamp verdicts');
            expect(evs.find((e) => e.error)?.error).toBeUndefined();
            return evs
                .map((e) => e.result as { pts: string; firstPes: number } | undefined)
                .filter((v): v is { pts: string; firstPes: number } => v !== undefined)
                .map((v) => ({ pts: BigInt(v.pts), firstPes: BigInt(v.firstPes) }));
        };
        return {
            split, events, inputSock, edge, attach, captureClient, verdictOf,
            ladderClient, stampsOf, send,
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

    it('stamps every output from ONE shared anchor (--stamp-timeline)', async () => {
        // The time-sync contract's per-branch property, and the reason the
        // splitter exists: each output is its own wire stream, but they must
        // stay MUTUALLY aligned. With one shared anchor + epoch the implied
        // anchor (wire pts - the buffer's own PES, in ns) is a single number
        // across both branches; give each output its own stamper and the two
        // constants drift apart by the wall gap between their first buffers.
        const ladder = join(dir, 'ladder.ts');
        writeFileSync(ladder, avLadder(LADDER_RUNGS));
        const r = await rig(['--stamp-timeline', '--flush-ms', '0']);
        await r.attach(0x65);
        await r.attach(0xc9);
        const video = await r.ladderClient(0x65, LADDER_RUNGS);
        const audio = await r.ladderClient(0xc9, LADDER_RUNGS);
        // One rung (the video+audio packet pair) per input chunk — the later
        // --chunk wins in the server's argparse — so with --flush-ms 0 each
        // output emits exactly one buffer per rung, carrying one ES packet.
        const srv = server(r.inputSock, ladder, '--chunk', String(2 * 188));
        await waitFor(() => srv.evs.find((e) => e.event === 'done'), 'ladder consumed', 60000);

        const stamps = await Promise.all([video, audio].map((c) => r.stampsOf(c)));
        expect(shedCount(r.events), SHED_MSG).toBe(0);
        // Every buffer carries exactly one ES packet here (--flush-ms 0), so
        // each stamp is checkable against the payload it describes.
        for (const s of stamps) expect(s).toHaveLength(LADDER_RUNGS);
        const implied = stamps.flat().map((s) => s.pts - toNs(s.firstPes));
        expect(new Set(implied.map(String)).size, 'branches anchored separately').toBe(1);
        // The drift loop is per-EGRESS, like the anchor it corrects: ONE
        // `timeline` object in the stats line for the whole splitter, not one
        // per output — a per-branch loop would slew the branches apart, which
        // is the failure a shared anchor exists to prevent. Field set is
        // `mrts::drift_stats_json`, python's `drift_stats()` key for key.
        const stats = (await waitFor(
            () => r.events.find((e) => 'stats' in e),
            'stats event',
            8000,
        )).stats as Record<string, unknown>;
        expect(Object.keys(stats.timeline as object).sort()).toEqual([
            'engageNs',
            'marginNs',
            'ppm',
            'samples',
            'slewNs',
            'window',
        ]);
        // ...and the mapping is the contract's, not a constant offset that
        // happens to match: the A/V lead the source encoded survives exactly.
        expect(stamps[1][0].pts - stamps[0][0].pts).toBe(
            toNs(stamps[1][0].firstPes - stamps[0][0].firstPes),
        );
        for (const pid of [0x65, 0xc9]) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
    }, 120_000);

    it('re-anchors every output when the source loops back to zero', async () => {
        // The 2026-08-13 field failure, in the producer that showed it. The
        // splitter's outputs are SINGLE-PID streams, so a source loop gives
        // each of them one isolated anomaly and nothing to confirm it with —
        // until the watch learned to confirm on the PID's own next buffer, no
        // re-anchor was emitted at all and the monotone floor pinned every
        // later stamp to the last pre-loop value. Measured on .202: newest and
        // oldest of 20 tapped video buffers both at the SAME pts, 11.6 minutes
        // behind CLOCK_MONOTONIC, with the sync=true sink dropping the lot.
        const PRE = 12, POST = 24;
        const ladder = join(dir, 'loop-ladder.ts');
        writeFileSync(ladder, avLoopFixture(PRE, POST));
        const r = await rig(['--stamp-timeline', '--flush-ms', '0']);
        await r.attach(0x65);
        await r.attach(0xc9);
        const video = await r.ladderClient(0x65, PRE + POST);
        const audio = await r.ladderClient(0xc9, (PRE + POST) / 4);
        // One TS packet per input chunk, so every ES packet becomes its own
        // output buffer — the per-PID buffer cadence the field ran at.
        const srv = server(r.inputSock, ladder, '--chunk', '188');
        await waitFor(() => srv.evs.find((e) => e.event === 'done'), 'ladder consumed', 60000);

        const [vStamps, aStamps] = await Promise.all([video, audio].map((c) => r.stampsOf(c)));
        expect(shedCount(r.events), SHED_MSG).toBe(0);
        const reanchors = r.events.filter((e) => e.event === 'timeline_reanchor');
        expect(reanchors).toHaveLength(1);
        // The video PID both reports and confirms it — no second PID needed.
        expect(reanchors[0]).toMatchObject({ pid: 0x65, count: 1 });

        // The timeline is LIVE again on the far side of the loop: a surviving
        // floor would flatten every one of these steps to zero for the rest of
        // the loop, which is exactly what the field saw.
        const tail = vStamps.slice(PRE + 2);
        expect(tail.length).toBeGreaterThan(10);
        for (let i = 1; i < tail.length; i++) {
            expect(tail[i].pts - tail[i - 1].pts).toBe(toNs(STEP));
        }
        // ...and both branches came through it on ONE anchor, so the A/V lead
        // the source encoded is still exactly the source's. Two anchors here
        // would re-roll lipsync at every loop.
        const implied = [...tail, ...aStamps.filter((s) => s.firstPes < 8_100_000n)].map(
            (s) => s.pts - toNs(s.firstPes),
        );
        expect(new Set(implied.map(String)).size, 'branches re-anchored separately').toBe(1);
        for (const pid of [0x65, 0xc9]) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
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
});
