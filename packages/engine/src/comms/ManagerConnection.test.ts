import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ManagerConnectionProfile } from '@media-router/shared-types';

// Track Client constructor calls and instances
let clientInstances: EventEmitter[] = [];
const mockDestroy = vi.fn();
const mockSend = vi.fn();

vi.mock('@media-router/dgram-comms', () => ({
    Client: vi.fn().mockImplementation(() => {
        const instance = new EventEmitter();
        (instance as any).destroy = mockDestroy;
        (instance as any).send = mockSend;
        clientInstances.push(instance);
        return instance;
    }),
}));

import { ManagerConnection } from './ManagerConnection.js';
import { Client as MockedClient } from '@media-router/dgram-comms';

const testProfile: ManagerConnectionProfile = {
    name: 'test-engine',
    paths: [{ host: '127.0.0.1', port: 3000 }],
    encryptionKey: 'secret',
};

describe('ManagerConnection', () => {
    let conn: ManagerConnection;

    beforeEach(() => {
        vi.useFakeTimers();
        clientInstances = [];
        (MockedClient as unknown as ReturnType<typeof vi.fn>).mockClear();
        mockDestroy.mockClear();
        mockSend.mockClear();
        conn = new ManagerConnection();
    });

    afterEach(() => {
        conn.disconnect();
        vi.useRealTimers();
    });

    // --- Basic state ---

    it('starts disconnected', () => {
        expect(conn.isConnected).toBe(false);
    });

    it('disconnect is safe to call when not connected', () => {
        expect(() => conn.disconnect()).not.toThrow();
    });

    it('send is safe when not connected (no client)', () => {
        expect(() => conn.send('test', { data: 1 })).not.toThrow();
    });

    it('sendState delegates to send', () => {
        const sendSpy = vi.spyOn(conn, 'send');
        conn.sendState({ 'mod-1': { health: 'ok' } });
        expect(sendSpy).toHaveBeenCalledWith(
            'state',
            { 'mod-1': { health: 'ok' } },
            undefined,
        );
    });

    it('sendState forwards guaranteeDelivery option', () => {
        const sendSpy = vi.spyOn(conn, 'send');
        conn.sendState({ 'mod-1': { health: 'ok' } }, { guaranteeDelivery: true });
        expect(sendSpy).toHaveBeenCalledWith(
            'state',
            { 'mod-1': { health: 'ok' } },
            { guaranteeDelivery: true },
        );
    });

    it('sendVu delegates to send with correct format', () => {
        const sendSpy = vi.spyOn(conn, 'send');
        conn.sendVu('audio-input-abc', [5, 5]);
        expect(sendSpy).toHaveBeenCalledWith('vu', {
            instanceId: 'audio-input-abc',
            vuData: [5, 5],
        });
    });

    it('emits events as EventEmitter', () => {
        const handler = vi.fn();
        conn.on('testEvent', handler);
        conn.emit('testEvent', 'payload');
        expect(handler).toHaveBeenCalledWith('payload');
    });

    it('multiple disconnect calls are safe', () => {
        conn.disconnect();
        conn.disconnect();
        conn.disconnect();
        expect(conn.isConnected).toBe(false);
    });

    // --- Connect lifecycle ---

    it('connect creates a dgram-comms Client', () => {
        conn.connect(testProfile);
        expect(MockedClient).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: 'test-engine',
                encryptionKey: 'secret',
            }),
        );
        expect(clientInstances).toHaveLength(1);
    });

    it('sets isConnected to true on connected event', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        expect(conn.isConnected).toBe(true);
    });

    it('emits connected event when client connects', () => {
        const spy = vi.fn();
        conn.on('connected', spy);
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        expect(spy).toHaveBeenCalled();
    });

    it('sets isConnected to false on disconnected event', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        expect(conn.isConnected).toBe(true);
        clientInstances[0].emit('disconnected');
        expect(conn.isConnected).toBe(false);
    });

    it('emits disconnected event when client disconnects', () => {
        const spy = vi.fn();
        conn.on('disconnected', spy);
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        clientInstances[0].emit('disconnected');
        expect(spy).toHaveBeenCalled();
    });

    it('forwards data events as topic-named events', () => {
        const spy = vi.fn();
        conn.on('config', spy);
        conn.connect(testProfile);
        clientInstances[0].emit('data', 'config', { modules: {} });
        expect(spy).toHaveBeenCalledWith({ modules: {} });
    });

    it('forwards command data events', () => {
        const spy = vi.fn();
        conn.on('command', spy);
        conn.connect(testProfile);
        clientInstances[0].emit('data', 'command', { action: 'restart' });
        expect(spy).toHaveBeenCalledWith({ action: 'restart' });
    });

    // --- send delegates to client ---

    it('send delegates to client.send when connected', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        conn.send('state', { data: 1 }, { guaranteeDelivery: true });
        expect(mockSend).toHaveBeenCalledWith('state', { data: 1 }, { guaranteeDelivery: true });
    });

    // --- Disconnect lifecycle ---

    it('disconnect destroys the client', () => {
        conn.connect(testProfile);
        conn.disconnect();
        expect(mockDestroy).toHaveBeenCalled();
        expect(conn.isConnected).toBe(false);
    });

    it('disconnect clears isConnected even if was connected', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        expect(conn.isConnected).toBe(true);
        conn.disconnect();
        expect(conn.isConnected).toBe(false);
    });

    it('disconnect emits "disconnected" when previously connected', () => {
        // Underlying Client.destroy() is silent — without an explicit emit
        // here, listeners that mirror connect-side resources on
        // 'connected'/'disconnected' would leak past intentional shutdown.
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        const spy = vi.fn();
        conn.on('disconnected', spy);
        conn.disconnect();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('disconnect does not emit "disconnected" if never connected', () => {
        const spy = vi.fn();
        conn.on('disconnected', spy);
        conn.disconnect();
        expect(spy).not.toHaveBeenCalled();
    });

    // --- Reconnection logic ---

    it('schedules reconnect on unintentional disconnect', () => {
        conn.connect(testProfile);
        const firstClient = clientInstances[0];
        firstClient.emit('connected');

        // Simulate unintentional disconnect
        firstClient.emit('disconnected');

        // Clear to track new client creation
        (MockedClient as unknown as ReturnType<typeof vi.fn>).mockClear();

        // Advance past backoff delay (base 3000ms)
        vi.advanceTimersByTime(3100);

        // Should have created a new client for reconnection
        expect(MockedClient).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect after intentional disconnect', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        conn.disconnect();

        (MockedClient as unknown as ReturnType<typeof vi.fn>).mockClear();

        // Advance well past any reconnect delay
        vi.advanceTimersByTime(60000);
        expect(MockedClient).not.toHaveBeenCalled();
    });

    it('connect timeout recreates client after 5s if not connected', () => {
        conn.connect(testProfile);
        expect(clientInstances).toHaveLength(1);

        // Advance 5s without triggering 'connected'
        vi.advanceTimersByTime(5100);

        // Should recreate client (original + timeout retry)
        expect(clientInstances.length).toBeGreaterThanOrEqual(2);
    });

    it('connect timeout does not fire if connected in time', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        const countAfterConnect = clientInstances.length;

        // Advance past 5s
        vi.advanceTimersByTime(5100);

        // Should NOT recreate — connected cleared the timeout
        expect(clientInstances).toHaveLength(countAfterConnect);
    });

    it('resets backoff on successful connection', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');

        // Disconnect unintentionally
        clientInstances[0].emit('disconnected');
        (MockedClient as unknown as ReturnType<typeof vi.fn>).mockClear();

        // Reconnect should happen at base delay (3000ms), not escalated
        vi.advanceTimersByTime(3100);
        expect(MockedClient).toHaveBeenCalledTimes(1);
    });

    it('destroys old client when reconnecting', () => {
        conn.connect(testProfile);
        mockDestroy.mockClear();

        // Connect again — should destroy old client first
        conn.connect(testProfile);
        expect(mockDestroy).toHaveBeenCalled();
    });

    it('backoff increases delay on repeated disconnects', () => {
        conn.connect(testProfile);
        clientInstances[0].emit('connected');
        clientInstances[0].emit('disconnected');

        // First reconnect at 3000ms
        vi.advanceTimersByTime(3100);
        const secondClient = clientInstances[clientInstances.length - 1];
        secondClient.emit('disconnected');

        (MockedClient as unknown as ReturnType<typeof vi.fn>).mockClear();

        // Second reconnect should be at 6000ms (exponential)
        vi.advanceTimersByTime(3100);
        expect(MockedClient).not.toHaveBeenCalled(); // Not yet — delay is longer

        vi.advanceTimersByTime(3100);
        expect(MockedClient).toHaveBeenCalled(); // Now at ~6200ms total
    });
});
