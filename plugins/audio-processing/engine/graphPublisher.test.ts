import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusGraph } from '@media-router/engine';
import {
    GraphPublisher,
    DUCK_ENVELOPE_GRAPH,
    DYNAMICS_GRAPH,
    EQ_GRAPH,
    GRAPH_SECTION,
} from './graphPublisher.js';

function collect() {
    const published: Array<{ key: string; graph: StatusGraph | null }> = [];
    const publisher = new GraphPublisher((key, graph) => published.push({ key, graph }));
    const last = (key: string): StatusGraph | null =>
        published.filter((p) => p.key === key).at(-1)?.graph ?? null;
    return { published, publisher, last };
}

describe('GraphPublisher', () => {
    it('publishes every key on every update, null when a stage is off', () => {
        const { published, publisher } = collect();
        publisher.update({ mode: 'none' });
        expect(published.map((p) => p.key)).toEqual([
            DYNAMICS_GRAPH,
            DUCK_ENVELOPE_GRAPH,
            EQ_GRAPH,
        ]);
        expect(published.every((p) => p.graph === null)).toBe(true);
    });

    it('publishes the curves once their stages are enabled', () => {
        const { publisher, last } = collect();
        publisher.update({ mode: 'compressor', eqEnabled: true });
        expect(last(DYNAMICS_GRAPH)?.series.length).toBeGreaterThan(0);
        expect(last(EQ_GRAPH)?.axes.x.scale).toBe('log');
        // The envelope belongs to the ducker alone.
        expect(last(DUCK_ENVELOPE_GRAPH)).toBeNull();
    });

    it('gives the ducker exactly one graph — the envelope, no transfer curve', () => {
        const { publisher, last } = collect();
        publisher.update({ mode: 'ducker', duckDepth: -12 });
        expect(last(DUCK_ENVELOPE_GRAPH)?.axes.x.label).toBe('Time →');
        expect(last(DYNAMICS_GRAPH)).toBeNull();
        expect(last(EQ_GRAPH)).toBeNull();
    });

    it('clears the other mode’s graph on a mode switch, both ways', () => {
        const { publisher, last } = collect();
        // A curve is showing…
        publisher.update({ mode: 'compressor', threshold: -20 });
        expect(last(DYNAMICS_GRAPH)).not.toBeNull();
        expect(last(DUCK_ENVELOPE_GRAPH)).toBeNull();

        // …switch to ducker and the curve is explicitly cleared (null deletes
        // the status key), not left behind next to the envelope.
        publisher.update({ mode: 'ducker', duckDepth: -12 });
        expect(last(DYNAMICS_GRAPH)).toBeNull();
        expect(last(DUCK_ENVELOPE_GRAPH)).not.toBeNull();

        // …and back again.
        publisher.update({ mode: 'gate', threshold: -40 });
        expect(last(DYNAMICS_GRAPH)).not.toBeNull();
        expect(last(DUCK_ENVELOPE_GRAPH)).toBeNull();
    });

    it('puts the ducker envelope reading on the envelope alone', () => {
        const { publisher, last } = collect();
        const config = { mode: 'ducker', duckDepth: -12, threshold: -35 };
        publisher.setDuckLive({ gainDb: -7.5, keyDb: -6, phase: 'attack' });
        publisher.update(config);
        // A dot on the attack ramp, plus the gain rule that carries the number.
        expect(last(DUCK_ENVELOPE_GRAPH)?.live?.y).toBe(-7.5);
        expect(last(DUCK_ENVELOPE_GRAPH)?.markers).toContainEqual(
            expect.objectContaining({ axis: 'y', value: -7.5 }),
        );

        // A slider move republishes without a new reading — the dot stays put.
        publisher.update({ ...config, hold: 500 });
        expect(last(DUCK_ENVELOPE_GRAPH)?.live?.y).toBe(-7.5);
    });

    it('drops the ducker overlay once the envelope settles or the chain stops', () => {
        const { publisher, last } = collect();
        const config = { mode: 'ducker', duckDepth: -12 };
        publisher.setDuckLive({ gainDb: -7.5, keyDb: -6, phase: 'hold' });
        publisher.update(config);
        publisher.setDuckLive(null);
        publisher.update(config);
        expect(last(DUCK_ENVELOPE_GRAPH)?.live).toBeUndefined();
        // Phases + the duck floor remain; the live rule is gone.
        expect(last(DUCK_ENVELOPE_GRAPH)?.markers).toHaveLength(4);

        publisher.setDuckLive({ gainDb: -7.5, keyDb: -6, phase: 'hold' });
        publisher.clearLive();
        publisher.update(config);
        expect(last(DUCK_ENVELOPE_GRAPH)?.live).toBeUndefined();
    });

    it('remembers the last meter reading across config-driven republishes', () => {
        const { publisher, last } = collect();
        const config = { mode: 'compressor', threshold: -20, ratio: 4, knee: 0 };
        publisher.update(config, { inDb: -8, grDb: -3 });
        expect(last(DYNAMICS_GRAPH)?.live?.x).toBe(-8);
        // A slider move republishes without a new reading — the dot stays put
        // instead of blinking off between meter ticks.
        publisher.update({ ...config, threshold: -30 });
        expect(last(DYNAMICS_GRAPH)?.live?.x).toBe(-8);
    });

    it('drops the dot once the chain stops metering', () => {
        const { publisher, last } = collect();
        const config = { mode: 'compressor' };
        publisher.update(config, { inDb: -8, grDb: -3 });
        publisher.clearLive();
        publisher.update(config);
        expect(last(DYNAMICS_GRAPH)?.live).toBeUndefined();
    });
});

