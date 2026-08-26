/**
 * Chain shape decisions for the Audio Processing module — which stages exist,
 * which edge feeds which pin, and what the operator is told about it. Pure
 * apart from the injected LADSPA resolver, so every branch is testable without
 * a gst registry.
 */

import type { AudioMixSource } from '@media-router/plugin-audio-302m-core';
import { EQ_BANDS } from './eqBands.js';
import { isLadspaDynMode } from './lspConfig.js';
import {
    DYN_SUFFIXES,
    EQ_SUFFIX,
    LIMITER_SUFFIX,
    type ChainStages,
    type DynamicsMode,
} from './lspProcessing.js';

export const PROGRAM_PORT = 'program-in';
export const SIDECHAIN_PORT = 'sidechain-in';
export const OUTPUT_PORT = 'audio-out';

/** Config keys the module accepts without a pipeline restart. Everything here
 *  either resolves to an element property (`resolveLiveTarget`) or is read
 *  live by the ducker envelope. `gateKey` is deliberately absent: self vs
 *  sidechain selects a different ELEMENT, so it needs a restart. */
export const LIVE_PARAMS: string[] = [
    // Dynamics (shared with the ducker envelope, resolved by mode)
    'threshold',
    'duckDepth',
    'hold',
    'ratio',
    'attack',
    'release',
    'knee',
    'makeupGain',
    'gateDepth',
    // High-pass
    'hpfFreq',
    // EQ
    'eqBypass',
    'eqInputGain',
    'eqOutputGain',
    'eqMode',
    'eqSlope',
    ...Array.from({ length: EQ_BANDS }, (_, i) => [
        `eqBand${i}Type`,
        `eqBand${i}Freq`,
        `eqBand${i}Gain`,
        `eqBand${i}Q`,
    ]).flat(),
    // Limiter
    'limiterThreshold',
    'limiterAttack',
    'limiterRelease',
    'limiterLookahead',
];

/**
 * Split the module's incoming 302M edges across the two input pins in ONE
 * pass, so every edge lands in exactly one bucket: audio wired to Sidechain
 * can never be consumed as programme audio, and an edge on a pin this module
 * doesn't know is dropped rather than defaulted into the programme mix. Both
 * buckets come from the SAME snapshot, so they can't disagree about an edge
 * that appears or vanishes mid-build.
 */
export function partitionBusSources(sources: Array<AudioMixSource & { sinkPortId?: string }>): {
    program: AudioMixSource[];
    sidechain: AudioMixSource[];
} {
    const program: AudioMixSource[] = [];
    const sidechain: AudioMixSource[] = [];
    for (const s of sources) {
        if (s.sinkPortId === PROGRAM_PORT) program.push(s);
        else if (s.sinkPortId === SIDECHAIN_PORT) sidechain.push(s);
    }
    return { program, sidechain };
}

/**
 * Decide the chain shape and resolve every LADSPA element it needs.
 * `requireLadspa` is expected to THROW for an enabled stage whose element is
 * missing — silently dropping a requested processing stage on a broadcast path
 * is worse than refusing to start.
 */
export async function resolveChainStages(
    config: Record<string, unknown>,
    mode: DynamicsMode,
    hasSidechain: boolean,
    requireLadspa: (suffix: string) => Promise<string>,
): Promise<ChainStages> {
    // A keyed gate needs BOTH the operator's choice and a key actually wired;
    // without one it falls back to the self-keyed `gate-stereo`, and
    // `stages.keyedGate` is what the property emission keys off too.
    const wantsKeyedGate = mode === 'gate' && config.gateKey === 'sidechain' && hasSidechain;

    const stages: ChainStages = {
        hpf: config.hpfEnabled === true,
        eqElement: null,
        dynElement: null,
        dynMode: mode,
        keyedGate: wantsKeyedGate,
        limiterElement: null,
        duckerKey: mode === 'ducker' && hasSidechain,
    };

    if (config.eqEnabled === true) {
        stages.eqElement = await requireLadspa(EQ_SUFFIX);
    }
    if (isLadspaDynMode(mode)) {
        stages.dynElement = await requireLadspa(
            wantsKeyedGate ? DYN_SUFFIXES.gateSidechain : DYN_SUFFIXES[mode],
        );
    }
    if (config.limiterEnabled === true) {
        stages.limiterElement = await requireLadspa(LIMITER_SUFFIX);
    }
    return stages;
}

export interface ChainSummary {
    data: { chain: string; sidechain: string };
    health: { level: 'ok' | 'warning'; message?: string };
}

/**
 * Chain summary + the two health warnings worth surfacing: a key-hungry mode
 * with nothing wired to the sidechain pin, and its mirror — audio wired to the
 * sidechain pin that no mode is keying off. The second is the silent case
 * operators fall for: the edge is deliberately left unconsumed (a key is never
 * programme audio), so without a note the wire simply appears to do nothing.
 */
export function chainSummary(
    stages: ChainStages,
    gateKey: unknown,
    sidechainCount: number,
): ChainSummary {
    const mode = stages.dynMode;
    const chain = [
        stages.hpf ? 'HPF' : null,
        stages.eqElement ? 'EQ' : null,
        mode === 'none' ? null : mode,
        stages.limiterElement ? 'limiter' : null,
    ].filter(Boolean);
    const wantsKey = mode === 'ducker' || (mode === 'gate' && gateKey === 'sidechain');

    const data = {
        chain: chain.length > 0 ? chain.join(' → ') : 'bypass (no stages enabled)',
        sidechain:
            sidechainCount === 0
                ? 'not connected'
                : wantsKey
                  ? `${sidechainCount} source(s)`
                  : `${sidechainCount} source(s) — unused by ${mode} mode`,
    };

    if (wantsKey && sidechainCount === 0) {
        return {
            data,
            health: {
                level: 'warning',
                message: `${mode === 'ducker' ? 'Ducker' : 'Sidechain gate'} has no sidechain source — wire 302M audio to Sidechain`,
            },
        };
    }
    if (!wantsKey && sidechainCount > 0) {
        return {
            data,
            health: {
                level: 'warning',
                message:
                    'Sidechain input is wired but nothing keys off it — set the dynamics mode to Ducker ' +
                    'or a sidechain-keyed Gate, or remove the connection (it is NOT mixed into the programme)',
            },
        };
    }
    return { data, health: { level: 'ok' } };
}
