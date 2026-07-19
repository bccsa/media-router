import { describe, expect, it } from 'vitest';
import { capsStreamInfo } from './streamCapsInfo.js';

describe('capsStreamInfo', () => {
    it('maps plain caps names to codec ids with nativeTs=true', () => {
        expect(capsStreamInfo('video/x-h264, stream-format=(string)byte-stream')).toMatchObject({
            codec: 'h264',
            nativeTs: true,
        });
        expect(capsStreamInfo('video/x-h265')).toMatchObject({ codec: 'h265', nativeTs: true });
        expect(capsStreamInfo('audio/x-opus, channel-mapping-family=(int)0')).toMatchObject({
            codec: 'opus',
            nativeTs: true,
        });
        expect(capsStreamInfo('audio/x-ac3')).toMatchObject({ codec: 'ac3', nativeTs: true });
        expect(capsStreamInfo('audio/x-smpte-302m')).toMatchObject({
            codec: 's302m',
            nativeTs: true,
        });
    });

    it('disambiguates audio/mpeg by mpegversion', () => {
        expect(
            capsStreamInfo('audio/mpeg, mpegversion=(int)4, stream-format=(string)adts'),
        ).toMatchObject({ codec: 'aac', nativeTs: true });
        expect(capsStreamInfo('audio/mpeg, mpegversion=(int)2')).toMatchObject({ codec: 'aac' });
        expect(capsStreamInfo('audio/mpeg, mpegversion=(int)1, layer=(int)3')).toMatchObject({
            codec: 'mp3',
            nativeTs: true,
        });
        expect(capsStreamInfo('audio/mpeg').codec).toBeUndefined();
    });

    it('flags webvtt as non-native (the KLV fallback case)', () => {
        expect(capsStreamInfo('application/x-subtitle-vtt')).toMatchObject({
            codec: 'webvtt',
            nativeTs: false,
        });
    });

    it('returns codec undefined + nativeTs false for unknown/private/empty caps', () => {
        expect(capsStreamInfo('private/x-unknown')).toEqual({ codec: undefined, nativeTs: false });
        expect(capsStreamInfo('meta/x-klv, parsed=(boolean)true')).toMatchObject({
            codec: undefined,
            nativeTs: false,
        });
        expect(capsStreamInfo('')).toEqual({ codec: undefined, nativeTs: false });
    });

    it('parses channels, rate and language fields', () => {
        const info = capsStreamInfo(
            'audio/mpeg, mpegversion=(int)4, rate=(int)48000, channels=(int)2, language=(string)deu',
        );
        expect(info).toEqual({
            codec: 'aac',
            nativeTs: true,
            channels: 2,
            rate: 48000,
            language: 'deu',
        });
    });

    it('omits malformed numeric fields', () => {
        const info = capsStreamInfo('audio/x-opus, rate=(int)0, channels=(int)-1');
        expect(info.rate).toBeUndefined();
        expect(info.channels).toBeUndefined();
    });
});
