import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HouseEpoch, TimeSyncState } from '@media-router/shared-types';
import { HouseClock, type HouseClockOptions } from './HouseClock.js';
import { ProcessManager } from '../child-process/ProcessManager.js';
import type { ManagedProcessOptions } from '../child-process/ManagedProcess.js';

const S = 1_000_000_000n;
const E0 = 1_789_775_770n * S;

function line(over: { eNs?: bigint; synced?: boolean; tai?: number } = {}): string {
    return JSON.stringify({
        type: 'sample',
        monoNs: '2103103813119540',
        eNs: String(over.eNs ?? E0),
        bracketNs: 80,
        synced: over.synced ?? true,
        taiOffsetS: over.tai ?? 37,
        estErrorUs: 1500,
        maxErrorUs: 9000,
        freqPpm: 3.5,
        status: 0x2001,
        leap: 'ok',
    });
}
const STEP = '{"type":"step","monoNs":"2103104000000000"}';

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
    const exec = vi.fn(async (cmd: string) => (cmd === 'systemctl' ? 'active\ninactive\n' : ''));
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

/** Let the first source poll settle (lines are held until it has). */
const settle = () => new Promise((r) => setImmediate(r));

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
        await settle();
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
        await settle();
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
        await settle();
        h.emit(line({ synced: false }));
        expect(h.clock.epoch()).toMatchObject({ seq: 1, eNs: E0, traceable: false });
        expect(h.clock.state()).toMatchObject({ synced: false, traceable: false });
    });

    it('a sidecar restart (same E, small jitter) never re-epochs', async () => {
        const h = fakeSidecar();
        clock = h.clock;
        h.clock.start();
        h.emit(line());
        await settle();
        // ManagedProcess restarts reuse the same onStdout: a fresh process, same clock.
        for (const j of [700n, -300n, 9_000n]) h.emit(line({ eNs: E0 + j }));
        expect(h.epochs).toHaveLength(1);
        expect(h.clock.epoch()!.eNs).toBe(E0);
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

    it('carries chrony tracking into the state when chrony owns the clock', async () => {
        const h = fakeSidecar({
            exec: async (cmd) =>
                cmd === 'systemctl'
                    ? 'active\ninactive\n'
                    : 'A29FC87B,ntp1.example.org,2,1791234567.123,0.000100,0.000020,0.000050,-3.479,0.001,0.010,0.004000,0.000500,64.2,Normal\n',
        });
        clock = h.clock;
        h.clock.start();
        await settle();
        expect(h.clock.state().chrony).toEqual({
            reference: 'ntp1.example.org',
            stratum: 2,
            estErrorUs: 2600,
            leap: 'Normal',
        });
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
