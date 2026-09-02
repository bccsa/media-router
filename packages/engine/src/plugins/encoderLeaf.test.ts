import { describe, it, expect } from 'vitest';
import { buildEncodeLeaf } from './encoderLeaf.js';
import { buildEncoderBranch, type EncoderBranchOptions } from './encoderElements.js';

const encoder: EncoderBranchOptions = {
    codec: 'h264',
    impl: 'software',
    bitrateKbps: 2500,
    kif: 60,
    name: 'venc_0',
};

describe('buildEncodeLeaf', () => {
    it("'decoder-pool' emits the bounded leaky head queue", () => {
        const leaf = buildEncodeLeaf({
            encoder,
            inputQueue: 'decoder-pool',
            muxName: 'mux_0',
            sink: 'fakesink',
        });
        expect(
            leaf.startsWith('queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! '),
        ).toBe(true);
    });

    it("'none' emits no head queue at all", () => {
        const leaf = buildEncodeLeaf({
            encoder,
            inputQueue: 'none',
            muxName: 'mux',
            sink: 'fakesink',
        });
        expect(leaf.startsWith('x264enc ')).toBe(true);
        expect(leaf).not.toContain('queue');
    });

    it('includes the scale stage between queue and encoder when given', () => {
        const leaf = buildEncodeLeaf({
            encoder,
            inputQueue: 'decoder-pool',
            scaleStage: 'videoscale ! video/x-raw,width=854,height=480 ! videoconvert',
            muxName: 'mux_0',
            sink: 'fakesink',
        });
        expect(leaf).toContain(
            'max-size-bytes=0 ! videoscale ! video/x-raw,width=854,height=480 ! videoconvert ! x264enc',
        );
    });

    it('forwards encoder options verbatim to buildEncoderBranch', () => {
        const leaf = buildEncodeLeaf({
            encoder,
            inputQueue: 'none',
            muxName: 'mux',
            sink: 'fakesink',
        });
        expect(leaf).toContain(buildEncoderBranch(encoder));
    });

    it('ends with named mux and the given sink fragment', () => {
        const leaf = buildEncodeLeaf({
            encoder,
            inputQueue: 'none',
            muxName: 'mux_3',
            sink: 'tee name=busout_40103 allow-not-linked=true',
        });
        expect(
            leaf.endsWith(
                '! mpegtsmux name=mux_3 latency=0 alignment=7 ! tee name=busout_40103 allow-not-linked=true',
            ),
        ).toBe(true);
    });
});
