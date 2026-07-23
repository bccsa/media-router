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

import {
    buildAudioMixInput,
    buildBusSink,
    build302mEncodeBranch,
    type AudioMixSource,
    type DynamicPort,
} from '@media-router/engine';

export type { DynamicPort };

export const MIN_PAIRS = 2;
export const MAX_PAIRS = 16;
export const DEFAULT_PAIRS = 4;

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
    /** Per-input mix latency budget (ms) — the wait for lagging SOURCES. */
    latencyMs: number;
}

// The output mixers bridge only intra-pipeline jitter between the input
// stages' continuous force-live streams — a fixed small budget, NOT the
// configurable source-side latency (reusing it would double the audible
// latency to every output).
const OUTPUT_MIX_LATENCY_NS = 50_000_000;

/**
 * Assemble the full pipeline:
 *   per connected input  — 302M sum (`inmix{i}`) → `tee name=in{i}t`
 *   per active output    — `audiomixer omix{o}` → 302M encode → bus sink
 *   exclusion matrix     — `in{i}t. ! queue ! omix{o}.` for every i ≠ o
 */
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

export function buildN1Pipeline(input: N1PipelineInputs): string | null {
    // An output whose only contributor would be its own pair has no branches —
    // never build a pad-less force-live mixer.
    const outputs = input.outputs.filter((out) =>
        [...input.inputs.keys()].some((i) => i !== out.index),
    );
    if (input.inputs.size === 0 || outputs.length === 0) return null;

    const parts: string[] = [];

    for (const [i, sources] of input.inputs) {
        const { fragment, mixerName } = buildAudioMixInput({
            sources,
            channels: 2,
            latencyMs: input.latencyMs,
            mixerName: `inmix${i}`,
        });
        parts.push(`${fragment} ${mixerName}. ! tee name=in${i}t`);
    }

    for (const out of outputs) {
        const sink = buildBusSink(out.port);
        parts.push(
            `audiomixer name=omix${out.index} force-live=true ` +
                `latency=${OUTPUT_MIX_LATENCY_NS} min-upstream-latency=${OUTPUT_MIX_LATENCY_NS}` +
                ' ! audio/x-raw,rate=48000,channels=2' +
                ` ! ${build302mEncodeBranch()} ! ${sink}`,
        );
    }

    // NON-leaky matrix queues, sized well past one source PES batch (same
    // rationale as the transcoder's leaf queues — decoders release audio in
    // ~150 ms bursts, and a small leaky queue here would shed most of every
    // burst). Encode leaves drain ≫ real-time, so no deadlock.
    for (const out of outputs) {
        for (const i of input.inputs.keys()) {
            if (i === out.index) continue; // the N-1 exclusion
            parts.push(
                `in${i}t. ! queue leaky=0 max-size-time=500000000` +
                    ` max-size-buffers=0 max-size-bytes=0 ! omix${out.index}.`,
            );
        }
    }

    return parts.join(' ');
}
