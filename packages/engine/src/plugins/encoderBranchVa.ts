/**
 * The Intel VA-API encoder strings (x86 iGPU) for `buildEncoderBranch`.
 */

import type { ResolvedBranch, SpeedPreset } from './encoderElements.js';

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
 * vah264enc / vah265enc / vaav1enc fragment. Its knobs differ from x264:
 * rate-control, target-usage 1(best)–7(fastest) mapped from the speed preset,
 * key-int-max for the GOP. x264-only knobs (scenecut, the VBV option-string)
 * don't apply. b-frames=0 keeps latency low. vah26Xenc accepts system-memory
 * NV12, so the leaf's videoconvert feeds it directly.
 *
 * QVBR (GStreamer 1.28 gstvah26Xenc `_ensure_rate_control`): max bitrate =
 * bitrate x 100 / target-percentage, `qpi` = the driver's quality factor.
 * target-percentage=100 makes `bitrate` the PEAK (= ffmpeg `-rc_mode QVBR
 * -global_quality q -b:v X -maxrate X`); the driver then spends less on easy
 * content. Without QVBR in the driver (and always on vaav1enc) the same
 * peak comes from `rate-control=vbr target-percentage=100` (`capped-vbr`).
 * (Plain VBR leaves target-percentage at its default 66: peak ~1.52x.)
 */
export function buildVaBranch(b: ResolvedBranch): string {
    const { codec, bitrateKbps, kif, name, rc, quality, h264Profile } = b;
    const capped = rc === 'qvbr' || rc === 'capped-vbr';
    const rcProps =
        rc === 'qvbr'
            ? `qvbr target-percentage=100 qpi=${quality}`
            : rc === 'capped-vbr'
              ? 'vbr target-percentage=100'
              : rc;
    // GStreamer's `_calculate_bitrate_hrd` drops a cpb-size under max/2 and
    // uses 2 s of max instead (QVBR 4841k at 0.4 s: 1936 asked, 9682 run), so
    // the capped modes floor it at max/2. CBR/VBR keep their strings (the same
    // flaw there is a follow-up).
    const cpb = capped ? Math.max(b.cpbKbit, Math.ceil(bitrateKbps / 2)) : b.cpbKbit;
    const tu = VA_TARGET_USAGE[b.speedPreset];
    if (codec === 'h264') {
        const profCaps = h264Profile === 'auto' ? '' : ` ! video/x-h264,profile=${h264Profile}`;
        return `vah264enc name=${name} bitrate=${bitrateKbps} rate-control=${rcProps} target-usage=${tu} key-int-max=${kif} b-frames=0 cpb-size=${cpb}${profCaps} ! h264parse config-interval=1`;
    }
    if (codec === 'h265') {
        return `vah265enc name=${name} bitrate=${bitrateKbps} rate-control=${rcProps} target-usage=${tu} key-int-max=${kif} b-frames=0 cpb-size=${cpb} ! h265parse config-interval=1`;
    }
    const av1Cpb = capped ? ` cpb-size=${cpb}` : '';
    return `vaav1enc name=${name} bitrate=${bitrateKbps} rate-control=${rcProps} target-usage=${tu} key-int-max=${kif}${av1Cpb} ! av1parse`;
}
