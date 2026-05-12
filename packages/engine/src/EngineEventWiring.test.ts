import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wireEngineEvents, type EngineEventContext } from './EngineEventWiring.js';

/**
 * Tests focus on the state-resync heartbeat — the rest of the wiring is
 * covered indirectly by the per-handler tests (EngineEventForwarder etc.).
 */

interface Stubs {
    moduleManager: EventEmitter & { getAllStates: ReturnType<typeof vi.fn> };
    managerConnection: EventEmitter & {
        send: ReturnType<typeof vi.fn>;
        sendState: ReturnType<typeof vi.fn>;
        sendVu: ReturnType<typeof vi.fn>;
        isConnected: boolean;
    };
    lcpServer: EventEmitter & {
        broadcastState: ReturnType<typeof vi.fn>;
        broadcastVuData: ReturnType<typeof vi.fn>;
        broadcastConfigUpdate: ReturnType<typeof vi.fn>;
    };
    deviceProviders: EventEmitter & {
        types: ReturnType<typeof vi.fn>;
        getDevices: ReturnType<typeof vi.fn>;
        resetSnapshots: ReturnType<typeof vi.fn>;
        startPolling: ReturnType<typeof vi.fn>;
        stopPolling: ReturnType<typeof vi.fn>;
    };
    systemStats: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    logForwarder: EventEmitter;
}

function makeStubs(): Stubs {
    const moduleManager = Object.assign(new EventEmitter(), {
        getAllStates: vi.fn(() => ({})),
    });
    const managerConnection = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        sendState: vi.fn(),
        sendVu: vi.fn(),
        isConnected: false,
    });
    const lcpServer = Object.assign(new EventEmitter(), {
        broadcastState: vi.fn(),
        broadcastVuData: vi.fn(),
        broadcastConfigUpdate: vi.fn(),
    });
    const deviceProviders = Object.assign(new EventEmitter(), {
        types: vi.fn(() => []),
        getDevices: vi.fn(() => Promise.resolve([])),
        resetSnapshots: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
    });
    const systemStats = { start: vi.fn(), stop: vi.fn() };
    return {
        moduleManager,
        managerConnection,
        lcpServer,
        deviceProviders,
        systemStats,
        logForwarder: new EventEmitter(),
    };
}

function makeCtx(stubs: Stubs): EngineEventContext {
    return {
        logForwarder: stubs.logForwarder as unknown as EngineEventContext['logForwarder'],
        moduleManager: stubs.moduleManager as unknown as EngineEventContext['moduleManager'],
        managerConnection:
            stubs.managerConnection as unknown as EngineEventContext['managerConnection'],
        lcpServer: stubs.lcpServer as unknown as EngineEventContext['lcpServer'],
        pipeWire: {} as EngineEventContext['pipeWire'],
        deviceProviders:
            stubs.deviceProviders as unknown as EngineEventContext['deviceProviders'],
        commandDispatcher: { dispatch: vi.fn() } as unknown as EngineEventContext['commandDispatcher'],
        enginePatchRouter: { onPatch: vi.fn() } as unknown as EngineEventContext['enginePatchRouter'],
        systemStats: stubs.systemStats as unknown as EngineEventContext['systemStats'],
        runController: { isRunning: false } as unknown as EngineEventContext['runController'],
        getCurrentConfig: () => null,
        setCurrentConfig: vi.fn(),
        enrichConfigForLcp: (c) => c,
    };
}

describe('wireEngineEvents — state resync heartbeat', () => {
    let stubs: Stubs;

    beforeEach(() => {
        vi.useFakeTimers();
        stubs = makeStubs();
        wireEngineEvents(makeCtx(stubs));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('pushes guaranteed initial snapshot on connect', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith(
            { 'mod-1': { running: true, health: 'ok' } },
            { guaranteeDelivery: true },
        );
    });

    it('skips initial snapshot when there are no modules', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({});
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
    });

    it('reports engineRunningState from the run controller, not module-map size', () => {
        // Dormant instances exist (size > 0) but the controller says stopped —
        // the historical `moduleManager.size > 0` proxy would mis-report this
        // as running.
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: false, health: 'stopped' },
        });
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.send).toHaveBeenCalledWith('engineRunningState', {
            running: false,
        });
    });

    it('republishes guaranteed snapshot every 10s while connected', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();

        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
        expect(stubs.managerConnection.sendState).toHaveBeenLastCalledWith(
            { 'mod-1': { running: true, health: 'ok' } },
            { guaranteeDelivery: true },
        );

        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(2);
    });

    it('heartbeat skips empty snapshots without calling sendState', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();

        // Now all modules are gone — heartbeat should not fire an empty payload.
        stubs.moduleManager.getAllStates.mockReturnValue({});
        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
    });

    it('stops the heartbeat on disconnect', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();

        stubs.managerConnection.emit('disconnected');
        vi.advanceTimersByTime(60_000);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
    });

    it('replaces a stale heartbeat timer when connect fires twice', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();

        // If the first timer leaked, we'd see two calls per tick.
        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
    });
});
