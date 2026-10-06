import { describe, it, expect, vi } from 'vitest';
import { AudioDeviceOps } from '../audio/AudioDeviceOps.js';
import { pactlTwinQueue } from '../audio/testing/pactlTwinMvx2u.js';
import type { EngineServices } from '../plugins/PluginModule.js';
import type { DeviceProvider } from './DeviceProviderRegistry.js';
import { registerPipeWireDeviceProvider } from './pipeWireDeviceProvider.js';

function makeServices(devices: Array<Record<string, unknown>>) {
    let registered: DeviceProvider | undefined;
    const register = vi.fn((p: DeviceProvider) => {
        registered = p;
    });
    const normalizeSinkVolumes = vi.fn();
    const services = {
        pipeWire: {
            listDevices: vi.fn(() => devices),
            normalizeSinkVolumes,
        },
        deviceProviders: { register },
    } as unknown as EngineServices;
    return { services, register, normalizeSinkVolumes, getRegistered: () => registered };
}

describe('registerPipeWireDeviceProvider', () => {
    it('registers a provider under the given type', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0].type).toBe('audio-source');
    });

    it('forwards pollMs when provided', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, {
            type: 'audio-sink',
            direction: 'sink',
            pollMs: 500,
        });
        expect(register.mock.calls[0][0].pollMs).toBe(500);
    });

    it('omits pollMs when not provided so the registry default applies', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        expect(register.mock.calls[0][0].pollMs).toBeUndefined();
    });

    it('list() filters PipeWire devices to the requested direction', () => {
        const { services, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Built-in Mic', channels: 2, sampleRate: 48000 },
            { name: 'spk', direction: 'sink', description: 'Speakers', channels: 2, sampleRate: 48000 },
            { name: 'usb', direction: 'source', description: 'USB Mic', channels: 1, sampleRate: 44100 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ name: string }>;
        expect(list.map((d) => d.name)).toEqual(['mic', 'usb']);
    });

    it('formats labels with channel and sample-rate metadata', () => {
        const { services, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Built-in Mic', channels: 2, sampleRate: 48000 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ label: string; meta: Record<string, unknown> }>;
        expect(list[0].label).toBe('Built-in Mic (2ch, 48000Hz)');
        expect(list[0].meta).toEqual({ direction: 'source', channels: 2, sampleRate: 48000 });
    });

    it('falls back to the device name when description is missing', () => {
        const { services, getRegistered } = makeServices([
            { name: 'unnamed', direction: 'source', description: '', channels: 1, sampleRate: 44100 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ label: string }>;
        expect(list[0].label).toBe('unnamed (1ch, 44100Hz)');
    });

    it('normalizes sink volumes on every poll, with the unfiltered device list', () => {
        const devices = [
            { name: 'spk', direction: 'sink', description: 'Speakers', volumes: [26214, 26214] },
            { name: 'mic', direction: 'source', description: 'Mic', volumes: [65536] },
        ];
        const { services, normalizeSinkVolumes, getRegistered } = makeServices(devices);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        getRegistered()!.list();
        expect(normalizeSinkVolumes).toHaveBeenCalledWith(devices);
    });

    it('does not normalize from the source provider — sinks are corrected once, not twice', () => {
        const { services, normalizeSinkVolumes, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Mic' },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        getRegistered()!.list();
        expect(normalizeSinkVolumes).not.toHaveBeenCalled();
    });

    it('keeps volume out of `meta` so the registry diff does not spam deviceList', () => {
        const { services, getRegistered } = makeServices([
            { name: 'spk', direction: 'sink', description: 'Speakers', channels: 2, sampleRate: 48000, volumes: [26214, 26214] },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        const list = getRegistered()!.list() as Array<{ meta: Record<string, unknown> }>;
        expect(list[0].meta).toEqual({ direction: 'sink', channels: 2, sampleRate: 48000 });
    });

    it('renders `?` placeholders when channel/sampleRate are missing', () => {
        const { services, getRegistered } = makeServices([
            { name: 'partial', direction: 'sink', description: 'Partial' },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        const list = getRegistered()!.list() as Array<{ label: string }>;
        expect(list[0].label).toBe('Partial (?ch, ?Hz)');
    });
});

describe('registerPipeWireDeviceProvider — devices that share a description', () => {
    const mvx = (hash: string, over: Record<string, unknown> = {}) => ({
        name: `alsa_output.usb-Shure_Inc_Shure_MVX2U_MVX2U_3-${hash}-01.analog-stereo`,
        direction: 'sink',
        description: 'Shure MVX2U Analog Stereo',
        channels: 2,
        sampleRate: 48000,
        serial: `Shure_Inc_Shure_MVX2U_MVX2U#3-${hash}`,
        ...over,
    });
    const listOf = (devices: unknown[], direction: 'source' | 'sink' = 'sink') => {
        const { services, getRegistered } = makeServices(devices as Array<Record<string, unknown>>);
        registerPipeWireDeviceProvider(services, { type: 'audio', direction });
        return getRegistered()!.list() as Array<{ name: string; label: string }>;
    };
    const labels = (devices: unknown[], direction: 'source' | 'sink' = 'sink') =>
        listOf(devices, direction).map((d) => d.label);
    const tagOf = (label: string) => label.match(/ · (\S+) \(/)?.[1];

    it('.24 field listing: both MVX2U sinks and both mics get the hash head node.name shows', () => {
        const devices = new AudioDeviceOps(pactlTwinQueue() as never).listDevices();
        const sinks = listOf(devices, 'sink');
        const mics = listOf(devices, 'source');
        expect(sinks.map((d) => d.label)).toEqual([
            'Shure MVX2U Analog Stereo · efece7ff (2ch, 48000Hz)',
            'Shure MVX2U Analog Stereo · c7555f27 (2ch, 48000Hz)',
        ]);
        expect(mics.map((d) => d.label)).toEqual([
            'Shure MVX2U Mono · efece7ff (1ch, 48000Hz)',
            'Shure MVX2U Mono · c7555f27 (1ch, 48000Hz)',
        ]);
        // The tag is where the stored node name first differs, so a health
        // text that names the device points straight at its dropdown entry.
        for (const d of [...sinks, ...mics]) expect(d.name).toContain(`_MVX2U_3-${tagOf(d.label)}`);
    });

    it('leaves a lone unit untagged — tags only separate twins', () => {
        expect(labels([mvx('efece7ff193b505fbe969dc2c1c535bf')])).toEqual([
            'Shure MVX2U Analog Stereo (2ch, 48000Hz)',
        ]);
    });

    it("keeps each twin's tag when a third twin is plugged in", () => {
        const a = mvx('efece7ff193b505fbe969dc2c1c535bf');
        const b = mvx('c7555f279c87c75188277333d4fadb32');
        const c = mvx('e0d1c2b3a4958677685940312a1b0c0d');
        expect(labels([a, b]).map(tagOf)).toEqual(['efece7ff', 'c7555f27']);
        expect(labels([a, b, c]).map(tagOf)).toEqual(['efece7ff', 'c7555f27', 'e0d1c2b3']);
    });

    it('lengthens the heads only while two of them still match (sequential serials)', () => {
        const unit = (sn: string) => mvx(sn, { serial: `Vendor_Model_${sn}` });
        expect(labels([unit('SN00001234'), unit('SN00001235')]).map(tagOf)).toEqual([
            'SN00001234',
            'SN00001235',
        ]);
    });

    it('falls back to the bus path for twins without a per-unit serial', () => {
        const dongle = (n: string, port: string) => ({
            name: `alsa_output.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00${n}.analog-stereo`,
            direction: 'sink',
            description: 'USB PnP Sound Device Analog Stereo',
            channels: 2,
            sampleRate: 48000,
            serial: 'C-Media_Electronics_Inc._USB_PnP_Sound_Device',
            busPath: `platform-${port}`,
        });
        expect(
            labels([dongle('', 'xhci-hcd.1-usb-0:2:1.0'), dongle('.2', 'xhci-hcd.0-usb-0:2:1.0')]),
        ).toEqual([
            'USB PnP Sound Device Analog Stereo · xhci-hcd.1-usb-0:2:1.0 (2ch, 48000Hz)',
            'USB PnP Sound Device Analog Stereo · xhci-hcd.0-usb-0:2:1.0 (2ch, 48000Hz)',
        ]);
    });

    it("tells the Pi's two HDMI outputs apart by platform device", () => {
        const hdmi = (addr: string) => ({
            name: `alsa_output.platform-${addr}.hdmi.hdmi-stereo`,
            direction: 'sink',
            description: 'Built-in Audio Digital Stereo (HDMI)',
            channels: 2,
            sampleRate: 48000,
            busPath: `platform-${addr}.hdmi`,
        });
        expect(labels([hdmi('107c701400'), hdmi('107c706400')])).toEqual([
            'Built-in Audio Digital Stereo (HDMI) · 107c701400.hdmi (2ch, 48000Hz)',
            'Built-in Audio Digital Stereo (HDMI) · 107c706400.hdmi (2ch, 48000Hz)',
        ]);
    });

    it('falls back to the node name when nothing else tells twins apart', () => {
        const twin = (name: string) => ({ name, direction: 'sink', description: 'Twin' });
        expect(labels([twin('a.analog-stereo'), twin('a.analog-stereo.2')])).toEqual([
            'Twin · a.analog-stereo (?ch, ?Hz)',
            'Twin · a.analog-stereo.2 (?ch, ?Hz)',
        ]);
    });

    it("compares devices of the provider's own direction only", () => {
        const sink = mvx('efece7ff193b505fbe969dc2c1c535bf');
        const source = mvx('c7555f279c87c75188277333d4fadb32', { direction: 'source' });
        expect(labels([sink, source], 'sink')).toEqual([
            'Shure MVX2U Analog Stereo (2ch, 48000Hz)',
        ]);
        expect(labels([sink, source], 'source')).toEqual([
            'Shure MVX2U Analog Stereo (2ch, 48000Hz)',
        ]);
    });
});
