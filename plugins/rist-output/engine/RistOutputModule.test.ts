import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RistOutputModule } from './RistOutputModule.js';

function makeModule() {
    const module = new RistOutputModule() as any;
    module.services = {
        instanceId: 'rist-out-1',
        mediaRouter: {
            getModuleBusSource: vi.fn(() => ({
                port: 41000,
                connectionId: 'c1',
                socketPath: '/tmp/mr-bus-41000-abc123.sock',
            })),
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

describe('RistOutputModule.buildPipeline', () => {
    it('returns null when no MPEG-TS source is connected', () => {
        const { module } = makeModule();
        module.services.mediaRouter.getModuleBusSource = vi.fn(() => undefined);
        module.log = { info: vi.fn() };
        expect(module.buildPipeline({})).toBeNull();
    });

    it('reads its per-consumer edge socket and drains into the librist appsink', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-41000-abc123.sock');
        // The queue between unixfdsrc and the appsink is buildBusSrc's drain
        // contract — presence matters here, its tuning is the builder's test.
        expect(desc.pipeline).toMatch(/unixfdsrc[^!]+! queue /);
        expect(desc.pipeline).toContain('appsink name=ristsink');
        expect(desc.pipeline).not.toContain('udpsrc');
        expect(desc.restartOnError).toBe(true);
    });

    it('carries the librist sender config with per-link rist:// URLs', () => {
        const { module } = makeModule();
        module.config = {
            links: [{ mode: 'caller', address: 'rist.example.net', port: 5004, weight: 5, cname: 'tx1' }],
            profile: 1,
            buffer: 1200,
            secret: 'hush',
            encryptionType: 256,
            nullPacketDeletion: true,
            statsInterval: 1000,
        };
        const desc = module.buildPipeline({})!;
        expect(desc.rist).toMatchObject({
            role: 'sender',
            profile: 1,
            buffer: 1200,
            secret: 'hush',
            encType: 256,
            npd: true,
            statsInterval: 1000,
            appElement: 'ristsink',
        });
        expect(desc.rist.urls).toEqual(['rist://rist.example.net:5004?weight=5&cname=tx1']);
    });

    it('defaults to a single caller link on :5004', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.rist.urls).toEqual(['rist://localhost:5004?weight=50&cname=link1']);
    });
});

describe('RistOutputModule rist:stats rendering', () => {
    beforeEach(() => vi.clearAllMocks());

    function stats(module: any, json: unknown): void {
        module.onPluginEvent('rist:stats', json);
    }

    it('emits a per-peer dynamic section keyed by peer.id with the cname as label', () => {
        const { module, setStatusData } = makeModule();
        stats(module, {
            'sender-stats': {
                peer: {
                    id: 1,
                    cname: 'remote-tx',
                    stats: {
                        quality: 95,
                        sent: 1000,
                        retransmitted: 5,
                        bandwidth: 4_500_000,
                        avg_rtt: 12.3,
                    },
                },
            },
        });
        expect(module.dynamicStatusSections).toHaveLength(1);
        expect(module.dynamicStatusSections[0]).toMatchObject({ id: 'peer-1', label: 'remote-tx' });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ quality: 95, sent: 1000, retransmitted: 5, bandwidth: '4.5 Mbps', rtt: '12.30' }),
        );
    });

    it('renders librist bits/s bandwidth with adaptive kbps/Mbps units', () => {
        const { module, setStatusData } = makeModule();
        // librist reports bits per second, not kbps — a 512 kbit/s link must
        // not surface as "512000 kbps".
        stats(module, {
            'sender-stats': { peer: { id: 1, stats: { quality: 99, bandwidth: 512_000 } } },
        });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ bandwidth: '512 kbps' }),
        );
    });

    it('shows a dash when librist reports no bandwidth', () => {
        const { module, setStatusData } = makeModule();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 99 } } } });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ bandwidth: '—' }),
        );
    });

    it('does not duplicate the dynamic section when the same peer reports again', () => {
        const { module } = makeModule();
        const payload = {
            'sender-stats': { peer: { id: 1, cname: 'remote-tx', stats: { quality: 95 } } },
        };
        stats(module, payload);
        stats(module, payload);
        expect(module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1')).toHaveLength(1);
    });

    it('tracks peer last-seen timestamps in peerLastSeen', () => {
        const { module } = makeModule();
        stats(module, { 'sender-stats': { peer: { id: 7, stats: { quality: 90 } } } });
        expect(module.peerLastSeen.has(7)).toBe(true);
        const ts = module.peerLastSeen.get(7)!;
        expect(ts).toBeGreaterThan(Date.now() - 1000);
    });

    it('colours the quality badge green/amber/red by threshold', () => {
        const { module, setBadge } = makeModule();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 95 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#10b981' }));

        setBadge.mockClear();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 60 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#f59e0b' }));

        setBadge.mockClear();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 30 } } } });
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#ef4444' }));
    });

    it('emits a connections badge reflecting the peer-last-seen size', () => {
        const { module, setBadge } = makeModule();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 90 } } } });
        stats(module, { 'sender-stats': { peer: { id: 2, stats: { quality: 90 } } } });
        // Last call should reflect 2 active peers
        const lastConnectionsCall = setBadge.mock.calls
            .filter((c) => c[0] === 'connections')
            .pop();
        expect(lastConnectionsCall![1]).toMatchObject({ text: '2', color: '#10b981' });
    });

    it('ignores payloads without sender-stats.peer.stats', () => {
        const { module, setStatusData } = makeModule();
        stats(module, { 'sender-stats': { peer: {} } });
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

describe('RistOutputModule.cleanupStalePeers', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-18T12:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('removes peers that have not been seen for >3s and drops their section', () => {
        const { module, setBadge } = makeModule();
        module.peerLastSeen.set(1, Date.now() - 5000);
        module.peerLastSeen.set(2, Date.now() - 1000);
        module.dynamicStatusSections = [
            { id: 'peer-1', label: 'a', fields: [] },
            { id: 'peer-2', label: 'b', fields: [] },
        ];
        module.cleanupStalePeers();
        expect(module.peerLastSeen.has(1)).toBe(false);
        expect(module.peerLastSeen.has(2)).toBe(true);
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-2']);
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ text: '1' }),
        );
    });

    it('clears the quality badge once the last peer is dropped', () => {
        const { module, clearBadge } = makeModule();
        module.peerLastSeen.set(1, Date.now() - 5000);
        module.cleanupStalePeers();
        expect(module.peerLastSeen.size).toBe(0);
        expect(clearBadge).toHaveBeenCalledWith('quality');
    });

    it('is a no-op when no peers are stale', () => {
        const { module, setBadge, clearBadge } = makeModule();
        module.peerLastSeen.set(1, Date.now());
        module.cleanupStalePeers();
        expect(setBadge).not.toHaveBeenCalled();
        expect(clearBadge).not.toHaveBeenCalled();
        expect(module.peerLastSeen.has(1)).toBe(true);
    });
});
