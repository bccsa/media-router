import { describe, it, expect, vi } from 'vitest';
import { ModuleLifecycle } from './ModuleLifecycle.js';
import { ModuleManager } from './ModuleManager.js';
import { MediaRouter } from '../routing/MediaRouter.js';
import { PluginLoader } from '../plugins/PluginLoader.js';

/** The operator's two ways of re-running a module both apply what was saved (ADR-0029). */
describe('ModuleLifecycle — Restart and Enable apply pending settings', () => {
    function rig() {
        const pw = {
            cleanupOrphans: vi.fn().mockResolvedValue(undefined),
            releaseAll: vi.fn().mockResolvedValue(undefined),
        } as any;
        const mediaRouter = new MediaRouter();
        const mm = new ModuleManager(new PluginLoader('/nonexistent'), pw, mediaRouter);
        const settings: Record<string, unknown> = { device: 'card2' };
        const config = {
            modules: {
                out: { pluginId: 'x', displayName: 'Out', enabled: true, settings, ports: [] },
            },
            connections: [] as unknown[],
        };
        const lc = new ModuleLifecycle(mm, mediaRouter, pw, () => config);
        // A plugin that caches its device in onInit, as audio-output did.
        const inits: string[] = [];
        mm.createModule('out', 'x', settings, {
            onInit: vi.fn(async (c: Record<string, unknown>) => {
                inits.push(c.device as string);
            }),
            onStart: vi.fn(async () => {}),
            onStop: vi.fn(async () => {}),
            onDestroy: vi.fn(async () => {}),
            getState: () => ({
                running: true,
                ready: true,
                health: 'ok' as const,
                pendingRestart: false,
            }),
            getLiveUpdatableParams: () => [] as string[],
            onLiveConfigUpdate: vi.fn(async () => {}),
        });
        return { mm, lc, inits };
    }

    it('Restart re-initialises the plugin with a device changed since start', async () => {
        const { mm, lc, inits } = rig();
        await mm.startModule('out');
        await mm.applyConfigUpdate('out', { device: 'card3' });
        await lc.restart('out');
        expect(inits).toEqual(['card2', 'card3']);
        expect(mm.get('out')!.getState().pendingRestart).toBe(false);
    });

    it('Enable applies a device changed while the module was disabled', async () => {
        const { mm, lc, inits } = rig();
        await mm.startModule('out');
        await lc.disable('out');
        await mm.applyConfigUpdate('out', { device: 'card3' });
        await lc.enable('out');
        expect(inits).toEqual(['card2', 'card3']);
    });
});
