import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GstPluginBase, ModuleInstance, PluginLoader, bitrateBadge } from '@media-router/engine';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioEncoderModule, BITRATE_KBPS, SRC_BUFFER_MS } from './AudioEncoderModule.js';

function makeModule(opts: { busPort?: number | null } = {}) {
    const module = new AudioEncoderModule() as any;
    const busPort = opts.busPort === undefined ? 41000 : opts.busPort;
    const assignBusChannel = vi.fn(() => (busPort === null ? null : { port: busPort }));
    const getBusChannel = vi.fn(() => (busPort === null ? undefined : { port: busPort }));
    module.services = {
        instanceId: 'enc-1',
        mediaRouter: { assignBusChannel, getBusChannel },
    };
    module.config = {};
    Object.defineProperty(module, 'pwNodeName', {
        value: 'MR_PW_enc-1',
        configurable: true,
    });
    const setStatusData = vi.fn();
    const setBadge = vi.fn();
    module.setStatusData = setStatusData;
    module.setBadge = setBadge;
    return { module, assignBusChannel, getBusChannel, setStatusData, setBadge };
}

describe('AudioEncoderModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('builds an opus path by default with the encoder bitrate, ts mux, restamp and bus fan-out tee', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc.pipeline).toContain('pipewiresrc target-object=MR_PW_enc-1 min-buffers=16 ');
        expect(desc.pipeline).toContain('opusenc bitrate=128000');
        expect(desc.pipeline).toContain(
            'mpegtsmux latency=0 alignment=7 ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! mrlateness name=lat_busout_41000 reference=running-time ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc.pipeline).not.toContain('udpsink');
    });

    it("captures its own null-sink's monitor (#736): no WirePlumber fallback, linger until the sink exists, the node on the RT data loop (B-88), 16 buffers, not live (B-180)", () => {
        const { module } = makeModule();
        expect(module.buildPipeline({}).pipeline).toMatch(
            /^pipewiresrc target-object=MR_PW_enc-1 min-buffers=16 stream-properties="props,node\.dont-fallback=\(string\)true,node\.linger=\(string\)true,node\.loop\.class=\(string\)data\.rt,stream\.is-live=\(string\)false,stream\.capture\.sink=\(string\)true,node\.latency=\(string\)2880\/48000" ! /,
        );
    });

    it('requests srcBufferMs as the PipeWire quantum, clamped to 40–85 ms (OQ-16)', () => {
        const { module } = makeModule();
        const latency = (cfg: Record<string, unknown>) =>
            /node\.latency=\(string\)(\d+)\/48000/.exec(module.buildPipeline(cfg).pipeline)?.[1];
        expect(latency({})).toBe('2880'); // 60 ms, audio-input-302m's default
        expect(latency({ srcBufferMs: 40 })).toBe('1920');
        expect(latency({ srcBufferMs: 5 })).toBe('1920');
        expect(latency({ srcBufferMs: 85 })).toBe('4080');
        // The pulsesrc ring's old range reaches 1000 ms; the quantum stops at the limit.
        expect(latency({ srcBufferMs: 200 })).toBe('4080');
        expect(latency({ srcBufferMs: 'junk' })).toBe('2880');
    });

    it("manifest srcBufferMs bounds and default mirror SRC_BUFFER_MS, the quantum's range", () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
        const prop = pkg.mediaRouter.configSchema.properties.srcBufferMs;
        expect([prop.minimum, prop.maximum, prop.default]).toEqual([
            SRC_BUFFER_MS.min,
            SRC_BUFFER_MS.max,
            SRC_BUFFER_MS.default,
        ]);
        expect([SRC_BUFFER_MS.min, SRC_BUFFER_MS.max]).toEqual([40, 85]);
    });

    it('takes any bitrate in kbps and clamps it to the codec range (#664)', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({ bitrate: 48 }).pipeline).toContain('opusenc bitrate=48000');
        expect(module.buildPipeline({ bitrate: 1 }).pipeline).toContain('opusenc bitrate=6000');
        expect(module.buildPipeline({ bitrate: 9999 }).pipeline).toContain(
            'opusenc bitrate=510000',
        );
        expect(module.buildPipeline({ codec: 'aac', bitrate: 9999 }).pipeline).toContain(
            'avenc_aac bitrate=320000',
        );
        expect(module.buildPipeline({ codec: 'aac', bitrate: 10 }).pipeline).toContain(
            'avenc_aac bitrate=32000',
        );
        expect(module.buildPipeline({ bitrate: 'junk' }).pipeline).toContain(
            'opusenc bitrate=128000',
        );
        expect(module.buildPipeline({ bitrate: 0 }).pipeline).toContain('opusenc bitrate=128000');
    });

    it('manifest bitrate bounds mirror BITRATE_KBPS (#664)', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
        const prop = pkg.mediaRouter.configSchema.properties.bitrate;
        expect(prop.minimum).toBe(Math.min(...Object.values(BITRATE_KBPS).map((r) => r.min)));
        expect(prop.maximum).toBe(Math.max(...Object.values(BITRATE_KBPS).map((r) => r.max)));
        expect(prop['x-maxBy'].map).toEqual({
            opus: BITRATE_KBPS.opus.max,
            aac: BITRATE_KBPS.aac.max,
        });
        expect(prop.default).toBe(BITRATE_KBPS.opus.default);
    });

    it('builds an AAC path when codec=aac', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'aac', bitrate: 192 });
        expect(desc.pipeline).toContain('avenc_aac bitrate=192000');
        expect(desc.pipeline).not.toContain('opusenc');
    });

    it('disables AAC joint stereo with integer 0, not "false" (issue #676)', () => {
        // avenc_aac's aac-ms is a tri-state enum (auto/off/on) on newer
        // gst-libav; the literal "false" fails to deserialize. `0` = off works
        // on both the enum and boolean builds.
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'aac' });
        expect(desc.pipeline).toContain('aac-is=0 aac-ms=0');
        expect(desc.pipeline).not.toContain('aac-ms=false');
        expect(desc.pipeline).not.toContain('aac-is=false');
    });

    it('falls back to fakesink when no bus channel can be assigned, one that never prerolls (B-180)', () => {
        const { module } = makeModule({ busPort: null });
        const desc = module.buildPipeline({});
        expect(desc.pipeline).toContain(
            '! mpegtsmux latency=0 alignment=7 ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0 ! fakesink name=usink sync=false async=false',
        );
        expect(desc.pipeline).not.toContain('tee name=busout');
    });

    it('threads tsAlignment through to mpegtsmux', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', tsAlignment: 1 });
        expect(desc.pipeline).toContain('alignment=1');
    });

    it('respects audioEnabled=false by forcing gst volume to 0', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', volume: 75, audioEnabled: false });
        expect(desc.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('passes inband-fec and packet-loss-percentage through to opusenc', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({
            codec: 'opus',
            inbandFec: true,
            packetLoss: 5,
        });
        expect(desc.pipeline).toContain('inband-fec=true');
        expect(desc.pipeline).toContain('packet-loss-percentage=5');
    });

    it('picks Opus audio-type=2051 (restricted-lowdelay) for short frames when audioType is 0/auto', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', frameSize: 2.5, audioType: 0 });
        expect(desc.pipeline).toContain('audio-type=2051');
    });

    it('picks Opus audio-type=2048 (generic) for longer frames when audioType is 0/auto', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', frameSize: 20, audioType: 0 });
        expect(desc.pipeline).toContain('audio-type=2048');
    });

    it('respects an explicit non-zero audioType verbatim', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ codec: 'opus', audioType: 2049 });
        expect(desc.pipeline).toContain('audio-type=2049');
    });
});

