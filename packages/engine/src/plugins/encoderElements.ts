/**
 * Shared video-encoder element selection + CBR/VBR-tuned branch builder.
 *
 * Codec/encoder knowledge is common to every codec plugin (video-encoder,
 * transcoder, …), so it lives here rather than being forked per plugin. Kept
 * free of GStreamer/engine imports so it unit-tests with plain inputs — the
 * runtime probing that needs `probeGstElement` lives next door in
 * `encoderManifest.ts`.
 */

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
 * and read as packet loss. CBR caps the peak at the target (vbv-maxrate =
 * bitrate, no headroom) and pads to hold the rate (`nal-hrd=cbr` / `strict-cbr`),
 * matching the V4L2 hardware path (`video_bitrate_mode=1`). `vbv-bufsize` = 1 s.
 */
export type RateControl = 'cbr' | 'vbr';

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
 * Map the x264-style speed preset onto VA-API's `target-usage` (1 = best quality
 * / slowest … 7 = fastest / lowest quality), so the single "Speed preset" control
 * still has meaning on the Intel hardware encoder.
 */
const VA_TARGET_USAGE: Record<SpeedPreset, number> = {
    ultrafast: 7,
    superfast: 6,
    veryfast: 6,
    faster: 5,
    fast: 4,
    medium: 3,
    slow: 1,
};

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
}

/**
 * Build one encoder fragment ending at the parsed elementary stream.
 */
export function buildEncoderBranch(opts: EncoderBranchOptions): string {
    const {
        codec,
        impl,
        bitrateKbps,
        kif,
        name,
        rateControl = 'cbr',
        speedPreset = 'ultrafast',
        h264Profile = 'auto',
        sceneCut = 40,
        cpbSeconds = 1,
        interlacedOutput = false,
    } = opts;
    const bps = bitrateKbps * 1000;
    const cbr = rateControl !== 'vbr';
    // VBR targets `bitrate` as the AVERAGE and lets per-frame size vary for better
    // quality on motion, but bounds bursts with a VBV cap at 1.5x so it can't
    // overrun the downstream UDP/SRT buffer too hard. CBR pins peak = average
    // (vbv-maxrate = bitrate) and pads to hold the rate constant.
    const vbvMax = cbr ? bitrateKbps : Math.round(bitrateKbps * 1.5);
    // HRD buffer depth (kbit): vbv-bufsize / cpb-size = rate cap x cpbSeconds.
    const cpbKbit = Math.max(1, Math.round(vbvMax * cpbSeconds));
    if (impl === 'v4l2') {
        // video_bitrate_mode: 1 = CBR, 0 = VBR.
        const mode = cbr ? 1 : 0;
        if (codec === 'h264') {
            const prof = h264Profile === 'auto' ? '' : `,profile=${h264Profile}`;
            return `v4l2h264enc name=${name} extra-controls="controls,video_bitrate=${bps},video_bitrate_mode=${mode},h264_i_frame_period=${kif}" ! video/x-h264,level=(string)4${prof} ! h264parse config-interval=1`;
        }
        if (codec === 'h265') {
            return `v4l2h265enc name=${name} extra-controls="controls,video_bitrate=${bps},video_bitrate_mode=${mode},h265_i_frame_period=${kif}" ! h265parse config-interval=1`;
        }
    }
    if (impl === 'va') {
        // Intel VA-API hardware encoder (x86 iGPU). Its knobs differ from x264:
        // rate-control cbr/vbr, target-usage 1(best)–7(fastest) mapped from the
        // speed preset, key-int-max for the GOP. x264-only knobs (scenecut, the
        // VBV option-string) don't apply. b-frames=0 keeps latency low. vah26Xenc
        // accepts system-memory NV12, so the leaf's videoconvert feeds it directly.
        const rc = cbr ? 'cbr' : 'vbr';
        const tu = VA_TARGET_USAGE[speedPreset];
        if (codec === 'h264') {
            const profCaps = h264Profile === 'auto' ? '' : ` ! video/x-h264,profile=${h264Profile}`;
            return `vah264enc name=${name} bitrate=${bitrateKbps} rate-control=${rc} target-usage=${tu} key-int-max=${kif} b-frames=0 cpb-size=${cpbKbit}${profCaps} ! h264parse config-interval=1`;
        }
        if (codec === 'h265') {
            return `vah265enc name=${name} bitrate=${bitrateKbps} rate-control=${rc} target-usage=${tu} key-int-max=${kif} b-frames=0 cpb-size=${cpbKbit} ! h265parse config-interval=1`;
        }
        if (codec === 'av1') {
            return `vaav1enc name=${name} bitrate=${bitrateKbps} rate-control=${rc} target-usage=${tu} key-int-max=${kif} ! av1parse`;
        }
    }
    if (impl === 'software') {
        if (codec === 'h264') {
            // speed-preset trades CPU for quality. `tune=zerolatency` stays put to
            // hold latency down (no lookahead / B-frames) regardless of preset.
            // CBR adds `nal-hrd=cbr` to pad to a constant rate; VBR omits it.
            // `scenecut` inserts an adaptive keyframe at detected cuts (x264
            // default 40; 0 = off for strict fixed-GOP ABR alignment).
            const opts =
                (cbr
                    ? `nal-hrd=cbr:vbv-maxrate=${bitrateKbps}:vbv-bufsize=${cpbKbit}`
                    : `vbv-maxrate=${vbvMax}:vbv-bufsize=${cpbKbit}`) + `:scenecut=${sceneCut}`;
            // Force the profile via a src capsfilter (x264enc has no `profile`
            // property); x264 then drops CABAC / 8x8dct etc. to comply. 'auto'
            // adds no filter and leaves x264 to pick.
            const profCaps = h264Profile === 'auto' ? '' : ` ! video/x-h264,profile=${h264Profile}`;
            const ilace = interlacedOutput ? ' interlaced=true' : '';
            return `x264enc name=${name} tune=zerolatency bitrate=${bitrateKbps} speed-preset=${speedPreset} key-int-max=${kif} bframes=0${ilace} option-string="${opts}"${profCaps} ! h264parse config-interval=1`;
        }
        if (codec === 'h265') {
            const opts =
                (cbr
                    ? `vbv-maxrate=${bitrateKbps}:vbv-bufsize=${cpbKbit}:strict-cbr=1`
                    : `vbv-maxrate=${vbvMax}:vbv-bufsize=${cpbKbit}`) + `:scenecut=${sceneCut}`;
            return `x265enc name=${name} bitrate=${bitrateKbps} tune=zerolatency speed-preset=${speedPreset} key-int-max=${kif} option-string="${opts}" ! h265parse config-interval=1`;
        }
        if (codec === 'av1') {
            return `svtav1enc name=${name} target-bitrate=${bitrateKbps} preset=10 ! av1parse`;
        }
    }
    throw new Error(`Unsupported codec/impl combination: ${codec}/${impl}`);
}
