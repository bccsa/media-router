import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    it('always returns null — ristreceiver CLI does the work, no GStreamer pipeline', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
    });
});

describe('RistInputModule.onStart', () => {
    it('points ristreceiver at the multicast bus group on lo', async () => {
        const { module } = makeModule();
        module.services.processManager = {};
        module.setHealth = vi.fn();
        module.spawnRunnerProcess = vi.fn(() => ({ on: vi.fn() }));
        await module.onStart();
        const args = module.spawnRunnerProcess.mock.calls[0][0].args as string[];
        expect(args[args.indexOf('-o') + 1]).toBe('udp://239.255.0.1:41000?miface=lo');
    });
});

describe('RistInputModule.parseStats', () => {
    beforeEach(() => vi.clearAllMocks());

    function statsLine(json: unknown): string {
        // Real ristreceiver output prefixes the JSON with a tag that includes
        // the literal `-stats"` substring the dispatcher filters on; the
        // parser itself just looks for the first `{`.
        return `1234 -stats" ${JSON.stringify(json)}`;
    }

    it('updates flow-level stats from receiver-stats.flowinstant.stats', () => {
        const { module, setStatusData } = makeModule();
        module.parseStats(
            statsLine({
                'receiver-stats': {
                    flowinstant: {
                        stats: { received: 100, dropped_late: 1, recovered_total: 2, lost: 3, quality: 95 },
                    },
                },
            }),
        );
        expect(setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({ received: 100, dropped: 1, recovered: 2, lost: 3 }),
        );
    });

    it('emits a per-peer dynamic section keyed by peer.id', () => {
        const { module, setStatusData } = makeModule();
        module.parseStats(
            statsLine({
                'receiver-stats': {
                    flowinstant: {
                        stats: { received: 100 },
                        peers: [
                            { id: 1, cname: 'studio-A', stats: { quality: 92, received: 80, avg_rtt: 14.5 } },
                            { id: 2, cname: 'studio-B', stats: { quality: 30, received: 20, avg_rtt: 95 } },
                        ],
                    },
                },
            }),
        );
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
        module.parseStats(statsLine(payload));
        module.parseStats(statsLine(payload));
        expect(module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1')).toHaveLength(1);
    });

    it('colours the quality badge green/amber/red by threshold', () => {
        // Quality is read from flow.stats.quality, not per-peer
        const { module, setBadge } = makeModule();
        module.parseStats(
            statsLine({ 'receiver-stats': { flowinstant: { stats: { quality: 95 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#10b981' }));

        setBadge.mockClear();
        module.parseStats(
            statsLine({ 'receiver-stats': { flowinstant: { stats: { quality: 60 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#f59e0b' }));

        setBadge.mockClear();
        module.parseStats(
            statsLine({ 'receiver-stats': { flowinstant: { stats: { quality: 30 } } } }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ color: '#ef4444' }));
    });

    it('emits a connections badge with the peer count', () => {
        const { module, setBadge } = makeModule();
        module.parseStats(
            statsLine({
                'receiver-stats': {
                    flowinstant: {
                        stats: { received: 1 },
                        peers: [
                            { id: 1, stats: { quality: 90 } },
                            { id: 2, stats: { quality: 90 } },
                        ],
                    },
                },
            }),
        );
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ icon: 'link', text: '2', color: '#10b981' }),
        );
    });

    it('ignores stats with no flowinstant payload', () => {
        const { module, setStatusData } = makeModule();
        module.parseStats(statsLine({ 'receiver-stats': {} }));
        expect(setStatusData).not.toHaveBeenCalled();
    });

    it('does not throw on malformed JSON', () => {
        const { module } = makeModule();
        expect(() => module.parseStats('garbage line with { incomplete json')).not.toThrow();
    });

    it('does not throw when the line contains no JSON at all', () => {
        const { module } = makeModule();
        expect(() => module.parseStats('plain log line — no braces')).not.toThrow();
    });
});
