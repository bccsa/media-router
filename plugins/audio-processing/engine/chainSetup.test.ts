import { describe, it, expect, vi } from 'vitest';
import {
    chainSummary,
    partitionBusSources,
    resolveChainStages,
    LIVE_PARAMS,
    PROGRAM_PORT,
    SIDECHAIN_PORT,
} from './chainSetup.js';
import type { ChainStages } from './lspProcessing.js';

const src = (sinkPortId: string, n = 0) => ({
    port: 40100 + n,
    connectionId: `c-${n}`,
    sinkPortId,
});

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

/** Resolver double — records what the chain asked for. */
const resolver = () => {
    const asked: string[] = [];
    return {
        asked,
        require: async (suffix: string) => {
            asked.push(suffix);
            return `ladspa-lsp-test-${suffix}`;
        },
    };
};

describe('partitionBusSources', () => {
    it('buckets each edge by sink pin, and drops edges on unknown pins', () => {
        const program = src(PROGRAM_PORT, 0);
        const key = src(SIDECHAIN_PORT, 1);
        const stray = src('not-a-pin', 2);
        const { program: p, sidechain: s } = partitionBusSources([program, key, stray]);
        expect(p).toEqual([program]);
        expect(s).toEqual([key]);
    });

    it('is empty for no edges at all', () => {
        expect(partitionBusSources([])).toEqual({ program: [], sidechain: [] });
    });
});

describe('LIVE_PARAMS', () => {
    it('covers all six EQ bands and excludes gateKey (it selects an ELEMENT)', () => {
        expect(LIVE_PARAMS).toContain('eqBand0Type');
        expect(LIVE_PARAMS).toContain('eqBand5Q');
        expect(LIVE_PARAMS).not.toContain('eqBand6Type');
        expect(LIVE_PARAMS).not.toContain('gateKey');
        expect(LIVE_PARAMS).not.toContain('mode');
        expect(new Set(LIVE_PARAMS).size).toBe(LIVE_PARAMS.length); // no duplicates
    });
});

describe('resolveChainStages', () => {
    it('resolves only the elements the enabled stages need', async () => {
        const r = resolver();
        const s = await resolveChainStages({}, 'none', false, r.require);
        expect(r.asked).toEqual([]);
        expect(s).toEqual(stages());

        const full = resolver();
        await resolveChainStages(
            { eqEnabled: true, limiterEnabled: true, hpfEnabled: true },
            'compressor',
            false,
            full.require,
        );
        expect(full.asked).toEqual([
            'para-equalizer-x16-stereo',
            'compressor-stereo',
            'limiter-stereo',
        ]);
    });

    it('picks sc-gate-stereo ONLY when the key is both asked for and wired', async () => {
        const keyed = resolver();
        const s = await resolveChainStages({ gateKey: 'sidechain' }, 'gate', true, keyed.require);
        expect(keyed.asked).toEqual(['sc-gate-stereo']);
        expect(s.keyedGate).toBe(true);

        // Same config, nothing wired to the pin → self-keyed fallback, and
        // `keyedGate` false so no `sidechain-input` is ever emitted for it.
        const dark = resolver();
        const d = await resolveChainStages({ gateKey: 'sidechain' }, 'gate', false, dark.require);
        expect(dark.asked).toEqual(['gate-stereo']);
        expect(d.keyedGate).toBe(false);
    });

    it('the ducker needs no LADSPA element at all', async () => {
        const r = resolver();
        const s = await resolveChainStages({}, 'ducker', true, r.require);
        expect(r.asked).toEqual([]);
        expect(s.duckerKey).toBe(true);
        expect(s.dynElement).toBeNull();
    });

    it('propagates the resolver refusal for an enabled stage', async () => {
        const boom = vi.fn(async () => {
            throw new Error('install lsp-plugins-ladspa');
        });
        await expect(resolveChainStages({ eqEnabled: true }, 'none', false, boom)).rejects.toThrow(
            /lsp-plugins-ladspa/,
        );
    });
});

describe('chainSummary', () => {
    it('lists the enabled stages in chain order', () => {
        const { data, health } = chainSummary(
            stages({
                hpf: true,
                eqElement: 'eq-el',
                dynElement: 'comp-el',
                dynMode: 'compressor',
                limiterElement: 'lim-el',
            }),
            'self',
            0,
        );
        expect(data).toEqual({
            chain: 'HPF → EQ → compressor → limiter',
            sidechain: 'not connected',
        });
        expect(health).toEqual({ level: 'ok' });
    });

    it('says so when nothing is enabled', () => {
        expect(chainSummary(stages(), 'self', 0).data.chain).toBe('bypass (no stages enabled)');
    });

    it('warns when a key-hungry mode has no sidechain wired', () => {
        for (const [mode, gateKey, word] of [
            ['ducker', 'self', 'Ducker'],
            ['gate', 'sidechain', 'Sidechain gate'],
        ] as const) {
            const { health } = chainSummary(stages({ dynMode: mode }), gateKey, 0);
            expect(health.level).toBe('warning');
            expect(health.message).toContain(word);
            expect(health.message).toContain('no sidechain source');
        }
    });

    it('warns about the mirror case: a key wired that nothing consumes', () => {
        const { data, health } = chainSummary(stages({ dynMode: 'none' }), 'self', 1);
        expect(data.sidechain).toBe('1 source(s) — unused by none mode');
        expect(health.level).toBe('warning');
        expect(health.message).toContain('nothing keys off it');
    });

    it('is healthy when the key is wired AND consumed', () => {
        const { data, health } = chainSummary(
            stages({ dynMode: 'ducker', duckerKey: true }),
            'self',
            2,
        );
        expect(data.sidechain).toBe('2 source(s)');
        expect(health).toEqual({ level: 'ok' });
    });
});
