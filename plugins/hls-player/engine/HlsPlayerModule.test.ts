import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { isMasterPlaylist } from 'hls-pipe';
import { existsSync } from 'node:fs';

// hls-pipe is ESM and the probe loads it via dynamic import — mock it so tests
// neither hit the network nor depend on the built library. The fetch mock is
// URL-driven: '…fail…' rejects (probe-failure paths), '…slow…' resolves late
// (live-update serialization).
vi.mock('hls-pipe', () => {
    const rendition = (type: string, name: string, language: string) => ({
        type,
        groupId: 'g',
        name,
        language,
        isDefault: false,
        autoselect: true,
        forced: false,
    });
    return {
        NodeLoader: vi.fn().mockImplementation(() => ({
            fetch: vi.fn(async ({ url }: { url: string }) => {
                if (url.includes('fail')) throw new Error('fetch failed');
                if (url.includes('slow')) await new Promise((r) => setTimeout(r, 25));
                return { body: Buffer.from('#EXTM3U') };
            }),
        })),
        isMasterPlaylist: vi.fn(() => true),
        parseMaster: vi.fn(() => ({
            variants: [],
            audio: [rendition('AUDIO', 'English', 'eng'), rendition('AUDIO', 'isiZulu', 'zul')],
            subtitles: [rendition('SUBTITLES', 'English', 'eng')],
            closedCaptions: [],
            independentSegments: false,
        })),
    };
});

// The module resolves both the compiled runner and the engine's fan-out
// sidecar with existsSync — pretend both are built.
vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: vi.fn(() => true),
}));

import { HlsPlayerModule } from './HlsPlayerModule.js';

function makeModule() {
    // Real emitter so tests can fire ManagedProcess lifecycle events.
    // writeLine covers the unixfd sidecar's stdin control channel.
    const spawn = vi.fn(() =>
        Object.assign(new EventEmitter(), { destroyed: false, writeLine: vi.fn(() => true) }),
    );
    const kill = vi.fn(async () => {});
    const module = new HlsPlayerModule() as any;
    module.services = {
        instanceId: 'hls-1',
        mediaRouter: {
            assignBusChannel: vi.fn(),
            getBusChannel: vi.fn(() => ({ port: 41000 })),
            onProducerPlaying: vi.fn(),
        },
        processManager: { spawn, kill },
    };
    module.config = {};
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    module.setHealth = vi.fn();
    module.setFieldOptions = vi.fn();
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    return { module, spawn, kill };
}

/** HLS_CONFIG from the Nth spawn call. Spawn 0 is always the fan-out sidecar,
 *  so the hls runner's config lives at index 1 (first launch). */
function runnerConfigAt(spawn: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
    return JSON.parse(spawn.mock.calls[n][1].env.HLS_CONFIG);
}

/** spawn call 0 = the fan-out sidecar (always first, even idle). */
const sidecarOf = (spawn: ReturnType<typeof vi.fn>) => ({
    proc: spawn.mock.results[0]!.value as EventEmitter & {
        writeLine: ReturnType<typeof vi.fn>;
    },
    opts: spawn.mock.calls[0]![1] as {
        command: string;
        args: string[];
        stdin?: boolean;
        onStdout: (line: string) => void;
    },
});

beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe('HlsPlayerModule.buildPipeline', () => {
    it('returns null — hls-pipe runner does the work, no GStreamer pipeline', () => {
        const { module } = makeModule();
        expect(module.buildPipeline()).toBeNull();
    });
});

describe('HlsPlayerModule.getLiveUpdatableParams', () => {
    it('only URL applies live; language changes need a module restart', () => {
        const { module } = makeModule();
        expect(module.getLiveUpdatableParams()).toEqual(['url']);
    });
});

