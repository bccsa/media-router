import { describe, it, expect } from 'vitest';
import { LatenessTrend, TREND_WINDOW_MS, latenessTrendText } from './latenessTrend.js';

// The Lateness trend (WI-P4-12, OQ-34): the slope over 3 min with no gap, a labelled row.
const trend = () => new LatenessTrend(6_000, 1_000);

/** Readings every 2 s from `from` for `forMs`, lateness `ms(t)` with t in ms since `from`. */
function feed(
    t: LatenessTrend,
    from: number,
    forMs: number,
    ms: (t: number) => number,
    mark = 'a',
) {
    for (let at = from; at <= from + forMs; at += 2_000) t.add(at, ms(at - from), mark);
}

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

    it('a gap its source counts (the mark moves) starts it afresh', () => {
        const t = trend();
        feed(t, 0, 200_000, (x) => 500 + (20 * x) / 60_000);
        feed(t, 202_000, 120_000, () => 40, 'b');
        expect(t.slope()).toEqual({});
        feed(t, 324_000, 60_000, () => 40, 'b');
        expect(t.slope()).toEqual({ msPerMin: 0 });
    });

    it('readings closer than its step count once; gap() forgets them', () => {
        const t = trend();
        t.add(0, 10, 'a');
        t.add(500, 9999, 'a');
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
    });
});
