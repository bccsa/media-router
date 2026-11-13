import { describe, it, expect } from 'vitest';
import { buildEncoderBranch, type EncoderBranchOptions } from '@media-router/engine';

/**
 * The QVBR encoder strings `py/qvbr_encoders_test.py` launches on real
 * GStreamer (`vitest -u` rewrites the file): every `key=value` the builder
 * writes must read back from the element after a short encode — an
 * out-of-range value only logs CRITICAL and keeps the default, and VA-API
 * rewrites a cpb-size under max/2. Rungs at the ladder's real rates.
 */
const qvbr = (o: Partial<EncoderBranchOptions>): EncoderBranchOptions => ({
    codec: 'h264',
    impl: 'software',
    bitrateKbps: 4841,
    kif: 50,
    name: 'enc',
    rateControl: 'qvbr',
    ...o,
});

const CASES: Record<string, EncoderBranchOptions> = {
    'va-h264': qvbr({ impl: 'va', quality: 25 }),
    'va-h264-cpb0.4': qvbr({ impl: 'va', cpbSeconds: 0.4 }),
    'va-h264-fallback': qvbr({ impl: 'va', vaQvbr: false, cpbSeconds: 0.4 }),
    'va-h265': qvbr({ impl: 'va', codec: 'h265', bitrateKbps: 16000, quality: 28 }),
    'va-h265-cpb0.4': qvbr({ impl: 'va', codec: 'h265', bitrateKbps: 16000, cpbSeconds: 0.4 }),
    'va-av1': qvbr({ impl: 'va', codec: 'av1' }),
    x264: qvbr({ quality: 23, cpbSeconds: 0.5, h264Profile: 'main' }),
    x265: qvbr({ codec: 'h265', quality: 28, cpbSeconds: 0.5 }),
    svtav1: qvbr({ codec: 'av1', bitrateKbps: 2500 }),
};

describe('QVBR encoder plan', () => {
    it('tests/qvbr-encoders.json is what qvbr_encoders_test.py launches (`vitest -u` rewrites it)', async () => {
        const plan = Object.fromEntries(
            Object.entries(CASES).map(([k, o]) => [k, buildEncoderBranch(o)]),
        );
        await expect(`${JSON.stringify(plan, null, 2)}\n`).toMatchFileSnapshot(
            '../tests/qvbr-encoders.json',
        );
    });
});
