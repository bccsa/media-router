import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    DECAY_HOLD_MS,
    LEG_OFFSET_CLEAR_MS,
    REANCHOR_HOLD_MS,
    REANCHOR_RETRY_MS,
} from '../plugins/playoutReanchor.js';
import { legD, req, splitRoute, spy } from './testing/playoutRoute.js';

/**
 * B-210 (MR-044, FRA01's 302M Audio Out stuck 2 s late): a raise that did not help is held,
 * a raise that is no longer needed comes back down, a late timeline the route cannot reach
 * re-anchors its leg alone, and a standing raise is there for a restarted module to show.
 * The runner's side is simulated as it behaves: it asks again one hold after its budget
 * moved, every retry while it did not.
 */

const OUT = 'audio-output-302m';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

/** `ms` of lateness reports from `legs`, one each timing tick (2 s). */
function report(
    router: Awaited<ReturnType<typeof splitRoute>>['router'],
    legs: Record<string, number | null>,
    ms: number,
) {
    for (let t = 0; t < ms; t += 2_000) {
        vi.advanceTimersByTime(2_000);
        for (const [id, late] of Object.entries(legs))
            router.notePlayoutLateness(id, undefined, late);
    }
}

describe('a raise that did not help is held (the ratchet guard)', () => {
    it('a sink-paced leg gets one raise, then held: D kept, the head told it is held', async () => {
        const g = await splitRoute();
        // Its excess sits after the probe: each raise moves its sink and its budget alike.
        const sinkPaced = (n: number) => req(88 + (n % 2) * 6, { cause: 'backlog', queuedMs: 400 });
        await expect(g.router.requestPlayoutRaise(OUT, undefined, sinkPaced(0))).resolves.toBe(
            'raised',
        );
        expect(legD(g.router, OUT)).toBe(300 + 140);
        const fanOuts = g.notified.length;
        // DEV-P3a's V7 asked 14 times to the 2 s headroom: here every later ask is held.
        for (let n = 1; n < 14; n++) {
            vi.advanceTimersByTime(n === 1 ? REANCHOR_HOLD_MS + 50 : REANCHOR_RETRY_MS);
            await expect(g.router.requestPlayoutRaise(OUT, undefined, sinkPaced(n))).resolves.toBe(
                'held',
            );
        }
        expect(legD(g.router, OUT)).toBe(440);
        expect(g.notified.length).toBe(fanOuts);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({
                raiseMs: 140,
                held: expect.objectContaining({ moduleId: OUT, excessMs: 94 }),
            }),
        );
        expect(g.router.getLegPlayout(OUT)).toMatchObject({ held: true, asked: true });
    });

    it('a falling excess behaves as today: the raise helped, the rest is raised too', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(300));
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, req(120))).resolves.toBe(
            'raised',
        );
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(340 + 160);
    });

    it('a request long after its raise is a new episode, not that raise measured', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(88));
        vi.advanceTimersByTime(5 * 60_000);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, req(88))).resolves.toBe('raised');
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(280);
    });

    it('another leg of the route is not held by this one', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(88));
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await expect(
            g.router.requestPlayoutRaise('video-player', undefined, req(88)),
        ).resolves.toBe('raised');
    });

    it('a queue the raises filled is not backlog: judged on the queue past the standing raise', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(
            OUT,
            undefined,
            req(500, { cause: 'backlog', queuedMs: 600 }),
        );
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await g.router.requestPlayoutRaise(
            OUT,
            undefined,
            req(200, { cause: 'backlog', queuedMs: 560 }),
        );
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({ lastBy: expect.objectContaining({ cause: 'timeline' }) }),
        );
    });
});

