/**
 * LSP LADSPA parameter mapping for the Audio Processing chain — pure, no gst.
 *
 * Dynamics, limiter and HPF ports live here; the parametric EQ's own maps are
 * in `eqBands.ts`, and the dB→linear / clamping conversions plus the schema
 * defaults in `lspConfig.ts`.
 *
 * Every LSP control port is a bare float/int: LADSPA carries no enum nicks and
 * no units, so the port names and ranges below are hardcoded from the LSP docs
 * and verified against `gst-inspect-1.0` on lsp-plugins-ladspa 1.2.5 (the
 * clamps are that inspection's, not guesses). Re-check on any lsp-plugins
 * version bump — a renamed port shows up as a silently ignored property.
 */

import { eqFanOutWrites, resolveEqWrite } from './eqBands.js';
import { cfg, clampNumber, dbToLinear, type LadspaDynMode, type PropMap } from './lspConfig.js';

/** The LADSPA-backed modes plus the two that build no LSP element: `none`
 *  (no stage) and `ducker` (native `level`→`volume` loop). */
export type DynamicsMode = 'none' | 'ducker' | LadspaDynMode;

/** Version-suffixed LADSPA element names are resolved at start via
 *  `findLadspaElement(<suffix>)` — never hardcoded whole. */
export const EQ_SUFFIX = 'para-equalizer-x16-stereo';
export const LIMITER_SUFFIX = 'limiter-stereo';
export const DYN_SUFFIXES = {
    /** SELF-keyed: a program compressor/gate/expander needs no external key,
     *  which is what lets the whole 4-channel deinterleave→interleave packing
     *  (program on 0/1, key on 2/3) disappear from this module. */
    compressor: 'compressor-stereo',
    gate: 'gate-stereo',
    expander: 'expander-stereo',
    /** The ONE surviving `sc-*` element: an externally keyed gate. 4-ch in. */
    gateSidechain: 'sc-gate-stereo',
} as const;

/** `audiocheblimit` cutoff, clamped to the SCHEMA's hpfFreq range so a live
 *  drag and the launch string can't disagree about the usable span. */
export const hpfCutoff = (v: unknown): number => clampNumber(v, 20, 500);

/** Config key → element property, per dynamics mode. The property NAMES differ
 *  per element (compressor/expander use `attack-time`, the gate `attack`), so
 *  the same operator-facing knob lands in the right port for every mode. */
export const DYN_PROP_MAPS: Record<LadspaDynMode, Record<string, PropMap>> = {
    compressor: {
        threshold: { prop: 'attack-threshold', convert: (v) => dbToLinear(v, 0.001, 1) },
        ratio: { prop: 'ratio', convert: (v) => clampNumber(v, 1, 100) },
        attack: { prop: 'attack-time', convert: (v) => clampNumber(v, 0, 2000) },
        release: { prop: 'release-time', convert: (v) => clampNumber(v, 0, 5000) },
        knee: { prop: 'knee', convert: (v) => dbToLinear(v, 0.0631, 1) },
        makeupGain: { prop: 'makeup-gain', convert: (v) => dbToLinear(v, 0.001, 1000) },
    },
    gate: {
        threshold: { prop: 'curve-threshold', convert: (v) => dbToLinear(v, 0.001, 1) },
        gateDepth: { prop: 'reduction', convert: (v) => dbToLinear(v, 0.00025119, 3981.073) },
        attack: { prop: 'attack', convert: (v) => clampNumber(v, 0, 2000) },
        release: { prop: 'release', convert: (v) => clampNumber(v, 0, 5000) },
        makeupGain: { prop: 'makeup-gain', convert: (v) => dbToLinear(v, 0.001, 1000) },
    },
    expander: {
        threshold: { prop: 'attack-threshold', convert: (v) => dbToLinear(v, 0.001, 1) },
        ratio: { prop: 'ratio', convert: (v) => clampNumber(v, 1, 100) },
        attack: { prop: 'attack-time', convert: (v) => clampNumber(v, 0, 2000) },
        release: { prop: 'release-time', convert: (v) => clampNumber(v, 0, 5000) },
        knee: { prop: 'knee', convert: (v) => dbToLinear(v, 0.0631, 1) },
        makeupGain: { prop: 'makeup-gain', convert: (v) => dbToLinear(v, 0.001, 1000) },
    },
};

