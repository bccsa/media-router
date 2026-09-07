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

    it('places an 8-channel mix on outputs 9–16 of a 32-channel card: whole width, unpositioned, matrix', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 8,
            firstChannel: 9,
            deviceChannels: 32,
        });
        expect(r.error).toBeUndefined();
        const expectedRows = Array.from({ length: 32 }, (_, d) =>
            row(8, d >= 8 && d < 16 ? d - 8 : null),
        ).join(', ');
        expect(r.fragment).toBe(
            `audioconvert mix-matrix="<${expectedRows}>" ! audio/x-raw,channels=32,channel-mask=(bitmask)0x0`,
        );
    });

    it('places a stereo mix on outputs 3–4', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 2,
            firstChannel: 3,
            deviceChannels: 4,
        });
        expect(r.fragment).toBe(
            `audioconvert mix-matrix="<${[row(2, null), row(2, null), row(2, 0), row(2, 1)].join(', ')}>"` +
                ' ! audio/x-raw,channels=4,channel-mask=(bitmask)0x0',
        );
    });

    it('needs no matrix when the mix IS the device', () => {
        expect(
            buildOutputPlacement({ device: DEV, channels: 8, firstChannel: 1, deviceChannels: 8 }),
        ).toEqual({ fragment: 'audioconvert ! audio/x-raw,channels=8,channel-mask=(bitmask)0x0' });
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
        // 99 → 8 channels from channel 1 → 8 == width? no (32) → matrix 32×8 from column 0.
        expect(r.fragment).toContain('mix-matrix=');
        expect(r.fragment).toContain('channels=32,channel-mask=(bitmask)0x0');
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
