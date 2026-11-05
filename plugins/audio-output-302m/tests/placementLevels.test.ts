import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChannelMapEntry } from '@media-router/engine';
import {
    expectedRms,
    levelRigSkip,
    measure,
    removeRigRegistry,
    type Shape,
    type ToneSource,
} from './levelRig.js';

/** B-214 (MR-052, MR-053, MR-056): every placement shape of the Audio Output (302M), its own
 *  launch text through real GStreamer, read by a level meter where the sink would be: signal on
 *  exactly the expected stream channels at the expected gain, silence on every other. */

/** Where an unmapped stereo source plays in a mix of N (m[dst][src]): GStreamer's own channel
 *  mixer, measured on b9c24948's output pipeline (wf13/c35/default-head.jsonl); B-214 keeps it. */
const STEREO_DEFAULT: Record<number, number[][]> = {
    1: [[0.5, 0.5]],
    2: [
        [1, 0],
        [0, 1],
    ],
    3: [
        [0.5, 0],
        [0, 0.5],
        [0.5, 0.5],
    ],
    4: [
        [1, 0],
        [0, 1],
        [0.5, 0],
        [0, 0.5],
    ],
    5: [
        [0.7071, 0],
        [0, 0.7071],
        [0.5, 0.5],
        [0.3536, 0],
        [0, 0.3536],
    ],
    6: [
        [0.5, 0],
        [0, 0.5],
        [0.3536, 0.3536],
        [0.5, 0.5],
        [0.25, 0],
        [0, 0.25],
    ],
    7: [
        [0.5, 0],
        [0, 0.5],
        [0.3536, 0.3536],
        [0.5, 0.5],
        [0.25, 0],
        [0, 0.25],
        [0.25, 0.25],
    ],
    8: [
        [0.5, 0],
        [0, 0.5],
        [0.3536, 0.3536],
        [0.5, 0.5],
        [0.25, 0],
        [0, 0.25],
        [0.3536, 0],
        [0, 0.3536],
    ],
};
/** The same for the wider wires this test plays (`wire/mix`), measured alike; an 8-channel wire
 *  played into an 8-channel mix only, and goes channel for channel (B-214). */
const WIDE_DEFAULT: Record<string, number[][]> = {
    '4/2': [
        [0.6667, 0, 0.3333, 0],
        [0, 0.6667, 0, 0.3333],
    ],
    '6/2': [
        [0.3118, 0, 0.2205, 0.3118, 0.1559, 0],
        [0, 0.3118, 0.2205, 0.3118, 0, 0.1559],
    ],
    '6/4': [
        [0.3694, 0, 0.2612, 0.3694, 0, 0],
        [0, 0.3694, 0.2612, 0.3694, 0, 0],
        [0, 0, 0, 0.2612, 0.3694, 0],
        [0, 0, 0, 0.2612, 0, 0.3694],
    ],
};
const measuredDefault = (wire: number, mix: number): ChannelMapEntry[] => {
    const table =
        wire === 2
            ? STEREO_DEFAULT[mix]
            : (WIDE_DEFAULT[`${wire}/${mix}`] ??
              Array.from({ length: mix }, (_, d) =>
                  Array.from({ length: wire }, (_, s) => (s === d ? 1 : 0)),
              ));
    return table.flatMap((row, dstChannel) =>
        row.map((gain, srcChannel) => ({ srcChannel, dstChannel, gain })),
    );
};

/** The legacy positioned stream, by the rule: the default range on a device of 2 channels or
 *  fewer, or of unknown width. */
const legacy = (s: Shape) =>
    s.firstChannel === 1 && s.channels <= 2 && (s.deviceChannels === null || s.deviceChannels <= 2);

/** Each source a tone of its own, left at full and right at half level (so a swap shows). */
function sources(count: number, mapped: boolean, channels: number): ToneSource[] {
    return Array.from({ length: count }, (_, i) => ({
        wire: 2,
        gains: [1, 0.5],
        freq: 300 + 200 * i,
        ...(mapped ? { map: [{ srcChannel: 0, dstChannel: i % channels }] } : {}),
    }));
}

