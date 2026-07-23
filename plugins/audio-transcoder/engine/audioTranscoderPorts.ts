/**
 * Dynamic-port + rendition config helpers for the audio transcoder.
 *
 * Pure and dependency-free (plain inputs → plain outputs) so they unit-test on
 * their own and stay decoupled from the GStreamer pipeline assembly in
 * `audioTranscoderPipeline.ts`.
 */

import type { DynamicPort } from '@media-router/engine';

export type { DynamicPort };

export type AudioCodec = 'opus' | 'aac' | 'pcm';

const AUDIO_CODECS: readonly AudioCodec[] = ['opus', 'aac', 'pcm'];

/** One configured output rendition. Opus knobs are per-rendition (they shape
 *  that rendition's encoder only); absent values take the schema defaults. */
export interface Rendition {
    name: string;
    codec: AudioCodec;
    bitrate: number;
    frameSize?: number;
    inbandFec?: boolean;
    packetLoss?: number;
    audioType?: number;
}

/** A rendition with its allocated bus channel. */
export interface AudioTranscoderOutput {
    portId: string;
    port: number;
    rendition: Rendition;
}

/** The single input port. Id stays `mpegts-in` for wire-compat with existing
 *  graphs (the former separate `audio-in` 302M port was folded into it). */
export const INPUT_PORT_ID = 'mpegts-in';
const OUTPUT_PORT_PREFIX = 'out-';
const MAX_RENDITIONS = 8;

/**
 * Provisional rendition used only when config carries none — the engine
 * resolves `getDynamicPorts` once BEFORE the module starts, when `this.config`
 * is still empty, and the node should show an output port immediately on add.
 * Kept in sync with the manifest's `renditions` default (video-transcoder
 * pattern).
 */
const DEFAULT_RENDITION: Rendition = { name: 'PCM 302M', codec: 'pcm', bitrate: 128 };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

/**
 * Read + sanitise the rendition list from config. Enum fields are strictly
 * validated (unknown codec collapses to 'opus'), numerics coerced — a
 * malformed config can never splice junk into the gst-launch string.
 */
export function readRenditions(config: Record<string, unknown>): Rendition[] {
    const arr = config.renditions;
    // Key absent → unconfigured/pre-start: surface the provisional rendition so
    // a port exists. An explicit array (even empty) is the operator's choice.
    if (!Array.isArray(arr)) return [{ ...DEFAULT_RENDITION }];
    return arr.slice(0, MAX_RENDITIONS).map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        const codec =
            typeof e.codec === 'string' && (AUDIO_CODECS as readonly string[]).includes(e.codec)
                ? (e.codec as AudioCodec)
                : 'opus';
        return {
            name: typeof e.name === 'string' ? e.name : '',
            codec,
            bitrate: toPositiveInt(e.bitrate, 128),
            frameSize: toOptionalNumber(e.frameSize),
            inbandFec: typeof e.inbandFec === 'boolean' ? e.inbandFec : undefined,
            packetLoss: toOptionalNumber(e.packetLoss),
            audioType: toOptionalNumber(e.audioType),
        };
    });
}

function toPositiveInt(value: unknown, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** Display label for a rendition's port: operator name, else codec + bitrate. */
export function renditionLabel(r: Rendition): string {
    if (r.name.trim()) return r.name.trim();
    if (r.codec === 'pcm') return 'PCM 302M';
    return `${r.codec === 'opus' ? 'Opus' : 'AAC'} ${r.bitrate}k`;
}

/**
 * Build the dynamic port list: one fixed single-source input + one output per
 * rendition. The input accepts any TS-family source (muxed TS of any codec,
 * or a 302M stream — the probe picks the decoder); summing several sources
 * is the audio-mixer plugin's job, so this port is capped at 1.
 */
export function buildDynamicPorts(renditions: Rendition[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'Audio In',
            maxConnections: 1,
            acceptsAnyTs: true,
        },
    ];
    renditions.forEach((r, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: r.codec === 'pcm' ? 'audio/302m' : 'muxed/mpegts',
            label: renditionLabel(r),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });
    return ports;
}
