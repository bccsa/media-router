import { describe, it, expect } from 'vitest';
import { buildOutputPlacement } from './outputPlacement.js';

const DEV = 'alsa_output.usb-KLARK_TEKNIK_KT-USB_33793A14-00.multichannel-output';

/** `<(float)0.0000, …>` with 1.0000 in column `hot` (or none). */
function row(cols: number, hot: number | null): string {
    return (
        '<' +
        Array.from({ length: cols }, (_, c) =>
            c === hot ? '(float)1.0000' : '(float)0.0000',
        ).join(', ') +
        '>'
    );
}

describe('buildOutputPlacement', () => {
    it('keeps the legacy positioned stream for the default range, even when the width is known', () => {
        for (const deviceChannels of [null, 2, 32]) {
            expect(
                buildOutputPlacement({ device: DEV, channels: 2, firstChannel: 1, deviceChannels }),
            ).toEqual({ fragment: null });
            expect(
                buildOutputPlacement({ device: DEV, channels: 1, firstChannel: 1, deviceChannels }),
            ).toEqual({ fragment: null });
        }
    });

    it('places an 8-channel mix on outputs 9–16 of a 32-channel card: 16 wide (not 32), unpositioned, matrix', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 8,
            firstChannel: 9,
            deviceChannels: 32,
        });
        expect(r.error).toBeUndefined();
        const expectedRows = Array.from({ length: 16 }, (_, d) =>
            row(8, d >= 8 ? d - 8 : null),
        ).join(', ');
        expect(r.fragment).toBe(
            `audioconvert mix-matrix="<${expectedRows}>" ! audio/x-raw,channels=16,channel-mask=(bitmask)0x0`,
        );
    });

    it('places a stereo mix on outputs 3–4 of a 48-channel card as a 4-wide stream', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 2,
            firstChannel: 3,
            deviceChannels: 48,
        });
        expect(r.fragment).toBe(
            `audioconvert mix-matrix="<${[row(2, null), row(2, null), row(2, 0), row(2, 1)].join(', ')}>"` +
                ' ! audio/x-raw,channels=4,channel-mask=(bitmask)0x0',
        );
    });

    it('a mono output on channel 3 of a 48-channel card is a 3-wide stream', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 1,
            firstChannel: 3,
            deviceChannels: 48,
        });
        expect(r.fragment).toBe(
            `audioconvert mix-matrix="<${[row(1, null), row(1, null), row(1, 0)].join(', ')}>"` +
                ' ! audio/x-raw,channels=3,channel-mask=(bitmask)0x0',
        );
    });

    it('needs no matrix when the mix starts at channel 1 (8 from 1 on any wide card)', () => {
        for (const deviceChannels of [8, 48]) {
            expect(
                buildOutputPlacement({ device: DEV, channels: 8, firstChannel: 1, deviceChannels }),
            ).toEqual({
                fragment: 'audioconvert ! audio/x-raw,channels=8,channel-mask=(bitmask)0x0',
            });
        }
    });

    it('refuses a range past the device', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 8,
            firstChannel: 45,
            deviceChannels: 32,
        });
        expect(r.fragment).toBeUndefined();
        expect(r.error).toContain('has 32 channels — cannot play on 45–52');
    });

    it('refuses a non-default range when the device width is unknown', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 8,
            firstChannel: 9,
            deviceChannels: null,
        });
        expect(r.error).toContain('not enumerated by PipeWire');
        expect(r.error).toContain('9–16');
    });

    it('sanitises junk settings: width clamped to 1–8, first channel to ≥ 1', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 99,
            firstChannel: 0,
            deviceChannels: 32,
        });
        // 99 → 8 channels from channel 1 → 8 wide, no matrix.
        expect(r.fragment).toBe('audioconvert ! audio/x-raw,channels=8,channel-mask=(bitmask)0x0');
        expect(
            buildOutputPlacement({
                device: DEV,
                channels: Number.NaN,
                firstChannel: 1,
                deviceChannels: 32,
            }),
        ).toEqual({ fragment: null });
    });
});
