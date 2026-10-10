/**
 * Pure pipeline assembly for the 302M audio mixer.
 *
 * PTS-preservation contract (same as every 302M module): no `pulsesrc`, no
 * `do-timestamp`, no `tsparse set-timestamps` — the 302M PES PTS is the
 * timeline. `audiomixer` aggregates by RUNNING TIME, so same-timeline inputs
 * mix content-aligned and the output carries coherent PTS.
 */

import { buildBusSink, busTeeName, type LiveInputBranch } from '@media-router/engine';
import {
    buildAudioMixInput,
    build302mEncodeBranch,
    liveInputBranchFor,
    s302mFormatFor,
    type AudioMixSource,
    type S302mFormat,
} from '@media-router/plugin-audio-302m-core';

/** Name of the fan-in aggregator — the element every live input branch links into. */
export const MIXER_NAME = 'mixin';

/** The live-input branch for one Audio In edge (`getLiveInputBranch`). */
export function mixerInputBranch(
    connectionId: string,
    source: AudioMixSource | undefined,
    channels: number,
): LiveInputBranch {
    return liveInputBranchFor(MIXER_NAME, connectionId, source, { channels });
}

export interface AudioMixerPipelineInputs {
    sources: AudioMixSource[];
    /** Allocated bus channel for the mix output. */
    outputPort: number;
    channels: number;
    volume: number; // 0..1.5 gst scale
    /** audiomixer latency budget (ms) — silence-fills starved sources. */
    latencyMs: number;
    /** 302M word length of the mix output (`pcmBitDepth`). Default 16-bit. */
    pcmFormat?: S302mFormat;
}

export interface AudioMixerPipelineResult {
    pipeline: string;
    /** Throughput counter element on the output (bus fan-out tee). */
    sinkName: string;
}

/**
 * N × 302M sources → audiomixer → master volume + VU level → 302M encode →
 * bus sink. Per-connection channel maps render per-branch inside
 * `buildAudioMixInput` (routing + gain).
 */
export function buildMixerPipeline(
    input: AudioMixerPipelineInputs,
): AudioMixerPipelineResult | null {
    if (input.sources.length === 0) return null;

    // Live inputs: each source a named bin, mixer arm even for one source
    // (ADR-0008 addendum) — a mixer's job is to take inputs on and off.
    const { fragment, continuationName } = buildAudioMixInput({
        sources: input.sources,
        channels: input.channels,
        latencyMs: input.latencyMs,
        mixerName: MIXER_NAME,
        liveInputs: true,
    });

    const pipeline =
        `${fragment} ${continuationName}.` +
        ` ! audioconvert ! volume name=vol volume=${input.volume.toFixed(2)}` +
        ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ` ! ${build302mEncodeBranch({ format: input.pcmFormat ?? s302mFormatFor(undefined) })}` +
        ` ! ${buildBusSink(input.outputPort)}`;

    return { pipeline, sinkName: busTeeName(input.outputPort) };
}