describe('AudioEncoderModule.updateStatusData', () => {
    beforeEach(() => vi.clearAllMocks());

    it('populates the encoder section from current config', () => {
        const { module, setStatusData } = makeModule();
        module.config = {
            codec: 'aac',
            bitrate: 192,
            frameSize: 10,
            sampleRate: 44100,
            channels: 2,
        };
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({
                codec: 'aac',
                bitrate: 192,
                frameSize: 10,
                sampleRate: 44100,
                channels: 2,
            }),
        );
    });

    it('populates the bus section with the assigned channel when available', () => {
        const { module, setStatusData } = makeModule();
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith('bus', { channel: 41000 });
    });

    it('renders channel 0 in the bus section when no channel is assigned', () => {
        const { module, setStatusData } = makeModule({ busPort: null });
        module.updateStatusData();
        expect(setStatusData).toHaveBeenCalledWith('bus', { channel: 0 });
    });
});

describe('AudioEncoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink as the sink so audio sources loop back into it', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ sink: 'MR_PW_enc-1' });
    });
});

describe('bitrateBadge', () => {
    it('shows kbps below 1 Mbps (audio scale), green when flowing', () => {
        expect(bitrateBadge(128)).toEqual({ icon: 'activity', text: '128 kbps', color: '#10b981' });
    });

    it('switches to Mbps at/above 1000 kbps (video scale)', () => {
        expect(bitrateBadge(4200)).toEqual({
            icon: 'activity',
            text: '4.2 Mbps',
            color: '#10b981',
        });
    });

    it('goes grey at zero throughput', () => {
        expect(bitrateBadge(0)).toEqual({ icon: 'activity', text: '0 kbps', color: '#6b7280' });
    });
});

