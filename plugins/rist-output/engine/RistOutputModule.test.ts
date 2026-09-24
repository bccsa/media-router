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

    it('reads its per-consumer edge socket and drains into the native mrristsink', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-41000-abc123.sock');
        // The queue between unixfdsrc and the sink is buildBusSrc's drain
        // contract — presence matters here, its tuning is the builder's test.
        expect(desc.pipeline).toMatch(/unixfdsrc[^!]+! queue /);
        expect(desc.pipeline).toContain('mrristsink name=ristsink');
        expect(desc.pipeline).not.toContain('appsink');
        expect(desc.pipeline).not.toContain('udpsrc');
        expect(desc.rist).toBeUndefined();
        expect(desc.restartOnError).toBe(true);
        // Stats come back as `mrrist-stats` bus messages from the element.
        expect(desc.busReports).toEqual([{ element: 'ristsink', structure: 'mrrist-stats' }]);
    });

    it('carries the librist sender config with per-link rist:// URLs', () => {
        const { module } = makeModule();
        module.config = {
            links: [
                {
                    mode: 'caller',
                    address: 'rist.example.net',
                    port: 5004,
                    weight: 5,
                    cname: 'tx1',
                },
            ],
            profile: 1,
            buffer: 1200,
            secret: 'hush',
            encryptionType: 256,
            nullPacketDeletion: true,
            statsInterval: 1000,
        };
        const desc = module.buildPipeline({})!;
        const sink = desc.pipeline.split(' ! ').pop()!;
        expect(sink).toContain('urls="rist://rist.example.net:5004?weight=5&cname=tx1"');
        expect(sink).toContain(' profile=1 ');
        expect(sink).toContain(' buffer=1200 ');
        expect(sink).toContain(' secret="hush" ');
        expect(sink).toContain(' aes-type=256 ');
        expect(sink).toContain(' npd=true ');
        expect(sink).toMatch(/ stats-interval=1000$/);
    });

    it('omits secret and aes-type when encryption is off', () => {
        const { module } = makeModule();
        module.config = { secret: '', encryptionType: 0 };
        const sink = module.buildPipeline({})!.pipeline.split(' ! ').pop()!;
        expect(sink).not.toContain('secret=');
        expect(sink).not.toContain('aes-type=');
    });

    it('quotes a passphrase with spaces and quotes for the pipeline parser', () => {
        const { module } = makeModule();
        module.config = { secret: 'say "hi" there', encryptionType: 128 };
        const sink = module.buildPipeline({})!.pipeline.split(' ! ').pop()!;
        expect(sink).toContain('secret="say \\"hi\\" there"');
    });

    it("renders stats from the element's mrrist-stats bus message", () => {
        const { module, setStatusData } = makeModule();
        module.onPluginEvent('mrrist-stats:ristsink', {
            json: JSON.stringify({
                'sender-stats': {
                    peer: {
                        id: 1,
                        cname: 'tx1',
                        stats: {
                            quality: 99,
                            sent: 5,
                            retransmitted: 0,
                            bandwidth: 1000,
                            avg_rtt: 1.5,
                        },
                    },
                },
            }),
        });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ quality: 99, sent: 5 }),
        );
        setStatusData.mockClear();
        module.onPluginEvent('mrrist-stats:ristsink', { json: '{not json' });
        module.onPluginEvent('mrrist-stats:other', { json: '{}' });
        expect(setStatusData).not.toHaveBeenCalled();
    });

    it('defaults to a single caller link on :5004', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('urls="rist://localhost:5004?weight=50&cname=link1"');
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
                        received: 8,
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
            expect.objectContaining({
                quality: 95,
                sent: 1000,
                retransmitted: 5,
                bandwidth: '4.5 Mbps',
                rtt: '12.30',
            }),
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

    it('keeps a sub-kbps trickle visible in bps', () => {
        const { module, setStatusData } = makeModule();
        // bits/s are handed to the formatter unrounded, so 400 bps reads as
        // "400 bps" instead of collapsing to "0 kbps" (issue #680).
        stats(module, {
            'sender-stats': { peer: { id: 1, stats: { quality: 40, bandwidth: 400 } } },
        });
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ bandwidth: '400 bps' }),
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
        expect(
            module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1'),
        ).toHaveLength(1);
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
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 95, received: 9 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#10b981' }),
        );

        setBadge.mockClear();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 60, received: 9 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#f59e0b' }),
        );

        setBadge.mockClear();
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 30, received: 9 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#ef4444' }),
        );
    });

    it('emits a connections badge as answered peers over configured links', () => {
        const { module, setBadge } = makeModule();
        module.config = {
            links: [
                { mode: 'caller', address: 'a', port: 1 },
                { mode: 'caller', address: 'b', port: 2 },
            ],
        };
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 90, received: 9 } } } });
        expect(setBadge).toHaveBeenLastCalledWith(
            'connections',
            expect.objectContaining({ text: '1/2', color: '#f59e0b' }),
        );
        stats(module, { 'sender-stats': { peer: { id: 1, stats: { quality: 90, received: 9 } } } });
        stats(module, { 'sender-stats': { peer: { id: 2, stats: { quality: 90, received: 9 } } } });
        // Last call should reflect 2 active peers
        const lastConnectionsCall = setBadge.mock.calls.filter((c) => c[0] === 'connections').pop();
        expect(lastConnectionsCall![1]).toMatchObject({ text: '2/2', color: '#10b981' });
    });

    it('does not count a caller nobody answers (#679)', () => {
        // librist never marks a never-answered caller dead, so it keeps
        // reporting it with quality 100 and received 0 every interval.
        const { module, setBadge, setStatusData } = makeModule();
        module.config = { links: [{ mode: 'caller', address: 'a', port: 1 }] };
        stats(module, {
            'sender-stats': {
                peer: { id: 1, stats: { quality: 100, sent: 500, received: 0, avg_rtt: 0 } },
            },
        });
        expect(module.peerLastSeen.has(1)).toBe(true);
        expect(module.peerLastAnswered.has(1)).toBe(false);
        expect(setBadge).toHaveBeenLastCalledWith(
            'connections',
            expect.objectContaining({ text: '0/1', color: '#6b7280' }),
        );
        expect(setBadge).not.toHaveBeenCalledWith('quality', expect.anything());
        // The per-link row still exists (packets are going out) but shows no RTT.
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-1']);
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({ sent: 500, rtt: '—' }),
        );
    });

    it('counts the peer once RTCP comes back and drops it when it stops', () => {
        vi.useFakeTimers();
        try {
            const { module, setBadge, clearBadge } = makeModule();
            module.config = { links: [{ mode: 'caller', address: 'a', port: 1 }] };
            stats(module, {
                'sender-stats': { peer: { id: 1, stats: { quality: 100, received: 0 } } },
            });
            stats(module, {
                'sender-stats': {
                    peer: { id: 1, stats: { quality: 98, received: 10, avg_rtt: 4 } },
                },
            });
            expect(setBadge).toHaveBeenLastCalledWith(
                'connections',
                expect.objectContaining({ text: '1/1', color: '#10b981' }),
            );
            expect(setBadge).toHaveBeenCalledWith(
                'quality',
                expect.objectContaining({ text: '98%' }),
            );
            // Remote goes away but librist keeps emitting records for the peer.
            vi.advanceTimersByTime(3500);
            stats(module, {
                'sender-stats': { peer: { id: 1, stats: { quality: 100, received: 0 } } },
            });
            expect(module.peerLastAnswered.has(1)).toBe(false);
            expect(setBadge).toHaveBeenLastCalledWith(
                'connections',
                expect.objectContaining({ text: '0/1' }),
            );
            expect(clearBadge).toHaveBeenCalledWith('quality');
        } finally {
            vi.useRealTimers();
        }
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
        module.peerLastAnswered.set(1, Date.now() - 5000);
        module.peerLastAnswered.set(2, Date.now() - 1000);
        module.dynamicStatusSections = [
            { id: 'peer-1', label: 'a', fields: [] },
            { id: 'peer-2', label: 'b', fields: [] },
        ];
        module.statusData = { 'peer-1': { sent: 1 }, 'peer-2': { sent: 2 } };
        module.cleanupStalePeers();
        expect(module.peerLastSeen.has(1)).toBe(false);
        expect(module.peerLastSeen.has(2)).toBe(true);
        expect(module.peerLastAnswered.has(1)).toBe(false);
        expect(module.peerLastAnswered.has(2)).toBe(true);
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-2']);
        // Data goes with the section — it used to leak one entry per peer id.
        expect(Object.keys(module.statusData)).toEqual(['peer-2']);
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ text: '1/1' }),
        );
    });

    it('clears the quality badge once the last peer is dropped', () => {
        const { module, clearBadge } = makeModule();
        module.peerLastSeen.set(1, Date.now() - 5000);
        module.peerLastAnswered.set(1, Date.now() - 5000);
        module.cleanupStalePeers();
        expect(module.peerLastSeen.size).toBe(0);
        expect(module.peerLastAnswered.size).toBe(0);
        expect(clearBadge).toHaveBeenCalledWith('quality');
    });

    it('scales the stale window with statsInterval (3 records, never under 3 s)', () => {
        const { module } = makeModule();
        module.config = { statsInterval: 5000 };
        module.peerLastSeen.set(1, Date.now() - 12_000);
        module.peerLastAnswered.set(1, Date.now() - 12_000);
        module.cleanupStalePeers();
        expect(module.peerLastAnswered.has(1)).toBe(true);
        module.peerLastSeen.set(1, Date.now() - 16_000);
        module.peerLastAnswered.set(1, Date.now() - 16_000);
        module.cleanupStalePeers();
        expect(module.peerLastAnswered.has(1)).toBe(false);
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
