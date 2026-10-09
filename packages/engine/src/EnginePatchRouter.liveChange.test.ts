import { describe, it, expect, vi } from 'vitest';
import { EnginePatchRouter } from './EnginePatchRouter.js';
import { ModuleManager } from './modules/ModuleManager.js';
import { PluginLoader } from './plugins/PluginLoader.js';
import type { PluginModule } from './plugins/PluginModule.js';

/**
 * Through the real ModuleManager and ModuleInstance, on the settings object
 * the router patches (the module shares it, as ModuleLifecycle wires it): the
 * plugin's `isLiveChange` must see the value from before the patch, or every
 * edit compares equal to itself and is applied "live" — that is, never.
 */
async function writeInputs(inputs: unknown[]) {
    const settings: Record<string, unknown> = { inputs: [{ name: 'A' }] };
    const config = { modules: { mux: { pluginId: 'mpegts-muxer', settings } }, connections: [] };
    const onLiveConfigUpdate = vi.fn(async () => {});
    // The muxer's rule in miniature: same length (a rename) is live.
    const plugin: PluginModule = {
        onInit: async () => {},
        onStart: async () => {},
        onStop: async () => {},
        onDestroy: async () => {},
        getState: () => ({ running: true, ready: true, health: 'ok', pendingRestart: false }),
        getLiveUpdatableParams: () => ['inputs'],
        isLiveChange: (_key, next, old) =>
            Array.isArray(old) && (next as unknown[]).length === old.length,
        onLiveConfigUpdate,
    };
    const moduleManager = new ModuleManager(new PluginLoader('/nonexistent'));
    moduleManager.createModule('mux', 'mpegts-muxer', settings, plugin);
    await moduleManager.startModule('mux');
    const router = new EnginePatchRouter(
        moduleManager,
        {} as any,
        { configChanged: vi.fn() } as any,
        { config: vi.fn() },
        { refreshPorts: vi.fn() } as any,
        () => config,
        () => true,
    );
    router.onPatch('manager', 'manager', [
        { op: 'replace', path: '/modules/mux/settings/inputs', value: inputs },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    return { pending: moduleManager.get('mux')!.getState().pendingRestart, onLiveConfigUpdate };
}

describe('EnginePatchRouter — a module compares an edit with the value before it', () => {
    it('an added muxer input waits for a restart instead of being swallowed as live', async () => {
        const { pending, onLiveConfigUpdate } = await writeInputs([{ name: 'A' }, { name: 'B' }]);
        expect(pending).toBe(true);
        expect(onLiveConfigUpdate).not.toHaveBeenCalled();
    });

    it('a rename still applies live', async () => {
        const { pending, onLiveConfigUpdate } = await writeInputs([{ name: 'A2' }]);
        expect(pending).toBe(false);
        expect(onLiveConfigUpdate).toHaveBeenCalledWith({ inputs: [{ name: 'A2' }] });
    });
});
