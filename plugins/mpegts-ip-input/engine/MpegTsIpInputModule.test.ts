import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    formatBytes,
    bitrateBadge,
    interfaceAddress,
    GstPluginBase,
    ModuleInstance,
    PluginLoader,
} from '@media-router/engine';
import { sniffEncapsulation } from './detectEncapsulation.js';
import { MpegTsIpInputModule } from './MpegTsIpInputModule.js';

// The sniff binds a real UDP socket and waits — stub it so these tests only
// assert the options the module hands it (the socket itself is covered by
// detectEncapsulation.test.ts).
vi.mock('./detectEncapsulation.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./detectEncapsulation.js')>()),
    sniffEncapsulation: vi.fn(async () => 'rtp'),
}));

// NIC-name → IPv4 now comes from the engine (the plugin no longer carries its
// own copy) — stub it so the join address doesn't depend on this host's NICs.
vi.mock('@media-router/engine', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@media-router/engine')>()),
    interfaceAddress: vi.fn((name: string) => (name === 'eth0' ? '192.168.1.10' : '')),
}));

// `as any` reaches private fields/methods without re-declaring them in a typed
// intersection (TS collapses such intersections to `never` over privates).
function makeModule(opts: { udpPort?: number | null } = {}) {
    const module = new MpegTsIpInputModule() as any;
    const udpPort = opts.udpPort === undefined ? 41000 : opts.udpPort;
    const getBusChannel = vi.fn(() => (udpPort === null ? undefined : { port: udpPort }));
    module.services = {
        instanceId: 'mpegts-ip-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel },
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    module.setStatusData = vi.fn();
    module.setBadge = vi.fn();
    module.clearBadge = vi.fn();
    return { module, getBusChannel };
}

describe('MpegTsIpInputModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + warns when no UDP port is assigned', () => {
        const { module } = makeModule({ udpPort: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(module.log.warn).toHaveBeenCalledWith(expect.stringContaining('No UDP port'));
    });

    it('builds a raw unicast receive chain by default', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        // unicast: bare port, no multicast-group
        expect(desc!.pipeline).toContain('udpsrc name=netsrc port=5000');
        expect(desc!.pipeline).not.toContain('multicast-group');
        // raw TS caps on the network udpsrc, not RTP
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc [^!]*caps="video\/mpegts/);
        expect(desc!.pipeline).not.toContain('application/x-rtp');
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
        // No tsparse: it aggregates TS into >64KB buffers that the loopback
        // udpsink can't send (UDP datagram limit) and drops. Pure passthrough.
        expect(desc!.pipeline).not.toContain('tsparse');
        // udpsrc feeds the restamp, then a NON-leaky back-pressure queue: on a clean
        // loopback relay a leaky queue would shed TS packets on a sender burst →
        // continuity errors / macroblocking downstream. See buildBackpressureQueue.
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc[^!]*! mrtsrestamp [^!]*! queue leaky=0/);
        // rebroadcasts on the local bus at the assigned channel (fan-out tee)
        expect(desc!.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'mrlateness name=lat_busout_41000 reference=running-time ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc!.pipeline).not.toContain('udpsink');
        expect(desc!.restartOnError).toBe(true);
    });

    it('joins a multicast group with the chosen interface', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ address: '239.1.1.1', port: 5004, interface: 'eth0' });
        expect(desc!.pipeline).toContain('multicast-group=239.1.1.1');
        expect(desc!.pipeline).toContain('port=5004');
        expect(desc!.pipeline).toContain('multicast-iface=eth0');
        expect(desc!.pipeline).toContain('auto-multicast=true');
    });

    it('re-joins a MULTICAST group after 60 s of udp silence, never restarts a unicast listener', () => {
        const { module } = makeModule();
        expect(
            module.buildPipeline({ address: '239.1.1.1', port: 5004 })!.udpSilenceRestartMs,
        ).toBe(60_000);
        expect(module.buildPipeline({ address: '0.0.0.0', port: 5004 })!.udpSilenceRestartMs).toBe(
            0,
        );
    });

    it('inserts the RTP depay chain when encapsulation is rtp', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ encapsulation: 'rtp' });
        expect(desc!.pipeline).toContain('application/x-rtp');
        expect(desc!.pipeline).toContain('encoding-name=(string)MP2T');
        expect(desc!.pipeline).toContain('rtpjitterbuffer ! rtpmp2tdepay');
    });

    it('applies the jitterMs buffer to the leaky queue', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ jitterMs: 500 });
        // 500 ms → 500_000_000 ns
        expect(desc!.pipeline).toContain('max-size-time=500000000');
    });

    it('defaults to raw when encapsulation is auto and nothing was detected', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ encapsulation: 'auto' });
        expect(desc!.pipeline).toMatch(/udpsrc name=netsrc [^!]*caps="video\/mpegts/);
        expect(desc!.pipeline).not.toContain('application/x-rtp');
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
    });

    it('uses the sniffed encapsulation when on auto', () => {
        const { module } = makeModule();
        module.detectedEncap = 'rtp'; // simulate a completed sniff
        const desc = module.buildPipeline({ encapsulation: 'auto' });
        expect(desc!.pipeline).toContain('rtpmp2tdepay');
    });

    it('an explicit raw/rtp setting overrides any detection', () => {
        const { module } = makeModule();
        module.detectedEncap = 'rtp';
        const desc = module.buildPipeline({ encapsulation: 'raw' });
        expect(desc!.pipeline).not.toContain('rtpmp2tdepay');
    });
});

