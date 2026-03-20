import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ManagerConnection } from './ManagerConnection.js';

// We can't easily mock the Client constructor since it's imported by ManagerConnection.
// Instead, test the public API behavior without actually connecting.

describe('ManagerConnection', () => {
    let conn: ManagerConnection;

    beforeEach(() => {
        vi.useFakeTimers();
        conn = new ManagerConnection();
    });

    afterEach(() => {
        conn.disconnect();
        vi.useRealTimers();
    });

    it('starts disconnected', () => {
        expect(conn.isConnected).toBe(false);
    });

    it('disconnect is safe to call when not connected', () => {
        expect(() => conn.disconnect()).not.toThrow();
    });

    it('disconnect prevents auto-reconnect', () => {
        conn.disconnect();
        // isConnected should remain false
        expect(conn.isConnected).toBe(false);
    });

    it('send is safe when not connected (no client)', () => {
        expect(() => conn.send('test', { data: 1 })).not.toThrow();
    });

    it('sendState delegates to send', () => {
        const sendSpy = vi.spyOn(conn, 'send');
        conn.sendState({ 'mod-1': { health: 'ok' } });
        expect(sendSpy).toHaveBeenCalledWith('state', { 'mod-1': { health: 'ok' } });
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
});
