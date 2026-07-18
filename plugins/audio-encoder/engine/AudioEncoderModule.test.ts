import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bitrateBadge } from '@media-router/engine';
import { AudioEncoderModule } from './AudioEncoderModule.js';

function makeModule(opts: { udpPort?: number | null } = {}) {
    const module = new AudioEncoderModule() as any;
    const udpPort = opts.udpPort === undefined ? 41000 : opts.udpPort;
    const assignUdpPort = vi.fn(() =>
        udpPort === null ? null : { host: '239.255.0.1', port: udpPort },
    );
    const getUdpEndpoint = vi.fn(() =>
        udpPort === null ? undefined : { host: '239.255.0.1', port: udpPort },
    );
    module.services = {
        instanceId: 'enc-1',
        mediaRouter: { assignUdpPort, getUdpEndpoint },
    };
    module.config = {};
    Object.defineProperty(module, 'pwNodeName', {
        value: 'MR_PW_enc-1',
        configurable: true,
    });
    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    return { module, assignUdpPort, getUdpEndpoint, setStatusData, setBadge };
}

describe('AudioEncoderModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('builds an opus path by default with the encoder bitrate and ts mux', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc.pipeline).toContain('pulsesrc device=MR_PW_enc-1.monitor');
        expect(desc.pipeline).toContain('opusenc bitrate=128000');
        expect(desc.pipeline).toContain('mpegtsmux latency=0 alignment=7');
        expect(desc.pipeline).toContain('udpsink');
        expect(desc.pipeline).toContain('port=41000');
    });

    it('pins the pulsesrc ring to srcBufferMs (default 200 ms = the previous implicit gst default, clamped to 40 ms floor)', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({}).pipeline).toContain(
            'pulsesrc device=MR_PW_enc-1.monitor buffer-time=200000',
        );
        expect(module.buildPipeline({ srcBufferMs: 60 }).pipeline).toContain(
            'buffer-time=60000',
        );
        expect(module.buildPipeline({ srcBufferMs: 5 }).pipeline).toContain(
            'buffer-time=40000',
        );
        expect(module.buildPipeline({ srcBufferMs: 5000 }).pipeline).toContain(
            'buffer-time=1000000',
        );
    });

    it('builds an AAC path when codec=aac', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'aac', bitrate: 192 });
        expect(desc.pipeline).toContain('avenc_aac bitrate=192000');
        expect(desc.pipeline).not.toContain('opusenc');
    });

    it('disables AAC joint stereo with integer 0, not "false" (issue #676)', () => {
        // avenc_aac's aac-ms is a tri-state enum (auto/off/on) on newer
        // gst-libav; the literal "false" fails to deserialize. `0` = off works
        // on both the enum and boolean builds.
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'aac' });
        expect(desc.pipeline).toContain('aac-is=0 aac-ms=0');
        expect(desc.pipeline).not.toContain('aac-ms=false');
        expect(desc.pipeline).not.toContain('aac-is=false');
    });

    it('falls back to fakesink when no UDP port can be assigned', () => {
        const { module } = makeModule({ udpPort: null });
        const desc = module.buildPipeline({});
        expect(desc.pipeline).toContain('fakesink name=usink');
        expect(desc.pipeline).not.toContain('udpsink');
    });

    it('threads tsAlignment through to mpegtsmux', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', tsAlignment: 1 });
        expect(desc.pipeline).toContain('alignment=1');
    });

    it('respects audioEnabled=false by forcing gst volume to 0', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', volume: 75, audioEnabled: false });
        expect(desc.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('passes inband-fec and packet-loss-percentage through to opusenc', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            codec: 'opus',
            inbandFec: true,
            packetLoss: 5,
        });
        expect(desc.pipeline).toContain('inband-fec=true');
        expect(desc.pipeline).toContain('packet-loss-percentage=5');
    });

    it('picks Opus audio-type=2051 (restricted-lowdelay) for short frames when audioType is 0/auto', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', frameSize: 2.5, audioType: 0 });
        expect(desc.pipeline).toContain('audio-type=2051');
    });

    it('picks Opus audio-type=2048 (generic) for longer frames when audioType is 0/auto', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', frameSize: 20, audioType: 0 });
        expect(desc.pipeline).toContain('audio-type=2048');
    });

    it('respects an explicit non-zero audioType verbatim', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', audioType: 2049 });
        expect(desc.pipeline).toContain('audio-type=2049');
    });

});

describe('AudioEncoderModule.updateStatusData', () => {
    beforeEach(() => vi.clearAllMocks());

    it('populates the encoder section from current config', () => {
        const { module, setStatusData } = makeModule();
        module.config = { codec: 'aac', bitrate: 192, frameSize: 10, sampleRate: 44100, channels: 2 };
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'aac', bitrate: 192, frameSize: 10, sampleRate: 44100, channels: 2 }),
        );
    });

    it('populates the udp section with the assigned endpoint when available', () => {
        const { module, setStatusData } = makeModule();
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith(
            'udp',
            expect.objectContaining({ host: '239.255.0.1', port: 41000 }),
        );
    });

    it('renders placeholders in the udp section when no port is assigned', () => {
        const { module, setStatusData } = makeModule({ udpPort: null });
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith('udp', { host: '—', port: 0 });
    });
});

describe('AudioEncoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink as the sink so audio sources loop back into it', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ sink: 'MR_PW_enc-1' });
    });
});

describe('bitrateBadge', () => {
    it('shows kbps below 1 Mbps (audio scale), green when flowing', () => {
        expect(bitrateBadge(128)).toEqual({ icon: 'activity', text: '128 kbps', color: '#10b981' });
    });

    it('switches to Mbps at/above 1000 kbps (video scale)', () => {
        expect(bitrateBadge(4200)).toEqual({
            icon: 'activity',
            text: '4.2 Mbps',
            color: '#10b981',
        });
    });

    it('goes grey at zero throughput', () => {
        expect(bitrateBadge(0)).toEqual({ icon: 'activity', text: '0 kbps', color: '#6b7280' });
    });
});

describe('AudioEncoderModule.publishThroughput', () => {
    beforeEach(() => vi.clearAllMocks());

    it('puts the live rate in the popup and a bitrate badge on the face', () => {
        const { module, setStatusData, setBadge } = makeModule();
        (module as any).publishThroughput({ bitrateKbps: 132, totalBytes: 2 * 1024 * 1024 });
        expect(setStatusData).toHaveBeenCalledWith(
            'throughput',
            expect.objectContaining({ 'Output Bitrate': '132 kbps' }),
        );
        expect(setBadge).toHaveBeenCalledWith('bitrate', {
            icon: 'activity',
            text: '132 kbps',
            color: '#10b981',
        });
    });
});
