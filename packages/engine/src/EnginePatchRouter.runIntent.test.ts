import { describe, it, expect, vi } from 'vitest';
import { EnginePatchRouter } from './EnginePatchRouter.js';
import { ModuleLifecycle } from './modules/ModuleLifecycle.js';
import { ModuleManager } from './modules/ModuleManager.js';
import { ModuleRunController } from './modules/ModuleRunController.js';
import { MediaRouter } from './routing/MediaRouter.js';
import { PluginLoader } from './plugins/PluginLoader.js';

/**
 * Through the real run controller, lifecycle and module manager (no-op
 * plugins), wired as the Engine wires them: Enable on a stopped engine must
 * start nothing — neither the dormant instance a Stop leaves behind nor a
 * module never created — and the next Start brings it up with the rest. One
 * module per case: an enable that does start holds the lifecycle lock for the
 * 200 ms PipeWire settle, which would hide a second one behind it.
 */
function engine() {
    const config = {
        modules: {
            'mod-a': { pluginId: 'example', enabled: true, settings: {}, ports: [] },
            'mod-b': { pluginId: 'example', enabled: false, settings: {}, ports: [] },
        },
        connections: [],
    };
    const pipeWire = { cleanupOrphans: vi.fn(async () => {}) } as any;
    const mediaRouter = new MediaRouter();
    const moduleManager = new ModuleManager(
        new PluginLoader('/nonexistent'),
        pipeWire,
        mediaRouter,
    );
    const lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, pipeWire, () => config);
    const run = new ModuleRunController(lifecycle, () => {});
    const router = new EnginePatchRouter(
        moduleManager,
        mediaRouter,
        { configChanged: vi.fn() } as any,
        { config: vi.fn() },
        lifecycle,
        () => config,
        () => run.isRunning,
    );
    const setEnabled = (id: string, value: boolean) =>
        router.onPatch('manager', 'manager', [
            { op: 'replace', path: `/modules/${id}/enabled`, value },
        ]);
    const running = (id: string) => moduleManager.get(id)?.running ?? false;
    return { run, setEnabled, running, moduleManager };
}

describe('EnginePatchRouter — Enable follows the engine run intent', () => {
    it('on a stopped engine Enable leaves a dormant instance stopped; Start brings it up', async () => {
        const { run, setEnabled, running } = engine();
        await run.start();
        setEnabled('mod-a', false);
        await vi.waitFor(() => expect(running('mod-a')).toBe(false));
        await run.stop(); // the instance stays in the map, stopped

        setEnabled('mod-a', true);
        await new Promise((r) => setTimeout(r, 20));
        expect(running('mod-a')).toBe(false);

        await run.start();
        expect(running('mod-a')).toBe(true);
    });

    it('on a stopped engine Enable creates nothing; Start brings the module up', async () => {
        const { run, setEnabled, running, moduleManager } = engine();
        await run.start();
        await run.stop(); // mod-b is disabled: never created

        setEnabled('mod-b', true);
        await new Promise((r) => setTimeout(r, 20));
        expect(moduleManager.get('mod-b')).toBeUndefined();

        await run.start();
        expect(running('mod-b')).toBe(true);
    });

    it('on a running engine Enable starts the module at once', async () => {
        const { run, setEnabled, running } = engine();
        await run.start();
        expect(running('mod-b')).toBe(false);

        setEnabled('mod-b', true);
        await vi.waitFor(() => expect(running('mod-b')).toBe(true));
    });
});
