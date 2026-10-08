import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaRouter } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { effectivePlayoutOffsetMs } from '../plugins/playoutOffset.js';
import type { ReanchorRaiseRequest, ReanchorRebaseReport } from '../plugins/playoutReanchor.js';
import { REANCHOR_SETTLE_MS } from '../plugins/playoutReanchor.js';

/**
 * The route-wide raise (ADR-0005 amendment 2026-10-08): a late leg asks, the
 * engine raises the ROUTE HEAD's D in memory and pushes it to every leg through
 * the same fan-out an edit uses. Pinned: which head is raised (through
 * transparent producers, and with no declaring producer at all), that both
 * legs see it, that a declaring sub-head is a separate route, that an edit
 * clears it, and that the ceiling alarms without ever shedding.
 */

/** Free-form bus graph (MediaRouter.playoutOffset.test.ts's shape) with spies. */
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
            notifyRoutePlayoutRaised: vi.fn(),
            notifyRoutePlayoutRebased: vi.fn(),
        } as unknown as ModuleInstance;
    }
    router.setDependencies(
        {} as never,
        (id: string) => modules[id],
        (id) => `${id} (name)`,
    );
    for (const id of Object.keys(configs)) router.assignBusChannel(id, 'out');
    const wire = (from: string, to: string, sinkPortId = 'in') =>
        router.createConnection(from, 'out', to, sinkPortId);
    return { router, modules, notified, wire };
}

const spy = (m: ModuleInstance, name: keyof ModuleInstance) =>
    (m as unknown as Record<string, ReturnType<typeof vi.fn>>)[name as string];

function req(excessMs: number, over: Partial<ReanchorRaiseRequest> = {}): ReanchorRaiseRequest {
    return {
        kind: 'raise',
        element: 'vdec',
        excessMs,
        worstMs: excessMs,
        cause: 'timeline',
        queuedMs: 0,
        budgetMs: 300,
        tsOffsetMs: 300,
        latencyMs: 0,
        holdMs: 15_000,
        ...over,
    };
}

/** splitter (D 300) → { video-player, audio-transcoder → audio-output-302m }. */
async function splitRoute() {
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
    g.router.setPlayoutReanchor(true, 60);
    g.notified.length = 0;
    return g;
}

/** What a leg resolves for its sink: the one shared definition. */
const legD = (router: MediaRouter, id: string) =>
    effectivePlayoutOffsetMs({
        instanceId: id,
        timeSyncContract: true,
        playoutOffsetMs: 60,
        mediaRouter: router,
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('MediaRouter.getRoutePlayoutHead', () => {
    it('resolves the declaring head through a transparent transcoder (splitter → transcoder → 302M)', async () => {
        const g = await splitRoute();
        expect(g.router.getRoutePlayoutHead('audio-output-302m')).toEqual({
            headId: 'splitter',
            label: 'splitter (name)',
            declaredMs: 300,
        });
        expect(g.router.getRoutePlayoutOffsetMs('audio-output-302m')).toBe(300);
    });

    it('with no declaring producer the head is the top-most one (hls-player → transcoder → player)', async () => {
        const g = busGraph({ 'hls-player': {}, transcoder: {}, 'video-player': {} });
        await g.wire('hls-player', 'transcoder');
        await g.wire('transcoder', 'video-player');
        expect(g.router.getRoutePlayoutHead('video-player')).toEqual({
            headId: 'hls-player',
            label: 'hls-player (name)',
        });
        expect(g.router.getRoutePlayoutOffsetMs('video-player')).toBeUndefined();
    });

    it('is undefined for a module with no bus source', () => {
        const g = busGraph({ 'video-player': {} });
        expect(g.router.getRoutePlayoutHead('video-player')).toBeUndefined();
    });
});

describe('MediaRouter.requestPlayoutRaise', () => {
    it('raises the HEAD, and both legs of the route see it', async () => {
        const g = await splitRoute();
        await expect(
            g.router.requestPlayoutRaise('audio-output-302m', undefined, req(112)),
        ).resolves.toBe('raised');
        expect(g.router.getRoutePlayoutRaiseMs('audio-output-302m')).toBe(160);
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(160);
        expect(legD(g.router, 'video-player')).toBe(460);
        expect(legD(g.router, 'audio-output-302m')).toBe(460);
        // The configured D is untouched — the raise is an overlay, not a write.
        expect(g.modules.splitter.config.playoutOffsetMs).toBe(300);
    });

    it('pushes it through the fan-out once per consumer, then tells the head', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(112));
        expect([...g.notified].sort()).toEqual([
            'audio-output-302m',
            'audio-transcoder',
            'video-player',
        ]);
        const told = spy(g.modules.splitter, 'notifyRoutePlayoutRaised');
        expect(told).toHaveBeenCalledTimes(1);
        expect(told.mock.calls[0][0]).toMatchObject({
            headId: 'splitter',
            baseMs: 300,
            raiseMs: 160,
            requests: 1,
            atCeiling: false,
            lastBy: { moduleId: 'video-player', label: 'video-player (name)', element: 'vdec' },
        });
    });

    it('a second leg inside the settle window is covered — one raise, one fan-out', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(100));
        g.notified.length = 0;
        vi.advanceTimersByTime(REANCHOR_SETTLE_MS - 1);
        await expect(
            g.router.requestPlayoutRaise('audio-output-302m', undefined, req(300)),
        ).resolves.toBe('covered');
        expect(g.notified).toEqual([]);
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(140);
    });

    it('a declaring sub-head is a route of its own — its subtree is not raised', async () => {
        const g = busGraph({
            'rist-input': { playoutOffsetMs: 500 },
            splitter: { playoutOffsetMs: 200 },
            'player-a': {},
            'player-b': {},
        });
        await g.wire('rist-input', 'splitter');
        await g.wire('rist-input', 'player-a');
        await g.wire('splitter', 'player-b');
        g.router.setPlayoutReanchor(true, 60);
        await g.router.requestPlayoutRaise('player-a', undefined, req(100));
        expect(g.router.getRoutePlayoutRaiseMs('player-a')).toBe(140);
        expect(g.router.getRoutePlayoutRaiseMs('player-b')).toBe(0);
        // The fan-out stops at the declaring splitter, exactly as an edit's does.
        expect([...g.notified].sort()).toEqual(['player-a', 'splitter']);
    });

    it('a route with no declaring producer is raised on its top-most producer', async () => {
        const g = busGraph({ 'hls-player': {}, transcoder: {}, 'video-player': {} });
        await g.wire('hls-player', 'transcoder');
        await g.wire('transcoder', 'video-player');
        g.router.setPlayoutReanchor(true, 60);
        await g.router.requestPlayoutRaise('video-player', undefined, req(150));
        // Base is the engine default: 60 + ceil20(150 + 40) = 60 + 200.
        expect(legD(g.router, 'video-player')).toBe(260);
        expect(spy(g.modules['hls-player'], 'notifyRoutePlayoutRaised')).toHaveBeenCalledWith(
            expect.objectContaining({ headId: 'hls-player', baseMs: 60, raiseMs: 200 }),
        );
    });

    it('at the ceiling it alarms and stops raising', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(5_000));
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(2_000);
        vi.advanceTimersByTime(REANCHOR_SETTLE_MS);
        g.notified.length = 0;
        await expect(
            g.router.requestPlayoutRaise('video-player', undefined, req(500)),
        ).resolves.toBe('ceiling');
        expect(g.notified).toEqual([]);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({ raiseMs: 2_000, atCeiling: true, requests: 2 }),
        );
    });

    it('a raise that lands exactly on the cap is marked atCeiling on that raise', async () => {
        const g = await splitRoute();
        // 1 880 + ceil20(80 + 40) = 2 000 = the headroom: no retry needed to warn.
        await g.router.requestPlayoutRaise('video-player', undefined, req(1_840));
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({ raiseMs: 1_880, atCeiling: false, requests: 1 }),
        );
        vi.advanceTimersByTime(REANCHOR_SETTLE_MS);
        await expect(
            g.router.requestPlayoutRaise('video-player', undefined, req(80)),
        ).resolves.toBe('raised');
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(2_000);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({ raiseMs: 2_000, atCeiling: true, requests: 2 }),
        );
    });

    it('is off — and keeps no state — unless the engine enabled it', async () => {
        const g = await splitRoute();
        g.router.setPlayoutReanchor(false);
        await expect(
            g.router.requestPlayoutRaise('video-player', undefined, req(112)),
        ).resolves.toBe('off');
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(0);
        expect(g.notified).toEqual([]);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).not.toHaveBeenCalled();
        // A fresh router (no Engine wiring) is off too.
        expect(
            await new MediaRouter().requestPlayoutRaise('video-player', undefined, req(112)),
        ).toBe('off');
    });
});

