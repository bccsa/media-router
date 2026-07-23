import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioTranscoderModule } from './AudioTranscoderModule.js';
import { INPUT_PORT_ID } from './audioTranscoderPorts.js';

interface SourceOpts {
    streamType?: string;
    channelMap?: Array<{ srcChannel: number; dstChannel: number; gain?: number }>;
}

/** Harness with an optional single source wired to the input port. */
function makeModule(source?: SourceOpts, opts: { busPort?: number | null } = {}) {
    const module = new AudioTranscoderModule() as any;
    let nextPort = 41000;
    const busSources = source
        ? [
              {
                  port: 40100,
                  socketPath: '/tmp/mr-bus-40100-x.sock',
                  connectionId: 'c-0',
                  sourceModuleId: 'src-0',
                  sourcePortId: 'out-0',
                  sinkPortId: INPUT_PORT_ID,
                  streamType: source.streamType ?? 'muxed/mpegts',
                  channelMap: source.channelMap,
              },
          ]
        : [];
    module.services = {
        instanceId: 'atx-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => busSources),
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
    it('exposes one single-source input + per-rendition outputs from config', () => {
        const { module } = makeModule();
        module.config = {
            renditions: [{ codec: 'opus' }, { codec: 'pcm' }],
        };
        const ports = module.getDynamicPorts();
        const inputs = ports.filter((p: any) => p.direction === 'input');
        expect(inputs).toHaveLength(1);
        expect(inputs[0].maxConnections).toBe(1);
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
        const { module, setHealth } = makeModule({});
        expect(module.buildPipeline({ renditions: [] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No renditions'),
        );
    });

    it('decode-once front-end, probed codec picks the chain (no mixer element)', () => {
        const { module } = makeModule({});
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('tsdemux latency=0');
        expect(desc!.pipeline).toContain('aacparse ! avdec_aac');
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.restartOnError).toBe(true);
    });

    it('a 302M-declared source decodes the same way (probe → avdec_s302m)', () => {
        const { module } = makeModule({ streamType: 'audio/302m' });
        module.probeResult = { codec: 's302m' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.pipeline).toContain('avdec_s302m');
        expect(desc!.pipeline).not.toContain('audiomixer');
    });

    it('a connection channel map is inlined as a trunk mix-matrix', () => {
        const { module } = makeModule({
            streamType: 'audio/302m',
            channelMap: [
                { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                { srcChannel: 1, dstChannel: 0, gain: 0.5 },
            ],
        });
        module.probeResult = { codec: 's302m' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.pipeline).toContain(
            'mix-matrix="<<(float)0.5000, (float)0.5000>, <(float)0.0000, (float)0.0000>>"',
        );
        // Matrix rows must match the negotiated channel count → pinned caps.
        expect(desc!.pipeline).toContain('audio/x-raw,channels=2');
    });

    it('matrix input dimension comes from the probe, not a stereo pin (5.1 source)', () => {
        const { module } = makeModule({
            channelMap: [
                { srcChannel: 0, dstChannel: 0 },
                { srcChannel: 2, dstChannel: 1 },
            ],
        });
        module.probeResult = { codec: 'ac3', channels: 6 };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        // 2 rows (output stereo) × 6 columns (probed source channels).
        expect(desc!.pipeline).toContain(
            'mix-matrix="<<(float)1.0000, (float)0.0000, (float)0.0000, (float)0.0000, (float)0.0000, (float)0.0000>, <(float)0.0000, (float)0.0000, (float)1.0000, (float)0.0000, (float)0.0000, (float)0.0000>>"',
        );
    });

    it('unknown probe codec builds decodebin but surfaces a health WARNING, not ok', () => {
        const { module, setHealth } = makeModule({});
        module.probeResult = { codec: 'unknown' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('decodebin');
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('codec unknown'));
        expect(setHealth).not.toHaveBeenCalledWith('ok');
    });

    it('health error when a pcm rendition is configured on a runtime without 302M TS support', () => {
        AudioTranscoderModule.setS302mSupported(false);
        const { module, setHealth } = makeModule({});
        expect(module.buildPipeline({ renditions: [{ codec: 'pcm' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1.26'));
    });

    it('allocates a distinct bus channel per rendition', () => {
        const { module } = makeModule({});
        const desc = module.buildPipeline({
            renditions: [{ codec: 'opus' }, { codec: 'aac' }],
        });
        expect(desc).not.toBeNull();
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-0');
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-1');
    });

    it('health error when the bus channel pool is exhausted', () => {
        const { module, setHealth } = makeModule({}, { busPort: null });
        expect(module.buildPipeline({ renditions: [{ codec: 'opus' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('exhausted'));
    });

    it('never contains PipeWire capture/re-stamp elements', () => {
        const { module } = makeModule({});
        const desc = module.buildPipeline({ renditions: [{ codec: 'pcm' }] });
        expect(desc!.pipeline).not.toContain('pulsesrc');
        expect(desc!.pipeline).not.toContain('pulsesink');
        expect(desc!.pipeline).not.toContain('do-timestamp');
    });
});
