import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `InProcessRunnerHost` hosts a `GstRunner` inside the engine (ADR-0012):
 * the runner's outbound `post` is a method call into the host, its `exit` is
 * the host being handed the runner back, and every fault stays inside the one
 * request or event that hit it. The Python child is faked — what is under
 * test is the host/runner seam, not GStreamer.
 */
vi.mock('./PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./PythonProcess.js')>()),
    PythonProcess: (await import('./testing/FakePythonProcess.js')).FakePythonProcess,
}));
import { FakePythonProcess } from './testing/FakePythonProcess.js';
import { InProcessRunnerHost } from './InProcessRunnerHost.js';
import { SHUTDOWN_FLUSH_MS } from './GstRunner.js';
import { FORCE_KILL_TIMEOUT_MS } from './PythonProcess.js';

const python = () => FakePythonProcess.last();

describe('InProcessRunnerHost', () => {
    let host: InProcessRunnerHost;

    beforeEach(() => {
        vi.useFakeTimers();
        FakePythonProcess.reset();
        host = new InProcessRunnerHost('/nonexistent/python-runner.py');
    });

    afterEach(() => {
        host.destroy();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it('a startPipeline request resolves on the runner’s synchronous response and spawns Python', async () => {
        const res = await host.sendRequest('startPipeline', {
            pipeline: 'fakesrc ! fakesink',
            restartOnError: true,
        });
        expect(res).toEqual({ ok: true });
        expect(FakePythonProcess.spawned).toHaveLength(1);
        expect(python().commands[0]).toEqual({ cmd: 'start' });
        expect(host.pid).toBe(python().pid);
    });

    it('routes the runner’s events to the registered handler', async () => {
        const stateChange = vi.fn();
        host.on('stateChange', stateChange);
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        python().options.onEvent({ event: 'state_change', state: 'playing' });
        expect(stateChange).toHaveBeenCalledWith({ state: 'playing' });
    });

    it('stop() hands the runner back as soon as Python is gone', async () => {
        const onExit = vi.fn();
        host.onExit(onExit);
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        const py = python();
        const stopping = host.stop(9000);
        await vi.advanceTimersByTimeAsync(0);
        expect(py.stop).toHaveBeenCalled(); // stopPipeline
        expect(py.kill).toHaveBeenCalledWith('SIGTERM'); // the shutdown nudge
        // Python drained and exited of its own accord.
        py.options.onExit(0, null);
        await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS);
        await stopping;
        expect(host.isExited).toBe(true);
        expect(onExit).toHaveBeenCalledWith(0);
        expect(py.emergencyKill).not.toHaveBeenCalled();
    });

    it('the runner’s own deadline SIGKILLs a Python that will not drain, then hands back', async () => {
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        const py = python();
        const stopping = host.stop(9000);
        await vi.advanceTimersByTimeAsync(FORCE_KILL_TIMEOUT_MS);
        expect(py.kill).toHaveBeenCalledWith('SIGKILL');
        expect(host.isExited).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        await stopping; // inside the host cap — the runner got there first
        expect(host.isExited).toBe(true);
        expect(py.emergencyKill).not.toHaveBeenCalled();
    });

    it('stop()’s cap is the backstop: emergency SIGKILL when the runner never hands back', async () => {
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        const py = python();
        // Freeze the runner's own deadlines so only the host cap can fire.
        vi.spyOn(host.runner, 'shutdown').mockImplementation(() => {});
        const onExit = vi.fn();
        host.onExit(onExit);
        const stopping = host.stop(100);
        await vi.advanceTimersByTimeAsync(100);
        await stopping;
        expect(py.emergencyKill).toHaveBeenCalledTimes(1);
        // …and the host still closes: the module gets its `exit`, nothing
        // keeps waiting on a runner that never came back.
        expect(host.isExited).toBe(true);
        expect(onExit).toHaveBeenCalledWith(null);
    });

    it('a throw inside the runner rejects only the request that caused it', async () => {
        vi.spyOn(host.runner, 'handleControlMessage').mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(host.sendRequest('getState')).rejects.toThrow('boom');
        // …and an event throw is logged, not raised.
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => host.sendEvent('busAttach', { tee: 't', socket: '/x' })).not.toThrow();
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it('a Python event handler throw is logged, never raised into the engine', async () => {
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        host.on('stateChange', () => {
            throw new Error('plugin handler bug');
        });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() =>
            python().options.onEvent({ event: 'state_change', state: 'playing' }),
        ).not.toThrow();
        expect(err).toHaveBeenCalledWith(
            expect.stringContaining('event handler threw (action=stateChange)'),
            expect.any(Error),
        );
        err.mockRestore();
    });

    it('destroy() on a live runner shuts it down rather than leaking it', async () => {
        await host.sendRequest('startPipeline', { pipeline: 'fakesrc ! fakesink' });
        const py = python();
        host.destroy();
        expect(py.commands.at(-1)).toEqual({ cmd: 'stop' });
        expect(py.kill).toHaveBeenCalledWith('SIGTERM');
        py.options.onExit(0, null);
        await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS);
        expect(host.isExited).toBe(true);
    });

    it('rejects pending requests and refuses new ones once the runner has exited', async () => {
        await host.sendRequest('stopPipeline');
        await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS);
        expect(host.isExited).toBe(true);
        await expect(host.sendRequest('getState')).rejects.toThrow('Runner exited');
    });
});
