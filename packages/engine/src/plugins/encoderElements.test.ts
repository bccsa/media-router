import { describe, expect, it } from 'vitest';

import { buildEncoderBranch, buildV4l2ExtraControls } from './encoderElements';

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

describe('buildV4l2ExtraControls', () => {
    it('pins VBR (mode=0) and sets both GOP controls plus repeat_sequence_header', () => {
        // mode=1 (CBR) throttles the bcm2835 encoder to ~10 fps on live input
        // — see buildV4l2ExtraControls. There is deliberately no way to ask
        // this helper for CBR.
        expect(buildV4l2ExtraControls('h264', 3_000_000, 60)).toBe(
            'controls,video_bitrate=3000000,video_bitrate_mode=0,' +
                'repeat_sequence_header=1,video_gop_size=60,h264_i_frame_period=60',
        );
    });

    it('h265 keys its own i-frame-period field', () => {
        expect(buildV4l2ExtraControls('h265', 1_500_000, 50)).toBe(
            'controls,video_bitrate=1500000,video_bitrate_mode=0,' +
                'repeat_sequence_header=1,video_gop_size=50,h265_i_frame_period=50',
        );
    });

    it('buildEncoderBranch embeds the helper output and declares level 4.2 (1080p50 passes STREAMON validation)', () => {
        const branch = buildEncoderBranch({
            codec: 'h264',
            impl: 'v4l2',
            bitrateKbps: 3000,
            kif: 60,
            name: 'venc0',
        });
        expect(branch).toContain(
            `extra-controls="${buildV4l2ExtraControls('h264', 3_000_000, 60)}"`,
        );
        expect(branch).toContain('video/x-h264,level=(string)4.2 ! h264parse');
    });

    it('rateControl=cbr does not reach the v4l2 driver (VBR stays pinned)', () => {
        const branch = buildEncoderBranch({
            codec: 'h264',
            impl: 'v4l2',
            bitrateKbps: 3000,
            kif: 60,
            name: 'venc0',
            rateControl: 'cbr',
        });
        expect(branch).toContain('video_bitrate_mode=0');
    });
});
