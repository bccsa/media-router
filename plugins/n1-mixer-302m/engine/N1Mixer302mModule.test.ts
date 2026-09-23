import { describe, it, expect, vi, beforeEach } from 'vitest';
import { N1Mixer302mModule } from './N1Mixer302mModule.js';

interface FakeSource {
    port: number;
    connectionId: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkPortId: string;
    streamType: string;
    socketPath: string;
}

function mkSource(sinkPortId: string, n = 0): FakeSource {
    return {
        port: 40100 + n,
        connectionId: `c-${sinkPortId}-${n}`,
        sourceModuleId: `src-${n}`,
        sourcePortId: 'out-0',
        sinkPortId,
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-bus-${40100 + n}-x.sock`,
    };
}

function makeModule(sources: FakeSource[] = []) {
    const module = new N1Mixer302mModule() as any;
    let nextPort = 40200;
    const assignBusChannel = vi.fn(() => ({ port: nextPort++ }));
    module.services = {
        instanceId: 'n1m-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => sources),
            assignBusChannel,
        },
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth, assignBusChannel };
}

beforeEach(() => {
    vi.clearAllMocks();
    N1Mixer302mModule.setS302mSupported(true);
});

describe('N1Mixer302mModule.getDynamicPorts', () => {
    it('resolves from the PASSED config (pre-start, this.config still empty)', () => {
        const { module } = makeModule();
        expect(module.getDynamicPorts({ pairCount: 3 })).toHaveLength(6);
        expect(module.getDynamicPorts({})).toHaveLength(8); // default 4 pairs
    });
});

describe('N1Mixer302mModule.getBusStreamChannels', () => {
    it('declares the 302M wire width of every output, never of an input', () => {
        const { module } = makeModule();
        expect(module.getBusStreamChannels('out-0')).toBe(2);
        expect(module.getBusStreamChannels('in-0')).toBeUndefined();
        module.config = { channels: 8 };
        expect(module.getBusStreamChannels('out-3')).toBe(8);
        // A mono mix leaves as dual-mono stereo — the wire is never 1 wide.
        module.config = { channels: 1 };
        expect(module.getBusStreamChannels('out-0')).toBe(2);
    });
});

describe('N1Mixer302mModule.buildPipeline', () => {
    it('errors on runtimes without 302M support', () => {
        N1Mixer302mModule.setS302mSupported(false);
        const { module, setHealth } = makeModule([mkSource('in-0')]);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('GStreamer'));
    });

    it('returns null + warning with no 302M sources', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No 302M'));
    });

    it('ignores stale out-of-range and foreign sink ports', () => {
        const { module, setHealth } = makeModule([mkSource('in-9'), mkSource('audio-in', 1)]);
        expect(module.buildPipeline({ pairCount: 4 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No 302M'));
    });

    it('allocates bus ports only for outputs with a contributing input', () => {
        const { module, assignBusChannel } = makeModule([mkSource('in-0')]);
        const desc = module.buildPipeline({ pairCount: 2 });
        expect(desc).not.toBeNull();
        expect(assignBusChannel).toHaveBeenCalledTimes(1);
        expect(assignBusChannel).toHaveBeenCalledWith('n1m-1', 'out-1');
        expect(desc!.pipeline).not.toContain('omix0');
        expect(desc!.pipeline).toContain('in0t. ! queue');
        expect(desc!.pipeline).toContain('! omix1.');
    });

    it('errors when the UDP port pool is exhausted', () => {
        const { module, setHealth } = makeModule([mkSource('in-0'), mkSource('in-1', 1)]);
        module.services.mediaRouter.assignBusChannel = vi.fn(() => null);
        expect(module.buildPipeline({ pairCount: 2 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('port pool'));
    });

    it('builds the mix-minus pipeline and reports routing status', () => {
        const { module, setHealth } = makeModule([mkSource('in-0'), mkSource('in-1', 1)]);
        const desc = module.buildPipeline({ pairCount: 2 });
        expect(desc).not.toBeNull();
        // One source per input pin → direct branches, no input aggregators.
        expect(desc!.pipeline).not.toContain('audiomixer name=inmix');
        expect(desc!.pipeline).toContain('capsfilter name=inmix0_out');
        expect(desc!.pipeline).toContain('capsfilter name=inmix1_out');
        expect(desc!.pipeline).toContain('audiomixer name=omix0 force-live=true');
        expect(desc!.pipeline).toContain('audiomixer name=omix1 force-live=true');
        expect(desc!.pipeline).toContain('avenc_s302m strict=experimental');
        expect(desc!.pipeline).toContain('tee name=busout_40200 allow-not-linked=true');
        expect(desc!.pipeline).toContain('tee name=busout_40201 allow-not-linked=true');
        expect(desc!.restartOnError).toBe(true);
        expect(module.setStatusData).toHaveBeenCalledWith('routing', {
            pairCount: 2,
            channels: 2,
            connectedInputs: 2,
            activeOutputs: 2,
        });
        expect(setHealth).toHaveBeenCalledWith('ok');
    });

    it('builds the whole matrix at the configured channel width', () => {
        const { module } = makeModule([mkSource('in-0'), mkSource('in-1', 1)]);
        const desc = module.buildPipeline({ pairCount: 2, channels: 6 });
        expect(desc!.pipeline).toContain(
            'capsfilter name=inmix0_out caps="audio/x-raw,rate=48000,channels=6"',
        );
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,rate=48000,channels=6 ! identity name=omix0_pace',
        );
        expect(desc!.pipeline).toContain('audio/x-raw,channels=6,channel-mask=(bitmask)0x3f');
        expect(desc!.pipeline).toContain('rate=48000,channels=6 ! avenc_s302m');
        expect(module.setStatusData).toHaveBeenCalledWith(
            'routing',
            expect.objectContaining({ channels: 6 }),
        );
    });
});
