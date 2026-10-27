/**
 * Pure pipeline assembly for the Audio Processing chain (302M in → 302M out).
 *
 * Topology (no PipeWire anywhere — the superseded audio-dynamics module's three
 * null-sinks are gone): the program input and the sidechain input are each a
 * 302M bus fan-in (`buildAudioMixInput` decodes every wired edge on content time
 * and sums them), the processed program leaves through `build302mEncodeBranch`
 * into the module's own bus fan-out tee.
 *
 *   progmix. ! audioconvert ! <hpf> ! <agc> ! <eq> ! <dynamics> ! <limiter>
 *           ! level name=outlevel ! 302M encode ! bus
 *
 * A mode that keys off the sidechain (the ducker, a sidechain-keyed gate) joins
 * programme and key by PTS (house-clock part 4.5): both split into mono, every
 * channel enters one `audiointerleave` through its `mralignwatch`, and the
 * 4-channel feed (programme 0/1, key 2/3) goes to `mrducker` or `sc-gate-stereo`
 * (then `mrptskeep`, which puts back the PTS the LADSPA wrapper drops there).
 * The ducker's limiter runs before the interleave, the keyed gate's after the gate.
 *
 * Every stage is optional; the chain collapses to a straight audioconvert when
 * nothing is enabled. PTS-preservation contract as for every 302M module: no
 * `pulsesrc`, no `do-timestamp`, no `tsparse set-timestamps` — the 302M PES PTS
 * is the timeline, and none of the stages here re-stamp. The limiter's lookahead
 * shifts the audio later than its PTS; it is reported, not corrected (OQ-22).
 */

import { buildBusSink, busTeeName, type BusReport } from '@media-router/engine';
import {
    buildAudioMixInput,
    build302mEncodeBranch,
    type AudioMixSource,
    s302mFormatFor,
} from '@media-router/plugin-audio-302m-core';
import { eqProps } from './eqBands.js';
import { AGC_ELEMENT, agcProps } from './agcStage.js';
import { DUCKER_ELEMENT, DUCKER_MESSAGE, duckerElement } from './duckerStage.js';
import { dynProps, hpfCutoff, limiterProps, type ChainStages } from './lspProcessing.js';

export interface ProcessingPipelineInputs {
    programSources: AudioMixSource[];
    sidechainSources: AudioMixSource[];
    /** Allocated bus channel for the processed output. */
    outputPort: number;
    config: Record<string, unknown>;
    stages: ChainStages;
}

export interface ProcessingPipelineResult {
    pipeline: string;
    /** Throughput counter element on the output (bus fan-out tee). */
    sinkName: string;
    busReports?: BusReport[];
}

const PROGRAM_MIXER = 'progmix';
const SIDECHAIN_MIXER = 'scmix';
/** The interleave that joins programme and key by PTS: its inputs' pace group. */
export const INTERLEAVE = 'il';

/** F32LE stereo with an explicit mask — `deinterleave` needs positioned
 *  channels, and the LSP elements are F32LE-only. */
const STEREO_CAPS = 'audio/x-raw,format=F32LE,channels=2,rate=48000,channel-mask=(bitmask)0x3';
/** One deinterleaved channel, pinned before its watchdog: one that gaps before
 *  `deinterleave` has its pad primes the interleave with these caps (WI-P2-6). */
const MONO_CAPS = 'audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=1';
/** The interleave's 4 channels, unpositioned (the LSP sc-* elements and mrducker). */
const QUAD_CAPS = 'audio/x-raw,channels=4,channel-mask=(bitmask)0x0';

/** A channel fed by an aligned mixer: its stops (waiting on a dark source, a pace
 *  rise) are no silence, so W is at least this (as n1-mixer-302m's matrix links). */
const MIXED_SILENCE_FLOOR_NS = 500_000_000;

/** GStreamer's LADSPA wrapper writes no timestamps on a 4 -> 2 filter: `mrptskeep`
 *  (native/mrducker) gives each buffer out of the keyed gate the PTS of the one in. */
const GATE_PTS_KEEPER = 'mrptskeep target=dyn';

/** One channel into the interleave: `il.sink_<i>`, programme on 0/1, key on 2/3. */
function interleaveInput(pad: string, input: string, sink: number, mixed: boolean): string {
    const floor = mixed ? ` silence-floor=${MIXED_SILENCE_FLOOR_NS}` : '';
    return (
        `${pad} ! ${MONO_CAPS} ! mralignwatch name=${INTERLEAVE}_aw_${input}` +
        ` aligner=${INTERLEAVE} input=${input}${floor} ! ${INTERLEAVE}.sink_${sink}`
    );
}

