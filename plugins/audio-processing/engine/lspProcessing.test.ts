import { describe, it, expect } from 'vitest';
import {
    dynProps,
    hpfCutoff,
    limiterProps,
    resolveEqFanOut,
    resolveLiveTarget,
    type ChainStages,
} from './lspProcessing.js';
import { EQ_BANDS } from './eqBands.js';

const stages = (over: Partial<ChainStages> = {}): ChainStages => ({
    hpf: false,
    eqElement: null,
    dynElement: null,
    dynMode: 'none',
    keyedGate: false,
    limiterElement: null,
    duckerKey: false,
    ...over,
});

describe('dynProps', () => {
    it('none / ducker use no LADSPA element at all', () => {
        expect(dynProps({ dynMode: 'none', keyedGate: false }, {})).toEqual([]);
        expect(dynProps({ dynMode: 'ducker', keyedGate: false }, { threshold: -20 })).toEqual([]);
    });

    it('compressor maps the ported knobs onto compressor-stereo ports', () => {
        const props = dynProps(
            { dynMode: 'compressor', keyedGate: false },
            { threshold: -35, ratio: 8, makeupGain: 6 },
        );
        expect(props).toContain('attack-threshold=0.017783'); // -35 dB
        expect(props).toContain('ratio=8');
        expect(props).toContain('attack-time=5');
        expect(props).toContain('release-time=200');
        expect(props).toContain('knee=0.501187'); // -6 dB default
        expect(props).toContain('makeup-gain=1.995262');
        expect(props).not.toContain('sidechain-input=1');
    });

    it('gate uses the gate port names, and only asks for a key when told to', () => {
        const self = dynProps(
            { dynMode: 'gate', keyedGate: false },
            { threshold: -60, gateDepth: -48 },
        );
        expect(self).toContain('curve-threshold=0.001');
        expect(self).toContain('reduction=0.003981');
        expect(self).toContain('attack=5');
        expect(self).toContain('release=200');
        expect(self.some((p) => p.startsWith('sidechain-input'))).toBe(false);

        const keyed = dynProps({ dynMode: 'gate', keyedGate: true }, { gateKey: 'sidechain' });
        expect(keyed).toContain('sidechain-input=1');
    });

    it('NEVER emits sidechain-input for gateKey=sidechain with no key wired', () => {
        // The element picked in that state is plain `gate-stereo`, which has no
        // `sidechain-input` port — emitting it off raw config produced a "no
        // property" warning on every start. The prop follows the ELEMENT
        // choice (`keyedGate`), never the operator's raw config key.
        const props = dynProps(
            { dynMode: 'gate', keyedGate: false },
            { gateKey: 'sidechain', threshold: -40 },
        );
        expect(props.some((p) => p.startsWith('sidechain-input'))).toBe(false);
        expect(props).toContain('curve-threshold=0.01');
    });

    it('expander runs downward', () => {
        expect(dynProps({ dynMode: 'expander', keyedGate: false }, {})).toContain(
            'expander-mode=1',
        );
    });
});

describe('limiterProps', () => {
    it('emits a clamped threshold + timings', () => {
        expect(limiterProps({})).toEqual([
            'threshold=0.891251', // -1 dB
            'attack-time=1',
            'release-time=5',
            'lookahead=5',
        ]);
        expect(limiterProps({ limiterThreshold: -60, limiterLookahead: 99 })).toContain(
            'threshold=0.003981', // clamped to the port floor
        );
    });
});

describe('hpfCutoff', () => {
    it('clamps to the schema range (20–500 Hz), not a wider one', () => {
        expect(hpfCutoff(120)).toBe(120);
        expect(hpfCutoff(10)).toBe(20);
        expect(hpfCutoff(2000)).toBe(500);
    });
});

