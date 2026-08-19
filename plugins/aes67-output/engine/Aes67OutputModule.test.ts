import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Aes67OutputModule } from './Aes67OutputModule.js';

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { source?: boolean; contract?: boolean } = {}) {
    const module = new Aes67OutputModule() as any;
    const source =
        opts.source === false ? undefined : { port: 41000, socketPath: '/run/mr/edge.sock' };
    module.services = {
        instanceId: 'aes67-out-1',
        timeSyncContract: opts.contract ?? true,
        mediaRouter: { getModuleBusSource: vi.fn(() => source) },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setHealth = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return module;
}

const DEST = { address: '239.69.0.1', port: 5004 };

describe('Aes67OutputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('is idle until a 302M source is wired in', () => {
        const module = makeModule({ source: false });
        expect(module.buildPipeline(DEST)).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No 302M source'),
        );
    });

    it('refuses to send with no destination', () => {
        const module = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('No destination'),
        );
    });

    it('builds the bus → AES67 chain', () => {
        const module = makeModule();
        const desc = module.buildPipeline(DEST);
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('unixfdsrc name=busin');
        expect(desc!.pipeline).toContain('tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m');
        expect(desc!.pipeline).toContain(
            'audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved',
        );
        expect(desc!.pipeline).toContain('rtpL24pay name=pay pt=96 mtu=1452');
        expect(desc!.pipeline).toContain('udpsink name=netsink host=239.69.0.1 port=5004');
        expect(desc!.restartOnError).toBe(true);
    });

    it('pins the packet time at both ends so the payloader cannot coalesce', () => {
        const module = makeModule();
        expect(module.buildPipeline(DEST)!.pipeline).toContain(
            'min-ptime=1000000 max-ptime=1000000',
        );
        expect(module.buildPipeline({ ...DEST, ptimeMs: 0.25 })!.pipeline).toContain(
            'min-ptime=250000 max-ptime=250000',
        );
    });

    it('marks the media DSCP EF by default, and honours an override', () => {
        const module = makeModule();
        expect(module.buildPipeline(DEST)!.pipeline).toContain('qos-dscp=46');
        expect(module.buildPipeline({ ...DEST, dscp: 34 })!.pipeline).toContain('qos-dscp=34');
        expect(module.buildPipeline({ ...DEST, dscp: -1 })!.pipeline).toContain('qos-dscp=-1');
    });

    it('uses multicast TTL and the chosen NIC for a group, plain TTL for a host', () => {
        const module = makeModule();
        const mc = module.buildPipeline({ ...DEST, interface: 'eth0', ttl: 8 });
        expect(mc!.pipeline).toContain('multicast-iface=eth0');
        expect(mc!.pipeline).toContain('auto-multicast=true ttl-mc=8');
        const uni = module.buildPipeline({
            address: '10.9.1.42',
            port: 5004,
            interface: 'eth0',
            ttl: 8,
        });
        expect(uni!.pipeline).toContain(' ttl=8');
        expect(uni!.pipeline).not.toContain('multicast-iface');
    });

    it('switches the whole chain to L16 together', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ ...DEST, encoding: 'L16' });
        expect(desc!.pipeline).toContain('format=S16BE');
        expect(desc!.pipeline).toContain('rtpL16pay');
        expect(desc!.pipeline).not.toContain('L24');
    });

    it('refuses a packet time that cannot fit the MTU instead of fragmenting it', () => {
        // 4 ms of stereo L24 is 1152 B of payload; a 576 B MTU would have the
        // payloader split it into something no AES67 receiver expects.
        const module = makeModule();
        expect(module.buildPipeline({ ...DEST, ptimeMs: 4, mtu: 576 })).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1152 B'));
    });

    describe('pacing', () => {
        it('paces against the house clock under the contract', () => {
            // The payloader emits one buffer per packet time; without a syncing
            // sink they leave in decode-sized bursts.
            const module = makeModule({ contract: true });
            const desc = module.buildPipeline({ ...DEST, senderLatencyMs: 15 });
            expect(desc!.pipeline).toContain('sync=true max-lateness=-1 ts-offset=15000000');
        });

        it('is NOT the route playout offset D', () => {
            // D would delay the egress by ~300 ms, spending the receiver's link
            // offset on our side of the wire while the RTP timestamps (which
            // carry the alignment) stay unchanged. Default is 20 ms, not 300.
            const module = makeModule({ contract: true });
            expect(module.buildPipeline(DEST)!.pipeline).toContain('ts-offset=20000000');
        });

        it('free-runs with the contract off (no house clock to pace against)', () => {
            const module = makeModule({ contract: false });
            const desc = module.buildPipeline(DEST);
            expect(desc!.pipeline).toContain('sync=false');
            expect(desc!.pipeline).not.toContain('ts-offset');
        });
    });

    describe('PTP epoch stamping', () => {
        it('leaves the payloader on its random RFC 3550 offset when the epoch is unknown', () => {
            const module = makeModule();
            module.epoch = null;
            expect(module.buildPipeline(DEST)!.pipeline).not.toContain('timestamp-offset');
        });

        it('pins timestamp-offset to the measured TAI↔monotonic offset', () => {
            const module = makeModule();
            module.epoch = { rtpTimestampOffset: 123456789, taiOffsetS: 37 };
            expect(module.buildPipeline(DEST)!.pipeline).toContain('timestamp-offset=123456789');
        });

        it('warns when ptpSync was asked for but the epoch could not be claimed', () => {
            // The failure that must never be silent: announcing a PTP media
            // clock we do not have is undetectable at the receiver.
            const module = makeModule();
            module.epoch = null;
            module.epochError = 'system clock is not PTP/TAI disciplined';
            module.buildPipeline({ ...DEST, ptpSync: true });
            expect(module.setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('disciplined'),
            );
        });
    });
});

describe('Aes67OutputModule.measureEpoch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does nothing at all when ptpSync is off', async () => {
        const module = makeModule();
        module.config = { ptpSync: false };
        await module.measureEpoch();
        expect(module.epoch).toBeNull();
        expect(module.epochError).toBe('');
    });

    it('refuses the epoch when the time-sync contract is off', async () => {
        // Without the contract, running time is a per-start base time — the
        // offset would map onto an arbitrary origin, i.e. a WRONG epoch.
        const module = makeModule({ contract: false });
        module.config = { ptpSync: true };
        await module.measureEpoch();
        expect(module.epoch).toBeNull();
        expect(module.epochError).toContain('time-sync contract is off');
    });

    it('reads the real clock helper end to end (and refuses on an undisciplined box)', async () => {
        // Runs plugins/aes67-core/py/aes67_clock.py for real: on a box with no
        // ptp4l/phc2sys the kernel TAI offset is 0, so this asserts the REFUSAL
        // path on CI and the accept path on a disciplined box — both correct.
        const module = makeModule({ contract: true });
        module.config = { ptpSync: true };
        await module.measureEpoch();
        if (module.epoch) {
            expect(module.epoch.rtpTimestampOffset).toBeGreaterThanOrEqual(0);
            expect(module.epoch.rtpTimestampOffset).toBeLessThan(2 ** 32);
            expect(module.epochError).toBe('');
        } else {
            expect(module.epochError).toMatch(/disciplined|not found|failed/);
        }
    });
});
