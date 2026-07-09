import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RistOutputModule } from './RistOutputModule.js';

function makeModule() {
    const module = new RistOutputModule() as any;
    module.services = { instanceId: 'rist-out-1' };
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
    it('always returns null — ristsender CLI does the work, no GStreamer pipeline', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
    });
});

describe('RistOutputModule.onStart', () => {
    it('joins the multicast bus group on lo for its input', async () => {
        const { module } = makeModule();
        module.services.mediaRouter = {
            getModuleUdpSource: vi.fn(() => ({ host: '239.255.0.1', port: 41000, connectionId: 'c1' })),
        };
        module.services.processManager = {};
        module.setHealth = vi.fn();
        module.spawnRunnerProcess = vi.fn(() => ({ on: vi.fn() }));
        await module.onStart();
        const args = module.spawnRunnerProcess.mock.calls[0][0].args as string[];
        expect(args[args.indexOf('-i') + 1]).toBe('udp://239.255.0.1:41000?miface=lo');
    });
});

describe('RistOutputModule.parseStats', () => {
    beforeEach(() => vi.clearAllMocks());

    function statsLine(json: unknown): string {
        return `1234 -stats" ${JSON.stringify(json)}`;
    }

    it('emits a per-peer dynamic section keyed by peer.id with the cname as label', () => {
        const { module, setStatusData } = makeModule();
        module.parseStats(
            statsLine({
                'sender-stats': {
                    peer: {
                        id: 1,
                        cname: 'remote-tx',
                        stats: { quality: 95, sent: 1000, retransmitted: 5, bandwidth: 4500, avg_rtt: 12.3 },
                    },
                },
            }),
        );
        expect(module.dynamicStatusSections).toHaveLength(1);
        expect(module.dynamicStatusSections[0]).toMatchObject({ id: 'peer-1', label: 'remote-tx' });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ quality: 95, sent: 1000, retransmitted: 5, bandwidth: '4500 kbps', rtt: '12.30' }),
        );
    });

    it('does not duplicate the dynamic section when the same peer reports again', () => {
        const { module } = makeModule();
        const payload = {
            'sender-stats': { peer: { id: 1, cname: 'remote-tx', stats: { quality: 95 } } },
        };
        module.parseStats(statsLine(payload));
        module.parseStats(statsLine(payload));
        expect(module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1')).toHaveLength(1);
    });

    it('tracks peer last-seen timestamps in peerLastSeen', () => {
        const { module } = makeModule();
        module.parseStats(
            statsLine({ 'sender-stats': { peer: { id: 7, stats: { quality: 90 } } } }),
        );
        expect(module.peerLastSeen.has(7)).toBe(true);
        const ts = module.peerLastSeen.get(7)!;
        expect(ts).toBeGreaterThan(Date.now() - 1000);
    });

    it('colours the quality badge green/amber/red by threshold', () => {
        const { module, setBadge } = makeModule();
        module.parseStats(
            statsLine({ 'sender-stats': { peer: { id: 1, stats: { quality: 95 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#10b981' }));

        setBadge.mockClear();
        module.parseStats(
            statsLine({ 'sender-stats': { peer: { id: 1, stats: { quality: 60 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#f59e0b' }));

        setBadge.mockClear();
        module.parseStats(
            statsLine({ 'sender-stats': { peer: { id: 1, stats: { quality: 30 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#ef4444' }));
    });

    it('emits a connections badge reflecting the peer-last-seen size', () => {
        const { module, setBadge } = makeModule();
        module.parseStats(statsLine({ 'sender-stats': { peer: { id: 1, stats: { quality: 90 } } } }));
        module.parseStats(statsLine({ 'sender-stats': { peer: { id: 2, stats: { quality: 90 } } } }));
        // Last call should reflect 2 active peers
        const lastConnectionsCall = setBadge.mock.calls
            .filter((c) => c[0] === 'connections')
            .pop();
        expect(lastConnectionsCall![1]).toMatchObject({ text: '2', color: '#10b981' });
    });

    it('ignores payloads without sender-stats.peer.stats', () => {
        const { module, setStatusData } = makeModule();
        module.parseStats(statsLine({ 'sender-stats': { peer: {} } }));
        expect(setStatusData).not.toHaveBeenCalled();
    });

    it('does not throw on malformed JSON', () => {
        const { module } = makeModule();
        expect(() => module.parseStats('1234 -stats" { incomplete')).not.toThrow();
    });

    it('does not throw when the line contains no JSON at all', () => {
        const { module } = makeModule();
        expect(() => module.parseStats('plain log line')).not.toThrow();
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
