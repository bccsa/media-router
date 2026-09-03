import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner, SHUTDOWN_FLUSH_MS } from './GstRunner.js';
import { FORCE_KILL_TIMEOUT_MS } from './PythonProcess.js';

/**
 * Tests focus on the bus-error vs command-error split — see TodoNotes:
 * gst-runner used to treat every Python `error` event as fatal, so a
 * `setProperty` against a missing element name tore the live pipeline down.
 */
describe('GstRunner — Python event routing', () => {
    let runner: GstRunner;
    let sent: ControlIpcMessage[];
    let exitFn: ReturnType<typeof vi.fn>;

    const emit = (event: Record<string, unknown>): void => {
        (
            runner as unknown as { handlePythonEvent: (e: Record<string, unknown>) => void }
        ).handlePythonEvent(event);
    };

    const lastByType = (
        type: ControlIpcMessage['type'],
        action?: string,
    ): ControlIpcMessage | undefined =>
        [...sent].reverse().find((m) => m.type === type && (!action || m.action === action));

    beforeEach(() => {
        sent = [];
        exitFn = vi.fn();
        // The host seam: everything the runner says goes through `post`, and
        // `exit` is the only way it can end — never `process.*` (it shares the
        // engine process by default).
        runner = new GstRunner('/nonexistent/python-runner.py', {
            post: (msg) => {
                sent.push(msg);
            },
            exit: exitFn,
        });
        // Mark the runner as having a live pipeline so the IPC routing for
        // setProperty/getProperty matches the production path — we never
        // actually spawn Python (the optional chaining no-ops the sendCommand).
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects pending setProperty when Python emits command_error', () => {
        runner.handleControlMessage({
            id: 'rpc-1',
            type: 'request',
            action: 'setProperty',
            data: { element: 'nov', property: 'text', value: 'hi' },
        });

        // The most recent command sent to the (would-be) Python child carries
        // an id we need to echo back as command_error.
        // Since python is null, no command goes out — but trackPending was
        // called. Pull the registered req id off the pending map.
        const pending = (
            runner as unknown as {
                ipc: { pending: Map<string, { requestId: string }> };
            }
        ).ipc.pending;
        expect(pending.size).toBe(1);
        const [reqId] = [...pending.keys()];

        emit({ event: 'command_error', id: reqId, message: 'Element not found: nov' });

        const response = lastByType('response');
        expect(response?.id).toBe('rpc-1');
        expect(response?.data).toEqual({ error: 'Element not found: nov' });
    });

    it('does NOT schedule a restart on command_error', () => {
        vi.useFakeTimers();
        emit({ event: 'command_error', id: 'whatever', message: 'set_property failed' });
        // restartTimer would be set by scheduleRestart — verify it isn't.
        const timer = (runner as unknown as { restartTimer: unknown }).restartTimer;
        expect(timer).toBeNull();
        // No 'error' event relayed to parent either — that's reserved for
        // pipeline-lifecycle failures.
        expect(lastByType('event', 'error')).toBeUndefined();
    });

    it('DOES schedule a restart on pipeline error (unchanged behavior)', () => {
        vi.useFakeTimers();
        emit({ event: 'error', message: 'Bus ERROR: internal data stream error' });
        const timer = (runner as unknown as { restartTimer: unknown }).restartTimer;
        expect(timer).not.toBeNull();
        // And the error is propagated to the parent.
        const errEvent = lastByType('event', 'error');
        expect((errEvent?.data as { message: string }).message).toMatch(/internal data stream/);
    });

    it('forwards the `kind` discriminator on pipeline error events', () => {
        // udpsrc timeout, GstUDPSrcTimeout-derived events, etc. are tagged
        // `kind` in the Python runner so plugins can distinguish recoverable
        // source-silent conditions from hard bus errors. Verify the field
        // survives the GstRunner → parent IPC hop.
        emit({
            event: 'error',
            kind: 'udp_timeout',
            message: 'UDP source timeout (no data received)',
        });
        const errEvent = lastByType('event', 'error');
        expect((errEvent?.data as { kind?: string }).kind).toBe('udp_timeout');
    });

    it('forwards plugin_event verbatim as a pluginEvent (channel + payload)', () => {
        // stream:discovered / stream:names / level:<name> all ride this one
        // channel — the runner never grows a per-data-type case again.
        emit({
            event: 'plugin_event',
            channel: 'stream:discovered',
            payload: { from: 'demux', pid: 0x141, media: 'audio' },
        });
        const evt = lastByType('event', 'pluginEvent');
        expect(evt?.data).toEqual({
            channel: 'stream:discovered',
            payload: { from: 'demux', pid: 0x141, media: 'audio' },
        });
    });

    it('does NOT schedule a restart or surface an error for plugin_event (D6 report-only)', () => {
        vi.useFakeTimers();
        emit({ event: 'plugin_event', channel: 'stream:names', payload: { malformed: true } });
        expect((runner as unknown as { restartTimer: unknown }).restartTimer).toBeNull();
        expect(lastByType('event', 'error')).toBeUndefined();
    });

    it('accepts a setKlvPayload action without sending a stray response (fire-and-forget)', () => {
        expect(() =>
            runner.handleControlMessage({
                id: 'evt-1',
                type: 'event',
                action: 'setKlvPayload',
                data: { element: 'klvsrc', payload: '{"v":1,"streams":[]}' },
            }),
        ).not.toThrow();
        // No pipeline-lifecycle response/event should leak from a fire-and-forget.
        expect(lastByType('response')).toBeUndefined();
    });

    it('resolves getProperty pending RPC with the property value', () => {
        runner.handleControlMessage({
            id: 'rpc-2',
            type: 'request',
            action: 'getProperty',
            data: { element: 'src', property: 'uri' },
        });
        const pending = (
            runner as unknown as {
                ipc: { pending: Map<string, unknown> };
            }
        ).ipc.pending;
        const [reqId] = [...pending.keys()];

        emit({ event: 'property', id: reqId, element: 'src', property: 'uri', value: 'udp://...' });

        const response = lastByType('response');
        expect(response?.id).toBe('rpc-2');
        expect((response?.data as { value: string }).value).toBe('udp://...');
    });

    it('resolves setProperty pending RPC with property_set confirmation', () => {
        runner.handleControlMessage({
            id: 'rpc-3',
            type: 'request',
            action: 'setProperty',
            data: { element: 'vol', property: 'volume', value: 0.5 },
        });
        const pending = (
            runner as unknown as {
                ipc: { pending: Map<string, unknown> };
            }
        ).ipc.pending;
        const [reqId] = [...pending.keys()];

        emit({
            event: 'property_set',
            id: reqId,
            element: 'vol',
            property: 'volume',
            value: 0.5,
        });

        const response = lastByType('response');
        expect(response?.id).toBe('rpc-3');
        expect((response?.data as { event: string }).event).toBe('property_set');
    });

    it('resolves busReinput via the runner bus_reinput_done event (tracked RPC)', () => {
        runner.handleControlMessage({
            id: 'rpc-ri',
            type: 'request',
            action: 'busReinput',
            data: { element: 'netin', socket: '/tmp/mr-bus-40000-new.sock' },
        });
        const pending = (
            runner as unknown as {
                ipc: { pending: Map<string, unknown> };
            }
        ).ipc.pending;
        expect(pending.size).toBe(1);
        const [reqId] = [...pending.keys()];

        emit({ event: 'bus_reinput_done', id: reqId });

        const response = lastByType('response');
        expect(response?.id).toBe('rpc-ri');
    });

    it('busReinput failure surfaces as command_error (executor falls back to restart)', () => {
        runner.handleControlMessage({
            id: 'rpc-ri2',
            type: 'request',
            action: 'busReinput',
            data: { element: 'netin', socket: '/tmp/x.sock' },
        });
        const pending = (
            runner as unknown as {
                ipc: { pending: Map<string, unknown> };
            }
        ).ipc.pending;
        const [reqId] = [...pending.keys()];

        emit({ event: 'command_error', id: reqId, message: "element 'netin' not found" });

        const response = lastByType('response');
        expect(response?.id).toBe('rpc-ri2');
        expect(response?.data).toEqual({ error: "element 'netin' not found" });
    });

    it('updatePipeline replaces the replay description (post-swap crash-restarts use it)', () => {
        runner.handleControlMessage({
            id: 'rpc-up',
            type: 'request',
            action: 'updatePipeline',
            data: { pipeline: 'fakesrc ! fakesink', restartOnError: false },
        });
        expect(lastByType('response')?.id).toBe('rpc-up');
        expect((runner as unknown as { lastStart: { pipeline: string } }).lastStart.pipeline).toBe(
            'fakesrc ! fakesink',
        );
    });

    it('forwards the error source `element` on pipeline error events', () => {
        // Attribution from the gst bus message source — diagnostics and
        // per-element policies (e.g. a udpsrc timeout names its udpsrc).
        emit({
            event: 'error',
            message: 'Could not write to resource',
            element: 'unixfdsink3',
        });
        const errEvent = lastByType('event', 'error');
        expect((errEvent?.data as { element?: string }).element).toBe('unixfdsink3');
    });

    describe('indefinite unixfd socket gate', () => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const gatedStart = (id: string, socket: string) =>
            runner.handleControlMessage({
                id,
                type: 'request',
                action: 'startPipeline',
                data: {
                    pipeline: `unixfdsrc socket-path=${socket} ! fakesink`,
                    restartOnError: false,
                },
            });
        const pythonOf = () => (runner as unknown as { python: unknown }).python;

        it('does not spawn python while the producer socket is absent, and reports busGate', async () => {
            gatedStart('rpc-g1', `/tmp/gate-gr-${process.pid}-a.sock`);
            // The start request is ACKed immediately (gate runs behind it)…
            expect(lastByType('response')?.id).toBe('rpc-g1');
            // …but python must NOT be spawned while gated: waiting is free,
            // spawning into a guaranteed unixfdsrc connect failure is the
            // respawn storm the indefinite gate exists to prevent.
            await sleep(400);
            expect(pythonOf()).toBeNull();
            // Operator visibility: the pending socket is reported upward.
            const gate = lastByType('event', 'busGate');
            expect((gate?.data as { pending: string[] }).pending).toEqual([
                `/tmp/gate-gr-${process.pid}-a.sock`,
            ]);
        });

        it('stopPipeline during the gate cancels it — python never spawns', async () => {
            gatedStart('rpc-g2', `/tmp/gate-gr-${process.pid}-b.sock`);
            await sleep(50);
            runner.handleControlMessage({
                id: 'rpc-g3',
                type: 'request',
                action: 'stopPipeline',
                data: {},
            });
            // Even if the producer socket appeared now, the aborted gate
            // must not launch a pipeline for the stopped epoch.
            const { createServer } = await import('node:net');
            const srv = createServer(() => {});
            await new Promise<void>((resolve) =>
                srv.listen(`/tmp/gate-gr-${process.pid}-b.sock`, () => resolve()),
            );
            await sleep(800);
            expect(pythonOf()).toBeNull();
            await new Promise((r) => srv.close(r));
            const { unlinkSync } = await import('node:fs');
            try {
                unlinkSync(`/tmp/gate-gr-${process.pid}-b.sock`);
            } catch {
                /* gone */
            }
        });

        it('shutdown during the gate cancels it too — in-process nothing else would', async () => {
            // Under the fork the shim's process exit ended the probe loop; a
            // hosted runner's `shutdown` must bump the epoch itself, or the
            // loop launches a Python for a module the engine already stopped.
            gatedStart('rpc-g6', `/tmp/gate-gr-${process.pid}-e.sock`);
            await sleep(50);
            runner.shutdown('module stop');
            const { createServer } = await import('node:net');
            const srv = createServer(() => {});
            await new Promise<void>((resolve) =>
                srv.listen(`/tmp/gate-gr-${process.pid}-e.sock`, () => resolve()),
            );
            await sleep(800);
            expect(pythonOf()).toBeNull();
            await new Promise((r) => srv.close(r));
            const { unlinkSync } = await import('node:fs');
            try {
                unlinkSync(`/tmp/gate-gr-${process.pid}-e.sock`);
            } catch {
                /* gone */
            }
        });

        it('a newer start supersedes an in-flight gate (no launch for the old epoch)', async () => {
            gatedStart('rpc-g4', `/tmp/gate-gr-${process.pid}-c.sock`);
            await sleep(50);
            // Second gated start on a different (also absent) socket bumps the
            // epoch; satisfying the FIRST socket afterwards must not launch.
            gatedStart('rpc-g5', `/tmp/gate-gr-${process.pid}-d.sock`);
            const { createServer } = await import('node:net');
            const srv = createServer(() => {});
            await new Promise<void>((resolve) =>
                srv.listen(`/tmp/gate-gr-${process.pid}-c.sock`, () => resolve()),
            );
            await sleep(800);
            expect(pythonOf()).toBeNull(); // still gated on the SECOND socket
            await new Promise((r) => srv.close(r));
            const { unlinkSync } = await import('node:fs');
            try {
                unlinkSync(`/tmp/gate-gr-${process.pid}-c.sock`);
            } catch {
                /* gone */
            }
        });
    });
});

