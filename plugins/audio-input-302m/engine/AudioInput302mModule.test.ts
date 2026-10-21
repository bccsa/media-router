import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstPluginBase, ModuleInstance, PluginLoader } from '@media-router/engine';
import { AudioInput302mModule } from './AudioInput302mModule.js';

const DEV = 'alsa_input.usb-KLARK_TEKNIK_KT-USB_33793A14-00.multichannel-input';
const PINS = 'node.dont-fallback=(string)true,node.linger=(string)true';

function makeModule(opts: { busPort?: number | null; deviceChannels?: number | null } = {}) {
    const module = new AudioInput302mModule() as any;
    module.services = {
        instanceId: 'ain-1',
        mediaRouter: {
            assignBusChannel: vi.fn(() => (opts.busPort === null ? null : { port: 41000 })),
        },
        ...(opts.deviceChannels !== undefined
            ? {
                  pipeWire: {
                      hasDevice: vi.fn(() => true),
                      getDeviceInfo: vi.fn(() =>
                          opts.deviceChannels === null
                              ? null
                              : { channels: opts.deviceChannels, sampleRate: 48000 },
                      ),
                  },
              }
            : {}),
    };
    module.config = {};
    module.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

/** pw-dump shaped graph: a `width`-channel capture card and the module's stream. */
function fakeDeps(width: number, streamPorts: number) {
    const dump: unknown[] = [
        { id: 55, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': DEV } } },
        {
            id: 400,
            type: 'PipeWire:Interface:Node',
            info: { props: { 'node.name': 'MR_PW_ain-1' } },
        },
    ];
    for (let i = 0; i < width; i++)
        dump.push({
            id: 100 + i,
            type: 'PipeWire:Interface:Port',
            info: {
                direction: 'output',
                props: { 'node.id': 55, 'port.id': i, 'port.name': `capture_AUX${i}` },
            },
        });
    for (let i = 0; i < streamPorts; i++)
        dump.push({
            id: 300 + i,
            type: 'PipeWire:Interface:Port',
            info: {
                direction: 'input',
                props: { 'node.id': 400, 'port.id': i, 'port.name': `input_${i + 1}` },
            },
        });
    return { dump: vi.fn(async () => dump), link: vi.fn(async () => undefined) };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioInput302mModule.buildPipeline', () => {
    it('never captures a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
        expect(module.linkPlan).toBeNull();
    });

    it('captures the explicit device as a 2-wide unpositioned stream the engine links itself', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic', volume: 100 });
        expect(desc).not.toBeNull();
        // pipewiresrc, never pulsesrc: pipewire-pulse cannot create wide record streams.
        expect(desc!.pipeline).toContain('pipewiresrc target-object=alsa_input.usb-mic');
        expect(desc!.pipeline).not.toContain('pulsesrc');
        // #736 pins, the quantum request, a findable node name, and WirePlumber kept out.
        expect(desc!.pipeline).toContain(
            `stream-properties="props,${PINS},node.latency=(string)2880/48000,node.name=(string)MR_PW_ain-1,node.autoconnect=(string)false"`,
        );
        // Exactly as wide as the range, unpositioned → ports input_1..2, re-positioned
        // by an identity matrix for the encoder. Never a device-wide matrix.
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,channels=2,channel-mask=(bitmask)0x0 ! audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)0.0000, (float)1.0000>>" ! audio/x-raw,channels=2,channel-mask=(bitmask)0x3 ! volume name=vol volume=1.00',
        );
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain(
            'audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7',
        );
        expect(desc!.pipeline).toContain(
            'mpegtsmux latency=0 alignment=7 ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! mrlateness name=lat_busout_41000 reference=house ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc!.restartOnError).toBe(true);
        expect(module.linkPlan).toEqual({
            streamNode: 'MR_PW_ain-1',
            direction: 'capture',
            deviceNode: 'alsa_input.usb-mic',
            firstIndex: 0,
            channels: 2,
        });
        expect(module.setStatusData).toHaveBeenCalledWith('bus', { channel: 41000 });
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: 'alsa_input.usb-mic',
            channels: 2,
            firstChannel: 1,
            lastChannel: 2,
        });
    });

    it('inputs 9–16 of a 48-channel desk: an 8-wide stream linked from device index 8', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 8, firstChannel: 9 });
        expect(desc).not.toBeNull();
        const p: string = desc!.pipeline;
        expect(p).toContain(`pipewiresrc target-object=${DEV}`);
        // Never the whole device any more — 8 ports, not 48; an 8×8 identity, not a 48×8 pick.
        expect(p).toMatch(
            /! audio\/x-raw,channels=8,channel-mask=\(bitmask\)0x0 ! audioconvert mix-matrix="<[^"]*>" ! audio\/x-raw,channels=8,channel-mask=\(bitmask\)0x63f ! volume name=vol/,
        );
        expect(p).not.toContain('channels=48');
        const rows = /mix-matrix="<(.*?)>"\s/.exec(p)![1].split('>, <');
        expect(rows).toHaveLength(8);
        for (const [i, r] of rows.entries()) {
            const cols = r.replace(/[<>]/g, '').split(', ');
            expect(cols).toHaveLength(8);
            expect(cols.indexOf('(float)1.0000')).toBe(i);
        }
        expect(p).toContain('audio/x-raw,format=S32LE,rate=48000,channels=8 ! avenc_s302m');
        expect(module.linkPlan).toEqual({
            streamNode: 'MR_PW_ain-1',
            direction: 'capture',
            deviceNode: DEV,
            firstIndex: 8,
            channels: 8,
        });
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: DEV,
            channels: 8,
            firstChannel: 9,
            lastChannel: 16,
            deviceChannels: 48,
        });
    });

    it('default stereo on a 48-channel desk links inputs 1–2 only', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV });
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,channels=2,channel-mask=(bitmask)0x0 ! audioconvert mix-matrix=',
        );
        expect(desc!.pipeline).toContain('rate=48000,channels=2 ! avenc_s302m');
        expect(module.linkPlan).toMatchObject({ firstIndex: 0, channels: 2 });
    });

    it('snaps channels onto the 302M set (3 → 4) before sizing the stream and the encoder', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 3, firstChannel: 5 });
        expect(desc!.pipeline).toContain('channels=4,channel-mask=(bitmask)0x0');
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,channels=4,channel-mask=(bitmask)0x33 ! volume',
        );
        expect(desc!.pipeline).toContain('rate=48000,channels=4 ! avenc_s302m');
        expect(module.linkPlan).toMatchObject({ firstIndex: 4, channels: 4 });
        expect(module.setStatusData).toHaveBeenCalledWith(
            'input',
            expect.objectContaining({ channels: 4, firstChannel: 5, lastChannel: 8 }),
        );
    });

    it('a mono source (UCM-split SSL 2 Mic1) is linked dual-mono into the stereo 302M pair', () => {
        const { module, setHealth } = makeModule({ deviceChannels: 1 });
        const desc = module.buildPipeline({
            device: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.HiFi__Mic1__source',
        });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('channels=2,channel-mask=(bitmask)0x0');
        expect(desc!.pipeline).toContain('rate=48000,channels=2 ! avenc_s302m');
        // Same device channel on both sides — a mono mic is centred, not left-only.
        expect(module.linkPlan).toMatchObject({ firstIndex: 0, channels: 2, dualMono: true });
        expect(setHealth).toHaveBeenLastCalledWith('ok');
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.HiFi__Mic1__source',
            channels: 2,
            firstChannel: 1,
            lastChannel: 2,
            deviceChannels: 1,
            dualMono: true,
        });
    });

    it('Mono (#778): one desk channel linked to both sides of a stereo 302M pair', () => {
        const { module, setHealth } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 1, firstChannel: 5 });
        expect(desc).not.toBeNull();
        // The wire is still stereo — 302M has no mono width.
        expect(desc!.pipeline).toContain('channels=2,channel-mask=(bitmask)0x0');
        expect(desc!.pipeline).toContain('rate=48000,channels=2 ! avenc_s302m');
        // Device channel 5 on BOTH stream inputs — never 5 left / 6 right.
        expect(module.linkPlan).toEqual({
            streamNode: 'MR_PW_ain-1',
            direction: 'capture',
            deviceNode: DEV,
            firstIndex: 4,
            channels: 2,
            dualMono: true,
        });
        expect(setHealth).toHaveBeenLastCalledWith('ok');
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: DEV,
            channels: 2,
            firstChannel: 5,
            lastChannel: 5,
            deviceChannels: 48,
            dualMono: true,
        });
    });

    it('Mono on a device of unknown width is dual-mono too; Mono past the device names the one channel', () => {
        const { module } = makeModule({ deviceChannels: null });
        module.buildPipeline({ device: DEV, channels: 1, firstChannel: 3 });
        expect(module.linkPlan).toMatchObject({ firstIndex: 2, channels: 2, dualMono: true });

        const { module: m2, setHealth } = makeModule({ deviceChannels: 2 });
        expect(m2.buildPipeline({ device: DEV, channels: 1, firstChannel: 3 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('has 2 channels — cannot capture 3'),
        );
        expect(setHealth).not.toHaveBeenCalledWith('error', expect.stringContaining('3–'));
    });

    it('the last channel of a wide desk into a stereo stream is dual-mono too', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        module.buildPipeline({ device: DEV, channels: 2, firstChannel: 48 });
        expect(module.linkPlan).toMatchObject({ firstIndex: 47, channels: 2, dualMono: true });
        expect(module.setStatusData).toHaveBeenCalledWith(
            'input',
            expect.objectContaining({ dualMono: true }),
        );
    });

    it('a range running past the device links what exists and reports the rest silent', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 8, firstChannel: 45 });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('channels=8,channel-mask=(bitmask)0x0');
        expect(module.linkPlan).toEqual({
            streamNode: 'MR_PW_ain-1',
            direction: 'capture',
            deviceNode: DEV,
            firstIndex: 44,
            channels: 8,
        });
        expect(module.setStatusData).toHaveBeenCalledWith(
            'input',
            expect.objectContaining({ deviceChannels: 48, silentChannels: 4 }),
        );
    });

    it('health error when the range starts beyond the device', () => {
        const { module, setHealth } = makeModule({ deviceChannels: 2 });
        expect(module.buildPipeline({ device: DEV, channels: 2, firstChannel: 3 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('has 2 channels — cannot capture 3–4'),
        );
        expect(module.setStatusData).not.toHaveBeenCalledWith('input', expect.anything());
        expect(module.linkPlan).toBeNull();
    });

    it('a non-default range on a device of unknown width still builds — the links decide', () => {
        const { module, setHealth } = makeModule({ deviceChannels: null });
        const desc = module.buildPipeline({ device: DEV, channels: 8, firstChannel: 9 });
        expect(desc).not.toBeNull();
        expect(module.linkPlan).toMatchObject({ firstIndex: 8, channels: 8 });
        expect(setHealth).toHaveBeenLastCalledWith('ok');
    });

    it('does not allocate a bus channel when the capture cannot be built', () => {
        const { module } = makeModule({ deviceChannels: 4 });
        expect(module.buildPipeline({ device: DEV, channels: 2, firstChannel: 5 })).toBeNull();
        expect(module.services.mediaRouter.assignBusChannel).not.toHaveBeenCalled();
    });

    it('clamps srcBufferMs to 40–85 ms as the requested PipeWire quantum', () => {
        const { module } = makeModule();
        expect(
            module.buildPipeline({ device: 'alsa_input.usb-mic', srcBufferMs: 5 })!.pipeline,
        ).toContain('node.latency=(string)1920/48000');
        // 85 ms = 4096 samples = the image's quantum-limit; more would be clamped by PipeWire.
        expect(
            module.buildPipeline({ device: 'alsa_input.usb-mic', srcBufferMs: 500 })!.pipeline,
        ).toContain('node.latency=(string)4080/48000');
    });

    it('health error when the bus channel pool is exhausted', () => {
        const { module, setHealth } = makeModule({ busPort: null });
        expect(module.buildPipeline({ device: 'alsa_input.usb-mic' })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No free UDP'));
    });

    it('declares its 302M wire width for consumers (getBusStreamChannels)', () => {
        const { module } = makeModule();
        module.config = { device: DEV, channels: 8, firstChannel: 9 };
        expect(module.getBusStreamChannels('audio-out')).toBe(8);
        // Wire width, not the raw setting: snapped onto the 302M set.
        module.config = { device: DEV, channels: 3 };
        expect(module.getBusStreamChannels('audio-out')).toBe(4);
        // Mono goes out dual-mono: consumers see a stereo stream.
        module.config = { device: DEV, channels: 1 };
        expect(module.getBusStreamChannels('audio-out')).toBe(2);
        module.config = { device: DEV };
        expect(module.getBusStreamChannels('audio-out')).toBe(2);
        expect(module.getBusStreamChannels('other')).toBeUndefined();
    });
});

describe('AudioInput302mModule device links', () => {
    it('on PLAYING, links stream ports to device channels from the plan and reports it', async () => {
        const { module, setHealth } = makeModule({ deviceChannels: 48 });
        module.buildPipeline({ device: DEV, channels: 2, firstChannel: 9 });
        module.linkDeps = fakeDeps(48, 2);
        module.onPipelinePlaying();
        await module.linker.ensure();
        // capture_AUX8 (id 108) → input_1 (id 300), AUX9 → input_2
        expect(module.linkDeps.link.mock.calls).toEqual([
            [108, 300],
            [109, 301],
        ]);
        expect(module.setStatusData).toHaveBeenCalledWith('links', {
            linked: 2,
            expected: 2,
            silent: 0,
        });
        expect(setHealth).not.toHaveBeenCalledWith('warning', expect.anything());
    });

    it('Mono links the one device channel to both stream inputs', async () => {
        const { module, setHealth } = makeModule({ deviceChannels: 48 });
        module.buildPipeline({ device: DEV, channels: 1, firstChannel: 5 });
        module.linkDeps = fakeDeps(48, 2);
        await module.linker.ensure();
        // capture_AUX4 (id 104) → input_1 (300) AND input_2 (301)
        expect(module.linkDeps.link.mock.calls).toEqual([
            [104, 300],
            [104, 301],
        ]);
        expect(module.setStatusData).toHaveBeenCalledWith('links', {
            linked: 2,
            expected: 2,
            silent: 0,
        });
        expect(setHealth).not.toHaveBeenCalledWith('warning', expect.anything());
    });

    it('a Mono range with no device port warns about the one channel, not a pair', async () => {
        const { module, setHealth } = makeModule({ deviceChannels: null });
        module.buildPipeline({ device: DEV, channels: 1, firstChannel: 9 });
        module.linkDeps = fakeDeps(4, 2);
        await module.linker.ensure();
        expect(setHealth).toHaveBeenLastCalledWith(
            'warning',
            expect.stringMatching(/no channels at 9$/),
        );
    });

    it('warns when the stream never appears, and clears the warning once it links', async () => {
        const { module, setHealth } = makeModule({ deviceChannels: 48 });
        module.buildPipeline({ device: DEV });
        module.linkDeps = fakeDeps(48, 0);
        module.linker = new (module.linker.constructor as any)({
            getPlan: () => module.linkPlan,
            deps: () => module.linkDeps,
            onResult: (r: unknown, p: unknown) => module.onLinked(r, p),
            onError: vi.fn(),
        });
        // Short timeout: the helper polls until the deadline.
        const { linkStreamPorts } = await import('@media-router/engine');
        module.onLinked(
            await linkStreamPorts(module.linkPlan, {
                deps: module.linkDeps,
                timeoutMs: 2,
                intervalMs: 1,
            }),
            module.linkPlan,
        );
        expect(setHealth).toHaveBeenLastCalledWith(
            'warning',
            expect.stringContaining('did not appear'),
        );
        module.linkDeps = fakeDeps(48, 2);
        await module.linker.ensure();
        expect(setHealth).toHaveBeenLastCalledWith('ok');
    });

    it('silent channels (range past the device) are not a warning; a range with no device ports is', async () => {
        const { module, setHealth } = makeModule({ deviceChannels: 4 });
        module.buildPipeline({ device: DEV, channels: 4, firstChannel: 3 });
        module.linkDeps = fakeDeps(4, 4);
        await module.linker.ensure();
        expect(module.setStatusData).toHaveBeenCalledWith('links', {
            linked: 2,
            expected: 4,
            silent: 2,
        });
        expect(setHealth).not.toHaveBeenCalledWith('warning', expect.anything());

        const { module: m2, setHealth: h2 } = makeModule({ deviceChannels: null });
        m2.buildPipeline({ device: DEV, channels: 2, firstChannel: 9 });
        m2.linkDeps = fakeDeps(4, 2);
        await m2.linker.ensure();
        expect(h2).toHaveBeenLastCalledWith(
            'warning',
            expect.stringContaining('no channels at 9–10'),
        );
    });

    it('does nothing without a plan (no pipeline was built)', async () => {
        const { module } = makeModule();
        module.linkDeps = fakeDeps(48, 2);
        await module.linker.ensure();
        expect(module.linkDeps.dump).not.toHaveBeenCalled();
    });
});

// --- On house time (house-clock plan WI-P1-11) ------------------------------------------------

const MS = 1_000_000;
const CH = {
    asrc: 'mrasrc-stats:asrc',
    asrcEvent: 'mrasrc-event:asrc',
    pid: 'mrtsrestamp-pid:restamp',
};
/** The elements' messages as the runner forwards them (plan ch. 5 part 10, WI-P1-8). */
const asrcStats = (o: Record<string, unknown> = {}) => ({
    state: 'locked',
    'ratio-ppb': 12_340,
    'phase-err-ns': 2.4 * MS,
    relocks: 1,
    'in-frames': 96_000,
    'out-frames': 96_000,
    'discont-in': 0,
    'dropped-frames': 0,
    ...o,
});
/** The capture's one PID, moved by O alone. */
const pidMsg = (shiftMs: number) => ({
    program: 1,
    pid: 65,
    'stream-type': 6,
    'lead-min-ns': -2 * MS,
    'lead-median-ns': -1 * MS,
    'lead-max-ns': 9 * MS,
    'trim-ns': 0,
    'shift-ns': shiftMs * MS,
    'dropped-pes': 0,
});
const factories = (pipeline: string) => pipeline.split(' ! ').map((el) => el.split(' ')[0]);
const OFF = "Device clock off by 300 ppm — check the device's sample rate";
const PLAN = {
    streamNode: 'MR_PW_ain-1',
    direction: 'capture',
    deviceNode: DEV,
    firstIndex: 0,
    channels: 2,
};

/** A module on the base's own state methods: what its card shows is `getState()`. */
function cardModule() {
    const module = new AudioInput302mModule() as any;
    module.services = {
        instanceId: 'ain-1',
        mediaRouter: { assignBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = { device: DEV };
    module.deviceName = DEV;
    module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    module.health = 'ok';
    return module;
}
const sectionIds = (module: any) =>
    module.getState().dynamicStatusSections.map((s: { id: string }) => s.id);
/** One report interval of the ASRC and the restamp, then the reporter's tick. */
function report(module: any, asrc: Record<string, unknown> = {}) {
    module.dispatchPluginEvent(CH.asrc, asrcStats(asrc));
    module.dispatchPluginEvent(CH.pid, pidMsg(-120));
    module.ingestTiming.tick();
}
/** A device clock 300 ppm off for the minute part 10's warning waits. */
function offForAMinute(module: any, ppb = 300_000) {
    report(module, { 'ratio-ppb': ppb });
    vi.advanceTimersByTime(61_000);
    report(module, { 'ratio-ppb': ppb });
}

describe('AudioInput302mModule on house time (WI-P1-11)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('resamples once, in mrasrc, and restamps after the mux, before the bus sink', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic' });
        const f = factories(desc!.pipeline);
        expect(f.slice(f.indexOf('level'))).toEqual([
            'level',
            'audioconvert',
            'mrasrc',
            'audio/x-raw,format=S32LE,rate=48000,channels=2',
            'avenc_s302m',
            'mpegtsmux',
            'mrtsrestamp',
            'capssetter',
            'capsfilter',
            'mrlateness',
            'tee',
        ]);
        // One resample per path (§13.1): the ASRC converts the nominal rate too.
        expect(desc!.pipeline).not.toContain('audioresample');
        expect(desc!.pipeline).toContain(
            '! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000 ' +
                '! audioconvert ! mrasrc name=asrc ! audio/x-raw,format=S32LE,rate=48000,channels=2 !',
        );
        expect(desc!.pipeline).toContain(
            '! mpegtsmux latency=0 alignment=7 ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0 ! capssetter ',
        );
        expect(desc!.busReports).toEqual([
            { element: 'restamp', structure: 'mrtsrestamp-stats' },
            { element: 'restamp', structure: 'mrtsrestamp-pid' },
            { element: 'restamp', structure: 'mrtsrestamp-event' },
            { element: 'asrc', structure: 'mrasrc-stats' },
            { element: 'asrc', structure: 'mrasrc-event' },
        ]);
    });

    it('starts the restamp on the configured Ingest Offset, with no per-PID trims', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const p: string = module.buildPipeline({
            device: DEV,
            channels: 8,
            firstChannel: 9,
            ingestOffsetMs: -120,
            pidTrimsMs: { 65: 40 },
        })!.pipeline;
        expect(p).toContain(
            '! mrasrc name=asrc ! audio/x-raw,format=S32LE,rate=48000,channels=8 ! avenc_s302m',
        );
        expect(p).toContain(' ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=-120000000 ! ');
        // A capture has one PID, where O is the trim (OQ-15).
        expect(p).not.toContain('pid-trims');
    });

    it('a live edit of O sets the restamp property with no restart, beside the live volume', async () => {
        const { module } = makeModule();
        module.config = { device: DEV };
        const setElementProperty = vi.fn(async () => {});
        module.setElementProperty = setElementProperty;
        const instance = new ModuleInstance('ain-1', 'audio-input-302m', module, { device: DEV });
        await instance.applyConfigUpdate({ ingestOffsetMs: -85 });
        expect(setElementProperty).toHaveBeenCalledWith('restamp', 'offset-ns', -85_000_000);
        await instance.applyConfigUpdate({ volume: 50 });
        expect(setElementProperty).toHaveBeenLastCalledWith('vol', 'volume', 0.5);
        expect(setElementProperty).toHaveBeenCalledTimes(2);
        expect(instance.getState().pendingRestart).toBe(false);
        // A later rebuild starts on the edited value.
        expect(module.buildPipeline(module.config)!.pipeline).toContain('offset-ns=-85000000');
    });

    it('declares ingest timing: the loader adds the Ingest Offset only, and it is live here', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'audio-input-302m-manifest-'));
        try {
            mkdirSync(join(dir, 'audio-input-302m'));
            copyFileSync(
                join(__dirname, '../package.json'),
                join(dir, 'audio-input-302m/package.json'),
            );
            const loader = new PluginLoader(dir);
            await loader.load();
            const props = (loader.getPluginSchemas()['audio-input-302m'] as any).properties;
            expect(props.ingestOffsetMs).toMatchObject({ minimum: -10000, maximum: 10000 });
            expect(props.pidTrimsMs).toBeUndefined();
            const live = Object.keys(props).filter((k) => props[k]['x-live'] === true);
            expect(live).toEqual(expect.arrayContaining(['volume', 'ingestOffsetMs']));
            expect(new AudioInput302mModule().getLiveUpdatableParams()).toEqual(
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
        // The base's own dynamic section (a route head's playout raise) shares the one list.
        module.upsertStatusSection({ id: 'playout', label: 'Playout', fields: [] });
        module.dispatchPluginEvent(CH.asrc, asrcStats());
        module.dispatchPluginEvent(CH.pid, pidMsg(-120));
        expect(sectionIds(module)).toEqual(['playout']);
        vi.advanceTimersByTime(2000); // the reporter's tick
        const state = module.getState();
        expect(sectionIds(module)).toEqual(['playout', 'clock']);
        expect(state.dynamicStatusSections[1]).toEqual({
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
            asrcRatio: 12.34,
            phaseError: 2,
            relocks: 1,
            ingestOffset: -120,
        });
        // Part 8's capture card has no clock badge.
        expect(state.badges).toEqual([]);
        // A new reading replaces the Clock section in place.
        module.dispatchPluginEvent(CH.asrc, asrcStats({ 'ratio-ppb': 23_450 }));
        vi.advanceTimersByTime(2000);
        expect(sectionIds(module)).toEqual(['playout', 'clock']);
        expect(module.getState().statusData.clock).toMatchObject({ asrcRatio: 23.45 });

        // Stopped: the card is cleared and nothing publishes any more, a new reading neither.
        await module.onStop();
        module.dispatchPluginEvent(CH.asrc, asrcStats({ 'ratio-ppb': 50_000 }));
        vi.advanceTimersByTime(4000);
        expect(sectionIds(module)).toEqual([]);
        expect(module.getState().statusData.clock).toBeUndefined();
    });

    it('a device unplug clears the card, and the replug shows it again with nothing changed', async () => {
        vi.useFakeTimers();
        vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async () => {});
        const module = cardModule();
        const interval = () => {
            module.dispatchPluginEvent(CH.asrc, asrcStats());
            module.dispatchPluginEvent(CH.pid, pidMsg(-120));
            vi.advanceTimersByTime(2000);
        };
        await module.onStart();
        interval();
        expect(module.getState().statusData.clock).toMatchObject({ asrcRatio: 12.34 });
        await module.onDeviceDisconnected();
        interval();
        expect(sectionIds(module)).toEqual([]);
        await module.onDeviceReconnected();
        interval();
        expect(sectionIds(module)).toEqual(['clock']);
        expect(module.getState().statusData.clock).toMatchObject({
            asrcRatio: 12.34,
            ingestOffset: -120,
        });
        await module.onStop();
    });

    it('raises the device clock warning over ok, and withdraws only its own text', () => {
        vi.useFakeTimers();
        const module = cardModule();
        offForAMinute(module);
        expect([module.health, module.error]).toEqual(['warning', OFF]);
        report(module);
        expect([module.health, module.error]).toEqual(['ok', undefined]);

        // A link warning since then owns the health text: the clock's clear leaves it.
        offForAMinute(module);
        module.onLinked({ linked: 1, missing: 0, streamPorts: 2 }, PLAN);
        expect(module.error).toBe('Linked 1 of 2 device channels');
        report(module);
        expect([module.health, module.error]).toEqual(['warning', 'Linked 1 of 2 device channels']);
        // ...and a clock warning raised over it replaces it.
        offForAMinute(module);
        expect([module.health, module.error]).toEqual(['warning', OFF]);
    });

    it('a clock warning hidden by another shows again at ok, and at PLAYING after a fault', () => {
        vi.useFakeTimers();
        const module = cardModule();
        offForAMinute(module, -300_000);
        module.onLinked({ linked: 1, missing: 0, streamPorts: 2 }, PLAN);
        module.onLinked({ linked: 2, missing: 0, streamPorts: 2 }, PLAN); // linked: ok
        expect([module.health, module.error]).toEqual(['warning', OFF]);

        // A fault outranks one raised during it; the PLAYING after the restart puts it back.
        const faulted = cardModule();
        faulted.setHealth('error', 'pipewiresrc: device busy');
        offForAMinute(faulted, -300_000);
        expect([faulted.health, faulted.error]).toEqual(['error', 'pipewiresrc: device busy']);
        faulted.health = 'ok'; // what the base's PLAYING sets before its hook
        faulted.error = undefined;
        faulted.onPipelinePlaying();
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
