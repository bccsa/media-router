import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    it('opts out of the EOS drain — an audio-only producer whose force-live mix never drains (#787)', () => {
        const { module } = makeModule(2);
        expect(module.buildPipeline({})!.eosDrain).toBe(false);
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
