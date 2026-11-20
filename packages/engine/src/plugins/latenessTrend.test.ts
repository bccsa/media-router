import { describe, it, expect } from 'vitest';
import {
    LatenessTrend,
    TREND_WINDOW_MS,
    latenessTrendText,
    type GapMark,
} from './latenessTrend.js';

// The Lateness trend (WI-P4-12, OQ-34; B-241): the slope over 3 min since the last reset, pooled
// across the steps of collapsed holes and gaps, a labelled row.
const trend = () => new LatenessTrend(6_000, 1_000);
const mk = (reset: string, step = '0'): GapMark => ({ reset, step });

/** Readings every 2 s from `from` for `forMs`, lateness `ms(t)` with t in ms since `from`. */
function feed(
    t: LatenessTrend,
    from: number,
    forMs: number,
    ms: (t: number) => number,
    mark: GapMark | ((t: number) => GapMark) = mk('a'),
    load: (t: number) => number = () => 0,
) {
    for (let at = from; at <= from + forMs; at += 2_000) {
        const m = typeof mark === 'function' ? mark(at - from) : mark;
        t.add(at, ms(at - from), m, load(at - from));
    }
}

/** A collapsed hole every `everyMs`: the step part counts them. */
const holes = (everyMs: number) => (x: number) => mk('a', String(Math.floor(x / everyMs)));

describe('LatenessTrend', () => {
    it('measures until 3 min ran without a gap, then gives the slope in ms/min', () => {
        const t = trend();
        expect(t.slope()).toBeUndefined();
        feed(t, 0, TREND_WINDOW_MS - 4_000, (x) => 200 + (12 * x) / 60_000);
        expect(t.slope()).toEqual({});
        feed(t, TREND_WINDOW_MS - 2_000, 2_000, (x) => 200 + (12 * (x + 178_000)) / 60_000);
        expect(t.slope()!.msPerMin).toBeCloseTo(12, 6);
    });

    it('reads the last 3 min only', () => {
        const t = trend();
        feed(t, 0, 300_000, (x) => (x < 120_000 ? 100 : 100 + (6 * (x - 120_000)) / 60_000));
        expect(t.slope()!.msPerMin).toBeCloseTo(6, 6);
    });

    it('a hole in the readings is a gap: it measures afresh', () => {
        const t = trend();
        feed(t, 0, 200_000, (x) => (3 * x) / 60_000);
        expect(t.slope()!.msPerMin).toBeCloseTo(3, 6);
        // 8 s without a reading, then a backlog gone: the line across it would read a fall.
        feed(t, 208_000, 100_000, () => 0);
        expect(t.slope()).toEqual({});
    });

    it('a reset its source counts (a new element generation) starts it afresh', () => {
        const t = trend();
        feed(t, 0, 200_000, (x) => 500 + (20 * x) / 60_000);
        feed(t, 202_000, 120_000, () => 40, mk('b'));
        expect(t.slope()).toEqual({});
        feed(t, 324_000, 60_000, () => 40, mk('b'));
        expect(t.slope()).toEqual({ msPerMin: 0 });
    });

    it('a collapsed hole every 40 s on a flat line reads 0 ± 1 ms/min at 3 min (F-5)', () => {
        const t = trend();
        feed(t, 0, TREND_WINDOW_MS, (x) => 120 + ((x / 2_000) % 3) - 1, holes(40_000));
        expect(Math.abs(t.slope()!.msPerMin!)).toBeLessThanOrEqual(1);
    });

    it('a +12 ms/min line with a hole every 20 s reads +12 ± 1', () => {
        const t = trend();
        feed(t, 0, TREND_WINDOW_MS, (x) => 200 + (12 * x) / 60_000, holes(20_000));
        expect(t.slope()!.msPerMin!).toBeGreaterThanOrEqual(11);
        expect(t.slope()!.msPerMin!).toBeLessThanOrEqual(13);
    });

    it('a step of +200 ms at each hole on a flat line is no growth: 0', () => {
        const t = trend();
        feed(t, 0, TREND_WINDOW_MS, (x) => 100 + 200 * Math.floor(x / 40_000), holes(40_000));
        expect(t.slope()).toEqual({ msPerMin: 0 });
        // The whole window as one line would read +200 ms per 40 s.
        const one = trend();
        feed(one, 0, TREND_WINDOW_MS, (x) => 100 + 200 * Math.floor(x / 40_000));
        expect(one.slope()!.msPerMin!).toBeGreaterThan(250);
    });

    it('a generation change among the holes resets it to measuring', () => {
        const t = trend();
        feed(t, 0, TREND_WINDOW_MS, () => 100, holes(40_000));
        expect(t.slope()).toEqual({ msPerMin: 0 });
        t.add(TREND_WINDOW_MS + 2_000, 100, mk('b', '5'));
        expect(t.slope()).toEqual({});
    });

    it("V-P4-9's shape (100 ms to 10 s in 3 min, holes on the way) reads positive at 3 min", () => {
        const t = trend();
        feed(t, 0, TREND_WINDOW_MS, (x) => 100 + (9_900 * x) / 180_000, holes(25_000));
        expect(t.slope()!.msPerMin!).toBeGreaterThan(3_000);
    });

    it('segments of one reading count nothing; a window of only those measures', () => {
        const t = trend();
        feed(
            t,
            0,
            TREND_WINDOW_MS,
            (x) => x,
            (x) => mk('a', String(x)),
        );
        expect(t.slope()).toEqual({});
    });

    it('an underrun under load in the window is carried, and leaves with the window', () => {
        const t = trend();
        feed(
            t,
            0,
            TREND_WINDOW_MS,
            (x) => 100 + x / 6_000,
            mk('a'),
            (x) => (x > 60_000 ? 3 : 0),
        );
        expect(t.slope()).toEqual({ msPerMin: expect.closeTo(10, 6), underLoad: true });
        feed(
            t,
            TREND_WINDOW_MS + 2_000,
            TREND_WINDOW_MS,
            () => 130,
            mk('a'),
            () => 3,
        );
        expect(t.slope()).toEqual({ msPerMin: 0 });
    });

    it('readings closer than its step count once; gap() forgets them', () => {
        const t = trend();
        t.add(0, 10, mk('a'));
        t.add(500, 9999, mk('a'));
        feed(t, 2_000, TREND_WINDOW_MS, () => 10);
        expect(t.slope()).toEqual({ msPerMin: 0 });
        t.gap();
        expect(t.slope()).toBeUndefined();
    });

    it('the row text: signed, labelled when positive, measuring before 3 min', () => {
        expect(latenessTrendText({ msPerMin: 12.2 })).toBe(
            '+12 ms/min — decode or device slower than real time',
        );
        expect(latenessTrendText({ msPerMin: -3.4 })).toBe('−3 ms/min');
        expect(latenessTrendText({ msPerMin: 0.3 })).toBe('0 ms/min');
        expect(latenessTrendText({})).toBe('measuring');
        expect(latenessTrendText({ msPerMin: 40, underLoad: true })).toBe(
            '+40 ms/min — falling behind under load',
        );
        expect(latenessTrendText({ msPerMin: -4, underLoad: true })).toBe('−4 ms/min');
    });
});
