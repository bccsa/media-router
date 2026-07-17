/**
 * MPEG-TS `stream_type` → media/codec mapping for the TS-splitter.
 *
 * The runner discovers streams at TS-packet level and reports the numeric PMT
 * `stream_type` (ISO/IEC 13818-1 Table 2-34 + common registrations) — unlike the
 * old GStreamer demuxer, which reported parsed caps. Kept free of engine imports
 * so it's unit-testable with plain values. The ISO-descriptor labeling follow-up
 * will layer service/language names (SDT/ISO-639/teletext_descriptor) on top of
 * the generic label produced here.
 */

export type StreamMedia = 'video' | 'audio' | 'subtitle' | 'metadata' | 'data';

export interface StreamTypeInfo {
    media: StreamMedia;
    codec: string;
}

const STREAM_TYPES: Record<number, StreamTypeInfo> = {
    0x01: { media: 'video', codec: 'mpeg1' },
    0x02: { media: 'video', codec: 'mpeg2' },
    0x03: { media: 'audio', codec: 'mp2' },
    0x04: { media: 'audio', codec: 'mp2' },
    0x0f: { media: 'audio', codec: 'aac' },
    0x11: { media: 'audio', codec: 'aac-latm' },
    0x1b: { media: 'video', codec: 'h264' },
    0x24: { media: 'video', codec: 'h265' },
    0x06: { media: 'data', codec: 'private' }, // DVB subtitle / teletext (descriptor disambiguates)
    0x15: { media: 'metadata', codec: 'klv' }, // metadata carried in PES
    0x81: { media: 'audio', codec: 'ac3' },
    0x87: { media: 'audio', codec: 'eac3' },
};

export function streamTypeInfo(streamType: number): StreamTypeInfo {
    return STREAM_TYPES[streamType] ?? { media: 'data', codec: `0x${streamType.toString(16)}` };
}

export function formatPid(pid: number): string {
    return `0x${pid.toString(16)}`;
}

/**
 * Generic display label, e.g. `Video (h264, PID 0x65)`. The ISO-descriptor
 * labeling follow-up prepends a service/language name when the stream carries
 * one (SDT service_descriptor, ISO-639 language descriptor, teletext_descriptor).
 */
export function streamLabel(pid: number, streamType: number): string {
    const { media, codec } = streamTypeInfo(streamType);
    const m = media.charAt(0).toUpperCase() + media.slice(1);
    return `${m} (${codec}, PID ${formatPid(pid)})`;
}
