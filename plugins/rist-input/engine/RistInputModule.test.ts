import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RistInputModule } from './RistInputModule.js';

function makeModule() {
    const module = new RistInputModule() as any;
    module.services = {
        instanceId: 'rist-in-1',
        mediaRouter: {
            assignUdpPort: vi.fn(() => ({ host: '239.255.0.1', port: 41000 })),
            getUdpEndpoint: vi.fn(() => ({ host: '239.255.0.1', port: 41000 })),
        },
    };
    module.config = {};
    module.dynamicStatusSections = [];
    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    const clearBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    module.clearBadge = clearBadge;
    return { module, setStatusData, setBadge, clearBadge };
}

describe('RistInputModule.buildPipeline', () => {
    const savedTransport = process.env.MR_BUS_TRANSPORT;
    afterEach(() => {
        if (savedTransport === undefined) delete process.env.MR_BUS_TRANSPORT;
        else process.env.MR_BUS_TRANSPORT = savedTransport;
    });

    it('returns null when no bus port is assigned', () => {
        const { module } = makeModule();
        module.services.mediaRouter.getUdpEndpoint = vi.fn(() => undefined);
        module.log = { warn: vi.fn() };
        expect(module.buildPipeline({})).toBeNull();
    });

    it('builds a live appsrc feeding the bus sink (udp transport)', () => {
        delete process.env.MR_BUS_TRANSPORT;
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain(
            'appsrc name=ristsrc is-live=true do-timestamp=true format=time',
        );
        expect(desc.pipeline).toContain('caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188"');
        expect(desc.pipeline).toContain('leaky-type=downstream');
        expect(desc.pipeline).toContain('udpsink name=usink host=239.255.0.1 port=41000');
        expect(desc.restartOnError).toBe(true);
    });

    it('becomes a tee fan-out producer under the unixfd bus', () => {
        process.env.MR_BUS_TRANSPORT = 'unixfd';
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('tee name=busout_41000 allow-not-linked=true');
        expect(desc.pipeline).not.toContain('udpsink');
    });

    it('carries the librist receiver config with per-link rist:// URLs', () => {
        const { module } = makeModule();
        module.config = {
            links: [
                { mode: 'listener', address: '0.0.0.0', port: 5004, weight: 50, cname: 'link1' },
                { mode: 'caller', address: '10.0.0.9', port: 5006, weight: 10, cname: 'link2' },
            ],
            profile: 1,
            buffer: 800,
            secret: 's3cret',
            encryptionType: 128,
            statsInterval: 500,
        };
        const desc = module.buildPipeline({})!;
        expect(desc.rist).toMatchObject({
            role: 'receiver',
            profile: 1,
            buffer: 800,
            secret: 's3cret',
            encType: 128,
            statsInterval: 500,
            appElement: 'ristsrc',
        });
        expect(desc.rist.urls).toEqual([
            'rist://@0.0.0.0:5004?weight=50&cname=link1',
            'rist://10.0.0.9:5006?weight=10&cname=link2',
        ]);
    });

    it('defaults to a single listener link on :5004', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.rist.urls).toEqual(['rist://@0.0.0.0:5004?weight=50&cname=link1']);
    });
});

describe('RistInputModule rist:stats rendering', () => {
    beforeEach(() => vi.clearAllMocks());

    function stats(module: any, json: unknown): void {
        module.onPluginEvent('rist:stats', json);
    }

    it('updates flow-level stats from receiver-stats.flowinstant.stats', () => {
        const { module, setStatusData } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: {
                    stats: { received: 100, dropped_late: 1, recovered_total: 2, lost: 3, quality: 95 },
                },
            },
        });
        expect(setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({ received: 100, dropped: 1, recovered: 2, lost: 3 }),
        );
    });

    it('emits a per-peer dynamic section keyed by peer.id', () => {
        const { module, setStatusData } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: {
                    stats: { received: 100 },
                    peers: [
                        { id: 1, cname: 'studio-A', stats: { quality: 92, received: 80, avg_rtt: 14.5 } },
                        { id: 2, cname: 'studio-B', stats: { quality: 30, received: 20, avg_rtt: 95 } },
                    ],
                },
            },
        });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-1', 'peer-2']);
        expect(module.dynamicStatusSections.map((s: { label: string }) => s.label)).toEqual(['studio-A', 'studio-B']);
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ quality: 92, received: 80, rtt: '14.50' }),
        );
    });

    it('does not duplicate the dynamic section if the same peer appears again', () => {
        const { module } = makeModule();
        const payload = {
            'receiver-stats': {
                flowinstant: {
                    stats: { received: 10 },
                    peers: [{ id: 1, cname: 'studio-A', stats: { quality: 90 } }],
                },
            },
        };
        stats(module, payload);
        stats(module, payload);
        expect(module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1')).toHaveLength(1);
    });

    it('colours the quality badge green/amber/red by threshold', () => {
        // Quality is read from flow.stats.quality, not per-peer
        const { module, setBadge } = makeModule();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 95 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#10b981' }));

        setBadge.mockClear();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 60 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#f59e0b' }));

        setBadge.mockClear();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 30 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#ef4444' }));
    });

    it('emits a connections badge with the peer count', () => {
        const { module, setBadge } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: {
                    stats: { received: 1 },
                    peers: [
                        { id: 1, stats: { quality: 90 } },
                        { id: 2, stats: { quality: 90 } },
                    ],
                },
            },
        });
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ icon: 'link', text: '2', color: '#10b981' }),
        );
    });

    it('ignores stats with no flowinstant payload', () => {
        const { module, setStatusData } = makeModule();
        stats(module, { 'receiver-stats': {} });
        expect(setStatusData).not.toHaveBeenCalled();
    });

    it('ignores other plugin-event channels and malformed payloads', () => {
        const { module, setStatusData } = makeModule();
        module.onPluginEvent('stream:names', { payload: 'x' });
        expect(() => stats(module, null)).not.toThrow();
        expect(() => stats(module, 'not an object')).not.toThrow();
        expect(setStatusData).not.toHaveBeenCalled();
    });
});
