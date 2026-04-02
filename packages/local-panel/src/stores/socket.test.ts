import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Stub window.location for Node environment
if (typeof window === 'undefined') {
    (globalThis as any).window = { location: { origin: 'http://localhost:8081' } };
} else if (!window.location) {
    (window as any).location = { origin: 'http://localhost:8081' };
}

// Mock socket.io-client
const mockSocket = {
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
};

vi.mock('socket.io-client', () => ({
    io: vi.fn(() => mockSocket),
}));

import { useSocketStore } from './socket';
import { useModuleStore } from './modules';
import { useVuStore } from './vuMeters';
import { io } from 'socket.io-client';

/** Helper to get the handler registered for a given socket event. */
function getHandler(event: string): (...args: unknown[]) => void {
    const call = mockSocket.on.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`No handler registered for event: ${event}`);
    return call[1];
}

describe('Socket Store', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    it('starts disconnected', () => {
        const store = useSocketStore();
        expect(store.connected).toBe(false);
    });

    it('creates a socket on connect()', () => {
        const store = useSocketStore();
        store.connect();
        expect(io).toHaveBeenCalledWith(window.location.origin, expect.objectContaining({
            reconnection: true,
            reconnectionDelay: 1000,
        }));
    });

    it('does not create duplicate sockets on repeated connect()', () => {
        const store = useSocketStore();
        store.connect();
        store.connect();
        expect(io).toHaveBeenCalledTimes(1);
    });

    it('sets connected=true on connect event', () => {
        const store = useSocketStore();
        store.connect();
        getHandler('connect')();
        expect(store.connected).toBe(true);
    });

    it('sets connected=false on disconnect event', () => {
        const store = useSocketStore();
        store.connect();
        getHandler('connect')();
        expect(store.connected).toBe(true);
        getHandler('disconnect')();
        expect(store.connected).toBe(false);
    });

    it('handles init event — sets engineRunning and applies config', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        socketStore.connect();

        getHandler('init')({
            engineRunning: true,
            ip: '192.168.1.10',
            ips: ['192.168.1.10', '10.0.0.1'],
            hostname: 'engine-01',
            buildNumber: '1.2.3',
            config: {
                'mic-1': { displayName: 'Mic 1', settings: { volume: 100 }, lcpType: 'mixer-strip' },
            },
        });

        expect(moduleStore.engineRunning).toBe(true);
        expect(moduleStore.engineIp).toBe('192.168.1.10');
        expect(moduleStore.engineIps).toEqual(['192.168.1.10', '10.0.0.1']);
        expect(moduleStore.engineHostname).toBe('engine-01');
        expect(moduleStore.buildNumber).toBe('1.2.3');
        expect(moduleStore.modules['mic-1']?.displayName).toBe('Mic 1');
    });

    it('handles init event with minimal data (no optional fields)', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        socketStore.connect();

        getHandler('init')({
            engineRunning: false,
            config: {},
        });

        expect(moduleStore.engineRunning).toBe(false);
        expect(moduleStore.engineIp).toBe('');
    });

    it('handles moduleState event', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        moduleStore.setAll({
            'mic-1': { pluginId: 'audio-input', displayName: 'Mic 1', health: 'stopped', running: false, ready: false, settings: {}, lcpType: 'mixer-strip' },
        });
        socketStore.connect();

        getHandler('moduleState')({ instanceId: 'mic-1', state: { health: 'ok', running: true } });

        expect(moduleStore.modules['mic-1'].health).toBe('ok');
        expect(moduleStore.modules['mic-1'].running).toBe(true);
    });

    it('handles vuData event', () => {
        const socketStore = useSocketStore();
        const vuStore = useVuStore();
        socketStore.connect();

        getHandler('vuData')({ instanceId: 'mic-1', vuData: [-12, -15] });

        expect(vuStore.get('mic-1')).toEqual([-12, -15]);
    });

    it('handles configUpdate event with array patch', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        moduleStore.setAll({
            'mic-1': { pluginId: 'audio-input', displayName: 'Mic 1', health: 'ok', running: true, ready: true, settings: { volume: 100 }, lcpType: 'mixer-strip' },
        });
        socketStore.connect();

        getHandler('configUpdate')([
            { op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 },
        ]);

        expect(moduleStore.modules['mic-1'].settings?.volume).toBe(75);
    });

    it('handles configUpdate event — ignores non-array payload', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        moduleStore.setAll({
            'mic-1': { pluginId: 'audio-input', displayName: 'Mic 1', health: 'ok', running: true, ready: true, settings: { volume: 100 }, lcpType: 'mixer-strip' },
        });
        socketStore.connect();

        // Non-array should be ignored
        getHandler('configUpdate')({ not: 'an array' });

        expect(moduleStore.modules['mic-1'].settings?.volume).toBe(100);
    });

    it('handles engineRunning event', () => {
        const socketStore = useSocketStore();
        const moduleStore = useModuleStore();
        socketStore.connect();

        getHandler('engineRunning')(true);
        expect(moduleStore.engineRunning).toBe(true);

        getHandler('engineRunning')(false);
        expect(moduleStore.engineRunning).toBe(false);
    });

    it('emit delegates to socket.emit', () => {
        const store = useSocketStore();
        store.connect();
        store.emit('patch', { ops: [] });
        expect(mockSocket.emit).toHaveBeenCalledWith('patch', { ops: [] });
    });

    it('emit is a no-op when not connected', () => {
        const store = useSocketStore();
        // Don't connect — socket is null
        store.emit('patch', { ops: [] });
        expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('disconnect cleans up socket and resets state', () => {
        const store = useSocketStore();
        store.connect();
        getHandler('connect')();
        expect(store.connected).toBe(true);

        store.disconnect();
        expect(mockSocket.disconnect).toHaveBeenCalled();
        expect(store.connected).toBe(false);
    });

    it('can reconnect after disconnect', () => {
        const store = useSocketStore();
        store.connect();
        store.disconnect();

        vi.clearAllMocks();
        store.connect();
        expect(io).toHaveBeenCalledTimes(1);
    });
});
