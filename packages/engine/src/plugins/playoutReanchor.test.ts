import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    DECAY_HOLD_MS,
    LEG_OFFSET_CLEAR_MS,
    REANCHOR_HEADROOM_MS,
    REANCHOR_HOLD_MS,
    REANCHOR_MARGIN_MS,
    REANCHOR_RETRY_MS,
    REANCHOR_SETTLE_MS,
    REANCHOR_STEP_MS,
    REANCHOR_TOLERANCE_MS,
    REBASE_COOLDOWN_MS,
    REBASE_HOLD_MS,
    RouteReanchor,
    judgeCause,
    raiseCapMs,
    readReanchorRequest,
    type PlayoutRaise,
} from './playoutReanchor.js';
import {
    ceilingWarning,
    decayText,
    headPlayoutStatus,
    heldWarningLeg,
    legClearText,
    legPlayoutStatus,
    legReanchorWarning,
    raiseWarningHead,
    raiseWarningLeg,
    reanchorBadge,
    rebaseWarningHead,
    rebaseWarningLeg,
} from './playoutReanchorText.js';

/**
 * Never drop on lateness (ADR-0005 amendment 2026-10-08): a late leg asks for
 * budget and the engine raises the ROUTE's D. These pin the pure half — what a
 * request is worth on one head, and the exact operator-facing text.
 */

function clock(start = 0) {
    const c = { t: start, now: () => c.t };
    return c;
}

describe('RouteReanchor.offer — the raise arithmetic', () => {
    it('covers the floor plus margin, rounded up to the 20 ms grid (112 → 160)', () => {
        const r = new RouteReanchor(clock().now);
        expect(r.offer({ excessMs: 112 }, 300, 0)).toEqual({ raiseToMs: 160 });
    });

    it('rounds UP — a hair over a step costs the next step', () => {
        expect(new RouteReanchor(clock().now).offer({ excessMs: 120 }, 300, 0)).toEqual({
            raiseToMs: 160,
        });
        expect(new RouteReanchor(clock().now).offer({ excessMs: 120.1 }, 300, 0)).toEqual({
            raiseToMs: 180,
        });
    });

    it('stacks on the raise the head already carries', () => {
        expect(new RouteReanchor(clock().now).offer({ excessMs: 60 }, 300, 160)).toEqual({
            raiseToMs: 160 + 100,
        });
    });

    it('a request inside the 2 s settle window after a raise is covered', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        expect(r.offer({ excessMs: 100 }, 300, 0)).toEqual({ raiseToMs: 140 });
        c.t += REANCHOR_SETTLE_MS - 1;
        expect(r.offer({ excessMs: 400 }, 300, 140)).toBe('covered');
        c.t += 1;
        expect(r.offer({ excessMs: 400 }, 300, 140)).toEqual({ raiseToMs: 140 + 440 });
    });

    it('two legs in one tick: one raise, the larger need converges on its re-ask', () => {
        // A transcoded leg needs 300 ms, a direct leg off the same head 100 ms.
        const c = clock();
        const r = new RouteReanchor(c.now);
        const first = r.offer({ excessMs: 100 }, 300, 0);
        expect(first).toEqual({ raiseToMs: 140 });
        expect(r.offer({ excessMs: 300 }, 300, 140)).toBe('covered');
        // The covered leg re-measures against the raised D after its own hold.
        c.t += REANCHOR_HOLD_MS;
        const second = r.offer({ excessMs: 300 - 140 }, 300, 140) as { raiseToMs: number };
        expect(second.raiseToMs).toBe(140 + 200);
        // Round two leaves both legs inside budget: 340 ≥ 300 + the margin.
        expect(second.raiseToMs).toBeGreaterThanOrEqual(300 + REANCHOR_MARGIN_MS);
    });

    it('caps at the 2 s headroom, then answers ceiling (never a shed)', () => {
        const c = clock();
        const r = new RouteReanchor(c.now);
        expect(r.offer({ excessMs: 500 }, 300, 1_900)).toEqual({ raiseToMs: REANCHOR_HEADROOM_MS });
        c.t += REANCHOR_SETTLE_MS;
        expect(r.offer({ excessMs: 500 }, 300, REANCHOR_HEADROOM_MS)).toBe('ceiling');
    });

    it('caps at MAX_PLAYOUT_OFFSET_MS − base too', () => {
        const c = clock();
        const r = new RouteReanchor(c.now);
        expect(r.offer({ excessMs: 1_000 }, 9_500, 0)).toEqual({ raiseToMs: 500 });
        c.t += REANCHOR_SETTLE_MS;
        expect(r.offer({ excessMs: 1_000 }, 9_500, 500)).toBe('ceiling');
        expect(new RouteReanchor(c.now).offer({ excessMs: 50 }, 10_000, 0)).toBe('ceiling');
    });

    it('at the ceiling the settle window does not mask it', () => {
        const r = new RouteReanchor(clock().now);
        r.offer({ excessMs: 3_000 }, 300, 0);
        expect(r.offer({ excessMs: 50 }, 300, REANCHOR_HEADROOM_MS)).toBe('ceiling');
    });
});

