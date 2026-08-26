/**
 * Pure pipeline assembly for the 302M audio mixer.
 *
 * PTS-preservation contract (same as every 302M module): no `pulsesrc`, no
 * `do-timestamp`, no `tsparse set-timestamps` — the 302M PES PTS is the
 * timeline. `audiomixer` aggregates by RUNNING TIME, so same-timeline inputs
 * mix content-aligned and the output carries coherent PTS.
 */

import { buildBusSink, busTeeName } from '@media-router/engine';
import {
    buildAudioMixInput,
    build302mEncodeBranch,
    type AudioMixSource,
} from '@media-router/plugin-audio-302m-core';

export interface AudioMixerPipelineInputs {
    sources: AudioMixSource[];
    /** Allocated bus channel for the mix output. */
    outputPort: number;
    channels: number;
    volume: number; // 0..1.5 gst scale
    /** audiomixer latency budget (ms) — silence-fills starved sources. */
    latencyMs: number;
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

    const { fragment, continuationName } = buildAudioMixInput({
        sources: input.sources,
        channels: input.channels,
        latencyMs: input.latencyMs,
    });

    const pipeline =
        `${fragment} ${continuationName}.` +
        ` ! audioconvert ! volume name=vol volume=${input.volume.toFixed(2)}` +
        ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ` ! ${build302mEncodeBranch()} ! ${buildBusSink(input.outputPort)}`;

    return { pipeline, sinkName: busTeeName(input.outputPort) };
}
