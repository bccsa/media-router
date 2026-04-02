import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatchRouter } from './PatchRouter.js';

function createMocks() {
    const configStore = {
        getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default' }),
        modifyProfileConfig: vi.fn((engineId, profile, fn) => {
            const config = { modules: {}, connections: [] };
            return fn(config);
        }),
        getProfile: vi.fn().mockReturnValue({ modules: {}, connections: [] }),
    } as any;

    const engineManager = {
        isEngineOnline: vi.fn().mockReturnValue(true),
        sendToEngine: vi.fn(),
    } as any;

    const emitted: Array<{ event: string; data: unknown }> = [];
    const io = {
        emit: vi.fn((event: string, data: unknown) => emitted.push({ event, data })),
        except: vi.fn().mockReturnThis(),
    } as any;

    const pluginRegistry = {
        find: vi.fn().mockReturnValue({
            pluginId: 'audio-input',
            displayName: 'Audio Input',
            ports: [{ id: 'audio-out', direction: 'output', streamType: 'audio/pcm' }],
            configSchema: { properties: { volume: { default: 100 } } },
            color: '#3b82f6',
            icon: 'mic',
        }),
    } as any;

    const router = new PatchRouter(configStore, engineManager, io, pluginRegistry);
    return { router, configStore, engineManager, io, pluginRegistry, emitted };
}

