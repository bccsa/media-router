/**
 * Dynamic-port + rendition config helpers for the video transcoder.
 *
 * Pure and dependency-free (plain inputs → plain outputs) so they unit-test on
 * their own and stay decoupled from the GStreamer pipeline assembly in
 * `transcoderPipeline.ts`. The only engine imports are the encoder enum
 * type/const definitions used to validate per-rendition override values —
 * constants, no runtime dependency on the pipeline.
 */

import {
    SPEED_PRESETS,
    H264_PROFILES,
    type CodecId,
    type H264Profile,
    type ImplId,
    type RateControl,
    type SpeedPreset,
} from '@media-router/engine';

export type PortDirection = 'input' | 'output';

/** Encoder-impl selector as it appears in config — a concrete impl or 'auto'. */
export type ImplChoice = ImplId | 'auto';

const CODEC_IDS: readonly CodecId[] = ['h264', 'h265', 'av1'];
const ENCODER_IMPLS: readonly ImplChoice[] = ['auto', 'v4l2', 'va', 'software'];
const RATE_CONTROLS: readonly RateControl[] = ['cbr', 'vbr'];

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
    /** Output ports carry MPEG-TS, so downstream consumers must wait for this
     *  pipeline to be PLAYING before they can be wired — same contract as the
     *  encoder / muxer outputs. */
    requiresOrderedApply?: boolean;
}

/**
 * Optional per-rendition encoder overrides. Every field is optional: an absent
 * value means "inherit the module-global setting". Only the encode-branch knobs
 * are overridable — framerate / GOP / buffer / decode-threading stay global
 * (single shared decoder + ABR keyframe alignment). Resolution of override ??
 * global happens in TranscoderModule, not here.
 */
export interface RenditionOverrides {
    codec?: CodecId;
    encoderImpl?: ImplChoice;
    rateControl?: RateControl;
    speedPreset?: SpeedPreset;
    h264Profile?: H264Profile;
    sceneCut?: number;
}

/** One configured output rendition (size/bitrate + optional encoder overrides). */
export interface Rendition extends RenditionOverrides {
    name: string;
    width: number;
    height: number;
    bitrate: number;
}

/**
 * Fully-resolved per-rendition encoder settings (override ?? global, with the
 * impl resolved to a concrete element). Built by TranscoderModule and consumed
 * by the pipeline leaf builder — no `auto`, no undefined.
 */
export interface ResolvedEncode {
    codec: CodecId;
    impl: ImplId;
    rateControl: RateControl;
    speedPreset: SpeedPreset;
    h264Profile: H264Profile;
    sceneCut: number;
}

/** A rendition with its allocated bus channel + resolved encoder settings. */
export interface TranscoderOutput {
    portId: string;
    port: number;
    rendition: Rendition;
    encode: ResolvedEncode;
}

const INPUT_PORT_ID = 'mpegts-in';
const OUTPUT_PORT_PREFIX = 'out-';
const MAX_RENDITIONS = 8;

/**
 * Provisional rendition used only when config carries none. The engine resolves
 * `getDynamicPorts` once BEFORE the module starts — at which point the plugin's
 * `this.config` is still empty (config is applied in `onInit`, during start).
 * Returning at least one rendition here means the node shows an output port
 * immediately on add (the engine re-resolves with the real config once the
 * module is running, e.g. on connection-apply). Mirrors how the MPEG-TS muxer's
 * `?? 1` stream-count default keeps its ports visible pre-start. Kept in sync
 * with the first entry of the manifest's `renditions` default.
 */
const DEFAULT_RENDITION: Rendition = { name: '720p', width: 1280, height: 720, bitrate: 2500 };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

/**
 * Read + sanitise the rendition list from config. Coerces the numeric fields
 * and clamps the count, so a malformed config can never splice junk into the
 * gst-launch string. A blank/missing name is left empty (the caller falls back
 * to the `WxH` resolution as the label).
 */
export function readRenditions(config: Record<string, unknown>): Rendition[] {
    const arr = config.renditions;
    // Key absent → unconfigured/pre-start: surface one provisional rendition so a
    // port exists (see DEFAULT_RENDITION). An explicit array (even empty) is the
    // operator's real choice and is honoured as-is.
    if (!Array.isArray(arr)) return [{ ...DEFAULT_RENDITION }];
    return arr.slice(0, MAX_RENDITIONS).map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        // Overrides are strictly validated: a value not in the known enum set (or
        // a blank "inherit" sentinel) collapses to undefined = inherit global, so
        // a malformed config can never splice junk into the gst-launch string.
        return {
            name: typeof e.name === 'string' ? e.name : '',
            width: toPositiveInt(e.width, 1280),
            height: toPositiveInt(e.height, 720),
            bitrate: toPositiveInt(e.bitrate, 2500),
            codec: readEnum(e.codec, CODEC_IDS),
            encoderImpl: readEnum(e.encoderImpl, ENCODER_IMPLS),
            rateControl: readEnum(e.rateControl, RATE_CONTROLS),
            speedPreset: readEnum(e.speedPreset, SPEED_PRESETS),
            h264Profile: readEnum(e.h264Profile, H264_PROFILES),
            sceneCut: readSceneCutOverride(e.sceneCut),
        };
    });
}

function toPositiveInt(value: unknown, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Keep a string override only if it's in the allowed set; else inherit (undefined). */
function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : undefined;
}

/** Scene-cut override: blank/absent = inherit; otherwise clamp to x264's 0–100. */
function readSceneCutOverride(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

/** Display label for a rendition's port: operator name, else `WxH`. */
export function renditionLabel(r: Rendition): string {
    if (r.name.trim()) return r.name.trim();
    return `${r.width}x${r.height}`;
}

/**
 * Build the dynamic port list: one MPEG-TS input + one output per rendition.
 * The input is always present so a source can be wired before any rendition is
 * configured.
 */
export function buildDynamicPorts(renditions: Rendition[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
    ];
    renditions.forEach((r, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: renditionLabel(r),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });
    return ports;
}