describe('HlsPlayerModule.onStart', () => {
    it('with no URL: reserves the channel, starts the sidecar and sits idle (warning), never spawns the runner', async () => {
        const { module, spawn } = makeModule();
        await module.onStart();
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('hls-1');
        expect(module.setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('URL'));
        expect(spawn).toHaveBeenCalledOnce(); // just the sidecar
        expect(module.running).toBe(true); // running-but-idle, ready for a pasted URL
    });

    it('spawns the fan-out sidecar even while idle — consumers gate on its edge sockets', async () => {
        const { module, spawn } = makeModule();
        await module.onStart(); // no URL
        expect(spawn).toHaveBeenCalledOnce();
        const { opts } = sidecarOf(spawn);
        expect(opts.command).toBe('python3');
        expect(opts.args.join(' ')).toContain('--ingest /tmp/mr-bus-41000-ingest.sock');
        expect(opts.args.join(' ')).toContain('video/mpegts');
        expect(opts.stdin).toBe(true);
        expect(module.getBusAttachTarget()).not.toBeNull();
    });

    it('assigns a bus channel, spawns sidecar + runner with the source URL and unixfd sink', async () => {
        const { module, spawn } = makeModule();
        module.config = { url: 'https://example.com/master.m3u8', quality: 'auto' };
        await module.onStart();

        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('hls-1');
        expect(spawn).toHaveBeenCalledTimes(2); // sidecar first, then the hls runner
        const cfg = runnerConfigAt(spawn, 1);
        expect(cfg).toMatchObject({
            url: 'https://example.com/master.m3u8',
            quality: 'auto',
            inlineAudio: [],
            inlineSubtitles: [],
            sink: { kind: 'unixfd', ingestPath: '/tmp/mr-bus-41000-ingest.sock' },
        });
        // Bus identity is the channel port keying the socket paths — no
        // network endpoint remains in the runner config.
        expect(cfg).not.toHaveProperty('host');
        expect(cfg).not.toHaveProperty('port');
        expect(module.running).toBe(true);
        expect(module.setHealth).toHaveBeenCalledWith('ok');
    });

    it('reports an error when the runner is not built (dev tsx fallback without dist)', async () => {
        const { module, spawn } = makeModule();
        // Sidecar script resolves fine; only the compiled runner is missing.
        (existsSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
            (p: unknown) => !String(p).includes('hls-pipe-runner'),
        );
        module.config = { url: 'https://example.com/master.m3u8' };
        await module.onStart();
        expect(spawn).toHaveBeenCalledOnce(); // sidecar only — no runner
        expect(module.setHealth).toHaveBeenCalledWith('error', expect.stringContaining('build'));
        // The error must be the FINAL health — onStart must not paper over it with 'ok'.
        expect(module.setHealth.mock.calls.at(-1)![0]).toBe('error');
    });

    it('reports an error when the sidecar script is missing (stale engine dist)', async () => {
        const { module, spawn } = makeModule();
        (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
        await module.onStart();
        expect(spawn).not.toHaveBeenCalled();
        expect(module.setHealth.mock.calls.at(-1)![0]).toBe('error');
    });

    it('probes the playlist and publishes detected languages as fieldOptions', async () => {
        const { module } = makeModule();
        module.config = { url: 'https://example.com/master.m3u8' };
        await module.onStart();

        expect(module.setFieldOptions).toHaveBeenCalledWith('audio', [
            { value: 'eng', label: 'English (eng)' },
            { value: 'zul', label: 'isiZulu (zul)' },
        ]);
        expect(module.setFieldOptions).toHaveBeenCalledWith('subtitles', [
            { value: 'eng', label: 'English (eng)' },
        ]);
    });

    it('reports empty language options for a media (non-master) playlist', async () => {
        (isMasterPlaylist as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
        const { module } = makeModule();
        module.config = { url: 'https://example.com/media.m3u8' };
        await module.onStart();
        expect(module.setFieldOptions).toHaveBeenCalledWith('audio', []);
        expect(module.setFieldOptions).toHaveBeenCalledWith('subtitles', []);
    });
});

describe('HlsPlayerModule.buildRunnerConfig', () => {
    it('maps cap bitrate kbps → bits/s and passes language selections through', () => {
        const { module } = makeModule();
        module.config = {
            url: 'u',
            quality: 'auto',
            capBitrate: 2500,
            abrPreset: 'unstable',
            audioLanguages: ['eng', 'zul'],
            subtitleLanguages: ['eng'],
            skipOnStall: true,
        };
        const cfg = module.buildRunnerConfig('u', 41000);
        expect(cfg).toMatchObject({
            sink: { kind: 'unixfd', ingestPath: '/tmp/mr-bus-41000-ingest.sock' },
            capBitrateBps: 2_500_000,
            abrPreset: 'unstable',
            inlineAudio: ['eng', 'zul'],
            inlineSubtitles: ['eng'],
            skipOnStall: true,
        });
    });

    it('treats 0 cap bitrate as no cap', () => {
        const { module } = makeModule();
        module.config = { capBitrate: 0 };
        expect(module.buildRunnerConfig('u', 1).capBitrateBps).toBe(0);
    });
});

describe('HlsPlayerModule.onLiveConfigUpdate', () => {
    it('pasting a URL live: probes for languages and launches the runner', async () => {
        const { module, spawn } = makeModule();
        await module.onStart(); // idle — no URL yet, sidecar up, no runner
        expect(spawn).toHaveBeenCalledOnce();

        await module.onLiveConfigUpdate({ url: 'https://example.com/master.m3u8' });
        expect(module.setFieldOptions).toHaveBeenCalledWith('audio', expect.any(Array)); // probed
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(runnerConfigAt(spawn, 1).url).toBe('https://example.com/master.m3u8');
    });

    it('relaunches with a new URL', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        expect(spawn).toHaveBeenCalledTimes(2); // sidecar + first runner

        await module.onLiveConfigUpdate({ url: 'https://example.com/b.m3u8' });
        expect(kill).toHaveBeenCalledOnce(); // old runner only — sidecar survives
        expect(spawn).toHaveBeenCalledTimes(3);
        expect(runnerConfigAt(spawn, 2).url).toBe('https://example.com/b.m3u8');
    });

    it('does not respawn when the pushed URL is unchanged (manager config re-sync)', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        expect(spawn).toHaveBeenCalledTimes(2);

        await module.onLiveConfigUpdate({ url: 'https://example.com/a.m3u8' });
        expect(kill).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('clearing the URL kills the runner and returns to idle', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();

        await module.onLiveConfigUpdate({ url: '' });
        expect(kill).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledTimes(2); // no respawn
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
        expect(module.setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('URL'));
    });

    it('serializes rapid URL changes — last update wins, runners never overlap', async () => {
        const { module, spawn, kill } = makeModule();
        await module.onStart(); // idle — sidecar only

        // First URL probes slowly; without the update lock the second update
        // would interleave and both could spawn a runner onto the same
        // ingest socket, corrupting the TS for every consumer.
        const p1 = module.onLiveConfigUpdate({ url: 'https://example.com/slow.m3u8' });
        const p2 = module.onLiveConfigUpdate({ url: 'https://example.com/b.m3u8' });
        await Promise.all([p1, p2]);

        expect(spawn).toHaveBeenCalledTimes(3); // sidecar + two runners
        expect(kill).toHaveBeenCalledOnce(); // first runner killed before the second spawned
        expect(runnerConfigAt(spawn, 2).url).toBe('https://example.com/b.m3u8');
    });

    it('a failed probe clears the previous stream’s language options', async () => {
        const { module } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        module.setFieldOptions.mockClear();

        await module.onLiveConfigUpdate({ url: 'https://example.com/fail.m3u8' });
        expect(module.setFieldOptions).toHaveBeenCalledWith('audio', []);
        expect(module.setFieldOptions).toHaveBeenCalledWith('subtitles', []);
    });
});

describe('HlsPlayerModule runner health', () => {
    it('crash-loop restart surfaces as warning with the bitrate badge cleared', async () => {
        const { module, spawn } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();

        const proc = spawn.mock.results[1]!.value as EventEmitter; // the hls runner
        proc.emit('restarting', 2, 6000);
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('restarting'),
        );
    });

    it('a stats line restores health to ok after a warning', () => {
        const { module } = makeModule();
        module.running = true;
        module.health = 'warning';
        module.parseStats(JSON.stringify({ stats: { bitrateMbps: 1.0, bytesSent: 1 } }));
        expect(module.setHealth).toHaveBeenCalledWith('ok');
    });

    it('a clean runner exit (VOD complete) requests a module self-stop', async () => {
        const { module, spawn } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        const selfStop = vi.fn();
        module.on('selfStop', selfStop);

        const proc = spawn.mock.results[1]!.value as EventEmitter;
        proc.emit('stopped', 0, null);
        expect(selfStop).toHaveBeenCalledWith(expect.stringContaining('ended'));
    });

    it('a killed or crashed runner does NOT request a self-stop', async () => {
        const { module, spawn } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        const selfStop = vi.fn();
        module.on('selfStop', selfStop);

        const proc = spawn.mock.results[1]!.value as EventEmitter & { destroyed: boolean };
        proc.emit('stopped', null, 'SIGKILL'); // killed (relaunch/OOM)
        proc.emit('stopped', 1, null); // crash — restart policy handles it
        proc.destroyed = true;
        proc.emit('stopped', 0, null); // deliberate module stop
        expect(selfStop).not.toHaveBeenCalled();
    });
});

