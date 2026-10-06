import { describe, it, expect, vi } from 'vitest';
import {
    parseDeviceBlock,
    parseDeviceChannels,
    parseDeviceProperty,
    parseDeviceSampleRate,
    parseDeviceVolumes,
    PA_VOLUME_NORM,
    AudioDeviceOps,
    DEFAULT_DEVICE_CACHE_TTL_MS,
} from './AudioDeviceOps.js';
import {
    MVX2U_MIC_NAMES,
    MVX2U_SINK_NAMES,
    MVX2U_UNITS,
    PACTL_SINKS,
    pactlTwinQueue,
} from './testing/pactlTwinMvx2u.js';

describe('parseDeviceChannels', () => {
    it('reads `Channel Map: mono` as 1 channel — fixes the mono-USB-mic-as-2ch bug where the active stereo profile mis-reports the spec', () => {
        const block = `Name: alsa_input.usb-mono\nChannel Map: mono\nSample Specification: s16le 2ch 48000Hz`;
        // Sample Specification says 2ch (active profile is stereo) but the
        // Channel Map says mono. Channel Map is authoritative — the device
        // is genuinely a mono mic, the second channel is just a duplicate.
        expect(parseDeviceChannels(block)).toBe(1);
    });
    it('counts comma-separated entries in `Channel Map:` for stereo', () => {
        const block = `Channel Map: front-left,front-right`;
        expect(parseDeviceChannels(block)).toBe(2);
    });
    it('counts entries for surround (5.1)', () => {
        const block = `Channel Map: front-left,front-right,front-center,lfe,rear-left,rear-right`;
        expect(parseDeviceChannels(block)).toBe(6);
    });
    it('falls back to `Sample Specification:` when `Channel Map:` is absent', () => {
        const block = `Sample Specification: s16le 2ch 48000Hz`;
        expect(parseDeviceChannels(block)).toBe(2);
    });
    it('returns undefined when neither field is parseable', () => {
        const block = `Name: foo\nDescription: bar`;
        expect(parseDeviceChannels(block)).toBeUndefined();
    });
    it('tolerates leading/trailing whitespace in Channel Map values', () => {
        const block = `Channel Map:   front-left , front-right  `;
        expect(parseDeviceChannels(block)).toBe(2);
    });
});

describe('parseDeviceSampleRate', () => {
    it('reads sample rate from `Sample Specification:`', () => {
        const block = `Sample Specification: s16le 2ch 48000Hz`;
        expect(parseDeviceSampleRate(block)).toBe(48000);
    });
    it('returns undefined when the spec line is missing — common for SUSPENDED devices', () => {
        const block = `Name: alsa_input.suspended\nChannel Map: mono`;
        expect(parseDeviceSampleRate(block)).toBeUndefined();
    });
});

describe('parseDeviceVolumes', () => {
    // Verbatim from `pactl list sinks` on a Shure MVX2U sitting at the
    // restored 40% that this fix exists to correct.
    const shure = [
        '\tMute: no',
        '\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB',
        '\t        balance 0.00',
        '\tBase Volume: 65536 / 100% / 0.00 dB',
    ].join('\n');

    it('reads one raw value per channel', () => {
        expect(parseDeviceVolumes(shure)).toEqual([26214, 26214]);
    });
    it('does not mistake `Base Volume:` for the current volume', () => {
        // Base Volume is always 65536; reading it would make an attenuated
        // device look like it is already at unity and skip the reset.
        expect(parseDeviceVolumes('\tBase Volume: 65536 / 100% / 0.00 dB')).toEqual([]);
    });
    it('reads a mono device as a single channel', () => {
        expect(parseDeviceVolumes('\tVolume: mono: 65536 / 100% / 0.00 dB')).toEqual([
            PA_VOLUME_NORM,
        ]);
    });
    it('reads all six channels of a surround device', () => {
        const line =
            '\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB,   ' +
            'front-center: 65536 / 100% / 0.00 dB,   lfe: 65536 / 100% / 0.00 dB,   ' +
            'rear-left: 65536 / 100% / 0.00 dB,   rear-right: 65536 / 100% / 0.00 dB';
        expect(parseDeviceVolumes(line)).toHaveLength(6);
    });
    it('returns an empty array when the block has no volume line', () => {
        expect(parseDeviceVolumes('Name: alsa_output.foo\nChannel Map: mono')).toEqual([]);
    });
});

