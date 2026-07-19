import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatBytes, bitrateBadge } from '@media-router/engine';
import { MpegTsIpInputModule } from './MpegTsIpInputModule.js';

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { udpPort?: number | null } = {}) {
    const module = new MpegTsIpInputModule() as any;
    const udpPort = opts.udpPort === undefined ? 41000 : opts.udpPort;
    const getBusChannel = vi.fn(() =>
        udpPort === null ? undefined : { port: udpPort },
    );
    module.services = {
        instanceId: 'mpegts-ip-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return { module, getBusChannel };
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
        // raw TS caps on the network udpsrc, not RTP
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc [^!]*caps="video\/mpegts/);
        expect(desc!.pipeline).not.toContain('application/x-rtp');
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
        // No tsparse: it aggregates TS into >64KB buffers that the loopback
        // udpsink can't send (UDP datagram limit) and drops. Pure passthrough.
        expect(desc!.pipeline).not.toContain('tsparse');
        // udpsrc feeds straight into a NON-leaky back-pressure queue: on a clean
        // loopback relay a leaky queue would shed TS packets on a sender burst →
        // continuity errors / macroblocking downstream. See buildBackpressureQueue.
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc[^!]*! queue leaky=0/);
        // rebroadcasts on the local bus at the assigned channel (fan-out tee)
        expect(desc!.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc!.pipeline).not.toContain('udpsink');
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
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc [^!]*caps="video\/mpegts/);
        expect(desc!.pipeline).not.toContain('application/x-rtp');
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

describe('MpegTsIpInputModule.pollStats', () => {
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
        expect(module.trackThroughput).toHaveBeenCalledWith('netsrc', 'src');
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('shows a green "Connected" badge + bitrate/bytes in the popup when flowing', async () => {
        // Mirrors the SRT badge: the face shows a status word, the bitrate lives
        // in the Live Stats popup (not the badge).
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            netsrc: { total_bytes: 2048, bitrate_kbps: 2500, bitrate_mbps: 2.5 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.trackThroughput).not.toHaveBeenCalled();
        expect(module.setStatusData).toHaveBeenCalledWith('stats', {
            bitrate: '2.50',
            bytesReceived: formatBytes(2048),
        });
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Connected',
            color: '#10b981',
        });
        // Second face badge: the live bitrate (2.5 Mbps = 2500 kbps here).
        expect(module.setBadge).toHaveBeenCalledWith('bitrate', bitrateBadge(2500));
        expect(bitrateBadge(2500)).toEqual({ icon: 'activity', text: '2.5 Mbps', color: '#10b981' });
    });

    it('shows grey "Waiting" and clears the bitrate badge when nothing has arrived', async () => {
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            netsrc: { total_bytes: 0, bitrate_kbps: 0, bitrate_mbps: 0 },
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
            netsrc: { total_bytes: 4096, bitrate_kbps: 0, bitrate_mbps: 0 },
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
