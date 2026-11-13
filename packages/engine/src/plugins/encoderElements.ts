/**
 * Shared video-encoder element selection + CBR/VBR/QVBR-tuned branch builder
 * (the per-impl strings live in `encoderBranchV4l2.ts`, `encoderBranchVa.ts`
 * and `encoderBranchSoftware.ts`).
 *
 * Codec/encoder knowledge is common to every codec plugin (video-encoder,
 * transcoder, …), so it lives here rather than being forked per plugin. Kept
 * free of GStreamer/engine imports so it unit-tests with plain inputs — the
 * runtime probing that needs `probeGstElement` lives next door in
 * `encoderManifest.ts`.
 */

import { readClampedNumber } from './configNumber.js';
import { buildV4l2Branch } from './encoderBranchV4l2.js';
import { buildVaBranch } from './encoderBranchVa.js';
import { buildSoftwareBranch } from './encoderBranchSoftware.js';

export { buildV4l2ExtraControls } from './encoderBranchV4l2.js';

export type CodecId = 'h264' | 'h265' | 'av1';
/** v4l2 = SoC hardware block (Pi), va = Intel VA-API iGPU (x86), software = x264/x265/svt. */
export type ImplId = 'v4l2' | 'va' | 'software';

/** GStreamer element name for each {codec × impl} combination. */
export const ENCODER_ELEMENTS: Record<CodecId, Partial<Record<ImplId, string>>> = {
    h264: { v4l2: 'v4l2h264enc', va: 'vah264enc', software: 'x264enc' },
    h265: { v4l2: 'v4l2h265enc', va: 'vah265enc', software: 'x265enc' },
    av1: { va: 'vaav1enc', software: 'svtav1enc' }, // Pi 5 has no HW AV1; Intel iGPU may
};

/**
 * Resolve the actual impl to use at runtime. Consults the runtime probe results
 * (passed in) so `auto` picks an impl that's actually installed rather than one
 * that just appears in the static element table. Returns `null` when no impl is
 * available — caller should fail the pipeline build.
 */
export function resolveImpl(
    codec: CodecId,
    preference: ImplId | 'auto',
    available: ImplId[],
): ImplId | null {
    if (available.length === 0) return null;
    if (preference === 'auto') {
        // Prefer a dedicated hardware block (v4l2) if present, then software
        // (x264/x265 — keeps its rich tuning), falling back to any remaining
        // impl (e.g. VA-API when it's the only encoder for a codec, as with
        // H.265 on an Intel box that has no x265enc).
        if (available.includes('v4l2')) return 'v4l2';
        if (available.includes('software')) return 'software';
        return available[0];
    }
    if (available.includes(preference)) return preference;
    return available[0];
}

/**
 * CBR (constant bitrate): fixed-bandwidth UDP/MPEG-TS can't absorb the bursts a
 * VBR encoder emits on fast motion — they overrun the downstream jitter buffer
 * and read as packet loss. CBR caps the peak at the target and, on VA-API and
 * x265 (`strict-cbr`), pads to hold the rate. `cpbSeconds` sets the buffer. VBR
 * targets the bitrate as the AVERAGE with a 1.5x peak. The V4L2 (bcm2835) path
 * pins VBR — see `buildV4l2ExtraControls`.
 *
 * x264 exception (GStreamer >= 1.26, a follow-up fixes it): x264enc assigns its
 * own `nal-hrd` property after the option-string (so `nal-hrd=cbr` there is
 * dead) and its `pass` switch overwrites the option-string VBV with vbv-maxrate
 * = bitrate, vbv-bufsize = 600 ms. x264 CBR and VBR are therefore one config
 * today: no padding, peak 1.0x, 600 ms buffer, `cpbSeconds` ignored.
 *
 * QVBR (quality-targeted VBR): the bitrate is a CEILING, not a target — the
 * encoder aims at a quality level (`quality`, CRF-like, lower = better) and
 * spends less than the ceiling on easy content. Peak = bitrate, buffer =
 * bitrate x cpbSeconds, no padding. VA-API maps it to the driver's QVBR mode
 * (or capped VBR without it), x264/x265/svtav1 to capped CRF; V4L2 stays VBR.
 * See {@link effectiveRateControl}.
 */
