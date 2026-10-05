import { describe, it, expect } from 'vitest';
import { stages } from './chainStages.fixture.js';
import { resolveLiveWrites } from './liveWrites.js';

describe('resolveLiveWrites', () => {
    const built = stages({
        hpf: true,
        agcElement: 'agc-el',
        eqElement: 'eq-el',
        dynElement: 'comp-el',
        dynMode: 'compressor',
    });

    it('routes each key to the stage that owns it', () => {
        expect(resolveLiveWrites('threshold', -20, built)).toEqual([
            { element: 'dyn', prop: 'attack-threshold', value: 0.1 },
        ]);
        expect(resolveLiveWrites('agcTarget', -20, built)).toEqual([
            { element: 'agc', prop: 'desired-loudness-level', value: -20 },
        ]);
        expect(resolveLiveWrites('hpfFreq', 120, built)).toEqual([
            { element: 'hpf', prop: 'cutoff', value: 120 },
        ]);
    });

    it('fans the multi-port knobs out', () => {
        expect(resolveLiveWrites('agcSpeed', 'fast', built)).toHaveLength(6);
        expect(resolveLiveWrites('eqSlope', 'x2', built).length).toBeGreaterThan(1);
    });

    it('writes nothing for a key no built stage owns', () => {
        expect(resolveLiveWrites('agcTarget', -20, stages())).toEqual([]);
        expect(resolveLiveWrites('duckDepth', -12, built)).toEqual([]); // envelope reads config
        expect(resolveLiveWrites('mode', 'gate', built)).toEqual([]); // structural
    });
});
