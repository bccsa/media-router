import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogTap, type HouseEpoch, type TimeSyncState } from '@media-router/shared-types';
import { HouseClock, type HouseClockOptions } from './HouseClock.js';
import { SETTLE_MAX_MS, START_WAIT_MS, deltaNs } from './houseClockPolicy.js';
import { ProcessManager } from '../child-process/ProcessManager.js';
import type { ManagedProcessOptions } from '../child-process/ManagedProcess.js';

const S = 1_000_000_000n;
const E0 = 1_789_775_770n * S;

function line(
    over: { eNs?: bigint; synced?: boolean; tai?: number; maxErrorUs?: number } = {},
): string {
    return JSON.stringify({
        type: 'sample',
        monoNs: '2103103813119540',
        eNs: String(over.eNs ?? E0),
        bracketNs: 80,
        synced: over.synced ?? true,
        taiOffsetS: over.tai ?? 37,
        estErrorUs: 1500,
        maxErrorUs: over.maxErrorUs ?? 9000,
        freqPpm: 3.5,
        status: 0x2001,
        leap: 'ok',
    });
}
const STEP = '{"type":"step","monoNs":"2103104000000000"}';
/** A Pi without an RTC boots this far behind (.108, .50). */
const BOOT_E = E0 - 214n * 86_400n * S;

/** A ProcessManager stand-in: the test is the sidecar, writing its stdout lines. */
function fakeSidecar(opts: Partial<HouseClockOptions> = {}) {
    let spawned: ManagedProcessOptions | null = null;
    const processManager = {
        spawn: vi.fn((_owner: string, o: ManagedProcessOptions) => {
            spawned = o;
            return { on: vi.fn() } as never;
        }),
        kill: vi.fn(async () => {}),
    };
    const exec = vi.fn(
        async (cmd: string): Promise<string> => (cmd === 'systemctl' ? 'active\ninactive\n' : ''),
    );
    const clock = new HouseClock({
        processManager,
        resolveBinary: () => '/usr/libexec/media-router/engine/mr-clockstate',
        exec,
        ...opts,
    });
    const epochs: HouseEpoch[] = [];
    const states: TimeSyncState[] = [];
    clock.on('epoch', (e: HouseEpoch) => epochs.push(e));
    clock.on('state', (s: TimeSyncState) => states.push(s));
    const emit = (l: string) => spawned!.onStdout!(l);
    return { clock, processManager, exec, epochs, states, emit };
}

/** Let the first source poll finish (lines are held until it has). */
const polled = () => new Promise((r) => setImmediate(r));
const decisions = (epochs: HouseEpoch[]) => epochs.map((e) => [e.seq, e.reason, e.traceable]);

