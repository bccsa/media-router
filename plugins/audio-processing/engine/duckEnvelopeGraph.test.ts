import { describe, it, expect } from 'vitest';
import { duckEnvelopeGraph, envelopePhases } from './duckEnvelopeGraph.js';
import { readDynamicsParams } from './dynamicsCurve.js';
import type { DuckLive } from './duckLive.js';

const phases = (config: Record<string, unknown>) => envelopePhases(readDynamicsParams(config));
const widths = (config: Record<string, unknown>) =>
    phases(config).map((p) => Number((p.to - p.from).toFixed(3)));

type Graph = NonNullable<ReturnType<typeof duckEnvelopeGraph>>;

/** Marker labels, in the order they were published. */
const labels = (graph: Graph): string[] => (graph.markers ?? []).map((m) => m.label ?? '');
const series = (graph: Graph, id: string) => graph.series.find((s) => s.id === id)!;
const reading = (over: Partial<DuckLive> = {}): DuckLive => ({
    gainDb: -6,
    keyDb: -8,
    phase: 'attack',
    ...over,
});

describe('envelopePhases', () => {
    it('lays attack → hold → release between the two idle pads', () => {
        const p = phases({ mode: 'ducker' });
        expect(p.map((s) => s.id)).toEqual(['attack', 'hold', 'release']);
        // 8% of the width is idle at each end.
        expect(p[0].from).toBe(0.08);
        expect(p[2].to).toBe(0.92);
        // Contiguous: no gaps, no overlaps.
        expect(p[1].from).toBe(p[0].to);
        expect(p[2].from).toBe(p[1].to);
    });

    it('floors every phase at 12% of the width, however short it really is', () => {
        // Defaults: attack 5 ms against hold 250 / release 200 — 1% of the
        // real timeline, and invisible if the axis were linear in time.
        expect(widths({ mode: 'ducker' })).toEqual([0.153, 0.356, 0.331]);
        // Extremes: a 1 ms attack and a zero hold still get their floor.
        expect(widths({ mode: 'ducker', attack: 1, hold: 0, release: 2000 })).toEqual([
            0.13, 0.12, 0.59,
        ]);
        expect(widths({ mode: 'ducker', attack: 500, hold: 2000, release: 5 })).toEqual([
            0.275, 0.43, 0.135,
        ]);
    });

    it('compresses the spare width by sqrt(duration), keeping the order honest', () => {
        // Equal times ⇒ equal widths; the spare 48% divides three ways.
        expect(widths({ mode: 'ducker', attack: 100, hold: 100, release: 100 })).toEqual([
            0.28, 0.28, 0.28,
        ]);
        // 4× the hold buys 2× the share of the spare, not 4× — but it is still
        // unmistakably the widest of the three.
        const [attack, hold, release] = widths({
            mode: 'ducker',
            attack: 100,
            hold: 400,
            release: 100,
        });
        expect(hold).toBeGreaterThan(attack);
        expect(hold).toBeLessThan(4 * (attack - 0.12) + 0.12);
        expect(release).toBe(attack);
        // A 40× longer release still reads as longer, without erasing attack.
        const long = widths({ mode: 'ducker', attack: 50, hold: 250, release: 2000 });
        expect(long[2]).toBeGreaterThan(long[0]);
        expect(long[0]).toBeGreaterThan(0.12);
    });

    it('carries each phase its real value for the label', () => {
        const p = phases({ mode: 'ducker', attack: 5, hold: 250, release: 200 });
        expect(p.map((s) => s.label)).toEqual(['Attack 5 ms', 'Hold 250 ms', 'Release 200 ms']);
        expect(p.map((s) => s.ms)).toEqual([5, 250, 200]);
    });
});