describe('a raise no longer needed comes back down (the decay)', () => {
    it('every leg that asked on time for 60 s: D back in one step, one fan-out, both ends told', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        expect(legD(g.router, OUT)).toBe(300 + 540);
        g.notified.length = 0;
        // Reports every tick from 2 s after the raise: on time for 58 s, still raised.
        report(g.router, { [OUT]: 20 }, DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(540);
        report(g.router, { [OUT]: 20 }, 2_000);
        await vi.runAllTimersAsync();
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
        expect(legD(g.router, OUT)).toBe(300);
        expect(legD(g.router, 'video-player')).toBe(300);
        expect([...g.notified].sort()).toEqual([OUT, 'audio-transcoder', 'video-player']);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(null);
        expect(spy(g.modules[OUT], 'notifyRoutePlayoutRaised')).toHaveBeenLastCalledWith(
            expect.objectContaining({ raiseMs: 0 }),
        );
        expect(g.router.getHeadPlayoutRaise('splitter')).toBeNull();
    });

    it('a report past the configured D restarts the hold; no reading is no verdict', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        report(g.router, { [OUT]: 20 }, 40_000);
        report(g.router, { [OUT]: 310 }, 2_000);
        report(g.router, { [OUT]: 20 }, 40_000);
        report(g.router, { [OUT]: null }, 2_000);
        report(g.router, { [OUT]: 20 }, DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(540);
        report(g.router, { [OUT]: 20 }, 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
    });

    it('a leg that asked and does not report holds the raise up; one that left the route does not', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await g.router.requestPlayoutRaise('video-player', undefined, req(800));
        report(g.router, { [OUT]: 20 }, 2 * DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBeGreaterThan(0);
        // The video leg leaves the route: what it asked no longer counts.
        for (const c of g.router.getModuleConnections('video-player')) {
            await g.router.removeConnection(c.id, true);
        }
        report(g.router, { [OUT]: 20 }, DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
    });

    it('a leg that went quiet (stopped, or its source dark) holds the raise up until it reports again', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await g.router.requestPlayoutRaise('video-player', undefined, req(800));
        report(g.router, { [OUT]: 20, 'video-player': 20 }, 30_000);
        report(g.router, { [OUT]: 20 }, DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBeGreaterThan(0);
        // Back, on time: its hold starts again from its first report.
        report(g.router, { [OUT]: 20, 'video-player': 20 }, DECAY_HOLD_MS);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBeGreaterThan(0);
        report(g.router, { [OUT]: 20, 'video-player': 20 }, 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
    });

    it('the hold counts from the raise: content on time all along is not cut at the next tick', async () => {
        const g = await splitRoute();
        // A sink-paced leg's arrival is on time before, during and after its raise.
        await g.router.requestPlayoutRaise(
            OUT,
            undefined,
            req(88, { cause: 'backlog', queuedMs: 400 }),
        );
        report(g.router, { [OUT]: 5 }, 30_000);
        vi.advanceTimersByTime(0);
        await expect(
            g.router.requestPlayoutRaise(
                OUT,
                undefined,
                req(90, { cause: 'backlog', queuedMs: 540 }),
            ),
        ).resolves.toBe('raised');
        // That one came 30 s after the raise: a new episode, raised again — and only after a
        // hold's worth of on-time reports since that raise does it come down.
        report(g.router, { [OUT]: 5 }, DECAY_HOLD_MS - 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBeGreaterThan(0);
        report(g.router, { [OUT]: 5 }, 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
    });

    it('a sink-paced leg held before stays held after the decay: no raise again', async () => {
        const g = await splitRoute();
        const sinkPaced = req(88, { cause: 'backlog', queuedMs: 400 });
        await g.router.requestPlayoutRaise(OUT, undefined, sinkPaced);
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, sinkPaced)).resolves.toBe('held');
        report(g.router, { [OUT]: 5 }, DECAY_HOLD_MS + 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, sinkPaced)).resolves.toBe('held');
        expect(legD(g.router, OUT)).toBe(300);
        // Its sink plays on time again: the hold is over, a later ask is news.
        g.router.notePlayoutOnTime(OUT);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, sinkPaced)).resolves.toBe(
            'raised',
        );
    });
});

