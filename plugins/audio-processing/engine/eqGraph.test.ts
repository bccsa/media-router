/**
 * The EQ curve as the settings panel receives it: band summing, the trims, the
 * bypass rule and the published `StatusGraph`. The per-filter-type magnitude
 * maths it builds on has its own known-point tests in `eqBiquad.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { eqCurvePoints, eqGraph, eqResponseDb, readEqParams } from './eqGraph.js';
import { EQ_DEFAULT_FREQS, EQ_BANDS } from './eqBands.js';

const eq = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    eqEnabled: true,
    ...over,
});

describe('readEqParams', () => {
    it('takes the per-band defaults from the band table', () => {
        const p = readEqParams({});
        expect(p.bands).toHaveLength(EQ_BANDS);
        expect(p.bands.map((b) => b.freq)).toEqual(EQ_DEFAULT_FREQS);
        expect(p.bands.every((b) => b.type === 'off')).toBe(true);
    });

    it('clamps the HPF cutoff to the element range', () => {
        expect(readEqParams({ hpfFreq: 5 }).hpfFreq).toBe(20);
        expect(readEqParams({ hpfFreq: 9000 }).hpfFreq).toBe(500);
    });
});

describe('eqResponseDb', () => {
    it('every band off is a flat 0 dB line', () => {
        const p = readEqParams(eq());
        for (const f of [20, 100, 1000, 10000, 20000]) expect(eqResponseDb(f, p)).toBeCloseTo(0, 6);
    });

    it('sums overlapping bands in dB', () => {
        const p = readEqParams(
            eq({
                eqBand0Type: 'bell',
                eqBand0Freq: 1000,
                eqBand0Gain: 4,
                eqBand0Q: 1,
                eqBand1Type: 'bell',
                eqBand1Freq: 1000,
                eqBand1Gain: 4,
                eqBand1Q: 1,
            }),
        );
        expect(eqResponseDb(1000, p)).toBeCloseTo(8, 1);
    });

    it('input + output trims offset the whole curve', () => {
        const p = readEqParams(eq({ eqInputGain: 2, eqOutputGain: -5 }));
        expect(eqResponseDb(1000, p)).toBeCloseTo(-3, 6);
    });

    it('bypass flattens the EQ but leaves the HPF in circuit', () => {
        const p = readEqParams(
            eq({
                eqBypass: true,
                eqInputGain: 6,
                eqBand0Type: 'bell',
                eqBand0Gain: 12,
                hpfEnabled: true,
                hpfFreq: 100,
            }),
        );
        // Not exactly 0 at 1 kHz — the 100 Hz HPF still contributes.
        expect(eqResponseDb(1000, p)).toBeCloseTo(0, 2);
        expect(eqResponseDb(100, p)).toBeCloseTo(-6, 0);
    });
});

describe('eqCurvePoints', () => {
    it('spans 20 Hz to 20 kHz, ascending', () => {
        const points = eqCurvePoints(readEqParams(eq()), 24);
        expect(points[0][0]).toBeCloseTo(20, 1);
        expect(points[points.length - 1][0]).toBeCloseTo(20000, 0);
        for (let i = 1; i < points.length; i++) {
            expect(points[i][0]).toBeGreaterThan(points[i - 1][0]);
        }
    });
});

describe('eqGraph', () => {
    it('publishes nothing while the EQ stage is off', () => {
        expect(eqGraph({})).toBeNull();
        expect(eqGraph({ eqEnabled: false, eqBand0Type: 'bell' })).toBeNull();
    });

    it('is a log frequency axis, ±18 dB, with a 0 dB reference line', () => {
        const g = eqGraph(eq())!;
        expect(g.axes.x).toMatchObject({ min: 20, max: 20000, scale: 'log', unit: 'Hz' });
        expect(g.axes.y).toMatchObject({ min: -18, max: 18, gridStep: 6, unit: 'dB' });
        expect(g.series.map((s) => s.id)).toEqual(['zero', 'response']);
        expect(g.notes).toEqual(['All bands off — flat']);
        expect(g.markers).toEqual([]);
    });

    it('counts the active bands and marks the HPF corner', () => {
        const g = eqGraph(
            eq({
                eqBand0Type: 'bell',
                eqBand2Type: 'notch',
                hpfEnabled: true,
                hpfFreq: 120,
            }),
        )!;
        expect(g.notes).toContain('2 of 6 bands on');
        expect(g.markers).toEqual([
            { axis: 'x', value: 120, label: 'HPF 120 Hz', role: 'warning', stroke: 'dashed' },
        ]);
    });

    it('greys the curve and says so when bypassed', () => {
        const g = eqGraph(eq({ eqBypass: true, eqBand0Type: 'bell' }))!;
        expect(g.notes).toEqual(['EQ bypassed']);
        expect(g.series.find((s) => s.id === 'response')!.role).toBe('muted');
    });
});
