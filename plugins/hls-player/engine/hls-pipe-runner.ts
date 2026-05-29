/*
 * hls-pipe runner — spawned by HlsPlayerModule as an isolated Node child.
 *
 * Embeds hls-pipe's Extractor and writes canonical MPEG-TS to a UDP multicast
 * group (UdpTsSink) instead of stdout, so stdout stays free for one-line JSON
 * stats the parent parses. hls-pipe is ESM-only; this file compiles to CJS
 * (like the rest of the plugin) and loads it via dynamic `import()`, which
 * NodeNext preserves natively for CJS→ESM interop.
 *
 * Config arrives as a JSON blob in the HLS_CONFIG env var. Exit codes drive the
 * parent's ManagedProcess restart policy: 0 = clean (VOD end / SIGTERM, no
 * restart), non-zero = error (auto-restart with backoff).
 */
import type { AbrConfig, ExtractorOptions, LatencyConfig, QualityHint, StdoutSink } from 'hls-pipe';
import { PacedUdpTsSink } from './udpTsSink.js';

interface RunnerConfig {
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

function emitStats(bitrateMbps: number, bytesSent: number): void {
    process.stdout.write(JSON.stringify({ stats: { bitrateMbps, bytesSent } }) + '\n');
}

async function main(): Promise<void> {
    const raw = process.env.HLS_CONFIG;
    if (!raw) {
        process.stderr.write('hls-pipe-runner: missing HLS_CONFIG\n');
        process.exit(2);
    }
    const cfg = JSON.parse(raw) as RunnerConfig;

    const { Extractor, makeOutputMode, DEFAULT_ABR_CONFIG, UNSTABLE_NETWORK_ABR_CONFIG } =
        await import('hls-pipe');

    // Paced multicast sink — releases each segment's datagrams at the media
    // rate so the receiver's UDP buffer doesn't overflow. Satisfies the
    // StdoutSink write/end contract hls-pipe expects (hence the cast).
    const sink = new PacedUdpTsSink(cfg.port, cfg.host);

    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const abr: Partial<AbrConfig> = {
        ...(cfg.abrPreset === 'unstable' ? UNSTABLE_NETWORK_ABR_CONFIG : DEFAULT_ABR_CONFIG),
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

    const options: ExtractorOptions = {
        url: cfg.url,
        sink: sink as unknown as StdoutSink,
        signal: abort.signal,
        outputMode: makeOutputMode('ts-canonical'),
        abr,
        inlineAudioLanguages: cfg.inlineAudio.length ? cfg.inlineAudio : 'all',
        liveStartOffsetSegments: cfg.liveStartSegments,
        ...(fixedQuality ? { fixedQuality } : {}),
        ...(Object.keys(latency).length ? { latency } : {}),
        ...(cfg.inlineSubtitles.length ? { inlineSubtitleLanguages: cfg.inlineSubtitles } : {}),
        ...(cfg.allowMonoAudio ? { allowMonoAudio: true } : {}),
        log: (msg: string) => process.stderr.write(`${msg}\n`),
    };

    let lastBytes = 0;
    let lastAt = Date.now();
    const statsTimer = setInterval(() => {
        const now = Date.now();
        const bytes = sink.bytesSent;
        const dt = (now - lastAt) / 1000;
        const mbps = dt > 0 ? ((bytes - lastBytes) * 8) / dt / 1e6 : 0;
        lastBytes = bytes;
        lastAt = now;
        emitStats(Number(mbps.toFixed(3)), bytes);
    }, 2000);
    statsTimer.unref();

    try {
        await new Extractor(options).run();
        await sink.end();
        clearInterval(statsTimer);
        process.exit(0);
    } catch (err) {
        clearInterval(statsTimer);
        // SIGTERM / user-stop aborts cleanly — don't trip the restart policy.
        if (err instanceof Error && err.name === 'AbortError') process.exit(0);
        process.stderr.write(
            `hls-pipe error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    }
}

void main();