describe('RouteReanchor.offer — a raise that did not help is held (B-210, MR-044)', () => {
    /** A sink-paced leg: its excess sits downstream of the probe, so a raise moves its
     *  placement and its budget alike and the next request reads the same excess. */
    it('the next request after its raise landed, the same excess: held, D kept', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        expect(r.offer({ excessMs: 88 }, 60, 0)).toEqual({ raiseToMs: 140 });
        const landed = { landedForMs: 88, landedAt: c.t };
        // The runner asks again one hold after its budget moved.
        c.t += REANCHOR_HOLD_MS + 100;
        expect(r.offer({ excessMs: 88 + REANCHOR_TOLERANCE_MS }, 60, 140, landed)).toBe('held');
        expect(r.offer({ excessMs: 88 - REANCHOR_TOLERANCE_MS }, 60, 140, landed)).toBe('held');
    });

    it('a falling excess raises as today: the raise helped, more is needed', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        r.offer({ excessMs: 300 }, 60, 0);
        c.t += REANCHOR_HOLD_MS + 100;
        expect(
            r.offer({ excessMs: 300 - REANCHOR_TOLERANCE_MS - 1 }, 60, 340, {
                landedForMs: 300,
                landedAt: 1_000,
            }),
        ).toEqual({ raiseToMs: 340 + 300 });
    });

    it('a rising excess may raise again', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        r.offer({ excessMs: 100 }, 60, 0);
        c.t += REANCHOR_HOLD_MS + 100;
        expect(r.offer({ excessMs: 141 }, 60, 140, { landedForMs: 100, landedAt: 1_000 })).toEqual({
            raiseToMs: 140 + 200,
        });
    });

    it('a request long after the raise is a new episode, not its measurement', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        r.offer({ excessMs: 88 }, 60, 0);
        c.t += REANCHOR_HOLD_MS + REANCHOR_SETTLE_MS + 1;
        expect(r.offer({ excessMs: 88 }, 60, 140, { landedForMs: 88, landedAt: 1_000 })).toEqual({
            raiseToMs: 280,
        });
    });

    it('held once it stays held, also with no raise standing (it came down)', () => {
        const r = new RouteReanchor(clock().now);
        expect(r.offer({ excessMs: 120 }, 60, 0, { heldAtMs: 100 })).toBe('held');
        expect(r.offer({ excessMs: 141 }, 60, 0, { heldAtMs: 100 })).toEqual({ raiseToMs: 200 });
    });

    it('at the cap the same excess is held, not the ceiling: a larger offset cannot help', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        expect(r.offer({ excessMs: 4_400 }, 60, 0)).toEqual({ raiseToMs: REANCHOR_HEADROOM_MS });
        c.t += REANCHOR_HOLD_MS + 100;
        const landed = { landedForMs: 4_400, landedAt: 1_000 };
        expect(r.offer({ excessMs: 4_410 }, 60, REANCHOR_HEADROOM_MS, landed)).toBe('held');
    });

    it('inside the settle window it is covered, never held (measured against the old budget)', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        r.offer({ excessMs: 88 }, 60, 0);
        c.t += 1;
        expect(r.offer({ excessMs: 88 }, 60, 140, { landedForMs: 88, landedAt: 1_000 })).toBe(
            'covered',
        );
    });
});

