/**
 * Pure pipeline assembly for the 302M audio mixer.
 *
 * PTS-preservation contract (same as every 302M module): no `pulsesrc`, no
 * `do-timestamp`, no `tsparse set-timestamps` — the 302M PES PTS is the
 * timeline. `audiomixer` aggregates by RUNNING TIME, so same-timeline inputs
 * mix content-aligned and the output carries coherent PTS.
 *
 * Under the time-sync contract the mixer is a TRANSFORM PRODUCER (ADR-0005,
 * house-timeline egress): every input branch's tsdemux is retimed to its
 * producer's stamps, so a branch's running time is its content time whatever
 * hop it came through, and the egress stamps by identity. Without that, each
 * branch kept the zero point of the one bus buffer its tsdemux locked on, and
 * an input whose producer re-anchors its egress at arrival (Audio Processing,
 * until it was made content-exact too) landed seconds away from a sibling that
 * carries the source's time — measured 2026-10-10: 7.99 s apart, 73% of the
 * mix silence-filled.
 */

import { buildBusSink, busTeeName, type LiveInputBranch } from '@media-router/engine';
import {
    branchIgnorePcr,
    buildAudioMixInput,
    build302mEncodeBranch,
    liveInputBranchFor,
    s302mFormatFor,
    type AudioMixSource,
    type S302mFormat,
} from '@media-router/plugin-audio-302m-core';

/** Name of the fan-in aggregator — the element every live input branch links into. */
export const MIXER_NAME = 'mixin';

/** The live-input branch for one Audio In edge (`getLiveInputBranch`) — the
 *  same string `buildMixerPipeline` renders for it at start (`retimed` must
 *  match), so a later live remove finds it and a re-add is identical. */
export function mixerInputBranch(
    connectionId: string,
    source: AudioMixSource | undefined,
    channels: number,
    retimed = false,
): LiveInputBranch {
    return liveInputBranchFor(MIXER_NAME, connectionId, source, {
        channels,
        ignorePcr: branchIgnorePcr({ retimed }),
    });
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
    /** Branches retimed to their producers' stamps (contract path) — see
     *  `AudioMixInputOpts.retimed`. */
    retimed?: boolean;
}

export interface AudioMixerPipelineResult {
    pipeline: string;
    /** Throughput counter element on the output (bus fan-out tee). */
    sinkName: string;
    /** Every start-time branch's tsdemux, for `alignBranchesToStamps`. */
    demuxes: string[];
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
    const { fragment, continuationName, demuxes } = buildAudioMixInput({
        sources: input.sources,
        channels: input.channels,
        latencyMs: input.latencyMs,
        mixerName: MIXER_NAME,
        liveInputs: true,
        retimed: input.retimed,
    });

    const pipeline =
        `${fragment} ${continuationName}.` +
        ` ! audioconvert ! volume name=vol volume=${input.volume.toFixed(2)}` +
        ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ` ! ${build302mEncodeBranch({ format: input.pcmFormat ?? s302mFormatFor(undefined) })}` +
        ` ! ${buildBusSink(input.outputPort)}`;

    return { pipeline, sinkName: busTeeName(input.outputPort), demuxes };
}
