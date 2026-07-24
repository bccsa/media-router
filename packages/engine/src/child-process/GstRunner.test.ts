import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner } from './GstRunner.js';

/**
 * Tests focus on the bus-error vs command-error split — see TodoNotes:
 * gst-runner used to treat every Python `error` event as fatal, so a
 * `setProperty` against a missing element name tore the live pipeline down.
 */
describe('GstRunner — Python event routing', () => {
    let runner: GstRunner;
    let sent: ControlIpcMessage[];
    let originalSend: typeof process.send;
    let originalConnected: PropertyDescriptor | undefined;

    const emit = (event: Record<string, unknown>): void => {
        (runner as unknown as { handlePythonEvent: (e: Record<string, unknown>) => void })
            .handlePythonEvent(event);
    };

    const lastByType = (
        type: ControlIpcMessage['type'],
        action?: string,
    ): ControlIpcMessage | undefined =>
        [...sent].reverse().find((m) => m.type === type && (!action || m.action === action));

    beforeEach(() => {
        sent = [];
        originalSend = process.send;
        originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');

        Object.defineProperty(process, 'connected', { value: true, configurable: true });
        process.send = ((msg: ControlIpcMessage) => {
            sent.push(msg);
            return true;
        }) as unknown as typeof process.send;

        runner = new GstRunner('/nonexistent/python-runner.py');
        // Mark the runner as having a live pipeline so the IPC routing for
        // setProperty/getProperty matches the production path — we never
        // actually spawn Python (the optional chaining no-ops the sendCommand).
        (runner as unknown as { restartOnError: boolean }).restartOnError = true;
    });

    afterEach(() => {
        vi.useRealTimers();
        if (originalConnected) {
            Object.defineProperty(process, 'connected', originalConnected);
        }
        process.send = originalSend;
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
        const pending = (runner as unknown as {
            ipc: { pending: Map<string, { requestId: string }> };
        }).ipc.pending;
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
        const pending = (runner as unknown as {
            ipc: { pending: Map<string, unknown> };
        }).ipc.pending;
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
        const pending = (runner as unknown as {
            ipc: { pending: Map<string, unknown> };
        }).ipc.pending;
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
        const pending = (runner as unknown as {
            ipc: { pending: Map<string, unknown> };
        }).ipc.pending;
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
        const pending = (runner as unknown as {
            ipc: { pending: Map<string, unknown> };
        }).ipc.pending;
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
        expect(
            (runner as unknown as { lastStart: { pipeline: string } }).lastStart.pipeline,
        ).toBe('fakesrc ! fakesink');
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
            const exitSpy = vi
                .spyOn(process, 'exit')
                .mockImplementation((() => undefined) as never);
            try {
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
            } finally {
                exitSpy.mockRestore();
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
