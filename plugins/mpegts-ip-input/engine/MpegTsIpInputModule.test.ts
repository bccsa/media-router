import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatBytes, bitrateBadge, interfaceAddress } from '@media-router/engine';
import { sniffEncapsulation } from './detectEncapsulation.js';
import { MpegTsIpInputModule } from './MpegTsIpInputModule.js';

// The sniff binds a real UDP socket and waits — stub it so these tests only
// assert the options the module hands it (the socket itself is covered by
// detectEncapsulation.test.ts).
vi.mock('./detectEncapsulation.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./detectEncapsulation.js')>()),
    sniffEncapsulation: vi.fn(async () => 'rtp'),
}));

// NIC-name → IPv4 now comes from the engine (the plugin no longer carries its
// own copy) — stub it so the join address doesn't depend on this host's NICs.
vi.mock('@media-router/engine', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@media-router/engine')>()),
    interfaceAddress: vi.fn((name: string) => (name === 'eth0' ? '192.168.1.10' : '')),
}));

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

describe('MpegTsIpInputModule video-info probe', () => {
    beforeEach(() => vi.clearAllMocks());

    it('taps the egress tee with a leaky queue + appsink and requests tsProbe', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        // Leaky tap: a stalled probe branch must never stall the relay tee.
        expect(desc!.pipeline).toContain(
            'busout_41000. ! queue leaky=downstream max-size-buffers=64 ! appsink name=tsprobe',
        );
        expect(desc!.tsProbe).toEqual({ appsink: 'tsprobe' });
    });

    it('renders display + codec into the video status line', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', {
            pid: 0x65, codec: 'h264', width: 1920, height: 1080,
            interlaced: true, fps: 25, display: '1920×1080i50',
        });
        expect(module.setStatusData).toHaveBeenCalledWith('video', {
            video: '1920×1080i50 (h264)',
        });
    });

    it('codec-only payload (pre-SPS / mpeg2) shows just the codec', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', { pid: 0x65, codec: 'mpeg2', display: null });
        expect(module.setStatusData).toHaveBeenCalledWith('video', { video: 'mpeg2' });
    });

    it('scrambled stream is labeled as such', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', {
            pid: 0x65, codec: 'h264', display: null, scrambled: true,
        });
        expect(module.setStatusData).toHaveBeenCalledWith('video', {
            video: 'h264 (scrambled)',
        });
    });

    it('ignores unrelated plugin-event channels', () => {
        const { module } = makeModule();
        module.onPluginEvent('stream:discovered', { pid: 0x65 });
        expect(module.setStatusData).not.toHaveBeenCalled();
    });
});

describe('MpegTsIpInputModule.detectEncapsulation', () => {
    beforeEach(() => vi.clearAllMocks());

    const sniffOpts = () => vi.mocked(sniffEncapsulation).mock.calls[0]![0];

    it('joins the group on the configured NIC — resolved by the engine helper', async () => {
        const { module } = makeModule();
        module.config = {
            encapsulation: 'auto',
            address: '239.1.1.1',
            port: 5004,
            interface: 'eth0',
        };
        await module.detectEncapsulation();
        expect(interfaceAddress).toHaveBeenCalledWith('eth0');
        expect(sniffOpts()).toMatchObject({
            port: 5004,
            multicastGroup: '239.1.1.1',
            ifaceAddr: '192.168.1.10',
        });
        expect(module.detectedEncap).toBe('rtp');
    });

    it('passes undefined — never the empty string — when the NIC has no external IPv4', async () => {
        const { module } = makeModule();
        // dgram's addMembership reads '' as an address and rejects it; the
        // engine helper returns '' for an unknown/IPv6-only/internal NIC.
        module.config = { encapsulation: 'auto', address: '239.1.1.1', interface: 'tun0' };
        await module.detectEncapsulation();
        expect(sniffOpts().ifaceAddr).toBeUndefined();
    });

    it('sniffs a unicast listen without a join', async () => {
        const { module } = makeModule();
        module.config = { encapsulation: 'auto', address: '0.0.0.0', interface: 'eth0' };
        await module.detectEncapsulation();
        expect(sniffOpts()).toMatchObject({ multicastGroup: undefined, ifaceAddr: undefined });
    });

    it('skips the sniff entirely when encapsulation is explicit', async () => {
        const { module } = makeModule();
        module.config = { encapsulation: 'rtp', address: '239.1.1.1' };
        await module.detectEncapsulation();
        expect(sniffEncapsulation).not.toHaveBeenCalled();
        expect(module.detectedEncap).toBeNull();
    });
});