describe('resolveLiveTarget', () => {
    it('routes EQ band knobs to the indexed properties', () => {
        const s = stages({ eqElement: 'ladspa-eq' });
        expect(resolveLiveTarget('eqBand2Gain', 6, s)).toEqual({
            element: 'eq',
            prop: 'gain-2',
            value: 1.995262,
        });
        expect(resolveLiveTarget('eqBand2Freq', 1000, s)).toEqual({
            element: 'eq',
            prop: 'frequency-2',
            value: 1000,
        });
        expect(resolveLiveTarget('eqBand3Type', 'notch', s)).toEqual({
            element: 'eq',
            prop: 'filter-type-3',
            value: 6,
        });
        expect(resolveLiveTarget('eqBypass', true, s)).toEqual({
            element: 'eq',
            prop: 'bypass',
            value: true,
        });
    });

    it('never addresses an element the chain does not contain', () => {
        const none = stages();
        expect(resolveLiveTarget('eqBand0Gain', 6, none)).toBeNull();
        expect(resolveLiveTarget('hpfFreq', 100, none)).toBeNull();
        expect(resolveLiveTarget('limiterThreshold', -3, none)).toBeNull();
        expect(resolveLiveTarget('threshold', -20, none)).toBeNull();
        // Out-of-UI band indices are refused even with the EQ present.
        expect(resolveLiveTarget('eqBand9Gain', 6, stages({ eqElement: 'eq-el' }))).toBeNull();
    });

    it('resolves the shared dynamics knobs against the ACTIVE mode', () => {
        const comp = stages({ dynElement: 'comp-el', dynMode: 'compressor' });
        expect(resolveLiveTarget('attack', 12, comp)).toEqual({
            element: 'dyn',
            prop: 'attack-time',
            value: 12,
        });
        const gate = stages({ dynElement: 'gate-el', dynMode: 'gate' });
        expect(resolveLiveTarget('attack', 12, gate)).toEqual({
            element: 'dyn',
            prop: 'attack',
            value: 12,
        });
        expect(resolveLiveTarget('threshold', -20, gate)).toEqual({
            element: 'dyn',
            prop: 'curve-threshold',
            value: 0.1,
        });
    });

    it('ducker knobs drive no element — the envelope reads them from config', () => {
        const duck = stages({ dynMode: 'ducker', duckerKey: true });
        expect(resolveLiveTarget('threshold', -20, duck)).toBeNull();
        expect(resolveLiveTarget('duckDepth', -18, duck)).toBeNull();
        expect(resolveLiveTarget('hold', 500, duck)).toBeNull();
    });

    it('hpf and limiter knobs reach their own elements', () => {
        expect(resolveLiveTarget('hpfFreq', 120, stages({ hpf: true }))).toEqual({
            element: 'hpf',
            prop: 'cutoff',
            value: 120,
        });
        // …clamped to the schema range, so a rogue patch can't drive the filter
        // somewhere the slider can never reach.
        expect(resolveLiveTarget('hpfFreq', 5000, stages({ hpf: true }))?.value).toBe(500);
        expect(
            resolveLiveTarget('limiterLookahead', 2, stages({ limiterElement: 'lim-el' })),
        ).toEqual({ element: 'lim', prop: 'lookahead', value: 2 });
    });
});

describe('resolveEqFanOut', () => {
    it('one mode/slope knob writes all six bands', () => {
        const s = stages({ eqElement: 'eq-el' });
        const modes = resolveEqFanOut('eqMode', 'lrx-mt', s);
        expect(modes).toHaveLength(EQ_BANDS);
        expect(modes[0]).toEqual({ element: 'eq', prop: 'filter-mode-0', value: 5 });
        expect(modes[5]).toEqual({ element: 'eq', prop: 'filter-mode-5', value: 5 });

        const slopes = resolveEqFanOut('eqSlope', 'x3', s);
        expect(slopes.map((t) => t.value)).toEqual([2, 2, 2, 2, 2, 2]);
    });

    it('is empty without an EQ, and for unrelated keys', () => {
        expect(resolveEqFanOut('eqMode', 'lrx-mt', stages())).toEqual([]);
        expect(resolveEqFanOut('ratio', 4, stages({ eqElement: 'eq-el' }))).toEqual([]);
    });
});