describe('duckEnvelopeGraph', () => {
    it('publishes nothing outside ducker mode', () => {
        expect(duckEnvelopeGraph({ mode: 'compressor' })).toBeNull();
        expect(duckEnvelopeGraph({ mode: 'none' })).toBeNull();
        expect(duckEnvelopeGraph({})).toBeNull();
    });

    it('draws idle → attack → hold → release → idle against the duck floor', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker', duckDepth: -12 })!;
        const [attack, hold, release] = phases({ mode: 'ducker', duckDepth: -12 });
        expect(series(g, 'envelope').points).toEqual([
            [0, 0],
            [attack.from, 0],
            [attack.to, -12],
            [hold.to, -12],
            [release.to, 0],
            [1, 0],
        ]);
    });

    it('runs the gain axis down from 0 dB, with headroom under the floor', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker', duckDepth: -12 })!;
        expect(g.axes.y).toEqual({
            label: 'Program gain',
            unit: 'dB',
            min: -15, // 25% below the floor, for the key rail
            max: 0,
            gridStep: 3, // ⇒ gridlines at -15 -12 -9 -6 -3 0
            labels: [-12, -6, 0],
        });
        // The floor is called out on the plateau, where an operator reads it.
        expect(g.markers).toContainEqual({
            axis: 'y',
            value: -12,
            label: 'Duck -12 dB',
            role: 'muted',
            stroke: 'dashed',
        });
    });

    it('keeps the axis usable when nothing is ducked (0 dB floor)', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker', duckDepth: 0 })!;
        expect(g.axes.y.min).toBe(-1.25); // not a zero-height plot
        expect(g.axes.y.max).toBe(0);
        expect(g.axes.y.labels).toEqual([0]); // one tick, not three zeroes
        for (const [, y] of series(g, 'envelope').points) expect(y).toBe(0);
    });

    it('prints no time ticks — the axis is ordered, not measured', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker' })!;
        expect(g.axes.x).toEqual({ label: 'Time →', min: 0, max: 1, gridStep: 1, labels: [] });
        expect(g.axes.x.unit).toBeUndefined();
        expect(g.notes).toContain('Phases not to scale');
    });

    it('says the times are full travel, not a time constant', () => {
        expect(duckEnvelopeGraph({ mode: 'ducker' })!.notes).toContain(
            'Attack / release = full travel',
        );
    });

    it('labels each segment with its real time at the phase boundary', () => {
        const config = { mode: 'ducker', attack: 12, hold: 400, release: 800 };
        const g = duckEnvelopeGraph(config)!;
        const [attack, hold, release] = phases(config);
        expect(g.markers?.slice(0, 3)).toEqual([
            {
                axis: 'x',
                value: attack.from,
                label: 'Attack 12 ms',
                role: 'secondary',
                stroke: 'dashed',
            },
            {
                axis: 'x',
                value: hold.from,
                label: 'Hold 400 ms',
                role: 'secondary',
                stroke: 'dashed',
            },
            {
                axis: 'x',
                value: release.from,
                label: 'Release 800 ms',
                role: 'secondary',
                stroke: 'dashed',
            },
        ]);
    });

    it('shows the key trigger window, since hold is measured from the drop', () => {
        const config = { mode: 'ducker', duckDepth: -12 };
        const g = duckEnvelopeGraph(config)!;
        const [attack, hold] = phases(config);
        const key = series(g, 'key');
        // A rail in the headroom under the floor: over threshold from the
        // trigger to the drop that starts the hold — not a fake waveform.
        expect(key.points).toEqual([
            [attack.from, -13.5],
            [hold.from, -13.5],
        ]);
        expect(key.role).toBe('warning');
        expect(g.notes).toContain('Key over threshold');
    });

    it('leaves the key threshold to the transfer curve — no axis for it here', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker', threshold: -28 })!;
        expect(labels(g).join(' ')).not.toContain('Thr');
        expect((g.notes ?? []).join(' ')).not.toContain('-28');
    });

    it('lays the live gain across the plot as a horizontal rule', () => {
        const g = duckEnvelopeGraph({ mode: 'ducker', duckDepth: -12 }, reading({ gainDb: -6.4 }))!;
        expect(g.markers).toContainEqual({
            axis: 'y',
            value: -6.4,
            label: '-6.4 dB',
            role: 'primary',
            stroke: 'solid',
        });
    });

    it('puts the dot on the leg the phase names, at the gain being applied', () => {
        const config = { mode: 'ducker', duckDepth: -12 };
        const [attack, hold, release] = phases(config);

        // Half way down the attack ramp — the gain fixes x, so the dot rides
        // the drawn line rather than being interpolated in time.
        const rising = duckEnvelopeGraph(config, reading({ gainDb: -6, phase: 'attack' }))!;
        expect(rising.live?.y).toBe(-6);
        expect(rising.live?.x).toBeCloseTo((attack.from + attack.to) / 2, 2); // x is published rounded to 3 dp

        // On the plateau it sits mid segment, at whatever gain is applied.
        const held = duckEnvelopeGraph(config, reading({ gainDb: -12, phase: 'hold' }))!;
        expect(held.live).toEqual({ x: (hold.from + hold.to) / 2, y: -12, role: 'primary' });

        // Half way back up the release, measured from its far end.
        const releasing = duckEnvelopeGraph(config, reading({ gainDb: -6, phase: 'release' }))!;
        expect(releasing.live?.x).toBeCloseTo((release.from + release.to) / 2, 2); // x is published rounded to 3 dp
    });

    it('draws no dot when the phase cannot place one honestly', () => {
        const config = { mode: 'ducker', duckDepth: -12 };
        expect(duckEnvelopeGraph(config, reading({ phase: 'idle' }))!.live).toBeUndefined();
        expect(duckEnvelopeGraph(config, null)!.live).toBeUndefined();
        expect(duckEnvelopeGraph(config)!.live).toBeUndefined();
    });

    it('draws no live rule when the ducker is idle or has no telemetry', () => {
        const idle = duckEnvelopeGraph({ mode: 'ducker' }, reading({ gainDb: 0, phase: 'idle' }))!;
        expect(labels(idle)).toHaveLength(4); // three phases + the duck floor
        expect(labels(duckEnvelopeGraph({ mode: 'ducker' }, null)!)).toHaveLength(4);
        expect(labels(duckEnvelopeGraph({ mode: 'ducker' })!)).toHaveLength(4);
    });
});