describe('HouseClock', () => {
    let clock: HouseClock | null = null;
    afterEach(async () => {
        await clock?.stop();
        clock = null;
        vi.useRealTimers();
    });

    it('latches at the first synced sample, naming its source; ready() resolves with it', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        h.emit(line());
        await polled();
        const ep = await h.clock.ready();
        expect(ep).toMatchObject({
            eNs: E0,
            seq: 1,
            reason: 'start',
            traceable: true,
            source: 'chrony',
            taiOffsetS: 37,
        });
        const st = h.clock.state();
        expect(st).toMatchObject({
            source: 'chrony',
            synced: true,
            traceable: true,
            waitingForSync: false,
        });
        expect(st).toMatchObject({
            epochSeq: 1,
            epochReason: 'start',
            eNs: String(E0),
            sidecar: true,
        });
        expect(st.epochLatchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(h.processManager.spawn).toHaveBeenCalledWith(
            '__house_clock__',
            expect.objectContaining({
                command: '/usr/libexec/media-router/engine/mr-clockstate',
                autoRestart: true,
            }),
        );
    });

    it('never synced: shows the wait, then latches untraceable at 30 s; late sync re-latches', async () => {
        vi.useFakeTimers();
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await vi.advanceTimersByTimeAsync(0);
        h.emit(line({ synced: false, tai: 0 }));
        let ready: HouseEpoch | null | undefined;
        void h.clock.ready().then((e) => (ready = e));

        await vi.advanceTimersByTimeAsync(10_000);
        expect(ready).toBeUndefined();
        expect(h.clock.state()).toMatchObject({
            waitingForSync: true,
            waitRemainingS: 20,
            epochSeq: 0,
        });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(ready).toMatchObject({ seq: 1, reason: 'timeout', traceable: false });
        expect(h.clock.state()).toMatchObject({ waitingForSync: false, traceable: false });

        // chrony syncs and the TAI offset lands: E moves by 37 s.
        h.emit(line({ eNs: E0 + 37n * S }));
        expect(h.epochs.map((e) => [e.seq, e.reason, e.traceable])).toEqual([
            [1, 'timeout', false],
            [2, 'sync', true],
        ]);
        expect(h.clock.epoch()!.eNs).toBe(E0 + 37n * S);
    });

    it('sync after an untraceable start with E unchanged flips traceable, no new epoch', async () => {
        vi.useFakeTimers();
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await vi.advanceTimersByTimeAsync(0);
        h.emit(line({ synced: false }));
        await vi.advanceTimersByTimeAsync(30_000);
        h.emit(line({ eNs: E0 + 4_000n }));
        expect(h.epochs).toHaveLength(1);
        expect(h.clock.epoch()).toMatchObject({ seq: 1, traceable: true, eNs: E0 });
        expect(h.states.at(-1)).toMatchObject({ traceable: true, epochSeq: 1 });
    });

    it('a step that moved E re-latches as a step; one that did not is only logged', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        h.emit(line());
        await polled();
        h.emit(STEP);
        h.emit(line({ eNs: E0 + 2_000n })); // leap insert: REALTIME stepped, E did not
        expect(h.epochs).toHaveLength(1);
        h.emit(STEP);
        h.emit(line({ eNs: E0 + 2n * S }));
        expect(h.epochs.at(-1)).toMatchObject({ seq: 2, reason: 'step', eNs: E0 + 2n * S });
        h.emit(line({ eNs: E0 + 2n * S + 1_500_000n })); // no step line: divergence
        expect(h.epochs.at(-1)).toMatchObject({ seq: 3, reason: 'divergence' });
    });

    it('loss of sync keeps E and drops traceability', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        h.emit(line());
        await polled();
        h.emit(line({ synced: false }));
        expect(h.clock.epoch()).toMatchObject({ seq: 1, eNs: E0, traceable: false });
        expect(h.clock.state()).toMatchObject({ synced: false, traceable: false });
    });

    it('a sidecar restart (same E, small jitter) never re-epochs', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        h.emit(line());
        await polled();
        // ManagedProcess restarts reuse the same onStdout: a fresh process, same clock.
        for (const j of [700n, -300n, 9_000n]) h.emit(line({ eNs: E0 + j }));
        expect(h.epochs).toHaveLength(1);
        expect(h.clock.epoch()!.eNs).toBe(E0);
    });

    it('linuxptp start-up false window (.108): no latch until a real sync', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await polled();
        // ptp4l/phc2sys set_leap(0) clears STA_UNSYNC for < 1 s, maxerror still at the 16 s limit.
        h.emit(line({ eNs: BOOT_E, synced: true, maxErrorUs: 16_000_000 }));
        for (let i = 0; i < 3; i++)
            h.emit(line({ eNs: BOOT_E, synced: false, maxErrorUs: 16_000_000 }));
        expect(h.epochs).toEqual([]);
        expect(h.states.some((st) => st.synced)).toBe(false);
        expect(h.clock.state()).toMatchObject({ synced: false, waitingForSync: true, epochSeq: 0 });
        h.emit(STEP); // the PTP step at lock, then locked: maxerror reset to 0
        h.emit(line({ eNs: E0, synced: true, maxErrorUs: 0 }));
        expect(decisions(h.epochs)).toEqual([[1, 'start', true]]);
        expect(h.clock.epoch()!.eNs).toBe(E0);
        expect(h.clock.state()).toMatchObject({ synced: true, traceable: true });
    });

    it('.108 boot: nothing flips in the window, then timeout, then the PTP step', async () => {
        vi.useFakeTimers();
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await vi.advanceTimersByTimeAsync(0);
        const falseWindow = line({ eNs: BOOT_E, synced: true, maxErrorUs: 16_000_000 });
        h.emit(falseWindow);
        await vi.advanceTimersByTimeAsync(START_WAIT_MS);
        h.emit(falseWindow); // ptp4l restarted while untraceable: no "sync arrived"
        expect(decisions(h.epochs)).toEqual([[1, 'timeout', false]]);
        expect(h.clock.epoch()!.traceable).toBe(false);
        await vi.advanceTimersByTimeAsync(36_000); // 66 s after start
        h.emit(STEP);
        h.emit(line({ eNs: E0, synced: true, maxErrorUs: 0 }));
        expect(decisions(h.epochs)).toEqual([
            [1, 'timeout', false],
            [2, 'step', true],
        ]);
    });

    it('missing mr-clockstate: logs, no epoch, ready() resolves at once with null', async () => {
        const h = fakeSidecar({ resolveBinary: () => null });
        clock = h.clock;
        h.clock.start();
        await expect(h.clock.ready()).resolves.toBeNull();
        expect(h.processManager.spawn).not.toHaveBeenCalled();
        expect(h.clock.state()).toMatchObject({
            sidecar: false,
            waitingForSync: false,
            traceable: false,
            epochSeq: 0,
        });
    });

    it('a step re-polls the clock owner at once, not at the next 10 s poll', async () => {
        vi.useFakeTimers();
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await vi.advanceTimersByTimeAsync(0);
        h.emit(line());
        const polls = () => h.exec.mock.calls.filter(([cmd]) => cmd === 'systemctl').length;
        expect(polls()).toBe(1);
        // The grandmaster loses the election: chronyd revoked, then linuxptp steps REALTIME.
        h.exec.mockImplementation(async (cmd: string) =>
            cmd === 'systemctl' ? 'inactive\nactive\n' : '',
        );
        h.emit(STEP);
        expect(polls()).toBe(2);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.clock.state().source).toBe('ptp');
        expect(h.states.at(-1)?.source).toBe('ptp');
    });

    it("an older poll's late answer never overwrites a step's newer one", async () => {
        vi.useFakeTimers();
        const answer: Array<(stdout: string) => void> = [];
        const h = fakeSidecar({
            exec: (cmd) =>
                cmd === 'systemctl' ? new Promise((r) => answer.push(r)) : Promise.resolve(''),
        });
        clock = h.clock;
        h.clock.start();
        answer[0]('active\ninactive\n');
        await vi.advanceTimersByTimeAsync(10_000); // the periodic poll asks before the handover
        h.emit(STEP); // and the step's poll after it
        answer[2]('inactive\nactive\n');
        await vi.advanceTimersByTimeAsync(0);
        answer[1]('active\ninactive\n');
        await vi.advanceTimersByTimeAsync(0);
        expect(answer).toHaveLength(3);
        expect(h.clock.state().source).toBe('ptp');
    });

    it('warns of an unreadable sidecar line at most once a minute, with an excerpt', async () => {
        vi.useFakeTimers();
        const warned: string[] = [];
        setLogTap((l) => {
            const { name, msg } = JSON.parse(l) as { name: string; msg: string };
            if (name === 'clock' && msg.includes('unreadable')) warned.push(msg);
        });
        try {
            const h = fakeSidecar();
            clock = h.clock;
            h.clock.start();
            await vi.advanceTimersByTimeAsync(0);
            const cut = line().slice(0, -1); // a sample cut short
            h.emit(cut);
            h.emit('not json');
            expect(warned).toEqual([
                `clock: ignored an unreadable mr-clockstate line: ${cut.slice(0, 120)}…`,
            ]);
            // The minute is monotonic: a REALTIME step back of a day does not stretch it.
            vi.setSystemTime(Date.now() - 86_400_000);
            await vi.advanceTimersByTimeAsync(59_999);
            h.emit('not json');
            expect(warned).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            h.emit('not json');
            expect(warned).toEqual([
                warned[0],
                'clock: ignored an unreadable mr-clockstate line: not json',
            ]);
        } finally {
            setLogTap(null);
        }
    });

    it('carries chrony tracking into the state when chrony owns the clock', async () => {
        const h = fakeSidecar({
            exec: async (cmd) =>
                cmd === 'systemctl'
                    ? 'active\ninactive\n'
                    : 'A29FC87B,ntp1.example.org,2,1791234567.123,0.000100,0.000020,0.000050,-3.479,0.001,0.010,0.004000,0.000500,64.2,Normal\n',
        });
        clock = h.clock;
        h.clock.start();
        await polled();
        expect(h.clock.state().chrony).toEqual({
            reference: 'ntp1.example.org',
            stratum: 2,
            estErrorUs: 2600,
            leap: 'Normal',
        });
    });
});

