import {
    H264_PROFILES,
    SPEED_PRESETS,
    RATE_CONTROLS,
    QVBR_QUALITY_DEFAULT,
    parseResolution,
    readClampedNumber,
    readQvbrQuality,
    type CodecId,
    type H264Profile,
    type RateControl,
    type SpeedPreset,
} from '@media-router/engine';

/** `value` when it is one of `allowed`, else `fallback` — the manifest enum is
 *  the contract, but a hand-edited profile must degrade to this module's
 *  established default rather than reach the gst-launch string. */
export function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

/** The encoder knobs, validated and defaulted in one place. */
export interface EncoderKnobs {
    codec: CodecId;
    width: number;
    height: number;
    framerate: number;
    bitrateKbps: number;
    kif: number;
    rateControl: RateControl;
    speedPreset: SpeedPreset;
    h264Profile: H264Profile;
    sceneCut: number;
    cpbSeconds: number;
    /** QVBR quality target (1–51, lower = better); only read in QVBR. */
    quality: number;
}

/**
 * Read the module config into `EncoderKnobs`. Defaults are what this module
 * used to hardcode (superfast, CBR) or the shared builder's own; enums are
 * validated against their known sets. `rateControl` only reaches the software
 * and VA encoders — the v4l2 branch pins VBR (see `buildV4l2ExtraControls`).
 */
export function readEncoderKnobs(config: Record<string, unknown>): EncoderKnobs {
    const { width, height } = parseResolution((config.resolution as string) ?? '1920x1080');
    return {
        codec: (config.codec as CodecId) ?? 'h264',
        width,
        height,
        framerate: (config.framerate as number) ?? 30,
        bitrateKbps: (config.bitrate as number) ?? 4000,
        kif: (config.keyframeInterval as number) ?? 60,
        rateControl: pickEnum<RateControl>(config.rateControl, RATE_CONTROLS, 'cbr'),
        speedPreset: pickEnum<SpeedPreset>(config.speedPreset, SPEED_PRESETS, 'superfast'),
        h264Profile: pickEnum<H264Profile>(config.h264Profile, H264_PROFILES, 'auto'),
        sceneCut: typeof config.sceneCut === 'number' ? config.sceneCut : 40,
        // Clamped to 0.1–2 s like the transcoder (the manifest's range).
        cpbSeconds: readClampedNumber(config.cpbSeconds, 0.1, 2) ?? 1,
        quality: readQvbrQuality(config.quality) ?? QVBR_QUALITY_DEFAULT,
    };
}