const label = (s: Shape) =>
    `${s.channels} from ${s.firstChannel} on ${s.deviceChannels ?? '?'}, ` +
    `${s.sources.length} source(s) ${s.sources[0]?.wire} wide${s.sources[0]?.map ? ', mapped' : ''}`;

/** What is wrong with each shape's stream; [] when every shape plays as expected. */
async function check(shapes: Shape[]): Promise<string[]> {
    const read = await measure(shapes);
    const wrong: string[] = [];
    shapes.forEach((s, i) => {
        const want = expectedRms(s, legacy(s), measuredDefault);
        const got = read[i];
        if (got === undefined) return wrong.push(`${label(s)}: refused by the module`);
        if (got === null) return wrong.push(`${label(s)}: plays nothing (no meter reading)`);
        if (got.length !== want.length) {
            return wrong.push(`${label(s)}: a ${got.length}-wide stream, want ${want.length}`);
        }
        want.forEach((w, c) => {
            const ok = Number.isFinite(w) ? Math.abs(got[c] - w) <= 0.5 : got[c] < -90;
            if (!ok) {
                const wantText = Number.isFinite(w) ? `${w.toFixed(2)} dB` : 'silence';
                wrong.push(`${label(s)}: channel ${c + 1} ${got[c]} dB, want ${wantText}`);
            }
        });
    });
    return wrong;
}

const skip = levelRigSkip();

beforeAll(() => {
    if (skip) console.warn(`[B-214] placement level test skipped — ${skip}`);
});

afterAll(() => removeRigRegistry());

describe.skipIf(skip !== null)('Audio Output (302M) placement, at the level meter (B-214)', () => {
    it('every width 1–8 from every legal first channel, on devices of 2, 4 and 32 channels', async () => {
        const shapes: Shape[] = [];
        for (const deviceChannels of [2, 4, 32]) {
            for (let channels = 1; channels <= 8; channels++) {
                for (let first = 1; first - 1 + channels <= deviceChannels; first++) {
                    shapes.push({
                        channels,
                        firstChannel: first,
                        deviceChannels,
                        sources: sources(1, false, channels),
                    });
                }
            }
        }
        expect(shapes).toHaveLength(241);
        expect(await check(shapes)).toEqual([]);
    }, 600_000);

    it("the field's shapes and every shape the code tells apart, with 1, 2 and 4 sources, mapped and not", async () => {
        const ranges: Array<[number, number, number | null]> = [
            [4, 1, 32], // MR-056: OUT1-4, the four Master feeds on AES50 1-4
            [2, 1, 32], // the workaround's OUT1-2
            [2, 3, 32], // and OUT3-4
            [1, 1, 32], // MR-052: ENG mono on channel 1
            [1, 2, 32],
            [1, 3, 32],
            [1, 4, 32],
            [8, 1, 32],
            [3, 1, 4],
            [8, 25, 32],
            [2, 1, 2], // a translation station's SSL 2: the legacy stream
            [1, 1, 2],
            [1, 2, 2],
            [2, 1, null], // a device of unknown width keeps the legacy stream
        ];
        const shapes: Shape[] = [];
        for (const [channels, firstChannel, deviceChannels] of ranges) {
            for (const count of [1, 2, 4]) {
                for (const mapped of [false, true]) {
                    shapes.push({
                        channels,
                        firstChannel,
                        deviceChannels,
                        sources: sources(count, mapped, channels),
                    });
                }
            }
        }
        expect(await check(shapes)).toEqual([]);
    }, 600_000);

    it('an unmapped 4-, 6- or 8-channel wire in a placed mix plays where it played before (MR-053)', async () => {
        const shapes: Shape[] = [];
        for (const [channels, firstChannel] of [
            [4, 1],
            [2, 3],
        ]) {
            for (const wire of [4, 6, 8] as const) {
                const gains = Array.from({ length: wire }, (_, c) => 2 ** -(c % 4));
                shapes.push({
                    channels,
                    firstChannel,
                    deviceChannels: 32,
                    sources: [{ wire, gains, freq: 300 }],
                });
            }
        }
        expect(await check(shapes)).toEqual([]);
    }, 600_000);
});
