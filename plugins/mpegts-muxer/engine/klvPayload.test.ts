import { describe, it, expect } from 'vitest';
import {
    KLV_PAYLOAD_VERSION,
    buildKlvPayload,
    resolveStreamName,
    serializeKlvPayload,
    type NamedStreamInput,
} from './klvPayload.js';

describe('resolveStreamName', () => {
    const base: NamedStreamInput = { pid: 0x141, media: 'audio', sinkPortId: 'audio-0' };

    it('prefers the operator-set name', () => {
        expect(resolveStreamName({ ...base, name: 'FOH Mix', sourceModuleId: 'enc-1' })).toBe(
            'FOH Mix',
        );
    });
    it('trims whitespace and treats a blank name as unset', () => {
        expect(resolveStreamName({ ...base, name: '  Cam 1  ' })).toBe('Cam 1');
        expect(resolveStreamName({ ...base, name: '   ', sourceModuleId: 'enc-2' })).toBe('enc-2');
    });
    it('falls back to sourceModuleId when no name (plan D4)', () => {
        expect(resolveStreamName({ ...base, sourceModuleId: 'encoder-7' })).toBe('encoder-7');
    });
    it('falls back to a generic media+PID label when neither is set', () => {
        expect(resolveStreamName({ pid: 0x100, media: 'video', sinkPortId: 'video-0' })).toBe('video 0x100');
        expect(resolveStreamName({ pid: 0x141, media: 'audio', sinkPortId: 'audio-0' })).toBe('audio 0x141');
    });
});

describe('buildKlvPayload', () => {
    it('emits a v1 payload with one entry per input', () => {
        const payload = buildKlvPayload([
            { pid: 0x100, media: 'video', sinkPortId: 'video-0', name: 'Cam 1' },
            { pid: 0x141, media: 'audio', sinkPortId: 'audio-0', sourceModuleId: 'enc-a' },
        ]);
        expect(payload.v).toBe(KLV_PAYLOAD_VERSION);
        expect(payload.streams).toEqual([
            { pid: 0x100, media: 'video', name: 'Cam 1' },
            { pid: 0x141, media: 'audio', name: 'enc-a' },
        ]);
    });

    it('sorts streams by PID so the byte stream is stable across restarts', () => {
        const payload = buildKlvPayload([
            { pid: 0x141, media: 'audio', sinkPortId: 'audio-0', name: 'b' },
            { pid: 0x100, media: 'video', sinkPortId: 'video-0', name: 'a' },
        ]);
        expect(payload.streams.map((s) => s.pid)).toEqual([0x100, 0x141]);
    });

    it('still emits a (empty) payload with zero inputs so the channel never goes silent', () => {
        const payload = buildKlvPayload([]);
        expect(payload).toEqual({ v: KLV_PAYLOAD_VERSION, streams: [] });
    });

    it('always carries a non-empty name even when nothing is configured (falls back)', () => {
        const payload = buildKlvPayload([{ pid: 0x100, media: 'video', sinkPortId: 'video-0' }]);
        expect(payload.streams[0].name).toBe('video 0x100');
    });

    it('omits codec info for natively-signalled codecs (layering rule)', () => {
        const payload = buildKlvPayload([
            {
                pid: 0x141,
                media: 'audio',
                sinkPortId: 'audio-0',
                name: 'EN',
                discovered: { codec: 'aac', nativeTs: true, channels: 2, rate: 48000 },
            },
            {
                pid: 0x100,
                media: 'video',
                sinkPortId: 'video-0',
                name: 'Cam',
                discovered: { codec: 'h264', nativeTs: true },
            },
        ]);
        // Name-only entries — the PMT already says aac/h264 on the wire.
        expect(payload.streams).toEqual([
            { pid: 0x100, media: 'video', name: 'Cam' },
            { pid: 0x141, media: 'audio', name: 'EN' },
        ]);
    });

    it('includes codec info for non-native codecs (webvtt/private fallback)', () => {
        const payload = buildKlvPayload([
            {
                pid: 0x141,
                media: 'audio',
                sinkPortId: 'audio-0',
                name: 'Subs',
                discovered: { codec: 'webvtt', nativeTs: false, channels: 0, rate: 0 },
            },
        ]);
        expect(payload.streams).toEqual([
            { pid: 0x141, media: 'audio', name: 'Subs', codec: 'webvtt' },
        ]);
    });

    it('never emits codec fields when discovery saw no codec at all', () => {
        const payload = buildKlvPayload([
            {
                pid: 0x141,
                media: 'audio',
                sinkPortId: 'audio-0',
                name: 'X',
                discovered: { nativeTs: false, channels: 2, rate: 48000 },
            },
        ]);
        expect(payload.streams).toEqual([{ pid: 0x141, media: 'audio', name: 'X' }]);
    });
});

describe('serializeKlvPayload', () => {
    it('produces compact JSON the runner pushes as bytes', () => {
        const json = serializeKlvPayload(
            buildKlvPayload([{ pid: 0x100, media: 'video', sinkPortId: 'video-0', name: 'Cam 1' }]),
        );
        expect(json).toBe('{"v":1,"streams":[{"pid":256,"media":"video","name":"Cam 1"}]}');
        // Round-trips back to the same object.
        expect(JSON.parse(json)).toEqual({
            v: 1,
            streams: [{ pid: 256, media: 'video', name: 'Cam 1' }],
        });
    });
});
