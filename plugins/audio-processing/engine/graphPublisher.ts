/**
 * Assembles the module's settings-panel graphs and hands them to the host's
 * `setStatusGraph`.
 *
 * All of them are recomputed from the CURRENT config, so a live slider drag
 * round-trips (patch → `onLiveConfigUpdate` → republish → curve follows). The
 * dynamics graph also carries the latest chain-meter reading as its live
 * operating point, which is why the meter poll republishes it once a second;
 * the ducker's envelope carries the applied gain instead, fed in at a
 * throttled rate by `DuckLiveThrottle`.
 *
 * EVERY key is published on every update, null included — that is what clears
 * a graph the previous mode owned (`setStatusGraph` deletes on null). Which
 * mode owns which graph is decided by the graph builders, not here: the two
 * dynamics graphs are mutually exclusive, so exactly one of them is non-null.
 *
 * The section id is graphs-only on purpose: `setStatusData` REPLACES a section
 * wholesale, so sharing one with the meter fields would wipe the curves every
 * poll. Nothing declares `graphs` in `statusSections`, so it never shows up in
 * the stats popup — it exists for the `x-graph` widgets alone.
 */

import type { StatusGraph } from '@media-router/engine';
import { duckEnvelopeGraph } from './duckEnvelopeGraph.js';
import type { DuckLive } from './duckLive.js';
import type { LiveLevels } from './dynamicsCurve.js';
import { dynamicsGraph } from './dynamicsGraph.js';
import { eqGraph } from './eqGraph.js';

export const GRAPH_SECTION = 'graphs';
export const DYNAMICS_GRAPH = 'dynamics';
export const DUCK_ENVELOPE_GRAPH = 'duckEnvelope';
export const EQ_GRAPH = 'eq';

export class GraphPublisher {
    private live: LiveLevels = { inDb: null, grDb: null };
    private duck: DuckLive | null = null;

    constructor(private readonly publish: (key: string, graph: StatusGraph | null) => void) {}

    /**
     * Recompute and publish. `levels` (when given) replaces the remembered
     * meter reading — a config-driven republish keeps the last one, so the dot
     * doesn't blink off between meter ticks.
     */
    update(config: Record<string, unknown>, levels?: LiveLevels): void {
        if (levels) this.live = levels;
        this.publish(DYNAMICS_GRAPH, dynamicsGraph(config, this.live));
        this.publish(DUCK_ENVELOPE_GRAPH, duckEnvelopeGraph(config, this.duck));
        this.publish(EQ_GRAPH, eqGraph(config));
    }

    /**
     * Latest ducker envelope reading, or null once it has settled back to
     * unity. Remembered like the meter levels, so a slider move republishes
     * with the duck still showing. The caller republishes.
     */
    setDuckLive(duck: DuckLive | null): void {
        this.duck = duck;
    }

    /** Drop the live overlays — the chain is no longer metering or ducking. */
    clearLive(): void {
        this.live = { inDb: null, grDb: null };
        this.duck = null;
    }
}
