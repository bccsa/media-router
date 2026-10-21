import { describe, it, expect } from 'vitest';
import type { AudioMixSource } from '@media-router/plugin-audio-302m-core';
import { buildProcessingPipeline } from './audioProcessingPipeline.js';
import type { ChainStages } from './lspProcessing.js';
import { stages } from './chainStages.fixture.js';

const EQ_EL = 'ladspa-lsp-test-para-equalizer-x16-stereo';
const COMP_EL = 'ladspa-lsp-test-compressor-stereo';
const GATE_EL = 'ladspa-lsp-test-gate-stereo';
const SC_GATE_EL = 'ladspa-lsp-test-sc-gate-stereo';
const LIM_EL = 'ladspa-lsp-test-limiter-stereo';
const AGC_EL = 'ladspa-lsp-test-autogain-stereo';

function mkSource(n = 0): AudioMixSource {
    return {
        port: 40100 + n,
        connectionId: `c-${n}`,
        socketPath: `/tmp/mr-bus-${40100 + n}-abcdef.sock`,
    };
}

function build(
    over: Partial<ChainStages> = {},
    config: Record<string, unknown> = {},
    sidechain: AudioMixSource[] = [],
) {
    return buildProcessingPipeline({
        programSources: [mkSource(0)],
        sidechainSources: sidechain,
        outputPort: 40200,
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
                config: {},
                stages: stages(),
            }),
        ).toBeNull();
    });

    it('bare chain: 302M decode in, VU, 302M encode out — no PipeWire', () => {
        const result = build()!;
        // One program source → direct branch: no aggregator, no watchdog.
        expect(result.pipeline).not.toContain('audiomixer');
        expect(result.pipeline).not.toContain('mralignwatch');
        expect(result.pipeline).toContain(
            'mrtsdemux name=progmix_demux0 select=audio/x-smpte-302m ! avdec_s302m',
        );
        expect(result.pipeline).toContain(
            'capsfilter name=progmix_out caps="audio/x-raw,rate=48000,channels=2"',
        );
        expect(result.pipeline).toContain('avdec_s302m');
        expect(result.pipeline).toContain('socket-path=/tmp/mr-bus-40100-abcdef.sock');
        expect(result.pipeline).toContain(
            'progmix_out. ! audioconvert ! level name=outlevel post-messages=true',
        );
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
            config: {},
            stages: stages(),
        })!;
        expect(result.pipeline.match(/! progmix\./g)).toHaveLength(3);
        // The aligned mixer: no budget, every source through its watchdog.
        expect(result.pipeline).toContain(
            'audiomixer name=progmix latency=0 start-time-selection=first' +
                ' ! capsfilter name=progmix_out caps="audio/x-raw,rate=48000,channels=2"',
        );
        expect(
            result.pipeline.match(/! mralignwatch name=progmix_aw_[0-9a-f]{6} aligner=progmix /g),
        ).toHaveLength(3);
        expect(result.pipeline).not.toContain('force-live');
        expect(result.pipeline).not.toContain('identity');
    });

    it('builds the full stage order: hpf → eq → dynamics → limiter → VU', () => {
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

    it('auto gain sits between the HPF and the EQ, knobs and fixed internals applied', () => {
        const result = build(
            { hpf: true, agcElement: AGC_EL, eqElement: EQ_EL },
            { agcKickIn: -55, agcTarget: -20, agcMaxGain: 18, agcSpeed: 'fast' },
        )!;
        const hpf = result.pipeline.indexOf('name=hpf');
        const agc = result.pipeline.indexOf(`${AGC_EL} name=agc`);
        const eq = result.pipeline.indexOf(`${EQ_EL} name=eq`);
        expect(hpf).toBeGreaterThan(-1);
        expect(agc).toBeGreaterThan(hpf);
        expect(eq).toBeGreaterThan(agc);
        expect(result.pipeline).toContain('the-level-of-silence=-55');
        expect(result.pipeline).toContain('desired-loudness-level=-20');
        expect(result.pipeline).toContain('the-maximum-amplification-gain=18');
        expect(result.pipeline).toContain('long-gain-grow-time=500'); // fast preset
        expect(result.pipeline).toContain('weighting-function=5');
        expect(result.pipeline).toContain('enable-quick-amplifier=false');
    });

    it('ducker: programme and key by PTS into mrducker, its envelope through busReports', () => {
        const result = build({ dynMode: 'ducker', duckerKey: true }, {}, [mkSource(1)])!;
        const p = result.pipeline;
        // Single key source → direct branch, same continuation name.
        expect(p).not.toContain('audiomixer name=scmix');
        expect(p).toContain(
            'scmix_out. ! audioconvert ! audio/x-raw,format=F32LE,channels=2,rate=48000,' +
                'channel-mask=(bitmask)0x3 ! deinterleave name=ds',
        );
        expect(p).toContain(
            'progmix_out. ! audioconvert ! audio/x-raw,format=F32LE,channels=2,rate=48000,' +
                'channel-mask=(bitmask)0x3 ! deinterleave name=dp',
        );
        expect(p).toContain(
            'audiointerleave name=il latency=0 start-time-selection=first ! audioconvert' +
                ' ! audio/x-raw,channels=4,channel-mask=(bitmask)0x0' +
                ' ! mrducker name=ducker threshold=-35 depth=-12 attack=5 release=200 hold=250' +
                ' ! level name=outlevel',
        );
        expect(result.busReports).toEqual([{ element: 'ducker', structure: 'mrducker' }]);
        // The engine-side loop is gone: no key `level`, no fader.
        expect(p).not.toContain('sclevel');
        expect(p).not.toContain('volume');
        expect(p).not.toContain('fakesink');
        expect(p).not.toContain('ladspa');
    });

    it('ducker and keyed gate: every channel enters the interleave through its watchdog', () => {
        const mono = 'audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=1';
        for (const over of [
            { dynMode: 'ducker' as const, duckerKey: true },
            { dynElement: SC_GATE_EL, dynMode: 'gate' as const, keyedGate: true },
        ]) {
            const p = build(over, { gateKey: 'sidechain' }, [mkSource(1)])!.pipeline;
            expect(p).toContain(
                `dp.src_0 ! ${mono} ! mralignwatch name=il_aw_prog0 aligner=il input=prog0 ! il.sink_0`,
            );
            expect(p).toContain(
                `dp.src_1 ! ${mono} ! mralignwatch name=il_aw_prog1 aligner=il input=prog1 ! il.sink_1`,
            );
            expect(p).toContain(
                `ds.src_0 ! ${mono} ! mralignwatch name=il_aw_key0 aligner=il input=key0 ! il.sink_2`,
            );
            expect(p).toContain(
                `ds.src_1 ! ${mono} ! mralignwatch name=il_aw_key1 aligner=il input=key1 ! il.sink_3`,
            );
            expect(p.match(/mralignwatch name=il_aw_/g)).toHaveLength(4);
            // collect-pads `interleave` joined by arrival; nothing queues ahead of il any more.
            expect(p).not.toMatch(/(^|[ !])interleave /);
            expect(p).not.toContain('queue ! il.');
            expect(p).not.toContain('silence-floor');
        }
    });

    it('a channel fed by an aligned mixer waits 500 ms before it is silent, a direct one not', () => {
        const two = [mkSource(1), mkSource(2)];
        const floor = (p: string, input: string) =>
            new RegExp(
                `name=il_aw_${input} aligner=il input=${input} silence-floor=500000000 `,
            ).test(p);
        const keyMixed = buildProcessingPipeline({
            programSources: [mkSource(0)],
            sidechainSources: two,
            outputPort: 40200,
            config: {},
            stages: stages({ dynMode: 'ducker', duckerKey: true }),
        })!.pipeline;
        expect(['prog0', 'prog1'].map((i) => floor(keyMixed, i))).toEqual([false, false]);
        expect(['key0', 'key1'].map((i) => floor(keyMixed, i))).toEqual([true, true]);
        const progMixed = buildProcessingPipeline({
            programSources: [mkSource(3), mkSource(4)],
            sidechainSources: [mkSource(1)],
            outputPort: 40200,
            config: {},
            stages: stages({ dynMode: 'ducker', duckerKey: true }),
        })!.pipeline;
        expect(['prog0', 'prog1'].map((i) => floor(progMixed, i))).toEqual([true, true]);
        expect(['key0', 'key1'].map((i) => floor(progMixed, i))).toEqual([false, false]);
    });

    it("ducker: the settings ride in the launch string, clamped to the element's ranges", () => {
        const p = build(
            { dynMode: 'ducker', duckerKey: true },
            { threshold: -80, duckDepth: 6, attack: 900, release: 1, hold: 'x' },
            [mkSource(1)],
        )!.pipeline;
        expect(p).toContain(
            'mrducker name=ducker threshold=-60 depth=0 attack=500 release=5 hold=0 !',
        );
        const q = build(
            { dynMode: 'ducker', duckerKey: true },
            { threshold: -20, duckDepth: -18, attack: 12.5, release: 400, hold: 100 },
            [mkSource(1)],
        )!.pipeline;
        expect(q).toContain(
            'mrducker name=ducker threshold=-20 depth=-18 attack=12.5 release=400 hold=100 !',
        );
    });

    it('ducker: the limiter runs before the interleave, so the duck stays after it', () => {
        const p = build(
            { dynMode: 'ducker', duckerKey: true, limiterElement: LIM_EL, eqElement: EQ_EL },
            {},
            [mkSource(1)],
        )!.pipeline;
        const at = (s: string) => p.indexOf(s);
        expect(at(`${EQ_EL} name=eq`)).toBeLessThan(at(`${LIM_EL} name=lim`));
        expect(at(`${LIM_EL} name=lim`)).toBeLessThan(at('deinterleave name=dp'));
        expect(at('deinterleave name=dp')).toBeLessThan(at('mrducker name=ducker'));
        expect(p.match(/name=lim /g)).toHaveLength(1);
        // The key never runs through the programme's limiter.
        expect(p).toMatch(/scmix_out\. ! audioconvert ! [^ ]+ ! deinterleave name=ds/);
    });

    it('ducker with nothing on the sidechain pin still passes program through', () => {
        const result = build({ dynMode: 'ducker', duckerKey: false })!;
        expect(result.pipeline).not.toContain('scmix');
        expect(result.pipeline).not.toContain('mrducker');
        expect(result.pipeline).not.toContain('interleave');
        expect(result.busReports).toBeUndefined();
        expect(result.pipeline).toContain('progmix_out. ! audioconvert ! level name=outlevel');
    });

    it('duckerKey with no key branch built: no mrducker (caller-bug guard)', () => {
        // The flag that names the ducker is the one that builds its key, so they cannot disagree.
        const result = build({ dynMode: 'ducker', duckerKey: true }, {}, [])!;
        expect(result.pipeline).not.toContain('mrducker');
        expect(result.pipeline).not.toContain('deinterleave');
        expect(result.busReports).toBeUndefined();
    });

    it('self-keyed gate is a plain inline element', () => {
        const result = build({ dynElement: GATE_EL, dynMode: 'gate' }, { gateKey: 'self' })!;
        expect(result.pipeline).toContain(`${GATE_EL} name=dyn`);
        expect(result.pipeline).toContain('curve-threshold=');
        expect(result.pipeline).not.toContain('interleave');
        expect(result.pipeline).not.toContain('sidechain-input');
    });

    it('only the keyed gate gets the PTS keeper: a 2 -> 2 LADSPA filter keeps its PTS', () => {
        const key = [mkSource(1)];
        const keyed = build(
            { dynElement: SC_GATE_EL, dynMode: 'gate', keyedGate: true },
            { gateKey: 'sidechain' },
            key,
        )!.pipeline;
        expect(keyed.match(/mrptskeep/g)).toHaveLength(1);
        expect(keyed).toContain(`! mrptskeep target=dyn ! audioconvert ! level name=outlevel`);
        for (const over of [
            { dynElement: GATE_EL, dynMode: 'gate' as const },
            { dynElement: COMP_EL, dynMode: 'compressor' as const, limiterElement: LIM_EL },
            { dynMode: 'ducker' as const, duckerKey: true },
            { dynElement: GATE_EL, dynMode: 'gate' as const, keyedGate: true },
        ]) {
            expect(
                build(over, { gateKey: 'sidechain' }, over.duckerKey ? key : [])!.pipeline,
            ).not.toContain('mrptskeep');
        }
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

    it('sidechain-keyed gate: programme 0/1 and key 2/3 by PTS, the limiter after the gate', () => {
        const result = build(
            {
                dynElement: SC_GATE_EL,
                dynMode: 'gate',
                keyedGate: true,
                eqElement: EQ_EL,
                limiterElement: LIM_EL,
            },
            { gateKey: 'sidechain' },
            [mkSource(1)],
        )!;
        const p = result.pipeline;
        expect(p).toContain('deinterleave name=dp');
        expect(p).toContain('deinterleave name=ds');
        expect(p).toContain(
            'audiointerleave name=il latency=0 start-time-selection=first ! audioconvert' +
                ` ! audio/x-raw,channels=4,channel-mask=(bitmask)0x0 ! ${SC_GATE_EL} name=dyn`,
        );
        expect(p).toContain('sidechain-input=1');
        // The LADSPA wrapper's 4 -> 2 output has no PTS: the keeper follows the gate directly.
        expect(p).toMatch(
            new RegExp(
                `${SC_GATE_EL} name=dyn [^!]+! mrptskeep target=dyn ! audioconvert ! ` +
                    `${LIM_EL} name=lim [^!]+! level name=outlevel`,
            ),
        );
        // The EQ stays on the PROGRAM leg, ahead of the split.
        expect(p.indexOf(`${EQ_EL} name=eq`)).toBeLessThan(p.indexOf('deinterleave name=dp'));
        // Both keyed legs are positioned stereo — deinterleave needs a mask.
        expect(p.match(/channel-mask=\(bitmask\)0x3/g)).toHaveLength(2);
        // Key branch feeds the interleave, no ducker here.
        expect(p).not.toContain('mrducker');
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
            config: {},
            stages: stages({ dynMode: 'ducker', duckerKey: true }),
        })!;
        expect(branchOwners(result.pipeline)).toEqual({
            [program.socketPath!]: 'progmix',
            [key.socketPath!]: 'scmix',
        });
        expect(result.pipeline).toContain('scmix_out. ! audioconvert ! audio/x-raw');
        expect(result.pipeline).toContain('! deinterleave name=ds');
    });

    it('limiter alone still lands ahead of the VU', () => {
        const result = build({ limiterElement: LIM_EL }, { limiterThreshold: -3 })!;
        expect(result.pipeline).toContain(`${LIM_EL} name=lim threshold=0.707946`);
        expect(result.pipeline.indexOf('name=lim')).toBeLessThan(
            result.pipeline.indexOf('level name=outlevel'),
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

describe('the strings py/mrducker_element_test.py runs', () => {
    // A placeholder per LADSPA element: the test puts the registry's versioned name in.
    const ladspa = (suffix: string) => `ladspa-@-${suffix}`;

    it('py/pipelines.json is what this builder makes (`vitest -u` rewrites it)', async () => {
        const key = [mkSource(1)];
        const cases = {
            ducker: build({ dynMode: 'ducker', duckerKey: true }, {}, key)!,
            keyedGate: build(
                {
                    dynElement: ladspa('sc-gate-stereo'),
                    dynMode: 'gate',
                    keyedGate: true,
                    limiterElement: ladspa('limiter-stereo'),
                },
                { gateKey: 'sidechain' },
                key,
            )!,
        };
        const out = Object.fromEntries(
            Object.entries(cases).map(([name, r]) => [
                name,
                { pipeline: r.pipeline, busReports: r.busReports ?? null },
            ]),
        );
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
            '../py/pipelines.json',
        );
    });
});
