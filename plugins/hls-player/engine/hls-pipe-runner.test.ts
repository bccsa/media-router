/*
 * Shutdown contract for the hls-pipe runner child.
 *
 * The runner is spawned by ManagedProcess, which stops it with SIGTERM and
 * escalates to SIGKILL after a 3 s grace. Field behaviour before this suite:
 * EVERY stop/URL-change burned the full grace and got SIGKILLed, because the
 * extractor spends most of its life parked inside `WorkerPacedTsSink.write`'s
 * back-pressure loop (up to 60 s of read-ahead media) — an AbortController the
 * sink never consulted could not unwind it, and the clean-exit path's
 * `sink.end()` then drains that same tail at MEDIA RATE.
 *
 * These tests spawn the real runner (TS source via tsx, as production spawns
 * the compiled twin) against a real HLS origin and a real ingest socket, and
 * assert both exit code and latency. `EXTINF:120` makes the park deterministic:
 * one segment overshoots the 60 s budget, so the extractor is wedged in
 * `write` from the first segment on and stays there for the whole test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createUnixServer, type Server as UnixServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNNER = join(__dirname, 'hls-pipe-runner.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
/** Real 2 s MPEG-TS segment — hls-pipe's own demux/remux fixture. */
const SEGMENT_FIXTURE = join(
    __dirname,
    '..',
    '..',
    '..',
    'packages',
    'hls-pipe',
    'tests',
    'fixtures',
    'synth-2s.ts',
);

/**
 * A master with one variant and one audio rendition — the shape the module
 * always produces (`inlineAudio: []` → 'all', which hls-pipe only accepts on a
 * master). Both media playlists are 60 × 2 s, i.e. 120 s of media: double the
 * sink's 60 s read-ahead budget, so the extractor is guaranteed to park in
 * `write` roughly half way through and stay there (the paced drain only
 * releases 2 s of media per 2 s of wall clock).
 */
const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud"
video.m3u8
`;

const SEGMENT_COUNT = 60;

const MEDIA_PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...Array.from({ length: SEGMENT_COUNT }, (_, i) => `#EXTINF:2,\nseg${i}.ts`),
    '#EXT-X-ENDLIST',
    '',
].join('\n');

interface Rig {
    dir: string;
    ingestPath: string;
    ingest: UnixServer;
    origin: HttpServer;
    originPort: number;
    /** Bytes the runner has pushed to the ingest socket. */
    ingestBytes: () => number;
    /** Playlist/segment paths the origin served. */
    hits: string[];
    /** Epoch ms of the most recent origin request. */
    lastHitAt: () => number;
    /** When set, the origin accepts requests and never answers them. */
    stall: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long the origin has been idle — the extractor's park signature. */
const idleForMs = (r: Rig): number => Date.now() - r.lastHitAt();

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
    }
}