export function buildProcessingPipeline(
    input: ProcessingPipelineInputs,
): ProcessingPipelineResult | null {
    if (input.programSources.length === 0) return null;

    const { config, stages } = input;
    const parts: string[] = [];

    // Hard separation of the two input pins: an edge wired to Sidechain is a
    // KEY, never programme audio, so it can never appear in the program mix —
    // not even if a caller hands the same edge to both lists. The module
    // partitions by sink pin, so this only ever fires on a caller bug; dropping
    // the duplicate is strictly safer than summing a key into the programme.
    const sidechainIds = new Set(input.sidechainSources.map((s) => s.connectionId));
    const programSources = input.programSources.filter((s) => !sidechainIds.has(s.connectionId));
    if (programSources.length === 0) return null;

    const program = buildAudioMixInput({
        sources: programSources,
        channels: 2,
        mixerName: PROGRAM_MIXER,
    });
    parts.push(program.fragment);

    // A sidechain edge is consumed ONLY by a mode that keys off it. Under any
    // other mode the edge stays unbuilt — unconsumed, not re-purposed (the
    // module surfaces a health note so the dead wire is visible).
    const needsSidechain = stages.keyedGate || stages.duckerKey;
    let sidechainName = '';
    if (needsSidechain && input.sidechainSources.length > 0) {
        const sidechain = buildAudioMixInput({
            sources: input.sidechainSources,
            channels: 2,
            mixerName: SIDECHAIN_MIXER,
        });
        parts.push(sidechain.fragment);
        sidechainName = sidechain.continuationName;
    }

    // ONE flag per keyed mode decides its element AND the topology that feeds
    // it: `sidechain-input=1` exists only on `sc-gate-stereo`, and `mrducker`
    // needs its key, so each is wired up only when a key branch was built.
    const keyedGate = stages.keyedGate && sidechainName !== '';
    const ducker = stages.duckerKey && sidechainName !== '';

    // --- Program head: everything up to (but excluding) the dynamics stage.
    const head: string[] = [`${program.continuationName}.`, 'audioconvert'];
    if (stages.hpf) {
        head.push(
            `audiocheblimit name=hpf mode=high-pass poles=4` +
                ` cutoff=${hpfCutoff(config.hpfFreq ?? 80)}`,
        );
    }
    if (stages.agcElement) {
        head.push(`${stages.agcElement} name=${AGC_ELEMENT} ${agcProps(config).join(' ')}`);
    }
    if (stages.eqElement) head.push(`${stages.eqElement} name=eq ${eqProps(config).join(' ')}`);

    const limiter = stages.limiterElement
        ? [`${stages.limiterElement} name=lim ${limiterProps(config).join(' ')}`]
        : [];
    const dynParams = dynProps({ dynMode: stages.dynMode, keyedGate }, config).join(' ');
    const dyn = stages.dynElement ? [`${stages.dynElement} name=dyn ${dynParams}`.trimEnd()] : [];

    // --- Egress: VU → 302M → the module's bus fan-out.
    const egress = [
        'level name=outlevel post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
        build302mEncodeBranch({ format: s302mFormatFor(input.config.pcmBitDepth) }),
        buildBusSink(input.outputPort),
    ];

    if (keyedGate || ducker) {
        // Programme on channels 0/1, the key on 2/3, joined by running time: a
        // late key holds the programme in its watchdogs instead of missing it.
        parts.push(
            [...head, ...(ducker ? limiter : []), STEREO_CAPS, 'deinterleave name=dp'].join(' ! '),
        );
        parts.push(`${sidechainName}. ! audioconvert ! ${STEREO_CAPS} ! deinterleave name=ds`);
        const keeper = dyn.length > 0 ? [GATE_PTS_KEEPER] : [];
        const stage = ducker
            ? [duckerElement(config)]
            : [...dyn, ...keeper, 'audioconvert', ...limiter];
        parts.push(
            [
                `audiointerleave name=${INTERLEAVE} latency=0 start-time-selection=first`,
                'audioconvert',
                QUAD_CAPS,
                ...stage,
                ...egress,
            ].join(' ! '),
        );
        const progMixed = programSources.length > 1;
        const keyMixed = input.sidechainSources.length > 1;
        parts.push(
            interleaveInput('dp.src_0', 'prog0', 0, progMixed),
            interleaveInput('dp.src_1', 'prog1', 1, progMixed),
            interleaveInput('ds.src_0', 'key0', 2, keyMixed),
            interleaveInput('ds.src_1', 'key1', 3, keyMixed),
        );
    } else {
        parts.push([...head, ...dyn, ...limiter, ...egress].join(' ! '));
    }

    // The ducker's envelope, 10 Hz of content: through busReports, so a runner
    // forwards it as `mrducker:ducker`.
    const busReports: BusReport[] = ducker
        ? [{ element: DUCKER_ELEMENT, structure: DUCKER_MESSAGE }]
        : [];

    return {
        pipeline: parts.join(' '),
        sinkName: busTeeName(input.outputPort),
        busReports: busReports.length > 0 ? busReports : undefined,
    };
}