export type RateControl = 'cbr' | 'vbr' | 'qvbr';

/** Allowed rate-control modes — also used to validate untrusted config. */
export const RATE_CONTROLS: RateControl[] = ['cbr', 'vbr', 'qvbr'];

/** QVBR quality when none is configured (CRF-like scale, lower = better). */
export const QVBR_QUALITY_DEFAULT = 25;

/**
 * Read a QVBR quality value from untrusted config: rounded and clamped to 1–51
 * (VA-API `qpi` / x265 CRF range); blank or non-numeric = `undefined`.
 */
export function readQvbrQuality(value: unknown): number | undefined {
    return readClampedNumber(value, 1, 51, true);
}

/**
 * The rate control the encoder actually runs — what status text must show.
 * `capped-vbr` is VA-API VBR with target-percentage=100 (peak = bitrate): QVBR
 * where the driver lacks it, and always on `vaav1enc` (its QVBR quality is a
 * 0–255 qindex, not this 1–51 scale). V4L2 is always VBR.
 */
export type EffectiveRateControl = RateControl | 'capped-vbr';

export function effectiveRateControl(opts: {
    codec: CodecId;
    impl: ImplId;
    rateControl?: RateControl;
    vaQvbr?: boolean;
}): EffectiveRateControl {
    const { codec, impl, rateControl, vaQvbr = true } = opts;
    if (impl === 'v4l2') return 'vbr';
    if (rateControl === 'vbr') return 'vbr';
    if (rateControl !== 'qvbr') return 'cbr';
    if (impl === 'va') return vaQvbr && codec !== 'av1' ? 'qvbr' : 'capped-vbr';
    return 'qvbr';
}

/**
 * x264/x265 speed↔quality preset, ordered fastest→slowest. Faster presets cost
 * less CPU but block up on hard content (fast motion, fine/scrolling text);
 * slower presets spend more CPU for better quality at the same bitrate. Only the
 * software x264/x265 encoders honour it — V4L2 hardware and svtav1 ignore it.
 */
export type SpeedPreset =
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow';

/** Allowed presets fastest→slowest — also used to validate untrusted config. */
export const SPEED_PRESETS: SpeedPreset[] = [
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
];

/**
 * H.264 output profile — constrains encoder features for decoder compatibility.
 * `baseline` is the most widely decodable (no CABAC / B-frames — best for old or
 * embedded/hardware decoders); `main` adds CABAC; `high` adds the 8x8 transform
 * for the best efficiency. `auto` lets the encoder pick. H.264 only (H.265/AV1
 * ignore it).
 */
export type H264Profile = 'auto' | 'baseline' | 'main' | 'high';
export const H264_PROFILES: H264Profile[] = ['auto', 'baseline', 'main', 'high'];

/**
 * Options for {@link buildEncoderBranch}. `codec`, `impl`, `bitrateKbps`, `kif`
 * and `name` are required; the rest default to the transcoder's ABR-safe values
 * (CBR, ultrafast, auto profile, scenecut 40). `name` lets each rendition's
 * encoder get a distinct element name (`venc_0`, `venc_1`, …) so several coexist
 * in one pipeline.
 */
