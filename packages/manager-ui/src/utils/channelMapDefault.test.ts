import { describe, it, expect } from 'vitest';
// The engine's own table, by path: the browser bundle never imports a plugin.
import { default302mChannelMap } from '../../../../plugins/audio-302m-core/engine/defaultChannelMap';
import { default302mMap, gainDb } from './channelMapDefault';

describe('default302mMap', () => {
    it("is the engine's default map for every wire width into every mix width", () => {
        for (const src of [2, 4, 6, 8]) {
            for (let dst = 1; dst <= 8; dst++) {
                const engine = default302mChannelMap(src, dst).map((e) => ({
                    srcChannel: e.srcChannel,
                    dstChannel: e.dstChannel,
                    gain: e.gain ?? 1,
                }));
                expect(default302mMap(src, dst), `${src}/${dst}`).toEqual(engine);
            }
        }
    });

    it('a stereo source in a 4-channel output: channels 1 and 2, and 3 and 4 at half level', () => {
        expect(default302mMap(2, 4)).toEqual([
            { srcChannel: 0, dstChannel: 0, gain: 1 },
            { srcChannel: 1, dstChannel: 1, gain: 1 },
            { srcChannel: 0, dstChannel: 2, gain: 0.5 },
            { srcChannel: 1, dstChannel: 3, gain: 0.5 },
        ]);
    });
});

describe('gainDb', () => {
    it('reads a gain in dB', () => {
        expect(gainDb(1)).toBe('0 dB');
        expect(gainDb(0.5)).toBe('−6.0 dB');
        expect(gainDb(0.707107)).toBe('−3.0 dB');
        expect(gainDb(0)).toBe('muted');
    });
});
