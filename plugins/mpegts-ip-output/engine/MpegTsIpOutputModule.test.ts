import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MpegTsIpOutputModule } from './MpegTsIpOutputModule.js';

function makeModule(opts: { hasSource?: boolean } = {}) {
    const module = new MpegTsIpOutputModule() as any;
    const hasSource = opts.hasSource ?? true;
    const getModuleUdpSource = vi.fn(() =>
        hasSource ? { host: '239.255.0.1', port: 41000 } : undefined,
    );
    module.services = {
        instanceId: 'mpegts-ip-out-1',
        mediaRouter: { getModuleUdpSource },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    return { module, getModuleUdpSource };
}

describe('MpegTsIpOutputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + info-logs when no source is connected', () => {
        const { module } = makeModule({ hasSource: false });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.log.info).toHaveBeenCalledWith(expect.stringContaining('No MPEG-TS source'));
    });

    it('returns null when destinations is empty', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ destinations: [] })).toBeNull();
        expect(module.log.warn).toHaveBeenCalledWith(expect.stringContaining('No destinations'));
    });

    it('builds a single multicast destination with iface + ttl, no tee', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            interface: 'eth0',
            ttl: 8,
            destinations: [{ host: '239.1.1.1', port: 5000 }],
        });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('udpsrc name=busin');
        expect(desc!.pipeline).toContain('udpsink name=netsink host=239.1.1.1 port=5000');
        expect(desc!.pipeline).toContain('multicast-iface=eth0');
        expect(desc!.pipeline).toContain('ttl-mc=8');
        expect(desc!.pipeline).not.toContain('tee');
        expect(desc!.pipeline).not.toContain('rtpmp2tpay');
    });

    it('uses unicast ttl (not ttl-mc) and omits iface for a unicast host', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            interface: 'eth0',
            ttl: 32,
            destinations: [{ host: '10.9.16.20', port: 5000 }],
        });
        // Assert on the network sink portion — the loopback bus source legitimately
        // carries multicast-iface=lo (it reads 239.255.0.1), which isn't the sink.
        const sink = desc!.pipeline.slice(desc!.pipeline.indexOf('udpsink'));
        expect(sink).toContain('host=10.9.16.20 port=5000 ttl=32');
        expect(sink).not.toContain('ttl-mc');
        expect(sink).not.toContain('multicast-iface');
    });

    it('fans out to a tee with one branch per destination', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            destinations: [
                { host: '10.0.0.1', port: 5000 },
                { host: '10.0.0.2', port: 5001 },
            ],
        });
        expect(desc!.pipeline).toContain('tee name=t');
        expect(desc!.pipeline).toContain('udpsink name=netsink0 host=10.0.0.1 port=5000');
        expect(desc!.pipeline).toContain('udpsink name=netsink1 host=10.0.0.2 port=5001');
        expect((desc!.pipeline.match(/t\. ! /g) ?? []).length).toBe(2);
    });

    it('inserts the RTP payloader when encapsulation is rtp', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            encapsulation: 'rtp',
            destinations: [{ host: '239.1.1.1', port: 5000 }],
        });
        expect(desc!.pipeline).toContain('rtpmp2tpay');
    });

    it('drops malformed destination entries', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            destinations: [{ host: '10.0.0.1', port: 5000 }, { host: '' }, { port: 6000 }],
        });
        // only the one valid entry survives → single sink, no tee
        expect(desc!.pipeline).toContain('udpsink name=netsink ');
        expect(desc!.pipeline).not.toContain('tee');
    });
});
