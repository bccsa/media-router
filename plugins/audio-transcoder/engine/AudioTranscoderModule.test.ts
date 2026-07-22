import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioTranscoderModule } from './AudioTranscoderModule.js';

interface HarnessOpts {
    mpegtsUpstream?: boolean;
    mixSources?: number;
    busPort?: number | null;
}

function makeModule(opts: HarnessOpts = {}) {
    const module = new AudioTranscoderModule() as any;
    let nextPort = 41000;
    const mixSources = Array.from({ length: opts.mixSources ?? 0 }, (_, i) => ({
        port: 40100 + i,
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
        connectionId: `c-mix-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
    }));
    module.services = {
        instanceId: 'atx-1',
        mediaRouter: {
            getModuleBusSource: vi.fn((_id: string, portId?: string) =>
                opts.mpegtsUpstream && (portId === undefined || portId === 'mpegts-in')
                    ? {
                          port: 40001,
                          socketPath: '/tmp/mr-bus-40001-x.sock',
                          connectionId: 'c-up',
                          sourceModuleId: 'src-ts',
                          sourcePortId: 'mpegts-out',
                          streamType: 'muxed/mpegts',
                      }
                    : undefined,
            ),
            getModuleBusSources: vi.fn(() => mixSources),
            assignBusChannel: vi.fn(() =>
                opts.busPort === null ? null : { port: nextPort++ },
            ),
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
    AudioTranscoderModule.setS302mSupported(true);
});

describe('AudioTranscoderModule.getDynamicPorts', () => {
    it('exposes both inputs + per-rendition outputs from config', () => {
        const { module } = makeModule();
        module.config = {
            renditions: [{ codec: 'opus' }, { codec: 'pcm' }],
        };
        const ports = module.getDynamicPorts();
        expect(ports.filter((p: any) => p.direction === 'input')).toHaveLength(2);
        expect(ports.filter((p: any) => p.direction === 'output')).toHaveLength(2);
    });
});

describe('AudioTranscoderModule.buildPipeline', () => {
    it('returns null + warning when nothing is wired', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No input'));
    });

    it('returns null + warning on zero renditions', () => {
        const { module, setHealth } = makeModule({ mpegtsUpstream: true });
        expect(module.buildPipeline({ renditions: [] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No renditions'),
        );
    });

    it('mpegts front-end when upstream TS is wired', () => {
        const { module } = makeModule({ mpegtsUpstream: true });
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('tsdemux latency=0');
        expect(desc!.pipeline).toContain('aacparse ! avdec_aac');
        expect(desc!.restartOnError).toBe(true);
    });

    it('falls back to the 302M mix front-end when only audio-in is wired', () => {
        const { module } = makeModule({ mixSources: 2 });
        const desc = module.buildPipeline({ renditions: [{ codec: 'aac' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('audiomixer name=mixin');
        expect(desc!.pipeline.match(/! mixin\./g)).toHaveLength(2);
    });

    it('passes a mix source connection channelMap through as a mix-matrix', () => {
        const { module } = makeModule({ mixSources: 1 });
        module.services.mediaRouter.getModuleBusSources = vi.fn(() => [
            {
                port: 40100,
                socketPath: '/tmp/mr-bus-40100-x.sock',
                connectionId: 'c-mix-0',
                sourceModuleId: 'src-0',
                sourcePortId: 'out-0',
                sinkPortId: 'audio-in',
                streamType: 'audio/302m',
                channelMap: [
                    { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                    { srcChannel: 1, dstChannel: 0, gain: 0.5 },
                ],
            },
        ]);
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        // Mix output is stereo (module channels=2): the stereo→mono-style map
        // lands in row 0, row 1 stays silent.
        expect(desc!.pipeline).toContain(
            'mix-matrix="<<(float)0.5000, (float)0.5000>, <(float)0.0000, (float)0.0000>>"',
        );
    });

    it('mpegts-in wins when both inputs are wired, with a warning', () => {
        const { module, setHealth } = makeModule({ mpegtsUpstream: true, mixSources: 1 });
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.pipeline).toContain('tsdemux');
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('Audio In (302M) is ignored'),
        );
    });

    it('health error when a pcm rendition is configured on a runtime without 302M TS support', () => {
        AudioTranscoderModule.setS302mSupported(false);
        const { module, setHealth } = makeModule({ mpegtsUpstream: true });
        expect(module.buildPipeline({ renditions: [{ codec: 'pcm' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1.26'));
    });

    it('allocates a distinct bus channel per rendition', () => {
        const { module } = makeModule({ mpegtsUpstream: true });
        const desc = module.buildPipeline({
            renditions: [{ codec: 'opus' }, { codec: 'aac' }],
        });
        expect(desc).not.toBeNull();
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-0');
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-1');
    });

    it('health error when the bus channel pool is exhausted', () => {
        const { module, setHealth } = makeModule({ mpegtsUpstream: true, busPort: null });
        expect(module.buildPipeline({ renditions: [{ codec: 'opus' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('exhausted'));
    });

    it('never contains PipeWire capture/re-stamp elements', () => {
        const { module } = makeModule({ mpegtsUpstream: true });
        const desc = module.buildPipeline({ renditions: [{ codec: 'pcm' }] });
        expect(desc!.pipeline).not.toContain('pulsesrc');
        expect(desc!.pipeline).not.toContain('pulsesink');
        expect(desc!.pipeline).not.toContain('do-timestamp');
    });
});
