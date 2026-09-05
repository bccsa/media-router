import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioInput302mModule } from './AudioInput302mModule.js';

const DEV = 'alsa_input.usb-KLARK_TEKNIK_KT-USB_33793A14-00.multichannel-input';

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
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

/** Parse `mix-matrix="<<r0>, <r1>>"` into rows of numbers. */
function matrixRows(pipeline: string): number[][] {
    const m = /mix-matrix="<(.*?)>"\s/.exec(pipeline);
    if (!m) throw new Error('no mix-matrix in pipeline');
    return m[1].split('>, <').map((r) =>
        r
            .replace(/[<>]/g, '')
            .split(', ')
            .map((c) => Number(c.replace('(float)', ''))),
    );
}

beforeEach(() => vi.clearAllMocks());

describe('AudioInput302mModule.buildPipeline', () => {
    it('never captures a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
    });

    it('captures the explicit device into a stereo 302M encode tail by default', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic', volume: 100 });
        expect(desc).not.toBeNull();
        // pipewiresrc, never pulsesrc: pipewire-pulse cannot create wide record
        // streams and links multichannel cards to two ports only.
        expect(desc!.pipeline).toContain('pipewiresrc target-object=alsa_input.usb-mic');
        expect(desc!.pipeline).not.toContain('pulsesrc');
        expect(desc!.pipeline).toContain('node.latency=(string)2880/48000');
        // Device width unknown (no PipeWire service) → plain stereo request.
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,channels=2 ! audioconvert ! volume name=vol volume=1.00',
        );
        expect(desc!.pipeline).not.toContain('mix-matrix');
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain(
            'audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7',
        );
        expect(desc!.pipeline).toContain(
            'mpegtsmux latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(desc!.restartOnError).toBe(true);
        expect(module.setStatusData).toHaveBeenCalledWith('bus', { channel: 41000 });
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: 'alsa_input.usb-mic',
            channels: 2,
            firstChannel: 1,
            lastChannel: 2,
        });
    });

    it('captures a 48-channel desk whole, unpositioned, and matrixes out inputs 9–16 as 8-ch 302M', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 8, firstChannel: 9 });
        expect(desc).not.toBeNull();
        const p: string = desc!.pipeline;
        // Full width with channel-mask 0 — the only shape PipeWire links port-for-port.
        expect(p).toContain(`pipewiresrc target-object=${DEV}`);
        expect(p).toContain(
            '! audio/x-raw,channels=48,channel-mask=(bitmask)0x0 ! audioconvert mix-matrix=',
        );
        expect(p).toContain('! audio/x-raw,channels=8 ! volume name=vol');
        expect(p).toContain('audio/x-raw,format=S32LE,rate=48000,channels=8 ! avenc_s302m');
        const rows = matrixRows(p);
        expect(rows).toHaveLength(8);
        for (const [dst, row] of rows.entries()) {
            expect(row).toHaveLength(48);
            // Output channel dst carries device channel (9-1)+dst and nothing else.
            expect(row.indexOf(1)).toBe(8 + dst);
            expect(row.filter((v) => v !== 0)).toEqual([1]);
        }
        expect(module.setStatusData).toHaveBeenCalledWith('input', {
            device: DEV,
            channels: 8,
            firstChannel: 9,
            lastChannel: 16,
            deviceChannels: 48,
        });
    });

    it('default stereo on a 48-channel desk still captures inputs 1–2 (through the matrix)', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV });
        const rows = matrixRows(desc!.pipeline);
        expect(rows).toHaveLength(2);
        expect(rows[0].indexOf(1)).toBe(0);
        expect(rows[1].indexOf(1)).toBe(1);
        expect(desc!.pipeline).toContain('rate=48000,channels=2 ! avenc_s302m');
    });

    it('skips the matrix when the range IS the device (stereo mic, default range)', () => {
        const { module } = makeModule({ deviceChannels: 2 });
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic' });
        expect(desc!.pipeline).toContain(
            '! audio/x-raw,channels=2,channel-mask=(bitmask)0x0 ! audioconvert ! volume',
        );
        expect(desc!.pipeline).not.toContain('mix-matrix');
    });

    it('snaps channels onto the 302M set (3 → 4) before sizing the matrix and the encoder', () => {
        const { module } = makeModule({ deviceChannels: 48 });
        const desc = module.buildPipeline({ device: DEV, channels: 3, firstChannel: 5 });
        expect(matrixRows(desc!.pipeline)).toHaveLength(4);
        expect(desc!.pipeline).toContain('rate=48000,channels=4 ! avenc_s302m');
        expect(module.setStatusData).toHaveBeenCalledWith(
            'input',
            expect.objectContaining({ channels: 4, firstChannel: 5, lastChannel: 8 }),
        );
    });

    it('health error when the range runs past the device', () => {
        const { module, setHealth } = makeModule({ deviceChannels: 48 });
        expect(module.buildPipeline({ device: DEV, channels: 8, firstChannel: 45 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('has 48 channels — cannot capture 45–52'),
        );
    });

    it('health error when a non-default range is asked of a device of unknown width', () => {
        const { module, setHealth } = makeModule({ deviceChannels: null });
        expect(module.buildPipeline({ device: DEV, channels: 8, firstChannel: 9 })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('not enumerated by PipeWire'),
        );
    });

    it('does not allocate a bus channel when the capture cannot be built', () => {
        const { module } = makeModule({ deviceChannels: 4 });
        expect(module.buildPipeline({ device: DEV, channels: 8 })).toBeNull();
        expect(module.services.mediaRouter.assignBusChannel).not.toHaveBeenCalled();
    });

    it('clamps srcBufferMs to the 40 ms floor as the requested PipeWire quantum', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic', srcBufferMs: 5 });
        expect(desc!.pipeline).toContain('node.latency=(string)1920/48000');
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
