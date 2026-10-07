import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleLifecycle } from './ModuleLifecycle.js';
import { ModuleManager } from './ModuleManager.js';
import { MediaRouter } from '../routing/MediaRouter.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';
import type { PluginModule } from '../plugins/PluginModule.js';

/** Who holds the fixed port (ClarioCast's 127.0.0.1:2000), and what onStart waits on after binding it. */
let portOwner: FixedPortPlugin | null = null;
let probe: Promise<void> = Promise.resolve();

/** ClarioCast's shape: bind a fixed port, then probe the input (slow), in onStart. */
class FixedPortPlugin implements PluginModule {
    portInUse = false;
    async onInit() {}
    async onStart() {
        if (portOwner) {
            this.portInUse = true; // "Port 2000 already in use"
            return;
        }
        portOwner = this;
        await probe;
    }
    async onStop() {
        if (portOwner === this) portOwner = null;
    }
    async onDestroy() {}
    getState() {
        return { running: false, ready: false, health: 'ok' as const, pendingRestart: false };
    }
    getLiveUpdatableParams() {
        return [];
    }
    async onLiveConfigUpdate() {}
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// #821, field 2026-10-07 NG-ON-Return01: a Restart clicked while a connection
// bounce was restarting ClarioCast found it not running (its start was still
// probing), deleted it and built a new one. The deleted instance finished its
// start with nobody holding it, kept the port, and the new one never bound.
describe('ModuleLifecycle — Restart landing mid-start (#821)', () => {
    let lifecycle: ModuleLifecycle;
    let moduleManager: ModuleManager;

    beforeEach(() => {
        portOwner = null;
        probe = Promise.resolve();
        const loader = {
            get: vi.fn().mockReturnValue({ ModuleClass: FixedPortPlugin }),
        } as unknown as PluginLoader;
        const pipeWire = { cleanupOrphans: vi.fn().mockResolvedValue(undefined) } as any;
        const mediaRouter = new MediaRouter();
        moduleManager = new ModuleManager(loader, pipeWire, mediaRouter);
        const config = {
            modules: {
                cc: {
                    pluginId: 'clariocast',
                    displayName: 'ClarioCast',
                    enabled: true,
                    settings: {},
                    ports: [],
                },
            },
            connections: [],
        };
        lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, pipeWire, () => config);
    });

    it('stops the instance it replaces, so the new one gets the port', async () => {
        await lifecycle.startSingle('cc');
        const old = moduleManager.get('cc')!;
        expect(portOwner).toBe(old.getPlugin());

        // Connection bounce (bus executor, outside the lifecycle lock): stop,
        // then a start that binds the port and probes.
        let probed!: () => void;
        probe = new Promise((r) => (probed = r));
        const bounce = old.stop().then(() => old.start());
        await settle();
        expect(old.running).toBe(false); // what moduleRestart sees → startSingle

        const restart = lifecycle.startSingle('cc');
        await settle();
        probed();
        await Promise.all([bounce, restart]);

        const live = moduleManager.get('cc')!;
        expect(live).not.toBe(old);
        expect(live.running).toBe(true);
        expect(old.running).toBe(false);
        expect(portOwner).toBe(live.getPlugin());
        expect((live.getPlugin() as FixedPortPlugin).portInUse).toBe(false);
    });

    it('a Disable that lands mid-start leaves the module stopped', async () => {
        await lifecycle.startSingle('cc');
        const inst = moduleManager.get('cc')!;

        let probed!: () => void;
        probe = new Promise((r) => (probed = r));
        const bounce = inst.stop().then(() => inst.start());
        await settle();
        const disable = lifecycle.disable('cc');
        await settle();
        probed();
        await Promise.all([bounce, disable]);

        expect(inst.running).toBe(false);
        expect(portOwner).toBeNull();
    });
});
