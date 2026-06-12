/*
 * hls-pipe runner — spawned by HlsPlayerModule as an isolated Node child.
 *
 * Embeds hls-pipe's Extractor and writes canonical MPEG-TS to a UDP multicast
 * group (PacedUdpTsSink) instead of stdout, so stdout stays free for one-line
 * JSON stats the parent parses. hls-pipe is ESM-only; this file compiles to
 * CJS (like the rest of the plugin) and loads it via dynamic `import()`, which
 * NodeNext preserves natively for CJS→ESM interop.
 *
 * Config arrives as a JSON blob in the HLS_CONFIG env var. Exit codes drive the
 * parent's ManagedProcess restart policy: 0 = clean (VOD end / SIGTERM, no
 * restart), non-zero = error (auto-restart with backoff).
 */
import type { ExtractorOptions } from 'hls-pipe';
// Deep import: this child only needs the sink — pulling in the engine's index
// would load the whole engine (Fastify, comms, …) into every runner process.
import { PacedUdpTsSink } from '@media-router/engine/dist/plugins/PacedUdpTsSink.js';
import { buildExtractorOverrides, type RunnerConfig } from './runnerOptions.js';

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
    // rate so the receiver's UDP buffer doesn't overflow.
    const sink = new PacedUdpTsSink(cfg.port, cfg.host);

    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const options: ExtractorOptions = {
        url: cfg.url,
        sink,
        signal: abort.signal,
        outputMode: makeOutputMode('ts-canonical'),
        ...buildExtractorOverrides(cfg, {
            default: DEFAULT_ABR_CONFIG,
            unstable: UNSTABLE_NETWORK_ABR_CONFIG,
        }),
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
