import { describe, it, expect } from 'vitest';
import { mixMatrixClause } from './channelMapMatrix.js';

describe('mixMatrixClause / per-connection channel maps', () => {
    it('renders identity-with-gain entries as a [dst][src] matrix', () => {
        const clause = mixMatrixClause(
            [
                { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                { srcChannel: 1, dstChannel: 1 },
            ],
            2,
            2,
        );
        expect(clause).toBe(
            ' mix-matrix="<<(float)0.5000, (float)0.0000>, <(float)0.0000, (float)1.0000>>"',
        );
    });

    it('mono→stereo fan-out and stereo→mono downmix', () => {
        expect(
            mixMatrixClause(
                [
                    { srcChannel: 0, dstChannel: 0 },
                    { srcChannel: 0, dstChannel: 1 },
                ],
                1,
                2,
            ),
        ).toBe(' mix-matrix="<<(float)1.0000>, <(float)1.0000>>"');
        expect(
            mixMatrixClause(
                [
                    { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                    { srcChannel: 1, dstChannel: 0, gain: 0.5 },
                ],
                2,
                1,
            ),
        ).toBe(' mix-matrix="<<(float)0.5000, (float)0.5000>>"');
    });

    it('ignores out-of-range entries and non-finite gains', () => {
        const clause = mixMatrixClause(
            [
                { srcChannel: 7, dstChannel: 0 },
                { srcChannel: -1, dstChannel: 1 },
                { srcChannel: 0, dstChannel: 0, gain: Number.NaN },
            ],
            2,
            2,
        );
        expect(clause).toBe(
            ' mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)0.0000, (float)0.0000>>"',
        );
    });
});
