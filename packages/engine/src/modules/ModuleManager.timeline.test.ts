import { describe, it, expect, vi } from 'vitest';
import { ModuleManager } from './ModuleManager.js';
import { topoSortOrderedConns, type StoredConnection } from './ConnectionApplier.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import type { PluginModule } from '../plugins/PluginModule.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import { MediaRouter as RealRouter } from '../routing/MediaRouter.js';
import type { DrainEdge } from '../plugins/drainGroups.js';
import { DRAIN_GROUP_ALONE_NS } from '../plugins/drainSummary.js';
import { NO_TIMELINE, localOriginKey, senderTimelineId } from '../plugins/timelineId.js';
import { CH, setup, trustEvent, trustMsg } from '../plugins/testing/ingestTimingFixtures.js';
import { SrtOutputModule } from '../../../../plugins/srt-output/engine/SrtOutputModule.js';

// p5-20 in the engine: the receiver's keys from the ingests, the sender's id to each egress writer.
const TS = 'muxed/mpegts';
const A302 = 'audio/302m';
const SALT = '0011223344556677';
const TL = '0123456789abcdef';
const e = (sourceModuleId: string, sinkModuleId: string, streamType = TS): DrainEdge => ({
    sourceModuleId,
    sinkModuleId,
    streamType,
});

const base = {
    async onInit() {},
    async onStart() {},
    async onStop() {},
    async onDestroy() {},
    getState: () => ({ running: true, ready: true, health: 'ok' as const, pendingRestart: false }),
    getLiveUpdatableParams: () => [],
    async onLiveConfigUpdate() {},
};

/** A network ingest whose drain key is its Trust reporter's, as the three ingest modules do. */
function ingest() {
    const { rep } = setup('stc');
    const plugin = { ...base, drainOriginKey: () => rep.drainOriginKey() } as PluginModule;
    return { plugin, rep };
}

function output(publishedMs: number, anchor: boolean) {
    const apply = vi.fn(async (_ns: number, _view: unknown) => undefined);
    const plugin = {
        ...base,
        drainElementNames: () => ['outasrc'],
        isLatencyGroupAnchor: () => anchor,
        getTimingSummary: () => ({ drain: { publishedMs } }),
        applyLatencyGroupTarget: apply,
    } as unknown as PluginModule;
    return { plugin, apply };
}

function rig(edges: DrainEdge[]) {
    const router = {
        getConnections: () => edges,
        moduleName: (id: string) => id.toUpperCase(),
        getModuleBusSource: () => ({
            port: 41000,
            socketPath: '/tmp/mr-bus-41000-abc123.sock',
            connectionId: 'c-up',
            sourceModuleId: 'up',
            sourcePortId: 'mpegts-out',
        }),
    } as unknown as MediaRouter;
    const stub = {} as never;
    const manager = new ModuleManager(new PluginLoader('/nonexistent'), stub, router, stub, stub);
    manager.setTimelineSalt(SALT);
    return manager;
}

/** A real srt-output built as the engine starts it, its runner a spy. */
async function egress(manager: ModuleManager, id: string) {
    const srt = new SrtOutputModule();
    // The plugin is built against the engine's dist types: one shape, two declarations.
    const inst = manager.createModule(id, 'srt-output', {}, srt as unknown as PluginModule);
    await srt.onInit({}, (inst as unknown as { services: never }).services);
    Object.defineProperty(inst, 'running', { get: () => true });
    const setProperty = vi.fn(async () => undefined);
    const build = (): string => {
        const desc = srt.buildPipeline({});
        (srt as unknown as { childProcess: unknown }).childProcess = {
            isRunning: true,
            setProperty,
        };
        return desc!.pipeline;
    };
    const pushes = (): unknown[] =>
        setProperty.mock.calls.filter((c) => (c as unknown[])[1] === 'timeline-id');
    return { srt, build, pushes };
}

