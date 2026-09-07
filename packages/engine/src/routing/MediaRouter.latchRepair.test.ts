import { describe, it, expect, vi } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import { effectiveLatchRepair } from '../plugins/latchRepair.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

/**
 * The upstream walk `effectiveLatchRepair` resolves through (ADR-0005 note
 * 2026-09-05). The fielded chain that motivates it is
 * hls-player → ts-splitter → mpegts-muxer: the muxer is two hops from the
 * source whose delivery lead makes the repair wrong, so a one-hop "route
 * head" lookup (the playout-offset shape) would not see it. The lead is the
 * producer's own declaration (`isDeliveryLeadProducer`), not its name.
 */
function chain(head: 'hls-player' | 'srt-input') {
    const router = new MediaRouter();
    const out = (id: string) =>
        [{ id, direction: 'output', streamType: 'muxed/mpegts', label: id }] as const;
    const inp = (id: string) =>
        [{ id, direction: 'input', streamType: 'muxed/mpegts', label: id }] as const;
    router.registerPorts('head-1', [...out('mpegts-out')]);
    router.registerPorts('ts-splitter-2', [...inp('mpegts-in'), ...out('pid-0x100')]);
    router.registerPorts('mpegts-muxer-3', [...inp('video-0')]);
    router.registerPorts('mpegts-muxer-3b', [...inp('audio-0')]);

    const instance = (instanceId: string, pluginId: string) =>
        ({
            instanceId,
            pluginId,
            isDeliveryLeadProducer: () => pluginId === 'hls-player',
            config: {},
            running: false,
            start: vi.fn(),
            stop: vi.fn(),
        }) as unknown as ModuleInstance;
    const modules: Record<string, ModuleInstance> = {
        'head-1': instance('head-1', head),
        'ts-splitter-2': instance('ts-splitter-2', 'ts-splitter'),
        'mpegts-muxer-3': instance('mpegts-muxer-3', 'mpegts-muxer'),
        'mpegts-muxer-3b': instance('mpegts-muxer-3b', 'mpegts-muxer'),
    };
    router.setDependencies({} as never, (id: string) => modules[id]);
    router.assignBusChannel('head-1', 'mpegts-out');
    router.assignBusChannel('ts-splitter-2', 'pid-0x100');
    return router;
}

async function wire(router: MediaRouter): Promise<void> {
    await router.createConnection('head-1', 'mpegts-out', 'ts-splitter-2', 'mpegts-in');
    await router.createConnection('ts-splitter-2', 'pid-0x100', 'mpegts-muxer-3', 'video-0');
    // A second consumer of the same splitter output: the walk must not stop
    // early or double-count the shared producer.
    await router.createConnection('ts-splitter-2', 'pid-0x100', 'mpegts-muxer-3b', 'audio-0');
}

describe('MediaRouter.getUpstreamBusProducers', () => {
    it('walks the whole bus chain, nearest first, each producer once, with its declaration', async () => {
        const router = chain('hls-player');
        await wire(router);
        expect(router.getUpstreamBusProducers('mpegts-muxer-3')).toEqual([
            { pluginId: 'ts-splitter', deliveryLead: false },
            { pluginId: 'hls-player', deliveryLead: true },
        ]);
        expect(router.getUpstreamBusProducers('ts-splitter-2')).toEqual([
            { pluginId: 'hls-player', deliveryLead: true },
        ]);
        expect(router.getUpstreamBusProducers('head-1')).toEqual([]);
    });

    it('turns the repair off two hops below an hls-player, and leaves it on below an srt-input', async () => {
        const hls = chain('hls-player');
        await wire(hls);
        const live = chain('srt-input');
        await wire(live);
        const services = (router: MediaRouter, instanceId: string) => ({
            instanceId,
            mediaRouter: router,
        });
        expect(effectiveLatchRepair(services(hls, 'mpegts-muxer-3'))).toBe(false);
        expect(effectiveLatchRepair(services(hls, 'ts-splitter-2'))).toBe(false);
        expect(effectiveLatchRepair(services(live, 'mpegts-muxer-3'))).toBe(true);
        expect(effectiveLatchRepair(services(live, 'ts-splitter-2'))).toBe(true);
        expect(effectiveLatchRepair(services(live, 'head-1'))).toBe(true);
    });
});
