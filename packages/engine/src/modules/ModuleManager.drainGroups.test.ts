import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModuleManager, DRAIN_GROUP_REFRESH_MS, DRAIN_SOON_MS } from './ModuleManager.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import type { PluginModule } from '../plugins/PluginModule.js';
import type { MediaRouter } from '../routing/MediaRouter.js';

// The engine's half of the A/V groups (B-179; B-177 G4-3): the running drain members, their
// published targets, P = the max to each, refreshed every 2 s from the first start until destroyAll.
function output(publishedMs: number, anchor: boolean) {
    const apply = vi.fn(async (_ns: number, _view: unknown) => undefined);
    const plugin = {
        async onInit() {},
        async onStart() {},
        async onStop() {},
        async onDestroy() {},
        getState: () => ({
            running: true,
            ready: true,
            health: 'ok' as const,
            pendingRestart: false,
        }),
        getLiveUpdatableParams: () => [],
        async onLiveConfigUpdate() {},
        drainElementNames: () => ['outasrc'],
        isLatencyGroupAnchor: () => anchor,
        getTimingSummary: () => ({ drain: { publishedMs } }),
        applyLatencyGroupTarget: apply,
    } as unknown as PluginModule;
    return { plugin, apply };
}

function rig() {
    const router = {
        getConnections: () => [
            { sourceModuleId: 'gate', sinkModuleId: 'vp', streamType: 'muxed/mpegts' },
            { sourceModuleId: 'gate', sinkModuleId: 'dec', streamType: 'muxed/mpegts' },
        ],
        moduleName: (id: string) => id.toUpperCase(),
    } as unknown as MediaRouter;
    const manager = new ModuleManager(new PluginLoader('/nonexistent'), undefined, router);
    const vp = output(-520, true);
    const dec = output(-110, false);
    manager.createModule('vp', 'video-player', {}, vp.plugin);
    manager.createModule('dec', 'audio-decoder', {}, dec.plugin);
    return { manager, vp, dec };
}

afterEach(() => vi.useRealTimers());

describe('ModuleManager: the A/V groups', () => {
    it("P = the max of the running members' published targets, to each, with the others named", async () => {
        const { manager, vp, dec } = rig();
        await manager.startModule('vp');
        await manager.startModule('dec');
        manager.refreshDrainGroups();
        expect(vp.apply).toHaveBeenLastCalledWith(-110_000_000, { with: ['DEC'] });
        expect(dec.apply).toHaveBeenLastCalledWith(-110_000_000, { with: ['VP'] });
        await manager.destroyAll();
    });

    it("the others' render lateness from their drains goes with the names (B-241)", async () => {
        const { manager, vp, dec } = rig();
        const summary = (publishedMs: number, nowMs: number) => () => ({
            drain: { publishedMs, nowMs },
        });
        (vp.plugin as any).getTimingSummary = summary(-520, 4800);
        (dec.plugin as any).getTimingSummary = summary(-110, 300);
        await manager.startModule('vp');
        await manager.startModule('dec');
        manager.refreshDrainGroups();
        expect(vp.apply).toHaveBeenLastCalledWith(-110_000_000, {
            with: ['DEC'],
            withRenderMs: [300],
        });
        expect(dec.apply).toHaveBeenLastCalledWith(-110_000_000, {
            with: ['VP'],
            withRenderMs: [4800],
        });
        await manager.destroyAll();
    });

    it('a stopped module is left out: the other drains alone', async () => {
        const { manager, vp, dec } = rig();
        await manager.startModule('vp');
        await manager.startModule('dec');
        await manager.stopModule('dec');
        dec.apply.mockClear();
        manager.refreshDrainGroups();
        expect(dec.apply).not.toHaveBeenCalled();
        expect(vp.apply.mock.calls.at(-1)?.[1]).toEqual({});
        await manager.destroyAll();
    });

    it('the 2 s refresh runs from the first start, and not after destroyAll', async () => {
        vi.useFakeTimers();
        const { manager, vp } = rig();
        await vi.advanceTimersByTimeAsync(DRAIN_GROUP_REFRESH_MS * 2);
        expect(vp.apply).not.toHaveBeenCalled();
        await manager.startModule('vp');
        await manager.startModule('dec');
        await vi.advanceTimersByTimeAsync(DRAIN_GROUP_REFRESH_MS);
        expect(vp.apply).toHaveBeenCalledWith(-110_000_000, { with: ['DEC'] });
        await manager.destroyAll();
        // destroyAll also drops the members, so the loop's tick is what shows the timer is gone.
        const tick = vi.spyOn((manager as any).drainGroups, 'tick');
        await vi.advanceTimersByTimeAsync(DRAIN_GROUP_REFRESH_MS * 3);
        expect(tick).not.toHaveBeenCalled();
    });
});

describe('ModuleManager: a first published target refreshes the groups at once (fix B)', () => {
    it('drainChanged refreshes within DRAIN_SOON_MS, several calls coalesce, not waiting for the 2 s', async () => {
        vi.useFakeTimers();
        const { manager, vp, dec } = rig();
        await manager.startModule('vp');
        await manager.startModule('dec');
        vp.apply.mockClear();
        const soon = (manager as unknown as { drainSoon(): void }).drainSoon.bind(manager);
        soon();
        soon();
        vi.advanceTimersByTime(DRAIN_SOON_MS);
        expect(vp.apply).toHaveBeenCalledTimes(1);
        expect(vp.apply).toHaveBeenLastCalledWith(-110_000_000, { with: ['DEC'] });
        expect(DRAIN_SOON_MS).toBeLessThan(DRAIN_GROUP_REFRESH_MS);
        await manager.destroyAll();
    });
});
