/**
 * The ducker's TIME-DOMAIN envelope as publishable graph data — the half of
 * the story the key → gain transfer curve cannot tell. The curve says how deep
 * the duck goes and from what key level; this says how fast it gets there and
 * how long it stays after the talker stops.
 *
 * Shape and conventions follow `docs/research/ducker-visualization.md`, which
 * surveyed what shipping consoles and DSP actually draw: attenuation downward
 * from a 0 dB idle line (universal), the floor labelled on the plateau, the
 * key's trigger window shown (hold is *defined* from the key falling below
 * threshold, so the plateau is unreadable without it), and the key threshold
 * deliberately NOT drawn here — it is a key-LEVEL quantity and belongs on the
 * transfer curve, which is where `dynamicsGraph.ts` puts it.
 *
 * **The x axis is ordered, not to scale.** Attack (1–500 ms), hold (0–2000 ms)
 * and release (5–2000 ms) differ by orders of magnitude, so real linear time
 * draws a typical 5 ms attack one pixel wide — and attack is the parameter
 * operators most often get wrong. Each phase therefore gets a floor of the
 * width plus a share of the rest weighted by `sqrt(duration)`: compressed
 * enough that nothing collapses, ordered enough that a long release still
 * visibly outlasts a short attack. The real values ride on the segment
 * markers, and the axis prints no ticks that would imply otherwise.
 *
 * The ramps are drawn straight because `DuckerEnvelope` really is linear in dB
 * (`db ± (|floor| / time) * dt`), which also makes our attack and release FULL
 * TRAVEL durations to the floor and back — Logic/Ableton semantics, not Q-SYS's
 * 63 % time constants nor Yamaha's per-6 dB rates. The notes say so.
 *
 * Everything here is a domain decision made plugin-side; the UI only plots
 * (ADR-0007).
 */

import type { GraphMarker, GraphSeries, StatusGraph } from '@media-router/engine';
import { readDynamicsParams, round, type DynamicsParams } from './dynamicsCurve.js';
import type { DuckLive } from './duckLive.js';

/** Normalised timeline. Not seconds — see the note above. */
const X_MIN = 0;
const X_MAX = 1;
/** Flat lead-in / lead-out, so idle reads as a state rather than an edge. */
const IDLE_PAD = 0.08;
/** Smallest share of the width a phase gets, however short it really is. */
const PHASE_FLOOR = 0.12;
/** Room under the floor for the key rail, as a fraction of the duck depth. */
const HEADROOM = 0.25;
/** Keeps the y axis from collapsing when the duck floor is 0 dB. */
const MIN_AXIS_DB = -1;

export interface EnvelopePhase {
    id: 'attack' | 'hold' | 'release';
    /** Real duration, ms — printed on the segment marker. */
    ms: number;
    label: string;
    /** Segment bounds on the normalised x axis. */
    from: number;
    to: number;
}

const PHASES = [
    { id: 'attack', name: 'Attack', read: (p: DynamicsParams) => p.attack },
    { id: 'hold', name: 'Hold', read: (p: DynamicsParams) => p.hold },
    { id: 'release', name: 'Release', read: (p: DynamicsParams) => p.release },
] as const;

/**
 * Where each phase sits on the normalised axis: `PHASE_FLOOR` each, then the
 * rest split by `sqrt(duration)`. With all three at zero (not reachable
 * through the schema) they simply share it evenly.
 */
export function envelopePhases(p: DynamicsParams): EnvelopePhase[] {
    const ms = PHASES.map((phase) => Math.max(0, phase.read(p)));
    const weights = ms.map((t) => Math.sqrt(t));
    const total = weights.reduce((a, b) => a + b, 0);
    const spare = X_MAX - X_MIN - 2 * IDLE_PAD - PHASES.length * PHASE_FLOOR;
    let from = X_MIN + IDLE_PAD;
    return PHASES.map((phase, i) => {
        const width = PHASE_FLOOR + spare * (total > 0 ? weights[i] / total : 1 / PHASES.length);
        // Pin the last edge instead of accumulating float error into it.
        const to = i === PHASES.length - 1 ? X_MAX - IDLE_PAD : from + width;
        const segment: EnvelopePhase = {
            id: phase.id,
            ms: round(ms[i], 1),
            label: `${phase.name} ${round(ms[i], 1)} ms`,
            from: round(from, 3),
            to: round(to, 3),
        };
        from = to;
        return segment;
    });
}

