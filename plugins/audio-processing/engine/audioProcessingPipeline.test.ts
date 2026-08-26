import { describe, it, expect } from 'vitest';
import type { AudioMixSource } from '@media-router/plugin-audio-302m-core';
import { buildProcessingPipeline } from './audioProcessingPipeline.js';
import type { ChainStages } from './lspProcessing.js';

const EQ_EL = 'ladspa-lsp-test-para-equalizer-x16-stereo';
const COMP_EL = 'ladspa-lsp-test-compressor-stereo';
const GATE_EL = 'ladspa-lsp-test-gate-stereo';
const SC_GATE_EL = 'ladspa-lsp-test-sc-gate-stereo';
const LIM_EL = 'ladspa-lsp-test-limiter-stereo';

function mkSource(n = 0): AudioMixSource {
    return {
        port: 40100 + n,
        connectionId: `c-${n}`,
        socketPath: `/tmp/mr-bus-${40100 + n}-abcdef.sock`,
    };
}

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

function build(
    over: Partial<ChainStages> = {},
    config: Record<string, unknown> = {},
    sidechain: AudioMixSource[] = [],
) {
    return buildProcessingPipeline({
        programSources: [mkSource(0)],
        sidechainSources: sidechain,
        outputPort: 40200,
        latencyMs: 200,
        config,
        stages: stages(over),
    });
}

/** Pair every bus source socket in a pipeline with the fan-in it feeds —
 *  each branch runs from its `unixfdsrc` to its named terminal element.
 *  Single-source (direct-branch) fan-ins only; a mixer arm ends its branches
 *  at `! <mixer>.` instead. */
function branchOwners(pipeline: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, socket, mixer] of pipeline.matchAll(/socket-path=(\S+)[\s\S]*?name=(\w+)_out/g)) {
        out[socket] = mixer;
    }
    return out;
}