describe('MpegTsIpInputModule.pollStats', () => {
    beforeEach(() => vi.clearAllMocks());

    it('does nothing while the pipeline is not running', async () => {
        const { module } = makeModule();
        module.running = false;
        module.getThroughput = vi.fn();
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.getThroughput).not.toHaveBeenCalled();
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('registers the pad probe when no tracker exists yet, without setting stats', async () => {
        // The tracker is missing until the child pipeline reaches PLAYING (and
        // after a restart the fresh child starts empty) — pollStats must
        // (re)register lazily rather than one-shot in onStart, else stats stay
        // blank forever. Regression for the "live stats show —" bug.
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({});
        module.trackThroughput = vi.fn().mockResolvedValue(undefined);
        await module.pollStats();
        expect(module.trackThroughput).toHaveBeenCalledWith('netsrc', 'src');
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('shows a green "Connected" badge + bitrate/bytes in the popup when flowing', async () => {
        // Mirrors the SRT badge: the face shows a status word, the bitrate lives
        // in the Live Stats popup (not the badge).
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            netsrc: { total_bytes: 2048, bitrate_kbps: 2500, bitrate_mbps: 2.5 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.trackThroughput).not.toHaveBeenCalled();
        expect(module.setStatusData).toHaveBeenCalledWith('stats', {
            bitrate: '2.50',
            bytesReceived: formatBytes(2048),
        });
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Connected',
            color: '#10b981',
        });
        // Second face badge: the live bitrate (2.5 Mbps = 2500 kbps here).
        expect(module.setBadge).toHaveBeenCalledWith('bitrate', bitrateBadge(2500));
        expect(bitrateBadge(2500)).toEqual({
            icon: 'activity',
            text: '2.5 Mbps',
            color: '#10b981',
        });
    });

    it('shows grey "Waiting" and clears the bitrate badge when nothing has arrived', async () => {
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            netsrc: { total_bytes: 0, bitrate_kbps: 0, bitrate_mbps: 0 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Waiting',
            color: '#6b7280',
        });
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
    });

    it('shows amber "Stalled" and clears the bitrate badge when the feed dried up', async () => {
        const { module } = makeModule();
        module.running = true;
        module.getThroughput = vi.fn().mockResolvedValue({
            netsrc: { total_bytes: 4096, bitrate_kbps: 0, bitrate_mbps: 0 },
        });
        module.trackThroughput = vi.fn();
        await module.pollStats();
        expect(module.setBadge).toHaveBeenCalledWith('status', {
            icon: 'radio',
            text: 'Stalled',
            color: '#f59e0b',
        });
        expect(module.clearBadge).toHaveBeenCalledWith('bitrate');
    });
});

