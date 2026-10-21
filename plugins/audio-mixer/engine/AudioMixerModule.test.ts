import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaRouter } from '@media-router/engine';
import { AudioMixerModule } from './AudioMixerModule.js';

function makeModule(sourceCount = 0, opts: { busPort?: number | null } = {}) {
    const module = new AudioMixerModule() as any;
    const sources = Array.from({ length: sourceCount }, (_, i) => ({
        port: 40100 + i,
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
    }));
    module.services = {
        instanceId: 'amx-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => sources),
            assignBusChannel: vi.fn(() => (opts.busPort === null ? null : { port: 41000 })),
        },
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

beforeEach(() => {
    vi.clearAllMocks();
    AudioMixerModule.setS302mSupported(true);
});

describe('AudioMixerModule.buildPipeline', () => {
    it('returns null + warning when no sources are wired', () => {
        const { module, setHealth } = makeModule(0);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No sources'));
    });

    it('sums all wired sources into one 302M output on the allocated bus channel', () => {
        const { module } = makeModule(3);
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('audiomixer name=mixin');
        expect(desc!.pipeline.match(/! mixin\./g)).toHaveLength(3);
        expect(desc!.pipeline).toContain('avenc_s302m');
        expect(desc!.pipeline).toContain('tee name=busout_41000');
        expect(desc!.restartOnError).toBe(true);
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith(
            'amx-1',
            'audio-out',
        );
    });

    it('mute (audioEnabled=false) builds with volume 0', () => {
        const { module } = makeModule(1);
        const desc = module.buildPipeline({ audioEnabled: false, volume: 100 });
        expect(desc!.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('health error on a runtime without 302M TS support', () => {
        AudioMixerModule.setS302mSupported(false);
        const { module, setHealth } = makeModule(2);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1.26'));
    });

    it('health error when the bus channel pool is exhausted', () => {
        const { module, setHealth } = makeModule(1, { busPort: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('exhausted'));
    });

    it('opts out of the EOS drain — an audio-only producer whose aligners hold EOS (#787)', () => {
        const { module } = makeModule(2);
        expect(module.buildPipeline({})!.eosDrain).toBe(false);
    });

    it('has no mix budget setting: the aligned mixer waits for data or a gap (WI-P2-9)', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        expect(Object.keys(manifest.mediaRouter.configSchema.properties)).toEqual([
            'volume',
            'audioEnabled',
            'channels',
            'pcmBitDepth',
        ]);
        const { module } = makeModule(2);
        const p = module.buildPipeline({})!.pipeline;
        expect(p).toContain('audiomixer name=mixin latency=0 start-time-selection=first');
        expect(p).not.toContain('force-live');
    });
});

describe('AudioMixerModule.getLiveInputBranch (#787)', () => {
    it('a wired Audio In edge gets its branch: mixer element, stable bin name, branch text', () => {
        const { module } = makeModule(2);
        module.config = { channels: 2 };
        const b = module.getLiveInputBranch('audio-in', 'c-1');
        expect(b).toMatchObject({ element: 'mixin' });
        expect(b.name).toMatch(/^mixin_in_[0-9a-f]{6}$/);
        expect(b.description).toContain('unixfdsrc socket-path=/tmp/mr-bus-40101-x.sock');
        // The same name the start-time pipeline gives that source's bin.
        expect(module.buildPipeline({})!.pipeline).toContain(`( name=${b.name} `);
    });

    it('an edge that is already gone (remove) still names its branch, without a description', () => {
        const { module } = makeModule(1);
        const b = module.getLiveInputBranch('audio-in', 'c-gone');
        expect(b).toEqual({ element: 'mixin', name: expect.stringMatching(/^mixin_in_/) });
    });

    it('other ports are not live-input ports', () => {
        const { module } = makeModule(1);
        expect(module.getLiveInputBranch('audio-out', 'c-0')).toBeNull();
    });
});

describe('AudioMixerModule: the start pace from the producers (WI-P2-13)', () => {
    it("a running producer's output lateness reaches its watchdog as seed-lateness", async () => {
        const router = new MediaRouter();
        const out = { id: 'audio-out', direction: 'output', streamType: 'audio/302m', label: 'A' };
        router.registerPorts('enc-a', [out as never]);
        router.registerPorts('enc-b', [out as never]);
        router.registerPorts('amx-1', [
            {
                id: 'audio-in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
                maxConnections: -1,
            },
            { id: 'audio-out', direction: 'output', streamType: 'audio/302m', label: 'Out' },
        ]);
        const summary = {
            instrument: true,
            inputs: [],
            output: { meanMs: 48.25, minMs: 40, maxMs: 55 },
        };
        router.setDependencies(
            {} as never,
            ((id: string) =>
                id === 'amx-1'
                    ? { config: {}, running: false, stop: vi.fn(), start: vi.fn() }
                    : // enc-b runs but has shown no lateness yet: no seed.
                      {
                          config: {},
                          running: true,
                          getTimingSummary: () => (id === 'enc-a' ? summary : undefined),
                      }) as never,
        );
        router.assignBusChannel('enc-a');
        router.assignBusChannel('enc-b');
        await router.createConnection('enc-a', 'audio-out', 'amx-1', 'audio-in');
        await router.createConnection('enc-b', 'audio-out', 'amx-1', 'audio-in');

        const module = new AudioMixerModule() as any;
        module.services = { instanceId: 'amx-1', mediaRouter: router };
        module.setHealth = vi.fn();
        module.setStatusData = vi.fn();
        const pipeline: string = module.buildPipeline({}).pipeline;
        expect(pipeline.match(/seed-lateness=\d+/g)).toEqual(['seed-lateness=48250000']);
        const seeded = router
            .getModuleBusSources('amx-1')
            .find((s) => s.sourceModuleId === 'enc-a')!;
        // On the branch of that edge, the one a live re-add sends too.
        const branch = module.getLiveInputBranch('audio-in', seeded.connectionId);
        expect(branch.description).toMatch(/ seed-lateness=48250000$/);
        expect(pipeline).toContain(branch.description);
    });
});
