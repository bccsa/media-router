import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wireEngineEvents, type EngineEventContext } from './EngineEventWiring.js';
import { LocalChanges } from './comms/LocalChanges.js';

/**
 * Tests focus on the state-resync heartbeat — the rest of the wiring is
 * covered indirectly by the per-handler tests (EngineEventForwarder etc.).
 */

interface Stubs {
    moduleManager: EventEmitter & { getAllStates: ReturnType<typeof vi.fn> };
    managerConnection: EventEmitter & {
        send: ReturnType<typeof vi.fn>;
        sendState: ReturnType<typeof vi.fn>;
        isConnected: boolean;
    };
    lcpServer: EventEmitter & {
        broadcastState: ReturnType<typeof vi.fn>;
        broadcastVuData: ReturnType<typeof vi.fn>;
        broadcastConfigUpdate: ReturnType<typeof vi.fn>;
        broadcastConfigUpdateExcept: ReturnType<typeof vi.fn>;
        broadcastEngineRunning: ReturnType<typeof vi.fn>;
    };
    localServer: EventEmitter & {
        configChanged: ReturnType<typeof vi.fn>;
        runningChanged: ReturnType<typeof vi.fn>;
    };
    deviceProviders: EventEmitter & {
        types: ReturnType<typeof vi.fn>;
        getDevices: ReturnType<typeof vi.fn>;
        resetSnapshots: ReturnType<typeof vi.fn>;
        startPolling: ReturnType<typeof vi.fn>;
        stopPolling: ReturnType<typeof vi.fn>;
    };
    logForwarder: EventEmitter;
}

