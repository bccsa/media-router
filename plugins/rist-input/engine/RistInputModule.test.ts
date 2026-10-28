import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    GstPluginBase,
    ModuleInstance,
    PluginLoader,
    REDACTED,
    buildIngestQueue,
    redactSecrets,
} from '@media-router/engine';
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
        // A downstream stall past the ingest queue's bound sheds there, counted (B-182).
        expect(desc.pipeline).toContain(` ! ${buildIngestQueue()} ! capssetter `);
        expect(buildIngestQueue()).toBe(
            'queue name=ingestq leaky=2 max-size-time=0 max-size-buffers=0 max-size-bytes=4000000 ' +
                'flush-on-eos=true',
        );
        expect(desc.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'mrlateness name=lat_busout_41000 reference=running-time ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc.pipeline).not.toContain('udpsink');
        expect(desc.rist).toBeUndefined();
        expect(desc.restartOnError).toBe(true);
        expect(desc.busReports).toEqual([
            { element: 'ristsrc', structure: 'mrrist-stats' },
            { element: 'ristsrc', structure: 'mrrist-peer' },
            { element: 'restamp', structure: 'mrtsrestamp-stats' },
            { element: 'restamp', structure: 'mrtsrestamp-pid' },
            { element: 'restamp', structure: 'mrtsrestamp-event' },
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

    it('logs the passphrase as <redacted>, the pipeline keeps it (B-109)', () => {
        const { module } = makeModule();
        // A test secret (unique, so the test output can be searched for it), with a space and quotes.
        module.config = { secret: 'zq109-rist-in-P2w8 "q" x', encryptionType: 256 };
        const pipeline: string = module.buildPipeline({})!.pipeline;
        const quoted = 'secret="zq109-rist-in-P2w8 \\"q\\" x"';
        expect(pipeline.includes(quoted)).toBe(true);
        const logged = redactSecrets(pipeline);
        expect(logged.includes('zq109')).toBe(false);
        expect(logged).toBe(pipeline.replace(quoted, `secret="${REDACTED}"`));
    });

    it("percent-encodes a link's cname: a space, comma or & leaves its URL whole (B-112)", () => {
        const { module } = makeModule();
        module.config = {
            links: [
                {
                    mode: 'listener',
                    address: '0.0.0.0',
                    port: 5004,
                    weight: 50,
                    cname: 'Studio A, cam 1',
                },
                { mode: 'caller', address: 'rist.example.net', port: 5006, cname: 'a&b=c #%41 é' },
            ],
        };
        const src: string = module.buildPipeline({})!.pipeline.split(' ! ')[0];
        expect(src).toContain(
            'urls="rist://@0.0.0.0:5004?weight=50&cname=Studio%20A%2C%20cam%201 ' +
                'rist://rist.example.net:5006?cname=a%26b%3Dc%20%23%2541%20%C3%A9"',
        );
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

// --- On the restamp (house-clock plan WI-P1-10) -----------------------------------------------

const MS = 1_000_000;
const CH = {
    stats: 'mrtsrestamp-stats:restamp',
    pid: 'mrtsrestamp-pid:restamp',
    event: 'mrtsrestamp-event:restamp',
};
/** The element's messages as the runner forwards them (plan ch. 5 part 10). */
const clockStats = (o: Record<string, unknown> = {}) => ({
    program: 1,
    state: 'locked',
    reason: 'none',
    ppb: 1234,
    'residual-p99-ns': 4 * MS,
    'pcr-interval-max-ns': 40 * MS,
    relocks: 0,
    'cadence-warning': false,
    'cc-lost': 0,
    'desync-bytes': 0,
    ...o,
});
const pidMsg = (pid: number, type: number) => ({
    program: 1,
    pid,
    'stream-type': type,
    'lead-min-ns': 300 * MS,
    'lead-median-ns': 340 * MS,
    'lead-max-ns': 420 * MS,
    'trim-ns': 0,
    'shift-ns': 0,
    'dropped-pes': 0,
});
const factories = (pipeline: string) => pipeline.split(' ! ').map((el) => el.split(' ')[0]);
/** Smoothing Cooldown as the loader injects it (b95s): minutes, 5 by default, live. */
const COOLDOWN_SCHEMA = {
    type: 'number',
    default: 5,
    minimum: 0,
    maximum: 60,
    'x-unit': 'min',
    'x-live': true,
    title: 'Smoothing Cooldown',
};
/** librist's receiver stats for one flow with one peer. */
const flowStats = (quality: number, missing = 0, received = 1000) => ({
    'receiver-stats': {
        flowinstant: {
            flow_id: 1,
            stats: { received, missing, quality, lost: 0 },
            peers: [{ id: 1, dead: 0, stats: { received_data: 80, avg_rtt: 14 } }],
        },
    },
});

/** A playing module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new RistInputModule() as any;
    module.services = {
        instanceId: 'rist-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = {};
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    module.health = 'ok';
    return module;
}
const sectionIds = (module: any) =>
    module.getState().dynamicStatusSections.map((s: { id: string }) => s.id);
function report(module: any, s: Record<string, unknown> = {}) {
    module.dispatchPluginEvent(CH.stats, clockStats(s));
    module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
    module.ingestTiming.tick();
}

describe('RistInputModule on the restamp (WI-P1-10)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('restamps right after mrristsrc, before the queue and the bus sink', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(factories(desc.pipeline)).toEqual([
            'mrristsrc',
            'mrtsrestamp',
            'queue',
            'capssetter',
            'capsfilter',
            'mrlateness',
            'tee',
        ]);
        expect(desc.pipeline).toContain(
            ' ! mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=300000000000 ' +
                'offset-ns=0 ! queue name=ingestq leaky=2 ',
        );
    });

    it('starts the restamp on the configured offset, trims and smoothing cooldown', () => {
        const { module } = makeModule();
        module.config = {
            ingestOffsetMs: 1500,
            pidTrimsMs: { 4097: 2500, 256: 0 },
            smoothingCooldownMin: 2,
        };
        // Clamped to ±2 s; a zero trim is no trim.
        expect(module.buildPipeline({})!.pipeline).toContain(
            'mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=120000000000 ' +
                'offset-ns=1500000000 pid-trims="4097=2000000000" ! queue',
        );
    });

    it('a live edit of O, a trim or the cooldown sets the restamp property, with no restart', async () => {
        const { module } = makeModule();
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('rist-in-1', 'rist-input', module, {});
        await instance.applyConfigUpdate({
            ingestOffsetMs: -300,
            pidTrimsMs: { 257: 120 },
            smoothingCooldownMin: 30,
        });
        expect(setElementProperty.mock.calls).toEqual([
            ['restamp', 'offset-ns', -300_000_000],
            ['restamp', 'pid-trims', '257=120000000'],
            ['restamp', 'smoothing-cooldown-ns', 1_800_000_000_000],
        ]);
        expect(instance.getState().pendingRestart).toBe(false);
        expect(module.buildPipeline({})!.pipeline).toContain(
            'smoothing-cooldown-ns=1800000000000 offset-ns=-300000000 pid-trims="257=120000000"',
        );
    });

    it('declares ingest timing: the loader adds O, the trims and the cooldown, each live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'rist-input-manifest-'));
        try {
            mkdirSync(join(dir, 'rist-input'));
            copyFileSync(join(__dirname, '../package.json'), join(dir, 'rist-input/package.json'));
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['rist-input'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toMatchObject({
                'x-widget': 'pidTrim',
                'x-optionsFrom': 'pids',
            });
            expect(props.smoothingCooldownMin).toMatchObject(COOLDOWN_SCHEMA);
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(
                expect.arrayContaining(['ingestOffsetMs', 'pidTrimsMs', 'smoothingCooldownMin']),
            );
            expect(new RistInputModule().getLiveUpdatableParams()).toEqual(
                expect.arrayContaining(live),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("shows the restamp's card from start to stop, beside the peer sections", async () => {
        vi.useFakeTimers();
        // The base's start spawns a runner; nothing stands in for it here.
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockResolvedValue(undefined);
        const module = cardModule();
        await module.onStart();
        module.dispatchPluginEvent(CH.stats, clockStats());
        module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
        vi.advanceTimersByTime(2000); // the reporter's tick
        const state = module.getState();
        expect(state.badges).toContainEqual({
            id: 'clock',
            icon: 'clock',
            text: 'Locked',
            color: '#10b981',
        });
        expect(state.statusData.clock).toMatchObject({ state: 'Locked', residualP99: 4 });
        expect(state.fieldOptions.pids).toEqual([{ value: '256', label: '0x0100 H.264 video' }]);
        expect(sectionIds(module)).toEqual(['clock', 'pid-256']);

        // librist's peers are reconciled every stats window; the clock's sections stay.
        module.dispatchPluginEvent('mrrist-stats:ristsrc', { json: JSON.stringify(flowStats(99)) });
        expect(sectionIds(module)).toEqual(['peer-1', 'clock', 'pid-256']);
        report(module, { state: 'acquiring' });
        expect(sectionIds(module)).toEqual(['peer-1', 'clock', 'pid-256']);
        expect(module.getState().statusData['peer-1']).toBeDefined();

        // Every program stopped reporting (its PIDs report on): the badge is withdrawn.
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(2000);
            module.dispatchPluginEvent(CH.pid, pidMsg(256, 0x1b));
        }
        vi.advanceTimersByTime(2000);
        expect(module.getState().badges.map((b: { id: string }) => b.id)).not.toContain('clock');

        await module.onStop();
        module.dispatchPluginEvent(CH.stats, clockStats());
        vi.advanceTimersByTime(4000);
        expect(module.getState().badges).toEqual([]);
        expect(sectionIds(module)).toEqual([]);
    });

    it('logs the restamp events', () => {
        const module = cardModule();
        module.dispatchPluginEvent(CH.event, { kind: 'degraded', program: 1, pid: 256 });
        expect(module.log.warn).toHaveBeenCalledWith(
            { 'mrtsrestamp-event': { kind: 'degraded', program: 1, pid: 256 } },
            'mrtsrestamp-event degraded',
        );
    });

    it('the degraded clock and the link warning share the health text without losing either', () => {
        const module = cardModule();
        const degraded = /^Degraded clock: PCR frozen — timing from PID 0x0100/;
        module.dispatchPluginEvent(CH.event, { kind: 'degraded', program: 1, pid: 256 });
        report(module, { state: 'degraded', reason: 'freeze' });
        expect(module.health).toBe('warning');
        expect(module.error).toMatch(degraded);
        // A second condition replaces the clock's own text.
        const sparse = {
            'cadence-warning': true,
            'pcr-gap-max-ns': 700 * MS,
            'pcr-cadence-ns': 40 * MS,
        };
        report(module, { state: 'degraded', reason: 'freeze', ...sparse });
        expect(module.error).toMatch(
            /^Degraded clock: .*; PCR comes irregularly: gaps up to 700 ms, normally every 40 ms$/,
        );
        report(module, { state: 'degraded', reason: 'freeze' });
        expect(module.error).toMatch(degraded);

        // A recovered-loss storm takes the text; the clock recovering leaves it there.
        const storm = () => flowStats(80, 150, 850);
        for (let i = 0; i < 3; i++) module.onPluginEvent('rist:stats', storm());
        expect(module.error).toMatch(/^RIST link degraded/);
        report(module);
        expect(module.error).toMatch(/^RIST link degraded/);
        // The clock degrading again takes the text back (the last writer shows).
        report(module, { state: 'degraded', reason: 'freeze' });
        expect(module.error).toMatch(degraded);

        // The link clears after 5 clean windows, taking any text down: the clock's shows again.
        for (let i = 0; i < 5; i++) module.onPluginEvent('rist:stats', flowStats(100));
        expect(module.health).toBe('warning');
        expect(module.error).toMatch(degraded);
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);
    });

    it('a fault outranks the clock warning; the PLAYING after it puts the warning back', () => {
        const module = cardModule();
        module.setHealth('error', 'mrristsrc: cannot resolve host');
        report(module, { state: 'degraded', reason: 'freeze' });
        expect([module.health, module.error]).toEqual(['error', 'mrristsrc: cannot resolve host']);
        module.health = 'ok'; // what the base's PLAYING sets before its hook
        module.error = undefined;
        module.onPipelinePlaying();
        expect(module.health).toBe('warning');
        expect(module.error).toMatch(/^Degraded clock: PCR frozen/);
    });
});
