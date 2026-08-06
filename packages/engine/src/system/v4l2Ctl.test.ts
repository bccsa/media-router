import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { runV4l2Ctl, v4l2CtlBlocked, _resetV4l2CtlGuardForTests } from './v4l2Ctl.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface Spawn {
    child: EventEmitter;
    cb: ExecCallback;
}

describe('runV4l2Ctl', () => {
    let spawns: Spawn[];

    beforeEach(() => {
        spawns = [];
        execFileMock.mockReset();
        execFileMock.mockImplementation(
            (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
                const child = new EventEmitter();
                spawns.push({ child, cb });
                return child;
            },
        );
        _resetV4l2CtlGuardForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves ok with stdout when the child exits 0', async () => {
        const promise = runV4l2Ctl(['--list-devices'], 5000);
        spawns[0].child.emit('exit', 0, null);
        spawns[0].cb(null, 'output', '');
        await expect(promise).resolves.toEqual({ kind: 'ok', stdout: 'output' });
        expect(v4l2CtlBlocked()).toBe(false);
    });

    it('resolves failed when the child errors', async () => {
        const promise = runV4l2Ctl(['--list-devices'], 5000);
        spawns[0].child.emit('exit', 1, null);
        spawns[0].cb(new Error('exit 1'), '', '');
        await expect(promise).resolves.toEqual({ kind: 'failed' });
        expect(v4l2CtlBlocked()).toBe(false);
    });

    it('reports blocked without spawning while an earlier child has not exited', async () => {
        const promise = runV4l2Ctl(['--list-devices'], 5000);
        spawns[0].cb(new Error('ETIMEDOUT'), '', ''); // killed, still in D-state
        await expect(promise).resolves.toEqual({ kind: 'failed' });

        await expect(runV4l2Ctl(['--list-devices'], 5000)).resolves.toEqual({ kind: 'blocked' });
        expect(spawns).toHaveLength(1);

        // Released by the eventual exit, whichever event Node delivers first.
        spawns[0].child.emit('close', 137, 'SIGKILL');
        expect(v4l2CtlBlocked()).toBe(false);
        void runV4l2Ctl(['--list-devices'], 5000);
        expect(spawns).toHaveLength(2);
    });

    it('releases the guard on a spawn error', async () => {
        const promise = runV4l2Ctl(['--list-devices'], 5000);
        spawns[0].child.emit('error', new Error('EAGAIN'));
        spawns[0].cb(new Error('EAGAIN'), '', '');
        await expect(promise).resolves.toEqual({ kind: 'failed' });
        expect(v4l2CtlBlocked()).toBe(false);
    });

    it('settles as failed past the kill timeout even if the callback never fires', async () => {
        vi.useFakeTimers();
        const promise = runV4l2Ctl(['--list-devices'], 5000);
        await vi.advanceTimersByTimeAsync(6000);
        await expect(promise).resolves.toEqual({ kind: 'failed' });
        // The child is still unaccounted for, so the guard stays engaged.
        expect(v4l2CtlBlocked()).toBe(true);
    });
});
