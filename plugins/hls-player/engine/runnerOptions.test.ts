import { describe, it, expect } from 'vitest';
import {
    buildExtractorOverrides,
    inlineAudioLanguages,
    resolutionCapBitrateBps,
    resolveQuality,
    type RunnerConfig,
} from './runnerOptions.js';

describe('resolveQuality (single Quality dropdown → internal quality + ceiling)', () => {
    it('maps the "up to Np" options to ABR with a resolution ceiling', () => {
        expect(resolveQuality('max1080')).toEqual({ quality: 'auto', maxHeight: 1080 });
        expect(resolveQuality('max720')).toEqual({ quality: 'auto', maxHeight: 720 });
        expect(resolveQuality('max480')).toEqual({ quality: 'auto', maxHeight: 480 });
        expect(resolveQuality('max360')).toEqual({ quality: 'auto', maxHeight: 360 });
    });
    it('auto = ABR no cap; lowest pins the smallest variant', () => {
        expect(resolveQuality('auto')).toEqual({ quality: 'auto', maxHeight: 0 });
        expect(resolveQuality('lowest')).toEqual({ quality: 'lowest', maxHeight: 0 });
    });
    it('still resolves legacy values + unknown falls back to auto', () => {
        expect(resolveQuality('highest')).toEqual({ quality: 'highest', maxHeight: 0 });
        expect(resolveQuality('fixed')).toEqual({ quality: 'fixed', maxHeight: 0 });
        expect(resolveQuality('garbage')).toEqual({ quality: 'auto', maxHeight: 0 });
    });
});

describe('resolutionCapBitrateBps', () => {
    const ladder = [
        { bitrate: 800_000, resolution: { height: 360 } },
        { bitrate: 1_800_000, resolution: { height: 480 } },
        { bitrate: 3_500_000, resolution: { height: 720 } },
        { bitrate: 6_500_000, resolution: { height: 1080 } },
    ];
    it('returns 0 (no cap) when disabled or no variants', () => {
        expect(resolutionCapBitrateBps(ladder, 0)).toBe(0);
        expect(resolutionCapBitrateBps([], 720)).toBe(0);
    });
    it('caps at the top bitrate of variants at/under the height ceiling', () => {
        expect(resolutionCapBitrateBps(ladder, 720)).toBe(3_500_000);
        expect(resolutionCapBitrateBps(ladder, 480)).toBe(1_800_000);
        expect(resolutionCapBitrateBps(ladder, 1080)).toBe(6_500_000);
    });
    it('pins to the lowest bitrate when every variant is taller than the cap', () => {
        expect(resolutionCapBitrateBps(ladder, 240)).toBe(800_000);
    });
    it('ignores variants with no resolution when filtering by height', () => {
        const mixed = [{ bitrate: 9_000_000 }, { bitrate: 2_000_000, resolution: { height: 720 } }];
        expect(resolutionCapBitrateBps(mixed, 720)).toBe(2_000_000);
    });
});

const presets = {
    default: { maxBitrate: 1 },
    unstable: { maxBitrate: 2 },
} as never;

/** An audio rendition as parseMaster gives it; no `uri` = carried in the variant. */
const rendition = (uri?: string) => ({
    type: 'AUDIO' as const,
    groupId: 'aud',
    name: 'English',
    language: 'eng',
    isDefault: true,
    autoselect: true,
    forced: false,
    ...(uri ? { uri } : {}),
});
/** A master with one audio rendition: the shape every case below assumed before B-183. */
const withAudio = { audio: [rendition('https://example.com/audio/eng.m3u8')] };