/**
 * Teardown LATENCY contract.
 *
 * The kill windows (`SHUTDOWN_EXIT_MS`, `STOP_PIPELINE_EXIT_MS`) are a DEADLINE
 * for the Python EOS drain — the point past which a drain that cannot finish is
 * abandoned — not a period the runner owes anybody. It used to sit out the whole
 * window regardless, so `GstChildProcess.stop()` (which waits for this process
 * to exit) took a flat ~8.5 s per teardown even when Python had already quit.
 * Measured 8516 ms to stop a `videotestsrc ! fakesink` pipeline whose Python
 * exited in ~100 ms; the video player pays that per rebuild, and an upstream
 * h265→h264 flip needs three rebuilds — which is the ~30 s field recovery on
 * the Pi 400, 2026-08-05.
 *
 * Both halves are pinned here: exit promptly once the drain is provably over,
 * and DON'T when it isn't (the mid-decode teardown that wedges the Pi's
 * stateless HEVC block — see eosDrainContract.test.ts).
 */
describe('GstRunner — teardown exits as soon as Python is gone', () => {
    // Derived, never re-typed: SHUTDOWN_EXIT_MS / STOP_PIPELINE_EXIT_MS are
    // themselves derived from the Python force-kill window.
    const SHUTDOWN_EXIT_MS = FORCE_KILL_TIMEOUT_MS + 500;
    const STOP_PIPELINE_EXIT_MS = FORCE_KILL_TIMEOUT_MS + 1000;

    let runner: GstRunner;
    let exitSpy: ReturnType<typeof vi.fn>;

    /** Stand-in for the Python child — shutdown/stop only reach these. */
    const fakePython = () => ({
        sendCommand: vi.fn(),
        kill: vi.fn(),
        stop: vi.fn(),
        emergencyKill: vi.fn(),
    });
    type FakePython = ReturnType<typeof fakePython>;
    const setPython = (py: FakePython): void => {
        (runner as unknown as { python: unknown }).python = py;
    };
    /** The real exit path: `PythonProcess`'s onExit → `handlePythonExit`. */
    const exitPython = (py: FakePython, code: number | null, signal: string | null = null): void =>
        (
            runner as unknown as {
                handlePythonExit: (p: unknown, c: number | null, s: unknown) => void;
            }
        ).handlePythonExit(py, code, signal);

    beforeEach(() => {
        vi.useFakeTimers();
        exitSpy = vi.fn();
        runner = new GstRunner('/nonexistent/python-runner.py', {
            post: () => {},
            exit: exitSpy,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('exits on the flush window when there is no Python left to drain', () => {
        // The field shape: the bus-error handler already tore the pipeline down
        // and quit, so by the time the module asks us to stop there is nothing
        // in flight — every millisecond after that is recovery latency.
        runner.shutdown('SIGTERM');
        vi.advanceTimersByTime(SHUTDOWN_FLUSH_MS - 1);
        expect(exitSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('waits for a LIVE Python child to finish its drain, then goes', () => {
        const py = fakePython();
        setPython(py);
        runner.shutdown('SIGTERM');
        // Mid-drain: exiting here would trip the process-exit emergency SIGKILL
        // on a decoder that is still finishing frames.
        vi.advanceTimersByTime(4000);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(py.sendCommand).toHaveBeenCalledWith({ cmd: 'stop' });
        expect(py.kill).toHaveBeenCalledWith('SIGTERM');
        // Drain done — Python exited of its own accord.
        exitPython(py, 0);
        vi.advanceTimersByTime(SHUTDOWN_FLUSH_MS);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps the deadline as the cap when Python never exits', () => {
        const py = fakePython();
        setPython(py);
        runner.shutdown('SIGTERM');
        vi.advanceTimersByTime(SHUTDOWN_EXIT_MS - 1);
        expect(exitSpy).not.toHaveBeenCalled();
        // The drain got its full window and then the SIGKILL, in that order.
        expect(py.kill).toHaveBeenCalledWith('SIGKILL');
        vi.advanceTimersByTime(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    const stopPipeline = (): void =>
        runner.handleControlMessage({ id: 'rpc-s1', type: 'request', action: 'stopPipeline' });

    it('stopPipeline takes the same short exit when nothing is draining', () => {
        stopPipeline();
        vi.advanceTimersByTime(SHUTDOWN_FLUSH_MS - 1);
        expect(exitSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('stopPipeline keeps its own cap for a Python that will not exit', () => {
        const py = fakePython();
        setPython(py);
        stopPipeline();
        expect(py.stop).toHaveBeenCalled();
        vi.advanceTimersByTime(STOP_PIPELINE_EXIT_MS - 1);
        expect(exitSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('a Python exit OUTSIDE a teardown never exits the runner', () => {
        // A crashed decoder must still be recovered by the restart loop — the
        // early exit is for deliberate teardowns only, which is what `exiting`
        // proves. Exiting here would kill the pipeline's only recovery path.
        const py = fakePython();
        setPython(py);
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
        exitPython(py, 139, 'SIGSEGV');
        expect((runner as unknown as { handback: { isArmed: boolean } }).handback.isArmed).toBe(false);
        expect((runner as unknown as { restartTimer: unknown }).restartTimer).not.toBeNull();
        // Short of the minimum restart delay (1000 ms base, 0.75 jitter floor)
        // so no respawn is attempted inside the test.
        vi.advanceTimersByTime(700);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('a CLEAN Python exit outside a teardown is restarted too (gate01 wedge)', () => {
        // The field shape (gate01, 2026-07-18): the replacement Python found
        // nothing to serve after its predecessor SIGSEGVed and exited 0. Read
        // as "intentional", the runner sat with no Python forever and every
        // downstream consumer gated on a socket that would never come back.
        // Only `exiting` (a real teardown) makes an exit intentional.
        const py = fakePython();
        setPython(py);
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
        exitPython(py, 0);
        expect((runner as unknown as { restartTimer: unknown }).restartTimer).not.toBeNull();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it('a clean exit that FOLLOWS a reported bus error posts no second error', () => {
        // Python exits 0 after every bus error / EOS it reports itself; the
        // restart is already scheduled and the real message already in module
        // health. A generic "exited unexpectedly" on top overwrote it.
        const py = fakePython();
        setPython(py);
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
        const posted: string[] = [];
        (runner as unknown as { host: { post: (m: { action: string }) => void } }).host.post = (
            m,
        ) => {
            posted.push(m.action);
        };
        (
            runner as unknown as { handlePythonEvent: (e: Record<string, unknown>) => void }
        ).handlePythonEvent({ event: 'error', message: 'Bus ERROR: not-linked' });
        expect(posted.filter((a) => a === 'error')).toHaveLength(1);
        exitPython(py, 0);
        expect(posted.filter((a) => a === 'error')).toHaveLength(1);
        expect((runner as unknown as { restartTimer: unknown }).restartTimer).not.toBeNull();
    });

    it('a retiring Python’s exit during a gated restart neither errors nor bumps the backoff', () => {
        // A newer start told the old Python to stop and is now gated on its
        // producer; the old one's clean exit must not be read as the NEW
        // pipeline dying (which re-entered startPipeline and abandoned the
        // live gate wait).
        const old = fakePython();
        setPython(old);
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
        runner.handleControlMessage({
            id: 'rpc-g',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: `unixfdsrc socket-path=/tmp/gate-${process.pid}-retire.sock ! fakesink` },
        });
        expect(old.stop).toHaveBeenCalled();
        expect((runner as unknown as { python: unknown }).python).toBeNull();
        // While it drains, an engine exit still reaches it…
        runner.emergencyKill();
        expect(old.emergencyKill).toHaveBeenCalled();
        // …and its exit is expected: no error, no backoff, the gate wait lives on.
        exitPython(old, 0);
        expect((runner as unknown as { restartTimer: unknown }).restartTimer).toBeNull();
        expect(exitSpy).not.toHaveBeenCalled();
        runner.shutdown('test'); // cancel the gate wait
    });

    it('exits its host exactly once, whichever deadline fires first', () => {
        // stop() sends stopPipeline AND shutdown (the fork's SIGTERM nudge):
        // two deadlines, one host exit — and no timer left behind to fire into
        // a host that has already let go of the runner.
        const py = fakePython();
        setPython(py);
        stopPipeline();
        runner.shutdown('module stop');
        vi.advanceTimersByTime(STOP_PIPELINE_EXIT_MS + SHUTDOWN_EXIT_MS);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a Python that drains in time leaves no SIGKILL timer behind', () => {
        const py = fakePython();
        setPython(py);
        runner.shutdown('module stop');
        exitPython(py, 0);
        vi.advanceTimersByTime(SHUTDOWN_FLUSH_MS);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(py.kill).not.toHaveBeenCalledWith('SIGKILL');
        expect(vi.getTimerCount()).toBe(0);
    });
});
