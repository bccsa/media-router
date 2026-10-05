/**
 * Auto gain stage — LSP Autogain (BS.1770 loudness AGC), pure mapping, no gst.
 * Gain only rises while the input is above the kick-in level, so pauses are
 * never pumped up; the max-gain cap bounds how far a quiet mic is lifted.
 */

import { cfg, clampNumber, launchProps, type PropMap, type PropWrite } from './lspConfig.js';
import type { ChainStages, LiveTarget } from './lspProcessing.js';

export const AGC_SUFFIX = 'autogain-stereo';
export const AGC_ELEMENT = 'agc';

/** The `*-gain-{grow,fall}-amount` ports are an INDEX into this dB list
 *  (verified gst-inspect, lsp-plugins-ladspa 1.2.33), not a dB value. */
export const AGC_AMOUNT_DB = [0.1, 0.5, 1, 3, 6, 9, 10, 12, 15, 18, 20, 21, 24] as const;
type AmountDb = (typeof AGC_AMOUNT_DB)[number];

export const AGC_SPEEDS = ['slow', 'medium', 'fast'] as const;
export type AgcSpeed = (typeof AGC_SPEEDS)[number];
export const isAgcSpeed = (v: unknown): v is AgcSpeed => AGC_SPEEDS.includes(v as AgcSpeed);

/** A slew: `db` of gain change per `ms`. */
interface Slew {
    db: AmountDb;
    ms: number;
}

/** Long = the leveller (speech), short = the peak catcher. Short grow is the
 *  "quick amplifier", kept off: lifting fast on a pause pumps room noise. */
export const AGC_SPEED_PRESETS: Record<
    AgcSpeed,
    { longGrow: Slew; longFall: Slew; shortFall: Slew }
> = {
    slow: {
        longGrow: { db: 3, ms: 1000 },
        longFall: { db: 6, ms: 500 },
        shortFall: { db: 12, ms: 20 },
    },
    medium: {
        longGrow: { db: 6, ms: 1000 },
        longFall: { db: 6, ms: 300 },
        shortFall: { db: 12, ms: 10 },
    },
    fast: {
        longGrow: { db: 6, ms: 500 },
        longFall: { db: 9, ms: 200 },
        shortFall: { db: 15, ms: 5 },
    },
};

const amountIndex = (db: AmountDb): number => AGC_AMOUNT_DB.indexOf(db);

/** Config key → level port. LUFS/dB ports take the value as is; clamps are
 *  the element's declared ranges. */
export const AGC_PROP_MAP: Record<string, PropMap> = {
    agcKickIn: { prop: 'the-level-of-silence', convert: (v) => clampNumber(v, -84, -36) },
    agcTarget: { prop: 'desired-loudness-level', convert: (v) => clampNumber(v, -60, 0) },
    agcMaxGain: {
        prop: 'the-maximum-amplification-gain',
        convert: (v) => clampNumber(v, 0, 108),
    },
};

/** Fixed internals: K-weighting over the BS.1770 400 ms window, cap enabled,
 *  no lookahead (zero latency), and only the two meters the poll reads. */
const AGC_FIXED_PROPS = [
    'weighting-function=5',
    'level-drift=12',
    'loudness-measuring-long-period=400',
    'loudness-measuring-short-period=20',
    'sidechain-lookahead=0',
    'enable-quick-amplifier=false',
    'enable-maximum-amplification-gain-limitation=true',
    'gain-correction-metering=true',
    'input-metering-enable-for-long-period=true',
];

/** The six slew ports for a speed preset; an unknown speed reads as medium. */
export function speedWrites(speed: unknown): PropWrite[] {
    const p = AGC_SPEED_PRESETS[isAgcSpeed(speed) ? speed : 'medium'];
    return [
        { prop: 'long-gain-grow-amount', value: amountIndex(p.longGrow.db) },
        { prop: 'long-gain-grow-time', value: p.longGrow.ms },
        { prop: 'long-gain-fall-amount', value: amountIndex(p.longFall.db) },
        { prop: 'long-gain-fall-time', value: p.longFall.ms },
        { prop: 'short-gain-fall-amount', value: amountIndex(p.shortFall.db) },
        { prop: 'short-gain-fall-time', value: p.shortFall.ms },
    ];
}

/** Launch-string properties for the autogain element. */
export function agcProps(config: Record<string, unknown>): string[] {
    const speed = speedWrites(cfg(config, 'agcSpeed')).map((w) => `${w.prop}=${w.value}`);
    return [...launchProps(AGC_PROP_MAP, config), ...speed, ...AGC_FIXED_PROPS];
}

/** Live writes for one `agc*` config key; empty when the stage is not built. */
export function resolveAgcWrites(key: string, value: unknown, stages: ChainStages): LiveTarget[] {
    if (!stages.agcElement || !key.startsWith('agc')) return [];
    if (key === 'agcSpeed') return speedWrites(value).map((w) => ({ element: AGC_ELEMENT, ...w }));
    const entry = AGC_PROP_MAP[key];
    return entry ? [{ element: AGC_ELEMENT, prop: entry.prop, value: entry.convert(value) }] : [];
}
