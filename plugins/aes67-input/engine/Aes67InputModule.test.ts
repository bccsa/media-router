import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Aes67InputModule } from './Aes67InputModule.js';
import { aes67Discovery } from './sapDiscovery.js';

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { busPort?: number | null } = {}) {
    const module = new Aes67InputModule() as any;
    const busPort = opts.busPort === undefined ? 41000 : opts.busPort;
    module.services = {
        instanceId: 'aes67-in-1',
        mediaRouter: {
            assignBusChannel: vi.fn(),
            getBusChannel: vi.fn(() => (busPort === null ? undefined : { port: busPort })),
        },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setHealth = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return module;
}

describe('Aes67InputModule.buildPipeline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        aes67Discovery.clear('aes67-in-1');
    });

    it('returns null when the bus pool is exhausted', () => {
        const module = makeModule({ busPort: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('bus channels'),
        );
    });

    it('refuses to receive with no stream selected (never "whatever arrives")', () => {
        // Broadcast rule, same as the audio devices: a receiver bound to
        // anything-goes picks up an unrelated stream and plays it on air.
        const module = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(module.setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('No stream selected'),
        );
    });

    it('builds the AES67 receive chain onto the 302M bus', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', port: 5004 });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('udpsrc name=netsrc multicast-group=239.69.0.1 port=5004');
        expect(desc!.pipeline).toContain('auto-multicast=true');
        // RTP carries no format of its own — the caps ARE the stream description.
        expect(desc!.pipeline).toContain('encoding-name=(string)L24');
        expect(desc!.pipeline).toContain('clock-rate=(int)48000');
        expect(desc!.pipeline).toContain('channels=(int)2');
        expect(desc!.pipeline).toContain('payload=(int)96');
        expect(desc!.pipeline).toContain('rtpjitterbuffer name=jbuf latency=20');
        expect(desc!.pipeline).toContain('rtpL24depay');
        // …and out onto the bus as 302M, exactly like audio-input-302m.
        expect(desc!.pipeline).toContain('avenc_s302m strict=experimental');
        expect(desc!.pipeline).toContain('tee name=busout_41000');
        expect(desc!.restartOnError).toBe(true);
    });

    it("never re-timestamps — the producer stamp is the engine stamper's job", () => {
        // Time-sync contract rule for plugin authors: no arrival-based re-timing
        // between the source and the bus sink.
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1' });
        expect(desc!.pipeline).not.toContain('do-timestamp');
        expect(desc!.pipeline).not.toContain('set-timestamps=true');
        expect(desc!.pipeline).not.toContain('tsparse');
    });

    it('binds the chosen NIC for the multicast join', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', interface: 'eth0' });
        expect(desc!.pipeline).toContain('multicast-iface=eth0');
    });

    it('receives unicast without a multicast join', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '10.9.1.42', port: 5006 });
        expect(desc!.pipeline).toContain('udpsrc name=netsrc port=5006');
        expect(desc!.pipeline).not.toContain('multicast-group');
    });

    it('switches the whole chain to L16 together', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', encoding: 'L16' });
        expect(desc!.pipeline).toContain('encoding-name=(string)L16');
        expect(desc!.pipeline).toContain('rtpL16depay');
        expect(desc!.pipeline).not.toContain('L24');
    });

    it('sizes the jitter buffer from config', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', jitterBufferMs: 5 });
        expect(desc!.pipeline).toContain('rtpjitterbuffer name=jbuf latency=5');
    });

    it('turns on rfc7273-sync only when a grandmaster is named', () => {
        const module = makeModule();
        const desc = module.buildPipeline({
            address: '239.69.0.1',
            ptpSync: true,
            ptpGmid: '00-1D-C1-FF-FE-50-30-EE',
            ptpDomain: 3,
        });
        expect(desc!.pipeline).toContain('rfc7273-sync=true');
        expect(desc!.pipeline).toContain(
            'a-ts-refclk=(string)\\"ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:3\\"',
        );
        expect(desc!.pipeline).toContain('a-mediaclk=(string)\\"direct=0\\"');
    });

    it('degrades to arrival scheduling (with a warning) when ptpSync has no grandmaster', () => {
        // A jitterbuffer told to sync to a clock that is not there stops
        // producing audio — silence is the worst possible failure here.
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', ptpSync: true });
        expect(desc!.pipeline).not.toContain('rfc7273-sync');
        expect(desc!.pipeline).not.toContain('ts-refclk');
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('grandmaster'),
        );
    });

    it('warns that a >2 channel stream is downmixed onto the 302M bus', () => {
        // avenc_s302m accepts [1,2] channels (verified on gst 1.28), so the
        // ceiling is real; losing channels silently would not be.
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', channels: 8 });
        expect(desc!.pipeline).toContain('channels=(int)8');
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('downmixed'),
        );
    });

    it('a picked SAP stream supplies the parameters the manual fields would', () => {
        const module = makeModule();
        aes67Discovery.publish('aes67-in-1', [
            {
                key: '10.9.1.50/abcd',
                name: 'Studio A',
                address: '239.69.7.7',
                port: 5008,
                encoding: 'L16',
                channels: 1,
                payloadType: 98,
            },
        ]);
        module.config = { discoveredStream: '239.69.7.7:5008' };
        module.resolvePickedStream();
        const desc = module.buildPipeline({
            discoveredStream: '239.69.7.7:5008',
            address: '239.0.0.1',
            port: 5004,
        });
        expect(desc!.pipeline).toContain('multicast-group=239.69.7.7 port=5008');
        expect(desc!.pipeline).toContain('encoding-name=(string)L16');
        expect(desc!.pipeline).toContain('channels=(int)1');
        expect(desc!.pipeline).toContain('payload=(int)98');
    });

    it('keeps running on the last known parameters when the announcement stops', () => {
        // The picked stream is remembered: a sender that pauses its
        // announcements must not silently re-point the receiver at the stale
        // manual fields mid-show.
        const module = makeModule();
        aes67Discovery.publish('aes67-in-1', [
            {
                key: 'k',
                name: 'Studio A',
                address: '239.69.7.7',
                port: 5008,
                encoding: 'L24',
                channels: 2,
            },
        ]);
        module.config = { discoveredStream: '239.69.7.7:5008' };
        module.resolvePickedStream();
        aes67Discovery.publish('aes67-in-1', []); // sender went quiet
        module.resolvePickedStream();
        const desc = module.buildPipeline({ discoveredStream: '239.69.7.7:5008' });
        expect(desc!.pipeline).toContain('multicast-group=239.69.7.7 port=5008');
    });
});

