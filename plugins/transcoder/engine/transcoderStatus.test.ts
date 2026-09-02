import { describe, expect, it } from 'vitest';
import { renditionStatLabel, renditionSummary, throughputSection } from './transcoderStatus.js';

const sample = (kbps: number, bytes = 0) =>
    ({ bitrateKbps: kbps, totalBytes: bytes, intervalMs: 1000 }) as any;

describe('renditionSummary', () => {
    it('lists resolution@bitrate and flags only overridden knobs', () => {
        const outputs: any = [
            {
                rendition: {
                    width: 1920,
                    height: 1080,
                    bitrate: 5000,
                    encoderImpl: 'v4l2',
                    rateControl: 'cbr',
                },
                encode: {
                    codec: 'h264',
                    impl: 'v4l2',
                    rateControl: 'cbr',
                    speedPreset: 'superfast',
                    h264Profile: 'auto',
                    sceneCut: 40,
                },
            },
            {
                rendition: { width: 854, height: 480, bitrate: 1200 },
                encode: {
                    codec: 'h264',
                    impl: 'software',
                    rateControl: 'vbr',
                    speedPreset: 'medium',
                    h264Profile: 'baseline',
                    sceneCut: 30,
                },
            },
        ];
        expect(renditionSummary(outputs)).toBe('1920x1080@5000k [v4l2, cbr], 854x480@1200k');
    });
});

describe('renditionStatLabel', () => {
    it('formats a known rendition and falls back to an ordinal', () => {
        expect(renditionStatLabel({ width: 1280, height: 720, bitrate: 2500 } as any, 0)).toBe(
            '1280x720 @ 2500k',
        );
        expect(renditionStatLabel(undefined, 2)).toBe('Rendition 3');
    });
});

describe('throughputSection', () => {
    it('emits one Mbps row per sink with a sample, then Total and Total Bytes', () => {
        const { fields, data } = throughputSection(
            ['busout_40100', 'busout_40101'],
            [{ width: 1920, height: 1080, bitrate: 5000 } as any, undefined],
            sample(6250, 2 * 1024 * 1024),
            { busout_40100: sample(5010) },
        );
        expect(fields.map((f) => f.key)).toEqual(['r0', 'total', 'totalBytes']);
        expect(fields[0].label).toBe('1920x1080 @ 5000k');
        expect(data).toEqual({ r0: 5.01, total: 6.25, totalBytes: '2.0 MB' });
    });
});
