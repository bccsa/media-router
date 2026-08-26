/**
 * `para-equalizer-x16-stereo` mapping — label↔index maps, the band-field table,
 * and the launch-string / live-write resolution built from it.
 *
 * The index maps below are hardcoded from the LSP docs and verified against
 * `gst-inspect-1.0` on lsp-plugins-ladspa 1.2.5 (LADSPA carries no enum nicks,
 * so a renamed or re-ordered port shows up as a silently ignored property).
 * Re-check on any lsp-plugins version bump.
 */

import { cfg, clampNumber, dbToLinear } from './lspConfig.js';

/** UI bands (0–5). Bands 6–15 exist on the element and stay `filter-type=0`. */
export const EQ_BANDS = 6;
export const EQ_TOTAL_BANDS = 16;

/** `filter-type-N` (0–8). Index order read off lsp-plugins-ladspa 1.2.5. */
export const EQ_FILTER_TYPES: Record<string, number> = {
    off: 0,
    bell: 1,
    hipass: 2,
    hishelf: 3,
    lopass: 4,
    loshelf: 5,
    notch: 6,
    resonance: 7,
    allpass: 8,
};

/** `filter-mode-N` (0–6) — the filter's analogue model. */
export const EQ_FILTER_MODES: Record<string, number> = {
    'rlc-bt': 0,
    'rlc-mt': 1,
    'bwc-bt': 2,
    'bwc-mt': 3,
    'lrx-bt': 4,
    'lrx-mt': 5,
    'apo-dr': 6,
};

/** `filter-slope-N` (0–3) — x1…x4 steepness. Steeper slopes add latency. */
export const EQ_SLOPES: Record<string, number> = { x1: 0, x2: 1, x3: 2, x4: 3 };

/** Per-band default centre frequencies for a 6-band UI. */
export const EQ_DEFAULT_FREQS = [80, 240, 750, 2200, 6000, 12000];

/** `gain-N` is LINEAR (0.01585…63.09575 = −36…+36 dB), NOT dB. */
export const eqBandGain = (db: unknown): number => dbToLinear(db, 0.01585, 63.09575);

export type EqBandField = 'Type' | 'Freq' | 'Gain' | 'Q';

export interface EqBandFieldSpec {
    /** Element property, `-N`-suffixed per band. */
    prop: string;
    /** Bands start OFF, so the EQ is transparent until an operator picks a
     *  filter type. Frequency is the only per-index default. */
    default: (index: number) => number | string;
    convert: (v: unknown) => number;
}

/**
 * The ONE description of a band field. Both directions read it: the launch
 * string (`eqProps`) and the live property write (`resolveEqBandTarget`), so a
 * knob can never mean one thing at start and another when it is dragged.
 */
export const EQ_BAND_FIELDS: Record<EqBandField, EqBandFieldSpec> = {
    Type: {
        prop: 'filter-type',
        default: () => 'off',
        convert: (v) => EQ_FILTER_TYPES[String(v)] ?? 0,
    },
    Freq: {
        prop: 'frequency',
        default: (index) => EQ_DEFAULT_FREQS[index] ?? 1000,
        convert: (v) => clampNumber(v, 10, 24000),
    },
    Gain: { prop: 'gain', default: () => 0, convert: eqBandGain },
    Q: { prop: 'quality-factor', default: () => 1, convert: (v) => clampNumber(v, 0, 100) },
};

/** `eqBand{index}{Field}` — the flat per-band config keys (arrays can't be
 *  live-patched field-by-field through the settings patch channel). */
export function eqBandKey(index: number, field: EqBandField): string {
    return `eqBand${index}${field}`;
}

/** Default for one band field. */
export function eqBandDefault(index: number, field: EqBandField): number | string {
    return EQ_BAND_FIELDS[field].default(index);
}

const eqBandValue = (config: Record<string, unknown>, index: number, field: EqBandField): unknown =>
    config[eqBandKey(index, field)] ?? eqBandDefault(index, field);

export const EQ_BAND_KEY_RE = /^eqBand(\d+)(Type|Freq|Gain|Q)$/;

/**
 * The full `para-equalizer-x16-stereo` property list: globals, then bands 0–5
 * from config, then an explicit `filter-type-N=0` for the unused bands 6–15.
 * The unused bands default to 0 anyway — writing them keeps the launch string
 * self-describing and immune to a sticky-property replay from an older config.
 */
export function eqProps(config: Record<string, unknown>): string[] {
    const mode = EQ_FILTER_MODES[String(cfg(config, 'eqMode'))] ?? 0;
    const slope = EQ_SLOPES[String(cfg(config, 'eqSlope'))] ?? 0;
    const props = [
        `bypass=${cfg(config, 'eqBypass') === true}`,
        `input-gain=${dbToLinear(cfg(config, 'eqInputGain'), 0, 10)}`,
        `output-gain=${dbToLinear(cfg(config, 'eqOutputGain'), 0, 10)}`,
    ];
    for (let i = 0; i < EQ_BANDS; i++) {
        const type = EQ_BAND_FIELDS.Type.convert(eqBandValue(config, i, 'Type'));
        props.push(`filter-type-${i}=${type}`);
        props.push(`filter-mode-${i}=${mode}`, `filter-slope-${i}=${slope}`);
        for (const field of ['Freq', 'Gain', 'Q'] as const) {
            const spec = EQ_BAND_FIELDS[field];
            props.push(`${spec.prop}-${i}=${spec.convert(eqBandValue(config, i, field))}`);
        }
    }
    for (let i = EQ_BANDS; i < EQ_TOTAL_BANDS; i++) props.push(`filter-type-${i}=0`);
    return props;
}

/** An element property write, before the caller stamps the element name on. */
export interface EqWrite {
    prop: string;
    value: number | boolean;
}

/**
 * One live `eq*` config key → the property to write on the EQ element, or null
 * when the key drives nothing (a band outside the 6-band UI, or a fan-out knob
 * — see `eqFanOutWrites`).
 */
export function resolveEqWrite(key: string, value: unknown): EqWrite | null {
    const band = EQ_BAND_KEY_RE.exec(key);
    if (band) {
        const index = Number(band[1]);
        if (index >= EQ_BANDS) return null;
        const spec = EQ_BAND_FIELDS[band[2] as EqBandField];
        return { prop: `${spec.prop}-${index}`, value: spec.convert(value) };
    }
    if (key === 'eqBypass') return { prop: 'bypass', value: value === true };
    if (key === 'eqInputGain') return { prop: 'input-gain', value: dbToLinear(value, 0, 10) };
    if (key === 'eqOutputGain') return { prop: 'output-gain', value: dbToLinear(value, 0, 10) };
    return null;
}

/** `eqMode` / `eqSlope` are single UI knobs that fan out to all six bands. */
export function eqFanOutWrites(key: string, value: unknown): EqWrite[] {
    const map =
        key === 'eqMode'
            ? { table: EQ_FILTER_MODES, prop: 'filter-mode' }
            : key === 'eqSlope'
              ? { table: EQ_SLOPES, prop: 'filter-slope' }
              : null;
    if (!map) return [];
    const v = map.table[String(value)] ?? 0;
    return Array.from({ length: EQ_BANDS }, (_, i) => ({ prop: `${map.prop}-${i}`, value: v }));
}
