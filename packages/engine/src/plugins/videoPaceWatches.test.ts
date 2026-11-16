import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    DISPLAY_NOT_PRESENTING_TEXT,
    DisplayStatsWatch,
    VideoPaceWatches,
    rateMatchText,
} from './videoPaceWatches.js';

// `mrvideopace` as gstmrvideopace.cpp posts it (vp_structure), every 2 s of arrivals.
const pace = (o: Record<string, number | string | boolean> = {}) => ({
    released: 500,
    late: 0,
    'rate-drops': 0,
    'gaps-collapsed': 0,
    unpaced: 0,
    'content-fps-x100': 5000,
    'refresh-ns': 20_000_000,
    'refresh-source': 'measured',
    'achieved-ns': 0,
    'display-behind': 0,
    'mean-hold-ns': 12_000_000,
    'present-lateness-ns': 240_000_000,
    'display-presenting': true,
    ...o,
});
const one = (w: VideoPaceWatches) => w.list()[0];

describe('VideoPaceWatches', () => {
    it('the presented lateness, the rate match and the hold', () => {
        const w = new VideoPaceWatches();
        w.take('vp_pace', pace(), 0);
        expect(one(w)).toMatchObject({
            name: 'vp_pace',
            presentLatenessMs: 240,
            rateMatch: { contentFps: 50, displayHz: 50, displaySource: 'measured', dropsPerMin: 0 },
            lateReleasesPerMin: 0,
            meanHoldMs: 12,
            presenting: true,
        });
        // Nothing released yet: no lateness of its own.
        w.take('vp_pace', pace({ released: 0 }), 2_000);
        expect(one(w).presentLatenessMs).toBeUndefined();
    });

    it('the display rate: achieved, else the mode measured or nominal, else unknown', () => {
        const w = new VideoPaceWatches();
        const rate = (o: Record<string, number | string>) => {
            w.take('p', pace(o), 0);
            return one(w).rateMatch;
        };
        expect(rate({ 'achieved-ns': 17_667_844 })).toMatchObject({ displaySource: 'achieved' });
        expect(rate({ 'achieved-ns': 17_667_844 }).displayHz).toBeCloseTo(56.6, 1);
        expect(
            rate({ 'refresh-source': 'nominal', 'refresh-ns': 16_666_667 }).displayHz,
        ).toBeCloseTo(60, 3);
        expect(rate({ 'refresh-source': 'none', 'refresh-ns': 0 })).toMatchObject({
            displayHz: 0,
            displaySource: 'none',
        });
    });

    it('drops (rate drops, those behind included once) and late releases per minute over the last minute', () => {
        const w = new VideoPaceWatches();
        w.take('p', pace(), 0);
        w.take('p', pace({ 'rate-drops': 300, 'display-behind': 10, late: 30 }), 30_000);
        expect(one(w).rateMatch.dropsPerMin).toBe(600);
        expect(one(w).lateReleasesPerMin).toBe(60);
        // Past a minute the first report leaves the window.
        w.take('p', pace({ 'rate-drops': 300, 'display-behind': 10, late: 30 }), 70_000);
        expect(one(w).rateMatch.dropsPerMin).toBe(0);
        expect(one(w).lateReleasesPerMin).toBe(0);
    });

    it('a new element under the name (fewer released) starts its counts afresh', () => {
        const w = new VideoPaceWatches();
        w.take('p', pace({ 'rate-drops': 1000 }), 0);
        const before = one(w).gapMark;
        w.take('p', pace({ released: 10, 'rate-drops': 0 }), 2_000);
        expect(one(w).rateMatch.dropsPerMin).toBe(0);
        expect(one(w).gapMark.reset).not.toBe(before.reset);
    });

    it('display not presenting: a change when it stops and when it presents again', () => {
        const w = new VideoPaceWatches();
        expect(w.take('p', pace(), 0).changed).toBe(false);
        const mark = one(w).gapMark;
        expect(w.take('p', pace({ 'display-presenting': false }), 2_000).changed).toBe(true);
        expect(one(w).presenting).toBe(false);
        expect(w.take('p', pace({ 'display-presenting': false }), 4_000).changed).toBe(false);
        // Not presenting resets the trend (B-241).
        expect(one(w).gapMark.reset).not.toBe(mark.reset);
        expect(w.take('p', pace(), 6_000).changed).toBe(true);
        expect(one(w).presenting).toBe(true);
        expect(one(w).gapMark).toEqual(mark);
        // A collapsed hole steps it, no reset.
        w.take('p', pace({ 'gaps-collapsed': 1 }), 8_000);
        expect(one(w).gapMark.reset).toBe(mark.reset);
        expect(one(w).gapMark.step).not.toBe(mark.step);
        expect(DISPLAY_NOT_PRESENTING_TEXT).toBe('Display not presenting (output off?)');
    });

    it('expires a pace that stopped reporting', () => {
        const w = new VideoPaceWatches();
        w.take('p', pace(), 0);
        w.expire(6_000, 6_000);
        expect(w.list()).toHaveLength(1);
        w.expire(6_001, 6_000);
        expect(w.list()).toEqual([]);
    });

    it('the row text', () => {
        const r = {
            contentFps: 50,
            displayHz: 50,
            displaySource: 'measured' as const,
            dropsPerMin: 0,
        };
        expect(rateMatchText(r)).toBe('50.00 fps → 50.00 Hz measured, 0 drops/min');
        expect(
            rateMatchText({ ...r, displayHz: 59.94, displaySource: 'nominal', dropsPerMin: 599.6 }),
        ).toBe('50.00 fps → 59.94 Hz nominal, 600 drops/min');
        expect(rateMatchText({ ...r, contentFps: 0, displayHz: 0, displaySource: 'none' })).toBe(
            'content rate unknown → display rate unknown, 0 drops/min',
        );
    });

    it('reads the message as recorded (forwarded-messages.json)', () => {
        const fixture = JSON.parse(
            readFileSync(
                join(process.cwd(), 'plugins/mpegts-core/tests/fixtures/forwarded-messages.json'),
                'utf8',
            ),
        ) as { mrvideopace: Record<string, unknown> };
        const w = new VideoPaceWatches();
        w.take('vp_pace', fixture.mrvideopace, 0);
        expect(one(w)).toMatchObject({
            presentLatenessMs: 246.683777,
            rateMatch: { contentFps: 50, displayHz: 50, displaySource: 'measured' },
            presenting: true,
        });
    });
});

