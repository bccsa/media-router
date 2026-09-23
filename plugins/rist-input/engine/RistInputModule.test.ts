import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RistInputModule } from './RistInputModule.js';

function makeModule() {
    const module = new RistInputModule() as any;
    module.services = {
        instanceId: 'rist-in-1',
        mediaRouter: {
            assignBusChannel: vi.fn(() => ({ port: 41000 })),
            getBusChannel: vi.fn(() => ({ port: 41000 })),
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
    it('returns null when no bus port is assigned', () => {
        const { module } = makeModule();
        module.services.mediaRouter.getBusChannel = vi.fn(() => undefined);
        module.log = { warn: vi.fn() };
        expect(module.buildPipeline({})).toBeNull();
    });

    it('builds a native mrristsrc feeding the bus fan-out tee through a leaky queue', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toMatch(/^mrristsrc name=ristsrc /);
        expect(desc.pipeline).not.toContain('appsrc');
        // Downstream stall sheds here (bounded, leaky) — the old appsrc contract.
        expect(desc.pipeline).toContain('queue leaky=downstream max-size-bytes=4194304');
        expect(desc.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc.pipeline).not.toContain('udpsink');
        expect(desc.rist).toBeUndefined();
        expect(desc.restartOnError).toBe(true);
        expect(desc.busReports).toEqual([
            { element: 'ristsrc', structure: 'mrrist-stats' },
            { element: 'ristsrc', structure: 'mrrist-peer' },
        ]);
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
            sessionTimeout: 10000,
        };
        const desc = module.buildPipeline({})!;
        const src = desc.pipeline.split(' ! ')[0];
        expect(src).toContain(
            'urls="rist://@0.0.0.0:5004?weight=50&cname=link1 rist://10.0.0.9:5006?weight=10&cname=link2"',
        );
        expect(src).toContain(' profile=1 ');
        expect(src).toContain(' buffer=800 ');
        expect(src).toContain(' session-timeout=10000 ');
        expect(src).toContain(' secret="s3cret" ');
        expect(src).toContain(' aes-type=128 ');
        expect(src).toContain(' stats-interval=500');
    });

    it('omits session-timeout when unset/zero (librist default applies)', () => {
        const { module } = makeModule();
        module.config = { sessionTimeout: 0 };
        expect(module.buildPipeline({})!.pipeline).not.toContain('session-timeout=');
    });

    it('defaults to a single listener link on :5004', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain('urls="rist://@0.0.0.0:5004?weight=50&cname=link1"');
    });

    it("renders stats from the element's mrrist-stats bus message", () => {
        const { module, setStatusData } = makeModule();
        module.onPluginEvent('mrrist-stats:ristsrc', {
            json: JSON.stringify({
                'receiver-stats': {
                    flowinstant: {
                        flow_id: 1,
                        stats: { quality: 97, received: 10, recovered: 1, lost: 0 },
                    },
                },
            }),
        });
        expect(setStatusData).toHaveBeenCalled();
        setStatusData.mockClear();
        module.onPluginEvent('mrrist-stats:ristsrc', { json: 'nope' });
        expect(setStatusData).not.toHaveBeenCalled();
    });
});

