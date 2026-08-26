import { describe, it, expect } from 'vitest';
import {
    axisTicks,
    formatTick,
    logTicks,
    polylinePoints,
    toX,
    toY,
    type PlotBox,
} from './graphScale';

const box: PlotBox = { left: 30, right: 230, top: 10, bottom: 110 };
const db = { min: -60, max: 0 };

describe('toX / toY', () => {
    it('maps the domain onto the plot box, max at the top', () => {
        expect(toX(-60, db, box)).toBe(30);
        expect(toX(0, db, box)).toBe(230);
        expect(toX(-30, db, box)).toBe(130);
        expect(toY(0, db, box)).toBe(10);
        expect(toY(-60, db, box)).toBe(110);
        expect(toY(-30, db, box)).toBe(60);
    });

    it('clamps out-of-domain values to the plot edge', () => {
        expect(toY(12, db, box)).toBe(10);
        expect(toY(-200, db, box)).toBe(110);
        expect(toX(999, db, box)).toBe(230);
    });

    it('a log x axis spaces decades evenly', () => {
        const freq = { min: 20, max: 20000 };
        expect(toX(20, freq, box, true)).toBe(30);
        expect(toX(20000, freq, box, true)).toBe(230);
        // 200 Hz and 2 kHz are one and two decades in — evenly spaced.
        const a = toX(200, freq, box, true);
        const b = toX(2000, freq, box, true);
        expect(b - a).toBeCloseTo(a - 30, 6);
    });
});

describe('polylinePoints', () => {
    it('emits an SVG points list with clamped, rounded coordinates', () => {
        const points = [
            { x: -60, y: -60 },
            { x: 0, y: 12 },
        ];
        expect(polylinePoints(points, db, db, box)).toBe('30.0,110.0 230.0,10.0');
    });
});

describe('axisTicks', () => {
    it('includes both endpoints', () => {
        expect(axisTicks(db, 10)).toEqual([-60, -50, -40, -30, -20, -10, 0]);
        expect(axisTicks({ min: -18, max: 18 }, 6)).toEqual([-18, -12, -6, 0, 6, 12, 18]);
    });
});

describe('logTicks', () => {
    it('gives 1-2-5 per decade inside the domain', () => {
        expect(logTicks({ min: 20, max: 20000 })).toEqual([
            20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
        ]);
    });
});

describe('formatTick', () => {
    it('abbreviates thousands and trims decimals', () => {
        expect(formatTick(20)).toBe('20');
        expect(formatTick(-18)).toBe('-18');
        expect(formatTick(1000)).toBe('1k');
        expect(formatTick(20000)).toBe('20k');
        expect(formatTick(1500)).toBe('1.5k');
        expect(formatTick(-6.5)).toBe('-6.5');
    });
});
