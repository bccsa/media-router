import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end integration of the native mr-tssplit child over real GstUnixFd
 * sockets (Linux only): a python unixfdsink stand-in feeds the phase-1
 * fixture upstream (verifying RELEASE_BUFFER for every buffer), capture
 * clients drain each output edge, and the captured SPTS streams must be
 * byte-identical (sha256) to the python SplitterCore reference over the same
 * chunking. Also covers: wired-only gating (late attach starts with PSI),
 * make-before-break reinput continuity, and input stall events.
 */

const NATIVE_DIR = join(__dirname, '../../../../native');
const MR_TSSPLIT = join(NATIVE_DIR, 'mr-tssplit/mr-tssplit');
const SERVER = join(__dirname, 'unixfd-test-server.py');
const CLIENT = join(__dirname, 'unixfd-fanout.test-client.py');
const FIXTURE_GEN = join(__dirname, 'native_parity_fixture.py');
const REF_RUNNER = join(__dirname, 'native_parity_ref.py');
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

describe.skipIf(!havePython || !haveBinary)('mr-tssplit end-to-end', () => {
    let dir: string;
    let fixture: string;
    const expected: Record<number, string> = {};   // pid -> sha256 (python ref)
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
        for (const pid of PIDS) expected[pid] = sha256(join(refDir, `out_0x${pid.toString(16)}.ts`));
    }, 120_000);

    afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    interface Rig {
        split: ChildProcess;
        events: Array<Record<string, unknown>>;
        inputSock: string;
        edge: (pid: number) => string;
        attach: (pid: number) => Promise<void>;
        captureClient: (pid: number, file: string) => Promise<ChildProcess>;
        verdictOf: (proc: ChildProcess) => Promise<{ buffers: number; bytes: number; sha256: string }>;
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
        const captureClient = async (pid: number, file: string) => {
            const c = spawn('python3', [CLIENT, edge(pid), '--capture', file], {
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
        return { split, events, inputSock, edge, attach, captureClient, verdictOf, send };
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
            PIDS.map((pid) => r.captureClient(pid, join(dir, `cap-a-${pid}.ts`))),
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

        for (const pid of PIDS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
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
            PIDS.map((pid) => r.captureClient(pid, join(dir, `cap-c-${pid}.ts`))),
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

        for (const pid of PIDS) r.send({ cmd: 'bus_detach', socket: r.edge(pid) });
        const verdicts = await Promise.all(caps.map((c) => r.verdictOf(c)));
        // Continuity across the swap = identical bytes to the single-source
        // reference (splitter state, PSI cadence and CCs carry over).
        verdicts.forEach((v, i) => {
            expect(v.sha256, `pid 0x${PIDS[i].toString(16)} lost continuity`).toBe(
                expected[PIDS[i]],
            );
        });
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