/** The .50 captures (fixtures/PROVENANCE.md), one line at a time through the sidecar's stdout. */
describe('HouseClock replaying field captures', () => {
    let clock: HouseClock | null = null;
    afterEach(async () => {
        await clock?.stop();
        clock = null;
        vi.useRealTimers();
    });

    const fixture = (name: string): string[] =>
        readFileSync(join(__dirname, 'fixtures', name), 'utf8')
            .split('\n')
            .filter(Boolean);
    const field = (l: string, k: 'monoNs' | 'eNs') =>
        BigInt((JSON.parse(l) as Record<string, string>)[k]);

    /** A chrony box's clock, its wait already run out when `untraceable`; fake time follows
     *  each line's monoNs, then runs on for a settle cap so a pending settle ends. */
    async function play(name: string, untraceable: boolean) {
        vi.useFakeTimers();
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        await vi.advanceTimersByTimeAsync(untraceable ? START_WAIT_MS : 0);
        const lines = fixture(name);
        const t0 = field(lines[0], 'monoNs');
        let at = 0;
        for (const l of lines) {
            const t = Number((field(l, 'monoNs') - t0) / 1_000_000n);
            await vi.advanceTimersByTimeAsync(t - at);
            at = t;
            h.emit(l);
        }
        const beforeCap = decisions(h.epochs);
        await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS);
        const es = lines.filter((l) => l.includes('"type":"sample"')).map((l) => field(l, 'eNs'));
        return { h, beforeCap, es };
    }
    const dEms = (h: { epochs: HouseEpoch[] }) => Number(h.epochs[1].eNs - h.epochs[0].eNs) / 1e6;

    it('synced 60 s: one start latch, E constant within 10 µs', async () => {
        const { h, es } = await play('clockstate-synced.jsonl', false);
        expect(decisions(h.epochs)).toEqual([[1, 'start', true]]);
        expect(es).toHaveLength(60);
        for (const e of es) expect(deltaNs(e, h.epochs[0].eNs)).toBeLessThan(10_000n);
        expect(h.clock.state()).toMatchObject({ synced: true, traceable: true, taiOffsetS: 37 });
    });

    it('date step +2 s, chronyd stopped: re-latched at once as a step, ΔE 2 s ± 1 ms', async () => {
        const { h, beforeCap } = await play('clockstate-date-step.jsonl', false);
        expect(beforeCap).toEqual(decisions(h.epochs));
        expect(decisions(h.epochs)).toEqual([
            [1, 'start', true],
            [2, 'step', false],
        ]);
        expect(Math.abs(dEms(h) - 2000)).toBeLessThan(1);
    });

    it('TAI 0 → 37, chronyd stopped: held for sync, re-latched at the cap, ΔE 37 s', async () => {
        const { h, beforeCap } = await play('clockstate-tai-late.jsonl', true);
        expect(beforeCap).toEqual([[1, 'timeout', false]]);
        expect(decisions(h.epochs)).toEqual([
            [1, 'timeout', false],
            [2, 'divergence', false],
        ]);
        expect(Math.abs(dEms(h) - 37_000)).toBeLessThan(0.01);
    });

    it("offline boot: the uplink's step, TAI write and sync make one re-epoch", async () => {
        const { h, es } = await play('clockstate-offline-boot.jsonl', true);
        expect(decisions(h.epochs)).toEqual([
            [1, 'timeout', false],
            [2, 'step', true],
        ]);
        expect(h.epochs[0].eNs).toBe(es[0]);
        expect(deltaNs(h.epochs[1].eNs, es.at(-1)!)).toBeLessThan(10_000n);
        // The 18,521,000 s setback plus TAI−UTC 37 s; chrony's step fell 1.1 ms short.
        expect(Math.abs(dEms(h) - 18_521_037_000)).toBeLessThan(2);
    });
});