describe('MpegTsIpInputModule video-info probe', () => {
    beforeEach(() => vi.clearAllMocks());

    it('taps the egress tee with a leaky queue + appsink and requests tsProbe', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        // Leaky tap: a stalled probe branch must never stall the relay tee.
        expect(desc!.pipeline).toContain(
            'busout_41000. ! queue leaky=downstream max-size-buffers=64 ! appsink name=tsprobe',
        );
        expect(desc!.tsProbe).toEqual({ appsink: 'tsprobe' });
    });

    it('renders display + codec into the video status line', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', {
            pid: 0x65,
            codec: 'h264',
            width: 1920,
            height: 1080,
            interlaced: true,
            fps: 25,
            display: '1920×1080i50',
        });
        expect(module.setStatusData).toHaveBeenCalledWith('video', {
            video: '1920×1080i50 (h264)',
        });
    });

    it('codec-only payload (pre-SPS / mpeg2) shows just the codec', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', { pid: 0x65, codec: 'mpeg2', display: null });
        expect(module.setStatusData).toHaveBeenCalledWith('video', { video: 'mpeg2' });
    });

    it('scrambled stream is labeled as such', () => {
        const { module } = makeModule();
        module.onPluginEvent('tsprobe:videoinfo', {
            pid: 0x65,
            codec: 'h264',
            display: null,
            scrambled: true,
        });
        expect(module.setStatusData).toHaveBeenCalledWith('video', {
            video: 'h264 (scrambled)',
        });
    });

    it('ignores unrelated plugin-event channels', () => {
        const { module } = makeModule();
        module.onPluginEvent('stream:discovered', { pid: 0x65 });
        expect(module.setStatusData).not.toHaveBeenCalled();
    });
});