describe('ModuleManager: the receiver groups Trust inputs by their sender timeline', () => {
    it('(a)+(c) srt-input and rist-input on one timeline: one group; a trust-fallback event splits it at the next refresh, before any further report; the return rejoins', async () => {
        const edges = [e('srt-in', 'vp'), e('rist-in', 'out302', A302)];
        const manager = rig(edges);
        const srt = ingest();
        const rist = ingest();
        const vp = output(300, true);
        const out = output(120, false);
        manager.createModule('srt-in', 'srt-input', {}, srt.plugin);
        manager.createModule('rist-in', 'rist-input', {}, rist.plugin);
        manager.createModule('vp', 'video-player', {}, vp.plugin);
        manager.createModule('out302', 'audio-output-302m', {}, out.plugin);
        for (const id of ['srt-in', 'rist-in', 'vp', 'out302']) await manager.startModule(id);
        srt.rep.onEvent(CH.trust, trustMsg(), 2000);
        rist.rep.onEvent(CH.trust, trustMsg(), 2000);
        manager.refreshDrainGroups();
        expect(out.apply).toHaveBeenLastCalledWith(300e6, { with: ['VP'] });
        // The rist link falls back: its key moves on the event itself.
        const fb = { reason: 'switch-to-restamp', failed: 'transit-high' };
        rist.rep.onEvent(CH.event, trustEvent('trust-switch', 'fallback', 'trust', fb), 2500);
        rist.rep.onEvent(CH.event, trustEvent('trust-fallback', 'fallback', 'trust', fb), 2500);
        manager.refreshDrainGroups();
        expect(out.apply).toHaveBeenLastCalledWith(DRAIN_GROUP_ALONE_NS, {});
        expect(vp.apply).toHaveBeenLastCalledWith(DRAIN_GROUP_ALONE_NS, {});
        const back = { reason: 'switch-to-trust', 'converging-ns': 300e6 };
        rist.rep.onEvent(
            CH.event,
            trustEvent('trust-switch', 'converging', 'returning', back),
            14_500,
        );
        manager.refreshDrainGroups();
        expect(out.apply).toHaveBeenLastCalledWith(300e6, { with: ['VP'] });
        await manager.destroyAll();
    });

    it('(b) two ids, and (j) a sender that declares timeline 0: apart', async () => {
        const edges = [e('srt-in', 'vp'), e('rist-in', 'out302', A302)];
        for (const other of ['fedcba9876543210', NO_TIMELINE]) {
            const manager = rig(edges);
            const srt = ingest();
            const rist = ingest();
            const out = output(120, false);
            manager.createModule('srt-in', 'srt-input', {}, srt.plugin);
            manager.createModule('rist-in', 'rist-input', {}, rist.plugin);
            manager.createModule('vp', 'video-player', {}, output(300, true).plugin);
            manager.createModule('out302', 'audio-output-302m', {}, out.plugin);
            for (const id of ['vp', 'out302']) await manager.startModule(id);
            srt.rep.onEvent(CH.trust, trustMsg(), 2000);
            rist.rep.onEvent(CH.trust, trustMsg({ 'decl-timeline-id': other }), 2000);
            manager.refreshDrainGroups();
            expect(out.apply, other).toHaveBeenLastCalledWith(DRAIN_GROUP_ALONE_NS, {});
            await manager.destroyAll();
        }
    });
});

