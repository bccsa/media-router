import { describe, it, expect } from 'vitest';
import {
    parseDeviceBlock,
    parseDeviceChannels,
    parseDeviceSampleRate,
} from './AudioDeviceOps.js';

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
});