async function rig(): Promise<Rig> {
    const dir = mkdtempSync(join(tmpdir(), 'hpr-'));
    const ingestPath = join(dir, 'ingest.sock');
    let bytes = 0;
    const ingest = createUnixServer((sock) => {
        sock.on('data', (d) => {
            bytes += d.length;
        });
        sock.on('error', () => {});
    });
    const segment = readFileSync(SEGMENT_FIXTURE);
    const hits: string[] = [];
    const state = { stall: false, lastHitAt: Date.now() };
    const origin = createHttpServer((req, res) => {
        hits.push(req.url ?? '');
        state.lastHitAt = Date.now();
        if (state.stall) return; // hold the request open forever
        if (req.url?.endsWith('.m3u8')) {
            res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            res.end(req.url.endsWith('master.m3u8') ? MASTER : MEDIA_PLAYLIST);
        } else if (req.url?.endsWith('.ts')) {
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            res.end(segment);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise<void>((r) => ingest.listen(ingestPath, r));
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    const addr = origin.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no origin port');
    return {
        dir,
        ingestPath,
        ingest,
        origin,
        originPort: addr.port,
        ingestBytes: () => bytes,
        hits,
        lastHitAt: () => state.lastHitAt,
        get stall() {
            return state.stall;
        },
        set stall(v: boolean) {
            state.stall = v;
        },
    };
}

function runnerConfig(r: Rig): Record<string, unknown> {
    return {
        url: `http://127.0.0.1:${r.originPort}/master.m3u8`,
        sink: { kind: 'unixfd', ingestPath: r.ingestPath },
        quality: 'auto',
        capBitrateBps: 0,
        abrPreset: 'default',
        inlineAudio: [],
        inlineSubtitles: [],
        allowMonoAudio: false,
        liveStartSegments: 6,
        liveSyncSec: 0,
        liveMaxLagSec: 30,
        skipOnStall: false,
    };
}

interface Spawned {
    child: ChildProcess;
    stderr: () => string;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnRunner(r: Rig): Spawned {
    const child = spawn(TSX, [RUNNER], {
        env: { ...process.env, HLS_CONFIG: JSON.stringify(runnerConfig(r)) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
    });
    child.stdout?.on('data', () => {});
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
        child.once('exit', (code, signal) => res({ code, signal }));
    });
    return { child, stderr: () => err, exited };
}

/**
 * SIGTERM the child and measure. ManagedProcess gives 3 s before SIGKILL; this
 * watchdog is deliberately shorter so a regression reports "still alive after
 * N ms" instead of stalling the suite until the vitest timeout.
 */
async function termAndMeasure(
    s: Spawned,
    watchdogMs = 4000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }> {
    const t0 = performance.now();
    s.child.kill('SIGTERM');
    const timedOut = Symbol('timeout');
    const outcome = await Promise.race([s.exited, sleep(watchdogMs).then(() => timedOut)]);
    const elapsedMs = performance.now() - t0;
    if (outcome === timedOut) {
        throw new Error(
            `runner still alive ${Math.round(elapsedMs)} ms after SIGTERM ` +
                `(ManagedProcess would SIGKILL it)\n--- runner stderr ---\n${s.stderr()}`,
        );
    }
    return { ...(outcome as { code: number | null; signal: NodeJS.Signals | null }), elapsedMs };
}

describe('hls-pipe-runner SIGTERM shutdown', () => {
    let r: Rig;
    let spawned: Spawned | null = null;

    beforeEach(async () => {
        expect(existsSync(TSX), `tsx not found at ${TSX}`).toBe(true);
        expect(existsSync(SEGMENT_FIXTURE), `fixture missing: ${SEGMENT_FIXTURE}`).toBe(true);
        r = await rig();
    });

    afterEach(async () => {
        if (spawned && spawned.child.exitCode === null) {
            spawned.child.kill('SIGKILL');
            await spawned.exited;
        }
        spawned = null;
        r.ingest.close();
        r.origin.close();
        rmSync(r.dir, { recursive: true, force: true });
    });

    it(
        'exits 0 within 1 s while parked on sink back-pressure',
        async () => {
            spawned = spawnRunner(r);
            // Park detector: the extractor stops requesting segments the
            // moment it wedges inside write()'s back-pressure loop, while the
            // paced sink keeps trickling to the ingest socket. Origin hits
            // going quiet with bytes flowing IS the parked state.
            try {
                await waitFor(
                    () => r.ingestBytes() > 0 && idleForMs(r) > 700 && r.hits.length > 10,
                    30_000,
                    'the extractor to park on sink back-pressure',
                );
            } catch (e) {
                throw new Error(
                    `${(e as Error).message}\nhits=${r.hits.length} ingestBytes=${r.ingestBytes()}` +
                        `\n--- runner stderr ---\n${spawned.stderr()}`,
                );
            }

            const { code, signal, elapsedMs } = await termAndMeasure(spawned);
            expect({ code, signal }).toEqual({ code: 0, signal: null });
            expect(elapsedMs, `took ${Math.round(elapsedMs)} ms`).toBeLessThan(1000);
        },
        60_000,
    );

    it(
        'exits 0 within 1 s while blocked on an unresponsive origin',
        async () => {
            r.stall = true;
            spawned = spawnRunner(r);
            await waitFor(() => r.hits.length > 0, 25_000, 'first origin request');

            const { code, signal, elapsedMs } = await termAndMeasure(spawned);
            expect({ code, signal }).toEqual({ code: 0, signal: null });
            expect(elapsedMs, `took ${Math.round(elapsedMs)} ms`).toBeLessThan(1000);
        },
        40_000,
    );
});
