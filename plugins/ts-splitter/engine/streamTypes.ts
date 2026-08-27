/**
 * MPEG-TS `stream_type` → media/codec mapping for the TS-splitter.
 *
 * The runner discovers streams at TS-packet level and reports the numeric PMT
 * `stream_type` (ISO/IEC 13818-1 Table 2-34 + common registrations) — unlike the
 * old GStreamer demuxer, which reported parsed caps. Kept free of engine imports
 * so it's unit-testable with plain values.
 *
 * stream_type alone is not always enough: some codecs ride the generic private
 * PES type (0x06) and are named only by the ES descriptor loop — Opus is one —
 * so the raw descriptor bytes are a second input to the mapping.
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

const PRIVATE_PES = 0x06;

/**
 * media/codec for a PMT entry. `esInfoHex` is the ES's raw descriptor-loop
 * bytes: pass it whenever they are available, since some codecs are signalled
 * ONLY there (Opus — see `isOpusEsInfo`) and stream_type alone under-reports
 * them as private data.
 */
export function streamTypeInfo(streamType: number, esInfoHex?: string): StreamTypeInfo {
    if (streamType === PRIVATE_PES && isOpusEsInfo(esInfoHex)) {
        return { media: 'audio', codec: 'opus' };
    }
    return STREAM_TYPES[streamType] ?? { media: 'data', codec: `0x${streamType.toString(16)}` };
}

export function formatPid(pid: number): string {
    return `0x${pid.toString(16)}`;
}

/**
 * An ES's raw PMT descriptor-loop bytes from the hex `esInfo` field of
 * `tssplit:discovered` — undefined when absent or not clean hex. Descriptor
 * data is source-controlled wire input, so every walk below bounds-checks and
 * the parsers are total: garbage yields "unknown", never a throw.
 */
function esInfoBytes(esInfoHex: string | undefined): Buffer | undefined {
    if (!esInfoHex || !/^[0-9a-fA-F]+$/.test(esInfoHex) || esInfoHex.length % 2 !== 0) {
        return undefined;
    }
    return Buffer.from(esInfoHex, 'hex');
}

/**
 * Does the descriptor loop identify the ES as Opus? Opus rides stream_type 0x06
 * (private PES), so the PMT's stream_type says nothing — identity lives only in
 * the descriptors: a registration descriptor (tag 0x05) with format_identifier
 * "Opus", and/or the DVB extension descriptor (tag 0x7f) with extension tag
 * 0x80. Other 0x06 streams (DVB subtitle, teletext) carry neither and stay
 * generic private data.
 */
function isOpusEsInfo(esInfoHex: string | undefined): boolean {
    const bytes = esInfoBytes(esInfoHex);
    if (!bytes) return false;
    for (let i = 0; i + 2 <= bytes.length; i += 2 + bytes[i + 1]) {
        const len = bytes[i + 1];
        if (i + 2 + len > bytes.length) break; // truncated descriptor — stop
        if (bytes[i] === 0x05 && len >= 4) {
            if (bytes.subarray(i + 2, i + 6).toString('latin1') === 'Opus') return true;
        } else if (bytes[i] === 0x7f && len >= 1 && bytes[i + 2] === 0x80) {
            return true;
        }
    }
    return false;
}

/**
 * ISO 639 language code (tag 0x0a, first entry) from an ES's raw PMT
 * descriptor-loop bytes as hex. Total: malformed/truncated loops and
 * non-letter codes yield undefined, never a throw.
 */
export function languageFromEsInfo(esInfoHex: string | undefined): string | undefined {
    const bytes = esInfoBytes(esInfoHex);
    if (!bytes) return undefined;
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
 *
 * Takes the already-resolved media/codec rather than the stream_type, so a
 * descriptor-derived identity (Opus) reaches the label too.
 */
export function streamLabel(pid: number, info: StreamTypeInfo, language?: string): string {
    const m = info.media.charAt(0).toUpperCase() + info.media.slice(1);
    const lang = language ? ` ${language}` : '';
    return `${m}${lang} (${info.codec}, PID ${formatPid(pid)})`;
}
