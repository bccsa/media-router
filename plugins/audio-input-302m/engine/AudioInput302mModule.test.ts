import { describe, it, expect, vi, beforeEach } from 'vitest';
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
            'mpegtsmux latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_41000 allow-not-linked=true',
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
