import { describe, it, expect } from 'vitest';
import {
    StreamInspector,
    codecFromCaps,
    languageFromCaps,
    type DiscoveredStream,
} from './streamInspector.js';

describe('codecFromCaps', () => {
    it('maps known caps to short codec labels', () => {
        expect(codecFromCaps('video/x-h264, stream-format=(string)byte-stream')).toBe('h264');
        expect(codecFromCaps('video/x-h265')).toBe('h265');
        expect(codecFromCaps('audio/x-ac3, framed=(boolean)true')).toBe('ac3');
        expect(codecFromCaps('audio/x-opus, channels=(int)2')).toBe('opus');
        expect(codecFromCaps('meta/x-klv, parsed=(boolean)true')).toBe('klv');
    });
    it('disambiguates audio/mpeg by mpegversion (matching the runner parser table)', () => {
        expect(codecFromCaps('audio/mpeg, mpegversion=(int)4, stream-format=(string)adts')).toBe(
            'aac',
        );
        expect(codecFromCaps('audio/mpeg, mpegversion=(int)1')).toBe('mp2');
    });
    it('falls back to the caps structure name for unknown codecs', () => {
        expect(codecFromCaps('video/x-future-codec, foo=(int)1')).toBe('video/x-future-codec');
    });
    it('returns "unknown" for an empty caps string', () => {
        expect(codecFromCaps('')).toBe('unknown');
    });
});

describe('StreamInspector', () => {
    it('records discovered streams keyed by PID and lists them sorted', () => {
        const insp = new StreamInspector();
        insp.record({ pid: 0x141, media: 'audio', caps: 'audio/mpeg, mpegversion=(int)4' });
        insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
        const list = insp.list();
        expect(list.map((s) => s.pid)).toEqual([0x100, 0x141]);
        expect(list[0]).toMatchObject({ media: 'video', codec: 'h264' });
        expect(list[1]).toMatchObject({ media: 'audio', codec: 'aac' });
    });

    it('upserts on a re-discovered PID rather than duplicating (restart case)', () => {
        const insp = new StreamInspector();
        insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
        insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h265' });
        expect(insp.size).toBe(1);
        expect(insp.list()[0].codec).toBe('h265');
    });

    it('classifies the KLV pad as metadata and never as a routable stream', () => {
        const insp = new StreamInspector();
        const entry = insp.record({
            pid: 0x12c,
            media: 'metadata',
            caps: 'meta/x-klv, parsed=(boolean)true',
        });
        expect(entry.media).toBe('metadata');
        expect(entry.codec).toBe('klv');
    });

    it('normalises an unknown media type to "data"', () => {
        const insp = new StreamInspector();
        const entry = insp.record({ pid: 0x200, media: 'wibble', caps: 'application/x-foo' });
        expect(entry.media).toBe('data');
    });

    it('lists streams with an unparseable PID (null) last, keyed by pad name', () => {
        const insp = new StreamInspector();
        insp.record({ pid: null, media: 'data', caps: 'application/x-foo', padName: 'odd_pad' });
        insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
        const list = insp.list();
        expect(list[0].pid).toBe(0x100);
        expect(list[1].pid).toBeNull();
        expect(insp.size).toBe(2);
    });

    it('clear() empties the table', () => {
        const insp = new StreamInspector();
        insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
        insp.clear();
        expect(insp.size).toBe(0);
        expect(insp.list()).toEqual([]);
    });

    it('formats PIDs as hex, with — for unknown', () => {
        expect(StreamInspector.formatPid(0x141)).toBe('0x141');
        expect(StreamInspector.formatPid(null)).toBe('—');
    });

    it('records an ISO-639 language tag from caps when present', () => {
        const insp = new StreamInspector();
        const e = insp.record({
            pid: 0x141,
            media: 'audio',
            caps: 'audio/mpeg, mpegversion=(int)4, language=(string)eng',
        });
        expect(e.language).toBe('eng');
        expect(insp.record({ pid: 0x142, media: 'audio', caps: 'audio/mpeg' }).language).toBeNull();
    });
});

describe('languageFromCaps', () => {
    it('extracts a lowercase ISO-639 tag', () => {
        expect(languageFromCaps('audio/mpeg, language=(string)ENG')).toBe('eng');
        expect(languageFromCaps('audio/mpeg, language=(string)fr')).toBe('fr');
    });
    it('returns null when no language descriptor is present', () => {
        expect(languageFromCaps('audio/mpeg, mpegversion=(int)4')).toBeNull();
    });
});

describe('StreamInspector.resolveLabel — KLV name → language → generated', () => {
    const stream = (over: Partial<DiscoveredStream>): DiscoveredStream => ({
        pid: 0x141,
        media: 'audio',
        caps: '',
        codec: 'aac',
        language: null,
        ...over,
    });

    it('prefers the in-band KLV name', () => {
        const names = new Map([[0x141, 'FOH Mix']]);
        expect(StreamInspector.resolveLabel(stream({ language: 'eng' }), names)).toBe('FOH Mix');
    });
    it('falls back to the language descriptor when no KLV name', () => {
        expect(StreamInspector.resolveLabel(stream({ language: 'eng' }), new Map())).toBe(
            'audio (eng)',
        );
    });
    it('falls back to the generated label when neither is available', () => {
        expect(StreamInspector.resolveLabel(stream({}), new Map())).toBe('Audio (aac, PID 0x141)');
    });
    it('a null-PID stream can never match a KLV name and uses the generated label', () => {
        const names = new Map([[0x141, 'X']]);
        expect(StreamInspector.resolveLabel(stream({ pid: null }), names)).toBe(
            'Audio (aac, PID —)',
        );
    });
});
