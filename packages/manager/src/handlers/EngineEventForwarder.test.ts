import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { EngineEventForwarder } from './EngineEventForwarder.js';

vi.mock('@media-router/shared-types', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@media-router/shared-types')>();
    return {
        ...actual,
        createLogger: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    };
});

function createMocks() {
    const configStore = {
        getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default' }),
        getProfile: vi.fn().mockReturnValue({ modules: {}, connections: [] }),
        modifyProfileConfig: vi.fn((_eid: string, _pid: string, fn: any) => {
            const config = { modules: {}, connections: [] };
            return fn(config);
        }),
    } as any;

    const engineManager = new EventEmitter() as any;
    engineManager.sendToEngine = vi.fn();

    const engineCommands = {
        isRunning: vi.fn().mockReturnValue(false),
        setRunning: vi.fn(),
        sendCommand: vi.fn(),
    } as any;

    const volatileEmit = vi.fn();
    const roomVolatileEmit = vi.fn();
    const roomEmit = vi.fn();
    const toRoom = vi
        .fn()
        .mockReturnValue({ emit: roomEmit, volatile: { emit: roomVolatileEmit } });

    const io = {
        emit: vi.fn(),
        volatile: { emit: volatileEmit },
        to: toRoom,
    } as any;

    const forwarder = new EngineEventForwarder(configStore, engineManager, engineCommands, io);
    forwarder.setup();

    return {
        forwarder,
        configStore,
        engineManager,
        engineCommands,
        io,
        volatileEmit,
        toRoom,
        roomEmit,
        roomVolatileEmit,
    };
}

