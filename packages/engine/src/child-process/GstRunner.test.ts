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
});