describe('MpegTsIpInputModule.detectEncapsulation', () => {
    beforeEach(() => vi.clearAllMocks());

    const sniffOpts = () => vi.mocked(sniffEncapsulation).mock.calls[0]![0];

    it('joins the group on the configured NIC — resolved by the engine helper', async () => {
        const { module } = makeModule();
        module.config = {
            encapsulation: 'auto',
            address: '239.1.1.1',
            port: 5004,
            interface: 'eth0',
        };
        await module.detectEncapsulation();
        expect(interfaceAddress).toHaveBeenCalledWith('eth0');
        expect(sniffOpts()).toMatchObject({
            port: 5004,
            multicastGroup: '239.1.1.1',
            ifaceAddr: '192.168.1.10',
        });
        expect(module.detectedEncap).toBe('rtp');
    });

    it('passes undefined — never the empty string — when the NIC has no external IPv4', async () => {
        const { module } = makeModule();
        // dgram's addMembership reads '' as an address and rejects it; the
        // engine helper returns '' for an unknown/IPv6-only/internal NIC.
        module.config = { encapsulation: 'auto', address: '239.1.1.1', interface: 'tun0' };
        await module.detectEncapsulation();
        expect(sniffOpts().ifaceAddr).toBeUndefined();
    });

    it('sniffs a unicast listen without a join', async () => {
        const { module } = makeModule();
        module.config = { encapsulation: 'auto', address: '0.0.0.0', interface: 'eth0' };
        await module.detectEncapsulation();
        expect(sniffOpts()).toMatchObject({ multicastGroup: undefined, ifaceAddr: undefined });
    });

    it('skips the sniff entirely when encapsulation is explicit', async () => {
        const { module } = makeModule();
        module.config = { encapsulation: 'rtp', address: '239.1.1.1' };
        await module.detectEncapsulation();
        expect(sniffEncapsulation).not.toHaveBeenCalled();
        expect(module.detectedEncap).toBeNull();
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
const BUS = ['queue', 'capssetter', 'capsfilter', 'mrlateness', 'tee'];
const TAP = ' busout_41000. ! queue leaky=downstream max-size-buffers=64 ! appsink name=tsprobe';

/** A playing module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new MpegTsIpInputModule() as any;
    module.services = {
        instanceId: 'mpegts-ip-in-1',
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

describe('MpegTsIpInputModule on the restamp (WI-P1-10)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('restamps right after the transport: udpsrc, or the RTP depayloader', () => {
        const { module } = makeModule();
        const raw = module.buildPipeline({});
        expect(raw.pipeline.endsWith(TAP)).toBe(true);
        expect(factories(raw.pipeline.slice(0, -TAP.length))).toEqual([
            'udpsrc',
            'mrtsrestamp',
            ...BUS,
        ]);
        const rtp = module.buildPipeline({ encapsulation: 'rtp' });
        expect(factories(rtp.pipeline.slice(0, -TAP.length))).toEqual([
            'udpsrc',
            'rtpjitterbuffer',
            'rtpmp2tdepay',
            'mrtsrestamp',
            ...BUS,
        ]);
        expect(rtp.pipeline).toContain(
            'rtpmp2tdepay ! mrtsrestamp name=restamp clock-mode=stc offset-ns=0 ! queue leaky=0',
        );
        for (const desc of [raw, rtp]) {
            expect(desc.busReports).toEqual([
                { element: 'restamp', structure: 'mrtsrestamp-stats' },
                { element: 'restamp', structure: 'mrtsrestamp-pid' },
                { element: 'restamp', structure: 'mrtsrestamp-event' },
            ]);
            expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
        }
    });

    it('starts the restamp on the configured offset and trims', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ ingestOffsetMs: 12.4, pidTrimsMs: { 256: 7, x: 9 } });
        expect(desc.pipeline).toContain(
            'mrtsrestamp name=restamp clock-mode=stc offset-ns=12400000 pid-trims="256=7000000" ! ',
        );
    });

    it('a live edit of O or a trim sets the restamp property, with no restart', async () => {
        const { module } = makeModule();
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('mpegts-ip-in-1', 'mpegts-ip-input', module, {});
        await instance.applyConfigUpdate({ pidTrimsMs: {} });
        await instance.applyConfigUpdate({ ingestOffsetMs: 40 });
        expect(setElementProperty.mock.calls).toEqual([
            ['restamp', 'pid-trims', ''],
            ['restamp', 'offset-ns', 40_000_000],
        ]);
        expect(instance.getState().pendingRestart).toBe(false);
        expect(module.buildPipeline(module.config).pipeline).toContain('offset-ns=40000000 ! ');
    });

    it('declares ingest timing: the loader adds O and the trims, and each is live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mpegts-ip-input-manifest-'));
        try {
            mkdirSync(join(dir, 'mpegts-ip-input'));
            copyFileSync(
                join(__dirname, '../package.json'),
                join(dir, 'mpegts-ip-input/package.json'),
            );
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['mpegts-ip-input'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toMatchObject({
                'x-widget': 'pidTrim',
                'x-optionsFrom': 'pids',
            });
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(expect.arrayContaining(['ingestOffsetMs', 'pidTrimsMs']));
            expect(new MpegTsIpInputModule().getLiveUpdatableParams()).toEqual(
                expect.arrayContaining(live),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("shows the restamp's card from start to stop and keeps the base's own sections", async () => {
        vi.useFakeTimers();
        // The base's start spawns a runner; nothing stands in for it here.
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockResolvedValue(undefined);
        const module = cardModule();
        module.config = { encapsulation: 'raw' };
        await module.onStart();
        module.upsertStatusSection({ id: 'playout', label: 'Playout', fields: [] });
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
        expect(state.statusData.clock).toMatchObject({ state: 'Locked', relocks: 0 });
        expect(state.fieldOptions.pids).toEqual([{ value: '256', label: '0x0100 H.264 video' }]);
        expect(sectionIds(module)).toEqual(['playout', 'clock', 'pid-256']);
        // The video probe's line is still this module's own.
        module.dispatchPluginEvent('tsprobe:videoinfo', { codec: 'h264', display: '1920×1080i50' });
        expect(module.getState().statusData.video).toEqual({ video: '1920×1080i50 (h264)' });

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

    it('logs the restamp events instead of reading them as the video probe', () => {
        const module = cardModule();
        module.setStatusData = vi.fn();
        module.dispatchPluginEvent(CH.event, { kind: 'gap', program: 1, pid: 256 });
        expect(module.log.info).toHaveBeenCalledWith(
            { 'mrtsrestamp-event': { kind: 'gap', program: 1, pid: 256 } },
            'mrtsrestamp-event gap',
        );
        expect(module.setStatusData).not.toHaveBeenCalled();
    });

    it('the degraded clock shows again once the input-silence warning that hid it clears', () => {
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
        // The base's own udpsrc-silence warning (its runner events) takes the text, and its clear
        // brings the clock's back while that still stands.
        module.ownWarning('silence', 'No packets for 5 s');
        report(module, { state: 'degraded', reason: 'freeze' });
        expect(module.error).toBe('No packets for 5 s');
        module.clearOwnWarning('silence');
        expect(module.error).toMatch(degraded);
        // The clock recovering clears its own text only.
        module.setHealth('warning', 'Waiting for upstream module(s): x');
        report(module);
        expect(module.error).toBe('Waiting for upstream module(s): x');
    });

    it('a fault outranks the clock warning; the PLAYING after it puts the warning back', () => {
        const module = cardModule();
        module.setHealth('error', 'udpsrc: bind failed');
        report(module, { state: 'degraded', reason: 'freeze' });
        expect([module.health, module.error]).toEqual(['error', 'udpsrc: bind failed']);
        module.health = 'ok'; // what the base's PLAYING sets before its hook
        module.error = undefined;
        module.onPipelinePlaying();
        expect(module.health).toBe('warning');
        expect(module.error).toMatch(/^Degraded clock: PCR frozen/);
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);
    });
});