describe('Aes67InputModule SAP sidecar handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        aes67Discovery.clear('aes67-in-1');
    });

    it('publishes a snapshot into the shared discovery table', () => {
        const module = makeModule();
        module.handleSapLine(
            JSON.stringify({
                event: 'streams',
                streams: [{ key: 'k', name: 'Studio A', address: '239.69.0.1', port: 5004 }],
            }),
        );
        expect(aes67Discovery.list()).toHaveLength(1);
        expect(module.setStatusData).toHaveBeenCalledWith('discovery', { discovered: 1 });
    });

    it('an empty snapshot clears the table (a stopped sender must leave the picker)', () => {
        const module = makeModule();
        module.handleSapLine(
            JSON.stringify({
                event: 'streams',
                streams: [{ key: 'k', name: 'A', address: '239.69.0.1', port: 5004 }],
            }),
        );
        module.handleSapLine(JSON.stringify({ event: 'streams', streams: [] }));
        expect(aes67Discovery.list()).toHaveLength(0);
    });

    it('survives non-JSON sidecar output', () => {
        const module = makeModule();
        expect(() => module.handleSapLine('Traceback (most recent call last):')).not.toThrow();
    });

    it('logs sidecar errors rather than failing the module', () => {
        const module = makeModule();
        module.handleSapLine(JSON.stringify({ event: 'error', message: 'SAP listen failed' }));
        expect(module.log.warn).toHaveBeenCalled();
    });
});
