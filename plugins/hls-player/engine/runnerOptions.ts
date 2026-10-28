/*
 * Pure mapping from the module's RunnerConfig (the HLS_CONFIG env blob) to
 * hls-pipe ExtractorOptions overrides. Kept free of I/O and hls-pipe runtime
 * imports so it can be unit-tested without spawning anything — the runner
 * supplies the ABR presets it dynamically imported and the master playlist it
 * fetched (none for a media playlist), and spreads the result into its
 * ExtractorOptions.
 */
import type { AbrConfig, LatencyConfig, MasterPlaylist, QualityHint } from 'hls-pipe';

/** Bus egress descriptor — the paced sink the runner instantiates. */
export type RunnerSink = { kind: 'unixfd'; ingestPath: string };

export interface RunnerConfig {
    url: string;
    sink: RunnerSink;
    // 'auto' = ABR (switches; capBitrateBps caps the ceiling).
    // 'highest'/'lowest' = pin the top/bottom variant (no ABR).
    // 'fixed' = pin the highest variant at/under the resolution ceiling
    // (capBitrateBps derived from maxHeight), no ABR — avoids the mid-stream
    // resolution switches that make GStreamer renegotiate the decoder and hitch.
    quality: 'auto' | 'highest' | 'lowest' | 'fixed';
    capBitrateBps: number;
    abrPreset: 'default' | 'unstable';
    inlineAudio: string[]; // [] = all of a master's audio renditions
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
    inlineAudioLanguages?: string[] | 'all';
    liveStartOffsetSegments: number;
    fixedQuality?: QualityHint;
    latency?: Partial<LatencyConfig>;
    inlineSubtitleLanguages?: string[];
    allowMonoAudio?: boolean;
}

/**
 * Translate a max-resolution ABR ceiling into a bitrate cap, using the master
 * playlist's variants. hls-pipe caps ABR by bitrate, not resolution, so we map
 * "≤ maxHeight" to "≤ the highest bitrate among variants at/under that height"
 * — standard HLS ladders are monotonic (higher res ⇒ higher bitrate), so the
 * bitrate cap keeps ABR on the ≤maxHeight rungs. Returns 0 (no cap) when
 * disabled or there's no variant info. If every variant is taller than the cap,
 * pins to the lowest variant's bitrate so playback never exceeds what the box
 * can decode.
 */
export function resolutionCapBitrateBps(
    variants: Array<{ bitrate: number; resolution?: { height: number } }>,
    maxHeight: number,
): number {
    if (maxHeight <= 0 || variants.length === 0) return 0;
    const eligible = variants.filter(
        (v) => typeof v.resolution?.height === 'number' && v.resolution.height <= maxHeight,
    );
    if (eligible.length > 0) return Math.max(...eligible.map((v) => v.bitrate));
    return Math.min(...variants.map((v) => v.bitrate));
}

/**
 * Map the single user-facing Quality dropdown to the internal (quality,
 * maxHeight) pair. One control instead of three (quality + max-resolution +
 * cap-bitrate): "Auto" adapts with no ceiling; the "up to Np" options are ABR
 * capped at that resolution (smooth switches via decodebin3); "lowest" pins the
 * smallest variant. Legacy values (highest/fixed/auto + a separate maxHeight)
 * still resolve so older configs keep working.
 */
export function resolveQuality(ui: string): {
    quality: RunnerConfig['quality'];
    maxHeight: number;
} {
    switch (ui) {
        case 'max1080':
            return { quality: 'auto', maxHeight: 1080 };
        case 'max720':
            return { quality: 'auto', maxHeight: 720 };
        case 'max480':
            return { quality: 'auto', maxHeight: 480 };
        case 'max360':
            return { quality: 'auto', maxHeight: 360 };
        case 'lowest':
            return { quality: 'lowest', maxHeight: 0 };
        case 'highest': // legacy
            return { quality: 'highest', maxHeight: 0 };
        case 'fixed': // legacy
            return { quality: 'fixed', maxHeight: 0 };
        case 'auto':
        default:
            return { quality: 'auto', maxHeight: 0 };
    }
}

/**
 * The languages for hls-pipe to mux in from a master's audio renditions; none on a media
 * playlist or a master whose variants carry the audio (hls-pipe throws on a selection
 * there), whose segments then pass through whole.
 */
export function inlineAudioLanguages(
    selection: string[],
    master: Pick<MasterPlaylist, 'audio'> | undefined,
): string[] | 'all' | undefined {
    if (!master?.audio.some((r) => r.uri)) return undefined;
    return selection.length ? selection : 'all';
}

export function buildExtractorOverrides(
    cfg: RunnerConfig,
    presets: AbrPresets,
    master: Pick<MasterPlaylist, 'audio'> | undefined,
): ExtractorOverrides {
    const abr: Partial<AbrConfig> = {
        ...(cfg.abrPreset === 'unstable' ? presets.unstable : presets.default),
        // The bitrate cap only applies to actual ABR ('auto'); the fixed modes
        // pin a single variant, so ABR config is moot there.
        ...(cfg.quality === 'auto' && cfg.capBitrateBps > 0
            ? { capBitrate: cfg.capBitrateBps }
            : {}),
    };

    const latency: Partial<LatencyConfig> = {};
    if (cfg.liveSyncSec > 0) latency.liveSyncTargetSec = cfg.liveSyncSec;
    if (cfg.liveMaxLagSec > 0) latency.liveMaxLatencySec = cfg.liveMaxLagSec;
    if (cfg.skipOnStall) latency.skipOnStall = true;

    // 'fixed' pins the highest variant at/under the resolution ceiling (no ABR
    // → no mid-stream resolution switches → no decoder-renegotiation hitch).
    // `maxBitrate` is hls-pipe's fixed (non-ABR) "highest variant ≤ N" pick.
    // With no derived cap (no variants probed / maxHeight unset) it falls back
    // to the top variant, same as 'highest'.
    const fixedQuality: QualityHint | undefined =
        cfg.quality === 'highest'
            ? { kind: 'highest' }
            : cfg.quality === 'lowest'
              ? { kind: 'lowest' }
              : cfg.quality === 'fixed'
                ? cfg.capBitrateBps > 0
                    ? { kind: 'maxBitrate', bitrate: cfg.capBitrateBps }
                    : { kind: 'highest' }
                : undefined;

    // Subtitles ride the same inline mux, which keeps only the segments' video:
    // without audio renditions they stay out, and the segments keep their audio.
    const audio = inlineAudioLanguages(cfg.inlineAudio, master);
    const subtitles = audio && cfg.inlineSubtitles.length ? cfg.inlineSubtitles : undefined;
    return {
        abr,
        ...(audio ? { inlineAudioLanguages: audio } : {}),
        liveStartOffsetSegments: cfg.liveStartSegments,
        ...(fixedQuality ? { fixedQuality } : {}),
        ...(Object.keys(latency).length ? { latency } : {}),
        ...(subtitles ? { inlineSubtitleLanguages: subtitles } : {}),
        ...(cfg.allowMonoAudio ? { allowMonoAudio: true } : {}),
    };
}
