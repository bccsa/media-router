import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GstPluginBase, formatBytes, bitrateBadge, egressBusReports } from '@media-router/engine';
import { MpegTsIpOutputModule } from './MpegTsIpOutputModule.js';

function makeModule(opts: { hasSource?: boolean } = {}) {
    const module = new MpegTsIpOutputModule() as any;
    const hasSource = opts.hasSource ?? true;
    const getModuleBusSource = vi.fn(() =>
        hasSource ? { port: 41000, socketPath: '/tmp/mr-bus-41000-abc123.sock' } : undefined,
    );
    module.services = {
        instanceId: 'mpegts-ip-out-1',
        mediaRouter: { getModuleBusSource },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return { module, getModuleBusSource };
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
        expect(desc!.pipeline).toContain(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-41000-abc123.sock',
        );
        expect(desc!.pipeline).not.toContain('udpsrc');
        // ADR-0011: bus buffers are one access unit each, so raw mode always
        // re-slices to 1316 B datagrams — a pure re-chunk, never re-timed.
        expect(desc!.pipeline).toContain('tsparse alignment=7 set-timestamps=false');
        expect(desc!.pipeline).not.toContain('set-timestamps=true');
        expect(desc!.pipeline).toContain('udpsink name=netsink host=239.1.1.1 port=5000');
        expect(desc!.pipeline).toContain(
            'mrlateness name=lat_egress reference=running-time ! udpsink',
        );
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
        // Assert on the network sink portion only.
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
        // One egress tap ahead of the fan-out, not one per destination.
        expect(desc!.pipeline).toContain(
            'mrlateness name=lat_egress reference=running-time ! tee name=t',
        );
        expect(desc!.pipeline.match(/mrlateness name=lat_egress/g)).toHaveLength(1);
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
        expect(bitrateBadge(3200)).toEqual({
            icon: 'activity',
            text: '3.2 Mbps',
            color: '#10b981',
        });
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

describe('MpegTsIpOutputModule on the egress writer (WI-P5-10)', () => {
    afterEach(() => vi.restoreAllMocks());

    const DEST = { host: '239.0.0.1', port: 5000 };
    /** Where each part sits; every part present, in this order. */
    const inOrder = (pipeline: string, parts: string[]) => {
        const at = parts.map((p) => pipeline.indexOf(p));
        parts.forEach((p, i) => expect(at[i], p).toBeGreaterThanOrEqual(0));
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    };
    const WRITER = 'mrtsegress name=egress house-clock="house-clock, ';

    it('raw: bus source, queue, the writer, tsparse, the tap, the sink', () => {
        const { module } = makeModule();
        const p: string = module.buildPipeline({ destinations: [DEST] }).pipeline;
        expect(p.match(/mrtsegress/g)).toHaveLength(1);
        inOrder(p, [
            'unixfdsrc ',
            'queue leaky=0 ',
            WRITER,
            'tsparse alignment=7 ',
            'lat_egress',
            'udpsink',
        ]);
    });

    it('rtp: the writer before rtpmp2tpay, and before a forced tsparse', () => {
        const { module } = makeModule();
        const rtp: string = module.buildPipeline({
            destinations: [DEST],
            encapsulation: 'rtp',
        }).pipeline;
        inOrder(rtp, ['queue leaky=0 ', WRITER, 'rtpmp2tpay', 'lat_egress', 'udpsink']);
        expect(rtp).not.toContain('tsparse');
        const forced: string = module.buildPipeline({
            destinations: [DEST],
            encapsulation: 'rtp',
            packetsPerDatagram: 1,
        }).pipeline;
        inOrder(forced, [WRITER, 'tsparse alignment=1 ', 'rtpmp2tpay', 'lat_egress']);
    });

    it('one writer ahead of a multi-destination tee', () => {
        const { module } = makeModule();
        const p: string = module.buildPipeline({
            destinations: [
                DEST,
                { host: '10.0.0.2', port: 5002 },
                { host: '192.0.2.3', port: 5004 },
            ],
        }).pipeline;
        expect(p.match(/mrtsegress/g)).toHaveLength(1);
        inOrder(p, ['queue leaky=0 ', WRITER, 'tsparse', 'lat_egress', 'tee name=t', 't. ! ']);
        expect(p.indexOf('mrtsegress')).toBeLessThan(p.indexOf('t. ! '));
    });

    it("reports the writer's stats and events", () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ destinations: [DEST] }).busReports).toEqual(
            egressBusReports(),
        );
    });

    it('pushes a new house epoch to the writer once', async () => {
        const { module } = makeModule();
        const clock = new EventEmitter() as EventEmitter & Record<string, unknown>;
        let epoch = { eNs: 1_760_283_215_000_000_000n, seq: 4 };
        clock.epoch = () => epoch;
        clock.state = () => null;
        module.services.houseClock = clock;
        expect(module.buildPipeline({ destinations: [DEST] }).pipeline).toContain('seq=(uint)4,');
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockResolvedValue(undefined);
        vi.spyOn(GstPluginBase.prototype, 'onStop').mockResolvedValue(undefined);
        module.childProcess = { on: vi.fn() };
        module.setElementProperty = vi.fn().mockResolvedValue(undefined);
        await module.onStart();
        epoch = { eNs: 1_760_283_215_250_000_000n, seq: 5 };
        clock.emit('epoch', epoch);
        clock.emit('epoch', epoch);
        expect(module.setElementProperty).toHaveBeenCalledTimes(1);
        expect(module.setElementProperty).toHaveBeenCalledWith(
            'egress',
            'house-clock',
            expect.stringContaining('e-ns=(gint64)1760283215250000000, seq=(uint)5,'),
        );
        await module.onStop();
    });
});
