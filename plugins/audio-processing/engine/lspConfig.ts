/**
 * Shared config plumbing for the LSP chain: schema defaults, and the two
 * conversions every LSP control port needs.
 *
 * LADSPA carries no units and no enum nicks — every port is a bare float/int —
 * so both conversions live here and every port map runs through them:
 *   - **dB → linear**: LSP's `(G)`-suffixed ports (thresholds, knees, makeup,
 *     EQ band `gain-N`, EQ `input-gain`/`output-gain`) are gain FACTORS. The
 *     operator-facing schema is dB, as on the superseded audio-dynamics module.
 *   - **range clamping**: an out-of-range GObject property write is warned about
 *     and clamped by GObject anyway; clamping here keeps the launch string
 *     honest and the warnings out of the journal.
 */

const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** dB → LSP gain factor, clamped to the port's range and rounded for the
 *  launch string (6 dp — LSP ports are single-precision anyway). */
export const dbToLinear = (db: unknown, lo = 0.001, hi = 1000): number =>
    Number(clamp(10 ** (Number(db) / 20), lo, hi).toFixed(6));

/** Plain numeric port with a range (times, ratios, frequencies). */
export const clampNumber = (v: unknown, lo: number, hi: number): number =>
    Number(clamp(Number(v), lo, hi).toFixed(4));

/** Unranged read of a config value — anything non-numeric falls back. Distinct
 *  from `clampNumber`: the graph builders plot in real units and must not be
 *  pinned to a port's range, so they read through this instead. */
export const num = (v: unknown, fallback: number): number =>
    Number.isFinite(Number(v)) ? Number(v) : fallback;

/**
 * The dynamics modes backed by a LADSPA element. `none` and `ducker` are not:
 * `none` builds no stage at all, and the ducker runs on the native
 * `level`→`volume` control loop. Kept here rather than beside `DynamicsMode`
 * so the graph builders can test it without importing the pipeline module.
 */
export const LADSPA_DYN_MODES = ['compressor', 'gate', 'expander'] as const;

export type LadspaDynMode = (typeof LADSPA_DYN_MODES)[number];

/** True when `mode` selects a LADSPA dynamics element — i.e. there is a stage
 *  to resolve, meters to poll and a static transfer curve to draw. */
export const isLadspaDynMode = (mode: unknown): mode is LadspaDynMode =>
    LADSPA_DYN_MODES.includes(mode as LadspaDynMode);

export interface PropMap {
    prop: string;
    convert: (v: unknown) => number | boolean;
}

/**
 * Schema defaults for keys absent from config (fresh instances).
 *
 * This MIRRORS `mediaRouter.configSchema` in the plugin's package.json — the
 * manifest stays the source of truth for the UI, and `lspConfig.test.ts`
 * asserts the two agree, so drift fails CI instead of shipping a launch string
 * that disagrees with the sliders. Per-band `eqBand{N}{Field}` defaults are not
 * repeated here; they come from `EQ_BAND_FIELDS` in `eqBands.ts` (same test).
 */
export const DEFAULTS: Record<string, number | string | boolean> = {
    threshold: -35,
    duckDepth: -12,
    hold: 250,
    ratio: 8,
    attack: 5,
    release: 200,
    knee: -6,
    makeupGain: 0,
    gateDepth: -48,
    gateKey: 'self',
    hpfFreq: 80,
    eqBypass: false,
    eqInputGain: 0,
    eqOutputGain: 0,
    eqMode: 'rlc-bt',
    eqSlope: 'x1',
    limiterThreshold: -1,
    limiterAttack: 1,
    limiterRelease: 5,
    limiterLookahead: 5,
};

/** Config value with the schema default applied. */
export const cfg = (config: Record<string, unknown>, key: string): unknown =>
    config[key] ?? DEFAULTS[key];
