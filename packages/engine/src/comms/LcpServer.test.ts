import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { io as IOClient, type Socket as ClientSocket } from 'socket.io-client';
import { LcpServer } from './LcpServer.js';

/**
 * Integration tests for LcpServer ↔ LCP client communication.
 * Uses a random high port to avoid conflicts.
 */

function waitForEvent(socket: ClientSocket, event: string, timeout = 2000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeout);
        socket.once(event, (data: unknown) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

// Use random port to avoid conflicts
const TEST_PORT = 18081 + Math.floor(Math.random() * 1000);

describe('LcpServer', () => {
    let lcpServer: LcpServer;
    let client: ClientSocket;

    beforeEach(async () => {
        lcpServer = new LcpServer(TEST_PORT);
        await lcpServer.start();

        client = IOClient(`http://localhost:${TEST_PORT}`, {
            transports: ['websocket'],
            reconnection: false,
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Client connect timeout')), 3000);
            client.on('connect', () => { clearTimeout(timer); resolve(); });
        });
    });

    afterEach(async () => {
        client.disconnect();
        await lcpServer.stop();
    });

    it('broadcasts configUpdate to connected clients', async () => {
        const patch = [{ op: 'replace', path: '/modules/mic-1/settings/audioEnabled', value: false }];
        const promise = waitForEvent(client, 'configUpdate');
        lcpServer.broadcastConfigUpdate(patch);
        const received = await promise;
        expect(received).toEqual(patch);
    });

    it('broadcasts VU data to connected clients', async () => {
        const promise = waitForEvent(client, 'vuData');
        lcpServer.broadcastVuData('mic-1', [5, 5]);
        const received = await promise;
        expect(received).toEqual({ instanceId: 'mic-1', vuData: [5, 5] });
    });

    it('broadcasts module state changes', async () => {
        const state = { running: true, health: 'ok', ready: true };
        const promise = waitForEvent(client, 'moduleState');
        lcpServer.broadcastState('mic-1', state);
        const received = await promise;
        expect(received).toEqual({ instanceId: 'mic-1', state });
    });

    it('broadcasts engine running state', async () => {
        const promise = waitForEvent(client, 'engineRunning');
        lcpServer.broadcastEngineRunning(true);
        const received = await promise;
        expect(received).toBe(true);
    });

    it('sends init data on connect', async () => {
        const mockInitData = {
            engineRunning: true,
            config: { modules: { 'mic-1': { displayName: 'Mic 1', health: 'ok' } } },
        };
        lcpServer._getInitData = () => mockInitData;

        // Connect a new client — should receive combined init event
        const client2 = IOClient(`http://localhost:${TEST_PORT}`, {
            transports: ['websocket'],
            reconnection: false,
        });
        const received = await waitForEvent(client2, 'init');
        expect(received).toEqual(mockInitData);
        client2.disconnect();
    });

    it('forwards patch from LCP with socket ID', async () => {
        const patchPromise = new Promise<unknown>((resolve) => {
            lcpServer.on('patch', resolve);
        });
        client.emit('patch', { ops: [{ op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 }] });
        const received = await patchPromise;
        const d = received as { ops: unknown[]; _socketId: string };
        expect(d.ops).toHaveLength(1);
        expect(d._socketId).toBeTruthy();
    });

    it('multiple clients all receive broadcasts', async () => {
        const client2 = IOClient(`http://localhost:${TEST_PORT}`, {
            transports: ['websocket'],
            reconnection: false,
        });
        await new Promise<void>((resolve) => client2.on('connect', resolve));

        const patch = [{ op: 'replace', path: '/modules/mic-1/settings/volume', value: 50 }];
        const p1 = waitForEvent(client, 'configUpdate');
        const p2 = waitForEvent(client2, 'configUpdate');
        lcpServer.broadcastConfigUpdate(patch);

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toEqual(patch);
        expect(r2).toEqual(patch);
        client2.disconnect();
    });

    it('broadcastConfigUpdateExcept skips the excluded socket', async () => {
        const client2 = IOClient(`http://localhost:${TEST_PORT}`, {
            transports: ['websocket'],
            reconnection: false,
        });
        await new Promise<void>((resolve) => client2.on('connect', resolve));

        const patch = [{ op: 'replace', path: '/modules/mic-1/settings/audioEnabled', value: false }];

        // Client 1 should NOT receive (excluded), client 2 should receive
        let client1Received = false;
        client.once('configUpdate', () => { client1Received = true; });

        const p2 = waitForEvent(client2, 'configUpdate');
        lcpServer.broadcastConfigUpdateExcept(client.id!, patch);

        const received = await p2;
        expect(received).toEqual(patch);

        // Give client1 a moment to potentially receive (it shouldn't)
        await new Promise((r) => setTimeout(r, 100));
        expect(client1Received).toBe(false);

        client2.disconnect();
    });

    it('forwards start/stop lifecycle commands', async () => {
        const controlPromise = new Promise<unknown>((resolve) => {
            lcpServer.on('control', resolve);
        });
        client.emit('start');
        const received = await controlPromise;
        expect(received).toEqual({ action: 'start' });
    });

    it('forwards stop lifecycle command', async () => {
        const controlPromise = new Promise<unknown>((resolve) => {
            lcpServer.on('control', resolve);
        });
        client.emit('stop');
        const received = await controlPromise;
        expect(received).toEqual({ action: 'stop' });
    });

    it('ignores patch with empty ops array', async () => {
        const patchHandler = vi.fn();
        lcpServer.on('patch', patchHandler);
        client.emit('patch', { ops: [] });
        await new Promise((r) => setTimeout(r, 100));
        expect(patchHandler).not.toHaveBeenCalled();
    });

    it('ignores patch with missing ops', async () => {
        const patchHandler = vi.fn();
        lcpServer.on('patch', patchHandler);
        client.emit('patch', {});
        await new Promise((r) => setTimeout(r, 100));
        expect(patchHandler).not.toHaveBeenCalled();
    });

    it('broadcastAllStates sends all states to clients', async () => {
        const states = {
            'mic-1': { running: true, health: 'ok', ready: true },
            'spk-1': { running: false, health: 'ok', ready: false },
        };
        const promise = waitForEvent(client, 'allStates');
        lcpServer.broadcastAllStates(states);
        const received = await promise;
        expect(received).toEqual(states);
    });

    it('sendInitialState broadcasts allStates', async () => {
        const states = { 'mic-1': { running: true, health: 'ok', ready: true } };
        const promise = waitForEvent(client, 'allStates');
        lcpServer.sendInitialState(states);
        const received = await promise;
        expect(received).toEqual(states);
    });

    it('broadcastEngineRunning tracks internal state', () => {
        lcpServer.broadcastEngineRunning(true);
        expect(lcpServer._engineRunning).toBe(true);
        lcpServer.broadcastEngineRunning(false);
        expect(lcpServer._engineRunning).toBe(false);
    });

    it('sendConfigToSocket sends config to a specific socket', async () => {
        const config = { modules: { 'mic-1': { pluginId: 'audio-input' } } };
        const promise = waitForEvent(client, 'config');
        lcpServer.sendConfigToSocket(client.id!, config);
        const received = await promise;
        expect(received).toEqual(config);
    });

    it('does not send init data when _getInitData is null', async () => {
        lcpServer._getInitData = null;
        const client2 = IOClient(`http://localhost:${TEST_PORT}`, {
            transports: ['websocket'],
            reconnection: false,
        });
        let received = false;
        client2.on('init', () => { received = true; });
        await new Promise<void>((resolve) => client2.on('connect', resolve));
        await new Promise((r) => setTimeout(r, 100));
        expect(received).toBe(false);
        client2.disconnect();
    });

    it('serves static files via HTTP when static dir exists', async () => {
        // The test environment has local-panel/dist built, so this should serve index.html
        const response = await fetch(`http://localhost:${TEST_PORT}/`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
    });
});
