import { describe, it, expect } from 'vitest';
import {
    eqBandDefault,
    eqBandGain,
    eqBandKey,
    eqFanOutWrites,
    eqProps,
    resolveEqWrite,
    EQ_BANDS,
    EQ_BAND_FIELDS,
    EQ_TOTAL_BANDS,
} from './eqBands.js';

describe('eqBandGain', () => {
    it('EQ band gain is LINEAR, clamped to 0.01585…63.09575 (−36…+36 dB)', () => {
        expect(eqBandGain(0)).toBe(1);
        expect(eqBandGain(6)).toBe(1.995262);
        expect(eqBandGain(-6)).toBe(0.501187);
        expect(eqBandGain(-36)).toBe(0.01585); // clamped up off 0.0158489
        expect(eqBandGain(-99)).toBe(0.01585);
        expect(eqBandGain(99)).toBe(63.09575);
    });
});

describe('EQ_BAND_FIELDS — the one band-field table', () => {
    it('backs both the config key and the per-band default', () => {
        expect(eqBandKey(2, 'Gain')).toBe('eqBand2Gain');
        expect(eqBandDefault(0, 'Type')).toBe('off');
        expect(eqBandDefault(0, 'Freq')).toBe(80);
        expect(eqBandDefault(5, 'Freq')).toBe(12000);
        expect(eqBandDefault(99, 'Freq')).toBe(1000); // outside the UI band list
        expect(eqBandDefault(0, 'Gain')).toBe(0);
        expect(eqBandDefault(0, 'Q')).toBe(1);
    });

    it('is the same table the launch string and the live write both read', () => {
        // A drifted table would show up as one direction using a stale property
        // name, so pin the mapping itself.
        expect(Object.entries(EQ_BAND_FIELDS).map(([k, v]) => [k, v.prop])).toEqual([
            ['Type', 'filter-type'],
            ['Freq', 'frequency'],
            ['Gain', 'gain'],
            ['Q', 'quality-factor'],
        ]);
        for (const [field, spec] of Object.entries(EQ_BAND_FIELDS)) {
            const live = resolveEqWrite(eqBandKey(3, field as never), 6);
            expect(live).toEqual({ prop: `${spec.prop}-3`, value: spec.convert(6) });
            expect(eqProps({ [eqBandKey(3, field as never)]: 6 })).toContain(
                `${spec.prop}-3=${spec.convert(6)}`,
            );
        }
    });
});

describe('eqProps', () => {
    it('emits globals, the six UI bands, and parks bands 6–15 at type 0', () => {
        const props = eqProps({});
        expect(props).toContain('bypass=false');
        expect(props).toContain('input-gain=1');
        expect(props).toContain('output-gain=1');
        for (let i = 0; i < EQ_BANDS; i++) {
            expect(props).toContain(`filter-type-${i}=0`); // default: band off
            expect(props).toContain(`filter-mode-${i}=0`); // rlc-bt
            expect(props).toContain(`filter-slope-${i}=0`); // x1
            expect(props).toContain(`gain-${i}=1`); // 0 dB
        }
        for (let i = EQ_BANDS; i < EQ_TOTAL_BANDS; i++) {
            expect(props).toContain(`filter-type-${i}=0`);
        }
        expect(props.filter((p) => p.startsWith('filter-type-'))).toHaveLength(EQ_TOTAL_BANDS);
        // Default centre frequencies for a 6-band UI.
        expect(props).toContain('frequency-0=80');
        expect(props).toContain('frequency-5=12000');
    });

    it('maps band labels to LADSPA indices and dB gain to a linear factor', () => {
        const props = eqProps({
            eqBand0Type: 'hipass',
            eqBand1Type: 'bell',
            eqBand1Freq: 1000,
            eqBand1Gain: 6,
            eqBand1Q: 2.5,
            eqBand5Type: 'hishelf',
            eqMode: 'bwc-bt',
            eqSlope: 'x4',
            eqBypass: true,
            eqInputGain: -6,
            eqOutputGain: 6,
        });
        expect(props).toContain('filter-type-0=2'); // hipass
        expect(props).toContain('filter-type-1=1'); // bell
        expect(props).toContain('filter-type-5=3'); // hishelf
        expect(props).toContain('frequency-1=1000');
        expect(props).toContain('gain-1=1.995262'); // +6 dB, LINEAR
        expect(props).toContain('quality-factor-1=2.5');
        expect(props).toContain('filter-mode-1=2'); // bwc-bt, fanned to every band
        expect(props).toContain('filter-slope-1=3'); // x4
        expect(props).toContain('bypass=true');
        expect(props).toContain('input-gain=0.501187');
        expect(props).toContain('output-gain=1.995262');
    });

    it('clamps out-of-range band values to the LSP port ranges', () => {
        const props = eqProps({ eqBand0Freq: 99999, eqBand0Q: 500, eqBand0Type: 'nonsense' });
        expect(props).toContain('frequency-0=24000');
        expect(props).toContain('quality-factor-0=100');
        expect(props).toContain('filter-type-0=0'); // unknown label → off
    });
});

describe('resolveEqWrite', () => {
    it('routes band knobs to the indexed properties', () => {
        expect(resolveEqWrite('eqBand2Gain', 6)).toEqual({ prop: 'gain-2', value: 1.995262 });
        expect(resolveEqWrite('eqBand2Freq', 1000)).toEqual({ prop: 'frequency-2', value: 1000 });
        expect(resolveEqWrite('eqBand3Type', 'notch')).toEqual({
            prop: 'filter-type-3',
            value: 6,
        });
    });

    it('routes the globals, and refuses bands outside the 6-band UI', () => {
        expect(resolveEqWrite('eqBypass', true)).toEqual({ prop: 'bypass', value: true });
        expect(resolveEqWrite('eqInputGain', -6)).toEqual({
            prop: 'input-gain',
            value: 0.501187,
        });
        expect(resolveEqWrite('eqOutputGain', 6)).toEqual({
            prop: 'output-gain',
            value: 1.995262,
        });
        expect(resolveEqWrite('eqBand9Gain', 6)).toBeNull();
        expect(resolveEqWrite('eqMode', 'lrx-mt')).toBeNull(); // fan-out, not a write
        expect(resolveEqWrite('ratio', 4)).toBeNull();
    });
});

describe('eqFanOutWrites', () => {
    it('one mode/slope knob writes all six bands', () => {
        const modes = eqFanOutWrites('eqMode', 'lrx-mt');
        expect(modes).toHaveLength(EQ_BANDS);
        expect(modes[0]).toEqual({ prop: 'filter-mode-0', value: 5 });
        expect(modes[5]).toEqual({ prop: 'filter-mode-5', value: 5 });

        expect(eqFanOutWrites('eqSlope', 'x3').map((w) => w.value)).toEqual([2, 2, 2, 2, 2, 2]);
        // Unknown labels fall back to index 0 rather than writing junk.
        expect(eqFanOutWrites('eqMode', 'nonsense')[0].value).toBe(0);
    });

    it('is empty for unrelated keys', () => {
        expect(eqFanOutWrites('ratio', 4)).toEqual([]);
    });
});
