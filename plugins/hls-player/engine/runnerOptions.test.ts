import { describe, it, expect } from 'vitest';
import { buildExtractorOverrides, type RunnerConfig } from './runnerOptions.js';

const presets = {
    default: { maxBitrate: 1 },
    unstable: { maxBitrate: 2 },
} as never;

const base: RunnerConfig = {
    url: 'https://example.com/master.m3u8',
    host: '239.255.0.1',
    port: 41000,
    quality: 'auto',
    capBitrateBps: 0,
    abrPreset: 'default',
    inlineAudio: [],
    inlineSubtitles: [],
    allowMonoAudio: false,
    liveStartSegments: 6,
    liveSyncSec: 0,
    liveMaxLagSec: 0,
    skipOnStall: false,
};

describe('buildExtractorOverrides', () => {
    it('defaults: default ABR preset, all audio, no optional knobs', () => {
        const o = buildExtractorOverrides(base, presets);
        expect(o).toEqual({
            abr: { maxBitrate: 1 },
            inlineAudioLanguages: 'all',
            liveStartOffsetSegments: 6,
        });
    });

    it('selects the unstable ABR preset and applies the bitrate cap', () => {
        const o = buildExtractorOverrides(
            { ...base, abrPreset: 'unstable', capBitrateBps: 2_500_000 },
            presets,
        );
        expect(o.abr).toEqual({ maxBitrate: 2, capBitrate: 2_500_000 });
    });

    it('maps fixed quality hints; auto leaves ABR enabled', () => {
        expect(buildExtractorOverrides({ ...base, quality: 'highest' }, presets).fixedQuality)
            .toEqual({ kind: 'highest' });
        expect(buildExtractorOverrides({ ...base, quality: 'lowest' }, presets).fixedQuality)
            .toEqual({ kind: 'lowest' });
        expect(buildExtractorOverrides(base, presets).fixedQuality).toBeUndefined();
    });

    it('builds latency config only from the knobs that are set', () => {
        expect(buildExtractorOverrides(base, presets).latency).toBeUndefined();
        expect(
            buildExtractorOverrides(
                { ...base, liveSyncSec: 8, liveMaxLagSec: 30, skipOnStall: true },
                presets,
            ).latency,
        ).toEqual({ liveSyncTargetSec: 8, liveMaxLatencySec: 30, skipOnStall: true });
    });

    it('passes language selections through; empty subtitles stay off', () => {
        const o = buildExtractorOverrides(
            { ...base, inlineAudio: ['eng', 'zul'], inlineSubtitles: ['eng'], allowMonoAudio: true },
            presets,
        );
        expect(o.inlineAudioLanguages).toEqual(['eng', 'zul']);
        expect(o.inlineSubtitleLanguages).toEqual(['eng']);
        expect(o.allowMonoAudio).toBe(true);
    });
});