// 0008's `display-stats` as waylandsink returns it (the counters the engine reads), every 10 s.
const stats = (replaced: number, discarded: number) => ({
    presented: 1000,
    'presented-seq': 900,
    discarded,
    replaced,
    'present-timeouts': 0,
    'not-presented': 0,
    'refresh-ns': 20_000_000,
    'clock-monotonic': true,
});

describe('DisplayStatsWatch (B-242)', () => {
    it('totals as read, per minute over the last minute', () => {
        const w = new DisplayStatsWatch();
        w.take(stats(0, 0), 0);
        expect(w.reading(0)).toEqual({
            replaced: 0,
            discarded: 0,
            replacedPerMin: 0,
            discardedPerMin: 0,
        });
        for (let t = 10_000; t <= 60_000; t += 10_000) w.take(stats(t / 10_000, 0), t);
        expect(w.reading(60_000)).toMatchObject({ replaced: 6, replacedPerMin: 6 });
        // Older reads leave the window: two more in the next 20 s, over the 60 s kept.
        w.take(stats(7, 2), 70_000);
        w.take(stats(8, 2), 80_000);
        expect(w.reading(80_000)).toEqual({
            replaced: 8,
            discarded: 2,
            replacedPerMin: 6,
            discardedPerMin: 2,
        });
    });

    it('a count below the last is a new sink: its counts start again', () => {
        const w = new DisplayStatsWatch();
        w.take(stats(50, 9), 0);
        w.take(stats(1, 0), 10_000);
        expect(w.reading(10_000)).toEqual({
            replaced: 1,
            discarded: 0,
            replacedPerMin: 0,
            discardedPerMin: 0,
        });
    });

    it('a missing property, an error or a structure without the counters reads nothing', () => {
        const w = new DisplayStatsWatch();
        w.take(undefined, 0);
        w.take(null, 0);
        w.take('get_property failed', 0);
        w.take({ presented: 5 }, 0);
        expect(w.reading(0)).toBeUndefined();
        w.take(stats(1, 1), 0);
        expect(w.reading(30_000)).toBeDefined();
        expect(w.reading(30_001)).toBeUndefined(); // three reads missed
        w.clear();
        expect(w.reading(0)).toBeUndefined();
    });

    it("the row text adds them after the drain's drops", () => {
        const r = {
            contentFps: 50,
            displayHz: 60,
            displaySource: 'achieved' as const,
            dropsPerMin: 0,
        };
        const d = { replaced: 3, discarded: 0, replacedPerMin: 0.4, discardedPerMin: 0 };
        expect(rateMatchText(r, 15, d)).toBe(
            '50.00 fps → 60.00 Hz achieved, 0 drops/min, 15 drain drops/min; replaced 0/min (3 total), discarded 0/min (0 total)',
        );
        expect(rateMatchText(r, undefined, d)).toBe(
            '50.00 fps → 60.00 Hz achieved, 0 drops/min; replaced 0/min (3 total), discarded 0/min (0 total)',
        );
    });
});