describe('PatchRouter', () => {
    describe('onPatch from browser', () => {
        it('applies patch to ConfigStore', () => {
            const { router, configStore } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(configStore.modifyProfileConfig).toHaveBeenCalled();
        });

        it('broadcasts to other browsers (skip sender)', () => {
            const { router, io } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(io.except).toHaveBeenCalledWith('browser-1');
        });

        it('forwards patch to engine', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(engineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'patch', expect.objectContaining({ ops: expect.any(Array) }), expect.any(Object),
            );
        });

        it('does not forward to engine if engine offline', () => {
            const { router, engineManager } = createMocks();
            engineManager.isEngineOnline.mockReturnValue(false);
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });
    });

    describe('onPatch from engine', () => {
        it('broadcasts to ALL browsers (not skip sender)', () => {
            const { router, io } = createMocks();
            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(io.emit).toHaveBeenCalledWith('engine:update', expect.objectContaining({
                engineId: 'eng-1',
                patch: expect.any(Array),
            }));
            // Should NOT call except (full broadcast)
            expect(io.except).not.toHaveBeenCalled();
        });

        it('does NOT forward back to engine', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });
    });

    describe('patch forwarding', () => {
        it('forwards patch to engine (not old commands)', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            // Should send patch, not old-style commands
            expect(engineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'patch',
                expect.objectContaining({ ops: expect.any(Array) }),
                expect.any(Object),
            );
            // Should NOT send old command format
            const calls = engineManager.sendToEngine.mock.calls;
            const commandCalls = calls.filter((c: any) => c[1] === 'command');
            expect(commandCalls).toHaveLength(0);
        });
    });

    describe('edge cases', () => {
        it('drops patch with no ops', () => {
            const { router, configStore } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', []);
            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
        });

        it('drops patch when no active profile', () => {
            const { router, configStore } = createMocks();
            configStore.getEngine.mockReturnValue({ engine_id: 'eng-1', active_profile: null });
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
        });

        it('drops patch when engine has no record', () => {
            const { router, configStore } = createMocks();
            configStore.getEngine.mockReturnValue(undefined);
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
        });
    });

    describe('preprocessOps', () => {
        it('converts connection ID-based path to index-based path', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: {},
                    connections: [
                        { id: 'conn-a', sourceModuleId: 'mod-1', sinkModuleId: 'mod-2' },
                        { id: 'conn-b', sourceModuleId: 'mod-3', sinkModuleId: 'mod-4' },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'remove', path: '/connections/conn-b' },
            ]);

            // Engine should receive index-based path
            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            expect(engineOps).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ op: 'remove', path: '/connections/1' }),
                ]),
            );
        });

        it('converts connection ID sub-path to index-based path', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: {},
                    connections: [
                        { id: 'conn-a', channelMap: [] },
                        { id: 'conn-b', channelMap: [{ srcChannel: 0, dstChannel: 0 }] },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/connections/conn-b/channelMap', value: [] },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            expect(engineOps).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ op: 'replace', path: '/connections/1/channelMap' }),
                ]),
            );
        });

        it('skips connection ID path when ID not found', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = { modules: {}, connections: [] };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'remove', path: '/connections/nonexistent' },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            // Should have no ops since the connection was not found
            expect(engineOps).toHaveLength(0);
        });

        it('module delete cascades connection removal', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: { 'mod-1': { pluginId: 'audio-input' }, 'mod-2': { pluginId: 'audio-output' } },
                    connections: [
                        { id: 'conn-a', sourceModuleId: 'mod-1', sinkModuleId: 'mod-2' },
                        { id: 'conn-b', sourceModuleId: 'mod-3', sinkModuleId: 'mod-4' },
                        { id: 'conn-c', sourceModuleId: 'mod-5', sinkModuleId: 'mod-1' },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'remove', path: '/modules/mod-1' },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            // Should remove conn-c (idx 2) first, then conn-a (idx 0), then the module
            expect(engineOps).toEqual([
                { op: 'remove', path: '/connections/2' },
                { op: 'remove', path: '/connections/0' },
                { op: 'remove', path: '/modules/mod-1' },
            ]);
        });

        it('module add enriches with defaults from configSchema', () => {
            const { router, configStore, engineManager, pluginRegistry } = createMocks();
            pluginRegistry.find.mockReturnValue({
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                ports: [{ id: 'audio-out', direction: 'output', streamType: 'audio/pcm' }],
                configSchema: {
                    properties: {
                        volume: { type: 'number', default: 100 },
                        device: { type: 'string' },
                        channels: { type: 'number', default: 2 },
                    },
                },
            });
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = { modules: {}, connections: [] };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'add', path: '/modules/mod-new', value: { pluginId: 'audio-input', settings: { volume: 50 } } },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            const addOp = engineOps.find((o: any) => o.op === 'add');
            // volume should keep user-specified 50, channels should get default 2
            expect(addOp.value.settings).toEqual({ volume: 50, channels: 2 });
            expect(addOp.value.ports).toEqual([{ id: 'audio-out', direction: 'output', streamType: 'audio/pcm' }]);
        });

        it('module add with unknown plugin passes through without enrichment', () => {
            const { router, configStore, engineManager, pluginRegistry } = createMocks();
            pluginRegistry.find.mockReturnValue(undefined);
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = { modules: {}, connections: [] };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'add', path: '/modules/mod-new', value: { pluginId: 'unknown-plugin' } },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            const addOp = engineOps.find((o: any) => o.op === 'add');
            expect(addOp.value.pluginId).toBe('unknown-plugin');
            // No settings/ports enrichment since manifest not found
            expect(addOp.value.settings).toBeUndefined();
        });

        it('dynamic port regeneration on pairCount change', () => {
            const { router, configStore, engineManager, pluginRegistry } = createMocks();
            pluginRegistry.find.mockReturnValue({
                pluginId: 'audio-matrix',
                ports: [], // empty = dynamic ports
            });
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: {
                        'mod-1': { pluginId: 'audio-matrix', settings: { pairCount: 2 }, ports: [] },
                    },
                    connections: [],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/pairCount', value: 3 },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            // Should have the pairCount replace + a ports replace
            const portsOp = engineOps.find((o: any) => o.path === '/modules/mod-1/ports');
            expect(portsOp).toBeDefined();
            expect(portsOp.op).toBe('replace');
            expect(portsOp.value).toHaveLength(6); // 3 inputs + 3 outputs
            expect(portsOp.value[0]).toEqual({ id: 'in-0', direction: 'input', streamType: 'audio/pcm', label: 'In 1', maxConnections: -1 });
            expect(portsOp.value[3]).toEqual({ id: 'out-0', direction: 'output', streamType: 'audio/pcm', label: 'Out 1', maxConnections: -1 });
        });

        it('does not regenerate ports when manifest has static ports', () => {
            const { router, configStore, engineManager, pluginRegistry } = createMocks();
            pluginRegistry.find.mockReturnValue({
                pluginId: 'audio-input',
                ports: [{ id: 'out-0', direction: 'output' }], // non-empty = static ports
            });
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: {
                        'mod-1': { pluginId: 'audio-input', settings: { pairCount: 2 }, ports: [] },
                    },
                    connections: [],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/pairCount', value: 4 },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            // Should only have the pairCount replace, no ports replace
            expect(engineOps).toHaveLength(1);
            expect(engineOps[0].path).toBe('/modules/mod-1/settings/pairCount');
        });

        it('channel map cleanup on channels change', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: { 'mod-1': { pluginId: 'audio-input' } },
                    connections: [
                        {
                            id: 'conn-a',
                            sourceModuleId: 'mod-1',
                            sinkModuleId: 'mod-2',
                            channelMap: [
                                { srcChannel: 0, dstChannel: 0 },
                                { srcChannel: 1, dstChannel: 1 },
                                { srcChannel: 2, dstChannel: 2 },
                            ],
                        },
                        {
                            id: 'conn-b',
                            sourceModuleId: 'mod-3',
                            sinkModuleId: 'mod-1',
                            channelMap: [
                                { srcChannel: 0, dstChannel: 0 },
                                { srcChannel: 1, dstChannel: 3 },
                            ],
                        },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/channels', value: 2 },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;

            // conn-a: mod-1 is source, channels reduced to 2, srcChannel >= 2 removed
            const connAOp = engineOps.find((o: any) => o.path === '/connections/0/channelMap');
            expect(connAOp).toBeDefined();
            expect(connAOp.value).toEqual([
                { srcChannel: 0, dstChannel: 0 },
                { srcChannel: 1, dstChannel: 1 },
            ]);

            // conn-b: mod-1 is sink, channels reduced to 2, dstChannel >= 2 removed
            const connBOp = engineOps.find((o: any) => o.path === '/connections/1/channelMap');
            expect(connBOp).toBeDefined();
            expect(connBOp.value).toEqual([
                { srcChannel: 0, dstChannel: 0 },
            ]);
        });

        it('channel map cleanup skips connections without channel maps', () => {
            const { router, configStore, engineManager } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: { 'mod-1': { pluginId: 'audio-input' } },
                    connections: [
                        { id: 'conn-a', sourceModuleId: 'mod-1', sinkModuleId: 'mod-2' },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/channels', value: 2 },
            ]);

            const engineCall = engineManager.sendToEngine.mock.calls[0];
            const engineOps = engineCall[2].ops;
            // Only the channels replace, no channelMap ops
            expect(engineOps).toHaveLength(1);
        });
    });

    describe('enrichOpsForBroadcast', () => {
        it('enriches module add with manifest data for broadcast', () => {
            const { router, configStore, io, pluginRegistry } = createMocks();
            pluginRegistry.find.mockReturnValue({
                pluginId: 'audio-input',
                color: '#3b82f6',
                icon: 'mic',
                statusSections: [{ label: 'Status' }],
                faceWidgets: [{ type: 'vu-meter' }],
                ports: [{ id: 'out-0' }],
                configSchema: { properties: { volume: { default: 100 } } },
            });
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = { modules: {}, connections: [] };
                return fn(config);
            });

            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'add', path: '/modules/mod-new', value: { pluginId: 'audio-input', settings: {} } },
            ]);

            // Browser broadcast should have enriched data
            const emitCall = io.emit.mock.calls[0];
            const browserOps = emitCall[1].patch;
            const addOp = browserOps.find((o: any) => o.op === 'add');
            expect(addOp.value).toEqual(expect.objectContaining({
                instanceId: 'mod-new',
                running: false,
                health: 'stopped',
                pendingRestart: false,
                color: '#3b82f6',
                icon: 'mic',
                statusSections: [{ label: 'Status' }],
                faceWidgets: [{ type: 'vu-meter' }],
            }));
        });

        it('passes through non-add ops unchanged', () => {
            const { router, configStore, io } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = { modules: { 'mod-1': { displayName: 'Old' } }, connections: [] };
                return fn(config);
            });

            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New' },
            ]);

            const emitCall = io.emit.mock.calls[0];
            const browserOps = emitCall[1].patch;
            expect(browserOps).toEqual([
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New' },
            ]);
        });
    });

    describe('engine vs browser ops routing', () => {
        it('engine receives processedOps (index-based), browsers receive original ops', () => {
            const { router, configStore, engineManager, io } = createMocks();
            configStore.modifyProfileConfig.mockImplementation((_eid: string, _pid: string, fn: any) => {
                const config = {
                    modules: {},
                    connections: [
                        { id: 'conn-a', sourceModuleId: 'mod-1', sinkModuleId: 'mod-2' },
                    ],
                };
                return fn(config);
            });

            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'remove', path: '/connections/conn-a' },
            ]);

            // Engine gets index-based path
            const engineOps = engineManager.sendToEngine.mock.calls[0][2].ops;
            expect(engineOps[0].path).toBe('/connections/0');

            // Browsers get original ID-based path
            const exceptCall = io.except.mock.calls[0];
            expect(exceptCall[0]).toBe('browser-1');
            const browserEmit = io.except('browser-1').emit;
            // io.except returns `this` (the io mock), so emit is io.emit after except
            // The broadcast call is chained: io.except(senderId).emit(...)
            // Since except returns this, the emit call is on io itself
            const emitCalls = io.emit.mock.calls;
            const browserOps = emitCalls[0][1].patch;
            expect(browserOps[0].path).toBe('/connections/conn-a');
        });
    });
});