describe('AudioEncoderModule.publishThroughput', () => {
    beforeEach(() => vi.clearAllMocks());

    it('puts the live rate in the popup and a bitrate badge on the face', () => {
        const { module, setStatusData, setBadge } = makeModule();
        (module as any).publishThroughput({ bitrateKbps: 132, totalBytes: 2 * 1024 * 1024 });
        expect(setStatusData).toHaveBeenCalledWith(
            'throughput',
            expect.objectContaining({ 'Output Bitrate': '132 kbps' }),
        );
        expect(setBadge).toHaveBeenCalledWith('bitrate', {
            icon: 'activity',
            text: '132 kbps',
            color: '#10b981',
        });
    });
});

// --- On house time (house-clock plan WI-P1-12) ------------------------------------------------

const MS = 1_000_000;
const CH = {
    asrc: 'mrasrc-stats:asrc',
    asrcEvent: 'mrasrc-event:asrc',
    pid: 'mrtsrestamp-pid:restamp',
};
/** The elements' messages as the runner forwards them (plan ch. 5 part 10, WI-P1-8). */
const asrcStats = (o: Record<string, unknown> = {}) => ({
    state: 'locked',
    'ratio-ppb': 3_210,
    'phase-err-ns': 1.6 * MS,
    relocks: 0,
    'in-frames': 96_000,
    'out-frames': 96_000,
    'discont-in': 0,
    'dropped-frames': 0,
    ...o,
});
/** The encoder's one audio PID, moved by O alone. */
const pidMsg = (shiftMs: number) => ({
    program: 1,
    pid: 65,
    'stream-type': 6,
    'lead-min-ns': -31 * MS,
    'lead-median-ns': -30 * MS,
    'lead-max-ns': -28 * MS,
    'trim-ns': 0,
    'shift-ns': shiftMs * MS,
    'dropped-pes': 0,
});
const factories = (pipeline: string) => pipeline.split(' ! ').map((el) => el.split(' ')[0]);
const OFF = "Device clock off by 300 ppm — check the device's sample rate";

/** A module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new AudioEncoderModule() as any;
    module.services = {
        instanceId: 'enc-1',
        mediaRouter: {
            assignBusChannel: vi.fn(() => ({ port: 41000 })),
            getBusChannel: vi.fn(() => ({ port: 41000 })),
        },
    };
    module.config = {};
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    module.health = 'ok';
    return module;
}
const sectionIds = (module: any) =>
    module.getState().dynamicStatusSections.map((s: { id: string }) => s.id);
/** One report interval of the ASRC and the restamp, then the reporter's tick. */
function report(module: any, asrc: Record<string, unknown> = {}) {
    module.dispatchPluginEvent(CH.asrc, asrcStats(asrc));
    module.dispatchPluginEvent(CH.pid, pidMsg(-40));
    module.ingestTiming.tick();
}
/** The capture's clock 300 ppm off for the minute part 10's warning waits. */
function offForAMinute(module: any) {
    report(module, { 'ratio-ppb': 300_000 });
    vi.advanceTimersByTime(61_000);
    report(module, { 'ratio-ppb': 300_000 });
}