describe('EngineEventForwarder', () => {
    describe('engineOnline', () => {
        it('emits engine:online to browsers', () => {
            const { engineManager, io } = createMocks();
            engineManager.emit('engineOnline', 'eng-1');
            expect(io.emit).toHaveBeenCalledWith('engine:online', { engineId: 'eng-1' });
        });
    });

    describe('engineOffline', () => {
        it('emits engine:offline to browsers and clears cached state', () => {
            const { forwarder, engineManager, io } = createMocks();

            // Populate caches first
            engineManager.emit('engineState', 'eng-1', { 'mod-1': { running: true } });
            engineManager.emit('engineSystem', 'eng-1', { ip: '10.0.0.1' });
            expect(forwarder.getCachedStates('eng-1')).toEqual({ 'mod-1': { running: true } });
            expect(forwarder.getEngineData('eng-1', 'ip')).toBe('10.0.0.1');

            io.emit.mockClear();
            engineManager.emit('engineOffline', 'eng-1');

            expect(io.emit).toHaveBeenCalledWith('engine:offline', { engineId: 'eng-1' });
            expect(forwarder.getCachedStates('eng-1')).toEqual({});
            expect(forwarder.getEngineData('eng-1', 'ip')).toBeUndefined();
        });
    });

    describe('engineRunningState', () => {
        it('sends start when manager wants running but engine is stopped', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);

            engineManager.emit('engineRunningState', 'eng-1', { running: false });

            expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'start');
        });

        it('pushes config when both manager and engine are running', () => {
            const { engineManager, engineCommands, configStore } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);

            engineManager.emit('engineRunningState', 'eng-1', { running: true });

            expect(engineCommands.sendCommand).not.toHaveBeenCalled();
            expect(engineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1',
                'config',
                expect.any(Object),
                expect.objectContaining({ guaranteeDelivery: true }),
            );
        });

        it('sends stop when manager wants stopped but engine is running', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(false);

            engineManager.emit('engineRunningState', 'eng-1', { running: true });

            expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'stop');
        });

        it('does nothing when both manager and engine are stopped', () => {
            const { engineManager, engineCommands } = createMocks();
            engineCommands.isRunning.mockReturnValue(false);

            engineManager.emit('engineRunningState', 'eng-1', { running: false });

            expect(engineCommands.sendCommand).not.toHaveBeenCalled();
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });

        it('skips config push when no active profile', () => {
            const { engineManager, engineCommands, configStore } = createMocks();
            engineCommands.isRunning.mockReturnValue(true);
            configStore.getEngine.mockReturnValue({ engine_id: 'eng-1', active_profile: null });

            engineManager.emit('engineRunningState', 'eng-1', { running: true });

            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });
    });

    describe('engineState', () => {
        it('caches module states and broadcasts to browsers', () => {
            const { forwarder, engineManager, io } = createMocks();

            engineManager.emit('engineState', 'eng-1', { 'mod-1': { running: true } });

            expect(io.emit).toHaveBeenCalledWith('engine:state', {
                engineId: 'eng-1',
                state: { 'mod-1': { running: true } },
            });
            expect(forwarder.getCachedStates('eng-1')).toEqual({ 'mod-1': { running: true } });
        });

        it('merges state updates incrementally', () => {
            const { forwarder, engineManager } = createMocks();

            engineManager.emit('engineState', 'eng-1', { 'mod-1': { running: true } });
            engineManager.emit('engineState', 'eng-1', { 'mod-2': { running: false } });

            expect(forwarder.getCachedStates('eng-1')).toEqual({
                'mod-1': { running: true },
                'mod-2': { running: false },
            });
        });
    });

    describe('engineCapabilities (#661)', () => {
        it('caches schemas and pushes configSchema patches for matching modules', () => {
            const { forwarder, engineManager, configStore, io } = createMocks();
            configStore.getProfile.mockReturnValue({
                modules: {
                    't-1': { pluginId: 'transcoder' },
                    'a-1': { pluginId: 'audio-input' }, // no reported schema → skipped
                },
            });
            const schemas = {
                transcoder: { properties: { encoderImpl: { enum: ['auto', 'va'] } } },
            };

            engineManager.emit('engineCapabilities', 'eng-1', schemas);

            expect(forwarder.getPluginSchemas('eng-1')).toEqual(schemas);
            expect(io.emit).toHaveBeenCalledWith('engine:update', {
                engineId: 'eng-1',
                patch: [
                    {
                        op: 'replace',
                        path: '/modules/t-1/configSchema',
                        value: schemas.transcoder,
                    },
                ],
            });
        });

        it('caches but does not broadcast when no placed module matches', () => {
            const { forwarder, engineManager, configStore, io } = createMocks();
            configStore.getProfile.mockReturnValue({ modules: { 'a-1': { pluginId: 'audio-input' } } });

            engineManager.emit('engineCapabilities', 'eng-1', { transcoder: { properties: {} } });

            expect(forwarder.getPluginSchemas('eng-1')).toBeDefined();
            expect(io.emit).not.toHaveBeenCalledWith('engine:update', expect.anything());
        });

        it('drops non-object payloads', () => {
            const { forwarder, engineManager, io } = createMocks();
            engineManager.emit('engineCapabilities', 'eng-1', 'nope');
            expect(forwarder.getPluginSchemas('eng-1')).toBeUndefined();
            expect(io.emit).not.toHaveBeenCalled();
        });

        it('is cleared on engineOffline', () => {
            const { forwarder, engineManager } = createMocks();
            engineManager.emit('engineCapabilities', 'eng-1', { transcoder: {} });
            expect(forwarder.getPluginSchemas('eng-1')).toBeDefined();
            engineManager.emit('engineOffline', 'eng-1');
            expect(forwarder.getPluginSchemas('eng-1')).toBeUndefined();
        });
    });

    describe('engineVu', () => {
        it('emits VU data to watchers room via volatile', () => {
            const { engineManager, toRoom, roomVolatileEmit } = createMocks();

            engineManager.emit('engineVu', 'eng-1', { moduleId: 'mod-1', levels: [0.5] });

            expect(toRoom).toHaveBeenCalledWith('watch:eng-1');
            expect(roomVolatileEmit).toHaveBeenCalledWith('engine:vu', {
                engineId: 'eng-1',
                moduleId: 'mod-1',
                levels: [0.5],
            });
        });
    });

    describe('engineSystem', () => {
        it('caches IP and hostname from system stats', () => {
            const { forwarder, engineManager } = createMocks();

            engineManager.emit('engineSystem', 'eng-1', {
                ip: '10.0.0.1',
                hostname: 'studio-a',
                buildNumber: '1.2.3',
                cpuPercent: 45,
            });

            expect(forwarder.getEngineData('eng-1', 'ip')).toBe('10.0.0.1');
            expect(forwarder.getEngineData('eng-1', 'hostname')).toBe('studio-a');
            expect(forwarder.getEngineData('eng-1', 'buildNumber')).toBe('1.2.3');
        });

        it('broadcasts system stats via volatile emit', () => {
            const { engineManager, volatileEmit } = createMocks();

            engineManager.emit('engineSystem', 'eng-1', { cpuPercent: 45 });

            expect(volatileEmit).toHaveBeenCalledWith('engine:system', {
                engineId: 'eng-1',
                cpuPercent: 45,
            });
        });

        it('caches ips array when present', () => {
            const { forwarder, engineManager } = createMocks();

            engineManager.emit('engineSystem', 'eng-1', { ips: ['10.0.0.1', '10.0.0.2'] });

            expect(forwarder.getEngineData('eng-1', 'ips')).toEqual(['10.0.0.1', '10.0.0.2']);
        });
    });

    describe('engineLogs', () => {
        it('buffers log entries and forwards to watchers', () => {
            const { forwarder, engineManager, toRoom, roomVolatileEmit } = createMocks();

            const batch = [
                { ts: 1, msg: 'hello' },
                { ts: 2, msg: 'world' },
            ];
            engineManager.emit('engineLogs', 'eng-1', batch);

            expect(toRoom).toHaveBeenCalledWith('watch:eng-1');
            expect(roomVolatileEmit).toHaveBeenCalledWith('engine:logs', {
                engineId: 'eng-1',
                entries: batch,
            });
            expect(forwarder.getLogBuffer('eng-1')).toEqual(batch);
        });

        it('ignores non-array batches', () => {
            const { forwarder, engineManager, toRoom } = createMocks();

            engineManager.emit('engineLogs', 'eng-1', 'not-an-array');

            expect(toRoom).not.toHaveBeenCalled();
            expect(forwarder.getLogBuffer('eng-1')).toEqual([]);
        });

        it('trims log buffer when exceeding max size', () => {
            const { forwarder, engineManager } = createMocks();

            // Send a large batch that exceeds 1000
            const largeBatch = Array.from({ length: 1100 }, (_, i) => ({
                ts: i,
                msg: `entry-${i}`,
            }));
            engineManager.emit('engineLogs', 'eng-1', largeBatch);

            const buffer = forwarder.getLogBuffer('eng-1');
            expect(buffer).toHaveLength(1000);
            // Should keep the last 1000 entries
            expect((buffer[0] as any).ts).toBe(100);
            expect((buffer[999] as any).ts).toBe(1099);
        });
    });

    describe('engineDeviceList', () => {
        it('caches devices under devices:<type> and broadcasts to watchers', () => {
            const { forwarder, engineManager, toRoom, roomEmit } = createMocks();

            const devices = [{ name: 'hw:0', label: 'Built-in Audio' }];
            engineManager.emit('engineDeviceList', 'eng-1', {
                type: 'audio-source',
                devices,
            });

            expect(forwarder.getEngineData('eng-1', 'devices:audio-source')).toEqual(devices);
            expect(toRoom).toHaveBeenCalledWith('watch:eng-1');
            expect(roomEmit).toHaveBeenCalledWith('engine:deviceList', {
                engineId: 'eng-1',
                type: 'audio-source',
                devices,
            });
        });

        it('ignores payloads missing a type', () => {
            const { forwarder, engineManager } = createMocks();
            engineManager.emit('engineDeviceList', 'eng-1', { devices: [] });
            expect(forwarder.getEngineData('eng-1', 'devices:audio-source')).toBeUndefined();
        });
    });

    describe('engineLcpCommand', () => {
        it('sets running state and broadcasts on start command', () => {
            const { engineManager, engineCommands, io } = createMocks();

            engineManager.emit('engineLcpCommand', 'eng-1', { command: 'start' });

            expect(engineCommands.setRunning).toHaveBeenCalledWith('eng-1', true);
            expect(io.emit).toHaveBeenCalledWith('engine:running', {
                engineId: 'eng-1',
                running: true,
            });
        });

        it('sets stopped state and broadcasts on stop command', () => {
            const { engineManager, engineCommands, io } = createMocks();

            engineManager.emit('engineLcpCommand', 'eng-1', { command: 'stop' });

            expect(engineCommands.setRunning).toHaveBeenCalledWith('eng-1', false);
            expect(io.emit).toHaveBeenCalledWith('engine:running', {
                engineId: 'eng-1',
                running: false,
            });
        });

        it('ignores missing command field', () => {
            const { engineManager, engineCommands, io } = createMocks();

            engineManager.emit('engineLcpCommand', 'eng-1', {});

            expect(engineCommands.setRunning).not.toHaveBeenCalled();
        });
    });

    describe('engineRebootFailed', () => {
        it('forwards a typed engine:rebootFailed broadcast to every browser', () => {
            const { engineManager, io } = createMocks();
            engineManager.emit('engineRebootFailed', 'eng-1', {
                reason: 'Interactive authentication required.',
            });
            expect(io.emit).toHaveBeenCalledWith('engine:rebootFailed', {
                engineId: 'eng-1',
                reason: 'Interactive authentication required.',
            });
        });

        it('drops malformed payloads (no reason field) without throwing', () => {
            const { engineManager, io } = createMocks();
            engineManager.emit('engineRebootFailed', 'eng-1', {});
            expect(io.emit).not.toHaveBeenCalledWith(
                'engine:rebootFailed',
                expect.anything(),
            );
        });
    });

    describe('engineDynamicPorts', () => {
        it('updates config and broadcasts port changes', () => {
            const { engineManager, configStore, io } = createMocks();

            const ports = [
                { id: 'in-0', direction: 'input' },
                { id: 'out-0', direction: 'output' },
            ];
            engineManager.emit('engineDynamicPorts', 'eng-1', { moduleId: 'mod-1', ports });

            expect(configStore.modifyProfileConfig).toHaveBeenCalledWith(
                'eng-1',
                'default',
                expect.any(Function),
            );
            expect(io.emit).toHaveBeenCalledWith('engine:update', {
                engineId: 'eng-1',
                patch: [{ op: 'replace', path: '/modules/mod-1/ports', value: ports }],
            });
        });

        it('ignores when moduleId or ports missing', () => {
            const { engineManager, configStore, io } = createMocks();

            engineManager.emit('engineDynamicPorts', 'eng-1', { moduleId: 'mod-1' });

            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
            expect(io.emit).not.toHaveBeenCalled();
        });
    });

    describe('data accessors', () => {
        it('setEngineData / getEngineData round-trips', () => {
            const { forwarder } = createMocks();

            forwarder.setEngineData('eng-1', 'audioDevices', [{ id: 'hw:0' }]);
            expect(forwarder.getEngineData('eng-1', 'audioDevices')).toEqual([{ id: 'hw:0' }]);
        });

        it('getEngineData returns undefined for unknown engine', () => {
            const { forwarder } = createMocks();
            expect(forwarder.getEngineData('unknown', 'ip')).toBeUndefined();
        });

        it('getCachedStates returns empty object for unknown engine', () => {
            const { forwarder } = createMocks();
            expect(forwarder.getCachedStates('unknown')).toEqual({});
        });

        it('getLogBuffer returns empty array for unknown engine', () => {
            const { forwarder } = createMocks();
            expect(forwarder.getLogBuffer('unknown')).toEqual([]);
        });
    });

    describe('notifyRename', () => {
        it('moves cached module states, engine data, and log buffer to the new id', () => {
            const { forwarder, engineManager } = createMocks();
            engineManager.emit('engineState', 'old-id', { 'mod-1': { running: true } });
            forwarder.setEngineData('old-id', 'ip', '10.0.0.5');
            engineManager.emit('engineLogs', 'old-id', [{ level: 30, msg: 'hello' }]);

            forwarder.notifyRename('old-id', 'new-id');

            // The renamed engine inherits everything the old session had cached.
            expect(forwarder.getCachedStates('new-id')).toEqual({ 'mod-1': { running: true } });
            expect(forwarder.getEngineData('new-id', 'ip')).toBe('10.0.0.5');
            expect(forwarder.getLogBuffer('new-id')).toEqual([{ level: 30, msg: 'hello' }]);
            // …and the old id no longer points to ghost data that would leak
            // into a future engine that happens to claim the same id.
            expect(forwarder.getCachedStates('old-id')).toEqual({});
            expect(forwarder.getEngineData('old-id', 'ip')).toBeUndefined();
            expect(forwarder.getLogBuffer('old-id')).toEqual([]);
        });

        it('is a no-op when old and new ids match', () => {
            const { forwarder } = createMocks();
            forwarder.setEngineData('eng-1', 'ip', '10.0.0.5');
            forwarder.notifyRename('eng-1', 'eng-1');
            expect(forwarder.getEngineData('eng-1', 'ip')).toBe('10.0.0.5');
        });
    });
});