describe('a late timeline the route cannot reach re-anchors its leg alone (the stamp jump)', () => {
    it('a source 5 s late at 1x: the route is not raised, the leg takes its own offset, its head is told', async () => {
        const g = await splitRoute();
        // Its content arrives 5 s late at its bus ingress (the timing tick's report).
        g.router.notePlayoutLateness(OUT, undefined, 5_000);
        await expect(
            g.router.requestPlayoutRaise(OUT, undefined, req(4_900, { element: 'sink' })),
        ).resolves.toBe('leg');
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
        expect(legD(g.router, OUT)).toBe(300 + 4_940);
        expect(legD(g.router, 'video-player')).toBe(300);
        expect(spy(g.modules[OUT], 'notifyRoutePlayoutOffsetChanged')).toHaveBeenCalledTimes(1);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRebased')).toHaveBeenLastCalledWith(
            expect.objectContaining({ moduleId: OUT, element: 'sink', latenessMs: 5_200 }),
        );
        expect(g.router.getHeadPlayoutNote('splitter')).toMatchObject({ moduleId: OUT });
        // The runner plays it on time against that offset: it asks nothing more, the route stays.
        report(g.router, { [OUT]: 5_000 }, 10 * 60_000);
        expect(legD(g.router, OUT)).toBe(5_240);
        expect(g.router.getRoutePlayoutRaiseMs('video-player')).toBe(0);
    });

    it('back on time for 3 s: its own offset goes in one step, the head note withdrawn', async () => {
        const g = await splitRoute();
        g.router.notePlayoutLateness(OUT, undefined, 5_000);
        await g.router.requestPlayoutRaise(OUT, undefined, req(4_900));
        report(g.router, { [OUT]: 5_000 }, 10_000);
        expect(legD(g.router, OUT)).toBe(5_240);
        report(g.router, { [OUT]: 20 }, 2_000);
        expect(legD(g.router, OUT)).toBe(5_240);
        report(g.router, { [OUT]: 20 }, LEG_OFFSET_CLEAR_MS);
        await vi.runAllTimersAsync();
        expect(legD(g.router, OUT)).toBe(300);
        expect(spy(g.modules[OUT], 'notifyPlayoutLegOffset')).toHaveBeenLastCalledWith(null);
        expect(spy(g.modules.splitter, 'notifyRoutePlayoutRebased')).toHaveBeenLastCalledWith(null);
        expect(g.router.getHeadPlayoutNote('splitter')).toBeNull();
    });

    it("an edit of the head's D takes it too", async () => {
        const g = await splitRoute();
        g.router.notePlayoutLateness(OUT, undefined, 5_000);
        await g.router.requestPlayoutRaise(OUT, undefined, req(4_900));
        g.router.clearPlayoutRaise('splitter');
        expect(legD(g.router, OUT)).toBe(300);
        expect(spy(g.modules[OUT], 'notifyPlayoutLegOffset')).toHaveBeenLastCalledWith(null);
    });

    it('content on time, late only at the sink, past the headroom: one raise to the cap, then held — never the leg alone', async () => {
        const g = await splitRoute();
        // A mixer arm's queues (its aligners') are not counted: such a request reads 'timeline'.
        g.router.notePlayoutLateness(OUT, undefined, 5);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, req(4_400))).resolves.toBe(
            'raised',
        );
        vi.advanceTimersByTime(REANCHOR_HOLD_MS + 50);
        g.router.notePlayoutLateness(OUT, undefined, 5);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, req(4_380))).resolves.toBe(
            'held',
        );
        expect(g.router.getPlayoutLegOffsetMs(OUT)).toBe(0);
    });

    it('a sink-paced leg past the headroom: one raise to the cap, then held — never its own offset', async () => {
        const g = await splitRoute();
        // FRA01, 3 Nov 08:14Z: 4.4 s past the budget with its queues full.
        const late = (ms: number) => req(ms, { cause: 'backlog', queuedMs: ms + 2_000 });
        await expect(g.router.requestPlayoutRaise(OUT, undefined, late(4_400))).resolves.toBe(
            'raised',
        );
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(2_000);
        // Its content arrives on time all the while (each tick from 2 s after the raise).
        report(g.router, { [OUT]: 5 }, 16_000);
        await expect(g.router.requestPlayoutRaise(OUT, undefined, late(4_420))).resolves.toBe(
            'held',
        );
        expect(g.router.getPlayoutLegOffsetMs(OUT)).toBe(0);
        report(g.router, { [OUT]: 5 }, DECAY_HOLD_MS - 16_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(2_000);
        report(g.router, { [OUT]: 5 }, 2_000);
        expect(g.router.getRoutePlayoutRaiseMs(OUT)).toBe(0);
    });
});

describe('a standing raise stays visible', () => {
    it('the head and the leg that asked read it from the router: configured, raised, since when', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        expect(g.router.getHeadPlayoutRaise('splitter')).toMatchObject({
            baseMs: 300,
            raiseMs: 540,
            since: 1_000_000,
        });
        expect(g.router.getLegPlayout(OUT)).toMatchObject({
            headLabel: 'splitter (name)',
            baseMs: 300,
            asked: true,
            held: false,
            own: null,
            raise: expect.objectContaining({ raiseMs: 540, since: 1_000_000 }),
        });
        // The video leg never asked: it sees the route's raise, not as its own request.
        expect(g.router.getLegPlayout('video-player')).toMatchObject({ asked: false });
    });

    it('a profile restart keeps it: the head re-created, the edges made again', async () => {
        const g = await splitRoute();
        await g.router.requestPlayoutRaise(OUT, undefined, req(500));
        for (const id of [OUT, 'audio-transcoder', 'video-player']) {
            for (const c of g.router.getModuleConnections(id))
                await g.router.removeConnection(c.id, true);
        }
        await g.wire('splitter', 'video-player');
        await g.wire('splitter', 'audio-transcoder');
        await g.wire('audio-transcoder', OUT);
        expect(legD(g.router, OUT)).toBe(840);
        expect(g.router.getHeadPlayoutRaise('splitter')?.raiseMs).toBe(540);
        expect(g.router.getLegPlayout(OUT)).toMatchObject({ asked: true, baseMs: 300 });
    });
});