describe('HouseClock with a real ProcessManager and a crashing fake sidecar', () => {
    it('keeps E across sidecar crashes and restarts', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mr-clockstate-'));
        const runs = join(dir, 'runs');
        const bin = join(dir, 'mr-clockstate');
        // Prints one sample and dies non-zero, so ManagedProcess restarts it.
        writeFileSync(bin, `#!/bin/sh\necho run >> ${runs}\necho '${line()}'\nexit 1\n`);
        chmodSync(bin, 0o755);
        const pm = new ProcessManager();
        const clock = new HouseClock({
            processManager: pm,
            resolveBinary: () => bin,
            exec: async () => 'inactive\nactive\n',
            restartDelayMs: 20,
        });
        try {
            clock.start();
            const first = await clock.ready();
            expect(first).toMatchObject({ seq: 1, eNs: E0, source: 'ptp' });
            await vi.waitFor(
                () => expect(readFileSync(runs, 'utf8').split('\n').length).toBeGreaterThan(3),
                { timeout: 5000, interval: 20 },
            );
            expect(clock.epoch()).toMatchObject({ seq: 1, eNs: E0 });
        } finally {
            await clock.stop();
            await pm.killAll();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('HouseClock logging through a real ProcessManager', () => {
    it('samples reach the clock but not the log; the sidecar stderr still does', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mr-clockstate-'));
        const bin = join(dir, 'mr-clockstate');
        const warning = 'mr-clockstate: no timerfd step watch: test';
        writeFileSync(bin, `#!/bin/sh\necho '${line()}'\necho '${warning}' >&2\nexec sleep 60\n`);
        chmodSync(bin, 0o755);
        const pm = new ProcessManager();
        const spawn = vi.spyOn(pm, 'spawn');
        const clock = new HouseClock({
            processManager: pm,
            resolveBinary: () => bin,
            exec: async () => 'inactive\nactive\n',
        });
        try {
            clock.start();
            // The spawned process's own logger: what it writes is what the journal gets.
            const procLog = spawn.mock.results[0].value['log'];
            const debug = vi.spyOn(procLog, 'debug');
            const warn = vi.spyOn(procLog, 'warn');
            await expect(clock.ready()).resolves.toMatchObject({ seq: 1, eNs: E0 });
            await vi.waitFor(() =>
                expect(warn).toHaveBeenCalledWith({ stream: 'stderr' }, warning),
            );
            expect(debug).not.toHaveBeenCalled();
        } finally {
            await clock.stop();
            await pm.killAll();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