function makeStubs(): Stubs {
    const moduleManager = Object.assign(new EventEmitter(), {
        getAllStates: vi.fn(() => ({})),
    });
    const managerConnection = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        sendState: vi.fn(),
        isConnected: false,
    });
    const lcpServer = Object.assign(new EventEmitter(), {
        broadcastState: vi.fn(),
        broadcastVuData: vi.fn(),
        broadcastConfigUpdate: vi.fn(),
        broadcastConfigUpdateExcept: vi.fn(),
        broadcastEngineRunning: vi.fn(),
    });
    const localServer = Object.assign(new EventEmitter(), {
        configChanged: vi.fn(),
        runningChanged: vi.fn(),
    });
    const deviceProviders = Object.assign(new EventEmitter(), {
        types: vi.fn(() => []),
        getDevices: vi.fn(() => Promise.resolve([])),
        resetSnapshots: vi.fn(),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
    });
    return {
        moduleManager,
        managerConnection,
        lcpServer,
        localServer,
        deviceProviders,
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
        localServer: stubs.localServer as unknown as EngineEventContext['localServer'],
        pipeWire: {} as EngineEventContext['pipeWire'],
        deviceProviders:
            stubs.deviceProviders as unknown as EngineEventContext['deviceProviders'],
        commandDispatcher: { dispatch: vi.fn() } as unknown as EngineEventContext['commandDispatcher'],
        enginePatchRouter: { onPatch: vi.fn() } as unknown as EngineEventContext['enginePatchRouter'],
        runController: { isRunning: false } as unknown as EngineEventContext['runController'],
        getCurrentConfig: () => null,
        setCurrentConfig: vi.fn(),
        enrichConfigForLcp: (c) => c,
        refreshModulePorts: vi.fn(),
        pluginSchemas: vi.fn(() => ({ transcoder: { properties: {} } })),
        routerTree: null,
        localChanges: new LocalChanges(stubs.managerConnection),
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

    it('pushes best-effort initial snapshot on connect (10s resync self-heals drops)', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({
            'mod-1': { running: true, health: 'ok' },
        });
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

    it('reports engineRunningState from the run controller, not module-map size', () => {
        // Value check: dormant instances exist (size > 0) but the controller
        // says stopped — the historical `moduleManager.size > 0` proxy would
        // mis-report this as running. Delivery is best-effort: the handshake
        // repeats on the 10s heartbeat, so a drop delays the auto-start
        // reconcile one interval at most (guaranteed delivery here fed the
        // retransmit flood that choked the NO-BR uplink).
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: false, health: 'stopped' },
        });
        stubs.managerConnection.emit('connected');

        expect(stubs.managerConnection.send).toHaveBeenCalledWith('engineRunningState', {
            running: false,
        });
    });

    it('re-sends the running-state handshake on the 10s heartbeat (self-healing auto-start)', () => {
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.send.mockClear();

        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.send).toHaveBeenCalledWith('engineRunningState', {
            running: false,
        });
    });

    it('republishes best-effort snapshot every 10s while connected', () => {
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok' },
        });
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();

        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
        expect(stubs.managerConnection.sendState).toHaveBeenLastCalledWith({
            'mod-1': { running: true, health: 'ok' },
        });

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

    // Device snapshots are best-effort: the 10s heartbeat re-broadcasts them,
    // so a dropped packet self-heals within one interval. Guaranteed delivery
    // here was measured flooding lossy uplinks with retransmits (NO-BR gate).
    it('sends the initial device snapshot on connect', async () => {
        stubs.deviceProviders.types.mockReturnValue(['network-interface']);
        const devices = [{ name: 'eth0', label: 'eth0 (10.56.0.55)' }];
        stubs.deviceProviders.getDevices.mockResolvedValue(devices);

        stubs.managerConnection.emit('connected');
        // sendInitialDeviceSnapshots is fire-and-forget async — flush microtasks.
        await Promise.resolve();
        await Promise.resolve();

        expect(stubs.managerConnection.send).toHaveBeenCalledWith('deviceList', {
            type: 'network-interface',
            devices,
        });
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

        expect(stubs.managerConnection.send).toHaveBeenCalledWith('deviceList', {
            type: 'network-interface',
            devices,
        });
    });

    it('forwards device-list changes while connected', () => {
        stubs.managerConnection.isConnected = true;
        const devices = [{ name: 'eth1', label: 'eth1 (10.64.0.55)' }];

        stubs.deviceProviders.emit('deviceList', { type: 'network-interface', devices });

        expect(stubs.managerConnection.send).toHaveBeenCalledWith('deviceList', {
            type: 'network-interface',
            devices,
        });
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

describe('wireEngineEvents — LCP lifecycle commands', () => {
    let stubs: Stubs;
    let ctx: EngineEventContext;

    beforeEach(() => {
        stubs = makeStubs();
        ctx = makeCtx(stubs);
        wireEngineEvents(ctx);
    });

    it.each(['start', 'stop'] as const)(
        'dispatches %s locally and notifies the manager guaranteed',
        (action) => {
            stubs.managerConnection.isConnected = true;
            stubs.managerConnection.emit('config', { modules: {}, _push: { reason: 'connect', profile: 'p' } });
            stubs.lcpServer.emit('control', { action });

            expect(ctx.commandDispatcher.dispatch).toHaveBeenCalledWith({ command: action });
            // Guaranteed on purpose: this message flips the manager's persisted
            // desired-run-state — if it's lost, the 10s engineRunningState
            // reconcile reverts the operator's LCP action.
            expect(stubs.managerConnection.send).toHaveBeenCalledWith(
                'lcpEngineCommand',
                { command: action },
                { guaranteeDelivery: true },
            );
        },
    );

    it('ignores unknown control actions', () => {
        stubs.lcpServer.emit('control', { action: 'reboot' });

        expect(ctx.commandDispatcher.dispatch).not.toHaveBeenCalled();
        expect(stubs.managerConnection.send).not.toHaveBeenCalled();
    });
});

describe('wireEngineEvents — the LCP follows every local change', () => {
    it("gets config changes (skipping a writer's own) and run intent, with lcpType on a whole config", () => {
        const stubs = makeStubs();
        const ctx = { ...makeCtx(stubs), enrichConfigForLcp: (c: Record<string, unknown>) => ({ ...c, enriched: true }) };
        wireEngineEvents(ctx);
        const op = { op: 'replace', path: '/modules/m1/settings/volume', value: 1 };
        stubs.localServer.emit('local:config', [op]);
        stubs.localServer.emit('local:config', [op], 'lcp-socket');
        stubs.localServer.emit('local:config', [{ op: 'replace', path: '/', value: { modules: {} } }]);
        stubs.localServer.emit('local:running', true);
        expect(stubs.lcpServer.broadcastConfigUpdate).toHaveBeenNthCalledWith(1, [op]);
        expect(stubs.lcpServer.broadcastConfigUpdateExcept).toHaveBeenCalledWith('lcp-socket', [op]);
        expect(stubs.lcpServer.broadcastConfigUpdate).toHaveBeenLastCalledWith([{ op: 'replace', path: '/', value: { modules: {}, enriched: true } }]);
        expect(stubs.lcpServer.broadcastEngineRunning).toHaveBeenCalledWith(true);
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

    it('snapshot supersedes the pending batch and resets dedup', () => {
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        stubs.moduleManager.getAllStates.mockReturnValue({
            'mod-1': { running: true, health: 'ok', vuData: [-3] },
        });
        stubs.managerConnection.emit('connected');

        // Snapshot went out (vuData stripped)…
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({
            'mod-1': { running: true, health: 'ok' },
        });
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

describe('wireEngineEvents — state patches (ADR-0025)', () => {
    let stubs: Stubs;
    const patches = () => stubs.managerConnection.send.mock.calls.filter(([topic]) => topic === 'statePatch');

    beforeEach(() => {
        vi.useFakeTimers();
        stubs = makeStubs();
        wireEngineEvents(makeCtx(stubs));
        stubs.moduleManager.getAllStates.mockReturnValue({ 'mod-1': { running: true, health: 'ok' } });
        stubs.managerConnection.emit('connected');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends whole states until the manager offers statePatch', () => {
        stubs.managerConnection.sendState.mockClear();
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'warning' });
        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledWith({ 'mod-1': { running: true, health: 'warning' } });
        expect(patches()).toHaveLength(0);
    });

    it('after hello: a baseline snapshot, then numbered leaf ops', () => {
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'ok' });
        stubs.managerConnection.sendState.mockClear();
        stubs.managerConnection.emit('hello', { features: ['statePatch'] });
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);

        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'warning' });
        vi.advanceTimersByTime(250);
        expect(patches()).toEqual([
            ['statePatch', { seq: 1, ops: [{ op: 'replace', path: '/modules/mod-1/health', value: 'warning' }] }],
        ]);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
    });

    it('stateResync sends a snapshot and restarts the numbering', () => {
        stubs.managerConnection.emit('hello', { features: ['statePatch'] });
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'warning' });
        vi.advanceTimersByTime(250);
        stubs.managerConnection.sendState.mockClear();
        stubs.managerConnection.emit('stateResync', {});
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: false, health: 'warning' });
        vi.advanceTimersByTime(250);
        expect(patches().at(-1)?.[1].seq).toBe(1);
    });

    it('full snapshots only every 60 s in patch mode', () => {
        stubs.managerConnection.emit('hello', { features: ['statePatch'] });
        stubs.managerConnection.sendState.mockClear();
        vi.advanceTimersByTime(50_000);
        expect(stubs.managerConnection.sendState).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10_000);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
    });

    it('a disconnect falls back to whole states until the next hello', () => {
        stubs.managerConnection.emit('hello', { features: ['statePatch'] });
        stubs.managerConnection.emit('disconnected');
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.sendState.mockClear();
        stubs.moduleManager.emit('stateChange', 'mod-1', { running: true, health: 'warning' });
        vi.advanceTimersByTime(250);
        expect(stubs.managerConnection.sendState).toHaveBeenCalledTimes(1);
        expect(patches()).toHaveLength(0);
    });
});

