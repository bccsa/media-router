import { describe, it, expect } from 'vitest';
import { streamTypeInfo, streamLabel, formatPid } from './streamTypes.js';

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

describe('streamLabel', () => {
    it('formats a generic PID label', () => {
        expect(streamLabel(0x65, 0x1b)).toBe('Video (h264, PID 0x65)');
        expect(streamLabel(0xcc, 0x0f)).toBe('Audio (aac, PID 0xcc)');
        expect(streamLabel(0x20, 0x06)).toBe('Data (private, PID 0x20)');
    });
});

describe('formatPid', () => {
    it('hex-formats a PID', () => {
        expect(formatPid(0x1f0)).toBe('0x1f0');
        expect(formatPid(0)).toBe('0x0');
    });
});
