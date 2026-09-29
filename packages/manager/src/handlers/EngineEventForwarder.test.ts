import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { EngineEventForwarder } from './EngineEventForwarder.js';
import { RuntimeCache } from '../tree/RuntimeCache.js';

vi.mock('@media-router/shared-types', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@media-router/shared-types')>();
    return {
        ...actual,
        createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    };
});

function createMocks(modules: Record<string, unknown> = {}) {
    const stored = { modules, connections: [] as unknown[] };
    const configStore = {
        getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default' }),
        getProfile: vi.fn(() => stored),
        modifyProfileConfig: vi.fn((_e: string, _p: string, fn: (c: any) => any) => fn(stored)),
    } as any;
    const engineManager = new EventEmitter() as any;
    engineManager.sendToEngine = vi.fn();
    engineManager.enginePaths = vi.fn().mockReturnValue([{ remote: '1.2.3.4:5', listenerPort: 3000 }]);
    const engineCommands = { isRunning: vi.fn().mockReturnValue(false), setRunning: vi.fn(), sendCommand: vi.fn() } as any;
    const runtime = new RuntimeCache();
    const publisher = {
        publish: vi.fn(),
        info: vi.fn(),
        infoFields: vi.fn(),
        runtime: vi.fn(),
        vu: vi.fn(),
        system: vi.fn(),
        logs: vi.fn(),
        devices: vi.fn(),
        event: vi.fn(),
        offline: vi.fn(),
        statePatch: vi.fn(),
        metaChanged: vi.fn(),
    } as any;
    new EngineEventForwarder(configStore, engineManager, engineCommands, runtime, publisher).setup();
    return { configStore, engineManager, engineCommands, runtime, publisher, stored };
}

