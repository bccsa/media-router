/**
 * Pure port + pipeline-assembly helpers for the 302M N-1 mixer.
 *
 * Decode-once + tee topology: each connected input port is summed to raw
 * audio exactly once (`buildAudioMixInput` — one consumer per edge socket),
 * tee'd, and fed into every output mixer except its own pair. Everything
 * stays inside one GStreamer pipeline, so source PTS flow through the
 * matrix unchanged (same PTS-preservation contract as the audio-transcoder:
 * no `pulsesrc`, no `do-timestamp`, no re-stamping anywhere).
 */

import { buildBusSink, type DynamicPort, type LiveInputBranch } from '@media-router/engine';
import {
    alignedMixer,
    buildAudioMixInput,
    build302mEncodeBranch,
    liveInputBranchFor,
    positionedChannelsClause,
    type AudioMixSource,
    s302mFormatFor,
    type S302mFormat,
} from '@media-router/plugin-audio-302m-core';

export type { DynamicPort };

/** Name of input `index`'s fan-in aggregator — what its live branches link into. */
export function n1InputMixerName(index: number): string {
    return `inmix${index}`;
}

/** The live-input branch for one edge on input `index` (`getLiveInputBranch`). */
export function n1InputBranch(
    index: number,
    connectionId: string,
    source: AudioMixSource | undefined,
    channels: number,
): LiveInputBranch {
    return liveInputBranchFor(n1InputMixerName(index), connectionId, source, { channels });
}

export const MIN_PAIRS = 2;
export const MAX_PAIRS = 16;
export const DEFAULT_PAIRS = 4;

/** Mix widths the `channels` setting offers: mono, or a 302M wire width. */
export const N1_CHANNEL_COUNTS = [1, 2, 4, 6, 8] as const;
export const DEFAULT_CHANNELS = 2;

export function n1PortId(dir: 'in' | 'out', index: number): string {
    return `${dir}-${index}`;
}

/** Clamped integer pairCount — malformed config can never inflate the port
 *  list or splice junk indices into the launch string. */
export function readPairCount(config: Record<string, unknown>): number {
    const n = Math.round(Number(config.pairCount));
    if (!Number.isFinite(n)) return DEFAULT_PAIRS;
    return Math.max(MIN_PAIRS, Math.min(MAX_PAIRS, n));
}

/** The configured mix width, or stereo for anything off the offered set. */
export function readChannels(config: Record<string, unknown>): number {
    const n = Number(config.channels);
    return (N1_CHANNEL_COUNTS as readonly number[]).includes(n) ? n : DEFAULT_CHANNELS;
}

/** A wide mix leaves the output mixer unpositioned (wide 302M inputs decode
 *  that way and the mixer fixates on the first pad) and `avenc_s302m` refuses
 *  it — measured .103, gst 1.28.2, 2026-09-23. Stereo and mono decode
 *  positioned and keep their launch string unchanged. */
function positionedTail(channels: number): string {
    return channels > 2 ? ` ! ${positionedChannelsClause(channels)}` : '';
}

/** N input + N output ports, all 302M. Inputs take unlimited connections
 *  (summed sample-accurately); outputs carry MPEG-TS on the bus, so
 *  downstream consumers wait for PLAYING (`requiresOrderedApply`). */