describe('the manifest points its graph widgets at what we publish', () => {
    // A renamed key on either side would render a permanently empty widget —
    // no error anywhere, just a blank box. Fail here instead.
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
        mediaRouter: {
            configSchema: {
                properties: Record<
                    string,
                    {
                        default?: unknown;
                        'x-widget'?: string;
                        'x-graph'?: { section: string; key: string };
                        'x-showWhen'?: string;
                    }
                >;
            };
            statusSections: Array<{ id: string }>;
        };
    };
    const props = manifest.mediaRouter.configSchema.properties;
    const graphProps = Object.entries(props).filter(([, p]) => p['x-widget'] === 'graph');

    it('declares one graph prop per published key, and no default on them', () => {
        expect(graphProps.map(([, p]) => p['x-graph']?.key).sort()).toEqual(
            [DYNAMICS_GRAPH, DUCK_ENVELOPE_GRAPH, EQ_GRAPH].sort(),
        );
        for (const [key, prop] of graphProps) {
            expect(prop['x-graph']?.section, `${key} section`).toBe(GRAPH_SECTION);
            // A virtual widget must never seed a value into saved settings.
            expect(prop.default, `${key} default`).toBeUndefined();
        }
    });

    it('shows exactly one dynamics graph per mode, and it is the one we publish', () => {
        const showWhen = (key: string) =>
            graphProps.find(([, p]) => p['x-graph']?.key === key)![1]['x-showWhen'];
        expect(showWhen(DUCK_ENVELOPE_GRAPH)).toBe('mode=ducker');
        // No negation in the x-showWhen syntax (`key=v1,v2` is any-of, see
        // manager-ui's showWhen.ts) — the ducker is excluded by omission.
        expect(showWhen(DYNAMICS_GRAPH)).toBe('mode=compressor,gate,expander');

        // The widget the UI would show, against the graph we would publish:
        // both must agree, for every mode, or an operator gets a blank box or
        // a hidden graph.
        const visible = (condition: string | undefined, mode: string) =>
            (condition ?? '').split('=')[1].split(',').includes(mode);
        const { publisher, last } = collect();
        for (const mode of ['none', 'ducker', 'compressor', 'gate', 'expander']) {
            publisher.update({ mode });
            for (const key of [DYNAMICS_GRAPH, DUCK_ENVELOPE_GRAPH]) {
                expect(visible(showWhen(key), mode), `${key} in ${mode}`).toBe(last(key) !== null);
            }
        }
    });

    it('keeps the graph section out of the stats popup', () => {
        const declared = manifest.mediaRouter.statusSections.map((s) => s.id);
        expect(declared).not.toContain(GRAPH_SECTION);
    });
});