export interface EncoderBranchOptions {
    codec: CodecId;
    impl: ImplId;
    bitrateKbps: number;
    /** Keyframe interval in FRAMES (x264/x265 key-int-max). */
    kif: number;
    name: string;
    rateControl?: RateControl;
    speedPreset?: SpeedPreset;
    h264Profile?: H264Profile;
    sceneCut?: number;
    /** HRD/CPB depth in seconds of the rate cap (default 1). Bounds the encoder's
     *  worst-case burst — above all scene-cut keyframes: a fixed-rate link
     *  serializes an oversized IDR over hundreds of ms, landing it (and every
     *  frame queued behind it) past the receiver's deadline (measured live:
     *  409 KB IDR at 5 Mbps CBR → ~370 ms late at the far end → vMix video
     *  drops ~10:1 over audio, OBS audio stutter). Maps to x264/x265
     *  `vbv-bufsize` and VA-API `cpb-size` (which otherwise defaults to
     *  "auto" — effectively unbounded, violating this module's CBR contract).
     *  Smaller = tighter burst bound / lower keyframe quality. */
    cpbSeconds?: number;
    /** The frames being encoded are interlaced fields passed through undeinterlaced
     *  (transcoder "keep interlaced" mode). Only x264 can signal this in the
     *  bitstream (`interlaced=true`); VA-API/V4L2 have no interlaced encode mode,
     *  so the flag is ignored there and their output stays progressive-flagged. */
    interlacedOutput?: boolean;
    /** QVBR only: the quality target, 1–51, lower = better (default
     *  {@link QVBR_QUALITY_DEFAULT}). VA-API `qpi` (the driver's quality
     *  factor), x264 CRF (capped at x264enc's 50), x265 CRF, SVT-AV1 CRF. */
    quality?: number;
    /** Does this host's VA driver offer QVBR for this codec's VA element? (The
     *  `rate-control` enum is built per driver, so an absent `qvbr` would fail
     *  the launch string.) Probed by `ProbedEncoders`; default true. When false,
     *  QVBR on VA falls back to `rate-control=vbr target-percentage=100`. */
    vaQvbr?: boolean;
}

/** {@link EncoderBranchOptions} with every default applied and the rate control
 *  resolved — what the per-impl builders take. */
export interface ResolvedBranch {
    codec: CodecId;
    bitrateKbps: number;
    kif: number;
    name: string;
    /** As run, see {@link effectiveRateControl}. */
    rc: EffectiveRateControl;
    speedPreset: SpeedPreset;
    h264Profile: H264Profile;
    sceneCut: number;
    cpbSeconds: number;
    interlacedOutput: boolean;
    quality: number;
    /** Rate cap (kbps): 1.5x bitrate for VBR, else the bitrate. */
    vbvMax: number;
    /** HRD buffer (kbit): vbvMax x cpbSeconds. */
    cpbKbit: number;
}

/**
 * Build one encoder fragment ending at the parsed elementary stream.
 */
export function buildEncoderBranch(opts: EncoderBranchOptions): string {
    const { codec, impl, bitrateKbps, rateControl = 'cbr', cpbSeconds = 1 } = opts;
    const rc = effectiveRateControl({ codec, impl, rateControl, vaQvbr: opts.vaQvbr });
    // VBR bounds bursts with a VBV cap at 1.5x so it can't overrun the
    // downstream UDP/SRT buffer too hard; CBR and QVBR pin the peak at bitrate.
    const vbvMax = rateControl === 'vbr' ? Math.round(bitrateKbps * 1.5) : bitrateKbps;
    const b: ResolvedBranch = {
        codec,
        bitrateKbps,
        kif: opts.kif,
        name: opts.name,
        rc,
        speedPreset: opts.speedPreset ?? 'ultrafast',
        h264Profile: opts.h264Profile ?? 'auto',
        sceneCut: opts.sceneCut ?? 40,
        cpbSeconds,
        interlacedOutput: opts.interlacedOutput ?? false,
        // Re-validated here: a stray value must never splice into the string.
        quality: readQvbrQuality(opts.quality) ?? QVBR_QUALITY_DEFAULT,
        vbvMax,
        cpbKbit: Math.max(1, Math.round(vbvMax * cpbSeconds)),
    };
    const branch =
        impl === 'v4l2'
            ? buildV4l2Branch(b)
            : impl === 'va'
              ? buildVaBranch(b)
              : impl === 'software'
                ? buildSoftwareBranch(b)
                : null;
    if (branch === null) throw new Error(`Unsupported codec/impl combination: ${codec}/${impl}`);
    return branch;
}
