import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatBytes, bitrateBadge } from '@media-router/engine';
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
    module.clearBadge = vi.fn();
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
        // Egress repacks the 188-byte internal TS to 1316 B (7 packets) for the wire by default.
        expect(desc!.pipeline).toContain('tsparse alignment=7 set-timestamps=false');
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

describe('MpegTsIpOutputModule.pollStats', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does nothing while the pipeline is not running', async () => {
        const { module } = makeModule();
        module.running = false;
        module.getThroughput = vi.fn();
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.getThroughput).not.toHaveBeenCalled();
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('registers the pad probe when no tracker exists yet, without setting stats', async () => {
        // The tracker is missing until the child pipeline reaches PLAYING (and
        // after a restart the fresh child starts empty) — pollStats must
        // (re)register lazily rather than one-shot in onStart, else stats stay
        // blank forever. Regression for the "live stats show —" bug.
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({});
        module.trackThroughput = vi.fn().mockResolvedValue(undefined);
        await module.pollStats();
        expect(module.trackThroughput).toHaveBeenCalledWith('busin', 'src');
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('shows a green "Connected" badge + bitrate/bytes in the popup when flowing', async () => {
        // Mirrors the SRT badge: the face shows a status word, the bitrate lives
        // in the Live Stats popup (not the badge).
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            busin: { total_bytes: 4096, bitrate_kbps: 3200, bitrate_mbps: 3.2 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.trackThroughput).not.toHaveBeenCalled();
        expect(module.setStatusData).toHaveBeenCalledWith('stats', {
            bitrate: '3.20',
            bytesSent: formatBytes(4096),
        });
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Connected',
            color: '#10b981',
        });
        // Second face badge: the live bitrate (3.2 Mbps = 3200 kbps here).
        expect(module.setBadge).toHaveBeenCalledWith('bitrate', bitrateBadge(3200));
        expect(bitrateBadge(3200)).toEqual({ icon: 'activity', text: '3.2 Mbps', color: '#10b981' });
    });

    it('shows grey "Waiting" and clears the bitrate badge when nothing has been sent', async () => {
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            busin: { total_bytes: 0, bitrate_kbps: 0, bitrate_mbps: 0 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Waiting',
            color: '#6b7280',
        });
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
    });

    it('shows amber "Stalled" and clears the bitrate badge when the feed dried up', async () => {
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            busin: { total_bytes: 8192, bitrate_kbps: 0, bitrate_mbps: 0 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Stalled',
            color: '#f59e0b',
        });
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
    });
});
