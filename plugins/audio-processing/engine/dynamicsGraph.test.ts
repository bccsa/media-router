import { describe, it, expect } from 'vitest';
import { dynamicsGraph } from './dynamicsGraph.js';

const seriesIds = (graph: NonNullable<ReturnType<typeof dynamicsGraph>>): string[] =>
    graph.series.map((s) => s.id);

describe('dynamicsGraph', () => {
    it('publishes nothing when the stage is off', () => {
        expect(dynamicsGraph({ mode: 'none' })).toBeNull();
        expect(dynamicsGraph({})).toBeNull();
    });

    it('publishes nothing for the ducker — the envelope is its only graph', () => {
        // Null is also what CLEARS a curve the previous mode left behind.
        expect(dynamicsGraph({ mode: 'ducker', duckDepth: -9, hold: 400 })).toBeNull();
        expect(dynamicsGraph({ mode: 'ducker' }, { inDb: -10, grDb: -2 })).toBeNull();
        expect(dynamicsGraph({ mode: 'ducker', limiterEnabled: true })).toBeNull();
    });

    it('labels a compressor in → out on -60…0 dB axes with a threshold marker', () => {
        const g = dynamicsGraph({ mode: 'compressor', threshold: -20, ratio: 4 })!;
        expect(g.axes.x).toMatchObject({ label: 'Input', unit: 'dB', min: -60, max: 0 });
        expect(g.axes.y).toMatchObject({ label: 'Output', unit: 'dB', min: -60, max: 0 });
        expect(g.axes.x.gridStep).toBe(10);
        expect(seriesIds(g)).toEqual(['unity', 'transfer']);
        expect(g.markers).toEqual([
            { axis: 'x', value: -20, label: 'Thr -20 dB', role: 'warning', stroke: 'dashed' },
        ]);
        expect(g.notes).toContain('4:1');
        expect(g.notes).toContain('Attack 5 ms');
    });

    it('overlays the limiter ceiling on top of the active curve', () => {
        const plain = dynamicsGraph({ mode: 'compressor', threshold: -20 })!;
        expect(seriesIds(plain)).not.toContain('limited');

        const g = dynamicsGraph({
            mode: 'compressor',
            threshold: -20,
            ratio: 4,
            makeupGain: 12,
            limiterEnabled: true,
            limiterThreshold: -3,
        })!;
        expect(seriesIds(g)).toContain('limited');
        const limited = g.series.find((s) => s.id === 'limited')!;
        expect(limited.stroke).toBe('dashed');
        for (const [, y] of limited.points) expect(y).toBeLessThanOrEqual(-3);
        expect(g.markers).toContainEqual({
            axis: 'y',
            value: -3,
            label: 'Ceiling -3 dB',
            role: 'error',
            stroke: 'dotted',
        });
    });

    it('places the live dot on the curve and spans the gain reduction', () => {
        const config = { mode: 'compressor', threshold: -20, ratio: 4, knee: 0 };
        const g = dynamicsGraph(config, { inDb: -8, grDb: -3 })!;
        expect(g.live).toEqual({ x: -8, y: -17, role: 'primary', span: [-17, -14] });
    });

    it('omits the live dot without a reading', () => {
        const config = { mode: 'compressor', threshold: -20 };
        expect(dynamicsGraph(config, { inDb: null, grDb: null })!.live).toBeUndefined();
        expect(dynamicsGraph(config)!.live).toBeUndefined();
    });

    it('omits the span when nothing is being reduced', () => {
        const g = dynamicsGraph({ mode: 'gate', threshold: -35 }, { inDb: -10, grDb: 0 })!;
        expect(g.live?.span).toBeUndefined();
        expect(g.live?.x).toBe(-10);
    });
});