describe('RouteReanchor.offer — a late timeline past the route reach (B-210)', () => {
    /** Its content itself arrives late (its bus-ingress taps, its aligners' pace). */
    const late = { lateContent: true };

    it('re-anchors the leg alone: the route is not raised to its cap for it', () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        // A source 5 s behind at 1x, on a route that can take 2 s at most.
        expect(r.offer({ excessMs: 4_900, cause: 'timeline' }, 60, 0, late)).toEqual({
            legMs: 4_940,
        });
        // No route raise was made: no settle window opened for the next request.
        c.t += 1;
        expect(r.offer({ excessMs: 100, cause: 'timeline' }, 60, 0)).toEqual({ raiseToMs: 140 });
    });

    it('content on time is a lateness at the sink: the route raised (then held), never the leg alone', () => {
        const r = new RouteReanchor(clock().now);
        expect(r.offer({ excessMs: 4_400, cause: 'timeline' }, 60, 0)).toEqual({
            raiseToMs: REANCHOR_HEADROOM_MS,
        });
        expect(
            new RouteReanchor(clock().now).offer({ excessMs: 4_400, cause: 'timeline' }, 60, 0, {
                lateContent: false,
            }),
        ).toEqual({ raiseToMs: REANCHOR_HEADROOM_MS });
    });

    it('what the route can still take it takes; the rest of a backlog as today', () => {
        const r = new RouteReanchor(clock().now);
        expect(r.offer({ excessMs: 500, cause: 'timeline' }, 60, 1_000, late)).toEqual({
            raiseToMs: 1_540,
        });
        // A raise absorbs a backlog (its excess falls), so a backlog may still take the cap.
        expect(
            new RouteReanchor(clock().now).offer(
                { excessMs: 4_900, cause: 'backlog' },
                60,
                0,
                late,
            ),
        ).toEqual({ raiseToMs: REANCHOR_HEADROOM_MS });
    });

    it('a leg on its own takes more on its own, up to the offset ceiling, then ceiling', () => {
        const r = new RouteReanchor(clock().now);
        expect(
            r.offer({ excessMs: 100, cause: 'timeline' }, 60, 0, { ...late, ownMs: 2_000 }),
        ).toEqual({ legMs: 2_140 });
        expect(r.offer({ excessMs: 20_000, cause: 'timeline' }, 60, 0, late)).toEqual({
            legMs: 9_940,
        });
        expect(
            r.offer({ excessMs: 500, cause: 'timeline' }, 60, 0, { ...late, ownMs: 9_940 }),
        ).toBe('ceiling');
    });

    it("inside the settle window of another leg's raise it is covered", () => {
        const c = clock(1_000);
        const r = new RouteReanchor(c.now);
        r.offer({ excessMs: 100 }, 60, 0);
        expect(r.offer({ excessMs: 4_900, cause: 'timeline' }, 60, 140, late)).toBe('covered');
    });
});

describe('judgeCause — a queue the raises filled is not backlog (B-210)', () => {
    it('backlog only past the standing raise', () => {
        expect(judgeCause({ cause: 'backlog', queuedMs: 2_090 }, 1_900)).toBe('backlog');
        expect(judgeCause({ cause: 'backlog', queuedMs: 1_930 }, 1_900)).toBe('timeline');
        expect(judgeCause({ cause: 'backlog', queuedMs: 400 }, 0)).toBe('backlog');
        expect(judgeCause({ cause: 'timeline', queuedMs: 0 }, 0)).toBe('timeline');
    });
});

describe('raiseCapMs', () => {
    it('is the headroom, within the offset ceiling', () => {
        expect(raiseCapMs(300)).toBe(REANCHOR_HEADROOM_MS);
        expect(raiseCapMs(9_500)).toBe(500);
        expect(raiseCapMs(10_000)).toBe(0);
    });
});

describe('readReanchorRequest', () => {
    const raise = {
        kind: 'raise',
        element: 'vdec',
        excessMs: 112.4,
        worstMs: 171,
        cause: 'timeline',
        queuedMs: 0,
        budgetMs: 60,
        tsOffsetMs: 60,
        latencyMs: 0,
        holdMs: 15000,
    };
    const rebase = {
        kind: 'rebase',
        element: 'vdec',
        latenessMs: -21340.2,
        appliedOffsetNs: -21340200000,
        padOffsetNs: -21340200000,
        flushed: false,
        sanityMs: 10000,
        budgetMs: 300,
        count: 1,
    };

    it('reads the runner payloads of both kinds verbatim', () => {
        expect(readReanchorRequest(raise)).toEqual(raise);
        expect(readReanchorRequest(rebase)).toEqual(rebase);
    });

    it('rejects what is not a request', () => {
        expect(readReanchorRequest(null)).toBeNull();
        expect(readReanchorRequest('raise')).toBeNull();
        expect(readReanchorRequest({ ...raise, kind: 'shed' })).toBeNull();
        expect(readReanchorRequest({ ...raise, excessMs: Number.NaN })).toBeNull();
        expect(readReanchorRequest({ ...raise, excessMs: 0 })).toBeNull();
        expect(readReanchorRequest({ ...rebase, latenessMs: 'far' })).toBeNull();
    });

    it('fills what an older runner left out, and only names two causes', () => {
        const r = readReanchorRequest({ kind: 'raise', excessMs: 80, cause: 'odd' });
        expect(r).toMatchObject({ cause: 'timeline', worstMs: 80, holdMs: REANCHOR_HOLD_MS });
    });
});

