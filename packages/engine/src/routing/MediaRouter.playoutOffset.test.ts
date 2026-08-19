import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

/**
 * Route resolution for the playout offset D (ADR-0005 decision 4).
 *
 * The override lives on the ROUTE HEAD — the producer both consumer legs take
 * their bus from — precisely so the "same route ⇒ same D" property is a fact
 * about the graph rather than a rule about reconciling two independently
 * trimmed sinks (the failure mode decision 4 rejects). These tests pin both
 * halves of that: the READ (every leg resolves the same head) and the WRITE
 * (an edit reaches every leg in one pass, so they never straddle two values).
 */

/** Splitter → { video-player, audio-decoder }: one route, two consumer legs. */
function splitRoute(headConfig: Record<string, unknown> = {}) {
    const router = new MediaRouter();
    router.registerPorts('splitter', [
        { id: 'video-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Video' },
        { id: 'audio-out', direction: 'output', streamType: 'muxed/mpegts', label: 'Audio' },
    ]);
    router.registerPorts('video-player', [
        { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
    ]);
    router.registerPorts('audio-decoder', [
        { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
    ]);

    const notified: string[] = [];
    const instance = (id: string, config: Record<string, unknown>) =>
        ({
            instanceId: id,
            config,
            running: false,
            // The bus executor restarts a consumer as it wires the edge; these
            // keep that path quiet, they are not what is under test here.
            start: vi.fn(),
            stop: vi.fn(),
            notifyRoutePlayoutOffsetChanged: vi.fn(async () => {
                notified.push(id);
            }),
        }) as unknown as ModuleInstance;

    const modules: Record<string, ModuleInstance> = {
        splitter: instance('splitter', headConfig),
        'video-player': instance('video-player', {}),
        'audio-decoder': instance('audio-decoder', {}),
    };
    router.setDependencies({} as never, (id: string) => modules[id]);
    router.assignBusChannel('splitter', 'video-out');
    router.assignBusChannel('splitter', 'audio-out');
    return { router, modules, notified };
}

async function wireBothLegs(router: MediaRouter): Promise<void> {
    await router.createConnection('splitter', 'video-out', 'video-player', 'mpegts-in');
    await router.createConnection('splitter', 'audio-out', 'audio-decoder', 'mpegts-in');
}

describe('MediaRouter.getRoutePlayoutOffsetMs', () => {
    let ctx: ReturnType<typeof splitRoute>;

    beforeEach(() => {
        ctx = splitRoute({ playoutOffsetMs: 500 });
    });

    it('reads the override off the route head, for BOTH legs identically', async () => {
        await wireBothLegs(ctx.router);
        expect(ctx.router.getRoutePlayoutOffsetMs('video-player')).toBe(500);
        expect(ctx.router.getRoutePlayoutOffsetMs('audio-decoder')).toBe(500);
    });

    it('tracks a live edit of the head without a reconnect', async () => {
        await wireBothLegs(ctx.router);
        ctx.modules.splitter.config.playoutOffsetMs = 250;
        expect(ctx.router.getRoutePlayoutOffsetMs('video-player')).toBe(250);
        expect(ctx.router.getRoutePlayoutOffsetMs('audio-decoder')).toBe(250);
    });

    it('is undefined when the head declares nothing — the engine default applies', async () => {
        const plain = splitRoute();
        await wireBothLegs(plain.router);
        expect(plain.router.getRoutePlayoutOffsetMs('video-player')).toBeUndefined();
    });

    it('is undefined for a module with no bus source at all', () => {
        expect(ctx.router.getRoutePlayoutOffsetMs('video-player')).toBeUndefined();
        expect(ctx.router.getRoutePlayoutOffsetMs('nobody')).toBeUndefined();
    });

    it('rejects a nonsense stored value rather than passing it through', async () => {
        const bad = splitRoute({ playoutOffsetMs: 'soon' });
        await wireBothLegs(bad.router);
        expect(bad.router.getRoutePlayoutOffsetMs('audio-decoder')).toBeUndefined();
    });
});

describe('MediaRouter.notifyPlayoutOffsetChanged', () => {
    it('fans the change out to every consumer of the route head, once each', async () => {
        const ctx = splitRoute({ playoutOffsetMs: 500 });
        await wireBothLegs(ctx.router);
        await ctx.router.notifyPlayoutOffsetChanged('splitter');
        expect(ctx.notified.sort()).toEqual(['audio-decoder', 'video-player']);
    });

    it('notifies a consumer once even when it holds two edges off the head', async () => {
        const ctx = splitRoute({ playoutOffsetMs: 500 });
        ctx.router.registerPorts('video-player', [
            { id: 'mpegts-in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
            { id: 'mpegts-in-b', direction: 'input', streamType: 'muxed/mpegts', label: 'In B' },
        ]);
        await ctx.router.createConnection('splitter', 'video-out', 'video-player', 'mpegts-in');
        await ctx.router.createConnection('splitter', 'audio-out', 'video-player', 'mpegts-in-b');
        await ctx.router.notifyPlayoutOffsetChanged('splitter');
        expect(ctx.notified).toEqual(['video-player']);
    });

    it('does not reach consumers of a DIFFERENT producer', async () => {
        const ctx = splitRoute({ playoutOffsetMs: 500 });
        await wireBothLegs(ctx.router);
        await ctx.router.notifyPlayoutOffsetChanged('some-other-module');
        expect(ctx.notified).toEqual([]);
    });

    it('a throwing consumer does not strand the other leg', async () => {
        const ctx = splitRoute({ playoutOffsetMs: 500 });
        await wireBothLegs(ctx.router);
        (
            ctx.modules['video-player'].notifyRoutePlayoutOffsetChanged as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error('sink gone'));
        await expect(ctx.router.notifyPlayoutOffsetChanged('splitter')).resolves.toBeUndefined();
        expect(ctx.notified).toEqual(['audio-decoder']);
    });
});
