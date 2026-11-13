/**
 * The V4L2 (Pi bcm2835) encoder strings for `buildEncoderBranch`. Rate control
 * does not reach this driver: it only works in VBR (see below).
 */

import type { ResolvedBranch } from './encoderElements.js';

/**
 * The `extra-controls` value for v4l2h264enc / v4l2h265enc — the V4L2 driver's
 * rate-control struct, unquoted (the caller supplies the quotes when it goes
 * into a gst-launch string).
 *
 * Shared with the live-bitrate path: the driver stores the FULL controls struct
 * from the last write, so a live update must re-send every field — dropping
 * `video_bitrate_mode` silently reverts the mode chosen at build time.
 *
 * `video_bitrate_mode` is PINNED to 0 (VBR) — there is no CBR option. The
 * bcm2835 encoder in CBR mode throttles to ~10 fps on live input (kernel 6.12,
 * gst 1.28, measured 2026-09-02 on a Pi 4: 250 live 1080p25 frames take 24.1 s
 * with mode=1 at ANY bitrate — 2, 6.9 and 20 Mbps identically — vs 11.1 s
 * ≈ real time with mode=0; h264_profile, h264_level and the caps level string
 * are all irrelevant to the stall). The v1 encoder shipped mode=0 for years,
 * field-proven; the firmware still targets `video_bitrate` as the average,
 * which is what callers configuring "CBR" actually need from this device.
 *
 * `video_gop_size` AND `h264_i_frame_period` are both set to the keyframe
 * interval: the driver exposes both (defaults 60) and which one the firmware
 * honours is undocumented — v1 set `video_gop_size`, the standard control is
 * the other. `repeat_sequence_header=1` (v1 parity) makes the raw stream
 * self-describing at any join point, independent of the downstream
 * h264parse config-interval re-insertion.
 */
export function buildV4l2ExtraControls(
    codec: 'h264' | 'h265',
    bitrateBps: number,
    kif: number,
): string {
    return (
        `controls,video_bitrate=${bitrateBps},video_bitrate_mode=0,` +
        `repeat_sequence_header=1,video_gop_size=${kif},${codec}_i_frame_period=${kif}`
    );
}

/** v4l2h264enc / v4l2h265enc fragment; null for a codec the block can't encode. */
export function buildV4l2Branch(b: ResolvedBranch): string | null {
    const { codec, bitrateKbps, kif, name, h264Profile } = b;
    const bps = bitrateKbps * 1000;
    if (codec === 'h264') {
        const controls = buildV4l2ExtraControls('h264', bps, kif);
        const prof = h264Profile === 'auto' ? '' : `,profile=${h264Profile}`;
        // Level 4.2: kernel 6.12 validates the declared level against
        // resolution x framerate at STREAMON and rejects 1080p50 at level 4
        // ("Failed enabling i/p port"); 4.2 covers 1080p60. The 2026-09-01
        // finding that "level=4.2 in the caps drops the encoder to ~13 fps"
        // (which reverted this to 4 for a day) was a misattribution — the
        // confound was CBR mode (see `buildV4l2ExtraControls`); with VBR
        // pinned, 4.2 caps run at full rate (re-measured 2026-09-02, live
        // 1080p25: 250 frames in 11.1 s with 4.2 vs 11.1 s with 4).
        return `v4l2h264enc name=${name} extra-controls="${controls}" ! video/x-h264,level=(string)4.2${prof} ! h264parse config-interval=1`;
    }
    if (codec === 'h265') {
        const controls = buildV4l2ExtraControls('h265', bps, kif);
        return `v4l2h265enc name=${name} extra-controls="${controls}" ! h265parse config-interval=1`;
    }
    return null;
}
