import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `GstChildProcess` with the default (in-process) backend: the module-facing
 * surface — start/stop/events/pid — is unchanged from the forked shim it
 * replaced, and the one recovery path (the runner's own restart loop) now
 * covers a clean Python exit as well (the gate01 wedge). Python is faked.
 */
vi.mock('./PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./PythonProcess.js')>()),
    PythonProcess: (await import('./testing/FakePythonProcess.js')).FakePythonProcess,
}));
import { FakePythonProcess } from './testing/FakePythonProcess.js';
import { GstChildProcess, useForkedRunner } from './GstChildProcess.js';
import { SHUTDOWN_FLUSH_MS } from './GstRunner.js';

const python = () => FakePythonProcess.last();

describe('GstChildProcess — in-process runner', () => {
    let child: GstChildProcess;

    beforeEach(() => {
        vi.useFakeTimers();
        FakePythonProcess.reset();
        delete process.env.MR_GST_RUNNER_FORK;
        child = new GstChildProcess('/nonexistent/gst-runner.js');
    });

    afterEach(async () => {
        // destroy() waits for the hosted runner to hand itself back — under
        // fake timers that needs the runner's own deadline to be driven.
        const destroying = child.destroy();
        await vi.advanceTimersByTimeAsync(20_000);
        await destroying;
        vi.useRealTimers();
    });

    it('defaults to hosting the runner; MR_GST_RUNNER_FORK=1 is the fork rollback', () => {
        expect(useForkedRunner()).toBe(false);
        process.env.MR_GST_RUNNER_FORK = '1';
        expect(useForkedRunner()).toBe(true);
        delete process.env.MR_GST_RUNNER_FORK;
    });

    it('start() spawns the module’s Python with no shim in between and reports its pid', async () => {
        await child.start({ pipeline: 'fakesrc ! fakesink' });
        expect(FakePythonProcess.spawned).toHaveLength(1);
        expect(python().commands[0]).toEqual({ cmd: 'start' });
        expect(child.pid).toBe(python().pid);
        expect(child.getStdin()).toBeNull();
    });

    it('relays runner events: playing → stateChange + isRunning, error with its kind', async () => {
        const state = vi.fn();
        const error = vi.fn();
        child.on('stateChange', state);
        child.on('error', error);
        await child.start({ pipeline: 'fakesrc ! fakesink' });
        python().options.onEvent({ event: 'state_change', state: 'playing' });
        await vi.advanceTimersByTimeAsync(0); // sticky-prop replay (empty) precedes the emit
        expect(state).toHaveBeenCalledWith({ state: 'playing' });
        expect(child.isRunning).toBe(true);
        python().options.onEvent({ event: 'error', kind: 'udp_timeout', message: 'silent' });
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ kind: 'udp_timeout' }));
        expect(child.isRunning).toBe(false);
    });

    it('stop() drains Python, resolves once it is gone, and emits exit 0', async () => {
        const exit = vi.fn();
        child.on('exit', exit);
        await child.start({ pipeline: 'fakesrc ! fakesink' });
        const py = python();
        const stopping = child.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(py.stop).toHaveBeenCalled(); // stopPipeline
        expect(py.kill).toHaveBeenCalledWith('SIGTERM'); // the shutdown nudge
        py.options.onExit(0, null);
        await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS);
        await stopping;
        expect(exit).toHaveBeenCalledWith(0);
        expect(child.isRunning).toBe(false);
        expect(child.pid).toBeUndefined();
        expect(py.emergencyKill).not.toHaveBeenCalled();
    });

    it('a Python that exits cleanly outside a teardown is respawned by the runner loop', async () => {
        await child.start({ pipeline: 'fakesrc ! fakesink', restartOnError: true });
        const first = python();
        const error = vi.fn();
        child.on('error', error);
        first.options.onExit(0, null);
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ kind: 'runner_exit' }));
        // Inner loop: 1 s base, 5 s cap — well inside 5 s a second Python is up.
        await vi.advanceTimersByTimeAsync(5000);
        expect(FakePythonProcess.spawned).toHaveLength(2);
        expect(python()).not.toBe(first);
    });

    it('refuses the data-pipe mode in-process instead of wiring the engine’s stdio into a pipeline', async () => {
        const error = vi.fn();
        child.on('error', error);
        await child.start({ pipeline: 'fakesrc ! fakesink', useStdioForData: true });
        expect(FakePythonProcess.spawned).toHaveLength(0);
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'spawn_failed', message: expect.stringContaining('MR_GST_RUNNER_FORK') }),
        );
    });

    it('a second start() lets go of the first runner by shutting it down, never by leaking it', async () => {
        await child.start({ pipeline: 'fakesrc ! fakesink' });
        const first = python();
        await child.start({ pipeline: 'fakesrc ! fakesink' });
        expect(first.commands.at(-1)).toEqual({ cmd: 'stop' });
        expect(FakePythonProcess.spawned).toHaveLength(2);
        expect(child.pid).toBe(python().pid);
    });
});
