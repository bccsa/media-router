/**
 * `ChainTelemetry` is wiring, so these are wiring tests: which pollers start
 * and stop with the chain, that a duck reading reaches the graph publisher and
 * is forgotten on stop, and that the live overlays are cleared rather than
 * frozen at the last value the chain saw.
 *
 * The poll internals belong to `statusPoll.ts` / `ThroughputPoller` and the
 * curve maths to the graph builders — both are covered by their own files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChainTelemetry, type ChainTelemetryHooks } from './chainTelemetry.js';
import { DYNAMICS_GRAPH, DUCK_ENVELOPE_GRAPH, EQ_GRAPH } from './graphPublisher.js';
import type { ChainStages } from './lspProcessing.js';
import type { StatusGraph } from '@media-router/engine';

const stages = (over: Partial<ChainStages> = {}): ChainStages =>
    ({
        eqElement: null,
        dynElement: null,
        limiterElement: null,
        dynMode: 'none',
        keyedGate: false,
        duckerKey: false,
        ...over,
    }) as ChainStages;

interface Harness {
    telemetry: ChainTelemetry;
    hooks: ChainTelemetryHooks;
    graphs: Array<[string, StatusGraph | null]>;
    status: Array<[string, Record<string, unknown>]>;
    badges: Array<[string, { text: string } | null]>;
    /** Property reads the meter poll issued, as `element/prop`. */
    reads: string[];
    setConfig: (c: Record<string, unknown>) => void;
}

function harness(initial: Record<string, unknown> = {}): Harness {
    const graphs: Harness['graphs'] = [];
    const status: Harness['status'] = [];
    const badges: Harness['badges'] = [];
    const reads: string[] = [];
    let config = initial;

    const hooks: ChainTelemetryHooks = {
        readProperty: async (element, prop) => {
            reads.push(`${element}/${prop}`);
            return 1;
        },
        readSinkBytes: async () => ({ sink: 0 }),
        publishStatus: (section, data) => void status.push([section, data]),
        publishGraph: (key, graph) => void graphs.push([key, graph]),
        badge: (id, badge) => void badges.push([id, badge]),
        config: () => config,
    };

    return {
        telemetry: new ChainTelemetry(hooks),
        hooks,
        graphs,
        status,
        badges,
        reads,
        setConfig: (c) => {
            config = c;
        },
    };
}

/** Graph keys published since the harness (or the last splice) — order kept. */
const keysOf = (graphs: Harness['graphs']): string[] => graphs.map(([key]) => key);

describe('ChainTelemetry.publishGraphs', () => {
    it('publishes every graph key on every update, nulls included', () => {
        const h = harness({});
        h.telemetry.publishGraphs();

        expect(keysOf(h.graphs)).toEqual([DYNAMICS_GRAPH, DUCK_ENVELOPE_GRAPH, EQ_GRAPH]);
        // Nothing enabled — all three clear, which is what deletes a graph the
        // previous mode owned.
        expect(h.graphs.every(([, g]) => g === null)).toBe(true);
    });

    it('reads config fresh each time, so a live change is picked up', () => {
        const h = harness({});
        h.telemetry.publishGraphs();
        expect(h.graphs.find(([k]) => k === EQ_GRAPH)![1]).toBeNull();

        h.graphs.length = 0;
        h.setConfig({ eqEnabled: true });
        h.telemetry.publishGraphs();

        expect(h.graphs.find(([k]) => k === EQ_GRAPH)![1]).not.toBeNull();
    });
});

describe('ChainTelemetry start / stop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts the throughput poll even when there is no LADSPA stage', async () => {
        const h = harness({});
        h.telemetry.start(null);
        // ThroughputPoller's default interval is 2 s, the meter poll's is 1 s.
        await vi.advanceTimersByTimeAsync(2100);

        expect(h.status.map(([section]) => section)).toContain('throughput');
        // No stages ⇒ nothing was read off the pipeline.
        expect(h.reads).toEqual([]);

        h.telemetry.stop();
    });

    it('starts the meter poll only when a stage exists to read', async () => {
        const h = harness({ mode: 'compressor' });
        h.telemetry.start(stages({ dynElement: 'dyn-elem', dynMode: 'compressor' }));
        await vi.advanceTimersByTimeAsync(1100);

        expect(h.reads).toContain('dyn/latency');
        expect(h.status.map(([section]) => section)).toContain('meters');

        h.telemetry.stop();
    });

    it('a stage-less chain never publishes meters', async () => {
        const h = harness({});
        h.telemetry.start(stages());
        await vi.advanceTimersByTimeAsync(2100);

        expect(h.status.map(([section]) => section)).not.toContain('meters');
        h.telemetry.stop();
    });

    it('stop halts both polls — no publishes after it', async () => {
        const h = harness({ mode: 'compressor' });
        h.telemetry.start(stages({ dynElement: 'dyn-elem', dynMode: 'compressor' }));
        await vi.advanceTimersByTimeAsync(1100);

        h.telemetry.stop();
        h.status.length = 0;
        h.reads.length = 0;
        await vi.advanceTimersByTimeAsync(5000);

        expect(h.status).toEqual([]);
        expect(h.reads).toEqual([]);
    });

    it('stop republishes the graphs so the live dot clears', () => {
        const h = harness({ eqEnabled: true });
        h.telemetry.start(null);
        h.graphs.length = 0;

        h.telemetry.stop();

        expect(keysOf(h.graphs)).toEqual([DYNAMICS_GRAPH, DUCK_ENVELOPE_GRAPH, EQ_GRAPH]);
    });
});

describe('ChainTelemetry.duckLevel', () => {
    it('forwards a duck reading to the envelope graph', () => {
        const h = harness({ mode: 'ducker' });
        h.graphs.length = 0;

        h.telemetry.duckLevel({ gainDb: -9, keyDb: -20, phase: 'attack' });

        const envelope = h.graphs.filter(([k]) => k === DUCK_ENVELOPE_GRAPH);
        expect(envelope).toHaveLength(1);
        expect(envelope[0][1]).not.toBeNull();
        expect(envelope[0][1]!.live).toMatchObject({ y: -9 });
    });

    it('publishes nothing while the ducker sits at unity', () => {
        const h = harness({ mode: 'ducker' });
        h.graphs.length = 0;

        h.telemetry.duckLevel({ gainDb: 0, keyDb: -60, phase: 'idle' });

        expect(h.graphs).toEqual([]);
    });

    it('stop resets the throttle, so the next run publishes its onset again', () => {
        const h = harness({ mode: 'ducker' });

        // Without the reset the throttle would still be holding this gain and
        // drop an identical reading on the next run as "no significant move".
        h.telemetry.duckLevel({ gainDb: -9, keyDb: -20, phase: 'attack' });
        h.telemetry.stop();
        h.graphs.length = 0;

        h.telemetry.duckLevel({ gainDb: -9, keyDb: -20, phase: 'attack' });

        const envelope = h.graphs.filter(([k]) => k === DUCK_ENVELOPE_GRAPH);
        expect(envelope[0][1]!.live).toMatchObject({ y: -9 });
    });

    it('stop clears the remembered duck, so a later republish has no live dot', () => {
        const h = harness({ mode: 'ducker' });
        h.telemetry.duckLevel({ gainDb: -9, keyDb: -20, phase: 'attack' });

        h.telemetry.stop();
        h.graphs.length = 0;
        h.telemetry.publishGraphs();

        const envelope = h.graphs.find(([k]) => k === DUCK_ENVELOPE_GRAPH)![1];
        expect(envelope!.live).toBeUndefined();
    });
});
