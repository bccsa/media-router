import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleManager } from './ModuleManager.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import type { ModuleServices, PluginModule } from '../plugins/PluginModule.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';

describe('ModuleManager', () => {
    let manager: ModuleManager;
    let pluginLoader: PluginLoader;

    beforeEach(() => {
        pluginLoader = new PluginLoader('/nonexistent'); // no real plugins needed
        manager = new ModuleManager(pluginLoader);
    });

    it('creates a module', () => {
        const mod = manager.createModule('test-1', 'example', { message: 'hello' });
        expect(mod.instanceId).toBe('test-1');
        expect(mod.pluginId).toBe('example');
        expect(manager.size).toBe(1);
    });

    it('starts and stops a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.startModule('test-1');

        const mod = manager.get('test-1')!;
        expect(mod.running).toBe(true);

        await manager.stopModule('test-1');
        expect(mod.running).toBe(false);
    });

    it('emits stateChange on start/stop', async () => {
        manager.createModule('test-1', 'example', {});

        const states: Array<{ id: string; state: ModuleRuntimeState }> = [];
        manager.on('stateChange', (id: string, state: ModuleRuntimeState) => {
            states.push({ id, state });
        });

        await manager.startModule('test-1');
        await manager.stopModule('test-1');

        expect(states.length).toBeGreaterThanOrEqual(2);
        expect(states[0].id).toBe('test-1');
    });

    it('deletes a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.deleteModule('test-1');
        expect(manager.size).toBe(0);
        expect(manager.get('test-1')).toBeUndefined();
    });

    it('stops all modules', async () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});
        await manager.startModule('a');
        await manager.startModule('b');

        await manager.stopAll();
        expect(manager.get('a')!.running).toBe(false);
        expect(manager.get('b')!.running).toBe(false);
    });

    it('getAllStates returns all module states', () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});

        const states = manager.getAllStates();
        expect(Object.keys(states)).toEqual(['a', 'b']);
        expect(states.a.health).toBe('stopped');
    });

    it('throws on duplicate instanceId', () => {
        manager.createModule('dup', 'example', {});
        expect(() => manager.createModule('dup', 'example', {})).toThrow('already exists');
    });
});

/**
 * The engine-wide time-sync contract reaches a module the same way the clock
 * authority does — through the services bag built here. A module resolves the
 * mode from `services.timeSyncContract`, so losing it in this wiring would
 * silently put every pipeline back on the legacy net-clock path.
 */
describe('ModuleManager — time-sync contract in the services bag', () => {
    /** The four services `createModule` requires before it builds a bag at all. */
    const deps = () =>
        [{}, {}, {}, {}] as unknown as [
            PipeWireManager,
            MediaRouter,
            ProcessManager,
            DeviceProviderRegistry,
        ];

    /** A plugin that records the services it was initialised with. */
    const capturingPlugin = (): PluginModule & { seen: ModuleServices | undefined } => ({
        seen: undefined as ModuleServices | undefined,
        async onInit(_config: Record<string, unknown>, services?: ModuleServices) {
            (this as unknown as { seen: ModuleServices | undefined }).seen = services;
        },
        async onStart() {},
        async onStop() {},
        async onDestroy() {},
        getState: () => ({
            running: false,
            ready: false,
            health: 'stopped' as const,
            pendingRestart: false,
        }),
        getLiveUpdatableParams: () => [],
        async onLiveConfigUpdate() {},
    });

    const servicesSeen = async (timeSyncContract?: boolean): Promise<ModuleServices | undefined> => {
        const manager = new ModuleManager(
            new PluginLoader('/nonexistent'),
            ...deps(),
            undefined,
            timeSyncContract,
        );
        const plugin = capturingPlugin();
        manager.createModule('m1', 'example', {}, plugin);
        await manager.startModule('m1');
        return plugin.seen;
    };

    it('passes the flag through when the engine runs the contract', async () => {
        expect((await servicesSeen(true))!.timeSyncContract).toBe(true);
    });

    it('leaves it absent when the engine does not', async () => {
        expect((await servicesSeen(false))!.timeSyncContract).toBeUndefined();
        expect((await servicesSeen())!.timeSyncContract).toBeUndefined();
    });
});
