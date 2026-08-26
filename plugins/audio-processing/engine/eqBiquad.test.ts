/**
 * Known-point tests for the RBJ cookbook maths itself — bell gain at centre,
 * shelf asymptotes, the notch null, the -3 dB corners and the two roll-off
 * slopes. These moved here from `eqGraph.test.ts`, which now covers only the
 * summing and the published `StatusGraph`.
 *
 * Everything is a magnitude in dB at one frequency, so a wrong coefficient
 * shows up as a number, not as a curve that merely "looks off".
 */
import { describe, it, expect } from 'vitest';
import { bandMagnitudeDb, hpfMagnitudeDb, EQ_SAMPLE_RATE } from './eqBiquad.js';
import { EQ_FILTER_TYPES } from './eqBands.js';

describe('bandMagnitudeDb', () => {
    it('a bell shows its gain at the centre frequency and decays away from it', () => {
        const band = { type: 'bell', freq: 1000, gain: 6, q: 1 };
        expect(bandMagnitudeDb(band, 1000)).toBeCloseTo(6, 1);
        expect(bandMagnitudeDb({ ...band, gain: -9 }, 1000)).toBeCloseTo(-9, 1);
        expect(bandMagnitudeDb(band, 40)).toBeCloseTo(0, 1);
        expect(bandMagnitudeDb(band, 18000)).toBeCloseTo(0, 1);
    });

    it('a higher Q keeps the peak but tightens the skirt', () => {
        const wide = { type: 'bell', freq: 1000, gain: 12, q: 0.5 };
        const narrow = { ...wide, q: 8 };
        expect(bandMagnitudeDb(narrow, 1000)).toBeCloseTo(12, 1);
        expect(bandMagnitudeDb(narrow, 500)).toBeLessThan(bandMagnitudeDb(wide, 500));
    });

    it('a bell is -3 dB down from its peak at the Q bandwidth edges', () => {
        // Q = 1 ⇒ bandwidth = f0/Q, edges at f0·(√5±1)/2 for the RBJ form.
        const band = { type: 'bell', freq: 1000, gain: 12, q: 1 };
        const upper = 1000 * ((Math.sqrt(5) + 1) / 2);
        const lower = 1000 * ((Math.sqrt(5) - 1) / 2);
        expect(bandMagnitudeDb(band, upper)).toBeCloseTo(6, 0);
        expect(bandMagnitudeDb(band, lower)).toBeCloseTo(6, 0);
    });

    it('resonance is drawn as a bell — same magnitude, different label', () => {
        const freq = 1000;
        const bell = { type: 'bell', freq, gain: 6, q: 2 };
        expect(bandMagnitudeDb({ ...bell, type: 'resonance' }, freq)).toBeCloseTo(
            bandMagnitudeDb(bell, freq),
            6,
        );
    });

    it('shelves reach their gain in the shelved band and unity in the other', () => {
        const lo = { type: 'loshelf', freq: 200, gain: 8, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(lo, 25)).toBeCloseTo(8, 0);
        expect(bandMagnitudeDb(lo, 10000)).toBeCloseTo(0, 1);

        const hi = { type: 'hishelf', freq: 4000, gain: -8, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(hi, 20000)).toBeCloseTo(-8, 0);
        expect(bandMagnitudeDb(hi, 50)).toBeCloseTo(0, 1);
    });

    it('a shelf sits at half its gain on the corner', () => {
        const lo = { type: 'loshelf', freq: 500, gain: 10, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(lo, 500)).toBeCloseTo(5, 0);

        const hi = { type: 'hishelf', freq: 500, gain: 10, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(hi, 500)).toBeCloseTo(5, 0);
    });

    it('a notch is a deep null at centre and flat either side', () => {
        const notch = { type: 'notch', freq: 1000, gain: 0, q: 4 };
        expect(bandMagnitudeDb(notch, 1000)).toBeLessThan(-40);
        expect(bandMagnitudeDb(notch, 200)).toBeCloseTo(0, 1);
        expect(bandMagnitudeDb(notch, 8000)).toBeCloseTo(0, 1);
    });

    it('the notch null is floored at -120 dB rather than -Infinity', () => {
        // A true zero: the polyline has to stay finite or the plot breaks.
        const db = bandMagnitudeDb({ type: 'notch', freq: 1000, gain: 0, q: 100 }, 1000);
        expect(Number.isFinite(db)).toBe(true);
        expect(db).toBeGreaterThanOrEqual(-120);
    });

    it('hi-pass / lo-pass are -3 dB at the corner and roll off 12 dB/octave', () => {
        const hp = { type: 'hipass', freq: 1000, gain: 0, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(hp, 1000)).toBeCloseTo(-3, 0);
        expect(bandMagnitudeDb(hp, 500) - bandMagnitudeDb(hp, 250)).toBeCloseTo(12, 0);
        expect(bandMagnitudeDb(hp, 10000)).toBeCloseTo(0, 1);

        const lp = { type: 'lopass', freq: 1000, gain: 0, q: Math.SQRT1_2 };
        expect(bandMagnitudeDb(lp, 1000)).toBeCloseTo(-3, 0);
        expect(bandMagnitudeDb(lp, 200)).toBeCloseTo(0, 1);
        // Measured well below Nyquist: the bilinear warp steepens the digital
        // slope as it approaches 24 kHz (4 k → 8 k already reads 13.3 dB).
        expect(bandMagnitudeDb(lp, 2000) - bandMagnitudeDb(lp, 4000)).toBeCloseTo(12, 0);
    });

    it('a pass filter ignores the gain knob — only the parametric types use it', () => {
        const at = (gain: number) =>
            bandMagnitudeDb({ type: 'hipass', freq: 200, gain, q: 1 }, 100);
        expect(at(12)).toBeCloseTo(at(0), 6);
    });

    it('Q = 0 is a legal LSP value and must not divide by zero', () => {
        const db = bandMagnitudeDb({ type: 'bell', freq: 1000, gain: 6, q: 0 }, 1000);
        expect(Number.isFinite(db)).toBe(true);
    });

    it('every schema band type evaluates finite; off / allpass are transparent', () => {
        for (const type of Object.keys(EQ_FILTER_TYPES)) {
            const db = bandMagnitudeDb({ type, freq: 1000, gain: 6, q: 1 }, 1000);
            expect(Number.isFinite(db), `${type} is finite`).toBe(true);
            if (type === 'off' || type === 'allpass') expect(db).toBe(0);
        }
    });

    it('an unknown type is transparent rather than an error', () => {
        expect(bandMagnitudeDb({ type: 'no-such-filter', freq: 1000, gain: 6, q: 1 }, 1000)).toBe(
            0,
        );
    });

    it('the chain rate is the 302M 48 kHz, and it is the default', () => {
        expect(EQ_SAMPLE_RATE).toBe(48000);
        const band = { type: 'bell', freq: 1000, gain: 6, q: 1 };
        expect(bandMagnitudeDb(band, 1000)).toBeCloseTo(bandMagnitudeDb(band, 1000, 48000), 12);
    });
});

describe('hpfMagnitudeDb', () => {
    it('is 4-pole: -6 dB at the corner, 24 dB/octave below it', () => {
        expect(hpfMagnitudeDb(100, 100)).toBeCloseTo(-6, 0);
        expect(hpfMagnitudeDb(100, 50) - hpfMagnitudeDb(100, 25)).toBeCloseTo(24, 0);
        expect(hpfMagnitudeDb(100, 5000)).toBeCloseTo(0, 1);
    });

    it('is exactly two cascaded Butterworth hi-pass sections', () => {
        const section = { type: 'hipass', freq: 80, gain: 0, q: Math.SQRT1_2 };
        for (const f of [20, 80, 200, 1000]) {
            expect(hpfMagnitudeDb(80, f)).toBeCloseTo(2 * bandMagnitudeDb(section, f), 9);
        }
    });

    it('moving the cutoff moves the corner with it', () => {
        expect(hpfMagnitudeDb(500, 500)).toBeCloseTo(-6, 0);
        // 80 Hz content is far cheaper through an 80 Hz HPF than a 500 Hz one.
        expect(hpfMagnitudeDb(80, 80)).toBeGreaterThan(hpfMagnitudeDb(500, 80));
    });
});
