import { describe, expect, it } from 'vitest';

import { buildEncoderBranch } from './encoderElements';

describe('buildEncoderBranch HRD/CPB bound (cpbSeconds)', () => {
    it('VA-API h264 CBR sets cpb-size = bitrate x cpbSeconds (default 1 s)', () => {
        const s = buildEncoderBranch({
            codec: 'h264',
            impl: 'va',
            bitrateKbps: 5000,
            kif: 50,
            name: 'venc_0',
        });
        // Without an explicit cpb-size the driver "auto-calculates" — in
        // practice unbounded scene-cut IDRs (measured 409 KB at 5 Mbps CBR)
        // that a fixed-rate link delivers hundreds of ms late.
        expect(s).toContain('cpb-size=5000');
    });

    it('VA-API h264 honours a tighter cpbSeconds', () => {
        const s = buildEncoderBranch({
            codec: 'h264',
            impl: 'va',
            bitrateKbps: 5000,
            kif: 50,
            name: 'venc_0',
            cpbSeconds: 0.4,
        });
        expect(s).toContain('cpb-size=2000');
    });

    it('VA-API h265 gets the same bound', () => {
        const s = buildEncoderBranch({
            codec: 'h265',
            impl: 'va',
            bitrateKbps: 2000,
            kif: 50,
            name: 'venc_1',
            cpbSeconds: 0.5,
        });
        expect(s).toContain('cpb-size=1000');
    });

    it('x264 CBR keeps vbv-maxrate = bitrate and scales vbv-bufsize', () => {
        const s = buildEncoderBranch({
            codec: 'h264',
            impl: 'software',
            bitrateKbps: 500,
            kif: 50,
            name: 'venc_2',
            cpbSeconds: 0.5,
        });
        expect(s).toContain('nal-hrd=cbr:vbv-maxrate=500:vbv-bufsize=250');
    });

    it('x264 CBR default (1 s) is unchanged from the historical string', () => {
        const s = buildEncoderBranch({
            codec: 'h264',
            impl: 'software',
            bitrateKbps: 500,
            kif: 50,
            name: 'venc_2',
        });
        expect(s).toContain('nal-hrd=cbr:vbv-maxrate=500:vbv-bufsize=500');
    });

    it('VBR scales the buffer from the 1.5x rate cap', () => {
        const s = buildEncoderBranch({
            codec: 'h264',
            impl: 'software',
            bitrateKbps: 1000,
            kif: 50,
            name: 'venc_3',
            rateControl: 'vbr',
            cpbSeconds: 0.5,
        });
        expect(s).toContain('vbv-maxrate=1500:vbv-bufsize=750');
    });
});
