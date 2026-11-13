import { describe, expect, it } from 'vitest';
import {
    qvbrFallbackWarning,
    renditionStatLabel,
    renditionSummary,
    throughputSection,
} from './transcoderStatus.js';

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
        // The tag is what runs: V4L2 pins VBR, so a cbr override reads vbr.
        expect(renditionSummary(outputs)).toBe('1920x1080@5000k [v4l2, vbr], 854x480@1200k');
    });

    it('tags a quality override only when the rendition really runs QVBR', () => {
        const row = (rateControl: string, codec = 'h264', impl = 'va', vaQvbr = true): any => ({
            rendition: { width: 1280, height: 720, bitrate: 2500, rateControl, quality: 20 },
            encode: { codec, impl, rateControl, quality: 20, vaQvbr },
        });
        expect(
            renditionSummary([
                row('qvbr'),
                row('cbr'),
                row('qvbr', 'h264', 'va', false),
                row('qvbr', 'av1', 'va'),
                row('qvbr', 'av1', 'software'),
                row('qvbr', 'h264', 'v4l2'),
                row('qvbr', 'h265', 'software'),
            ])
                .split(/, (?=1280x720)/)
                .map((s) => s.replace('1280x720@2500k ', '')),
        ).toEqual([
            '[qvbr, q20]',
            '[cbr]',
            '[capped-vbr]',
            '[capped-vbr]',
            '[qvbr, q20]',
            '[vbr]',
            '[qvbr, q20]',
        ]);
    });

    it('warns only for QVBR renditions that fell back to capped VBR on VA-API', () => {
        const out = (name: string, codec: string, vaQvbr: boolean, rateControl = 'qvbr'): any => ({
            rendition: { name, width: 1280, height: 720, bitrate: 2500 },
            encode: { codec, impl: 'va', rateControl, quality: 25, vaQvbr },
        });
        expect(
            qvbrFallbackWarning([out('HD', 'h264', true), out('SD', 'h264', false, 'cbr')]),
        ).toBe(null);
        expect(qvbrFallbackWarning([out('HD', 'h264', false), out('AV1', 'av1', true)])).toBe(
            'No VA-API QVBR for HD, AV1: VBR capped at the bitrate, quality ignored',
        );
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
