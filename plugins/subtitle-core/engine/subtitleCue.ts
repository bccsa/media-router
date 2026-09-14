/**
 * The subtitle carrier: one WebVTT cue block wrapped in a SMPTE 336M-style
 * KLV triplet, carried as a `meta/x-klv,parsed=true` PES in MPEG-TS
 * (stream_type 0x06 + KLVA registration — what `mpegtsmux` writes and
 * `tsdemux` exposes natively on gst 1.28). See
 * docs/subtitles-teletext-vtt-plan.md, decision S1, for why this carrier and
 * not a private "VTT " PES (tsdemux creates no pad for it) or DVB-sub.
 *
 * Wire layout of the KLV value (UTF-8):
 *
 *     HH:MM:SS.mmm --> HH:MM:SS.mmm\n
 *     <text line>\n
 *     [<text line>\n ...]
 *
 * Times are HOUSE-CLOCK media time (ADR-0005: running-time ≡ house time in
 * every synced pipeline), so a consumer compares them directly against the
 * PTS of the video frames it composes — no offset, no re-anchoring. WebVTT
 * allows any number of hour digits, which a monotonic house clock needs.
 * An EMPTY text is a CLEAR cue: it ends whatever is showing at `start`.
 *
 * The python twin (`py/subtitle_klv.py`) encodes byte-identically; both test
 * suites pin the same vectors. Keep them in lockstep — this is a wire format
 * that crosses version boundaries during rolling fleet upgrades.
 */

/** 16-byte KLV key: SMPTE UL prefix + a private designator, ASCII "MRSUB1"
 *  in the last six bytes so a hex dump reads. */
export const SUBTITLE_KLV_KEY = Uint8Array.from([
    0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0e, 0x0e, 0x4d, 0x52, 0x53, 0x55, 0x42, 0x31,
]);

/** Deterministic PID range for subtitle streams: above audio (0x140…), below
 *  the metadata carousel (0x1f0). subtitle-N → 0x180 + N. */
export const TS_SUBTITLE_PID_BASE = 0x180;

export function subtitleStreamPid(index: number): number {
    return TS_SUBTITLE_PID_BASE + index;
}

/** Sanity bound on one cue payload — a subtitle is a few lines, never KBs. */
export const SUBTITLE_KLV_MAX_VALUE_BYTES = 4096;

export interface SubtitleCue {
    /** House-clock time the cue starts showing, in milliseconds. */
    startMs: number;
    /** House-clock time the cue stops showing, in milliseconds (>= startMs). */
    endMs: number;
    /** Cue text, lines joined with `\n`; empty string = clear. */
    text: string;
}

/** `HH:MM:SS.mmm` with as many hour digits as the value needs (min 2). */
export function formatVttTime(ms: number): string {
    const total = Math.max(0, Math.round(ms));
    const h = Math.floor(total / 3_600_000);
    const m = Math.floor((total % 3_600_000) / 60_000);
    const s = Math.floor((total % 60_000) / 1000);
    const f = total % 1000;
    const hh = String(h).padStart(2, '0');
    return `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

const VTT_TIME = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;

/** Parse `HH:MM:SS.mmm` → ms, or undefined when malformed. */
export function parseVttTime(text: string): number | undefined {
    const m = VTT_TIME.exec(text.trim());
    if (!m) return undefined;
    return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]);
}

/** The WebVTT cue block (timing line + text lines, each `\n`-terminated). */
export function formatCueBlock(cue: SubtitleCue): string {
    const timing = `${formatVttTime(cue.startMs)} --> ${formatVttTime(Math.max(cue.startMs, cue.endMs))}\n`;
    const text = cue.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return text.length ? `${timing}${text}\n` : timing;
}

/** Inverse of formatCueBlock. Total: garbage → undefined. */
export function parseCueBlock(block: string): SubtitleCue | undefined {
    const nl = block.indexOf('\n');
    const timing = nl < 0 ? block : block.slice(0, nl);
    const arrow = timing.indexOf('-->');
    if (arrow < 0) return undefined;
    const startMs = parseVttTime(timing.slice(0, arrow));
    const endMs = parseVttTime(timing.slice(arrow + 3));
    if (startMs === undefined || endMs === undefined || endMs < startMs) return undefined;
    const text = nl < 0 ? '' : block.slice(nl + 1).replace(/\n+$/, '');
    return { startMs, endMs, text };
}

/** BER length: short form under 128, else 0x8n + n big-endian bytes. */
function berLength(n: number): Uint8Array {
    if (n < 0x80) return Uint8Array.from([n]);
    const bytes: number[] = [];
    let v = n;
    while (v > 0) {
        bytes.unshift(v & 0xff);
        v = Math.floor(v / 256);
    }
    return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

/** Encode one cue as a KLV triplet ready to push as a `meta/x-klv` buffer. */
export function encodeSubtitleKlv(cue: SubtitleCue): Uint8Array {
    const value = new TextEncoder().encode(formatCueBlock(cue));
    if (value.length > SUBTITLE_KLV_MAX_VALUE_BYTES) {
        throw new Error(`subtitle cue too large: ${value.length} bytes`);
    }
    const len = berLength(value.length);
    const out = new Uint8Array(SUBTITLE_KLV_KEY.length + len.length + value.length);
    out.set(SUBTITLE_KLV_KEY, 0);
    out.set(len, SUBTITLE_KLV_KEY.length);
    out.set(value, SUBTITLE_KLV_KEY.length + len.length);
    return out;
}

/** True when the buffer starts with our key — cheap classifier for a
 *  `meta/x-klv` PES that is NOT the muxer's name carousel (JSON). */
export function isSubtitleKlv(bytes: Uint8Array): boolean {
    if (bytes.length < SUBTITLE_KLV_KEY.length) return false;
    for (let i = 0; i < SUBTITLE_KLV_KEY.length; i++) {
        if (bytes[i] !== SUBTITLE_KLV_KEY[i]) return false;
    }
    return true;
}

/**
 * Decode a KLV triplet back to a cue. Total: a foreign key, a bad BER
 * length, a truncated value or a malformed timing line all yield undefined,
 * never a throw — this runs on wire input inside the pipeline runner.
 */
export function decodeSubtitleKlv(bytes: Uint8Array): SubtitleCue | undefined {
    if (!isSubtitleKlv(bytes)) return undefined;
    let i = SUBTITLE_KLV_KEY.length;
    if (i >= bytes.length) return undefined;
    let len = bytes[i++];
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n === 0 || n > 4 || i + n > bytes.length) return undefined;
        len = 0;
        for (let k = 0; k < n; k++) len = len * 256 + bytes[i++];
    }
    if (len > SUBTITLE_KLV_MAX_VALUE_BYTES || i + len > bytes.length) return undefined;
    let block: string;
    try {
        block = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(i, i + len));
    } catch {
        return undefined;
    }
    return parseCueBlock(block);
}
