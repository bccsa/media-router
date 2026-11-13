/**
 * The software encoder strings (x264 / x265 / SVT-AV1) for `buildEncoderBranch`.
 */

import type { ResolvedBranch } from './encoderElements.js';

/** x264enc / x265enc / svtav1enc fragment. */
export function buildSoftwareBranch(b: ResolvedBranch): string {
    const { codec, bitrateKbps, kif, name, rc, quality, sceneCut, speedPreset } = b;
    const { vbvMax, cpbKbit } = b;
    if (codec === 'h264') {
        // speed-preset trades CPU for quality. `tune=zerolatency` stays put to
        // hold latency down (no lookahead / B-frames) regardless of preset.
        // `scenecut` inserts an adaptive keyframe at detected cuts (x264
        // default 40; 0 = off for strict fixed-GOP ABR alignment).
        // Force the profile via a src capsfilter (x264enc has no `profile`
        // property); x264 then drops CABAC / 8x8dct etc. to comply. 'auto'
        // adds no filter and leaves x264 to pick.
        const profCaps = b.h264Profile === 'auto' ? '' : ` ! video/x-h264,profile=${b.h264Profile}`;
        const ilace = b.interlacedOutput ? ' interlaced=true' : '';
        if (rc === 'qvbr') {
            // Capped CRF. x264enc applies option-string BEFORE its `pass`
            // switch, and `pass=qual` then sets vbv-maxrate = `bitrate` and
            // vbv-bufsize = bitrate x vbv-buf-capacity (ms) itself — so the
            // cap goes through those properties, not the option-string. The
            // buffer starts 90 % full: worst 1 s ≈ bitrate x (1 + 0.9 x cpbSeconds).
            const crf = Math.min(50, quality); // x264enc `quantizer` is 0–50
            const vbvMs = Math.max(1, Math.round(b.cpbSeconds * 1000));
            return `x264enc name=${name} tune=zerolatency bitrate=${bitrateKbps} pass=qual quantizer=${crf} vbv-buf-capacity=${vbvMs} speed-preset=${speedPreset} key-int-max=${kif} bframes=0${ilace} option-string="scenecut=${sceneCut}"${profCaps} ! h264parse config-interval=1`;
        }
        // CBR/VBR: the option-string's `nal-hrd` and VBV are overwritten by
        // x264enc (see the RateControl doc) — a follow-up fixes it.
        const opts =
            (rc === 'cbr'
                ? `nal-hrd=cbr:vbv-maxrate=${bitrateKbps}:vbv-bufsize=${cpbKbit}`
                : `vbv-maxrate=${vbvMax}:vbv-bufsize=${cpbKbit}`) + `:scenecut=${sceneCut}`;
        return `x264enc name=${name} tune=zerolatency bitrate=${bitrateKbps} speed-preset=${speedPreset} key-int-max=${kif} bframes=0${ilace} option-string="${opts}"${profCaps} ! h264parse config-interval=1`;
    }
    if (codec === 'h265') {
        // QVBR = capped CRF: x265enc applies option-string AFTER its own
        // ABR setup, and `crf=` switches libx265 to CRF mode.
        const rcOpts =
            rc === 'qvbr'
                ? `crf=${quality}:vbv-maxrate=${bitrateKbps}:vbv-bufsize=${cpbKbit}`
                : rc === 'cbr'
                  ? `vbv-maxrate=${bitrateKbps}:vbv-bufsize=${cpbKbit}:strict-cbr=1`
                  : `vbv-maxrate=${vbvMax}:vbv-bufsize=${cpbKbit}`;
        const opts = `${rcOpts}:scenecut=${sceneCut}`;
        return `x265enc name=${name} bitrate=${bitrateKbps} tune=zerolatency speed-preset=${speedPreset} key-int-max=${kif} option-string="${opts}" ! h265parse config-interval=1`;
    }
    if (rc === 'qvbr') {
        // SVT capped CRF: `crf` (SVT's 1–63 scale) with target-bitrate left 0,
        // and the cap through parameters-string, which gstsvtav1enc applies
        // after its own rate-control setup. `mbr-overshoot-pct=0` holds the
        // cap: at the default, snow at mbr 2500 averaged 3.6 Mbps; at 0, 2.44.
        // (max-bitrate = target-bitrate would select SVT's CBR mode, which
        // fails to start with the default random-access prediction structure.)
        return `svtav1enc name=${name} crf=${quality} preset=10 parameters-string="mbr=${bitrateKbps}:mbr-overshoot-pct=0" ! av1parse`;
    }
    // CBR/VBR: svtav1enc gets the target only (as before).
    return `svtav1enc name=${name} target-bitrate=${bitrateKbps} preset=10 ! av1parse`;
}