describe('buildProcessingPipeline', () => {
    it('returns null without a program source', () => {
        expect(
            buildProcessingPipeline({
                programSources: [],
                sidechainSources: [mkSource(1)],
                outputPort: 40200,
                latencyMs: 200,
                config: {},
                stages: stages(),
            }),
        ).toBeNull();
    });

    it('bare chain: 302M decode in, fader + VU, 302M encode out — no PipeWire', () => {
        const result = build()!;
        // One program source → direct branch: no aggregator, no 200 ms mix
        // latency, no pacer (nothing can free-run without force-live).
        expect(result.pipeline).not.toContain('audiomixer');
        expect(result.pipeline).not.toContain('latency=200000000');
        expect(result.pipeline).toContain(
            'capsfilter name=progmix_out caps="audio/x-raw,rate=48000,channels=2"',
        );
        expect(result.pipeline).toContain('avdec_s302m');
        expect(result.pipeline).toContain('socket-path=/tmp/mr-bus-40100-abcdef.sock');
        expect(result.pipeline).toContain(
            'progmix_out. ! audioconvert ! volume name=duckvol volume=1',
        );
        expect(result.pipeline).toContain('level name=outlevel post-messages=true');
        expect(result.pipeline).toContain('avenc_s302m strict=experimental');
        expect(result.pipeline).toContain('tee name=busout_40200 allow-not-linked=true');
        expect(result.sinkName).toBe('busout_40200');
        expect(result.busReports).toBeUndefined();
        expect(result.pipeline).not.toContain('pulsesrc');
        expect(result.pipeline).not.toContain('pulsesink');
        expect(result.pipeline).not.toContain('ladspa');
        expect(result.pipeline).not.toContain('scmix');
    });

    it('sums several sources wired to the program pin', () => {
        const result = buildProcessingPipeline({
            programSources: [mkSource(0), mkSource(1), mkSource(2)],
            sidechainSources: [],
            outputPort: 40200,
            latencyMs: 500,
            config: {},
            stages: stages(),
        })!;
        expect(result.pipeline.match(/! progmix\./g)).toHaveLength(3);
        expect(result.pipeline).toContain('audiomixer name=progmix force-live=true');
        expect(result.pipeline).toContain('latency=500000000');
        // The force-live mixer is clock-paced: without this it free-runs once
        // every input has gone EOS (11.64 s CPU per 10 s wall, fleet box).
        expect(result.pipeline).toContain('identity name=progmix_out sync=true');
    });

    it('builds the full stage order: hpf → eq → dynamics → limiter → duckvol', () => {
        const result = build(
            {
                hpf: true,
                eqElement: EQ_EL,
                dynElement: COMP_EL,
                dynMode: 'compressor',
                limiterElement: LIM_EL,
            },
            { hpfFreq: 120, eqBand0Type: 'bell', eqBand0Gain: 3, threshold: -25 },
        )!;
        const order = [
            'audioconvert',
            'audiocheblimit name=hpf mode=high-pass poles=4 cutoff=120',
            `${EQ_EL} name=eq`,
            `${COMP_EL} name=dyn`,
            `${LIM_EL} name=lim`,
            'volume name=duckvol',
            'level name=outlevel',
        ];
        let cursor = -1;
        for (const fragment of order) {
            const at = result.pipeline.indexOf(fragment);
            expect(at, `${fragment} present`).toBeGreaterThan(-1);
            expect(at, `${fragment} in order`).toBeGreaterThan(cursor);
            cursor = at;
        }
        expect(result.pipeline).toContain('filter-type-0=1'); // bell
        expect(result.pipeline).toContain('gain-0=1.412538'); // +3 dB, linear
        expect(result.pipeline).toContain('attack-threshold=0.056234'); // -25 dB
        expect(result.pipeline).toContain('threshold=0.891251'); // limiter, -1 dB
        // Self-keyed dynamics — the 4-channel packing is gone.
        expect(result.pipeline).not.toContain('deinterleave');
        expect(result.pipeline).not.toContain('interleave');
    });

    it('ducker adds a fast sidechain level branch and subscribes to it', () => {
        const result = build({ dynMode: 'ducker', duckerKey: true }, {}, [mkSource(1)])!;
        // Single key source → direct branch, same continuation name.
        expect(result.pipeline).not.toContain('audiomixer name=scmix');
        expect(result.pipeline).toContain('capsfilter name=scmix_out');
        expect(result.pipeline).toContain(
            'scmix_out. ! audioconvert ! level name=sclevel post-messages=true interval=15000000 ! fakesink sync=false',
        );
        expect(result.busReports).toEqual([{ element: 'sclevel', structure: 'level' }]);
        expect(result.pipeline).toContain('volume name=duckvol');
        expect(result.pipeline).not.toContain('ladspa');
    });

    it('ducker with nothing on the sidechain pin still passes program through', () => {
        const result = build({ dynMode: 'ducker', duckerKey: false })!;
        expect(result.pipeline).not.toContain('scmix');
        expect(result.pipeline).not.toContain('sclevel');
        expect(result.busReports).toBeUndefined();
        expect(result.pipeline).toContain('volume name=duckvol');
    });

    it('self-keyed gate is a plain inline element', () => {
        const result = build({ dynElement: GATE_EL, dynMode: 'gate' }, { gateKey: 'self' })!;
        expect(result.pipeline).toContain(`${GATE_EL} name=dyn`);
        expect(result.pipeline).toContain('curve-threshold=');
        expect(result.pipeline).not.toContain('interleave');
        expect(result.pipeline).not.toContain('sidechain-input');
    });

    it('gateKey=sidechain with no key wired: gate-stereo WITHOUT sidechain-input', () => {
        // The module resolves `gate-stereo` (not `sc-gate-stereo`) in this
        // state, and that element has no `sidechain-input` port — emitting the
        // property off raw config warned on every start.
        const result = build(
            { dynElement: GATE_EL, dynMode: 'gate', keyedGate: false },
            { gateKey: 'sidechain' },
        )!;
        expect(result.pipeline).toContain(`${GATE_EL} name=dyn`);
        expect(result.pipeline).not.toContain('sidechain-input');
        expect(result.pipeline).not.toContain('interleave');
        expect(result.pipeline).not.toContain('scmix');
    });

    it('keyedGate with no key branch built falls back inline, props and all', () => {
        // Caller-bug guard: the flag that emits `sidechain-input` is the same
        // one that builds the 4-channel wiring, so they cannot disagree.
        const result = build(
            { dynElement: GATE_EL, dynMode: 'gate', keyedGate: true },
            { gateKey: 'sidechain' },
            [],
        )!;
        expect(result.pipeline).not.toContain('sidechain-input');
        expect(result.pipeline).not.toContain('deinterleave');
        expect(result.pipeline).toContain(`${GATE_EL} name=dyn`);
    });

    it('sidechain-keyed gate is the ONE 4-channel path (program 0/1, key 2/3)', () => {
        const result = build(
            { dynElement: SC_GATE_EL, dynMode: 'gate', keyedGate: true, eqElement: EQ_EL },
            { gateKey: 'sidechain' },
            [mkSource(1)],
        )!;
        expect(result.pipeline).toContain('deinterleave name=dp');
        expect(result.pipeline).toContain('deinterleave name=ds');
        expect(result.pipeline).toContain('interleave name=il');
        expect(result.pipeline).toContain('audio/x-raw,channels=4,channel-mask=(bitmask)0x0');
        expect(result.pipeline).toContain(`${SC_GATE_EL} name=dyn`);
        expect(result.pipeline).toContain('sidechain-input=1');
        expect(result.pipeline).toContain('dp.src_0 ! queue ! il.sink_0');
        expect(result.pipeline).toContain('dp.src_1 ! queue ! il.sink_1');
        expect(result.pipeline).toContain('ds.src_0 ! queue ! il.sink_2');
        expect(result.pipeline).toContain('ds.src_1 ! queue ! il.sink_3');
        // The EQ stays on the PROGRAM leg, ahead of the split.
        expect(result.pipeline.indexOf(`${EQ_EL} name=eq`)).toBeLessThan(
            result.pipeline.indexOf('deinterleave name=dp'),
        );
        // Both keyed legs are positioned stereo — deinterleave needs a mask.
        expect(result.pipeline.match(/channel-mask=\(bitmask\)0x3/g)).toHaveLength(2);
        // Key branch feeds the interleave, not a `level` — no ducker here.
        expect(result.busReports).toBeUndefined();
    });

    it('a sidechain edge is NEVER consumed as program audio when nothing keys off it', () => {
        // Field wiring that started this: a transcoder output on Sidechain,
        // every DSP stage off. The key must not reach the programme mix, and
        // no sidechain branch should exist at all.
        const key = mkSource(1);
        const result = build({}, {}, [key])!;
        expect(result.pipeline).not.toContain(key.socketPath!);
        expect(result.pipeline).not.toContain('scmix');
        expect(result.pipeline).not.toContain('sclevel');
        expect(branchOwners(result.pipeline)).toEqual({
            [mkSource(0).socketPath!]: 'progmix',
        });
    });

    it('sidechain-only wiring builds nothing — a key is not a program input', () => {
        // The program mix has no branches to build, so there is no pipeline
        // (the module turns this into the "wire audio to Program In" warning).
        const key = mkSource(1);
        expect(
            buildProcessingPipeline({
                programSources: [],
                sidechainSources: [key],
                outputPort: 40200,
                latencyMs: 200,
                config: {},
                stages: stages({ dynMode: 'ducker', duckerKey: true }),
            }),
        ).toBeNull();
    });

    it('drops an edge handed to BOTH pins from the program mix (caller-bug guard)', () => {
        const shared = mkSource(0);
        expect(
            buildProcessingPipeline({
                programSources: [shared],
                sidechainSources: [shared],
                outputPort: 40200,
                latencyMs: 200,
                config: {},
                stages: stages(),
            }),
        ).toBeNull();
    });

    it('each socket lands in its own branch for a sidechain-keyed gate', () => {
        const program = mkSource(0);
        const key = mkSource(1);
        const result = buildProcessingPipeline({
            programSources: [program],
            sidechainSources: [key],
            outputPort: 40200,
            latencyMs: 200,
            config: { gateKey: 'sidechain' },
            stages: stages({ dynElement: SC_GATE_EL, dynMode: 'gate', keyedGate: true }),
        })!;
        expect(branchOwners(result.pipeline)).toEqual({
            [program.socketPath!]: 'progmix',
            [key.socketPath!]: 'scmix',
        });
        // …and each terminal feeds the leg it belongs to: program → dp, key → ds.
        expect(result.pipeline).toContain('progmix_out. ! audioconvert');
        expect(result.pipeline).toContain('scmix_out. ! audioconvert !');
        expect(result.pipeline).toContain('! deinterleave name=ds');
    });

    it('each socket lands in its own branch for a ducker key', () => {
        const program = mkSource(0);
        const key = mkSource(1);
        const result = buildProcessingPipeline({
            programSources: [program],
            sidechainSources: [key],
            outputPort: 40200,
            latencyMs: 200,
            config: {},
            stages: stages({ dynMode: 'ducker', duckerKey: true }),
        })!;
        expect(branchOwners(result.pipeline)).toEqual({
            [program.socketPath!]: 'progmix',
            [key.socketPath!]: 'scmix',
        });
        expect(result.pipeline).toContain('scmix_out. ! audioconvert ! level name=sclevel');
    });

    it('limiter alone still lands ahead of the fader', () => {
        const result = build({ limiterElement: LIM_EL }, { limiterThreshold: -3 })!;
        expect(result.pipeline).toContain(`${LIM_EL} name=lim threshold=0.707946`);
        expect(result.pipeline.indexOf('name=lim')).toBeLessThan(
            result.pipeline.indexOf('volume name=duckvol'),
        );
        expect(result.pipeline).not.toContain('name=dyn');
    });

    it('EQ bypass rides in the launch string, all 16 bands are pinned', () => {
        const result = build({ eqElement: EQ_EL }, { eqEnabled: true, eqBypass: true })!;
        expect(result.pipeline).toContain('bypass=true');
        expect(result.pipeline.match(/filter-type-\d+=/g)).toHaveLength(16);
        expect(result.pipeline).toContain('filter-type-15=0');
    });
});
