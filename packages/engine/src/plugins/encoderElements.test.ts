import { describe, expect, it } from 'vitest';

import { buildEncoderBranch, buildV4l2ExtraControls, readQvbrQuality } from './encoderElements';

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

describe('buildEncoderBranch QVBR (bitrate = ceiling)', () => {
    const base = { bitrateKbps: 4841, kif: 50, name: 'venc_0' } as const;

    it('VA-API h264: driver QVBR, target-percentage=100 so bitrate is the peak, cpb = bitrate x cpbSeconds', () => {
        expect(
            buildEncoderBranch({ ...base, codec: 'h264', impl: 'va', rateControl: 'qvbr' }),
        ).toBe(
            'vah264enc name=venc_0 bitrate=4841 rate-control=qvbr target-percentage=100 qpi=25 target-usage=7 key-int-max=50 b-frames=0 cpb-size=4841 ! h264parse config-interval=1',
        );
    });

    it('VA-API h265 carries the quality and a cpb from the 1x cap, not 1.5x', () => {
        const s = buildEncoderBranch({
            ...base,
            codec: 'h265',
            impl: 'va',
            bitrateKbps: 16000,
            rateControl: 'qvbr',
            quality: 20,
            cpbSeconds: 0.5,
        });
        expect(s).toContain('rate-control=qvbr target-percentage=100 qpi=20');
        expect(s).toContain('cpb-size=8000');
    });

    it('VA-API av1 has no QVBR: falls back to CBR so the bitrate stays a ceiling', () => {
        const s = buildEncoderBranch({ ...base, codec: 'av1', impl: 'va', rateControl: 'qvbr' });
        expect(s).toContain('rate-control=cbr');
        expect(s).not.toContain('qpi');
    });

    it('x264: capped CRF through pass=qual, cap and buffer via properties', () => {
        expect(
            buildEncoderBranch({
                ...base,
                codec: 'h264',
                impl: 'software',
                rateControl: 'qvbr',
                quality: 23,
                cpbSeconds: 0.4,
                h264Profile: 'high',
            }),
        ).toBe(
            'x264enc name=venc_0 tune=zerolatency bitrate=4841 pass=qual quantizer=23 vbv-buf-capacity=400 speed-preset=ultrafast key-int-max=50 bframes=0 option-string="scenecut=40" ! video/x-h264,profile=high ! h264parse config-interval=1',
        );
    });

    it('x264 clamps the quality to x264enc quantizer max 50', () => {
        const s = buildEncoderBranch({
            ...base,
            codec: 'h264',
            impl: 'software',
            rateControl: 'qvbr',
            quality: 51,
        });
        expect(s).toContain('quantizer=50');
    });

    it('x265: capped CRF in the option-string', () => {
        const s = buildEncoderBranch({
            ...base,
            codec: 'h265',
            impl: 'software',
            rateControl: 'qvbr',
            quality: 28,
        });
        expect(s).toContain('option-string="crf=28:vbv-maxrate=4841:vbv-bufsize=4841:scenecut=40"');
        expect(s).not.toContain('strict-cbr');
    });

    it('v4l2 ignores QVBR exactly as it ignores CBR (VBR pinned)', () => {
        const opts = { ...base, codec: 'h264', impl: 'v4l2' } as const;
        expect(buildEncoderBranch({ ...opts, rateControl: 'qvbr' })).toBe(
            buildEncoderBranch({ ...opts, rateControl: 'cbr' }),
        );
    });

    it('svtav1 keeps its existing target-bitrate behaviour', () => {
        const opts = { ...base, codec: 'av1', impl: 'software' } as const;
        expect(buildEncoderBranch({ ...opts, rateControl: 'qvbr' })).toBe(
            buildEncoderBranch({ ...opts, rateControl: 'cbr' }),
        );
    });

    it('VA-API CBR and VBR strings are unchanged', () => {
        expect(buildEncoderBranch({ ...base, codec: 'h264', impl: 'va' })).toBe(
            'vah264enc name=venc_0 bitrate=4841 rate-control=cbr target-usage=7 key-int-max=50 b-frames=0 cpb-size=4841 ! h264parse config-interval=1',
        );
        expect(buildEncoderBranch({ ...base, codec: 'h264', impl: 'va', rateControl: 'vbr' })).toBe(
            'vah264enc name=venc_0 bitrate=4841 rate-control=vbr target-usage=7 key-int-max=50 b-frames=0 cpb-size=7262 ! h264parse config-interval=1',
        );
    });
});

describe('readQvbrQuality', () => {
    it('rounds and clamps to 1–51; blank or junk is undefined', () => {
        expect(readQvbrQuality(24.6)).toBe(25);
        expect(readQvbrQuality('30')).toBe(30);
        expect(readQvbrQuality(0)).toBe(1);
        expect(readQvbrQuality(80)).toBe(51);
        expect(readQvbrQuality('')).toBeUndefined();
        expect(readQvbrQuality(undefined)).toBeUndefined();
        expect(readQvbrQuality('abc')).toBeUndefined();
    });
});
