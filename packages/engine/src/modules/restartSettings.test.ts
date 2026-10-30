import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModuleManager } from './ModuleManager.js';
import { ModuleLifecycle } from './ModuleLifecycle.js';
import { MediaRouter } from '../routing/MediaRouter.js';
import { EnginePatchRouter } from '../EnginePatchRouter.js';
import { CommandDispatcher } from '../commands/CommandDispatcher.js';
import { GstPluginBase } from '../plugins/GstPluginBase.js';
import type { ModuleServices, PipelineDescription } from '../plugins/PluginModule.js';

// B-191: a settings patch then Restart, or Disable then Enable, reaches a plugin that copies a
// setting in onInit, as the audio I/O plugins copy their device (field MR-002).

/** Devices on the fake PipeWire graph. */
const present = new Set<string>();

/** The audio I/O plugins' shape: the device is read in onInit, a missing one is waited for. */
class DevicePlugin extends GstPluginBase {
    protected liveUpdatableParams = ['volume'];
    private deviceName = '';
    readonly opened: string[] = [];

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';
    }

    async onStart(): Promise<void> {
        if (!present.has(this.deviceName)) {
            this.setHealth(
                'warning',
                `Audio device "${this.deviceName}" not connected — waiting for hot-plug`,
            );
            this.startDeviceWatchdog(false);
            return;
        }
        this.opened.push(this.deviceName);
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
        await super.onStop();
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    protected async onDeviceReconnected(): Promise<void> {
        this.opened.push(this.deviceName);
    }

    buildPipeline(): PipelineDescription | null {
        return null;
    }
}

/** The engine's own wiring of a settings patch, Restart and Enable/Disable, around one module. */
function engine() {
    const config = {
        modules: {
            mic: {
                pluginId: 'device-plugin',
                displayName: 'Mic 1',
                enabled: true,
                settings: { device: 'A', volume: 100 } as Record<string, unknown>,
                ports: [],
            },
        },
        connections: [],
    };
    const loader = {
        get: () => ({ ModuleClass: DevicePlugin, manifest: { ports: [] } }),
        settle: async () => {},
    } as any;
    const pipeWire = {
        hasDevice: (name: string) => present.has(name),
        releaseAll: vi.fn(async () => {}),
        cleanupOrphans: vi.fn(async () => {}),
    } as any;
    const processManager = { releaseAll: vi.fn(async () => {}) } as any;
    const mediaRouter = new MediaRouter();
    const modules = new ModuleManager(loader, pipeWire, mediaRouter, processManager, {} as any);
    const lifecycle = new ModuleLifecycle(modules, mediaRouter, pipeWire, () => config, loader);
    const localServer = { configChanged: vi.fn() } as any;
    const patches = new EnginePatchRouter(
        modules,
        mediaRouter,
        localServer,
        { config: vi.fn() },
        lifecycle,
        () => config,
        () => true,
    );
    const commands = new CommandDispatcher({
        moduleManager: modules,
        mediaRouter,
        localServer,
        currentConfig: config,
        isEngineRunning: () => true,
        broadcastRunIntent: vi.fn(),
        startModules: () => lifecycle.startAll(),
        stopModules: () => lifecycle.stopAll(),
        resetEngine: vi.fn(async () => {}),
        rebootHost: vi.fn(async () => {}),
        restartModule: (id) => lifecycle.restart(id),
        startSingleModule: (id) => lifecycle.startSingle(id),
        deleteSingleModule: (id) => lifecycle.deleteSingle(id),
        disableModule: (id) => lifecycle.disable(id),
        enableModule: (id) => lifecycle.enable(id),
    });
    const patch = (path: string, value: unknown) =>
        patches.onPatch('manager', 'manager', [{ op: 'replace', path, value }]);
    return {
        lifecycle,
        modules,
        plugin: () => modules.get('mic')!.getPlugin() as unknown as DevicePlugin,
        pickDevice: (device: string) => patch('/modules/mic/settings/device', device),
        setEnabled: (enabled: boolean) => patch('/modules/mic/enabled', enabled),
        restart: () => commands.dispatch({ command: 'moduleRestart', moduleId: 'mic' }),
    };
}

/** What a logger leaves on stderr: one of each per pipe that is never ended. */
const stderrListeners = () =>
    ['close', 'finish', 'error', 'unpipe'].map((e) => process.stderr.listenerCount(e));
const tick = (plugin: DevicePlugin) => (plugin as any).deviceWatchdog?.tick();
const warning = (plugin: DevicePlugin) => plugin.getState().error ?? '';

describe('a restart applies a changed setting (B-191)', () => {
    let e: ReturnType<typeof engine>;

    beforeEach(() => {
        present.clear();
        e = engine();
    });

    afterEach(async () => {
        await e.lifecycle.stopAll();
    });

    it('Restart opens a device re-picked on a running module, with no second logger', async () => {
        present.add('A').add('B');
        await e.lifecycle.startAll();
        const plugin = e.plugin();
        expect(plugin.opened).toEqual(['A']);
        const log = (plugin as any).log;
        const listeners = stderrListeners();

        e.pickDevice('B');
        e.restart();
        await vi.waitFor(() => expect(plugin.opened).toEqual(['A', 'B']));
        expect((plugin as any).getWatchedDeviceName()).toBe('B');
        expect(e.modules.get('mic')!.getState().pendingRestart).toBe(false);
        // The one allocation in any onInit, the base's logger, is not made again.
        expect((plugin as any).log).toBe(log);
        expect(stderrListeners()).toEqual(listeners);
    });

    it('Restart of a module waiting for hot-plug opens the re-picked device', async () => {
        present.add('B');
        await e.lifecycle.startAll();
        const plugin = e.plugin();
        // Waiting counts as running, so Restart takes the restart path, not a fresh start.
        expect(e.modules.get('mic')!.running).toBe(true);
        expect(warning(plugin)).toContain('"A" not connected');

        e.pickDevice('B');
        e.restart();
        await vi.waitFor(() => expect(plugin.opened).toEqual(['B']));
    });

    it('after Restart a module waiting for hot-plug watches the re-picked device, not the old one', async () => {
        await e.lifecycle.startAll();
        const plugin = e.plugin();
        expect(warning(plugin)).toContain('"A" not connected');

        e.pickDevice('B');
        e.restart();
        await vi.waitFor(() => expect(warning(plugin)).toContain('"B" not connected'));
        present.add('A');
        await tick(plugin);
        expect(plugin.opened).toEqual([]);
        present.add('B');
        await tick(plugin);
        expect(plugin.opened).toEqual(['B']);
    });

    it('Disable then Enable opens a device re-picked while disabled', async () => {
        present.add('A').add('B');
        await e.lifecycle.startAll();
        const plugin = e.plugin();
        e.setEnabled(false);
        await vi.waitFor(() => expect(e.modules.get('mic')!.running).toBe(false));

        e.pickDevice('B');
        e.setEnabled(true);
        await vi.waitFor(() => expect(plugin.opened).toEqual(['A', 'B']));
        expect(e.plugin()).toBe(plugin);
    });

    it('Disable then Enable applies a device re-picked while running', async () => {
        await e.lifecycle.startAll();
        const plugin = e.plugin();
        e.pickDevice('B');
        expect(e.modules.get('mic')!.getState().pendingRestart).toBe(true);

        present.add('B');
        e.setEnabled(false);
        e.setEnabled(true);
        await vi.waitFor(() => expect(plugin.opened).toEqual(['B']));
        expect(e.modules.get('mic')!.getState().pendingRestart).toBe(false);
    });
});