describe('HlsPlayerModule fan-out sidecar', () => {
    it('coordinator attach commands reach the sidecar stdin and replay on ready', async () => {
        const { module, spawn } = makeModule();
        await module.onStart();
        const { proc, opts } = sidecarOf(spawn);

        module.getBusAttachTarget().sendBusAttach('busout_41000', '/tmp/mr-bus-41000-ab.sock');
        const attachLine = JSON.stringify({
            cmd: 'bus_attach',
            tee: 'busout_41000',
            socket: '/tmp/mr-bus-41000-ab.sock',
        });
        expect(proc.writeLine).toHaveBeenCalledWith(attachLine);

        // Sidecar (re)start: a fresh process has no listeners — the desired
        // edge set must be replayed on its ready event.
        proc.writeLine.mockClear();
        opts.onStdout('{"event":"ready"}');
        expect(proc.writeLine).toHaveBeenCalledWith(attachLine);
    });

    it('sidecar ready triggers a producer reattach and re-asserts the idle warning', async () => {
        const { module, spawn } = makeModule();
        await module.onStart(); // idle — no URL
        const { opts } = sidecarOf(spawn);
        module.setHealth.mockClear();

        opts.onStdout('{"event":"ready"}');
        expect(module.services.mediaRouter.onProducerPlaying).toHaveBeenCalledWith('hls-1');
        expect(module.setHealth).toHaveBeenLastCalledWith(
            'warning',
            expect.stringContaining('URL'),
        );
    });

    it('sidecar stats surface as bus status data (consumers + shed buffers)', async () => {
        const { module, spawn } = makeModule();
        await module.onStart();
        const { opts } = sidecarOf(spawn);
        opts.onStdout('{"stats": {"clients": 2, "drops": {"/tmp/a.sock": 3, "/tmp/b.sock": 4}}}');
        expect(module.setStatusData).toHaveBeenCalledWith('bus', {
            consumers: 2,
            'shed buffers': 7,
        });
    });

    it('onStop drops the fan-out refs so a restart spawns a fresh sidecar', async () => {
        const { module, spawn } = makeModule();
        await module.onStart();
        expect(module.getBusAttachTarget()).not.toBeNull();
        await module.onStop();
        expect(module.getBusAttachTarget()).toBeNull();
        await module.onStart();
        expect(spawn).toHaveBeenCalledTimes(2); // fresh sidecar on restart
    });
});

describe('HlsPlayerModule.parseStats', () => {
    it('updates the live stats section and bitrate badge', () => {
        const { module } = makeModule();
        module.parseStats(JSON.stringify({ stats: { bitrateMbps: 4.2, bytesSent: 1048576 } }));
        expect(module.setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({ bitrate: '4.20' }),
        );
        expect(module.setBadge).toHaveBeenCalledWith(
            'bitrate',
            expect.objectContaining({ text: '4.2 Mbps' }),
        );
    });

    it('ignores non-JSON log lines', () => {
        const { module } = makeModule();
        expect(() => module.parseStats('hls: switching to level 3')).not.toThrow();
        expect(module.setStatusData).not.toHaveBeenCalled();
    });
});
