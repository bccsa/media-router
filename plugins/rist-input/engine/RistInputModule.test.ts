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
        expect(desc.busReports).toEqual([{ element: 'ristsrc', structure: 'mrrist-stats' }]);
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
                'receiver-stats': { flowinstant: { flow_id: 1, stats: { quality: 97, received: 10, recovered: 1, lost: 0 } } },
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
