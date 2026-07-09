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
        refreshModulePorts: vi.fn(),
        pluginSchemas: vi.fn(() => ({ transcoder: { properties: {} } })),
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

    it('advertises this host plugin schemas on connect (guaranteed) (#661)', () => {
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'capabilities',
            { transcoder: { properties: {} } },
            { guaranteeDelivery: true },
        );
    });

    it('skips initial snapshot when there are no modules', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({});
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
    });

    it('reports engineRunningState from the run controller (guaranteed), not module-map size', () => {
        // Two things at once:
        //  - Value: dormant instances exist (size > 0) but the controller says
        //    stopped — the historical `moduleManager.size > 0` proxy would
        //    mis-report this as running.
        //  - Delivery: guaranteed. This handshake is the sole trigger for
        //    manager-driven auto-start; sent best-effort it drops on a lossy
        //    tunnel (the NO-BR gate over Cloudflare) and the engine boots with
        //    every module stopped until an operator restarts it.
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: false, health: 'stopped' },
        });
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'engineRunningState',
            { running: false },
            { guaranteeDelivery: true },
        );
    });

    it('re-sends the running-state handshake on the 10s heartbeat (self-healing auto-start)', () => {
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.send.mockClear();

        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'engineRunningState',
            { running: false },
            { guaranteeDelivery: true },
        );
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

    // A dropped best-effort snapshot leaves the manager's device dropdown empty
    // until the next change — for NICs, effectively forever. Both the initial
    // snapshot and change-forward must be guaranteed (the mpegts NIC dropdown fix).
    it('sends the initial device snapshot guaranteed on connect', async () => {
        stubs.deviceProviders.types.mockReturnValue(['network-interface']);
        const devices = [{ name: 'eth0', label: 'eth0 (10.56.0.55)' }];
        stubs.deviceProviders.getDevices.mockResolvedValue(devices);

        stubs.managerConnection.emit('connected');
        // sendInitialDeviceSnapshots is fire-and-forget async — flush microtasks.
        await Promise.resolve();
        await Promise.resolve();

        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'deviceList',
            { type: 'network-interface', devices },
            { guaranteeDelivery: true },
        );
    });

    it('re-broadcasts device snapshots on the 10s heartbeat (self-heals a wiped cache)', async () => {
        stubs.deviceProviders.types.mockReturnValue(['network-interface']);
        const devices = [{ name: 'eth0' }];
        stubs.deviceProviders.getDevices.mockResolvedValue(devices);

        stubs.managerConnection.emit('connected');
        // Flush the on-connect snapshot, then clear so we only observe the
        // heartbeat's re-send — not the initial one.
        await Promise.resolve();
        await Promise.resolve();
        stubs.managerConnection.send.mockClear();

        vi.advanceTimersByTime(10_000);
        // The send follows getDevices' resolution — flush microtasks.
        await Promise.resolve();
        await Promise.resolve();

        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'deviceList',
            { type: 'network-interface', devices },
            { guaranteeDelivery: true },
        );
    });

    it('forwards device-list changes guaranteed while connected', () => {
        stubs.managerConnection.isConnected = true;
        const devices = [{ name: 'eth1', label: 'eth1 (10.64.0.55)' }];

        stubs.deviceProviders.emit('deviceList', { type: 'network-interface', devices });

        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'deviceList',
            { type: 'network-interface', devices },
            { guaranteeDelivery: true },
        );
    });

    it('drops device-list changes while disconnected', () => {
        stubs.managerConnection.isConnected = false;
        stubs.deviceProviders.emit('deviceList', {
            type: 'network-interface',
            devices: [{ name: 'eth0' }],
        });

        expect(stubs.managerConnection.send).not.toHaveBeenCalledWith(
            'deviceList',
            expect.anything(),
            expect.anything(),
        );
    });
});

describe('wireEngineEvents — module state batching', () => {
    let stubs: Stubs;

    beforeEach(() => {
        vi.useFakeTimers();
        stubs = makeStubs();
        wireEngineEvents(makeCtx(stubs));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // Batching semantics (flush window, latest-wins, dedup, vu-strip) are
    // covered directly in ModuleStateBatcher.test.ts — here we verify the
    // WIRING: events reach the batcher and its output reaches the connection.
    it('routes stateChange through the batcher — LCP gets the full state at once, the manager a lean batch on flush', () => {
        const state = { running: true, health: 'ok', vuData: [-12.5] };
        stubs.moduleManager.emit('stateChange', 'mod-1', state);
        stubs.moduleManager.emit('stateChange', 'mod-2', { running: false, health: 'stopped' });

        expect(stubs.lcpServer.broadcastState).toHaveBeenCalledWith('mod-1', state);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({
            'mod-1': { running: true, health: 'ok' },
            'mod-2': { running: false, health: 'stopped' },
        });
    });

    it('drops a deleted module from the pending batch', () => {
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        stubs.moduleManager.emit('stateChange', 'mod-2', { running: true, health: 'ok' });
        stubs.moduleManager.emit('moduleDeleted', 'mod-1');

        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({
            'mod-2': { running: true, health: 'ok' },
        });
    });

    it('guaranteed snapshot supersedes the pending batch and resets dedup', () => {
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok', vuData: [-3] },
        });
        stubs.managerConnection.emit('connected');

        // Snapshot went out guaranteed (vuData stripped)…
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith(
            { 'mod-1': { running: true, health: 'ok' } },
            { guaranteeDelivery: true },
        );
        stubs.managerConnection.sendState.mockClear();

        // …and the pending batch was absorbed — nothing extra flushes.
        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
    });

    it('clears the batch and dedup cache on disconnect so reconnect starts clean', () => {
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        stubs.managerConnection.emit('disconnected');

        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();

        // Same state again post-reconnect must not be dedup-suppressed.
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({
            'mod-1': { running: true, health: 'ok' },
        });
    });
});
