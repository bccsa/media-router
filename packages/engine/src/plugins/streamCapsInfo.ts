/**
 * Codec identity + key stream params from a serialized GStreamer caps string
 * (the `caps` field of the runner's `stream:discovered` events).
 *
 * Drives the in-band labeling layering rule: MPEG-TS natively signals most
 * codecs via stream_type + standard/registration descriptors (and language via
 * the ISO 639 descriptor), so those must NOT be duplicated into the KLV
 * stream-info channel. `nativeTs` says whether mpegtsmux/tsdemux express the
 * codec on the wire by themselves — callers put codec info into KLV only when
 * it is false (WebVTT, unknown/private payloads).
 */

export interface StreamCapsInfo {
    /** Short codec id (h264, aac, s302m, webvtt, …); undefined when unknown. */
    codec?: string;
    /** True when MPEG-TS signals this codec natively (stream_type +
     *  standard/registration descriptors) — never duplicate it into KLV. */
    nativeTs: boolean;
    channels?: number;
    rate?: number;
    /** ISO 639 code tsdemux surfaces from the source PMT's language
     *  descriptor (natively signalled — informational only, never for KLV). */
    language?: string;
}

/** Caps name → codec id for names that need no field disambiguation.
 *  `audio/mpeg` is versioned and handled separately. */
const CODEC_FOR_CAPS_NAME: Record<string, string> = {
    'video/x-h264': 'h264',
    'video/x-h265': 'h265',
    'video/x-av1': 'av1',
    'audio/x-opus': 'opus',
    'audio/x-ac3': 'ac3',
    'audio/x-eac3': 'eac3',
    'audio/x-smpte-302m': 's302m',
    'application/x-subtitle-vtt': 'webvtt',
};

/**
 * Codecs mpegtsmux/tsdemux signal natively in the PMT. Everything the big
 * muxer routes today is on this list; webvtt (no ISO TS mapping exists) and
 * unknown/private payloads are not — they are exactly what the KLV fallback
 * channel is for. 302M note: native support needs gst ≥ 1.26 (fleet 1.28).
 */
const NATIVE_TS_CODECS = new Set([
    'h264', 'h265', 'av1', 'aac', 'mp3', 'opus', 'ac3', 'eac3', 's302m',
]);

/** Read one `field=(type)value` scalar out of a serialized caps string. */
function capsField(caps: string, field: string): string | undefined {
    const m = caps.match(new RegExp(`\\b${field}=\\((?:string|int)\\)([^,;\\s]+)`));
    return m?.[1];
}

/**
 * Parse codec identity + channels/rate/language from a caps string as
 * serialized by `GstCaps.to_string()`. Total: malformed/empty caps yield
 * `{ nativeTs: false }`, never a throw.
 */
export function capsStreamInfo(caps: string): StreamCapsInfo {
    const name = caps.split(/[,;]/, 1)[0]?.trim() ?? '';
    let codec = CODEC_FOR_CAPS_NAME[name];
    if (!codec && name === 'audio/mpeg') {
        const version = Number(capsField(caps, 'mpegversion'));
        if (version === 2 || version === 4) codec = 'aac';
        else if (version === 1) codec = 'mp3';
    }

    const channels = Number(capsField(caps, 'channels'));
    const rate = Number(capsField(caps, 'rate'));
    const language = capsField(caps, 'language');

    return {
        codec,
        nativeTs: codec !== undefined && NATIVE_TS_CODECS.has(codec),
        ...(Number.isInteger(channels) && channels > 0 ? { channels } : {}),
        ...(Number.isInteger(rate) && rate > 0 ? { rate } : {}),
        ...(language ? { language } : {}),
    };
}
