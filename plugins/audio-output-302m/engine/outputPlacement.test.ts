import { describe, it, expect } from 'vitest';
import { buildOutputPlacement } from './outputPlacement.js';

const DEV = 'alsa_output.usb-KLARK_TEKNIK_KT-USB_33793A14-00.multichannel-output';
const RELABEL = 'capssetter caps="audio/x-raw,channel-mask=(bitmask)0x0"';

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

/** The placement of `channels` from `first`: the pinned mix relabelled (two or more channels), its
 *  matrix onto a stream as wide as the last channel (2 at least), unpositioned. */
function placed(channels: number, first: number): string {
    const width = Math.max(first - 1 + channels, 2);
    const rows = Array.from({ length: width }, (_, d) => {
        const src = d - (first - 1);
        return row(channels, src >= 0 && src < channels ? src : null);
    });
    return (
        (channels > 1 ? `${RELABEL} ! ` : '') +
        `audioconvert mix-matrix="<${rows.join(', ')}>"` +
        ` ! audio/x-raw,channels=${width},channel-mask=(bitmask)0x0`
    );
}

describe('buildOutputPlacement', () => {
    it('every width and legal first channel on devices of 2, 4 and 32: legacy only for the default range of a stereo device', () => {
        let shapes = 0;
        for (const deviceChannels of [2, 4, 32]) {
            for (let channels = 1; channels <= 8; channels++) {
                for (let first = 1; first - 1 + channels <= deviceChannels; first++) {
                    const r = buildOutputPlacement({
                        device: DEV,
                        channels,
                        firstChannel: first,
                        deviceChannels,
                    });
                    const legacy = deviceChannels <= 2 && first === 1 && channels <= 2;
                    expect(r, `${channels} from ${first} on ${deviceChannels}`).toEqual({
                        fragment: legacy ? null : placed(channels, first),
                    });
                    shapes++;
                }
            }
        }
        // 3 on the stereo device, 10 on the 4-channel one, 228 on the 32-channel one.
        expect(shapes).toBe(241);
    });

    it('MR-052: a mono or stereo output on channel 1 of a wider device is placed, a stereo device keeps its string', () => {
        for (const deviceChannels of [1, 2]) {
            for (const channels of [1, 2]) {
                expect(
                    buildOutputPlacement({
                        device: DEV,
                        channels,
                        firstChannel: 1,
                        deviceChannels,
                    }),
                ).toEqual({ fragment: null });
            }
        }
        // Mono on 1 of the AUX card: channel 1 of a 2-wide stream, channel 2 silent.
        expect(
            buildOutputPlacement({ device: DEV, channels: 1, firstChannel: 1, deviceChannels: 4 })
                .fragment,
        ).toBe(
            `audioconvert mix-matrix="<<(float)1.0000>, <(float)0.0000>>"` +
                ' ! audio/x-raw,channels=2,channel-mask=(bitmask)0x0',
        );
        expect(
            buildOutputPlacement({ device: DEV, channels: 2, firstChannel: 1, deviceChannels: 32 })
                .fragment,
        ).toBe(placed(2, 1));
    });

    it("MR-056: 4 from 1 (the field's OUT1-4) relabels its mix and places it by an identity matrix", () => {
        expect(
            buildOutputPlacement({ device: DEV, channels: 4, firstChannel: 1, deviceChannels: 32 })
                .fragment,
        ).toBe(
            `${RELABEL} ! audioconvert mix-matrix="<${[0, 1, 2, 3].map((c) => row(4, c)).join(', ')}>"` +
                ' ! audio/x-raw,channels=4,channel-mask=(bitmask)0x0',
        );
    });

    it('a device of unknown width: the default range keeps the legacy stream, any other range is refused', () => {
        for (const channels of [1, 2]) {
            expect(
                buildOutputPlacement({
                    device: DEV,
                    channels,
                    firstChannel: 1,
                    deviceChannels: null,
                }),
            ).toEqual({ fragment: null });
        }
        for (const [channels, first] of [
            [3, 1],
            [1, 2],
            [8, 9],
        ]) {
            const r = buildOutputPlacement({
                device: DEV,
                channels,
                firstChannel: first,
                deviceChannels: null,
            });
            expect(r.fragment).toBeUndefined();
            expect(r.error).toContain('not enumerated by PipeWire');
        }
        expect(
            buildOutputPlacement({
                device: DEV,
                channels: 8,
                firstChannel: 9,
                deviceChannels: null,
            }).error,
        ).toContain('9–16');
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
            `${RELABEL} ! audioconvert mix-matrix="<${expectedRows}>"` +
                ' ! audio/x-raw,channels=16,channel-mask=(bitmask)0x0',
        );
    });

    it('a mono output keeps its string on any channel past the first (no relabel: one channel is mono)', () => {
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

    it('refuses a range past the device', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 8,
            firstChannel: 45,
            deviceChannels: 32,
        });
        expect(r.fragment).toBeUndefined();
        expect(r.error).toContain('has 32 channels — cannot play on 45–52');
        expect(
            buildOutputPlacement({ device: DEV, channels: 4, firstChannel: 2, deviceChannels: 4 })
                .error,
        ).toContain('has 4 channels — cannot play on 2–5');
    });

    it('a mono output past the device names the one channel, not a pair', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 1,
            firstChannel: 3,
            deviceChannels: 2,
        });
        expect(r.error).toContain('has 2 channels — cannot play on 3');
        expect(r.error).not.toContain('3–');
    });

    it('sanitises junk settings: width clamped to 1–8, first channel to ≥ 1', () => {
        const r = buildOutputPlacement({
            device: DEV,
            channels: 99,
            firstChannel: 0,
            deviceChannels: 32,
        });
        // 99 → 8 channels from channel 1 → 8 wide.
        expect(r.fragment).toBe(placed(8, 1));
        expect(
            buildOutputPlacement({
                device: DEV,
                channels: Number.NaN,
                firstChannel: 1,
                deviceChannels: 2,
            }),
        ).toEqual({ fragment: null });
        expect(
            buildOutputPlacement({
                device: DEV,
                channels: Number.NaN,
                firstChannel: 1,
                deviceChannels: 32,
            }).fragment,
        ).toBe(placed(2, 1));
    });
});
