/**
 * MPEG-TS `stream_type` → media/codec mapping for the TS-splitter.
 *
 * The runner discovers streams at TS-packet level and reports the numeric PMT
 * `stream_type` (ISO/IEC 13818-1 Table 2-34 + common registrations) — unlike the
 * old GStreamer demuxer, which reported parsed caps. Kept free of engine imports
 * so it's unit-testable with plain values.
 *
 * Labels follow the fleet-wide layering order (in-band name → ISO descriptor →
 * generated): the splitter reads no KLV name channel (the demuxer keeps that
 * duty), so its labels layer the natively-signalled **ISO 639 language
 * descriptor** — parsed here from the ES's raw PMT descriptor-loop bytes the
 * discovery event carries — on top of the generic stream_type label.
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
 * ISO 639 language code (tag 0x0a, first entry) from an ES's raw PMT
 * descriptor-loop bytes as hex (the `esInfo` field of `tssplit:discovered`).
 * Total: malformed/truncated loops and non-letter codes yield undefined,
 * never a throw — descriptor data is source-controlled wire input.
 */
export function languageFromEsInfo(esInfoHex: string | undefined): string | undefined {
    if (!esInfoHex || !/^[0-9a-fA-F]*$/.test(esInfoHex) || esInfoHex.length % 2 !== 0) {
        return undefined;
    }
    const bytes = Buffer.from(esInfoHex, 'hex');
    for (let i = 0; i + 2 <= bytes.length; i += 2 + bytes[i + 1]) {
        if (bytes[i] !== 0x0a || bytes[i + 1] < 3 || i + 5 > bytes.length) continue;
        const code = bytes.subarray(i + 2, i + 5).toString('latin1');
        if (/^[A-Za-z]{3}$/.test(code)) return code.toLowerCase();
    }
    return undefined;
}

/**
 * Display label. Generic form `Video (h264, PID 0x65)`; when the stream
 * carries a natively-signalled ISO 639 language the label leads with it —
 * `Audio nor (aac, PID 0x141)`. An in-band stream NAME would outrank the
 * language (fleet layering order), but the splitter reads no name channel.
 */
export function streamLabel(pid: number, streamType: number, language?: string): string {
    const { media, codec } = streamTypeInfo(streamType);
    const m = media.charAt(0).toUpperCase() + media.slice(1);
    const lang = language ? ` ${language}` : '';
    return `${m}${lang} (${codec}, PID ${formatPid(pid)})`;
}