const base: RunnerConfig = {
    url: 'https://example.com/master.m3u8',
    sink: { kind: 'unixfd', ingestPath: '/tmp/mr-bus-41000-ingest.sock' },
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

describe('buildExtractorOverrides — fixed (no-ABR) quality', () => {
    it('quality=fixed with a resolution cap pins maxBitrate (no ABR switching)', () => {
        const o = buildExtractorOverrides(
            { ...base, quality: 'fixed', capBitrateBps: 3_500_000 },
            presets,
            withAudio,
        );
        expect(o.fixedQuality).toEqual({ kind: 'maxBitrate', bitrate: 3_500_000 });
        // ABR cap must NOT be set in a fixed pin — it would be meaningless.
        expect(o.abr).toEqual({ maxBitrate: 1 });
    });
    it('quality=fixed with no derived cap falls back to the highest variant', () => {
        const o = buildExtractorOverrides(
            { ...base, quality: 'fixed', capBitrateBps: 0 },
            presets,
            withAudio,
        );
        expect(o.fixedQuality).toEqual({ kind: 'highest' });
    });
    it('quality=auto applies capBitrate to ABR (not a fixed pin)', () => {
        const o = buildExtractorOverrides(
            { ...base, quality: 'auto', capBitrateBps: 3_500_000 },
            presets,
            withAudio,
        );
        expect(o.fixedQuality).toBeUndefined();
        expect(o.abr).toEqual({ maxBitrate: 1, capBitrate: 3_500_000 });
    });
});

describe('buildExtractorOverrides', () => {
    it('defaults: default ABR preset, all audio, no optional knobs', () => {
        const o = buildExtractorOverrides(base, presets, withAudio);
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
            withAudio,
        );
        expect(o.abr).toEqual({ maxBitrate: 2, capBitrate: 2_500_000 });
    });

    it('maps fixed quality hints; auto leaves ABR enabled', () => {
        expect(
            buildExtractorOverrides({ ...base, quality: 'highest' }, presets, withAudio)
                .fixedQuality,
        ).toEqual({ kind: 'highest' });
        expect(
            buildExtractorOverrides({ ...base, quality: 'lowest' }, presets, withAudio)
                .fixedQuality,
        ).toEqual({ kind: 'lowest' });
        expect(buildExtractorOverrides(base, presets, withAudio).fixedQuality).toBeUndefined();
    });

    it('builds latency config only from the knobs that are set', () => {
        expect(buildExtractorOverrides(base, presets, withAudio).latency).toBeUndefined();
        expect(
            buildExtractorOverrides(
                { ...base, liveSyncSec: 8, liveMaxLagSec: 30, skipOnStall: true },
                presets,
                withAudio,
            ).latency,
        ).toEqual({ liveSyncTargetSec: 8, liveMaxLatencySec: 30, skipOnStall: true });
    });

    it('passes language selections through; empty subtitles stay off', () => {
        const o = buildExtractorOverrides(
            {
                ...base,
                inlineAudio: ['eng', 'zul'],
                inlineSubtitles: ['eng'],
                allowMonoAudio: true,
            },
            presets,
            withAudio,
        );
        expect(o.inlineAudioLanguages).toEqual(['eng', 'zul']);
        expect(o.inlineSubtitleLanguages).toEqual(['eng']);
        expect(o.allowMonoAudio).toBe(true);
    });
});

describe("the inline mux only on a master's audio renditions (B-183)", () => {
    it('a master with an audio rendition: the selection, or all when none is picked', () => {
        expect(inlineAudioLanguages(['eng', 'zul'], withAudio)).toEqual(['eng', 'zul']);
        expect(inlineAudioLanguages([], withAudio)).toBe('all');
    });

    it('a media playlist: none, whatever is picked (its segments carry the audio)', () => {
        expect(inlineAudioLanguages([], undefined)).toBeUndefined();
        expect(inlineAudioLanguages(['eng'], undefined)).toBeUndefined();
    });

    it('a master whose variants carry the audio: none', () => {
        expect(inlineAudioLanguages([], { audio: [] })).toBeUndefined();
        // EXT-X-MEDIA without a URI: that audio is in the variant's segments.
        expect(inlineAudioLanguages([], { audio: [rendition()] })).toBeUndefined();
        expect(inlineAudioLanguages(['eng'], { audio: [rendition()] })).toBeUndefined();
    });

    it('one rendition with a URI is enough: hls-pipe skips the others', () => {
        const mixed = { audio: [rendition(), rendition('https://example.com/audio/eng.m3u8')] };
        expect(inlineAudioLanguages([], mixed)).toBe('all');
    });

    it('subtitles join the inline mux only beside audio renditions: it keeps just the video', () => {
        const picked = { ...base, inlineSubtitles: ['eng'] };
        expect(buildExtractorOverrides(picked, presets, withAudio).inlineSubtitleLanguages).toEqual(
            ['eng'],
        );
        expect(buildExtractorOverrides(picked, presets, undefined)).not.toHaveProperty(
            'inlineSubtitleLanguages',
        );
        expect(buildExtractorOverrides(picked, presets, { audio: [] })).not.toHaveProperty(
            'inlineSubtitleLanguages',
        );
    });

    it('buildExtractorOverrides leaves the option out for a media playlist', () => {
        const o = buildExtractorOverrides({ ...base, inlineAudio: ['eng'] }, presets, undefined);
        expect(o).toEqual({ abr: { maxBitrate: 1 }, liveStartOffsetSegments: 6 });
        expect(o).not.toHaveProperty('inlineAudioLanguages');
    });
});
