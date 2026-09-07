/**
 * Pure pipeline assembly for the Audio Processing chain (302M in → 302M out).
 *
 * Topology (no PipeWire anywhere — the superseded audio-dynamics module's three
 * null-sinks are gone): the program input and the sidechain input are each a
 * 302M bus fan-in (`buildAudioMixInput` decodes every wired edge once and sums
 * them), the processed program leaves through `build302mEncodeBranch` into the
 * module's own bus fan-out tee.
 *
 *   progmix. ! audioconvert ! <hpf> ! <eq> ! <dynamics> ! <limiter>
 *           ! volume name=duckvol ! level name=outlevel ! 302M encode ! bus
 *
 * Every stage is optional; the chain collapses to a straight audioconvert when
 * nothing is enabled. PTS-preservation contract as for every 302M module: no
 * `pulsesrc`, no `do-timestamp`, no `tsparse set-timestamps` — the 302M PES PTS
 * is the timeline, and none of the stages here re-stamp.
 */

import { buildBusSink, busTeeName, type BusReport } from '@media-router/engine';
import {
    buildAudioMixInput,
    build302mEncodeBranch,
    type AudioMixSource,
    s302mFormatFor,
} from '@media-router/plugin-audio-302m-core';
import { eqProps } from './eqBands.js';
import { dynProps, hpfCutoff, limiterProps, type ChainStages } from './lspProcessing.js';

export interface ProcessingPipelineInputs {
    programSources: AudioMixSource[];
    sidechainSources: AudioMixSource[];
    /** Allocated bus channel for the processed output. */
    outputPort: number;
    /** Per-input mix latency budget (ms) — the wait for lagging SOURCES. */
    latencyMs: number;
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

/** F32LE stereo with an explicit mask — `deinterleave` needs positioned
 *  channels, and the LSP elements are F32LE-only. */
const STEREO_CAPS = 'audio/x-raw,format=F32LE,channels=2,rate=48000,channel-mask=(bitmask)0x3';

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
        latencyMs: input.latencyMs,
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
            latencyMs: input.latencyMs,
            mixerName: SIDECHAIN_MIXER,
        });
        parts.push(sidechain.fragment);
        sidechainName = sidechain.continuationName;
    }

    // ONE flag decides the keyed-gate element's properties AND the topology
    // that feeds it: `sidechain-input=1` exists only on `sc-gate-stereo`, and
    // that element is only wired up when a key branch was actually built.
    const keyedGate = stages.keyedGate && sidechainName !== '';

    // --- Program head: everything up to (but excluding) the dynamics stage.
    const head: string[] = [`${program.continuationName}.`, 'audioconvert'];
    if (stages.hpf) {
        head.push(
            `audiocheblimit name=hpf mode=high-pass poles=4` +
                ` cutoff=${hpfCutoff(config.hpfFreq ?? 80)}`,
        );
    }
    if (stages.eqElement) head.push(`${stages.eqElement} name=eq ${eqProps(config).join(' ')}`);

    // --- Tail: dynamics output → limiter → duck fader → VU → 302M egress.
    const tail: string[] = [];
    if (stages.limiterElement) {
        tail.push(`${stages.limiterElement} name=lim ${limiterProps(config).join(' ')}`);
    }
    tail.push(
        'volume name=duckvol volume=1',
        'level name=outlevel post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
        build302mEncodeBranch({ format: s302mFormatFor(input.config.pcmBitDepth) }),
        buildBusSink(input.outputPort),
    );

    const dynParams = dynProps({ dynMode: stages.dynMode, keyedGate }, config).join(' ');
    const dyn = stages.dynElement ? `${stages.dynElement} name=dyn ${dynParams}`.trimEnd() : null;

    if (keyedGate) {
        // The one surviving 4-channel path: `sc-gate-stereo` wants program on
        // channels 0/1 and the key on 2/3, so the head ends in a deinterleave,
        // the sidechain gets its own, and an interleave rebuilds the 4-ch feed.
        parts.push([...head, STEREO_CAPS, 'deinterleave name=dp'].join(' ! '));
        parts.push(`${sidechainName}. ! audioconvert ! ${STEREO_CAPS} ! deinterleave name=ds`);
        parts.push(
            [
                'interleave name=il',
                'audioconvert',
                'audio/x-raw,channels=4,channel-mask=(bitmask)0x0',
                dyn,
                'audioconvert',
                ...tail,
            ].join(' ! '),
        );
        parts.push(
            'dp.src_0 ! queue ! il.sink_0',
            'dp.src_1 ! queue ! il.sink_1',
            'ds.src_0 ! queue ! il.sink_2',
            'ds.src_1 ! queue ! il.sink_3',
        );
    } else {
        parts.push([...head, ...(dyn ? [dyn] : []), ...tail].join(' ! '));
    }

    const busReports: BusReport[] = [];
    if (stages.duckerKey && sidechainName) {
        // Fast (~15 ms) key readings for the ducker's gain envelope. Subscribed
        // via busReports, so this `level` never reaches the aggregate VU meter.
        parts.push(
            `${sidechainName}. ! audioconvert` +
                ' ! level name=sclevel post-messages=true interval=15000000' +
                ' ! fakesink sync=false',
        );
        busReports.push({ element: 'sclevel', structure: 'level' });
    }

    return {
        pipeline: parts.join(' '),
        sinkName: busTeeName(input.outputPort),
        busReports: busReports.length > 0 ? busReports : undefined,
    };
}
