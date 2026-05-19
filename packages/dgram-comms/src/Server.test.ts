import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Server } from './Server.js';

describe('Server', () => {
    let server: Server;

    afterEach(async () => {
        try {
            await server?.stop();
        } catch {
            /* already closed */
        }
    });

    // ---- Construction ----

    it('creates with default options', () => {
        server = new Server();
        expect(server).toBeDefined();
        expect(server['port']).toBe(3000);
        expect(server['bindAddress']).toBe('0.0.0.0');
        expect(server['connectionTimeout']).toBe(5000);
        expect(server['missedKeepaliveThreshold']).toBe(3);
    });

    it('creates with custom options', () => {
        server = new Server({
            port: 4000,
            bindAddress: '127.0.0.1',
            encryptionKeys: { 'engine-1': 'secret' },
            connectionTimeout: 10000,
            missedKeepaliveThreshold: 5,
        });
        expect(server['port']).toBe(4000);
        expect(server['bindAddress']).toBe('127.0.0.1');
        expect(server['encryptionKeys']).toEqual({ 'engine-1': 'secret' });
        expect(server['connectionTimeout']).toBe(10000);
        expect(server['missedKeepaliveThreshold']).toBe(5);
    });

    it('copies encryption keys (does not share reference)', () => {
        const keys = { 'engine-1': 'pass1' };
        server = new Server({ encryptionKeys: keys });
        keys['engine-2'] = 'pass2';
        expect(server['encryptionKeys']).not.toHaveProperty('engine-2');
    });

    // ---- refreshEncryptionKeys ----

    it('refreshEncryptionKeys replaces all keys', () => {
        server = new Server({ encryptionKeys: { 'engine-1': 'old' } });
        server.refreshEncryptionKeys({ 'engine-2': 'new' });
        expect(server['encryptionKeys']).toEqual({ 'engine-2': 'new' });
        expect(server['encryptionKeys']).not.toHaveProperty('engine-1');
    });

    it('refreshEncryptionKeys copies keys (no shared reference)', () => {
        server = new Server();
        const newKeys = { 'engine-1': 'pass' };
        server.refreshEncryptionKeys(newKeys);
        newKeys['engine-2'] = 'extra';
        expect(server['encryptionKeys']).not.toHaveProperty('engine-2');
    });

    // ---- isClientOnline ----

    it('isClientOnline returns false for unknown client', () => {
        server = new Server();
        expect(server.isClientOnline('nonexistent')).toBe(false);
    });

    // ---- sendTo ----

    it('sendTo warns and returns for unknown client', () => {
        server = new Server();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        server.sendTo('missing', 'topic', { data: 1 });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('no socket for client missing'),
        );
        warnSpy.mockRestore();
    });

    // ---- broadcast ----

    it('broadcast sends to all connected sockets', () => {
        server = new Server();
        const mockSocket1 = { send: vi.fn() };
        const mockSocket2 = { send: vi.fn() };
        server['sockets'].set('s1', mockSocket1 as any);
        server['sockets'].set('s2', mockSocket2 as any);

        server.broadcast('config:update', { version: 2 });
        expect(mockSocket1.send).toHaveBeenCalledWith('config:update', { version: 2 }, {});
        expect(mockSocket2.send).toHaveBeenCalledWith('config:update', { version: 2 }, {});
    });

    it('broadcast passes guaranteeDelivery option', () => {
        server = new Server();
        const mockSocket = { send: vi.fn() };
        server['sockets'].set('s1', mockSocket as any);

        server.broadcast('important', 'data', { guaranteeDelivery: true });
        expect(mockSocket.send).toHaveBeenCalledWith('important', 'data', {
            guaranteeDelivery: true,
        });
    });

    it('broadcast is no-op with no connected sockets', () => {
        server = new Server();
        // Should not throw
        server.broadcast('topic', 'msg');
    });

    // ---- sendTo with socket ----

    it('sendTo sends to specific client socket', () => {
        server = new Server();
        const mockSocket = { send: vi.fn() };
        server['sockets'].set('sock-1', mockSocket as any);
        server['clientToSocket'].set('engine-1', 'sock-1');

        server.sendTo('engine-1', 'config', { key: 'val' });
        expect(mockSocket.send).toHaveBeenCalledWith('config', { key: 'val' }, {});
    });

    it('sendTo warns when socketID mapped but socket missing', () => {
        server = new Server();
        server['clientToSocket'].set('engine-1', 'orphan-sock');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        server.sendTo('engine-1', 'topic', 'data');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('socket orphan-sock not found'),
        );
        warnSpy.mockRestore();
    });

    // ---- isClientOnline with socket ----

    it('isClientOnline returns true when socket is connected', () => {
        server = new Server();
        const mockSocket = { connected: true };
        server['sockets'].set('sock-1', mockSocket as any);
        server['clientToSocket'].set('engine-1', 'sock-1');
        expect(server.isClientOnline('engine-1')).toBe(true);
    });

    it('isClientOnline returns false when socket exists but not connected', () => {
        server = new Server();
        const mockSocket = { connected: false };
        server['sockets'].set('sock-1', mockSocket as any);
        server['clientToSocket'].set('engine-1', 'sock-1');
        expect(server.isClientOnline('engine-1')).toBe(false);
    });

    // ---- handleConnect ----

    it('handleConnect rejects client without encryption key', () => {
        server = new Server({ encryptionKeys: {} });
        const spy = vi.fn();
        server.on('connection', spy);
        server['handleConnect'](
            'unknown-engine',
            {},
            { address: '1.2.3.4', port: 9999, family: 'IPv4', size: 0 },
        );
        expect(spy).not.toHaveBeenCalled();
        expect(server['sockets'].size).toBe(0);
    });

    it('handleConnect creates socket and emits connection for valid client', () => {
        server = new Server({ encryptionKeys: { 'engine-1': 'secret' } });
        const spy = vi.fn();
        server.on('connection', spy);
        server['handleConnect'](
            'engine-1',
            {},
            { address: '10.0.0.1', port: 5000, family: 'IPv4', size: 0 },
        );
        expect(spy).toHaveBeenCalledWith(expect.any(Object), 'engine-1');
        expect(server['sockets'].size).toBe(1);
        expect(server['clientToSocket'].has('engine-1')).toBe(true);
    });

    it('handleConnect replaces existing socket on reconnect', () => {
        server = new Server({ encryptionKeys: { 'engine-1': 'secret' } });

        // First connection
        server['handleConnect'](
            'engine-1',
            {},
            { address: '10.0.0.1', port: 5000, family: 'IPv4', size: 0 },
        );
        const firstSocketId = server['clientToSocket'].get('engine-1')!;
        expect(server['sockets'].has(firstSocketId)).toBe(true);

        // Reconnect — old socket should be replaced
        server['handleConnect'](
            'engine-1',
            {},
            { address: '10.0.0.1', port: 5001, family: 'IPv4', size: 0 },
        );
        const secondSocketId = server['clientToSocket'].get('engine-1')!;
        expect(secondSocketId).not.toBe(firstSocketId);
        expect(server['sockets'].has(firstSocketId)).toBe(false);
        expect(server['sockets'].size).toBe(1);
    });

    // ---- Disconnection tracking ----

    it('onDisconnect callback cleans up maps', () => {
        server = new Server({ encryptionKeys: { 'engine-1': 'secret' } });
        const disconnectSpy = vi.fn();
        server.on('disconnection', disconnectSpy);

        server['handleConnect'](
            'engine-1',
            {},
            { address: '10.0.0.1', port: 5000, family: 'IPv4', size: 0 },
        );
        const socketId = server['clientToSocket'].get('engine-1')!;
        const socket = server['sockets'].get(socketId)!;

        // Simulate disconnect
        socket.destroy();

        expect(server['sockets'].has(socketId)).toBe(false);
        expect(server['clientToSocket'].has('engine-1')).toBe(false);
        expect(disconnectSpy).toHaveBeenCalledWith('engine-1');
    });

    // ---- getSocketByDataSocketID ----

    it('getSocketByDataSocketID returns undefined for missing socketID', () => {
        server = new Server();
        expect(server['getSocketByDataSocketID'](undefined)).toBeUndefined();
        expect(server['getSocketByDataSocketID']('nonexistent')).toBeUndefined();
    });

    it('getSocketByDataSocketID returns socket when present', () => {
        server = new Server();
        const mockSocket = { send: vi.fn() };
        server['sockets'].set('sock-1', mockSocket as any);
        expect(server['getSocketByDataSocketID']('sock-1')).toBe(mockSocket);
    });

    // ---- Reject-log throttle ----

    it('claimRejectLog allows the first call and reports zero suppressed', () => {
        server = new Server();
        const claim = server['claimRejectLog']('stale-client');
        expect(claim).toEqual({ suppressed: 0 });
    });

    it('claimRejectLog suppresses repeated calls within the window', () => {
        server = new Server({ rejectLogIntervalMs: 30_000 });
        expect(server['claimRejectLog']('stale-client')).toEqual({ suppressed: 0 });
        for (let i = 0; i < 5; i++) {
            expect(server['claimRejectLog']('stale-client')).toBeNull();
        }
        // Internal state tracks the suppressed count
        expect(server['rejectLogState'].get('stale-client')?.suppressed).toBe(5);
    });

    it('claimRejectLog re-emits after the window with the suppressed count', () => {
        server = new Server({ rejectLogIntervalMs: 30_000 });
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-18T10:00:00Z'));
        expect(server['claimRejectLog']('stale-client')).toEqual({ suppressed: 0 });
        for (let i = 0; i < 7; i++) server['claimRejectLog']('stale-client');
        // Advance past the throttle window
        vi.setSystemTime(new Date('2026-05-18T10:00:31Z'));
        expect(server['claimRejectLog']('stale-client')).toEqual({ suppressed: 7 });
        // After the allowed log, the counter resets
        expect(server['rejectLogState'].get('stale-client')?.suppressed).toBe(0);
        vi.useRealTimers();
    });

    it('claimRejectLog tracks clients independently', () => {
        server = new Server({ rejectLogIntervalMs: 30_000 });
        expect(server['claimRejectLog']('client-a')).toEqual({ suppressed: 0 });
        expect(server['claimRejectLog']('client-b')).toEqual({ suppressed: 0 });
        expect(server['claimRejectLog']('client-a')).toBeNull();
        expect(server['claimRejectLog']('client-b')).toBeNull();
    });

    it('refreshEncryptionKeys clears throttle state for newly-registered clients', () => {
        server = new Server({ rejectLogIntervalMs: 30_000 });
        server['claimRejectLog']('engine-1');
        expect(server['rejectLogState'].has('engine-1')).toBe(true);
        server.refreshEncryptionKeys({ 'engine-1': 'secret' });
        expect(server['rejectLogState'].has('engine-1')).toBe(false);
    });

    it('refreshEncryptionKeys leaves throttle state for clients still unknown', () => {
        server = new Server({ rejectLogIntervalMs: 30_000 });
        server['claimRejectLog']('stale-client');
        server.refreshEncryptionKeys({ 'engine-1': 'secret' });
        expect(server['rejectLogState'].has('stale-client')).toBe(true);
    });

    // ---- stop ----

    it('stop clears all sockets and maps', async () => {
        server = new Server({ port: 0, encryptionKeys: { 'engine-1': 'secret' } });

        // Bind to random port first so stop() has something to close
        await new Promise<void>((resolve) => {
            server['udpSocket'].bind(0, '127.0.0.1', () => resolve());
        });

        server['handleConnect'](
            'engine-1',
            {},
            { address: '10.0.0.1', port: 5000, family: 'IPv4', size: 0 },
        );
        expect(server['sockets'].size).toBe(1);

        await server.stop();
        expect(server['sockets'].size).toBe(0);
        expect(server['clientToSocket'].size).toBe(0);
    });
});
