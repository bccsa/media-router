import type { CodecId, ImplId, ThroughputSample } from '@media-router/engine';

/** The `encoder` status section: what is configured and which impl resolved. */
export function encoderStatus(
    config: Record<string, unknown>,
    impl: ImplId | null,
): Record<string, string | number> {
    return {
        codec: (config.codec as CodecId) ?? 'h264',
        impl: impl ?? 'unavailable',
        resolution: (config.resolution as string) ?? '1920x1080',
        framerate: `${(config.framerate as number) ?? 30} fps`,
        bitrate: (config.bitrate as number) ?? 4000,
    };
}

/** The `throughput` status section from one poller sample. */
export function throughputStatus(sample: ThroughputSample): Record<string, string> {
    return {
        'Output Bitrate': `${sample.bitrateKbps} kbps`,
        'Total Bytes': `${(sample.totalBytes / 1024 / 1024).toFixed(1)} MB`,
    };
}