describe('ModuleManager: the sender names its timeline (f)', () => {
    it('one origin: its key under the salt, in the pipeline string at build; the first refresh pushes nothing', async () => {
        const manager = rig([e('gen', 'out')]);
        const { build, pushes } = await egress(manager, 'out');
        const want = localOriginKey(SALT, 'gen');
        expect(build()).toContain(`mrtsegress name=egress house-clock=`);
        expect(build()).toContain(` timeline-id=${want} ! `);
        manager.refreshDrainGroups();
        manager.refreshDrainGroups();
        expect(pushes()).toEqual([]);
        await manager.destroyAll();
    });

    it('a Trust relay passes the received timeline through, once it is on it: one live push', async () => {
        const manager = rig([e('rist-in', 'out')]);
        const rist = ingest();
        manager.createModule('rist-in', 'rist-input', {}, rist.plugin);
        const { build, pushes } = await egress(manager, 'out');
        expect(build()).toContain(`timeline-id=${localOriginKey(SALT, 'rist-in')}`);
        rist.rep.onEvent(CH.trust, trustMsg(), 2000);
        manager.refreshDrainGroups();
        manager.refreshDrainGroups();
        expect(pushes()).toEqual([['egress', 'timeline-id', TL]]);
        // Its fallback: back to its local key, at the next refresh.
        rist.rep.onEvent(
            CH.event,
            trustEvent('trust-fallback', 'fallback', 'trust', { failed: 'transit-high' }),
            2500,
        );
        manager.refreshDrainGroups();
        expect(pushes().at(-1)).toEqual(['egress', 'timeline-id', localOriginKey(SALT, 'rist-in')]);
        await manager.destroyAll();
    });

    it('two origins (a muxer): the sorted hash; an egress with no origin carries 0', async () => {
        const edges = [e('cam', 'mux'), e('mic', 'mux', A302), e('mux', 'out')];
        const manager = rig(edges);
        const { build } = await egress(manager, 'out');
        expect(build()).toContain(
            `timeline-id=${senderTimelineId(['mic', 'cam'], () => undefined, SALT)}`,
        );
        expect(manager.timelineIdOf('out')).not.toBe(localOriginKey(SALT, 'cam'));
        expect(manager.timelineIdOf('nowhere')).toBe(NO_TIMELINE);
        await manager.destroyAll();
    });

    it('an upstream edge that arrives after the build: exactly one push, from the id at build', async () => {
        const edges = [e('mux', 'out')];
        const manager = rig(edges);
        const { build, pushes } = await egress(manager, 'out');
        expect(build()).toContain(`timeline-id=${localOriginKey(SALT, 'mux')}`);
        edges.push(e('cam', 'mux'));
        manager.refreshDrainGroups();
        manager.refreshDrainGroups();
        expect(pushes()).toEqual([['egress', 'timeline-id', localOriginKey(SALT, 'cam')]]);
        await manager.destroyAll();
    });

    it('two engines with one profile: two salts, two ids', async () => {
        const one = rig([e('gen', 'out')]);
        const two = rig([e('gen', 'out')]);
        two.setTimelineSalt('8899aabbccddeeff');
        expect(one.timelineIdOf('out')).not.toBe(two.timelineIdOf('out'));
        await one.destroyAll();
        await two.destroyAll();
    });
});

describe('the activation order the build relies on (f)', () => {
    it("bus edges apply parents first, so an egress's upstream edges exist when its own edge builds it", () => {
        const c = (src: string, sink: string): StoredConnection => ({
            id: `${src}-${sink}`,
            sourceModuleId: src,
            sourcePortId: 'mpegts-out',
            sinkModuleId: sink,
            sinkPortId: 'mpegts-in',
        });
        // Stored children first: the applier still runs the egress's own edge last.
        const order = topoSortOrderedConns([c('mux', 'out'), c('cam', 'mux'), c('mic', 'mux')]);
        expect(order.map((x) => x.id)).toEqual(['cam-mux', 'mic-mux', 'mux-out']);
    });

    it('a connection is in getConnections() while its consumer restarts (the build)', async () => {
        const router = new RealRouter();
        router.registerPorts('mux', [
            { id: 'mpegts-out', direction: 'output', streamType: TS, label: 'Out' },
        ]);
        router.registerPorts('out', [
            { id: 'mpegts-in', direction: 'input', streamType: TS, label: 'In' },
        ]);
        let seen: string[] = [];
        const sink = {
            config: {},
            running: false,
            stop: vi.fn(),
            start: vi.fn(async () => {
                seen = router.getConnections().map((x) => `${x.sourceModuleId}>${x.sinkModuleId}`);
            }),
            getPlugin: () => ({}),
        };
        router.setDependencies({} as never, (id) =>
            id === 'out'
                ? (sink as never)
                : id === 'mux'
                  ? ({ running: true, getPlugin: () => ({}) } as never)
                  : undefined,
        );
        router.assignBusChannel('mux');
        await router.createConnection('mux', 'mpegts-out', 'out', 'mpegts-in');
        expect(sink.start).toHaveBeenCalledOnce();
        expect(seen).toEqual(['mux>out']);
    });
});
