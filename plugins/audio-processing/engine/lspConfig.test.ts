import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cfg,
    clampNumber,
    dbToLinear,
    isLadspaDynMode,
    num,
    DEFAULTS,
    LADSPA_DYN_MODES,
} from './lspConfig.js';
import { eqBandDefault, EQ_BANDS, type EqBandField } from './eqBands.js';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    mediaRouter: {
        configSchema: {
            properties: Record<string, { default?: unknown; 'x-widget'?: string }>;
        };
    };
};
const schema = manifest.mediaRouter.configSchema.properties;

/** Virtual UI-only props (the `graph` widgets). They carry no value, never
 *  reach an element, and the manager-ui form strips them from the saved
 *  settings — so they are not mirrored in DEFAULTS either. */
const DISPLAY_WIDGETS = new Set(['graph']);
const isDisplayOnly = (key: string): boolean => DISPLAY_WIDGETS.has(schema[key]['x-widget'] ?? '');

describe('dB → linear conversion', () => {
    it('converts and clamps to the LSP port range', () => {
        expect(dbToLinear(0)).toBe(1);
        expect(dbToLinear(-20)).toBe(0.1);
        expect(dbToLinear(6, 0.001, 1000)).toBe(1.995262);
        // Clamped at both ends of the port's declared range.
        expect(dbToLinear(-60, 0.001, 1)).toBe(0.001);
        expect(dbToLinear(12, 0.001, 1)).toBe(1);
    });

    it('a non-numeric value lands on the port floor, never NaN', () => {
        expect(dbToLinear(undefined, 0.001, 1)).toBe(0.001);
        expect(clampNumber('nonsense', 1, 100)).toBe(1);
    });
});

describe('clampNumber', () => {
    it('clamps to the port range and rounds for the launch string', () => {
        expect(clampNumber(1000, 10, 24000)).toBe(1000);
        expect(clampNumber(99999, 10, 24000)).toBe(24000);
        expect(clampNumber(-5, 0, 100)).toBe(0);
        expect(clampNumber(2.123456789, 0, 100)).toBe(2.1235);
    });
});

describe('num', () => {
    it('reads a value unranged, falling back on anything non-numeric', () => {
        // Deliberately NOT clampNumber: the graph builders plot in real units
        // and must not be pinned to a port's range.
        expect(num(1e9, 0)).toBe(1e9);
        expect(num('-12.5', 0)).toBe(-12.5);
        expect(num(0, -35)).toBe(0);
        expect(num(undefined, -35)).toBe(-35);
        expect(num('nonsense', -35)).toBe(-35);
        expect(num(NaN, -35)).toBe(-35);
    });
});

describe('isLadspaDynMode', () => {
    it('is true for exactly the three LADSPA-backed dynamics modes', () => {
        expect(LADSPA_DYN_MODES).toEqual(['compressor', 'gate', 'expander']);
        for (const mode of LADSPA_DYN_MODES) expect(isLadspaDynMode(mode)).toBe(true);
    });

    it('is false for the modes that build no LSP element', () => {
        // `none` builds no stage; the ducker runs on the native level→volume
        // loop, so neither has an element to resolve or meters to poll.
        expect(isLadspaDynMode('none')).toBe(false);
        expect(isLadspaDynMode('ducker')).toBe(false);
        expect(isLadspaDynMode(undefined)).toBe(false);
        expect(isLadspaDynMode('Compressor')).toBe(false);
    });
});

describe('cfg', () => {
    it('falls back to the schema default only when the key is absent', () => {
        expect(cfg({}, 'threshold')).toBe(-35);
        expect(cfg({ threshold: -20 }, 'threshold')).toBe(-20);
        expect(cfg({ makeupGain: 0 }, 'makeupGain')).toBe(0); // 0 is not absent
        expect(cfg({}, 'notAKnob')).toBeUndefined();
    });
});

describe('DEFAULTS mirrors the manifest configSchema', () => {
    // The manifest drives the UI, DEFAULTS drives the launch string. If they
    // drift, a fresh instance renders one value on the slider and applies
    // another to the element — so make the drift fail here instead.
    it('every DEFAULTS key matches its schema default', () => {
        for (const [key, value] of Object.entries(DEFAULTS)) {
            expect(schema[key], `${key} exists in configSchema`).toBeDefined();
            expect(schema[key].default, `${key} default`).toBe(value);
        }
    });

    it('per-band defaults match the schema too', () => {
        for (let i = 0; i < EQ_BANDS; i++) {
            for (const field of ['Type', 'Freq', 'Gain', 'Q'] as EqBandField[]) {
                const key = `eqBand${i}${field}`;
                expect(schema[key], `${key} exists in configSchema`).toBeDefined();
                expect(schema[key].default, `${key} default`).toBe(eqBandDefault(i, field));
            }
        }
    });

    it('covers every live-tunable schema key that reaches an element', () => {
        // Structural keys (mode, the per-stage enables, mixLatencyMs, the
        // 302M word length) are read directly off config with their own
        // fallbacks and are not mirrored.
        const structural = new Set([
            'mode',
            'hpfEnabled',
            'eqEnabled',
            'limiterEnabled',
            'mixLatencyMs',
            'pcmBitDepth',
        ]);
        const missing = Object.keys(schema).filter(
            (k) =>
                !structural.has(k) &&
                !isDisplayOnly(k) &&
                !/^eqBand\d+/.test(k) &&
                !(k in DEFAULTS),
        );
        expect(missing).toEqual([]);
    });
});
