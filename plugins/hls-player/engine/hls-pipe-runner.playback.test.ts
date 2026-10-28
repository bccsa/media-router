/*
 * What the runner plays (B-183): each playlist shape from a local origin, with the module's
 * default settings, a short VOD to its end (exit 0 is "playlist complete", an error a restart).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createUnixServer, type Server as UnixServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requireFreshEngineBuild } from './testing/engineBuild.js';
import { filterPids, scanTs } from './testing/tsScan.js';

beforeAll(requireFreshEngineBuild);

const RUNNER = join(__dirname, 'hls-pipe-runner.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');
/** 2 s of H.264 on 0x100 and AAC on 0x101 (50 and 6 PES): hls-pipe's own fixture. */
const FIXTURE = join(
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
const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const SEGMENTS = 2;

const mediaPlaylist = (prefix: string, ext = 'ts'): string =>
    [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        ...Array.from({ length: SEGMENTS }, (_, i) => `#EXTINF:2,\n${prefix}${i}.${ext}`),
        '#EXT-X-ENDLIST',
        '',
    ].join('\n');

/** One cue per segment, on the fixture's timeline (its first PTS is 1.4 s). */
const VTT =
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.100 --> 00:00:01.900\nHello\n';

/** Path → body. av*.ts carry both streams, v*.ts the video alone, a*.ts the audio alone. */
function originFiles(segment: Buffer): Map<string, string | Buffer> {
    const files = new Map<string, string | Buffer>([
        // b92's origin: ffmpeg's HLS muxer, one playlist, both streams in its segments.
        ['/live.m3u8', mediaPlaylist('av')],
        // A ladder of one variant whose segments carry the audio: no audio rendition.
        [
            '/muxed-master.m3u8',
            '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00d,mp4a.40.2"\nlive.m3u8\n',
        ],
        // The CDN shape: video variants and the audio as renditions.
        [
            '/master.m3u8',
            [
                '#EXTM3U',
                '#EXT-X-VERSION:3',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="aud"',
                'video.m3u8',
                '',
            ].join('\n'),
        ],
        // The same with a subtitle rendition: hls-pipe's inline mux would keep only the video.
        [
            '/muxed-subs-master.m3u8',
            [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,URI="subs.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42c00d,mp4a.40.2",SUBTITLES="subs"',
                'live.m3u8',
                '',
            ].join('\n'),
        ],
        ['/video.m3u8', mediaPlaylist('v')],
        ['/audio.m3u8', mediaPlaylist('a')],
        ['/subs.m3u8', mediaPlaylist('s', 'vtt')],
    ]);
    const videoOnly = filterPids(segment, (pid) => pid !== AUDIO_PID);
    const audioOnly = filterPids(segment, (pid) => pid !== VIDEO_PID);
    for (let i = 0; i < SEGMENTS; i++) {
        files.set(`/av${i}.ts`, segment);
        files.set(`/v${i}.ts`, videoOnly);
        files.set(`/a${i}.ts`, audioOnly);
        files.set(`/s${i}.vtt`, VTT);
    }
    return files;
}

interface Rig {
    dir: string;
    ingestPath: string;
    ingest: UnixServer;
    origin: HttpServer;
    base: string;
    /** Everything the runner wrote to the ingest socket. */
    received: () => Buffer;
}

async function rig(): Promise<Rig> {
    const dir = mkdtempSync(join(tmpdir(), 'hpp-'));
    const ingestPath = join(dir, 'ingest.sock');
    const chunks: Buffer[] = [];
    const ingest = createUnixServer((sock) => {
        sock.on('data', (d: Buffer) => chunks.push(d));
        sock.on('error', () => {});
    });
    const files = originFiles(readFileSync(FIXTURE));
    const origin = createHttpServer((req, res) => {
        const body = files.get(req.url ?? '');
        if (body === undefined) {
            res.writeHead(404);
            res.end();
            return;
        }
        const url = req.url ?? '';
        const type = url.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : url.endsWith('.vtt')
              ? 'text/vtt'
              : 'video/mp2t';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
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
        base: `http://127.0.0.1:${addr.port}`,
        received: () => Buffer.concat(chunks),
    };
}

/** HlsPlayerModule.buildRunnerConfig's output for a module left at its defaults. */
function moduleDefaults(url: string, ingestPath: string): Record<string, unknown> {
    return {
        url,
        sink: { kind: 'unixfd', ingestPath },
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

interface Played {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    out: Buffer;
}

/** Run the runner on `path` until it exits; a run past 40 s is killed and fails. */
async function play(r: Rig, path: string, settings: Record<string, unknown> = {}): Promise<Played> {
    const cfg = { ...moduleDefaults(r.base + path, r.ingestPath), ...settings };
    const child = spawn(TSX, [RUNNER], {
        env: { ...process.env, HLS_CONFIG: JSON.stringify(cfg) },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    const { code, signal } = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }>((res) => child.once('exit', (c, s) => res({ code: c, signal: s })));
    clearTimeout(timer);
    return { code, signal, stderr, out: r.received() };
}

/** Played to the end with no error: what the module reads as "playlist complete". */
function expectCleanEnd(p: Played): void {
    expect({ code: p.code, signal: p.signal }, p.stderr).toEqual({ code: 0, signal: null });
    expect(p.stderr).not.toContain('hls-pipe error');
}

describe('hls-pipe-runner plays each playlist shape (module defaults)', () => {
    let r: Rig;
    const segment = readFileSync(FIXTURE);
    const fixture = scanTs(segment);
    const videoPes = fixture.unitStarts.get(VIDEO_PID)!;
    const audioPes = fixture.unitStarts.get(AUDIO_PID)!;

    /** The segments' own bytes, in order: video and audio as the origin muxed them. */
    function expectPassedThrough(p: Played): void {
        const out = scanTs(p.out);
        expect(out.unitStarts.get(VIDEO_PID)).toBe(SEGMENTS * videoPes);
        expect(out.unitStarts.get(AUDIO_PID)).toBe(SEGMENTS * audioPes);
        const whole = Buffer.concat(Array.from({ length: SEGMENTS }, () => segment));
        expect(p.out.equals(whole), `${p.out.length} bytes out, ${whole.length} in`).toBe(true);
    }

    beforeEach(async () => {
        expect(existsSync(TSX), `tsx not found at ${TSX}`).toBe(true);
        expect(fixture.streams.map((s) => [s.pid, s.streamType])).toEqual([
            [VIDEO_PID, 0x1b],
            [AUDIO_PID, 0x0f],
        ]);
        r = await rig();
    });

    afterEach(() => {
        r.ingest.close();
        r.origin.close();
        rmSync(r.dir, { recursive: true, force: true });
    });

    it('a plain media playlist: its segments pass through whole, video and audio', async () => {
        const p = await play(r, '/live.m3u8');
        expectCleanEnd(p);
        expect(scanTs(p.out).streams.map((s) => [s.pid, s.streamType])).toEqual([
            [VIDEO_PID, 0x1b],
            [AUDIO_PID, 0x0f],
        ]);
        expectPassedThrough(p);
        expect(p.stderr).toContain('no audio renditions: the segments pass through whole');
    }, 60_000);

    it('a master whose variant carries the audio: passed through the same way', async () => {
        const p = await play(r, '/muxed-master.m3u8');
        expectCleanEnd(p);
        expectPassedThrough(p);
    }, 60_000);

    it('the same with a subtitle language picked: the audio is kept, the subtitles left out', async () => {
        const p = await play(r, '/muxed-subs-master.m3u8', { inlineSubtitles: ['eng'] });
        expectCleanEnd(p);
        expectPassedThrough(p);
    }, 60_000);

    it('a master with an audio rendition: muxed in as before, tagged with its language', async () => {
        const p = await play(r, '/master.m3u8');
        expectCleanEnd(p);
        const out = scanTs(p.out);
        // The variant's segments hold no audio: it can only come from the rendition.
        expect(out.streams).toContainEqual({ pid: AUDIO_PID, streamType: 0x0f, language: 'eng' });
        expect(out.unitStarts.get(VIDEO_PID)).toBe(SEGMENTS * videoPes);
        expect(out.unitStarts.get(AUDIO_PID) ?? 0).toBeGreaterThan(0);
        expect(p.stderr).not.toContain('no audio renditions');
    }, 60_000);
});