describe('RistInputModule rist:stats rendering', () => {
    beforeEach(() => vi.clearAllMocks());

    function stats(module: any, json: unknown): void {
        module.onPluginEvent('rist:stats', json);
    }

    it('updates flow-level stats (incl. quality for the face widgets) from flowinstant.stats', () => {
        const { module, setStatusData } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: {
                    flow_id: 1,
                    stats: {
                        received: 100,
                        dropped_late: 1,
                        recovered_total: 2,
                        lost: 3,
                        quality: 95,
                    },
                },
            },
        });
        expect(setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({
                received: 100,
                dropped: 1,
                recovered: 2,
                lost: 3,
                quality: 95,
                rtt: '—',
            }),
        );
    });

    it('sums flow counters across fresh flows and shows the worst quality', () => {
        const { module, setStatusData, setBadge } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: { flow_id: 1, stats: { received: 100, quality: 99 } },
            },
        });
        stats(module, {
            'receiver-stats': { flowinstant: { flow_id: 2, stats: { received: 50, quality: 80 } } },
        });
        expect(setStatusData).toHaveBeenLastCalledWith(
            'stats',
            expect.objectContaining({ received: 150, quality: 80 }),
        );
        expect(setBadge).toHaveBeenCalledWith('quality', expect.objectContaining({ text: '80%' }));
    });

    // librist's receiver JSON per peer: {id, dead, stats:{received_data,
    // received_rtcp, sent_rtcp, rtt, avg_rtt, bitrate, avg_bitrate}} — no
    // cname, no quality.
    const peer = (id: number, extra: Record<string, unknown> = {}, dead = 0) => ({
        id,
        dead,
        stats: {
            received_data: 80,
            received_rtcp: 4,
            sent_rtcp: 5,
            bitrate: 2_500_000,
            avg_rtt: 14.5,
            ...extra,
        },
    });

    it('emits a per-peer dynamic section keyed by peer.id with the real receiver counters', () => {
        const { module, setStatusData } = makeModule();
        stats(module, {
            'receiver-stats': {
                flowinstant: {
                    stats: { received: 100 },
                    peers: [peer(1), peer(2, { avg_rtt: 95 })],
                },
            },
        });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual([
            'peer-1',
            'peer-2',
        ]);
        expect(module.dynamicStatusSections.map((s: { label: string }) => s.label)).toEqual([
            'Peer 1',
            'Peer 2',
        ]);
        expect(setStatusData).toHaveBeenCalledWith(
            'peer-1',
            expect.objectContaining({
                bitrate: '2.5 Mbps',
                received: 80,
                rtcpIn: 4,
                rtcpOut: 5,
                rtt: '14.50',
            }),
        );
    });

    it('does not duplicate the dynamic section if the same peer appears again', () => {
        const { module } = makeModule();
        const payload = {
            'receiver-stats': { flowinstant: { stats: { received: 10 }, peers: [peer(1)] } },
        };
        stats(module, payload);
        stats(module, payload);
        expect(
            module.dynamicStatusSections.filter((s: { id: string }) => s.id === 'peer-1'),
        ).toHaveLength(1);
    });

    it('prunes the section and data of a peer that left the flow (no ghost links)', () => {
        const { module } = makeModule();
        module.setStatusData = (id: string, data: unknown) => {
            module.statusData[id] = data;
        };
        stats(module, {
            'receiver-stats': { flowinstant: { stats: {}, peers: [peer(1), peer(2)] } },
        });
        expect(Object.keys(module.statusData)).toEqual(
            expect.arrayContaining(['peer-1', 'peer-2']),
        );
        // Peer 1 reconnected → librist hands out a new id; peer 2 timed out.
        stats(module, { 'receiver-stats': { flowinstant: { stats: {}, peers: [peer(3)] } } });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-3']);
        expect(module.statusData['peer-1']).toBeUndefined();
        expect(module.statusData['peer-2']).toBeUndefined();
        expect(module.statusData['peer-3']).toBeDefined();
    });

    it('unions live peers across flows instead of thrashing between per-flow messages', () => {
        const { module, setBadge } = makeModule();
        module.config = {
            links: [
                { mode: 'listener', port: 1 },
                { mode: 'listener', port: 2 },
                { mode: 'listener', port: 3 },
            ],
        };
        stats(module, {
            'receiver-stats': {
                flowinstant: { flow_id: 11, stats: {}, peers: [peer(1), peer(2)] },
            },
        });
        stats(module, {
            'receiver-stats': { flowinstant: { flow_id: 22, stats: {}, peers: [peer(7)] } },
        });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id).sort()).toEqual([
            'peer-1',
            'peer-2',
            'peer-7',
        ]);
        expect(setBadge).toHaveBeenLastCalledWith(
            'connections',
            expect.objectContaining({ text: '3/3' }),
        );

        // Session timeout farewell (dead=2) drops that flow's peers at once.
        stats(module, {
            'receiver-stats': {
                flowinstant: { flow_id: 22, dead: 2, stats: {}, peers: [peer(7)] },
            },
        });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id).sort()).toEqual([
            'peer-1',
            'peer-2',
        ]);
        expect(setBadge).toHaveBeenLastCalledWith(
            'connections',
            expect.objectContaining({ text: '2/3' }),
        );
    });

    it('drops a flow that stopped reporting after three missed stats windows', () => {
        vi.useFakeTimers();
        try {
            const { module } = makeModule();
            stats(module, {
                'receiver-stats': { flowinstant: { flow_id: 11, stats: {}, peers: [peer(1)] } },
            });
            stats(module, {
                'receiver-stats': { flowinstant: { flow_id: 22, stats: {}, peers: [peer(7)] } },
            });
            vi.advanceTimersByTime(3500);
            stats(module, {
                'receiver-stats': { flowinstant: { flow_id: 22, stats: {}, peers: [peer(7)] } },
            });
            expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual([
                'peer-7',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("labels a peer row with the remote cname the element lifted from librist's log", () => {
        const { module } = makeModule();
        module.onPluginEvent('mrrist-peer:ristsrc', { id: 5, cname: 'orange' });
        stats(module, {
            'receiver-stats': { flowinstant: { flow_id: 1, stats: {}, peers: [peer(5), peer(6)] } },
        });
        expect(module.dynamicStatusSections.map((s: { label: string }) => s.label)).toEqual([
            'orange',
            'Peer 6',
        ]);
        // A name arriving after the row exists re-labels it in place.
        module.onPluginEvent('mrrist-peer:ristsrc', { id: 6, cname: 'camtel' });
        expect(module.dynamicStatusSections.map((s: { label: string }) => s.label)).toEqual([
            'orange',
            'camtel',
        ]);
        module.onPluginEvent('mrrist-peer:ristsrc', { id: 'x', cname: '' });
        expect(module.dynamicStatusSections.map((s: { label: string }) => s.label)).toEqual([
            'orange',
            'camtel',
        ]);
    });

    it('does not count or render peers librist flags dead', () => {
        const { module, setBadge, setStatusData } = makeModule();
        module.config = {
            links: [
                { mode: 'caller', address: 'a', port: 1 },
                { mode: 'caller', address: 'b', port: 2 },
            ],
        };
        stats(module, {
            'receiver-stats': { flowinstant: { stats: {}, peers: [peer(1), peer(2, {}, 1)] } },
        });
        expect(module.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual(['peer-1']);
        expect(setStatusData).not.toHaveBeenCalledWith('peer-2', expect.anything());
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ text: '1/2', color: '#f59e0b' }),
        );
    });

    it('colours the quality badge green/amber/red by threshold', () => {
        // Quality is read from flow.stats.quality, not per-peer
        const { module, setBadge } = makeModule();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 95 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#10b981' }),
        );

        setBadge.mockClear();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 60 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#f59e0b' }),
        );

        setBadge.mockClear();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { quality: 30 } } } });
        expect(setBadge).toHaveBeenCalledWith(
            'quality',
            expect.objectContaining({ color: '#ef4444' }),
        );
    });

    it('emits a connections badge as live peers over configured links', () => {
        const { module, setBadge } = makeModule();
        module.config = {
            links: [
                { mode: 'listener', port: 1 },
                { mode: 'listener', port: 2 },
            ],
        };
        stats(module, {
            'receiver-stats': {
                flowinstant: { stats: { received: 1 }, peers: [peer(1), peer(2)] },
            },
        });
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ icon: 'link', text: '2/2', color: '#10b981' }),
        );

        setBadge.mockClear();
        stats(module, { 'receiver-stats': { flowinstant: { stats: { received: 0 }, peers: [] } } });
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ text: '0/2', color: '#6b7280' }),
        );

        // More senders than links (or a lingering old flow) is not "all good" either.
        setBadge.mockClear();
        stats(module, {
            'receiver-stats': { flowinstant: { stats: {}, peers: [peer(1), peer(2), peer(3)] } },
        });
        expect(setBadge).toHaveBeenCalledWith(
            'connections',
            expect.objectContaining({ text: '3/2', color: '#f59e0b' }),
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

describe('RistInputModule link health (recovered-loss storms)', () => {
    beforeEach(() => vi.clearAllMocks());

    function storm(quality: number, missing = 150, received = 850) {
        return {
            'receiver-stats': {
                flowinstant: {
                    stats: { received, missing, quality, lost: 0 },
                    peers: [{ id: 1, stats: { avg_rtt: 210.4 } }],
                },
            },
        };
    }

    function makeHealthModule() {
        const { module, ...rest } = makeModule();
        module.setHealth = vi.fn();
        return { module, setHealth: module.setHealth as ReturnType<typeof vi.fn>, ...rest };
    }

    it('renders the recovered-loss rate in the flow stats', () => {
        const { module, setStatusData } = makeHealthModule();
        module.onPluginEvent('rist:stats', storm(85, 150, 850));
        expect(setStatusData).toHaveBeenCalledWith(
            'stats',
            expect.objectContaining({ loss: '15.0', rtt: '210.40' }),
        );
    });

    it('warns only after 3 consecutive low-quality windows', () => {
        const { module, setHealth } = makeHealthModule();
        module.onPluginEvent('rist:stats', storm(80));
        module.onPluginEvent('rist:stats', storm(80));
        expect(setHealth).not.toHaveBeenCalled();
        module.onPluginEvent('rist:stats', storm(80));
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('recovering 15% packet loss'),
        );
    });

    it('a single good window resets the warn streak (no flapping into warning)', () => {
        const { module, setHealth } = makeHealthModule();
        module.onPluginEvent('rist:stats', storm(80));
        module.onPluginEvent('rist:stats', storm(80));
        module.onPluginEvent('rist:stats', storm(100, 0));
        module.onPluginEvent('rist:stats', storm(80));
        module.onPluginEvent('rist:stats', storm(80));
        expect(setHealth).not.toHaveBeenCalled();
    });

    it('clears its own warning only after 5 consecutive clean windows', () => {
        const { module, setHealth } = makeHealthModule();
        for (let i = 0; i < 3; i++) module.onPluginEvent('rist:stats', storm(80));
        module.health = 'warning';
        for (let i = 0; i < 4; i++) module.onPluginEvent('rist:stats', storm(100, 0));
        expect(setHealth).not.toHaveBeenCalledWith('ok');
        module.onPluginEvent('rist:stats', storm(100, 0));
        expect(setHealth).toHaveBeenLastCalledWith('ok');
    });

    it('never clears a warning it does not own', () => {
        const { module, setHealth } = makeHealthModule();
        module.health = 'warning'; // someone else's warning, linkWarnActive false
        for (let i = 0; i < 6; i++) module.onPluginEvent('rist:stats', storm(100, 0));
        expect(setHealth).not.toHaveBeenCalled();
    });

    it('mid-band quality (85–95) keeps an active warning latched', () => {
        const { module, setHealth } = makeHealthModule();
        for (let i = 0; i < 3; i++) module.onPluginEvent('rist:stats', storm(80));
        module.health = 'warning';
        setHealth.mockClear();
        for (let i = 0; i < 10; i++) module.onPluginEvent('rist:stats', storm(90, 50, 950));
        expect(setHealth).not.toHaveBeenCalledWith('ok');
    });
});
