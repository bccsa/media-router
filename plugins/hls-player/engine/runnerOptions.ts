/*
 * Pure mapping from the module's RunnerConfig (the HLS_CONFIG env blob) to
 * hls-pipe ExtractorOptions overrides. Kept free of I/O and hls-pipe runtime
 * imports so it can be unit-tested without spawning anything — the runner
 * supplies the ABR presets it dynamically imported and spreads the result
 * into its ExtractorOptions.
 */
import type { AbrConfig, LatencyConfig, QualityHint } from 'hls-pipe';

export interface RunnerConfig {
    url: string;
    host: string;
    port: number;
    quality: 'auto' | 'highest' | 'lowest';
    capBitrateBps: number;
    abrPreset: 'default' | 'unstable';
    inlineAudio: string[]; // [] = all
    inlineSubtitles: string[]; // [] = off
    allowMonoAudio: boolean;
    liveStartSegments: number;
    liveSyncSec: number;
    liveMaxLagSec: number;
    skipOnStall: boolean;
}

export interface AbrPresets {
    default: Partial<AbrConfig>;
    unstable: Partial<AbrConfig>;
}

export interface ExtractorOverrides {
    abr: Partial<AbrConfig>;
    inlineAudioLanguages: string[] | 'all';
    liveStartOffsetSegments: number;
    fixedQuality?: QualityHint;
    latency?: Partial<LatencyConfig>;
    inlineSubtitleLanguages?: string[];
    allowMonoAudio?: boolean;
}

export function buildExtractorOverrides(cfg: RunnerConfig, presets: AbrPresets): ExtractorOverrides {
    const abr: Partial<AbrConfig> = {
        ...(cfg.abrPreset === 'unstable' ? presets.unstable : presets.default),
        ...(cfg.capBitrateBps > 0 ? { capBitrate: cfg.capBitrateBps } : {}),
    };

    const latency: Partial<LatencyConfig> = {};
    if (cfg.liveSyncSec > 0) latency.liveSyncTargetSec = cfg.liveSyncSec;
    if (cfg.liveMaxLagSec > 0) latency.liveMaxLatencySec = cfg.liveMaxLagSec;
    if (cfg.skipOnStall) latency.skipOnStall = true;

    const fixedQuality: QualityHint | undefined =
        cfg.quality === 'highest'
            ? { kind: 'highest' }
            : cfg.quality === 'lowest'
              ? { kind: 'lowest' }
              : undefined;

    return {
        abr,
        inlineAudioLanguages: cfg.inlineAudio.length ? cfg.inlineAudio : 'all',
        liveStartOffsetSegments: cfg.liveStartSegments,
        ...(fixedQuality ? { fixedQuality } : {}),
        ...(Object.keys(latency).length ? { latency } : {}),
        ...(cfg.inlineSubtitles.length ? { inlineSubtitleLanguages: cfg.inlineSubtitles } : {}),
        ...(cfg.allowMonoAudio ? { allowMonoAudio: true } : {}),
    };
}