describe('parseDeviceProperty', () => {
    const sink = PACTL_SINKS.split('\n\n')[0];

    it('reads a two-tab-indented `key = "value"` line, keeping the `#` udev leaves in the serial', () => {
        expect(parseDeviceProperty(sink, 'device.serial')).toBe(
            'Shure_Inc_Shure_MVX2U_MVX2U#3-efece7ff193b505fbe969dc2c1c535bf',
        );
    });
    it('matches the whole key: `device.bus` is not `device.bus_path` or `device.bus-id`', () => {
        expect(parseDeviceProperty(sink, 'device.bus')).toBe('usb');
    });
    it("reads pactl's `device.bus_path`; PipeWire's `device.bus-path` spelling never reaches pactl", () => {
        expect(parseDeviceProperty(sink, 'device.bus_path')).toBe(
            'platform-xhci-hcd.1-usb-0:1:1.1',
        );
        expect(parseDeviceProperty(sink, 'device.bus-path')).toBeUndefined();
    });
});

describe('parseDeviceBlock', () => {
    it('returns null for blocks without a `Name:` field (e.g. blank trailing block)', () => {
        expect(parseDeviceBlock('', 'source')).toBeNull();
        expect(parseDeviceBlock('Description: nothing here', 'source')).toBeNull();
    });
    it('skips `.monitor` sources but keeps real sources', () => {
        const monitor = `Name: alsa_output.usb-mono.monitor\nChannel Map: mono`;
        const real = `Name: alsa_input.usb-mono\nChannel Map: mono`;
        expect(parseDeviceBlock(monitor, 'source')).toBeNull();
        expect(parseDeviceBlock(real, 'source')).not.toBeNull();
    });
    it('skips Media Router-owned modules (MR_PW_ prefix)', () => {
        const block = `Name: MR_PW_remap.module-1\nChannel Map: front-left,front-right`;
        expect(parseDeviceBlock(block, 'source')).toBeNull();
        expect(parseDeviceBlock(block, 'sink')).toBeNull();
    });
    it('returns a SUSPENDED device with channels but no sample rate — critical for the audio-input flow which probes just-selected devices that are still suspended', () => {
        const block = `Name: alsa_input.usb-mono\nDescription: USB PnP Mono\nChannel Map: mono`;
        const dev = parseDeviceBlock(block, 'source');
        expect(dev).not.toBeNull();
        expect(dev!.channels).toBe(1);
        expect(dev!.sampleRate).toBeUndefined();
        expect(dev!.description).toBe('USB PnP Mono');
    });
    it('carries per-channel volumes through so the normalizer can act on them', () => {
        const block = [
            'Name: alsa_output.usb-shure',
            'Channel Map: front-left,front-right',
            '\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB',
        ].join('\n');
        expect(parseDeviceBlock(block, 'sink')!.volumes).toEqual([26214, 26214]);
    });
    it('falls back to `name` for description when missing', () => {
        const block = `Name: alsa_input.foo\nChannel Map: mono`;
        const dev = parseDeviceBlock(block, 'source');
        expect(dev!.description).toBe('alsa_input.foo');
    });
    it('honours the `direction` argument so the same parser handles sources and sinks', () => {
        const block = `Name: alsa_output.foo\nChannel Map: mono`;
        expect(parseDeviceBlock(block, 'source')!.direction).toBe('source');
        expect(parseDeviceBlock(block, 'sink')!.direction).toBe('sink');
    });
    it('keeps a `.monitor` entry when listing sinks (the `.monitor` skip is source-only — sinks are never monitors)', () => {
        // Note: sinks don't have `.monitor` siblings — they ARE the
        // master devices that monitors hang off. `.monitor` would only
        // appear in the source list, so the skip is direction-scoped.
        const block = `Name: alsa_output.foo.monitor\nChannel Map: front-left,front-right`;
        // In the sink direction this name shouldn't appear, but if it
        // did we wouldn't filter it out — that's intentional.
        expect(parseDeviceBlock(block, 'sink')).not.toBeNull();
    });
    it("carries the card's serial and bus path; the label still comes from `Description:`", () => {
        const dev = parseDeviceBlock(PACTL_SINKS.split('\n\n')[1], 'sink')!;
        expect(dev).toMatchObject({
            name: MVX2U_SINK_NAMES[1],
            description: 'Shure MVX2U Analog Stereo', // not the card's `device.description`
            serial: 'Shure_Inc_Shure_MVX2U_MVX2U#3-c7555f279c87c75188277333d4fadb32',
            busPath: 'platform-xhci-hcd.0-usb-0:1:1.1',
            channels: 2,
        });
    });
    it('leaves serial and bus path unset for a device without card properties', () => {
        const dev = parseDeviceBlock(`Name: alsa_output.foo\nChannel Map: mono`, 'sink')!;
        expect(dev.serial).toBeUndefined();
        expect(dev.busPath).toBeUndefined();
    });
});

