/**
 * Summed frequency response of the 6-band parametric EQ (and the high-pass
 * filter when it is on) as publishable graph data.
 *
 * Bands are cascaded, so their dB magnitudes sum. Band values are read through
 * the same `eqBandKey` / `eqBandDefault` table that builds the launch string
 * (`eqBands.ts`), so the curve can't disagree with what was applied to the
 * element. `hpfEnabled` sits outside the EQ element, so a `bypass` flattens
 * the bands and the trims but leaves the HPF in circuit — exactly as the
 * pipeline does.
 */

import type { StatusGraph } from '@media-router/engine';
import { EQ_BANDS, eqBandKey, eqBandDefault, type EqBandField } from './eqBands.js';
import { bandMagnitudeDb, hpfMagnitudeDb, type EqBandSpec } from './eqBiquad.js';
import { cfg, num } from './lspConfig.js';
import { hpfCutoff } from './lspProcessing.js';

const MIN_HZ = 20;
const MAX_HZ = 20000;
const MIN_DB = -18;
const MAX_DB = 18;
const GRID_DB = 6;
/** ~24 samples per decade — smooth enough for a 230 px wide plot. */
const STEPS = 72;

const bandValue = (config: Record<string, unknown>, index: number, field: EqBandField): unknown =>
    config[eqBandKey(index, field)] ?? eqBandDefault(index, field);

export interface EqParams {
    bands: EqBandSpec[];
    bypass: boolean;
    /** Constant dB offset — the EQ element's own input + output trims. */
    trimDb: number;
    hpfEnabled: boolean;
    hpfFreq: number;
}

/** Read the six bands + globals off module config, schema defaults applied. */
export function readEqParams(config: Record<string, unknown>): EqParams {
    const bands: EqBandSpec[] = [];
    for (let i = 0; i < EQ_BANDS; i++) {
        bands.push({
            type: String(bandValue(config, i, 'Type')),
            freq: num(bandValue(config, i, 'Freq'), 1000),
            gain: num(bandValue(config, i, 'Gain'), 0),
            q: num(bandValue(config, i, 'Q'), 1),
        });
    }
    return {
        bands,
        bypass: cfg(config, 'eqBypass') === true,
        trimDb: num(cfg(config, 'eqInputGain'), 0) + num(cfg(config, 'eqOutputGain'), 0),
        hpfEnabled: config.hpfEnabled === true,
        hpfFreq: hpfCutoff(cfg(config, 'hpfFreq')),
    };
}

/** Summed response of every enabled band (plus trims and the HPF) at `freq`. */
export function eqResponseDb(freq: number, p: EqParams): number {
    let db = 0;
    if (!p.bypass) {
        db += p.trimDb;
        for (const band of p.bands) db += bandMagnitudeDb(band, freq);
    }
    if (p.hpfEnabled) db += hpfMagnitudeDb(p.hpfFreq, freq);
    return db;
}

/** Log-spaced sample of the summed response across the audio band. */
export function eqCurvePoints(p: EqParams, steps = STEPS): Array<[number, number]> {
    const logMin = Math.log10(MIN_HZ);
    const logSpan = Math.log10(MAX_HZ) - logMin;
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
        const freq = 10 ** (logMin + (logSpan * i) / steps);
        points.push([Number(freq.toFixed(1)), Number(eqResponseDb(freq, p).toFixed(2))]);
    }
    return points;
}

function notesFor(p: EqParams): string[] {
    if (p.bypass) return ['EQ bypassed'];
    const active = p.bands.filter((b) => b.type !== 'off').length;
    const notes = [active === 0 ? 'All bands off — flat' : `${active} of 6 bands on`];
    if (p.trimDb !== 0) notes.push(`Trim ${p.trimDb > 0 ? '+' : ''}${p.trimDb} dB`);
    return notes;
}

/** The EQ response curve as publishable graph data. */
export function eqGraph(config: Record<string, unknown>): StatusGraph | null {
    if (config.eqEnabled !== true) return null;
    const p = readEqParams(config);
    const markers: StatusGraph['markers'] = p.hpfEnabled
        ? [
              {
                  axis: 'x',
                  value: p.hpfFreq,
                  label: `HPF ${p.hpfFreq} Hz`,
                  role: 'warning',
                  stroke: 'dashed',
              },
          ]
        : [];
    return {
        axes: {
            x: {
                label: 'Frequency',
                unit: 'Hz',
                min: MIN_HZ,
                max: MAX_HZ,
                scale: 'log',
                labels: [20, 100, 1000, 10000, 20000],
            },
            y: {
                label: 'Gain',
                unit: 'dB',
                min: MIN_DB,
                max: MAX_DB,
                gridStep: GRID_DB,
                labels: [-18, -12, -6, 0, 6, 12, 18],
            },
        },
        series: [
            {
                id: 'zero',
                points: [
                    [MIN_HZ, 0],
                    [MAX_HZ, 0],
                ],
                role: 'muted',
                stroke: 'dotted',
            },
            {
                id: 'response',
                points: eqCurvePoints(p),
                role: p.bypass ? 'muted' : 'primary',
            },
        ],
        markers,
        notes: notesFor(p),
    };
}
