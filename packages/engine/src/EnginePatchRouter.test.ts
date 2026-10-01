import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    const localServer = { configChanged: vi.fn() } as any;

    const localChanges = { config: vi.fn() } as any;

    const lifecycle = {
        refreshPorts: vi.fn(),
        startSingle: vi.fn(async () => {}),
        deleteSingle: vi.fn(async () => {}),
        enable: vi.fn(async () => {}),
        disable: vi.fn(async () => {}),
    } as any;

    const router = new EnginePatchRouter(
        moduleManager,
        mediaRouter,
        localServer,
        localChanges,
        lifecycle,
        () => config,
        () => opts.modulesRunning ?? true,
    );

    return { router, config, moduleManager, mediaRouter, localServer, localChanges, lifecycle };
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

        it('tells the router tree', () => {
            const { router, localServer } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(localServer.configChanged).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
        });

        it('does NOT forward back to manager', () => {
            const { router, localChanges } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(localChanges.config).not.toHaveBeenCalled();
        });
    });

    describe('onPatch from the router tree', () => {
        it('applies patch to config', () => {
            const { router, config } = createMocks();
            router.onPatch('tree-1', 'local', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect((config.modules as any)['mod-1'].settings.volume).toBe(50);
        });

        it('tells the rest of the router tree (skip the writer)', () => {
            const { router, localServer } = createMocks();
            router.onPatch('tree-1', 'local', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect(localServer.configChanged).toHaveBeenCalledWith(expect.any(Array), 'tree-1');
        });

        it('forwards to manager', () => {
            const { router, localChanges } = createMocks();
            router.onPatch('tree-1', 'local', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect(localChanges.config).toHaveBeenCalledWith(expect.any(Array));
        });

        it('an unmute mutes the rest of its interlock here, and everyone sees the mutes', () => {
            const { router, config, localServer, localChanges, moduleManager } = createMocks();
            const mods = config.modules as Record<string, any>;
            mods['mic-a'] = { pluginId: 'audio-input', settings: { audioEnabled: true } };
            mods['mic-b'] = { pluginId: 'audio-input', settings: { audioEnabled: false } };
            config.interlocks = [{ id: 'ilk-1', name: 'Mics', members: ['mic-a', 'mic-b'] }];
            const unmute = { op: 'replace' as const, path: '/modules/mic-b/settings/audioEnabled', value: true };
            const mute = { op: 'replace', path: '/modules/mic-a/settings/audioEnabled', value: false };
            router.onPatch('tree-1', 'local', [unmute]);
            expect([mods['mic-a'].settings.audioEnabled, mods['mic-b'].settings.audioEnabled]).toEqual([false, true]);
            // The writer has its own op; the mute goes to every viewer, the writer too.
            expect(localServer.configChanged).toHaveBeenCalledWith([unmute], 'tree-1');
            expect(localServer.configChanged).toHaveBeenCalledWith([mute]);
            // The manager: the ops, then the whole group as it stands.
            expect(localChanges.config).toHaveBeenCalledWith([mute, unmute, mute, unmute]);
            expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mic-a', expect.objectContaining({ audioEnabled: false }));
        });

        it('applies them to the manager’s writes too, and reports the group back', () => {
            const { router, config, localServer, localChanges } = createMocks();
            const mods = config.modules as Record<string, any>;
            mods['mic-a'] = { pluginId: 'audio-input', settings: { audioEnabled: true } };
            mods['mic-b'] = { pluginId: 'audio-input', settings: { audioEnabled: false } };
            config.interlocks = [{ id: 'ilk-1', name: 'Mics', members: ['mic-a', 'mic-b'] }];
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/modules/mic-b/settings/audioEnabled', value: true }]);
            expect(mods['mic-a'].settings.audioEnabled).toBe(false);
            expect(localServer.configChanged).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mic-a/settings/audioEnabled', value: false },
                { op: 'replace', path: '/modules/mic-b/settings/audioEnabled', value: true },
            ]);
            expect(localChanges.config).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mic-a/settings/audioEnabled', value: false },
                { op: 'replace', path: '/modules/mic-b/settings/audioEnabled', value: true },
            ]);
        });

        it('a batch that unmutes two members, or new members, leaves one live: the first in the group', () => {
            const { router, config } = createMocks();
            const mods = config.modules as Record<string, any>;
            for (const id of ['a', 'b', 'c']) mods[id] = { pluginId: 'audio-input', settings: { audioEnabled: false } };
            config.interlocks = [{ id: 'ilk-1', name: 'Mics', members: ['a', 'b'] }];
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/b/settings/audioEnabled', value: true },
                { op: 'replace', path: '/modules/a/settings/audioEnabled', value: true },
            ]);
            expect([mods.a.settings.audioEnabled, mods.b.settings.audioEnabled]).toEqual([true, false]);
            mods.c.settings.audioEnabled = true;
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/interlocks/0/members', value: ['c', 'a', 'b'] }]);
            expect([mods.c.settings.audioEnabled, mods.a.settings.audioEnabled]).toEqual([true, false]);
        });

        it('leaves writes that touch no interlock alone', () => {
            const { router, localChanges } = createMocks();
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/modules/mod-1/settings/volume', value: 3 }]);
            expect(localChanges.config).not.toHaveBeenCalled();
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

    describe('side effects — batched connection removes', () => {
        /** Ids the live router was actually told to tear down, in call order. */
        const tornDown = (mediaRouter: any): string[] =>
            mediaRouter.removeConnection.mock.calls.map((c: unknown[]) => c[0] as string);

        it('tears down each connection of a two-remove batch exactly once', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [
                { id: 'conn-a', sourceModuleId: 'a', sinkModuleId: 'x' },
                { id: 'conn-b', sourceModuleId: 'b', sinkModuleId: 'y' },
                { id: 'conn-keep', sourceModuleId: 'c', sinkModuleId: 'z' },
            ];

            // The manager emits progressively-valid indices: after the first
            // remove the array shifts, so conn-b is at index 0 too. Resolving
            // both against the pre-patch array named conn-a twice — conn-b's
            // live routing was then never torn down.
            router.onPatch('manager', 'manager', [
                { op: 'remove', path: '/connections/0' },
                { op: 'remove', path: '/connections/0' },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(tornDown(mediaRouter)).toEqual(['conn-a', 'conn-b']);
            // Config and live state agree: everything that left the config was
            // disconnected, and the survivor was left alone.
            expect((config.connections as Array<{ id: string }>).map((c) => c.id)).toEqual([
                'conn-keep',
            ]);
            expect(tornDown(mediaRouter)).not.toContain('conn-keep');
        });

        it('resolves id-based removes against the shifting array', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [
                { id: 'conn-a', sourceModuleId: 'a', sinkModuleId: 'x' },
                { id: 'conn-b', sourceModuleId: 'b', sinkModuleId: 'y' },
            ];

            // Browsers address connections by id — those never shift, and
            // must keep resolving to themselves alongside index-based ops.
            router.onPatch('manager', 'manager', [
                { op: 'remove', path: '/connections/conn-b' },
                { op: 'remove', path: '/connections/0' },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(tornDown(mediaRouter)).toEqual(['conn-b', 'conn-a']);
            expect(config.connections).toEqual([]);
        });

        it('handles a mixed add + remove batch', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [
                { id: 'conn-a', sourceModuleId: 'a', sinkModuleId: 'x' },
                { id: 'conn-b', sourceModuleId: 'b', sinkModuleId: 'y' },
            ];

            router.onPatch('manager', 'manager', [
                { op: 'remove', path: '/connections/0' },
                {
                    op: 'add',
                    path: '/connections/-',
                    value: {
                        id: 'conn-new',
                        sourceModuleId: 'n',
                        sourcePortId: 'out',
                        sinkModuleId: 'm',
                        sinkPortId: 'in',
                    },
                },
                // conn-b sat at index 1 pre-patch; the remove shifted it to 0.
                { op: 'remove', path: '/connections/0' },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(tornDown(mediaRouter)).toEqual(['conn-a', 'conn-b']);
            expect(mediaRouter.createConnection).toHaveBeenCalledWith(
                'n',
                'out',
                'm',
                'in',
                undefined,
            );
            expect((config.connections as Array<{ id: string }>).map((c) => c.id)).toEqual([
                'conn-new',
            ]);
        });

        it('leaves the descending-index module-delete cascade unchanged', async () => {
            const { router, config, mediaRouter, lifecycle } = createMocks();
            (config as any).connections = [
                { id: 'conn-0', sourceModuleId: 'mod-1', sinkModuleId: 'x' },
                { id: 'conn-1', sourceModuleId: 'other', sinkModuleId: 'y' },
                { id: 'conn-2', sourceModuleId: 'z', sinkModuleId: 'mod-1' },
            ];

            // cascadeModuleDelete emits connection removes in reverse index
            // order precisely so earlier removals don't shift later indices.
            router.onPatch('manager', 'manager', [
                { op: 'remove', path: '/connections/2' },
                { op: 'remove', path: '/connections/0' },
                { op: 'remove', path: '/modules/mod-1' },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(tornDown(mediaRouter)).toEqual(['conn-2', 'conn-0']);
            expect(lifecycle.deleteSingle).toHaveBeenCalledWith('mod-1');
            expect((config.connections as Array<{ id: string }>).map((c) => c.id)).toEqual([
                'conn-1',
            ]);
        });

        it('resolves channelMap updates against the shifted array', async () => {
            const { router, config, mediaRouter } = createMocks();
            (config as any).connections = [
                { id: 'conn-a', sourceModuleId: 'a', sinkModuleId: 'x' },
                { id: 'conn-b', sourceModuleId: 'b', sinkModuleId: 'y', channelMap: null },
            ];

            router.onPatch('manager', 'manager', [
                { op: 'remove', path: '/connections/0' },
                {
                    op: 'replace',
                    path: '/connections/0/channelMap',
                    value: [{ source: 0, sink: 0 }],
                },
            ]);

            await new Promise((r) => setTimeout(r, 10));
            expect(mediaRouter.removeConnection).toHaveBeenCalledWith('conn-a');
            expect(mediaRouter.updateChannelMap).toHaveBeenCalledWith('conn-b', [
                { source: 0, sink: 0 },
            ]);
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

    describe('throttled forward to manager', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());
        const vol = (value: number) => [{ op: 'replace' as const, path: '/modules/mod-1/settings/volume', value }];

        it('sends the first op at once and batches the rest of the 100 ms', () => {
            const { router, localChanges } = createMocks();
            router.onPatch('tree-1', 'local', vol(50));
            expect(localChanges.config).toHaveBeenCalledTimes(1);
            router.onPatch('tree-1', 'local', vol(60));
            router.onPatch('tree-1', 'local', vol(70));
            expect(localChanges.config).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(100);
            expect(localChanges.config).toHaveBeenCalledTimes(2);
            expect(localChanges.config.mock.calls[1][0]).toHaveLength(2);
        });

        it('keeps forwarding during a continuous drag, not only after it stops', () => {
            const { router, localChanges } = createMocks();
            // A fader writing every 90 ms for ~1 s.
            for (let i = 0; i < 12; i++) {
                router.onPatch('tree-1', 'local', vol(50 + i));
                vi.advanceTimersByTime(90);
            }
            expect(localChanges.config.mock.calls.length).toBeGreaterThanOrEqual(10);
            vi.advanceTimersByTime(100);
            expect(localChanges.config.mock.calls.flatMap((c: any[]) => c[0]).at(-1).value).toBe(61);
        });

        it('sends nothing pending after destroy', () => {
            const { router, localChanges } = createMocks();
            router.onPatch('tree-1', 'local', vol(50));
            router.onPatch('tree-1', 'local', vol(60));
            router.destroy();
            vi.advanceTimersByTime(150);
            expect(localChanges.config).toHaveBeenCalledTimes(1);
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

    describe('edge cases', () => {
        it('drops patch with no ops', () => {
            const { router, localServer } = createMocks();
            router.onPatch('manager', 'manager', []);
            expect(localServer.configChanged).not.toHaveBeenCalled();
        });

        it('drops patch when no config', () => {
            const moduleManager = {} as any;
            const mediaRouter = {} as any;
            const localServer = { configChanged: vi.fn() } as any;
            const localChanges = { config: vi.fn() } as any;
            const lifecycle = {} as any;
            const router = new EnginePatchRouter(
                moduleManager,
                mediaRouter,
                localServer,
                localChanges,
                lifecycle,
                () => null,
                () => false,
            );
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/x', value: 1 }]);
            expect(localServer.configChanged).not.toHaveBeenCalled();
        });
    });
});