/**
 * The live dot, placed on the leg of the envelope the phase names and at the
 * gain the envelope is actually applying. On a ramp that gain fixes the x
 * position exactly (the dot rides the drawn line); on the plateau it sits mid
 * segment. An unknown or idle phase gets no dot at all — the x axis is
 * schematic, so there is nothing honest to interpolate.
 */
function liveDot(
    phases: EnvelopePhase[],
    floor: number,
    live: DuckLive,
): Pick<StatusGraph, 'live'> {
    const [attack, hold, release] = phases;
    const travelled = floor < 0 ? Math.min(1, Math.max(0, live.gainDb / floor)) : 0;
    let x: number;
    if (live.phase === 'attack') x = attack.from + travelled * (attack.to - attack.from);
    else if (live.phase === 'hold') x = (hold.from + hold.to) / 2;
    else if (live.phase === 'release') x = release.to - travelled * (release.to - release.from);
    else return {};
    return { live: { x: round(x, 3), y: live.gainDb, role: 'primary' } };
}

/**
 * The ducker gain envelope as publishable graph data, or null in any other
 * dynamics mode (nothing to draw — the other stages act on the programme
 * itself and their timing is annotation on the transfer curve).
 */
export function duckEnvelopeGraph(
    config: Record<string, unknown>,
    live?: DuckLive | null,
): StatusGraph | null {
    const p = readDynamicsParams(config);
    if (p.mode !== 'ducker') return null;

    const floor = Math.min(0, p.duckDepth);
    const phases = envelopePhases(p);
    const [attack, hold, release] = phases;
    // Headroom under the floor gives the key rail somewhere to live, and keeps
    // the plateau off the frame. Gridlines land on the floor and half of it.
    const axisMin = Math.min(floor, MIN_AXIS_DB) * (1 + HEADROOM);
    const keyRail = (axisMin + Math.min(floor, MIN_AXIS_DB)) / 2;

    const markers: GraphMarker[] = phases.map((phase) => ({
        axis: 'x',
        value: phase.from,
        label: phase.label,
        role: 'secondary',
        stroke: 'dashed',
    }));
    markers.push({
        axis: 'y',
        value: floor,
        label: `Duck ${floor} dB`,
        role: 'muted',
        stroke: 'dashed',
    });
    // The applied gain as a rule across the whole plot: it carries the number,
    // and it is the honest fallback whenever the dot cannot be placed.
    if (live && live.gainDb < 0) {
        markers.push({
            axis: 'y',
            value: live.gainDb,
            label: `${live.gainDb} dB`,
            role: 'primary',
            stroke: 'solid',
        });
    }

    const series: GraphSeries[] = [
        {
            id: 'envelope',
            points: [
                [X_MIN, 0],
                [attack.from, 0],
                [attack.to, floor],
                [hold.to, floor],
                [release.to, 0],
                [X_MAX, 0],
            ],
            role: 'primary',
        },
        // Key over threshold: from the trigger to the drop that starts the
        // hold. Drawn as a rail in the headroom, not as a fake waveform.
        {
            id: 'key',
            points: [
                [attack.from, keyRail],
                [hold.from, keyRail],
            ],
            role: 'warning',
        },
    ];

    return {
        axes: {
            // No unit and no tick labels: the axis is ordered, not measured.
            x: { label: 'Time →', min: X_MIN, max: X_MAX, gridStep: X_MAX - X_MIN, labels: [] },
            y: {
                label: 'Program gain',
                unit: 'dB',
                min: round(axisMin, 2),
                max: 0,
                gridStep: round(Math.abs(axisMin) / 5, 3),
                labels: [...new Set([floor, round(floor / 2, 1), 0])],
            },
        },
        series,
        markers,
        notes: ['Key over threshold', 'Attack / release = full travel', 'Phases not to scale'],
        ...(live ? liveDot(phases, floor, live) : {}),
    };
}
