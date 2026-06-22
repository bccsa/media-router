import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MpegTsIpInputModule } from './MpegTsIpInputModule.js';

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { udpPort?: number | null } = {}) {
    const module = new MpegTsIpInputModule() as any;
    const udpPort = opts.udpPort === undefined ? 41000 : opts.udpPort;
    const getUdpEndpoint = vi.fn(() =>
        udpPort === null ? undefined : { host: '239.255.0.1', port: udpPort },
    );
    module.services = {
        instanceId: 'mpegts-ip-in-1',
        mediaRouter: { assignUdpPort: vi.fn(), getUdpEndpoint },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    return { module, getUdpEndpoint };
}

describe('MpegTsIpInputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + warns when no UDP port is assigned', () => {
        const { module } = makeModule({ udpPort: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.log.warn).toHaveBeenCalledWith(expect.stringContaining('No UDP port'));
    });

    it('builds a raw unicast receive chain by default', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        // unicast: bare port, no multicast-group
        expect(desc!.pipeline).toContain('udpsrc name=netsrc port=5000');
        expect(desc!.pipeline).not.toContain('multicast-group');
        // raw TS caps, not RTP
        expect(desc!.pipeline).toContain('video/mpegts');
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
        // No tsparse: it aggregates TS into >64KB buffers that the loopback
        // udpsink can't send (UDP datagram limit) and drops. Pure passthrough.
        expect(desc!.pipeline).not.toContain('tsparse');
        // udpsrc feeds straight into the leaky queue
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc[^!]*! queue leaky=2/);
        // rebroadcasts on the loopback bus at the assigned port
        expect(desc!.pipeline).toContain('host=239.255.0.1');
        expect(desc!.pipeline).toContain('port=41000');
        expect(desc!.restartOnError).toBe(true);
    });

    it('joins a multicast group with the chosen interface', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ address: '239.1.1.1', port: 5004, interface: 'eth0' });
        expect(desc!.pipeline).toContain('multicast-group=239.1.1.1');
        expect(desc!.pipeline).toContain('port=5004');
        expect(desc!.pipeline).toContain('multicast-iface=eth0');
        expect(desc!.pipeline).toContain('auto-multicast=true');
    });

    it('inserts the RTP depay chain when encapsulation is rtp', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ encapsulation: 'rtp' });
        expect(desc!.pipeline).toContain('application/x-rtp');
        expect(desc!.pipeline).toContain('encoding-name=(string)MP2T');
        expect(desc!.pipeline).toContain('rtpjitterbuffer ! rtpmp2tdepay');
    });

    it('applies the jitterMs buffer to the leaky queue', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ jitterMs: 500 });
        // 500 ms → 500_000_000 ns
        expect(desc!.pipeline).toContain('max-size-time=500000000');
    });

    it('defaults to raw when encapsulation is auto and nothing was detected', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ encapsulation: 'auto' });
        expect(desc!.pipeline).toContain('video/mpegts');
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
    });

    it('uses the sniffed encapsulation when on auto', () => {
        const { module } = makeModule();
        module.detectedEncap = 'rtp'; // simulate a completed sniff
        const desc = module.buildPipeline({ encapsulation: 'auto' });
        expect(desc!.pipeline).toContain('rtpmp2tdepay');
    });

    it('an explicit raw/rtp setting overrides any detection', () => {
        const { module } = makeModule();
        module.detectedEncap = 'rtp';
        const desc = module.buildPipeline({ encapsulation: 'raw' });
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
    });
});
