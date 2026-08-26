/**
 * Static transfer curve for the dynamics stage — input dB → output dB.
 *
 * The maths lives here, plugin-side, because the semantics are this module's:
 * which LSP element is in circuit, what `knee` means on it, which parameters
 * even apply per mode. `dynamicsGraph.ts` turns it into publishable graph data
 * for compressor / gate / expander; the UI only plots. The ducker no longer
 * draws a transfer curve at all — it publishes the time-domain envelope
 * (`duckEnvelopeGraph.ts`), which reads its parameters through
 * `readDynamicsParams` here. `transferDb`'s ducker case is therefore unplotted
 * today; it is kept as the documented static model of the stage.
 *
 * It is the STATIC curve: attack / release / hold change how fast the DSP
 * walks along it, never where it goes, so they are published as text notes.
 * The knee is drawn as a soft knee of `|knee|` dB TOTAL width centred on the
 * threshold (the schema knob is "soft knee width", 0 = hard knee) with the
 * usual quadratic interpolation — continuous in value and in slope at both
 * knee edges. It is an operator-facing picture of the element, not a
 * bit-exact model of it.
 */

import { cfg, num, LADSPA_DYN_MODES } from './lspConfig.js';
import type { DynamicsMode } from './lspProcessing.js';

/** Both axes span this dB range, gridded every `GRID_DB`. */
export const MIN_DB = -60;
export const MAX_DB = 0;
export const GRID_DB = 10;
export const AXIS_LABELS = [-60, -40, -20, 0];
/** 1 dB per sample across the domain — plenty for a 230 px wide plot. */
const STEPS = 60;

export interface DynamicsParams {
    mode: DynamicsMode;
    threshold: number;
    ratio: number;
    /** Soft-knee width, dB (schema is negative; the magnitude is the width). */
    knee: number;
    makeupGain: number;
    /** Attenuation while the gate is closed, dB (negative). */
    gateDepth: number;
    /** Programme gain while the ducker's key is active, dB (negative). */
    duckDepth: number;
    limiterEnabled: boolean;
    limiterThreshold: number;
    attack: number;
    release: number;
    hold: number;
}

/** Live telemetry for the operating-point dot, from the chain meter poll. */
export interface LiveLevels {
    /** Chain input level, dB. */
    inDb: number | null;
    /** Gain reduction currently applied, dB (negative). */
    grDb: number | null;
}

const MODES: DynamicsMode[] = ['none', 'ducker', ...LADSPA_DYN_MODES];

/** Read the curve's inputs off module config, schema defaults applied. */
export function readDynamicsParams(config: Record<string, unknown>): DynamicsParams {
    const mode = String(config.mode ?? 'none') as DynamicsMode;
    return {
        mode: MODES.includes(mode) ? mode : 'none',
        threshold: num(cfg(config, 'threshold'), -35),
        ratio: Math.max(1, num(cfg(config, 'ratio'), 8)),
        knee: num(cfg(config, 'knee'), -6),
        makeupGain: num(cfg(config, 'makeupGain'), 0),
        gateDepth: num(cfg(config, 'gateDepth'), -48),
        duckDepth: num(cfg(config, 'duckDepth'), -12),
        limiterEnabled: config.limiterEnabled === true,
        limiterThreshold: num(cfg(config, 'limiterThreshold'), -1),
        attack: num(cfg(config, 'attack'), 5),
        release: num(cfg(config, 'release'), 200),
        hold: num(cfg(config, 'hold'), 250),
    };
}

/** Compressor: unity below the threshold, slope 1/ratio above, soft knee across. */
function compressorDb(x: number, threshold: number, ratio: number, width: number): number {
    const d = x - threshold;
    if (width > 0 && Math.abs(d) <= width / 2) {
        return x + ((1 / ratio - 1) * (d + width / 2) ** 2) / (2 * width);
    }
    return d <= 0 ? x : threshold + d / ratio;
}

/** Expander (downward): unity above the threshold, slope `ratio` below. */
function expanderDb(x: number, threshold: number, ratio: number, width: number): number {
    const d = x - threshold;
    if (width > 0 && Math.abs(d) <= width / 2) {
        return x - ((ratio - 1) * (d - width / 2) ** 2) / (2 * width);
    }
    return d >= 0 ? x : threshold + d * ratio;
}

/**
 * The stage's static transfer, dB in → dB out, BEFORE the limiter ceiling.
 * Unclamped — makeup gain legitimately pushes the curve above 0 dBFS on paper,
 * and the plot clamps to its axis rather than the maths lying about it.
 *
 * For `ducker` the axes differ: `inputDb` is the KEY level and the result is
 * the gain applied to the (unrelated) programme.
 */
export function transferDb(inputDb: number, p: DynamicsParams): number {
    const width = Math.abs(p.knee);
    switch (p.mode) {
        case 'ducker':
            return inputDb > p.threshold ? p.duckDepth : 0;
        case 'gate':
            return (inputDb < p.threshold ? inputDb + p.gateDepth : inputDb) + p.makeupGain;
        case 'compressor':
            return compressorDb(inputDb, p.threshold, p.ratio, width) + p.makeupGain;
        case 'expander':
            return expanderDb(inputDb, p.threshold, p.ratio, width) + p.makeupGain;
        default:
            return inputDb;
    }
}

/** The limiter's brickwall, applied on top of whichever curve is active. */
export function limitedDb(outputDb: number, p: DynamicsParams): number {
    return p.limiterEnabled ? Math.min(outputDb, p.limiterThreshold) : outputDb;
}

export const round = (v: number, dp = 1): number => Number(v.toFixed(dp));

/**
 * Sample the transfer curve across the dB domain. The threshold is sampled
 * from both sides so the gate's and ducker's discontinuity draws as a clean
 * vertical step instead of a slant between neighbouring samples.
 */
export function dynamicsCurvePoints(
    p: DynamicsParams,
    project: (db: number) => number = (db) => db,
    steps = STEPS,
): Array<[number, number]> {
    const xs: number[] = [];
    for (let i = 0; i <= steps; i++) xs.push(MIN_DB + ((MAX_DB - MIN_DB) * i) / steps);
    if (p.threshold > MIN_DB && p.threshold < MAX_DB) {
        xs.push(p.threshold - 1e-6, p.threshold + 1e-6);
    }
    xs.sort((a, b) => a - b);
    return xs.map((x) => [round(x, 3), round(project(transferDb(x, p)), 2)]);
}