describe('warning texts (exact, ADR-0005 2026-10-08)', () => {
    const raise: PlayoutRaise = {
        headId: 'srt-1',
        baseMs: 300,
        raiseMs: 180,
        since: 0,
        lastRaiseAt: 0,
        requests: 1,
        lastBy: {
            moduleId: 'vp-1',
            label: 'video-player-1',
            element: 'vdec',
            cause: 'timeline',
            excessMs: 112,
            queuedMs: 0,
            holdMs: 15_000,
        },
        atCeiling: false,
    };

    it('head, raise — a late timeline', () => {
        expect(raiseWarningHead(raise)).toBe(
            'Playout re-anchored: offset raised 300 → 480 ms because video-player-1 (vdec) ' +
                'arrived 112 ms late for 15 s with nothing queued (hop transit or late timeline). ' +
                'Nothing was dropped. To keep it, set Playout Offset to 480 ms; any edit of ' +
                'Playout Offset resets the raise.',
        );
    });

    it('head, raise — a backlog', () => {
        expect(
            raiseWarningHead({
                ...raise,
                lastBy: { ...raise.lastBy, cause: 'backlog', queuedMs: 180 },
            }),
        ).toContain(
            'arrived 112 ms late for 15 s and held 180 ms of backlog after a stall. Nothing',
        );
    });

    it('leg, raise', () => {
        expect(raiseWarningLeg({ excessMs: 112, holdMs: 15_000 }, 'srt-input-1', 300, 480)).toBe(
            'Arrived 112 ms past the playout budget for 15 s — asked route head srt-input-1 ' +
                'to raise the playout offset 300 → 480 ms; nothing dropped.',
        );
    });

    it('ceiling (both ends): no further raise, nothing dropped', () => {
        expect(ceilingWarning(2_000, 300)).toBe(
            'Playout re-anchor ceiling reached (+2000 ms over a 300 ms budget) — no further ' +
                're-anchor; nothing dropped — restart this output to reclaim its queues or raise ' +
                'Playout Offset manually.',
        );
    });

    it('leg, rebase — behind, and ahead of, the house clock', () => {
        expect(rebaseWarningLeg({ latenessMs: 21_340.2 }, 'rist-input-2')).toBe(
            'Timeline 21.3 s behind the house clock — re-anchored this output onto arrival + ' +
                'playout offset. Lipsync with other outputs of rist-input-2 is NOT guaranteed ' +
                'until its timeline is fixed.',
        );
        expect(rebaseWarningLeg({ latenessMs: -21_340.2 }, 'rist-input-2')).toContain(
            'Timeline 21.3 s ahead of the house clock',
        );
    });

    it('head, rebase', () => {
        expect(
            rebaseWarningHead({
                moduleId: 'vp-1',
                label: 'video-player-1',
                element: 'vdec',
                latenessMs: 21_340,
                at: 0,
            }),
        ).toBe(
            "video-player-1 found this producer's stamps 21.3 s off the house clock and " +
                're-anchored itself — producer timeline fault (stamper / PCR PID / ' +
                'identity unwrap).',
        );
    });

    it('the head badge names the raise, red only at the ceiling', () => {
        expect(reanchorBadge(raise)).toEqual({
            icon: 'clock-alert',
            text: 're-anchored +180 ms',
            color: '#f59e0b',
        });
        expect(reanchorBadge({ ...raise, atCeiling: true }).color).toBe('#ef4444');
    });
});

