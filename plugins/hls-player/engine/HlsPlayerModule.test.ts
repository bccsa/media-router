import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isMasterPlaylist } from 'hls-pipe';

// hls-pipe is ESM and the probe loads it via dynamic import — mock it so tests
// neither hit the network nor depend on the built library.
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
            fetch: vi.fn(async () => ({ body: Buffer.from('#EXTM3U') })),
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

import { HlsPlayerModule } from './HlsPlayerModule.js';

function makeModule() {
    const spawn = vi.fn(() => ({ on: vi.fn() }));
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
    module.setHealth = vi.fn();
    module.setFieldOptions = vi.fn();
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    return { module, spawn, kill };
}

/** Parse the HLS_CONFIG JSON handed to the spawned runner. */
function runnerConfig(spawn: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse(spawn.mock.calls[0][1].env.HLS_CONFIG);
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

/** HLS_CONFIG from the Nth spawn call. */
function runnerConfigAt(spawn: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
    return JSON.parse(spawn.mock.calls[n][1].env.HLS_CONFIG);
}
