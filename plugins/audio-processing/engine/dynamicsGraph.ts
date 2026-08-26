/**
 * The dynamics transfer curve as publishable graph data — the `StatusGraph`
 * the settings panel's `graph` widget renders. Every domain decision (axes,
 * units, which series exist, what the notes say) is made here; the UI plots.
 *
 * Compressor / gate / expander only. The ducker draws its time-domain gain
 * envelope instead (`duckEnvelopeGraph.ts`) and nothing else: on a ducker the
 * static curve is two flat lines and a step, and the questions an operator
 * actually has — how fast, and how long after the talker stops — live on the
 * envelope. Publishing null here is what CLEARS a curve left behind by the
 * previous mode: `setStatusGraph(section, key, null)` deletes the key.
 */

import type { GraphSeries, StatusGraph } from '@media-router/engine';
import {
    dynamicsCurvePoints,
    limitedDb,
    readDynamicsParams,
    round,
    transferDb,
    AXIS_LABELS,
    GRID_DB,
    MAX_DB,
    MIN_DB,
    type DynamicsParams,
    type LiveLevels,
} from './dynamicsCurve.js';
import { isLadspaDynMode } from './lspConfig.js';

function notesFor(p: DynamicsParams): string[] {
    const timing = [`Attack ${p.attack} ms`, `Release ${p.release} ms`];
    switch (p.mode) {
        case 'gate':
            return [`Depth ${p.gateDepth} dB`, ...timing];
        case 'compressor':
        case 'expander':
            return [`${p.ratio}:1`, `Knee ${Math.abs(p.knee)} dB`, ...timing];
        default:
            return [];
    }
}

/**
 * The dynamics transfer curve as publishable graph data, or null when there is
 * none to draw — the stage is off, or it is the ducker (see the file header).
 */
export function dynamicsGraph(
    config: Record<string, unknown>,
    live?: LiveLevels,
): StatusGraph | null {
    const p = readDynamicsParams(config);
    // The static curve exists exactly where a LADSPA dynamics element does.
    if (!isLadspaDynMode(p.mode)) return null;

    // Unity reference first, so the active curve draws over it.
    const series: GraphSeries[] = [
        {
            id: 'unity',
            points: [
                [MIN_DB, MIN_DB],
                [MAX_DB, MAX_DB],
            ],
            role: 'muted',
            stroke: 'dotted',
        },
    ];
    if (p.limiterEnabled) {
        series.push({
            id: 'limited',
            points: dynamicsCurvePoints(p, (db) => limitedDb(db, p)),
            role: 'error',
            stroke: 'dashed',
        });
    }
    series.push({ id: 'transfer', points: dynamicsCurvePoints(p), role: 'primary' });

    const markers: StatusGraph['markers'] = [
        {
            axis: 'x',
            value: p.threshold,
            label: `Thr ${p.threshold} dB`,
            role: 'warning',
            stroke: 'dashed',
        },
    ];
    if (p.limiterEnabled) {
        markers.push({
            axis: 'y',
            value: p.limiterThreshold,
            label: `Ceiling ${p.limiterThreshold} dB`,
            role: 'error',
            stroke: 'dotted',
        });
    }

    const axis = (label: string) => ({
        label,
        unit: 'dB',
        min: MIN_DB,
        max: MAX_DB,
        gridStep: GRID_DB,
        labels: AXIS_LABELS,
    });

    return {
        axes: { x: axis('Input'), y: axis('Output') },
        series,
        markers,
        notes: notesFor(p),
        ...livePoint(p, live),
    };
}

/** The operating-point dot + the reduction it is applying, when reported. */
function livePoint(p: DynamicsParams, live?: LiveLevels): Pick<StatusGraph, 'live'> {
    if (!live || live.inDb === null) return {};
    const y = round(limitedDb(transferDb(live.inDb, p), p), 2);
    const gr = live.grDb !== null && live.grDb < 0 ? live.grDb : null;
    return {
        live: {
            x: round(live.inDb, 2),
            y,
            role: 'primary',
            ...(gr === null ? {} : { span: [y, round(y - gr, 2)] as [number, number] }),
        },
    };
}
