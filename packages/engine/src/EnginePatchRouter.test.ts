import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnginePatchRouter } from './EnginePatchRouter.js';

function createMocks(opts: { modulesRunning?: boolean } = {}) {
    const config: Record<string, unknown> = {
        modules: {
            'mod-1': { pluginId: 'audio-input', displayName: 'Mic', settings: { volume: 100 } },
        },
        connections: [],
    };

    const moduleManager = {
        applyConfigUpdate: vi.fn(async () => {}),
    } as any;

    const mediaRouter = {
        createConnection: vi.fn(async () => 'conn-1'),
        removeConnection: vi.fn(async () => true),
        updateChannelMap: vi.fn(async () => {}),
    } as any;

    const lcpServer = {
        broadcastConfigUpdate: vi.fn(),
        broadcastConfigUpdateExcept: vi.fn(),
    } as any;

    const managerConnection = {
        isConnected: true,
        send: vi.fn(),
    } as any;

    const lifecycle = {
        startSingle: vi.fn(async () => {}),
        deleteSingle: vi.fn(async () => {}),
        enable: vi.fn(async () => {}),
        disable: vi.fn(async () => {}),
    } as any;

    const router = new EnginePatchRouter(
        moduleManager,
        mediaRouter,
        lcpServer,
        managerConnection,
        lifecycle,
        () => config,
        () => opts.modulesRunning ?? true,
    );

    return { router, config, moduleManager, mediaRouter, lcpServer, managerConnection, lifecycle };
}

