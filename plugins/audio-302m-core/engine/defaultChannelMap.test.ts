import { describe, it, expect } from 'vitest';
import { default302mChannelMap } from './defaultChannelMap.js';

/** Where an unmapped source played before B-214 (m[dst][src], rms gain), measured on b9c24948's
 *  own output pipeline on the dev Pi, one source and two (`wf13/c35/default-head.jsonl`); null:
 *  it did not play at all (GStreamer converts the unpositioned 8-channel wire to no other width). */
const MEASURED: Record<string, number[][] | null> = {
    '2/1': [[0.5001, 0.5001]],
    '4/1': [[0.3331, 0.3331, 0.166, 0.166]],
    '6/1': [[0.2119, 0.2119, 0.1495, 0.2119, 0.1055, 0.1055]],
    '8/1': null,
    '2/2': [
        [1.0002, 0],
        [0, 1.0002],
    ],
    '4/2': [
        [0.6662, 0, 0.3331, 0],
        [0, 0.6662, 0, 0.3331],
    ],
    '6/2': [
        [0.3116, 0, 0.2198, 0.3116, 0.1553, 0],
        [0, 0.3116, 0.2198, 0.3116, 0, 0.1553],
    ],
    '8/2': null,
    '2/4': [
        [1.0002, 0],
        [0, 1.0002],
        [0.5001, 0],
        [0, 0.5001],
    ],
    '4/4': [
        [1.0002, 0, 0, 0],
        [0, 1.0002, 0, 0],
        [0, 0, 1.0002, 0],
        [0, 0, 0, 1.0002],
    ],
    '6/4': [
        [0.369, 0, 0.2607, 0.369, 0, 0],
        [0, 0.369, 0.2607, 0.369, 0, 0],
        [0, 0, 0, 0.2607, 0.369, 0],
        [0, 0, 0, 0.2607, 0, 0.369],
    ],
    '8/4': null,
    '2/8': [
        [0.5001, 0],
        [0, 0.5001],
        [0.3537, 0.3537],
        [0.5001, 0.5001],
        [0.2501, 0],
        [0, 0.2501],
        [0.3537, 0],
        [0, 0.3537],
    ],
    '4/8': [
        [0.2921, 0, 0, 0],
        [0, 0.2921, 0, 0],
        [0.207, 0.207, 0, 0],
        [0.2921, 0.2921, 0.207, 0.207],
        [0, 0, 0.2921, 0],
        [0, 0, 0, 0.2921],
        [0.1035, 0, 0.1035, 0],
        [0, 0.1035, 0, 0.1035],
    ],
    '6/8': [
        [1.0002, 0, 0, 0, 0, 0],
        [0, 1.0002, 0, 0, 0, 0],
        [0, 0, 1.0002, 0, 0, 0],
        [0, 0, 0, 1.0002, 0, 0],
        [0, 0, 0, 0, 1.0002, 0],
        [0, 0, 0, 0, 0, 1.0002],
        [0.3537, 0, 0, 0, 0.3537, 0],
        [0, 0.3537, 0, 0, 0, 0.3537],
    ],
    '8/8': Array.from({ length: 8 }, (_, d) =>
        Array.from({ length: 8 }, (_, s) => (s === d ? 1.0002 : 0)),
    ),
};

/** The map as a dense m[dst][src]. */
function dense(src: number, dst: number): number[][] {
    const m = Array.from({ length: dst }, () => new Array<number>(src).fill(0));
    for (const e of default302mChannelMap(src, dst)) m[e.dstChannel][e.srcChannel] = e.gain ?? 1;
    return m;
}

describe('default302mChannelMap (MR-053, B-214)', () => {
    it('plays an unmapped source where it played before, within 0.5 dB, and nowhere else', () => {
        for (const [key, measured] of Object.entries(MEASURED)) {
            if (!measured) continue;
            const [src, dst] = key.split('/').map(Number);
            dense(src, dst).forEach((row, d) =>
                row.forEach((gain, s) => {
                    const was = measured[d][s];
                    if (was === 0) expect(gain, `${key} [${d}][${s}]`).toBe(0);
                    else
                        expect(
                            Math.abs(20 * Math.log10(gain / was)),
                            `${key} [${d}][${s}]`,
                        ).toBeLessThan(0.5);
                }),
            );
        }
    });

    it('a stereo source in a 4-channel mix: channels 1 and 2, and 3 and 4 at half level', () => {
        expect(default302mChannelMap(2, 4)).toEqual([
            { srcChannel: 0, dstChannel: 0 },
            { srcChannel: 1, dstChannel: 1 },
            { srcChannel: 0, dstChannel: 2, gain: 0.5 },
            { srcChannel: 1, dstChannel: 3, gain: 0.5 },
        ]);
        expect(default302mChannelMap(2, 1)).toEqual([
            { srcChannel: 0, dstChannel: 0, gain: 0.5 },
            { srcChannel: 1, dstChannel: 0, gain: 0.5 },
        ]);
    });

    it('equal widths, and an 8-channel wire into any width, go channel for channel', () => {
        for (const w of [2, 4, 6, 8]) {
            expect(default302mChannelMap(w, w)).toEqual(
                Array.from({ length: w }, (_, i) => ({ srcChannel: i, dstChannel: i })),
            );
        }
        for (let dst = 1; dst <= 8; dst++) {
            expect(default302mChannelMap(8, dst)).toEqual(
                Array.from({ length: dst }, (_, i) => ({ srcChannel: i, dstChannel: i })),
            );
        }
    });

    it('covers every wire width into every mix width, each output channel fed and every cell in range', () => {
        for (const src of [2, 4, 6, 8]) {
            for (let dst = 1; dst <= 8; dst++) {
                const map = default302mChannelMap(src, dst);
                for (const e of map) {
                    expect(e.srcChannel).toBeLessThan(src);
                    expect(e.dstChannel).toBeLessThan(dst);
                    expect(e.gain ?? 1).toBeGreaterThan(0);
                    expect(e.gain ?? 1).toBeLessThanOrEqual(1);
                }
                const fed = new Set(map.map((e) => e.dstChannel));
                expect(fed.size, `${src}/${dst}`).toBe(dst);
            }
        }
    });
});
