import { describe, it, expect } from 'vitest';
import { languageFromEsInfo, streamTypeInfo, streamLabel, formatPid } from './streamTypes.js';

describe('streamTypeInfo', () => {
    it('maps known video/audio/data/metadata stream types', () => {
        expect(streamTypeInfo(0x1b)).toEqual({ media: 'video', codec: 'h264' });
        expect(streamTypeInfo(0x24)).toEqual({ media: 'video', codec: 'h265' });
        expect(streamTypeInfo(0x0f)).toEqual({ media: 'audio', codec: 'aac' });
        expect(streamTypeInfo(0x81)).toEqual({ media: 'audio', codec: 'ac3' });
        expect(streamTypeInfo(0x06)).toEqual({ media: 'data', codec: 'private' }); // teletext / DVB-sub
        expect(streamTypeInfo(0x15)).toEqual({ media: 'metadata', codec: 'klv' });
    });

    it('falls back to a hex codec label for unknown types', () => {
        expect(streamTypeInfo(0x99)).toEqual({ media: 'data', codec: '0x99' });
    });
});

describe('streamTypeInfo — Opus on stream_type 0x06', () => {
    const OPUS_REGISTRATION = '05044f707573'; // tag 0x05, len 4, "Opus"
    const OPUS_DVB_EXT = '7f028002'; // tag 0x7f, len 2, ext tag 0x80
    const ISO639_NOR = '0a046e6f7200';
    const opus = { media: 'audio', codec: 'opus' };
    const privateData = { media: 'data', codec: 'private' };

    it('identifies Opus from the registration descriptor alone', () => {
        expect(streamTypeInfo(0x06, OPUS_REGISTRATION)).toEqual(opus);
    });

    it('identifies Opus from the DVB extension descriptor alone', () => {
        expect(streamTypeInfo(0x06, OPUS_DVB_EXT)).toEqual(opus);
    });

    it('identifies Opus from both descriptors, in any descriptor-loop position', () => {
        expect(streamTypeInfo(0x06, OPUS_REGISTRATION + OPUS_DVB_EXT)).toEqual(opus);
        expect(streamTypeInfo(0x06, ISO639_NOR + OPUS_REGISTRATION + OPUS_DVB_EXT)).toEqual(opus);
    });

    it('leaves other 0x06 streams private (DVB subtitle / teletext must not become opus)', () => {
        expect(streamTypeInfo(0x06)).toEqual(privateData);
        expect(streamTypeInfo(0x06, ISO639_NOR)).toEqual(privateData); // language only
        expect(streamTypeInfo(0x06, '5908' + '6e6f721000010002')).toEqual(privateData); // DVB sub
        expect(streamTypeInfo(0x06, '7f024f02')).toEqual(privateData); // ext, but not ext tag 0x80
        expect(streamTypeInfo(0x06, '05044f707500')).toEqual(privateData); // registration != "Opus"
    });

    it('is total on malformed esInfo: truncation, odd hex, garbage → private, no throw', () => {
        expect(streamTypeInfo(0x06, '')).toEqual(privateData);
        expect(streamTypeInfo(0x06, '0504')).toEqual(privateData); // registration header only
        expect(streamTypeInfo(0x06, '05044f70')).toEqual(privateData); // truncated mid-"Opus"
        expect(streamTypeInfo(0x06, '7f02')).toEqual(privateData); // ext header only
        expect(streamTypeInfo(0x06, '05044f70757')).toEqual(privateData); // odd-length hex
        expect(streamTypeInfo(0x06, 'zzzz')).toEqual(privateData); // not hex
        expect(streamTypeInfo(0x06, 'ff'.repeat(64))).toEqual(privateData); // garbage loop
    });

    it('never overrides a stream_type that states its own codec', () => {
        expect(streamTypeInfo(0x0f, OPUS_REGISTRATION)).toEqual({ media: 'audio', codec: 'aac' });
        expect(streamTypeInfo(0x1b, OPUS_DVB_EXT)).toEqual({ media: 'video', codec: 'h264' });
    });
});

describe('streamLabel', () => {
    it('formats a generic PID label', () => {
        expect(streamLabel(0x65, streamTypeInfo(0x1b))).toBe('Video (h264, PID 0x65)');
        expect(streamLabel(0xcc, streamTypeInfo(0x0f))).toBe('Audio (aac, PID 0xcc)');
        expect(streamLabel(0x20, streamTypeInfo(0x06))).toBe('Data (private, PID 0x20)');
    });

    it('carries a descriptor-derived codec into the label', () => {
        expect(streamLabel(0x20, streamTypeInfo(0x06, '05044f707573'), 'nor')).toBe(
            'Audio nor (opus, PID 0x20)',
        );
    });

    it('leads with the ISO 639 language when present', () => {
        expect(streamLabel(0x141, streamTypeInfo(0x0f), 'nor')).toBe('Audio nor (aac, PID 0x141)');
        expect(streamLabel(0x141, streamTypeInfo(0x0f), undefined)).toBe('Audio (aac, PID 0x141)');
    });
});

describe('languageFromEsInfo', () => {
    it('reads the ISO 639 descriptor (tag 0x0a) from a raw descriptor loop', () => {
        // The OCC stream shape: ISO639 'nor' + AAC descriptor + max bitrate.
        expect(languageFromEsInfo('0a046e6f7200' + '7c03518003' + '0e03c003c0')).toBe('nor');
        // Descriptor order must not matter.
        expect(languageFromEsInfo('7c035180030a0464657500')).toBe('deu');
    });

    it('is total on garbage: no descriptor, truncation, odd hex, non-letters', () => {
        expect(languageFromEsInfo(undefined)).toBeUndefined();
        expect(languageFromEsInfo('')).toBeUndefined();
        expect(languageFromEsInfo('05044f707573')).toBeUndefined(); // Opus registration only
        expect(languageFromEsInfo('0a04')).toBeUndefined(); // truncated
        expect(languageFromEsInfo('0a0')).toBeUndefined(); // odd-length hex
        expect(languageFromEsInfo('zz')).toBeUndefined(); // not hex
        expect(languageFromEsInfo('0a04313233ff')).toBeUndefined(); // '123' not letters
    });
});

describe('formatPid', () => {
    it('hex-formats a PID', () => {
        expect(formatPid(0x1f0)).toBe('0x1f0');
        expect(formatPid(0)).toBe('0x0');
    });
});