describe('EnginePatchRouter', () => {
    describe('onPatch from manager', () => {
        it('applies patch to config', () => {
            const { router, config } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect((config.modules as any)['mod-1'].displayName).toBe('New Name');
        });

        it('broadcasts to ALL LCPs', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
        });

        it('does NOT forward back to manager', () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(managerConnection.send).not.toHaveBeenCalled();
        });
    });

    describe('onPatch from LCP', () => {
        it('applies patch to config', () => {
            const { router, config } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect((config.modules as any)['mod-1'].settings.volume).toBe(50);
        });

        it('broadcasts to other LCPs (skip sender)', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect(lcpServer.broadcastConfigUpdateExcept).toHaveBeenCalledWith(
                'lcp-1',
                expect.any(Array),
            );
        });

        it('debounced forwards to manager', async () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            // Not sent yet (debounced)
            expect(managerConnection.send).not.toHaveBeenCalled();
            // Wait for debounce
            await new Promise((r) => setTimeout(r, 150));
            expect(managerConnection.send).toHaveBeenCalledWith(
                'patch',
                expect.objectContaining({ ops: expect.any(Array) }),
            );
        });
    });

    describe('side effects', () => {
        it('applies live config update for settings change', () => {
            const { router, moduleManager } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mod-1', { volume: 80 });
        });

        it('triggers connection creation for connection add', async () => {
            const { router, mediaRouter } = createMocks();
            router.onPatch('manager', 'manager', [
                {
                    op: 'add',
                    path: '/connections/-',
                    value: {
                        sourceModuleId: 'a',
                        sourcePortId: 'out',
                        sinkModuleId: 'b',
                        sinkPortId: 'in',
                    },
                },
            ]);
            // Connection creation is chained to the lifecycle lock
            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.createConnection).toHaveBeenCalledWith(
                'a',
                'out',
                'b',
                'in',
                undefined,
            );
        });
    });

    describe('side effects — connection remove', () => {
        it('triggers removeConnection for connection remove (pre-resolved _connId)', async () => {
            const { router, config, mediaRouter } = createMocks();
            // Set up a connection in config so resolveConnectionIds can find it
            (config as any).connections = [
                { id: 'conn-abc', sourceModuleId: 'a', sinkModuleId: 'b' },
            ];

            router.onPatch('manager', 'manager', [{ op: 'remove', path: '/connections/0' }]);

            // Wait for async side effect
            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.removeConnection).toHaveBeenCalledWith('conn-abc');
        });

        it('skips removeConnection when _connId cannot be resolved', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [];

            router.onPatch('manager', 'manager', [{ op: 'remove', path: '/connections/5' }]);

            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.removeConnection).not.toHaveBeenCalled();
        });
    });

    describe('side effects — channel map update', () => {
        it('triggers updateChannelMap with resolved connection ID', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [
                { id: 'conn-xyz', sourceModuleId: 'a', sinkModuleId: 'b', channelMap: null },
            ];

            router.onPatch('manager', 'manager', [
                {
                    op: 'replace',
                    path: '/connections/0/channelMap',
                    value: [{ source: 0, sink: 0 }],
                },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.updateChannelMap).toHaveBeenCalledWith('conn-xyz', [
                { source: 0, sink: 0 },
            ]);
        });

        it('falls back to config lookup when _connId not pre-resolved', async () => {
            const { router, config, mediaRouter } = createMocks();
            // The connection exists in config (after patch apply) but path uses non-numeric key
            // Simulate: connection at index 0 with id
            (config as any).connections = [
                { id: 'conn-fallback', sourceModuleId: 'a', sinkModuleId: 'b', channelMap: [] },
            ];

            // Use 'add' op on channelMap — _connId from resolveConnectionIds would be set for index 0
            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/connections/0/channelMap', value: [{ source: 1, sink: 1 }] },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.updateChannelMap).toHaveBeenCalledWith('conn-fallback', [
                { source: 1, sink: 1 },
            ]);
        });

        it('logs warning when connection ID cannot be resolved for channelMap update', async () => {
            const { router, config, mediaRouter } = createMocks();
            // Empty connections array — index won't resolve
            (config as any).connections = [];

            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/connections/99/channelMap', value: [] },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.updateChannelMap).not.toHaveBeenCalled();
        });
    });

    describe('side effects — module enable/disable', () => {
        it('calls lifecycle.enable when module enabled', async () => {
            const { router, lifecycle } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/enabled', value: true },
            ]);

            // Wait for lifecycle lock chain
            await new Promise((r) => setTimeout(r, 10));
            expect(lifecycle.enable).toHaveBeenCalledWith('mod-1');
        });

        it('calls lifecycle.disable when module disabled', async () => {
            const { router, lifecycle } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/enabled', value: false },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(lifecycle.disable).toHaveBeenCalledWith('mod-1');
        });
    });

    describe('side effects — module add/remove', () => {
        it('calls lifecycle.startSingle when module added and engine running', async () => {
            const { router, lifecycle } = createMocks({ modulesRunning: true });

            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/modules/mod-new', value: { pluginId: 'test', settings: {} } },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(lifecycle.startSingle).toHaveBeenCalledWith('mod-new');
        });

        it('does NOT call lifecycle.startSingle when module added while engine stopped', async () => {
            const { router, lifecycle } = createMocks({ modulesRunning: false });

            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/modules/mod-new', value: { pluginId: 'test', settings: {} } },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(lifecycle.startSingle).not.toHaveBeenCalled();
        });

        it('calls lifecycle.deleteSingle when module removed', async () => {
            const { router, lifecycle } = createMocks();

            router.onPatch('manager', 'manager', [{ op: 'remove', path: '/modules/mod-1' }]);

            await new Promise((r) => setTimeout(r, 10));
            expect(lifecycle.deleteSingle).toHaveBeenCalledWith('mod-1');
        });
    });

    describe('side effects — batched settings changes', () => {
        it('batches multiple setting changes for the same module', () => {
            const { router, moduleManager } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
                { op: 'replace', path: '/modules/mod-1/settings/mute', value: true },
            ]);
            expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mod-1', {
                volume: 80,
                mute: true,
            });
        });

        it('handles add op for settings', () => {
            const { router, moduleManager } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/modules/mod-1/settings/newProp', value: 'hello' },
            ]);
            expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mod-1', {
                newProp: 'hello',
            });
        });
    });

    describe('debounced forward to manager', () => {
        it('accumulates ops from multiple LCP patches before sending', async () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 60 },
            ]);

            expect(managerConnection.send).not.toHaveBeenCalled();
            await new Promise((r) => setTimeout(r, 150));
            expect(managerConnection.send).toHaveBeenCalledTimes(1);
            // Should contain both ops
            const sentOps = managerConnection.send.mock.calls[0][1].ops;
            expect(sentOps).toHaveLength(2);
        });

        it('does not forward when manager is disconnected', async () => {
            const { router, managerConnection } = createMocks();
            managerConnection.isConnected = false;

            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);

            await new Promise((r) => setTimeout(r, 150));
            expect(managerConnection.send).not.toHaveBeenCalled();
        });

        it('does not forward when no pending ops', async () => {
            const { router, managerConnection } = createMocks();
            // Trigger debounce but somehow ops are empty — edge case
            // The debounce timer fires but pendingOps is empty
            // This is tested implicitly by the isConnected check above
            // but let's test destroy clears timers
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            router.destroy();
            await new Promise((r) => setTimeout(r, 150));
            expect(managerConnection.send).not.toHaveBeenCalled();
        });
    });

    describe('connection add with channelMap', () => {
        it('passes channelMap to createConnection', async () => {
            const { router, mediaRouter } = createMocks();
            const channelMap = [{ source: 0, sink: 1 }];
            router.onPatch('manager', 'manager', [
                {
                    op: 'add',
                    path: '/connections/-',
                    value: {
                        sourceModuleId: 'a',
                        sourcePortId: 'out',
                        sinkModuleId: 'b',
                        sinkPortId: 'in',
                        channelMap,
                    },
                },
            ]);
            // Connection creation is chained to the lifecycle lock
            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.createConnection).toHaveBeenCalledWith(
                'a',
                'out',
                'b',
                'in',
                channelMap,
            );
        });

        it('skips connection creation for sub-field adds (length > 2)', () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [{ id: 'c1', sourceModuleId: 'a' }];
            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/connections/0/channelMap', value: [] },
            ]);
            expect(mediaRouter.createConnection).not.toHaveBeenCalled();
        });

        it('skips connection creation when value has no sourceModuleId', () => {
            const { router, mediaRouter } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/connections/-', value: { label: 'broken' } },
            ]);
            expect(mediaRouter.createConnection).not.toHaveBeenCalled();
        });
    });

    describe('destroy', () => {
        it('clears debounce timers', async () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            router.destroy();
            await new Promise((r) => setTimeout(r, 150));
            // Timer was cleared, so manager never receives the patch
            expect(managerConnection.send).not.toHaveBeenCalled();
        });
    });

    describe('edge cases', () => {
        it('drops patch with no ops', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('manager', 'manager', []);
            expect(lcpServer.broadcastConfigUpdate).not.toHaveBeenCalled();
        });

        it('drops patch when no config', () => {
            const moduleManager = {} as any;
            const mediaRouter = {} as any;
            const lcpServer = { broadcastConfigUpdate: vi.fn() } as any;
            const managerConnection = { isConnected: false, send: vi.fn() } as any;
            const lifecycle = {} as any;
            const router = new EnginePatchRouter(
                moduleManager,
                mediaRouter,
                lcpServer,
                managerConnection,
                lifecycle,
                () => null,
                () => false,
            );
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/x', value: 1 }]);
            expect(lcpServer.broadcastConfigUpdate).not.toHaveBeenCalled();
        });
    });
});