describe('MediaRouter.clearPlayoutRaise — an edit of the head’s D takes ownership', () => {
    it('drops the raise, tells the head null and each asking leg a zero raise', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(112));
        g.router.clearPlayoutRaise('splitter');
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(0);
        expect(legD(g.router, 'audio-output-302m')).toBe(300);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(null);
        expect(spy(g.modules['video-player'], 'notifyRoutePlayoutRaised')).toHaveBeenCalledWith(
            expect.objectContaining({ headId: 'splitter', raiseMs: 0, atCeiling: false }),
        );
        // A leg that never asked is not told (its D push comes from the fan-out).
        expect(
            spy(g.modules['audio-output-302m'], 'notifyRoutePlayoutRaised'),
        ).not.toHaveBeenCalled();
    });

    it('a throwing module hook never breaks the clear — the edit still fans out', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(112));
        spy(g.modules.splitter, 'notifyRoutePlayoutRaised').mockImplementation(() => {
            throw new Error('hook bug');
        });
        expect(() => g.router.clearPlayoutRaise('splitter')).not.toThrow();
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(0);
        expect(spy(g.modules['video-player'], 'notifyRoutePlayoutRaised')).toHaveBeenCalledWith(
            expect.objectContaining({ raiseMs: 0 }),
        );
    });

    it('is a no-op for a head with nothing raised', async () => {
        const g = await splitRoute();
        g.router.clearPlayoutRaise('splitter');
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).not.toHaveBeenCalled();
    });

    it('a cleared head raises from scratch on the next request', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise('video-player', undefined, req(112));
        g.router.clearPlayoutRaise('splitter');
        await expect(
            g.router.requestPlayoutRaise('video-player', undefined, req(50)),
        ).resolves.toBe('raised');
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(100);
    });
});

describe('MediaRouter.notePlayoutRebase', () => {
    it('tells the route head which leg rebased, and by how much', async () => {
        const g = await splitRoute();
        const report: ReanchorRebaseReport = {
            kind: 'rebase',
            element: 'sink',
            latenessMs: -21_340.2,
            appliedOffsetNs: -21_340_200_000,
            padOffsetNs: -21_340_200_000,
            flushed: false,
            sanityMs: 10_000,
            budgetMs: 300,
            count: 1,
        };
        g.router.notePlayoutRebase('audio-output-302m', undefined, report);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRebased')).toHaveBeenCalledWith({
            moduleId: 'audio-output-302m',
            label: 'audio-output-302m (name)',
            element: 'sink',
            latenessMs: -21_340.2,
            at: 1_000_000,
        });
        // A rebase is per leg: the route's D is untouched.
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(0);
    });
});
