import { describe, it, expect } from 'vitest';
import { TrendHistory, bandPath, linePath, trendValue, yRange } from './trendHistory';
import { asNumber } from '../../valueTypes';

describe('trend history (browser memory only)', () => {
    it("every update lands in its second's low/high; the window keeps one point before it", () => {
        const h = new TrendHistory(3000);
        h.sample('/a', 10_100, 14);
        h.sample('/a', 10_300, 0);
        h.sample('/a', 10_900, 14);
        h.sample('/a', 11_000, 3);
        h.sample('/a', 14_200, null);
        expect(h.points('/a')).toEqual([[11_000, 3, 3], [14_000, null]]);
        const g = new TrendHistory(60_000);
        g.sample('/l', 1_000, 14);
        g.sample('/l', 1_400, 0);
        expect(g.points('/l')).toEqual([[1_000, 0, 14]]);
        expect(g.values(['/l'])).toEqual([0, 14]);
        g.retain([]);
        expect(g.points('/l')).toEqual([]);
    });

    it('scales to the data, padded, unless an end is fixed; a flat line still gets room', () => {
        expect(yRange([0, 100])).toEqual([-5, 105]);
        expect(yRange([10, 20], 0, 100)).toEqual([0, 100]);
        expect(yRange([10, 20], 0)).toEqual([0, 20]);
        expect(yRange([50, 50])).toEqual([45, 55]);
        expect(yRange([])).toEqual([-0.05, 1.05]);
    });

    it('draws a gap as a new stroke; a band only where a second moved', () => {
        const pts = [[0, 0, 0], [1000, 10, 10], [2000, null], [3000, 0, 10]] as const;
        expect(linePath(pts as any, 0, 4000, 0, 10)).toBe('M0.0 1000.0L250.0 0.0M750.0 0.0');
        expect(bandPath(pts as any, 0, 4000, 0, 10)).toBe('M750.0 0.0L750.0 1000.0Z');
    });
});

describe('trend values', () => {
    it('plots numbers and number text; levels as their loudest channel', () => {
        expect([2, '2.5', '—', [3, 11, 7], [], ['4', 9]].map((v) => trendValue(v, asNumber))).toEqual([2, 2.5, undefined, 11, undefined, 9]);
    });
});
