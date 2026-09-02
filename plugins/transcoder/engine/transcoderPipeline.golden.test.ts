import { describe, it, expect } from 'vitest';
import { buildPipeline } from './transcoderPipeline.js';
import type { TranscoderOutput } from './transcoderPorts.js';

/**
 * Golden pipeline strings, captured VERBATIM from the pre-`buildEncodeLeaf`
 * builder (2026-08-31, v2.0.0.78) — the refactor onto the shared leaf is a pure
 * extraction, so the emitted gst-launch strings must not change by a byte.
 * If a deliberate pipeline change lands later, regenerate these strings and say
 * so in the commit; an unexplained diff here is a refactor regression.
 *
 * Deliberate regenerations since capture:
 *   - 2026-09-02: pre-tsparse jitter queue is now BACK-PRESSURING (leaky=0)
 *     — raw TS must never be shed mid-slice (buildTsUdpInput). The
 *     post-decoder raw-frame queue stays leaky=2.
 *   - 2026-09-02: v4l2 extra-controls pin VBR (video_bitrate_mode=0) and add
 *     repeat_sequence_header + video_gop_size — CBR stalls the bcm2835
 *     encoder live (buildV4l2ExtraControls).
 *   - 2026-08-31: v4l2h264enc caps level 4 → 4.2 (for 1080p50).
 *   - 2026-09-01: reverted to level 4 on a "4.2 caps drop the encoder to
 *     ~13 fps" measurement — later shown to be the CBR confound above.
 *   - 2026-09-02: level 4.2 re-landed (full rate under pinned VBR; kernel 6.12
 *     rejects 1080p50 at level 4 at STREAMON).
 */

const outputs: TranscoderOutput[] = [
    {
        port: 40100,
        portId: 'out-0',
        rendition: { name: 'HD', width: 1920, height: 1080, bitrate: 5000 },
        encode: {
            codec: 'h264',
            impl: 'v4l2',
            rateControl: 'cbr',
            speedPreset: 'superfast',
            h264Profile: 'auto',
            sceneCut: 40,
            cpbSeconds: 1,
        },
    },
    {
        port: 40101,
        portId: 'out-1',
        rendition: { name: 'SD', width: 854, height: 480, bitrate: 1200 },
        encode: {
            codec: 'h264',
            impl: 'software',
            rateControl: 'vbr',
            speedPreset: 'medium',
            h264Profile: 'baseline',
            sceneCut: 30,
            cpbSeconds: 0.5,
        },
    },
];

const base = {
    input: { port: 5000 },
    outputs,
    framerate: 25,
    gopFrames: 60,
    bufferMs: 700,
    decodeThreads: 'multi' as const,
    deinterlace: 'off' as const,
};

const GOLDEN_V4L2_SCALER =
    'unixfdsrc socket-path=/tmp/mr-bus-5000.sock ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! queue leaky=0 max-size-time=700000000 max-size-buffers=0 max-size-bytes=0 ! tsparse set-timestamps=false ! tsdemux name=demux latency=0 ! capsfilter caps="video/x-h264" ! h264parse ! avdec_h264 thread-type=frame max-threads=3 ! queue leaky=2 max-size-time=700000000 max-size-buffers=0 max-size-bytes=0 ! videorate ! video/x-raw,framerate=25/1 ! tee name=t t. ! queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! v4l2convert ! video/x-raw,width=1920,height=1080 ! v4l2h264enc name=venc_0 extra-controls="controls,video_bitrate=5000000,video_bitrate_mode=0,repeat_sequence_header=1,video_gop_size=60,h264_i_frame_period=60" ! video/x-h264,level=(string)4.2 ! h264parse config-interval=1 ! mpegtsmux name=mux_0 latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_40100 allow-not-linked=true t. ! queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videoscale ! video/x-raw,width=854,height=480 ! videoconvert ! x264enc name=venc_1 tune=zerolatency bitrate=1200 speed-preset=medium key-int-max=60 bframes=0 interlaced=true option-string="vbv-maxrate=1800:vbv-bufsize=900:scenecut=30" ! video/x-h264,profile=baseline ! h264parse config-interval=1 ! mpegtsmux name=mux_1 latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_40101 allow-not-linked=true';

const GOLDEN_VA_SCALER =
    'unixfdsrc socket-path=/tmp/mr-bus-5000.sock ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! queue leaky=0 max-size-time=700000000 max-size-buffers=0 max-size-bytes=0 ! tsparse set-timestamps=false ! tsdemux name=demux latency=0 ! capsfilter caps="video/x-h264" ! h264parse ! avdec_h264 thread-type=frame max-threads=3 ! queue leaky=2 max-size-time=700000000 max-size-buffers=0 max-size-bytes=0 ! videorate ! video/x-raw,framerate=25/1 ! tee name=t t. ! queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videoscale ! video/x-raw,width=1920,height=1080 ! videoconvert ! v4l2h264enc name=venc_0 extra-controls="controls,video_bitrate=5000000,video_bitrate_mode=0,repeat_sequence_header=1,video_gop_size=60,h264_i_frame_period=60" ! video/x-h264,level=(string)4.2 ! h264parse config-interval=1 ! mpegtsmux name=mux_0 latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_40100 allow-not-linked=true t. ! queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videoscale ! video/x-raw,width=854,height=480 ! videoconvert ! x264enc name=venc_1 tune=zerolatency bitrate=1200 speed-preset=medium key-int-max=60 bframes=0 interlaced=true option-string="vbv-maxrate=1800:vbv-bufsize=900:scenecut=30" ! video/x-h264,profile=baseline ! h264parse config-interval=1 ! mpegtsmux name=mux_1 latency=0 alignment=7 ! capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_40101 allow-not-linked=true';

describe('transcoderPipeline golden strings (pre-refactor capture)', () => {
    it('v4l2 hw scaler available: byte-identical to the pre-refactor builder', () => {
        const res = buildPipeline({ ...base, hwScalers: { va: false, v4l2: true } });
        expect(res!.pipeline).toBe(GOLDEN_V4L2_SCALER);
        expect(res!.sinkNames).toEqual(['busout_40100', 'busout_40101']);
    });

    it('va hw scaler available: byte-identical to the pre-refactor builder', () => {
        const res = buildPipeline({ ...base, hwScalers: { va: true, v4l2: false } });
        expect(res!.pipeline).toBe(GOLDEN_VA_SCALER);
        expect(res!.sinkNames).toEqual(['busout_40100', 'busout_40101']);
    });
});
