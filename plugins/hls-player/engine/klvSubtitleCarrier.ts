/**
 * The fleet's subtitle carrier for hls-pipe: KLV-wrapped WebVTT cues
 * (ADR-0016, `plugins/subtitle-core`) in place of hls-pipe's own `"VTT "`
 * private PES, which GStreamer's tsdemux never exposes — so until this
 * existed an HLS subtitle language could be selected but never burned in
 * or muxed on. Plugged into the extractor through
 * `ExtractorOptions.subtitleCarrier` by the runner:
 *
 * - PMT: stream_type 0x06 + registration "KLVA" — byte for byte what
 *   mpegtsmux writes for `meta/x-klv,parsed=true`, so tsdemux gives the PID
 *   a `meta/x-klv` pad on every consumer (splitter, muxer, the renderers'
 *   subtitles-in bridge). hls-pipe adds the ISO 639 language descriptor.
 * - PIDs from subtitle-core's 0x180 base, the fleet's subtitle range.
 * - Payload: one KLV triplet per PES whose WebVTT block carries times
 *   RELATIVE to the carrying PES (`0 --> remaining` at the cue start,
 *   recomputed on every re-send) — the teletext producer's convention, which
 *   is what lets a cue survive the arrival-time re-stamping of every hop.
 * - Re-sent every 2 s while live (the runner bridge's RESEND_MS), so a
 *   consumer attaching mid-cue still shows it.
 * - Text is Pango-escaped: the renderer sets it as textoverlay markup.
 */

import type { SubtitleCarrier, SubtitleCueOut } from 'hls-pipe';
import { TS_SUBTITLE_PID_BASE, encodeSubtitleKlv } from '@media-router/plugin-subtitle-core/cue';

/** Re-send cadence of a live cue (matches subtitle_bridge.RESEND_MS). */
export const KLV_RESEND_MS = 2000;

/** registration_descriptor (tag 0x05, length 4) "KLVA" — tsdemux's key to `meta/x-klv`. */
export const KLVA_REGISTRATION = Uint8Array.from([0x05, 0x04, 0x4b, 0x4c, 0x56, 0x41]);

/** Escape plain text for a Pango-markup consumer (textoverlay's `text`). */
export function pangoEscape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One cue as a KLV triplet, its span relative to the PES written at `pesPts` (90 kHz). */
export function encodeKlvCue(cue: SubtitleCueOut, pesPts: number): Uint8Array {
    return encodeSubtitleKlv({
        startMs: Math.max(0, cue.startTicks - pesPts) / 90,
        endMs: Math.max(0, cue.endTicks - pesPts) / 90,
        text: pangoEscape(cue.text),
    });
}

export function klvSubtitleCarrier(): SubtitleCarrier {
    return {
        streamType: 0x06,
        descriptors: [KLVA_REGISTRATION],
        pidBase: TS_SUBTITLE_PID_BASE,
        resendTicks: KLV_RESEND_MS * 90,
        encode: encodeKlvCue,
    };
}