describe('B-210 texts (exact)', () => {
    it('held, on the leg', () => {
        expect(heldWarningLeg(88.4, 'SRT -> MUL', 200)).toBe(
            'Plays 88 ms late at its device: a larger playout offset cannot help, so route head ' +
                'SRT -> MUL is held at 200 ms; nothing dropped.',
        );
    });

    it('a leg re-anchored on its own', () => {
        expect(legReanchorWarning({ excessMs: 4_900, holdMs: 15_000 }, 4_940, 'SRT -> MUL')).toBe(
            'Arrived 4900 ms past the playout budget for 15 s, more than route head SRT -> MUL can ' +
                'be raised: re-anchored this output on its own by +4940 ms. Lipsync with other ' +
                'outputs of SRT -> MUL is NOT guaranteed until its source is back on time; nothing dropped.',
        );
    });

    it('the INFO lines of a step down name the head, the step and what is skipped', () => {
        expect(decayText('SRT -> MUL', 60, 1_940)).toBe(
            'Playout re-anchor: SRT -> MUL back to its configured 60 ms, down 1940 ms in one step: ' +
                'the outputs that asked arrived on time for 60 s; about 1940 ms of held content ' +
                'skipped at each, its time passed',
        );
        expect(legClearText('Audio Out', 'SRT -> MUL', 4_940)).toBe(
            "Playout re-anchor: Audio Out back on route head SRT -> MUL's playout offset, down " +
                '4940 ms in one step: its source arrives on time again; about 4940 ms of held ' +
                'content skipped, its time passed',
        );
    });

    const raise: PlayoutRaise = {
        headId: 'srt-1',
        baseMs: 60,
        raiseMs: 140,
        since: Date.UTC(2026, 10, 2, 17, 32, 49),
        lastRaiseAt: Date.UTC(2026, 10, 2, 17, 32, 49),
        requests: 3,
        lastBy: {
            moduleId: 'aout',
            label: 'Audio Out',
            element: 'sink',
            cause: 'timeline',
            excessMs: 88,
            queuedMs: 0,
            holdMs: 15_000,
        },
        atCeiling: false,
        held: { moduleId: 'aout', label: 'Audio Out', excessMs: 90, since: 0 },
    };

    it('the head says it is held, in its reason and its badge', () => {
        expect(headPlayoutStatus(raise, null, 60).reason).toBe(
            'hop transit or late timeline — held: a larger offset cannot help Audio Out',
        );
        expect(reanchorBadge(raise).text).toBe('re-anchored +140 ms, held');
    });

    it('the leg section: configured, raised to, since when (also with no request, a restart)', () => {
        expect(
            legPlayoutStatus(null, {
                headLabel: 'SRT -> MUL',
                configuredMs: 60,
                raisedToMs: 2_060,
                since: Date.UTC(2026, 10, 2, 17, 32, 49),
            }),
        ).toEqual({
            budget: null,
            lateBy: null,
            cause: null,
            head: 'SRT -> MUL',
            configured: 60,
            raisedTo: 2_060,
            since: '2026-11-02T17:32:49Z',
        });
    });
});

describe('the numbers, pinned across the process boundary', () => {
    it('are the amendment’s', () => {
        expect([
            REANCHOR_TOLERANCE_MS,
            REANCHOR_HOLD_MS,
            REANCHOR_RETRY_MS,
            REANCHOR_STEP_MS,
            REANCHOR_MARGIN_MS,
            REANCHOR_HEADROOM_MS,
            REANCHOR_SETTLE_MS,
            REBASE_HOLD_MS,
            REBASE_COOLDOWN_MS,
        ]).toEqual([40, 15_000, 30_000, 20, 40, 2_000, 2_000, 3_000, 60_000]);
    });

    it("B-210: a raise comes down after 60 s on time, a leg's own re-anchor after 3 s", () => {
        expect([DECAY_HOLD_MS, LEG_OFFSET_CLEAR_MS]).toEqual([60_000, 3_000]);
    });

    it('match the runner policy’s own fallbacks (backlog_shed.py)', () => {
        const py = readFileSync(join(__dirname, '..', 'child-process', 'backlog_shed.py'), 'utf8');
        const pyNum = (name: string): number =>
            Number(new RegExp(`^${name} = ([0-9_.]+)$`, 'm').exec(py)?.[1].replace(/_/g, ''));
        expect(pyNum('DEFAULT_REANCHOR_TOLERANCE_MS')).toBe(REANCHOR_TOLERANCE_MS);
        expect(pyNum('DEFAULT_REANCHOR_HOLD_MS')).toBe(REANCHOR_HOLD_MS);
        expect(pyNum('DEFAULT_REANCHOR_RETRY_MS')).toBe(REANCHOR_RETRY_MS);
        expect(pyNum('DEFAULT_REBASE_HOLD_MS')).toBe(REBASE_HOLD_MS);
        expect(pyNum('DEFAULT_REBASE_COOLDOWN_MS')).toBe(REBASE_COOLDOWN_MS);
    });
});
