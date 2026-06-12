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

// The module resolves the compiled runner with existsSync — pretend it's built.
vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: vi.fn(() => true),
}));

import { HlsPlayerModule } from './HlsPlayerModule.js';

function makeModule() {
    // Real emitter so tests can fire ManagedProcess lifecycle events.
    const spawn = vi.fn(() => Object.assign(new EventEmitter(), { destroyed: false }));
    const kill = vi.fn(async () => {});
    const module = new HlsPlayerModule() as any;
    module.services = {
        instanceId: 'hls-1',
        mediaRouter: {
            assignUdpPort: vi.fn(),
            getUdpEndpoint: vi.fn(() => ({ host: '239.255.0.1', port: 41000 })),
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

/** Parse the HLS_CONFIG JSON handed to the spawned runner. */
function runnerConfig(spawn: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return runnerConfigAt(spawn, 0);
}

/** HLS_CONFIG from the Nth spawn call. */
function runnerConfigAt(spawn: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
    return JSON.parse(spawn.mock.calls[n][1].env.HLS_CONFIG);
}

beforeEach(() => vi.clearAllMocks());

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
    it('with no URL: reserves the port and sits idle (warning), never spawns', async () => {
        const { module, spawn } = makeModule();
        await module.onStart();
        expect(module.services.mediaRouter.assignUdpPort).toHaveBeenCalledWith('hls-1');
        expect(module.setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('URL'));
        expect(spawn).not.toHaveBeenCalled();
        expect(module.running).toBe(true); // running-but-idle, ready for a pasted URL
    });

    it('assigns a UDP port, spawns the runner with the source URL + endpoint', async () => {
        const { module, spawn } = makeModule();
        module.config = { url: 'https://example.com/master.m3u8', quality: 'auto' };
        await module.onStart();

        expect(module.services.mediaRouter.assignUdpPort).toHaveBeenCalledWith('hls-1');
        expect(spawn).toHaveBeenCalledOnce();
        const cfg = runnerConfig(spawn);
        expect(cfg).toMatchObject({
            url: 'https://example.com/master.m3u8',
            host: '239.255.0.1',
            port: 41000,
            quality: 'auto',
            inlineAudio: [],
            inlineSubtitles: [],
        });
        expect(module.running).toBe(true);
        expect(module.setHealth).toHaveBeenCalledWith('ok');
    });

    it('reports an error when the runner is not built (dev tsx fallback without dist)', async () => {
        const { module, spawn } = makeModule();
        (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
        module.config = { url: 'https://example.com/master.m3u8' };
        await module.onStart();
        expect(spawn).not.toHaveBeenCalled();
        expect(module.setHealth).toHaveBeenCalledWith('error', expect.stringContaining('build'));
        // The error must be the FINAL health — onStart must not paper over it with 'ok'.
        expect(module.setHealth.mock.calls.at(-1)![0]).toBe('error');
        (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
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
        const cfg = module.buildRunnerConfig('u', '239.255.0.1', 41000);
        expect(cfg).toMatchObject({
            host: '239.255.0.1',
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
        expect(module.buildRunnerConfig('u', 'h', 1).capBitrateBps).toBe(0);
    });
});

describe('HlsPlayerModule.onLiveConfigUpdate', () => {
    it('pasting a URL live: probes for languages and launches the runner', async () => {
        const { module, spawn } = makeModule();
        await module.onStart(); // idle — no URL yet, port reserved, no spawn
        expect(spawn).not.toHaveBeenCalled();

        await module.onLiveConfigUpdate({ url: 'https://example.com/master.m3u8' });
        expect(module.setFieldOptions).toHaveBeenCalledWith('audio', expect.any(Array)); // probed
        expect(spawn).toHaveBeenCalledOnce();
        expect(runnerConfig(spawn).url).toBe('https://example.com/master.m3u8');
    });

    it('relaunches with a new URL', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        expect(spawn).toHaveBeenCalledOnce();

        await module.onLiveConfigUpdate({ url: 'https://example.com/b.m3u8' });
        expect(kill).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(runnerConfigAt(spawn, 1).url).toBe('https://example.com/b.m3u8');
    });

    it('does not respawn when the pushed URL is unchanged (manager config re-sync)', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();
        expect(spawn).toHaveBeenCalledOnce();

        await module.onLiveConfigUpdate({ url: 'https://example.com/a.m3u8' });
        expect(kill).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledOnce();
    });

    it('clearing the URL kills the runner and returns to idle', async () => {
        const { module, spawn, kill } = makeModule();
        module.config = { url: 'https://example.com/a.m3u8' };
        await module.onStart();

        await module.onLiveConfigUpdate({ url: '' });
        expect(kill).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledOnce(); // no respawn
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
        expect(module.setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('URL'));
    });

    it('serializes rapid URL changes — last update wins, runners never overlap', async () => {
        const { module, spawn, kill } = makeModule();
        await module.onStart(); // idle

        // First URL probes slowly; without the update lock the second update
        // would interleave and both could spawn onto the same multicast port.
        const p1 = module.onLiveConfigUpdate({ url: 'https://example.com/slow.m3u8' });
        const p2 = module.onLiveConfigUpdate({ url: 'https://example.com/b.m3u8' });
        await Promise.all([p1, p2]);

        expect(spawn).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenCalledOnce(); // first runner killed before the second spawned
        expect(runnerConfigAt(spawn, 1).url).toBe('https://example.com/b.m3u8');
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

        const proc = spawn.mock.results[0]!.value as EventEmitter;
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
