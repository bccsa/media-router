import { readFileSync } from 'fs';
import { join } from 'path';
import { QVBR_QUALITY_DEFAULT, RATE_CONTROLS } from '@media-router/engine';
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
            quality: 25,
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
            quality: 30,
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
            quality: 30,
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
    it('clamps cpbSeconds to 0.1–2 s like the transcoder', () => {
        expect(readEncoderKnobs({ cpbSeconds: 0.01 }).cpbSeconds).toBe(0.1);
        expect(readEncoderKnobs({ cpbSeconds: 9 }).cpbSeconds).toBe(2);
        expect(readEncoderKnobs({ cpbSeconds: 'x' }).cpbSeconds).toBe(1);
    });
    it('accepts qvbr and clamps its quality to 1–51', () => {
        expect(readEncoderKnobs({ rateControl: 'qvbr', quality: 18 })).toMatchObject({
            rateControl: 'qvbr',
            quality: 18,
        });
        expect(readEncoderKnobs({ quality: 99 }).quality).toBe(51);
        expect(readEncoderKnobs({ quality: 0 }).quality).toBe(1);
        expect(readEncoderKnobs({ quality: 'junk' }).quality).toBe(25);
    });
});

describe('video-encoder manifest rate control', () => {
    const props = JSON.parse(
        readFileSync(join(process.cwd(), 'plugins', 'video-encoder', 'package.json'), 'utf8'),
    ).mediaRouter.configSchema.properties;
    it('rateControl enum is RATE_CONTROLS; quality 1–51, engine default, hidden on V4L2', () => {
        expect(props.rateControl.enum).toEqual(RATE_CONTROLS);
        expect(Object.keys(props.rateControl['x-enumLabels'])).toEqual(RATE_CONTROLS);
        expect(props.quality).toMatchObject({
            minimum: 1,
            maximum: 51,
            default: QVBR_QUALITY_DEFAULT,
            'x-showWhen': 'rateControl=qvbr&encoderImpl=software,va,auto',
        });
    });
});
