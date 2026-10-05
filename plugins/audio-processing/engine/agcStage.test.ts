import { describe, it, expect } from 'vitest';
import {
    AGC_AMOUNT_DB,
    AGC_SPEED_PRESETS,
    AGC_SPEEDS,
    agcProps,
    resolveAgcWrites,
    speedWrites,
} from './agcStage.js';
import { stages } from './chainStages.fixture.js';

describe('speed presets', () => {
    it('every preset slew uses a dB step the element actually offers', () => {
        // The amount ports are indices; a dB value missing from the list
        // would silently become index -1 (clamped to 0.1 dB by GObject).
        for (const speed of AGC_SPEEDS) {
            const p = AGC_SPEED_PRESETS[speed];
            for (const slew of [p.longGrow, p.longFall, p.shortFall]) {
                expect(AGC_AMOUNT_DB, `${speed} ${slew.db} dB`).toContain(slew.db);
            }
            // Port ranges from gst-inspect: long 10–10000 ms, short fall 0.1–40 ms.
            expect(p.longGrow.ms).toBeGreaterThanOrEqual(10);
            expect(p.longFall.ms).toBeGreaterThanOrEqual(10);
            expect(p.shortFall.ms).toBeLessThanOrEqual(40);
        }
    });

    it('writes the six slew ports as indices + ms', () => {
        expect(speedWrites('medium')).toEqual([
            { prop: 'long-gain-grow-amount', value: 4 }, // 6 dB
            { prop: 'long-gain-grow-time', value: 1000 },
            { prop: 'long-gain-fall-amount', value: 4 }, // 6 dB
            { prop: 'long-gain-fall-time', value: 300 },
            { prop: 'short-gain-fall-amount', value: 7 }, // 12 dB
            { prop: 'short-gain-fall-time', value: 10 },
        ]);
        expect(speedWrites('fast').find((w) => w.prop === 'long-gain-grow-time')?.value).toBe(500);
    });

    it('an unknown speed falls back to medium, never to the element defaults', () => {
        expect(speedWrites('turbo')).toEqual(speedWrites('medium'));
        expect(speedWrites(undefined)).toEqual(speedWrites('medium'));
    });
});

describe('agcProps', () => {
    it('emits the schema defaults, the medium slews and the fixed internals', () => {
        const props = agcProps({});
        expect(props).toContain('the-level-of-silence=-60');
        expect(props).toContain('desired-loudness-level=-23');
        expect(props).toContain('the-maximum-amplification-gain=24');
        expect(props).toContain('long-gain-grow-amount=4');
        expect(props).toContain('long-gain-grow-time=1000');
        expect(props).toContain('short-gain-fall-time=10');
        expect(props).toContain('weighting-function=5'); // K-weighted
        expect(props).toContain('enable-maximum-amplification-gain-limitation=true');
        expect(props).toContain('enable-quick-amplifier=false');
        expect(props).toContain('sidechain-lookahead=0');
        expect(props).toContain('gain-correction-metering=true');
        expect(props).toContain('loudness-measuring-long-period=400');
        expect(props).toContain('loudness-measuring-short-period=20');
        expect(props.some((p) => p.startsWith('output-metering'))).toBe(false); // nothing reads it
    });

    it('clamps the level knobs to the element ranges', () => {
        const props = agcProps({ agcKickIn: -20, agcTarget: 5, agcMaxGain: 200 });
        expect(props).toContain('the-level-of-silence=-36');
        expect(props).toContain('desired-loudness-level=0');
        expect(props).toContain('the-maximum-amplification-gain=108');
    });
});

describe('resolveAgcWrites', () => {
    const built = stages({ agcElement: 'ladspa-agc' });

    it('maps the level knobs onto the running element', () => {
        expect(resolveAgcWrites('agcTarget', -20, built)).toEqual([
            { element: 'agc', prop: 'desired-loudness-level', value: -20 },
        ]);
        expect(resolveAgcWrites('agcKickIn', -55, built)).toEqual([
            { element: 'agc', prop: 'the-level-of-silence', value: -55 },
        ]);
    });

    it('fans a speed change out to all six slew ports', () => {
        const writes = resolveAgcWrites('agcSpeed', 'fast', built);
        expect(writes).toHaveLength(6);
        expect(writes.every((w) => w.element === 'agc')).toBe(true);
        expect(writes).toContainEqual({ element: 'agc', prop: 'long-gain-fall-time', value: 200 });
    });

    it('writes nothing for a stage that is not built, or for a non-agc key', () => {
        expect(resolveAgcWrites('agcTarget', -20, stages())).toEqual([]);
        expect(resolveAgcWrites('threshold', -20, built)).toEqual([]);
        expect(resolveAgcWrites('agcEnabled', true, built)).toEqual([]); // structural
    });
});
