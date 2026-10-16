import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstPluginBase, ModuleInstance, PluginLoader } from '@media-router/engine';
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

    it('declares the multicast re-join bound for udp silence, none for unicast', () => {
        const module = makeModule();
        expect(
            module.buildPipeline({ address: '239.69.0.1', port: 5004 })!.udpSilenceRestartMs,
        ).toBe(60_000);
        expect(
            module.buildPipeline({ address: '10.9.16.5', port: 5004 })!.udpSilenceRestartMs,
        ).toBe(0);
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

    it('never re-times on arrival — the jitterbuffer PTS are the labels', () => {
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

// --- On house time (house-clock plan WI-P1-11) ------------------------------------------------

const MS = 1_000_000;
const GM = '00-1D-C1-FF-FE-50-30-EE';
const CH = { asrc: 'mrasrc-stats:asrc', pid: 'mrtsrestamp-pid:restamp' };
/** The elements' messages as the runner forwards them (plan ch. 5 part 10, WI-P1-8). */
const asrcStats = (o: Record<string, unknown> = {}) => ({
    state: 'locked',
    'ratio-ppb': -4_560,
    'phase-err-ns': 0.6 * MS,
    relocks: 0,
    'in-frames': 96_000,
    'out-frames': 96_000,
    'discont-in': 0,
    'dropped-frames': 0,
    ...o,
});
/** The stream's one 302M PID, moved by O alone. */
const pidMsg = (shiftMs: number) => ({
    program: 1,
    pid: 65,
    'stream-type': 6,
    'lead-min-ns': -21 * MS,
    'lead-median-ns': -20 * MS,
    'lead-max-ns': -18 * MS,
    'trim-ns': 0,
    'shift-ns': shiftMs * MS,
    'dropped-pes': 0,
});
const factories = (pipeline: string) => pipeline.split(' ! ').map((el) => el.split(' ')[0]);
const OFF = "Device clock off by 250 ppm — check the device's sample rate";
const DOWNMIX = '8-channel stream downmixed to stereo on the 302M bus';

/** A module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new Aes67InputModule() as any;
    module.services = {
        instanceId: 'aes67-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = { address: '239.69.0.1', ptpSync: true, ptpGmid: GM };
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    module.health = 'ok';
    module.startSapListener = vi.fn(); // no sidecar
    return module;
}
/** One report interval of the ASRC and the restamp, then the reporter's tick. */
function report(module: any, asrc: Record<string, unknown> = {}) {
    module.dispatchPluginEvent(CH.asrc, asrcStats(asrc));
    module.dispatchPluginEvent(CH.pid, pidMsg(250));
    module.ingestTiming.tick();
}
/** The sender's clock 250 ppm off for the minute part 10's warning waits. */
function offForAMinute(module: any) {
    report(module, { 'ratio-ppb': 250_000 });
    vi.advanceTimersByTime(61_000);
    report(module, { 'ratio-ppb': 250_000 });
}

describe('Aes67InputModule on house time (WI-P1-11)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        aes67Discovery.clear('aes67-in-1');
    });

    it('resamples once, in mrasrc after the depayloader, and restamps after the mux', () => {
        const module = makeModule();
        const desc = module.buildPipeline({ address: '239.69.0.1', port: 5004 });
        expect(factories(desc!.pipeline)).toEqual([
            'udpsrc',
            'rtpjitterbuffer',
            'rtpL24depay',
            'audio/x-raw,rate=48000',
            'audioconvert',
            'mrasrc',
            'audio/x-raw,format=S16LE,rate=48000,channels=2',
            'avenc_s302m',
            'mpegtsmux',
            'mrtsrestamp',
            'capssetter',
            'capsfilter',
            'mrlateness',
            'tee',
        ]);
        // One resample per path (§13.1).
        expect(desc!.pipeline).not.toContain('audioresample');
        expect(desc!.pipeline).toContain(
            ' ! rtpL24depay ! audio/x-raw,rate=48000 ! audioconvert ! mrasrc name=asrc' +
                ' ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! avenc_s302m strict=experimental' +
                ' ! mpegtsmux latency=0 alignment=7' +
                ' ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0 ! capssetter ',
        );
        expect(desc!.houseTimelineEgress).toBe(true);
        expect(desc!.busReports).toEqual([
            { element: 'restamp', structure: 'mrtsrestamp-stats' },
            { element: 'restamp', structure: 'mrtsrestamp-pid' },
            { element: 'restamp', structure: 'mrtsrestamp-event' },
            { element: 'asrc', structure: 'mrasrc-stats' },
            { element: 'asrc', structure: 'mrasrc-event' },
        ]);
    });

    it('keeps the jitterbuffer as it was: its PTS are what the ASRC locks to (§5.4)', () => {
        const module = makeModule();
        expect(module.buildPipeline({ address: '239.69.0.1' })!.pipeline).toContain(
            'rtpjitterbuffer name=jbuf latency=20 ! rtpL24depay ! ',
        );
        const ptp: string = module.buildPipeline({
            address: '239.69.0.1',
            ptpSync: true,
            ptpGmid: GM,
            encoding: 'L16',
            pcmBitDepth: 24,
        })!.pipeline;
        expect(ptp).toContain(
            'rtpjitterbuffer name=jbuf latency=20 rfc7273-sync=true add-reference-timestamp-meta=true' +
                ' ! rtpL16depay ! audio/x-raw,rate=48000 ! audioconvert ! mrasrc name=asrc' +
                ' ! audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m',
        );
    });

    it('starts the restamp on the configured Ingest Offset, with no per-PID trims', () => {
        const module = makeModule();
        const p: string = module.buildPipeline({
            address: '239.69.0.1',
            ingestOffsetMs: 250,
            pidTrimsMs: { 65: -40 },
        })!.pipeline;
        expect(p).toContain(' ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=250000000 ! ');
        // One PID, where O is the trim (OQ-15).
        expect(p).not.toContain('pid-trims');
    });

    it('a live edit of O sets the restamp property with no restart; the playout offset stays live', async () => {
        const module = makeModule();
        module.config = { address: '239.69.0.1' };
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('aes67-in-1', 'aes67-input', module, {
            address: '239.69.0.1',
        });
        await instance.applyConfigUpdate({ ingestOffsetMs: 500 });
        expect(setElementProperty).toHaveBeenCalledWith('restamp', 'offset-ns', 500_000_000);
        await instance.applyConfigUpdate({ playoutOffsetMs: 120 });
        expect(setElementProperty).toHaveBeenCalledTimes(1);
        expect(instance.getState().pendingRestart).toBe(false);
        // A later rebuild starts on the edited value.
        expect(module.buildPipeline(module.config)!.pipeline).toContain('offset-ns=500000000');
    });

    it('declares ingest timing: the loader adds the Ingest Offset only, and it is live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aes67-input-manifest-'));
        try {
            mkdirSync(join(dir, 'aes67-input'));
            copyFileSync(join(__dirname, '../package.json'), join(dir, 'aes67-input/package.json'));
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['aes67-input'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toBeUndefined();
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(expect.arrayContaining(['playoutOffsetMs', 'ingestOffsetMs']));
            expect(new Aes67InputModule().getLiveUpdatableParams()).toEqual(
                expect.arrayContaining(live),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('the only Clock section is the ASRC card: PTP Sync is a Stream row', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
        const sections: Array<{ id: string; fields: unknown[] }> = pkg.mediaRouter.statusSections;
        expect(sections.map((s) => s.id)).not.toContain('clock');
        expect(sections.find((s) => s.id === 'stream')!.fields).toContainEqual({
            key: 'ptpSync',
            type: 'string',
            label: 'PTP Sync',
        });
    });

    it("shows the ASRC on the Clock card from start to stop, beside the stream's rows", async () => {
        vi.useFakeTimers();
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async () => {});
        const module = cardModule();
        await module.onStart();
        expect(module.getState().statusData.stream).toMatchObject({
            ptpSync: `RFC 7273 (gm ${GM})`,
        });
        // The base's own dynamic section (a route head's playout raise) shares the one list.
        module.upsertStatusSection({ id: 'playout', label: 'Playout', fields: [] });
        module.dispatchPluginEvent(CH.asrc, asrcStats());
        module.dispatchPluginEvent(CH.pid, pidMsg(250));
        vi.advanceTimersByTime(2000); // the reporter's tick
        const state = module.getState();
        expect(state.dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual([
            'playout',
            'clock',
        ]);
        expect(state.statusData.clock).toEqual({
            asrcRatio: -4.56,
            phaseError: 1,
            relocks: 0,
            ingestOffset: 250,
        });
        // The Clock publication replaces only its own section's data.
        expect(state.statusData.stream).toMatchObject({ ptpSync: `RFC 7273 (gm ${GM})` });
        // A new reading replaces the Clock section in place.
        module.dispatchPluginEvent(CH.asrc, asrcStats({ 'ratio-ppb': 7_890 }));
        vi.advanceTimersByTime(2000);
        expect(module.getState().dynamicStatusSections.map((s: { id: string }) => s.id)).toEqual([
            'playout',
            'clock',
        ]);
        expect(module.getState().statusData.clock).toMatchObject({ asrcRatio: 7.89 });

        // Stopped: nothing publishes any more, a new reading neither.
        await module.onStop();
        module.dispatchPluginEvent(CH.asrc, asrcStats({ 'ratio-ppb': 50_000 }));
        vi.advanceTimersByTime(4000);
        expect(module.getState().dynamicStatusSections).toEqual([]);
        expect(module.getState().statusData.clock).toBeUndefined();
    });

    it('raises the device clock warning over ok, and withdraws only its own text', () => {
        vi.useFakeTimers();
        const module = cardModule();
        offForAMinute(module);
        expect([module.health, module.error]).toEqual(['warning', OFF]);
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);

        // A rebuild's downmix warning since then owns the health text: the clear leaves it.
        offForAMinute(module);
        module.buildPipeline({ address: '239.69.0.1', channels: 8 });
        expect(module.error).toBe(DOWNMIX);
        report(module);
        expect([module.health, module.error]).toEqual(['warning', DOWNMIX]);
        // ...and a clock warning raised over it replaces it.
        offForAMinute(module);
        expect([module.health, module.error]).toEqual(['warning', OFF]);
    });

    it('a standing clock warning goes back up at every ok: a rebuild, a PLAYING', () => {
        vi.useFakeTimers();
        const module = cardModule();
        offForAMinute(module);
        module.buildPipeline({ address: '239.69.0.1' }); // ends in setHealth('ok')
        expect([module.health, module.error]).toEqual(['warning', OFF]);
        module.health = 'ok'; // what the base's PLAYING sets before its hook
        module.error = undefined;
        module.onPipelinePlaying();
        expect([module.health, module.error]).toEqual(['warning', OFF]);

        // A fault outranks one raised during it.
        const faulted = cardModule();
        faulted.setHealth('error', 'udpsrc: bind failed');
        offForAMinute(faulted);
        expect([faulted.health, faulted.error]).toEqual(['error', 'udpsrc: bind failed']);
    });
});
