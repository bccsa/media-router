import { describe, it, expect } from 'vitest';
import {
    dynamicsCurvePoints,
    limitedDb,
    readDynamicsParams,
    transferDb,
    type DynamicsParams,
} from './dynamicsCurve.js';

const params = (config: Record<string, unknown>): DynamicsParams => readDynamicsParams(config);

describe('readDynamicsParams', () => {
    it('falls back to the schema defaults for absent / junk values', () => {
        const p = params({ mode: 'bogus', ratio: 'x' });
        expect(p.mode).toBe('none');
        expect(p.ratio).toBe(8);
        expect(p.threshold).toBe(-35);
        expect(p.knee).toBe(-6);
        expect(p.gateDepth).toBe(-48);
    });

    it('reads the live config over the defaults', () => {
        const p = params({ mode: 'gate', threshold: -20, gateDepth: -30 });
        expect(p.mode).toBe('gate');
        expect(p.threshold).toBe(-20);
        expect(p.gateDepth).toBe(-30);
    });
});

describe('transferDb — compressor', () => {
    it('4:1 above a -20 dB threshold maps 0 dB in to -15 dB out', () => {
        const p = params({ mode: 'compressor', threshold: -20, ratio: 4, knee: 0, makeupGain: 0 });
        expect(transferDb(0, p)).toBeCloseTo(-15, 6);
    });

    it('makeup gain shifts the whole curve up', () => {
        const p = params({ mode: 'compressor', threshold: -20, ratio: 4, knee: 0, makeupGain: 6 });
        expect(transferDb(0, p)).toBeCloseTo(-9, 6);
        expect(transferDb(-40, p)).toBeCloseTo(-34, 6);
    });

    it('is unity below the threshold with a hard knee', () => {
        const p = params({ mode: 'compressor', threshold: -20, ratio: 4, knee: 0 });
        expect(transferDb(-40, p)).toBeCloseTo(-40, 6);
        expect(transferDb(-20, p)).toBeCloseTo(-20, 6);
    });

    it('a soft knee is continuous at both edges and rounded in between', () => {
        // 8 dB total width, centred on the threshold: -24 … -16.
        const p = params({ mode: 'compressor', threshold: -20, ratio: 4, knee: -8 });
        const hard = params({ mode: 'compressor', threshold: -20, ratio: 4, knee: 0 });
        expect(transferDb(-24, p)).toBeCloseTo(-24, 6);
        expect(transferDb(-16, p)).toBeCloseTo(transferDb(-16, hard), 6);
        // Knee midpoint (the threshold) sits between unity and the hard knee.
        const mid = transferDb(-20, p);
        expect(mid).toBeLessThan(-20);
        expect(mid).toBeGreaterThan(-20 - 4 * (1 - 1 / 4));
        // No step across either edge.
        expect(transferDb(-24.001, p)).toBeCloseTo(transferDb(-23.999, p), 2);
        expect(transferDb(-16.001, p)).toBeCloseTo(transferDb(-15.999, p), 2);
    });
});

describe('transferDb — gate', () => {
    it('is unity above the threshold and drops by the depth below it', () => {
        const p = params({ mode: 'gate', threshold: -35, gateDepth: -48 });
        expect(transferDb(-20, p)).toBeCloseTo(-20, 6);
        expect(transferDb(-35, p)).toBeCloseTo(-35, 6);
        expect(transferDb(-40, p)).toBeCloseTo(-88, 6);
    });

    it('makeup gain lifts both sides of the step', () => {
        const p = params({ mode: 'gate', threshold: -35, gateDepth: -20, makeupGain: 3 });
        expect(transferDb(-30, p)).toBeCloseTo(-27, 6);
        expect(transferDb(-40, p)).toBeCloseTo(-57, 6);
    });
});

describe('transferDb — expander', () => {
    it('is unity above the threshold and expands downward below it', () => {
        const p = params({ mode: 'expander', threshold: -30, ratio: 2, knee: 0 });
        expect(transferDb(-10, p)).toBeCloseTo(-10, 6);
        expect(transferDb(-40, p)).toBeCloseTo(-50, 6);
    });

    it('the soft knee meets both asymptotes', () => {
        const p = params({ mode: 'expander', threshold: -30, ratio: 2, knee: -6 });
        expect(transferDb(-27, p)).toBeCloseTo(-27, 6);
        expect(transferDb(-33, p)).toBeCloseTo(-36, 6);
    });
});

describe('transferDb — ducker', () => {
    it('maps key level to program gain: unity below, the exact floor above', () => {
        const p = params({ mode: 'ducker', threshold: -35, duckDepth: -12 });
        expect(transferDb(-50, p)).toBe(0);
        expect(transferDb(-35, p)).toBe(0);
        expect(transferDb(-10, p)).toBe(-12);
    });
});

describe('limitedDb', () => {
    it('clamps to the ceiling only when the limiter is on', () => {
        const off = params({ mode: 'compressor', limiterEnabled: false });
        const on = params({ mode: 'compressor', limiterEnabled: true, limiterThreshold: -6 });
        expect(limitedDb(-2, off)).toBe(-2);
        expect(limitedDb(-2, on)).toBe(-6);
        expect(limitedDb(-30, on)).toBe(-30);
    });
});

describe('dynamicsCurvePoints', () => {
    it('spans -60…0 dB and crosses the gate step in a near-zero x gap', () => {
        const p = params({ mode: 'gate', threshold: -35, gateDepth: -48 });
        const points = dynamicsCurvePoints(p);
        expect(points[0][0]).toBe(-60);
        expect(points[points.length - 1][0]).toBe(0);
        for (let i = 1; i < points.length; i++) {
            expect(points[i][0]).toBeGreaterThanOrEqual(points[i - 1][0]);
        }
        let jumpAt = 0;
        let maxJump = 0;
        for (let i = 1; i < points.length; i++) {
            const jump = Math.abs(points[i][1] - points[i - 1][1]);
            if (jump > maxJump) {
                maxJump = jump;
                jumpAt = i;
            }
        }
        expect(maxJump).toBeCloseTo(48, 1);
        expect(points[jumpAt][0] - points[jumpAt - 1][0]).toBeLessThan(0.01);
    });

    it('applies the projection (used for the limiter overlay)', () => {
        const p = params({
            mode: 'compressor',
            threshold: -20,
            ratio: 4,
            makeupGain: 12,
            limiterEnabled: true,
            limiterThreshold: -3,
        });
        for (const [, y] of dynamicsCurvePoints(p, (db) => limitedDb(db, p))) {
            expect(y).toBeLessThanOrEqual(-3);
        }
    });

    it('a mode of none is the unity line', () => {
        for (const [x, y] of dynamicsCurvePoints(params({ mode: 'none' }), undefined, 20)) {
            expect(y).toBeCloseTo(x, 6);
        }
    });
});
