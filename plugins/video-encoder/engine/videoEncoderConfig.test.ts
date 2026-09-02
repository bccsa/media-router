import { describe, expect, it } from 'vitest';
import { pickEnum, readEncoderKnobs } from './videoEncoderConfig.js';

describe('pickEnum', () => {
    it('returns the value when it is in the allowed set', () => {
        expect(pickEnum('vbr', ['cbr', 'vbr'], 'cbr')).toBe('vbr');
    });
    it('falls back on anything outside the set, including undefined', () => {
        expect(pickEnum('turbo', ['cbr', 'vbr'], 'cbr')).toBe('cbr');
        expect(pickEnum(undefined, ['cbr', 'vbr'], 'cbr')).toBe('cbr');
    });
});

describe('readEncoderKnobs', () => {
    it('applies the module defaults to an empty config', () => {
        const k = readEncoderKnobs({});
        expect(k).toMatchObject({
            codec: 'h264',
            width: 1920,
            height: 1080,
            framerate: 30,
            bitrateKbps: 4000,
            kif: 60,
            rateControl: 'cbr',
            speedPreset: 'superfast',
            h264Profile: 'auto',
            sceneCut: 40,
            cpbSeconds: 1,
        });
    });
    it('reads and validates every knob', () => {
        const k = readEncoderKnobs({
            codec: 'h265',
            resolution: '1280x720',
            framerate: 25,
            bitrate: 6928,
            keyframeInterval: 50,
            rateControl: 'vbr',
            speedPreset: 'medium',
            h264Profile: 'baseline',
            sceneCut: 0,
            cpbSeconds: 0.5,
        });
        expect(k).toEqual({
            codec: 'h265',
            width: 1280,
            height: 720,
            framerate: 25,
            bitrateKbps: 6928,
            kif: 50,
            rateControl: 'vbr',
            speedPreset: 'medium',
            h264Profile: 'baseline',
            sceneCut: 0,
            cpbSeconds: 0.5,
        });
    });
    it('rejects out-of-set enums back to the defaults', () => {
        const k = readEncoderKnobs({
            rateControl: 'abr',
            speedPreset: 'warp',
            h264Profile: 'high10',
        });
        expect(k.rateControl).toBe('cbr');
        expect(k.speedPreset).toBe('superfast');
        expect(k.h264Profile).toBe('auto');
    });
});
