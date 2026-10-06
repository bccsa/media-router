import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

/**
 * Route resolution for the playout offset D (ADR-0005 decision 4).
 *
 * The override lives on the ROUTE HEAD — the nearest upstream producer that
 * sets one (amended 2026-10-04) — precisely so the "same route ⇒ same D"
 * property is a fact about the graph rather than a rule about reconciling two
 * independently trimmed sinks (the failure mode decision 4 rejects). These
 * tests pin both halves of that: the READ (every leg resolves the same head)
 * and the WRITE (an edit reaches every leg in one pass, so they never straddle
 * two values).
 */

/** A module the router can wire and notify; records each notification. */
function fakeModule(id: string, config: Record<string, unknown>, notified: string[]) {
    return {
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
    } as unknown as ModuleInstance;
}

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
    const modules: Record<string, ModuleInstance> = {
        splitter: fakeModule('splitter', headConfig, notified),
        'video-player': fakeModule('video-player', {}, notified),
        'audio-decoder': fakeModule('audio-decoder', {}, notified),
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

/**
 * BCC Mulanje's Translation Station (10.37.7.24, 2026-10-04): srt-input →
 * ts-splitter → { video-player, audio-decoder, audio-transcoder → 302M output }.
 * The 302M leg's bus source is the transcoder, which declares no D, so the
 * one-hop lookup left it on the engine default while the splitter's D moved
 * the picture and the decoder.
 */
function translationStation(offsets: { srt?: unknown; splitter?: unknown; transcoder?: unknown }) {
    const router = new MediaRouter();
    const ts = 'muxed/mpegts' as const;
    const input = { id: 'mpegts-in', direction: 'input', streamType: ts, label: 'In' } as const;
    router.registerPorts('srt', [{ id: 'out', direction: 'output', streamType: ts, label: 'Out' }]);
    router.registerPorts('splitter', [
        { id: 'in', direction: 'input', streamType: ts, label: 'In' },
        { id: 'video-out', direction: 'output', streamType: ts, label: 'Video' },
        { id: 'audio-out', direction: 'output', streamType: ts, label: 'Audio' },
    ]);
    router.registerPorts('video-player', [input]);
    router.registerPorts('audio-decoder', [input]);
    router.registerPorts('transcoder', [
        input,
        { id: 'out-0', direction: 'output', streamType: 'audio/302m', label: '302M' },
    ]);
    router.registerPorts('out302m', [
        { id: 'audio-in', direction: 'input', streamType: 'audio/302m', label: 'In' },
    ]);
    const notified: string[] = [];
    const config = (ms: unknown) => (ms === undefined ? {} : { playoutOffsetMs: ms });
    const modules: Record<string, ModuleInstance> = {
        srt: fakeModule('srt', config(offsets.srt), notified),
        splitter: fakeModule('splitter', config(offsets.splitter), notified),
        transcoder: fakeModule('transcoder', config(offsets.transcoder), notified),
        'video-player': fakeModule('video-player', {}, notified),
        'audio-decoder': fakeModule('audio-decoder', {}, notified),
        out302m: fakeModule('out302m', {}, notified),
    };
    router.setDependencies({} as never, (id: string) => modules[id]);
    router.assignBusChannel('srt', 'out');
    router.assignBusChannel('splitter', 'video-out');
    router.assignBusChannel('splitter', 'audio-out');
    router.assignBusChannel('transcoder', 'out-0');
    const wire = async () => {
        await router.createConnection('srt', 'out', 'splitter', 'in');
        await router.createConnection('splitter', 'video-out', 'video-player', 'mpegts-in');
        await router.createConnection('splitter', 'audio-out', 'audio-decoder', 'mpegts-in');
        await router.createConnection('splitter', 'audio-out', 'transcoder', 'mpegts-in');
        await router.createConnection('transcoder', 'out-0', 'out302m', 'audio-in');
    };
    return { router, notified, wire };
}

const LEGS = ['video-player', 'audio-decoder', 'out302m'];

describe('playout offset through a re-stamping producer (.24, 2026-10-04)', () => {
    it("the 302M leg behind the transcoder resolves the splitter's D, like the other legs", async () => {
        const { router, wire } = translationStation({ splitter: 260 });
        await wire();
        for (const leg of LEGS) expect(router.getRoutePlayoutOffsetMs(leg)).toBe(260);
    });

    it('a splitter edit reaches every leg once — the 302M output through the transcoder', async () => {
        const { router, notified, wire } = translationStation({ splitter: 260 });
        await wire();
        await router.notifyPlayoutOffsetChanged('splitter');
        expect(notified.sort()).toEqual(['audio-decoder', 'out302m', 'transcoder', 'video-player']);
    });

    it("walks an unset splitter through to the srt-input's D (the deliberate change)", async () => {
        const { router, wire } = translationStation({ srt: 500 });
        await wire();
        for (const leg of LEGS) expect(router.getRoutePlayoutOffsetMs(leg)).toBe(500);
    });

    it('the nearest producer that sets one wins; nothing set ⇒ the engine default', async () => {
        const near = translationStation({ srt: 500, splitter: 260, transcoder: 120 });
        await near.wire();
        expect(near.router.getRoutePlayoutOffsetMs('out302m')).toBe(120);
        expect(near.router.getRoutePlayoutOffsetMs('audio-decoder')).toBe(260);

        const none = translationStation({});
        await none.wire();
        for (const leg of LEGS) expect(none.router.getRoutePlayoutOffsetMs(leg)).toBeUndefined();
    });
});
