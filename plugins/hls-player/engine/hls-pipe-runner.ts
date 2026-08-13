/*
 * hls-pipe runner — spawned by HlsPlayerModule as an isolated Node child.
 *
 * Embeds hls-pipe's Extractor and writes paced canonical MPEG-TS to the
 * module's unixfd-fanout sidecar ingest socket (PacedUnixStreamTsSink)
 * instead of stdout, so stdout stays free for one-line JSON stats the parent
 * parses. hls-pipe is ESM-only; this file compiles to CJS
 * (like the rest of the plugin) and loads it via dynamic `import()`, which
 * NodeNext preserves natively for CJS→ESM interop.
 *
 * Config arrives as a JSON blob in the HLS_CONFIG env var. Exit codes drive the
 * parent's ManagedProcess restart policy: 0 = clean (VOD end / SIGTERM, no
 * restart), non-zero = error (auto-restart with backoff).
 */
import type { ExtractorOptions } from 'hls-pipe';
import { buildExtractorOverrides, type RunnerConfig } from './runnerOptions.js';
import { WorkerPacedTsSink } from './workerPacedSink.js';

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

    // Paced sink — releases each segment's datagrams at the media rate so
    // the sidecar's per-consumer queues don't overflow.
    // Runs on a WORKER THREAD (WorkerPacedTsSink): the extractor's
    // per-segment fetch/decrypt/demux/mux is one main-thread macrotask, which
    // used to starve the drain timers and stall the wire ~100 ms at every
    // segment boundary.
    if (cfg.sink?.kind !== 'unixfd') {
        process.stderr.write('hls-pipe-runner: missing unixfd sink descriptor\n');
        process.exit(2);
    }
    const sink = new WorkerPacedTsSink({ kind: 'unixfd', ingestPath: cfg.sink.ingestPath });

    const abort = new AbortController();
    let statsTimer: NodeJS.Timeout | undefined;
    let shuttingDown = false;

    // Every module stop and every URL change arrives here as SIGTERM, with 3 s
    // of ManagedProcess grace before SIGKILL. Aborting the controller alone
    // never made that deadline: the extractor spends most of its life parked
    // inside sink.write()'s back-pressure loop (up to 60 s of read-ahead
    // media), which does not watch the signal, and the clean-exit path then
    // drains that same tail at media rate. So: abort the fetches, ABANDON the
    // sink (unparks the wedged write, closes the ingest socket, drops the
    // undelivered tail), and hold a short deadline over the whole thing —
    // nothing in hls-pipe promises to observe the signal at every await, and
    // the per-segment demux/mux between two awaits cannot be interrupted at
    // all. Exit 0: a deliberate stop must not read as a crash to the parent's
    // restart policy.
    const shutdown = (): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        abort.abort();
        clearInterval(statsTimer);
        sink.abandon();
        setTimeout(() => process.exit(0), 300);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

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
    statsTimer = setInterval(() => {
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
        // Shutting down: the sink is already abandoned, so end() would be a
        // no-op — but skip it explicitly, it is the tail-drain that used to
        // outlive the grace period.
        if (shuttingDown) process.exit(0);
        await sink.end();
        clearInterval(statsTimer);
        process.exit(0);
    } catch (err) {
        clearInterval(statsTimer);
        // SIGTERM / user-stop aborts cleanly — don't trip the restart policy.
        // The shuttingDown check comes first: unwinding after abandon can
        // surface as any error (an aborted fetch, a dead-worker write), and
        // none of them are faults.
        if (shuttingDown) process.exit(0);
        if (err instanceof Error && err.name === 'AbortError') process.exit(0);
        process.stderr.write(
            `hls-pipe error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    }
}

void main();
