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

describe('AudioMixerModule — time-sync contract (transform producer)', () => {
    it('declares the per-AU retime on every input demux and the identity egress', () => {
        const { module } = makeModule(2);
        module.services.timeSyncContract = true;
        const desc = module.buildPipeline({})!;
        expect(desc.houseTimelineEgress).toBe(true);
        expect(desc.alignBranchesToStamps).toEqual({
            demuxes: [expect.stringMatching(/^mixin_demux_/), expect.stringMatching(/^mixin_demux_/)],
            transformProducer: true,
        });
        for (const d of desc.alignBranchesToStamps!.demuxes)
            expect(desc.pipeline).toContain(`tsdemux name=${d} latency=0 !`);
        expect(desc.pipeline).not.toContain('ignore-pcr');
    });

    it('a live add under the contract hands the engine the retimed branch text', () => {
        const { module } = makeModule(2);
        module.services.timeSyncContract = true;
        module.config = { channels: 2 };
        const b = module.getLiveInputBranch('audio-in', 'c-1');
        expect(b.description).not.toContain('ignore-pcr');
        expect(module.buildPipeline({})!.pipeline).toContain(`( name=${b.name} ${b.description} )`);
    });

    it('off-contract the string is the legacy one (the engine drops both fields there)', () => {
        const { module } = makeModule(2);
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('ignore-pcr=true');
        expect(desc.pipeline).not.toContain('ts-offset');
    });
});

describe('AudioMixerModule — lateness budget follows the route D (contract)', () => {
    function contractModule(routeD: number | undefined) {
        const made = makeModule(2);
        made.module.services.timeSyncContract = true;
        made.module.services.mediaRouter.getRoutePlayoutOffsetMs = vi.fn(() => routeD);
        made.module.services.mediaRouter.getRoutePlayoutRaiseMs = vi.fn(() => 0);
        return made;
    }

    it('waits at least D for a late input: latency = max(mixLatencyMs, D)', () => {
        const { module } = contractModule(700);
        expect(module.buildPipeline({ mixLatencyMs: 20 })!.pipeline).toContain('latency=700000000');
        expect(module.buildPipeline({ mixLatencyMs: 900 })!.pipeline).toContain('latency=900000000');
    });

    it('off-contract the configured budget alone', () => {
        const { module } = makeModule(2);
        module.services.mediaRouter.getRoutePlayoutOffsetMs = vi.fn(() => 700);
        expect(module.buildPipeline({ mixLatencyMs: 20 })!.pipeline).toContain('latency=20000000');
    });

    it('a D change is pushed into the running aggregator, not a rebuild', async () => {
        const { module } = contractModule(700);
        module.config = { mixLatencyMs: 20 };
        module.running = true;
        module.setElementProperty = vi.fn(async () => {});
        await module.onRoutePlayoutOffsetChanged();
        expect(module.setElementProperty).toHaveBeenCalledWith('mixin', 'latency', 700_000_000);
    });
});
