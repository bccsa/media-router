import { describe, it, expect } from 'vitest';
import {
    SUBTITLE_KLV_KEY,
    TS_SUBTITLE_PID_BASE,
    decodeSubtitleKlv,
    encodeSubtitleKlv,
    formatCueBlock,
    formatVttTime,
    isSubtitleKlv,
    parseCueBlock,
    parseVttTime,
    subtitleStreamPid,
} from './subtitleCue.js';

/**
 * Wire vectors shared with `py/subtitle_klv_test.py` — the two encoders must
 * agree byte for byte. Change one, change both, and say so in the commit.
 */
const VECTOR_CUE = { startMs: 3_723_004, endMs: 3_725_500, text: 'Hello\nWorld' };
const VECTOR_HEX =
    '060e2b34020501010e0e4d5253554231' + // key
    '2a' + // BER short length = 42 (30-byte timing line + "Hello\n" + "World\n")
    Buffer.from('01:02:03.004 --> 01:02:05.500\nHello\nWorld\n', 'utf-8').toString('hex');
const CLEAR_HEX =
    '060e2b34020501010e0e4d5253554231' +
    '1e' +
    Buffer.from('01:02:05.500 --> 01:02:05.500\n', 'utf-8').toString('hex');

describe('VTT timing', () => {
    it('formats with millisecond precision and grows hour digits', () => {
        expect(formatVttTime(0)).toBe('00:00:00.000');
        expect(formatVttTime(3_723_004)).toBe('01:02:03.004');
        // 46 days of uptime as a house-clock time → 4-digit hours
        expect(formatVttTime(46 * 24 * 3_600_000 + 1)).toBe('1104:00:00.001');
        expect(formatVttTime(-5)).toBe('00:00:00.000');
        expect(formatVttTime(1.6)).toBe('00:00:00.002');
    });

    it('parses what it formats and rejects garbage', () => {
        for (const ms of [0, 999, 60_000, 3_723_004, 1104 * 3_600_000 + 1]) {
            expect(parseVttTime(formatVttTime(ms))).toBe(ms);
        }
        expect(parseVttTime('1:02:03.004')).toBeUndefined();
        expect(parseVttTime('01:62:03.004')).toBeUndefined();
        expect(parseVttTime('01:02:03,004')).toBeUndefined();
        expect(parseVttTime('')).toBeUndefined();
    });
});

describe('cue block', () => {
    it('round-trips text, normalises line endings and trailing newlines', () => {
        const block = formatCueBlock({ startMs: 1000, endMs: 2500, text: 'a\r\nb\n\n' });
        expect(block).toBe('00:00:01.000 --> 00:00:02.500\na\nb\n');
        expect(parseCueBlock(block)).toEqual({ startMs: 1000, endMs: 2500, text: 'a\nb' });
    });

    it('a clear cue is a bare timing line', () => {
        const block = formatCueBlock({ startMs: 1000, endMs: 1000, text: '' });
        expect(block).toBe('00:00:01.000 --> 00:00:01.000\n');
        expect(parseCueBlock(block)).toEqual({ startMs: 1000, endMs: 1000, text: '' });
    });

    it('clamps end below start when formatting, rejects it when parsing', () => {
        expect(formatCueBlock({ startMs: 2000, endMs: 1000, text: 'x' })).toBe(
            '00:00:02.000 --> 00:00:02.000\nx\n',
        );
        expect(parseCueBlock('00:00:02.000 --> 00:00:01.000\nx\n')).toBeUndefined();
        expect(parseCueBlock('no timing here')).toBeUndefined();
    });
});

describe('KLV triplet', () => {
    it('encodes the pinned vector byte for byte', () => {
        expect(Buffer.from(encodeSubtitleKlv(VECTOR_CUE)).toString('hex')).toBe(VECTOR_HEX);
        expect(
            Buffer.from(
                encodeSubtitleKlv({ startMs: 3_725_500, endMs: 3_725_500, text: '' }),
            ).toString('hex'),
        ).toBe(CLEAR_HEX);
    });

    it('decodes the pinned vector and its own output', () => {
        expect(decodeSubtitleKlv(Buffer.from(VECTOR_HEX, 'hex'))).toEqual(VECTOR_CUE);
        const long = { startMs: 5, endMs: 9000, text: 'x'.repeat(300) };
        const bytes = encodeSubtitleKlv(long);
        // long-form BER: 0x82 0x01 0x4b (=331 = 30-byte timing line + 300 + "\n")
        expect(Array.from(bytes.subarray(16, 19))).toEqual([0x82, 0x01, 0x4b]);
        expect(decodeSubtitleKlv(bytes)).toEqual(long);
    });

    it('is total on wire garbage', () => {
        expect(decodeSubtitleKlv(new Uint8Array(0))).toBeUndefined();
        expect(decodeSubtitleKlv(SUBTITLE_KLV_KEY)).toBeUndefined(); // no length
        const truncated = encodeSubtitleKlv(VECTOR_CUE).subarray(0, 30);
        expect(decodeSubtitleKlv(truncated)).toBeUndefined();
        // the muxer's JSON name carousel is also meta/x-klv — must be ignored
        const json = Buffer.from('{"v":1,"streams":[]}', 'utf-8');
        expect(isSubtitleKlv(json)).toBe(false);
        expect(decodeSubtitleKlv(json)).toBeUndefined();
        // invalid UTF-8 inside a well-formed triplet
        const bad = Uint8Array.from([...SUBTITLE_KLV_KEY, 2, 0xff, 0xfe]);
        expect(decodeSubtitleKlv(bad)).toBeUndefined();
    });

    it('refuses oversized cues', () => {
        expect(() => encodeSubtitleKlv({ startMs: 0, endMs: 1, text: 'y'.repeat(5000) })).toThrow(
            /too large/,
        );
    });
});

describe('PID scheme', () => {
    it('numbers subtitle streams above audio and below the metadata PID', () => {
        expect(TS_SUBTITLE_PID_BASE).toBe(0x180);
        expect(subtitleStreamPid(0)).toBe(0x180);
        expect(subtitleStreamPid(7)).toBe(0x187);
    });
});