/** Config key → `limiter-stereo` property. */
export const LIMITER_PROP_MAP: Record<string, PropMap> = {
    limiterThreshold: { prop: 'threshold', convert: (v) => dbToLinear(v, 0.00398107, 1) },
    limiterAttack: { prop: 'attack-time', convert: (v) => clampNumber(v, 0.25, 20) },
    limiterRelease: { prop: 'release-time', convert: (v) => clampNumber(v, 0.25, 20) },
    limiterLookahead: { prop: 'lookahead', convert: (v) => clampNumber(v, 0.1, 20) },
};

/** Which chain stages actually exist in the running pipeline — live writes are
 *  guarded by this so a knob for an absent stage never addresses a missing
 *  element (a `command_error` per keystroke otherwise). */
export interface ChainStages {
    hpf: boolean;
    eqElement: string | null;
    dynElement: string | null;
    dynMode: DynamicsMode;
    /** gate mode with an external key → the 4-channel `sc-gate-stereo` path. */
    keyedGate: boolean;
    limiterElement: string | null;
    /** Sidechain `level` branch built (ducker with a sidechain wired). */
    duckerKey: boolean;
}

/** The two stage facts that decide the dynamics element AND its properties. */
export type DynStages = Pick<ChainStages, 'dynMode' | 'keyedGate'>;

export interface LiveTarget {
    element: string;
    prop: string;
    value: number | boolean;
}

/**
 * Dynamics element properties for the active mode (empty for none/ducker).
 *
 * Keyed off the RESOLVED stages, never off raw config: `sidechain-input=1` is a
 * property of `sc-gate-stereo` only, and that element is chosen by
 * `keyedGate` — `gateKey='sidechain'` with nothing wired to the pin falls back
 * to plain `gate-stereo`, which has no such port and warns about it.
 */
export function dynProps(stages: DynStages, config: Record<string, unknown>): string[] {
    const mode = stages.dynMode;
    if (mode === 'none' || mode === 'ducker') return [];
    const map = DYN_PROP_MAPS[mode];
    const props = Object.entries(map).map(
        ([key, { prop, convert }]) => `${prop}=${convert(cfg(config, key))}`,
    );
    // Downward expansion — the broadcast-useful direction (0 = upward).
    if (mode === 'expander') props.push('expander-mode=1');
    // External key on the ONE sc-* element we keep.
    if (mode === 'gate' && stages.keyedGate) props.push('sidechain-input=1');
    return props;
}

export function limiterProps(config: Record<string, unknown>): string[] {
    return Object.entries(LIMITER_PROP_MAP).map(
        ([key, { prop, convert }]) => `${prop}=${convert(cfg(config, key))}`,
    );
}

/**
 * Resolve one live config change to an element property write, or null when
 * the change has no element to drive (stage disabled, ducker params — the
 * envelope reads those straight off `this.config`, structural keys).
 */
export function resolveLiveTarget(
    key: string,
    value: unknown,
    stages: ChainStages,
): LiveTarget | null {
    if (key === 'hpfFreq') {
        return stages.hpf ? { element: 'hpf', prop: 'cutoff', value: hpfCutoff(value) } : null;
    }

    if (key.startsWith('eq')) {
        if (!stages.eqElement) return null;
        const write = resolveEqWrite(key, value);
        return write ? { element: 'eq', ...write } : null;
    }

    if (key.startsWith('limiter')) {
        const entry = LIMITER_PROP_MAP[key];
        if (!entry || !stages.limiterElement) return null;
        return { element: 'lim', prop: entry.prop, value: entry.convert(value) };
    }

    const mode = stages.dynMode;
    if (mode === 'none' || mode === 'ducker' || !stages.dynElement) return null;
    const entry = DYN_PROP_MAPS[mode][key];
    return entry ? { element: 'dyn', prop: entry.prop, value: entry.convert(value) } : null;
}

/** `eqMode` / `eqSlope` are single UI knobs that fan out to all six bands. */
export function resolveEqFanOut(key: string, value: unknown, stages: ChainStages): LiveTarget[] {
    if (!stages.eqElement) return [];
    return eqFanOutWrites(key, value).map((w) => ({ element: 'eq', ...w }));
}