describe('AudioEncoderModule on house time (WI-P1-12)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('captures with pipewiresrc, resamples once in mrasrc and restamps after the mux', () => {
        const { module } = makeModule();
        const opus = module.buildPipeline({});
        expect(factories(opus.pipeline)).toEqual([
            'pipewiresrc',
            'audio/x-raw,format=F32LE,channels=2,channel-mask=(bitmask)0x3',
            'audioconvert',
            'mrasrc',
            'audio/x-raw,rate=48000,channels=2',
            'volume',
            'level',
            'queue',
            'opusenc',
            'mpegtsmux',
            'mrtsrestamp',
            'capssetter',
            'capsfilter',
            'mrlateness',
            'tee',
        ]);
        const aac = factories(module.buildPipeline({ codec: 'aac' }).pipeline);
        expect(aac.slice(aac.indexOf('queue'), aac.indexOf('capssetter'))).toEqual([
            'queue',
            'audioconvert',
            'avenc_aac',
            'mpegtsmux',
            'mrtsrestamp',
        ]);
        for (const p of [opus.pipeline, module.buildPipeline({ codec: 'aac' }).pipeline]) {
            // One resample per path (§13.1), and the pulsesrc ring is gone.
            expect(p).not.toContain('audioresample');
            expect(p).not.toContain('pulsesrc');
        }
    });

    it('stamps by identity with no conditioner threshold (OQ-16), and reports both elements', () => {
        const { module } = makeModule();
        for (const codec of ['opus', 'aac']) {
            const desc = module.buildPipeline({ codec });
            // These two and nothing else: no stamper policy, every egress is stamped by
            // identity (WI-P2-3), and no per-egress conditioner threshold (OQ-16).
            expect(Object.keys(desc).sort()).toEqual(['busReports', 'pipeline']);
            expect(desc.busReports).toEqual([
                { element: 'restamp', structure: 'mrtsrestamp-stats' },
                { element: 'restamp', structure: 'mrtsrestamp-pid' },
                { element: 'restamp', structure: 'mrtsrestamp-event' },
                { element: 'asrc', structure: 'mrasrc-stats' },
                { element: 'asrc', structure: 'mrasrc-event' },
            ]);
        }
    });

    it('the ASRC counts at sampleRate, whatever rate the null-sink monitor runs at', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({}).pipeline).toContain(
            '! audioconvert ! mrasrc name=asrc out-rate=48000 cycle-input=true ! audio/x-raw,rate=48000,channels=2 ! volume ',
        );
        const p: string = module.buildPipeline({ codec: 'aac', sampleRate: 44100 }).pipeline;
        expect(p).toContain(
            '! mrasrc name=asrc out-rate=44100 cycle-input=true ! audio/x-raw,rate=44100,channels=2 !',
        );
        // The capture's rate stays open: PipeWire hands over the monitor's own.
        expect(p).toMatch(/! audio\/x-raw,format=F32LE,channels=2,channel-mask=\(bitmask\)0x3 ! /);
    });

    it("pins the capture's layout: an open count is downmixed, >2 channels need a mask", () => {
        const { module } = makeModule();
        const capture = (channels: number) =>
            factories(module.buildPipeline({ channels }).pipeline)[1];
        expect(capture(1)).toBe('audio/x-raw,format=F32LE,channels=1');
        expect(capture(2)).toBe('audio/x-raw,format=F32LE,channels=2,channel-mask=(bitmask)0x3');
        expect(capture(6)).toBe('audio/x-raw,format=F32LE,channels=6,channel-mask=(bitmask)0x3f');
        expect(capture(8)).toBe('audio/x-raw,format=F32LE,channels=8,channel-mask=(bitmask)0xc3f');
        expect(module.buildPipeline({ channels: 6 }).pipeline).toContain(
            '! mrasrc name=asrc out-rate=48000 cycle-input=true ! audio/x-raw,rate=48000,channels=6 !',
        );
    });

    it('starts the restamp on the configured Ingest Offset, with no per-PID trims', () => {
        const { module } = makeModule();
        const p: string = module.buildPipeline({
            ingestOffsetMs: -120,
            pidTrimsMs: { 65: 40 },
        }).pipeline;
        expect(p).toContain(' ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=-120000000 ! ');
        // One PID, where O is the trim (OQ-15).
        expect(p).not.toContain('pid-trims');
        // OQ-14's bound.
        expect(module.buildPipeline({ ingestOffsetMs: 25_000 }).pipeline).toContain(
            'offset-ns=10000000000 ',
        );
    });

    it('a live edit of O sets the restamp property with no restart, beside the live bitrate and volume', async () => {
        const { module } = makeModule();
        module.config = { codec: 'opus' };
        module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('enc-1', 'audio-encoder', module, { codec: 'opus' });
        await instance.applyConfigUpdate({ ingestOffsetMs: -85 });
        expect(setElementProperty).toHaveBeenCalledWith('restamp', 'offset-ns', -85_000_000);
        await instance.applyConfigUpdate({ bitrate: 64, volume: 50 });
        expect(setElementProperty).toHaveBeenCalledWith('vol', 'volume', 0.5);
        expect(setElementProperty).toHaveBeenCalledWith('opusenc0', 'bitrate', 64_000);
        expect(setElementProperty).toHaveBeenCalledTimes(3);
        expect(instance.getState().pendingRestart).toBe(false);
        // A later rebuild starts on the edited value.
        expect(module.buildPipeline(module.config).pipeline).toContain('offset-ns=-85000000');
        // The quantum is not live: it rebuilds the capture.
        await instance.applyConfigUpdate({ srcBufferMs: 80 });
        expect(instance.getState().pendingRestart).toBe(true);
    });

    it('declares ingest timing: the loader adds the Ingest Offset only, and it is live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'audio-encoder-manifest-'));
        try {
            mkdirSync(join(dir, 'audio-encoder'));
            copyFileSync(
                join(__dirname, '../package.json'),
                join(dir, 'audio-encoder/package.json'),
            );
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['audio-encoder'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toBeUndefined();
            // No clock lock to smooth (b95s).
            expect(props.smoothingCooldownMin).toBeUndefined();
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(expect.arrayContaining(['volume', 'ingestOffsetMs']));
            expect(new AudioEncoderModule().getLiveUpdatableParams()).toEqual(
                expect.arrayContaining(live),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("shows the ASRC on the capture's Clock card from start to stop", async () => {
        vi.useFakeTimers();
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async () => {});
        const module = cardModule();
        await module.onStart();
        module.dispatchPluginEvent(CH.asrc, asrcStats());
        module.dispatchPluginEvent(CH.pid, pidMsg(-40));
        expect(sectionIds(module)).toEqual([]);
        vi.advanceTimersByTime(2000); // the reporter's tick
        const state = module.getState();
        expect(sectionIds(module)).toEqual(['clock']);
        expect(state.dynamicStatusSections[0]).toEqual({
            id: 'clock',
            label: 'Clock',
            fields: [
                { key: 'asrcRatio', label: 'ASRC ratio', unit: 'ppm' },
                { key: 'phaseError', label: 'Phase error', unit: 'ms' },
                { key: 'relocks', label: 'Re-locks' },
                { key: 'ingestOffset', label: 'Ingest offset', unit: 'ms' },
            ],
        });
        expect(state.statusData.clock).toEqual({
            asrcRatio: 3.21,
            phaseError: 2,
            relocks: 0,
            ingestOffset: -40,
        });
        // The encoder's own sections stay beside it.
        expect(state.statusData.bus).toEqual({ channel: 41000 });
        // Part 8's capture card has no clock badge.
        expect(state.badges).toEqual([]);

        // Stopped: the card is cleared and nothing publishes any more, a new reading neither.
        await module.onStop();
        module.dispatchPluginEvent(CH.asrc, asrcStats({ 'ratio-ppb': 50_000 }));
        vi.advanceTimersByTime(4000);
        expect(sectionIds(module)).toEqual([]);
        expect(module.getState().statusData.clock).toBeUndefined();
    });

    it('raises the device clock warning over ok, withdraws it, and puts it back at PLAYING', () => {
        vi.useFakeTimers();
        const module = cardModule();
        offForAMinute(module);
        expect([module.health, module.error]).toEqual(['warning', OFF]);
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);

        // A fault outranks one raised during it; the PLAYING after the restart puts it back.
        const faulted = cardModule();
        faulted.setHealth('error', 'pipewiresrc: not-negotiated');
        offForAMinute(faulted);
        expect([faulted.health, faulted.error]).toEqual(['error', 'pipewiresrc: not-negotiated']);
        faulted.health = 'ok'; // what the base's PLAYING sets before its hook
        faulted.error = undefined;
        faulted.onPipelinePlaying();
        expect([faulted.health, faulted.error]).toEqual(['warning', OFF]);
        // ...and any later return to ok shows it again.
        faulted.setHealth('ok');
        expect([faulted.health, faulted.error]).toEqual(['warning', OFF]);
    });

    it('logs the ASRC events, a ratio past the clamp at warn', () => {
        const module = cardModule();
        const relock = { kind: 'relock', reason: 'envelope-step', 'dropped-ns': 59_935_000 };
        module.dispatchPluginEvent(CH.asrcEvent, relock);
        expect(module.log.info).toHaveBeenCalledWith(
            { 'mrasrc-event': relock },
            'mrasrc-event relock (envelope-step)',
        );
        const oob = { kind: 'ratio-out-of-bounds', reason: '', 'fit-ppb': 1_500_000 };
        module.dispatchPluginEvent(CH.asrcEvent, oob);
        expect(module.log.warn).toHaveBeenCalledWith(
            { 'mrasrc-event': oob },
            'mrasrc-event ratio-out-of-bounds',
        );
    });
});
