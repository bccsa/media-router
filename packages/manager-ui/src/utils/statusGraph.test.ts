import { describe, it, expect } from 'vitest';
import { isStatusGraph } from './statusGraph';

const graph = {
    axes: { x: { min: -60, max: 0 }, y: { min: -60, max: 0 } },
    series: [{ id: 'transfer', points: [[-60, -60] as [number, number]] }],
};

describe('isStatusGraph', () => {
    it('accepts published graph data', () => {
        expect(isStatusGraph(graph)).toBe(true);
    });

    it('rejects the primitive status values a popup field would hold', () => {
        expect(isStatusGraph('-12.3 / -12.1 dB')).toBe(false);
        expect(isStatusGraph(42)).toBe(false);
        expect(isStatusGraph(true)).toBe(false);
        expect(isStatusGraph(undefined)).toBe(false);
    });

    it('rejects a malformed graph rather than letting the plotter throw', () => {
        expect(isStatusGraph({ ...graph, series: undefined } as never)).toBe(false);
        expect(isStatusGraph({ ...graph, axes: { x: { min: 0 } } } as never)).toBe(false);
        expect(isStatusGraph({ series: [] } as never)).toBe(false);
    });
});