describe('AudioDeviceOps on two Shure MVX2U (.24 field listing)', () => {
    it('lists each unit once per direction with its serial; monitors and MR_PW_ nodes stay out', () => {
        const devices = new AudioDeviceOps(pactlTwinQueue() as never).listDevices();
        const serials = MVX2U_UNITS.map((u) => `Shure_Inc_Shure_MVX2U_MVX2U#3-${u.hash}`);
        expect(devices.map((d) => [d.direction, d.name, d.serial])).toEqual([
            ['source', MVX2U_MIC_NAMES[0], serials[0]],
            ['source', MVX2U_MIC_NAMES[1], serials[1]],
            ['sink', MVX2U_SINK_NAMES[0], serials[0]],
            ['sink', MVX2U_SINK_NAMES[1], serials[1]],
        ]);
    });
});

describe('AudioDeviceOps listing cache', () => {
    const SOURCES = [
        'Source #1',
        '\tName: alsa_input.usb-mic',
        '\tDescription: USB Mic',
        '\tChannel Map: front-left,front-right',
    ].join('\n');
    const SINKS = [
        'Sink #2',
        '\tName: alsa_output.usb-dac',
        '\tDescription: USB DAC',
        '\tChannel Map: front-left,front-right',
    ].join('\n');

    function makeOps(cacheTtlMs?: number) {
        let t = 1_000_000;
        const execImmediate = vi.fn((args: string[]) => (args[1] === 'sources' ? SOURCES : SINKS));
        const queue = { execImmediate, onMutation: null as (() => void) | null };
        const ops = new AudioDeviceOps(queue as never, { cacheTtlMs, now: () => t });
        return { ops, execImmediate, queue, advance: (ms: number) => (t += ms) };
    }

    it('reuses one pactl snapshot for every reader inside the TTL', () => {
        const { ops, execImmediate } = makeOps();
        expect(ops.hasDevice('alsa_input.usb-mic')).toBe(true);
        expect(ops.getDeviceInfo('alsa_output.usb-dac')?.channels).toBe(2);
        expect(ops.listDevices()).toHaveLength(2);
        // sources + sinks, once — not once per reader.
        expect(execImmediate).toHaveBeenCalledTimes(2);
    });

    it('re-fetches once the TTL has elapsed (hot-plug is still seen)', () => {
        const { ops, execImmediate, advance } = makeOps();
        ops.listDevices();
        advance(DEFAULT_DEVICE_CACHE_TTL_MS - 1);
        ops.listDevices();
        expect(execImmediate).toHaveBeenCalledTimes(2);
        advance(1);
        ops.listDevices();
        expect(execImmediate).toHaveBeenCalledTimes(4);
    });

    it('drops the snapshot when a queued (mutating) pactl command settles', () => {
        const { ops, execImmediate, queue } = makeOps();
        ops.listDevices();
        expect(queue.onMutation).toBeTypeOf('function');
        queue.onMutation!();
        ops.listDevices();
        expect(execImmediate).toHaveBeenCalledTimes(4);
    });

    it('hands out a copy, so a caller mutating the list cannot poison later readers', () => {
        const { ops } = makeOps();
        ops.listDevices().length = 0;
        expect(ops.listDevices()).toHaveLength(2);
    });

    it('caches nothing when cacheTtlMs is 0', () => {
        const { ops, execImmediate } = makeOps(0);
        ops.listDevices();
        ops.listDevices();
        expect(execImmediate).toHaveBeenCalledTimes(4);
    });
});