export function buildN1Ports(pairCount: number): DynamicPort[] {
    const ports: DynamicPort[] = [];
    for (let i = 0; i < pairCount; i++) {
        ports.push({
            id: n1PortId('in', i),
            direction: 'input',
            streamType: 'audio/302m',
            label: `In ${i + 1}`,
            maxConnections: -1,
            acceptsStreamTypes: ['audio/302m'],
        });
    }
    for (let i = 0; i < pairCount; i++) {
        ports.push({
            id: n1PortId('out', i),
            direction: 'output',
            streamType: 'audio/302m',
            label: `Out ${i + 1} (N-1)`,
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    }
    return ports;
}

/** An output with its allocated bus channel (only outputs with ≥1
 *  contributing input are built/allocated). */
export interface N1Output {
    index: number;
    port: number;
}

export interface N1PipelineInputs {
    /** Connected sources grouped by input index — only indices with ≥1 edge. */
    inputs: Map<number, AudioMixSource[]>;
    outputs: N1Output[];
    /** 302M word length of every output (`pcmBitDepth`). Default 16-bit. */
    pcmFormat?: S302mFormat;
    /** Mix width of every input fan-in and output mixer (`channels`). Default
     *  stereo. Mono mixes are encoded dual-mono — 302M has no 1-channel wire. */
    channels?: number;
}

/** Output indices that have ≥1 contributing input (some connected i ≠ o) —
 *  the only outputs worth building/allocating a bus port for. */
export function activeOutputIndices(
    connectedInputs: Iterable<number>,
    pairCount: number,
): number[] {
    const inputs = [...connectedInputs];
    const out: number[] = [];
    for (let o = 0; o < pairCount; o++) {
        if (inputs.some((i) => i !== o)) out.push(o);
    }
    return out;
}

/** A matrix link's least W. What it gets left `inmix<i>`, which holds its output for one of
 *  its sources' W or a pace rise: no silence, and a false absence would drop it. */
const N1_MATRIX_SILENCE_FLOOR_NS = 500_000_000;

/** The pace group of output `o`'s matrix links: its feature mixer `omix<o>`. */
export function isMatrixAligner(aligner: string): boolean {
    return /^omix\d+$/.test(aligner);
}

/** Input `i`'s link into output `o`'s mixer: its watchdog, in that mixer's pace
 *  group (house-clock part 4.4). Its FIFO replaced the 500 ms matrix queue. */
function n1MatrixLink(i: number, o: number): string {
    return (
        `mralignwatch name=omix${o}_aw${i} aligner=omix${o} input=in${i}` +
        ` silence-floor=${N1_MATRIX_SILENCE_FLOOR_NS}`
    );
}

/**
 * Assemble the full pipeline:
 *   per connected input — 302M sum (`inmix<i>`) → `tee name=in<i>t`
 *   per active output   — aligned mixer `omix<o>` → 302M encode → bus sink
 *   exclusion matrix    — `in<i>t. ! <n1MatrixLink(i, o)> ! omix<o>.` for every i ≠ o
 */
export function buildN1Pipeline(input: N1PipelineInputs): string | null {
    // An output whose only contributor would be its own pair has no branches —
    // never build a pad-less mixer.
    const outputs = input.outputs.filter((out) =>
        [...input.inputs.keys()].some((i) => i !== out.index),
    );
    if (input.inputs.size === 0 || outputs.length === 0) return null;

    const parts: string[] = [];
    const channels = input.channels ?? DEFAULT_CHANNELS;

    for (const [i, sources] of input.inputs) {
        // Live-input mode: each source is a named bin on an explicit
        // `inmix<i>` pad and the fan-in aggregator exists even for one source,
        // so a second source on an already-connected input is added or
        // removed on the running pipeline. The FIRST source on an input (or
        // its last leaving) still restarts: that input's tee and its matrix
        // links, and possibly the set of active outputs, come and go with it.
        const { fragment, continuationName } = buildAudioMixInput({
            sources,
            channels,
            mixerName: n1InputMixerName(i),
            liveInputs: true,
        });
        parts.push(`${fragment} ${continuationName}. ! tee name=in${i}t`);
    }

    // The N-1 feature mixers are aligned like the fan-ins: non-live, no budget,
    // no pacer. Their matrix links release at running time + pace, so an output
    // whose contributors all went dark runs on their gaps and never free-runs.
    const pcmFormat = input.pcmFormat ?? s302mFormatFor(undefined);
    const caps = `audio/x-raw,rate=48000,channels=${channels}`;
    for (const out of outputs) {
        const name = `omix${out.index}`;
        parts.push(
            alignedMixer({ name, caps, outName: `${name}_out` }) +
                positionedTail(channels) +
                ` ! ${build302mEncodeBranch({ format: pcmFormat, channels })}` +
                ` ! ${buildBusSink(out.port)}`,
        );
    }

    for (const out of outputs) {
        for (const i of input.inputs.keys()) {
            if (i === out.index) continue; // the N-1 exclusion
            parts.push(`in${i}t. ! ${n1MatrixLink(i, out.index)} ! omix${out.index}.`);
        }
    }

    return parts.join(' ');
}