describe('EngineEventForwarder', () => {
    it('publishes info when an engine comes online, and its paths when they change', () => {
        const { engineManager, publisher } = createMocks();
        engineManager.emit('engineOnline', 'eng-1');
        expect(publisher.info).toHaveBeenCalledWith('eng-1');
        engineManager.emit('enginePathDown', 'eng-1');
        expect(publisher.infoFields).toHaveBeenCalledWith('eng-1', {
            paths: [{ remote: '1.2.3.4:5', listenerPort: 3000 }],
        });
    });

    it('clears the runtime cache and publishes the reset when an engine goes offline', () => {
        const { engineManager, runtime, publisher } = createMocks();
        engineManager.emit('engineState', 'eng-1', { m1: { running: true } });
        engineManager.emit('engineSystem', 'eng-1', { ip: '10.0.0.1', cpu: 5 });
        engineManager.emit('engineOffline', 'eng-1');
        expect(runtime.getStates('eng-1')).toEqual({});
        expect(runtime.getData('eng-1', 'ip')).toBeUndefined();
        expect(publisher.offline).toHaveBeenCalledWith('eng-1');
    });

    describe('engineRunningState', () => {
        it('sends start when manager wants running but engine is stopped', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);
            engineManager.emit('engineRunningState', 'eng-1', { running: false });
            expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'start');
        });

        it('sends nothing when both are running — the connect push already delivered the config', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);
            engineManager.emit('engineRunningState', 'eng-1', { running: true });
            engineManager.emit('engineRunningState', 'eng-1', { running: true });
            expect(engineCommands.sendCommand).not.toHaveBeenCalled();
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });

        it('sends stop when manager wants stopped but engine is running', () => {
            const { engineManager, engineCommands } = createMocks();
            engineManager.emit('engineRunningState', 'eng-1', { running: true });
            expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'stop');
        });

        it('does nothing when both are stopped', () => {
            const { engineManager, engineCommands } = createMocks();
            engineManager.emit('engineRunningState', 'eng-1', { running: false });
            expect(engineCommands.sendCommand).not.toHaveBeenCalled();
        });

        it('adopts a Start/Stop made on site during an outage instead of reverting it (ADR-0025)', () => {
            const { engineManager, engineCommands, publisher } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);
            engineManager.emit('engineRunningState', 'eng-1', { running: false, localChange: true });
            expect(engineCommands.sendCommand).not.toHaveBeenCalled();
            expect(engineCommands.setRunning).toHaveBeenCalledWith('eng-1', false);
            expect(publisher.info).toHaveBeenCalledWith('eng-1');
        });

        it('retries start on every stopped-report — heartbeat self-heal for eaten commands', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);
            engineManager.emit('engineRunningState', 'eng-1', { running: false });
            engineManager.emit('engineRunningState', 'eng-1', { running: false });
            expect(engineCommands.sendCommand).toHaveBeenCalledTimes(2);
        });
    });

    describe('engineState', () => {
        it('merges into the cache and publishes per-module changes', () => {
            const { engineManager, publisher } = createMocks();
            engineManager.emit('engineState', 'eng-1', { m1: { health: 'ok' } });
            engineManager.emit('engineState', 'eng-1', { m1: { health: 'warning' } });
            expect(publisher.runtime).toHaveBeenLastCalledWith('eng-1', [
                { moduleId: 'm1', prev: { health: 'ok' }, next: { health: 'warning' } },
            ]);
        });

        it('drops a late batch for a removed module (tombstone)', () => {
            const { engineManager, runtime, publisher } = createMocks();
            runtime.purgeModuleStates('eng-1', ['ghost']);
            engineManager.emit('engineState', 'eng-1', { ghost: { running: false } });
            expect(publisher.runtime).toHaveBeenCalledWith('eng-1', []);
            expect(runtime.getStates('eng-1')).toEqual({});
        });

        it('drops non-object payloads', () => {
            const { engineManager, publisher } = createMocks();
            engineManager.emit('engineState', 'eng-1', 'nope');
            expect(publisher.runtime).not.toHaveBeenCalled();
        });
    });

    describe('engineStatePatch (ADR-0025)', () => {
        const op = (path: string, value: unknown) => ({ op: 'replace', path, value });

        it('applies leaf ops to the cache and publishes them under the engine', () => {
            const { engineManager, runtime, publisher } = createMocks();
            engineManager.emit('engineState', 'eng-1', { m1: { health: 'ok', statusData: { kbps: 1 } } });
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 1, ops: [op('/modules/m1/statusData/kbps', 2)] });
            expect(runtime.getStates('eng-1').m1).toEqual({ health: 'ok', statusData: { kbps: 2 } });
            expect(publisher.statePatch).toHaveBeenLastCalledWith('eng-1', [op('/modules/m1/statusData/kbps', 2)]);
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });

        it('asks for a resync on a seq gap and still applies the ops', () => {
            const { engineManager, runtime } = createMocks();
            engineManager.emit('engineState', 'eng-1', { m1: { health: 'ok' } });
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 3, ops: [op('/modules/m1/health', 'warning')] });
            expect(engineManager.sendToEngine).toHaveBeenCalledWith('eng-1', 'stateResync', {}, { guaranteeDelivery: true });
            expect(runtime.getStates('eng-1').m1.health).toBe('warning');
        });

        it('a full snapshot restarts the count', () => {
            const { engineManager } = createMocks();
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 1, ops: [] });
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 2, ops: [] });
            engineManager.emit('engineState', 'eng-1', {});
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 1, ops: [] });
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });

        it('skips ops for a removed module', () => {
            const { engineManager, runtime, publisher } = createMocks();
            runtime.purgeModuleStates('eng-1', ['ghost']);
            engineManager.emit('engineStatePatch', 'eng-1', { seq: 1, ops: [op('/modules/ghost/health', 'ok')] });
            expect(runtime.getStates('eng-1')).toEqual({});
            expect(publisher.statePatch).toHaveBeenLastCalledWith('eng-1', []);
        });
    });

    describe('engineCapabilities (#661)', () => {
        it('caches schemas and replaces configSchema of placed modules of that plugin', () => {
            const { engineManager, runtime, publisher } = createMocks({
                m1: { pluginId: 'enc' },
                m2: { pluginId: 'other' },
            });
            engineManager.emit('engineCapabilities', 'eng-1', { enc: { properties: { hw: {} } } });
            expect(runtime.getPluginSchemas('eng-1')).toEqual({ enc: { properties: { hw: {} } } });
            expect(publisher.publish).toHaveBeenCalledWith([
                { op: 'replace', path: '/engines/eng-1/modules/m1/configSchema', value: { properties: { hw: {} } } },
            ]);
            // Their descriptors follow the new schema (/meta).
            expect(publisher.metaChanged).toHaveBeenCalledWith('eng-1', ['m1']);
        });

        it('drops non-object payloads', () => {
            const { engineManager, runtime } = createMocks();
            engineManager.emit('engineCapabilities', 'eng-1', 42);
            expect(runtime.getPluginSchemas('eng-1')).toBeUndefined();
        });
    });

    describe('engineVu', () => {
        it('caches and publishes a batched payload', () => {
            const { engineManager, runtime, publisher } = createMocks();
            engineManager.emit('engineVu', 'eng-1', { batch: { m1: [-6, -7] } });
            expect(runtime.getVu('eng-1')).toEqual({ m1: [-6, -7] });
            expect(publisher.vu).toHaveBeenCalledWith('eng-1', { m1: [-6, -7] });
        });

        it('accepts the older one-module form', () => {
            const { engineManager, publisher } = createMocks();
            engineManager.emit('engineVu', 'eng-1', { instanceId: 'm1', vuData: [-3] });
            expect(publisher.vu).toHaveBeenCalledWith('eng-1', { m1: [-3] });
        });
    });

    describe('engineSystem', () => {
        it('splits identity into info and load into system', () => {
            const { engineManager, runtime, publisher } = createMocks();
            engineManager.emit('engineSystem', 'eng-1', {
                cpu: 12, mem: 40, ip: '10.0.0.1', ips: ['10.0.0.1'], hostname: 'mr',
                buildNumber: 'v2', managerPaths: { connected: 1, total: 2 },
            });
            expect(runtime.getData('eng-1', 'hostname')).toBe('mr');
            expect(publisher.infoFields).toHaveBeenCalledWith('eng-1', {
                ip: '10.0.0.1', ips: ['10.0.0.1'], hostname: 'mr', buildNumber: 'v2',
                managerPaths: { connected: 1, total: 2 },
            });
            expect(publisher.system).toHaveBeenCalledWith('eng-1', undefined, { cpu: 12, mem: 40 });
            engineManager.emit('engineSystem', 'eng-1', { cpu: 13, mem: 40 });
            expect(publisher.system).toHaveBeenLastCalledWith('eng-1', { cpu: 12, mem: 40 }, { cpu: 13, mem: 40 });
        });
    });

    it('buffers and publishes logs; ignores non-arrays', () => {
        const { engineManager, runtime, publisher } = createMocks();
        engineManager.emit('engineLogs', 'eng-1', [{ msg: 'a' }]);
        engineManager.emit('engineLogs', 'eng-1', { msg: 'b' });
        expect(runtime.getLogs('eng-1')).toEqual([{ msg: 'a' }]);
        expect(publisher.logs).toHaveBeenCalledTimes(1);
    });

    it('caches and publishes device lists once per change; ignores a missing type', () => {
        const { engineManager, runtime, publisher } = createMocks();
        engineManager.emit('engineDeviceList', 'eng-1', { type: 'audio-sink', devices: [{ name: 'x' }] });
        engineManager.emit('engineDeviceList', 'eng-1', { type: 'audio-sink', devices: [{ name: 'x' }] });
        engineManager.emit('engineDeviceList', 'eng-1', { devices: [] });
        expect(runtime.getDevices('eng-1')).toEqual({ 'audio-sink': [{ name: 'x' }] });
        expect(publisher.devices).toHaveBeenCalledTimes(1);
    });

    it('adopts an LCP start/stop as the manager intent', () => {
        const { engineManager, engineCommands, publisher } = createMocks();
        engineManager.emit('engineLcpCommand', 'eng-1', { command: 'stop' });
        expect(engineCommands.setRunning).toHaveBeenCalledWith('eng-1', false);
        expect(publisher.info).toHaveBeenCalledWith('eng-1');
        engineManager.emit('engineLcpCommand', 'eng-1', {});
        expect(engineCommands.setRunning).toHaveBeenCalledTimes(1);
    });

    it('publishes a failed reboot as an event; drops malformed payloads', () => {
        const { engineManager, publisher } = createMocks();
        engineManager.emit('engineRebootFailed', 'eng-1', { reason: 'polkit' });
        engineManager.emit('engineRebootFailed', 'eng-1', {});
        expect(publisher.event).toHaveBeenCalledTimes(1);
        expect(publisher.event).toHaveBeenCalledWith('eng-1', { type: 'rebootFailed', reason: 'polkit' });
    });

    it('stores dynamic ports and publishes them', () => {
        const { engineManager, stored, publisher } = createMocks({ m1: { pluginId: 'mux' } });
        const ports = [{ id: 'in-0', direction: 'input', streamType: 'muxed/mpegts', label: 'In 0' }];
        engineManager.emit('engineDynamicPorts', 'eng-1', { moduleId: 'm1', ports });
        expect((stored.modules.m1 as any).ports).toEqual(ports);
        expect(publisher.publish).toHaveBeenCalledWith([
            { op: 'replace', path: '/engines/eng-1/modules/m1/ports', value: ports },
        ]);
        engineManager.emit('engineDynamicPorts', 'eng-1', { moduleId: 'm1' });
        expect(publisher.publish).toHaveBeenCalledTimes(1);
    });
});
