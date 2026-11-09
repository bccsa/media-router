import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    DISPLAY_NOT_PRESENTING_TEXT,
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

    it('drops (rate drops and frames behind) and late releases per minute over the last minute', () => {
        const w = new VideoPaceWatches();
        w.take('p', pace(), 0);
        w.take('p', pace({ 'rate-drops': 300, 'display-behind': 10, late: 30 }), 30_000);
        expect(one(w).rateMatch.dropsPerMin).toBe(620);
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
        expect(one(w).gapMark).not.toBe(before);
    });

    it('display not presenting: a change when it stops and when it presents again', () => {
        const w = new VideoPaceWatches();
        expect(w.take('p', pace(), 0).changed).toBe(false);
        const mark = one(w).gapMark;
        expect(w.take('p', pace({ 'display-presenting': false }), 2_000).changed).toBe(true);
        expect(one(w).presenting).toBe(false);
        expect(w.take('p', pace({ 'display-presenting': false }), 4_000).changed).toBe(false);
        expect(w.take('p', pace(), 6_000).changed).toBe(true);
        expect(one(w).presenting).toBe(true);
        expect(one(w).gapMark).toBe(mark);
        w.take('p', pace({ 'gaps-collapsed': 1 }), 8_000);
        expect(one(w).gapMark).not.toBe(mark);
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
