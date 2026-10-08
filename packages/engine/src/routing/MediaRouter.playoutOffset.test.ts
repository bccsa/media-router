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

/**
 * Free-form bus graph for the upstream walk: each module gets bus inputs `in` /
 * `in-b` and one output `out`, muxed TS unless listed in `pcm` (`audio/302m`).
 */
function busGraph(configs: Record<string, Record<string, unknown>>, pcm: string[] = []) {
    const router = new MediaRouter();
    const notified: string[] = [];
    const modules: Record<string, ModuleInstance> = {};
    for (const [id, config] of Object.entries(configs)) {
        router.registerPorts(id, [
            { id: 'in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
            { id: 'in-b', direction: 'input', streamType: 'muxed/mpegts', label: 'In B' },
            {
                id: 'out',
                direction: 'output',
                streamType: pcm.includes(id) ? 'audio/302m' : 'muxed/mpegts',
                label: 'Out',
            },
        ]);
        modules[id] = {
            instanceId: id,
            config,
            running: false,
            start: vi.fn(),
            stop: vi.fn(),
            notifyRoutePlayoutOffsetChanged: vi.fn(async () => {
                notified.push(id);
            }),
        } as unknown as ModuleInstance;
    }
    router.setDependencies({} as never, (id: string) => modules[id]);
    for (const id of Object.keys(configs)) router.assignBusChannel(id, 'out');
    const wire = (from: string, to: string, sinkPortId = 'in') =>
        router.createConnection(from, 'out', to, sinkPortId);
    return { router, modules, notified, wire };
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

    it('resolves through a transparent transcoder: the 302M leg gets the video leg D', async () => {
        // The .108 route: the audio-transcoder declares no D and passes the splitter's through.
        const g = busGraph(
            {
                splitter: { playoutOffsetMs: 300 },
                'video-player': {},
                'audio-transcoder': {},
                'audio-output-302m': {},
            },
            ['audio-transcoder'],
        );
        await g.wire('splitter', 'video-player');
        await g.wire('splitter', 'audio-transcoder');
        await g.wire('audio-transcoder', 'audio-output-302m');
        expect(g.router.getRoutePlayoutOffsetMs('audio-output-302m')).toBe(300);
        expect(g.router.getRoutePlayoutOffsetMs('video-player')).toBe(300);
    });

    it('the nearest DECLARING producer wins over the head above it', async () => {
        const g = busGraph(
            {
                'rist-input': { playoutOffsetMs: 500 },
                splitter: { playoutOffsetMs: 200 },
                'audio-transcoder': {},
                'audio-output-302m': {},
            },
            ['audio-transcoder'],
        );
        await g.wire('rist-input', 'splitter');
        await g.wire('splitter', 'audio-transcoder');
        await g.wire('audio-transcoder', 'audio-output-302m');
        expect(g.router.getRoutePlayoutOffsetMs('audio-output-302m')).toBe(200);
        // With the splitter declaring nothing, the walk carries on to the head.
        delete g.modules.splitter.config.playoutOffsetMs;
        expect(g.router.getRoutePlayoutOffsetMs('audio-output-302m')).toBe(500);
    });

    it('follows a multi-input muxer through its FIRST bus input', async () => {
        const g = busGraph({
            'splitter-a': { playoutOffsetMs: 400 },
            'splitter-b': { playoutOffsetMs: 700 },
            muxer: {},
            'video-player': {},
        });
        await g.wire('splitter-a', 'muxer');
        await g.wire('splitter-b', 'muxer', 'in-b');
        await g.wire('muxer', 'video-player');
        expect(g.router.getRoutePlayoutOffsetMs('video-player')).toBe(400);
    });

    it('terminates on a cycle in the bus graph — nothing declares, so undefined', async () => {
        const g = busGraph({ a: {}, b: {}, c: {} });
        await g.wire('a', 'b');
        await g.wire('b', 'a');
        await g.wire('b', 'c');
        expect(g.router.getRoutePlayoutOffsetMs('a')).toBeUndefined();
        expect(g.router.getRoutePlayoutOffsetMs('c')).toBeUndefined();
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

    it('reaches a consumer two hops down through a transparent producer, exactly once', async () => {
        // The 302M output mixes two PCM renditions of the edited splitter's audio.
        const g = busGraph(
            {
                splitter: { playoutOffsetMs: 300 },
                'video-player': {},
                'transcoder-a': {},
                'transcoder-b': {},
                'audio-output-302m': {},
            },
            ['transcoder-a', 'transcoder-b'],
        );
        await g.wire('splitter', 'video-player');
        await g.wire('splitter', 'transcoder-a');
        await g.wire('splitter', 'transcoder-b');
        await g.wire('transcoder-a', 'audio-output-302m');
        await g.wire('transcoder-b', 'audio-output-302m', 'in-b');
        await g.router.notifyPlayoutOffsetChanged('splitter');
        expect(g.notified.filter((id) => id === 'audio-output-302m')).toHaveLength(1);
        expect([...g.notified].sort()).toEqual([
            'audio-output-302m',
            'transcoder-a',
            'transcoder-b',
            'video-player',
        ]);
    });

    it('stops at a consumer that declares its own D — its subtree has its own head', async () => {
        const g = busGraph({
            'rist-input': { playoutOffsetMs: 500 },
            splitter: { playoutOffsetMs: 200 },
            'video-player': {},
        });
        await g.wire('rist-input', 'splitter');
        await g.wire('splitter', 'video-player');
        await g.router.notifyPlayoutOffsetChanged('rist-input');
        expect(g.notified).toEqual(['splitter']);
    });

    it('terminates on a cycle in the bus graph, notifying each module once', async () => {
        const g = busGraph({ a: {}, b: {}, c: {} });
        await g.wire('a', 'b');
        await g.wire('b', 'a');
        await g.wire('b', 'c');
        await g.router.notifyPlayoutOffsetChanged('a');
        expect([...g.notified].sort()).toEqual(['b', 'c']);
    });
});