describe('wireEngineEvents — outage and reconnect (ADR-0025)', () => {
    let stubs: Stubs;
    let ctx: EngineEventContext;
    let config: Record<string, unknown>;
    const push = (volume: number) => ({
        modules: { m1: { pluginId: 'mixer', settings: { volume } } },
        connections: [],
        _push: { reason: 'connect', profile: 'p' },
    });

    beforeEach(() => {
        stubs = makeStubs();
        ctx = makeCtx(stubs);
        config = { modules: { m1: { pluginId: 'mixer', settings: { volume: 100 } } }, connections: [] };
        ctx.getCurrentConfig = () => config;
        ctx.setCurrentConfig = vi.fn((c) => (config = c));
        (ctx.runController as { isRunning: boolean }).isRunning = true;
        wireEngineEvents(ctx);
        stubs.managerConnection.isConnected = true;
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.emit('config', push(100));
        stubs.managerConnection.emit('disconnected');
        stubs.managerConnection.isConnected = false;
        stubs.managerConnection.send.mockClear();
    });

    it('an outage Stop rides the connect handshake, guaranteed, for the manager to adopt', () => {
        stubs.lcpServer.emit('control', { action: 'stop' });
        (ctx.runController as { isRunning: boolean }).isRunning = false;
        expect(stubs.managerConnection.send).not.toHaveBeenCalled();
        stubs.managerConnection.isConnected = true;
        stubs.managerConnection.emit('connected');
        expect(stubs.managerConnection.send).toHaveBeenCalledWith(
            'engineRunningState',
            { running: false, localChange: true },
            { guaranteeDelivery: true },
        );
    });

    it('a plugin auto-write updates the engine config and the LCP, and is journaled offline', () => {
        stubs.moduleManager.emit('configUpdated', 'm1', { volume: 55 });
        const op = { op: 'replace', path: '/modules/m1/settings/volume', value: 55 };
        expect((config.modules as any).m1.settings.volume).toBe(55);
        expect(stubs.localServer.configChanged).toHaveBeenCalledWith([op]);
        expect(stubs.managerConnection.send).not.toHaveBeenCalled();
        stubs.managerConnection.isConnected = true;
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.emit('config', push(100));
        expect(stubs.managerConnection.send).toHaveBeenCalledWith('patch', { ops: [op] }, { guaranteeDelivery: true });
    });

    it('a reconnect push goes to the patch router as a difference, not a swap', () => {
        stubs.managerConnection.isConnected = true;
        stubs.managerConnection.emit('connected');
        stubs.managerConnection.emit('config', push(80));
        expect(ctx.enginePatchRouter.onPatch).toHaveBeenCalledWith('manager', 'manager', [
            { op: 'replace', path: '/modules/m1/settings/volume', value: 80 },
        ]);
        expect(ctx.setCurrentConfig).not.toHaveBeenCalled();
    });
});
