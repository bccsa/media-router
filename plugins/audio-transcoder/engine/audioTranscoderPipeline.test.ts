import { describe, it, expect } from 'vitest';
import { buildPipeline, decoderChainFor } from './audioTranscoderPipeline.js';
import type { AudioTranscoderOutput } from './audioTranscoderPorts.js';

function outputs(...codecs: Array<'opus' | 'aac' | 'pcm'>): AudioTranscoderOutput[] {
    return codecs.map((codec, i) => ({
        portId: `out-${i}`,
        port: 41000 + i,
        rendition: { name: '', codec, bitrate: 128 },
    }));
}

const MPEGTS_FE = {
    mode: 'mpegts' as const,
    port: 40001,
    socketPath: '/tmp/mr-bus-40001-abc123.sock',
    probedCodec: 'aac',
    bufferMs: 75,
};

describe('buildPipeline (audio transcoder)', () => {
    it('returns null with zero outputs', () => {
        expect(
            buildPipeline({
                frontEnd: MPEGTS_FE,
                outputs: [],
                channels: 2,
                volume: 1,
                tsAlignment: 7,
            }),
        ).toBeNull();
    });

    it('mpegts front-end: decode-once with parser-before-decoder, low non-leaky dejitter', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain(
            'unixfdsrc socket-path=/tmp/mr-bus-40001-abc123.sock ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! tsdemux latency=0',
        );
        // bufferMs honoured directly — no 300ms floor (no real-time sink here).
        expect(r.pipeline).toContain('queue leaky=0 max-size-time=75000000');
        expect(r.pipeline).toContain('aacparse ! avdec_aac');
        expect(r.pipeline.match(/avdec_aac/g)).toHaveLength(1);
    });

    it('mpegts front-end clamps bufferMs to the 50ms floor', () => {
        const r = buildPipeline({
            frontEnd: { ...MPEGTS_FE, bufferMs: 0 },
            outputs: outputs('opus'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain('max-size-time=50000000');
    });

    it('mix front-end: audiomixer fan-in, no decoder chain', () => {
        const r = buildPipeline({
            frontEnd: {
                mode: 'mix',
                sources: [
                    { port: 40010, socketPath: '/tmp/mr-bus-40010-c1.sock', connectionId: 'c1' },
                    { port: 40011, socketPath: '/tmp/mr-bus-40011-c2.sock', connectionId: 'c2' },
                ],
                latencyMs: 200,
            },
            outputs: outputs('aac'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain('audiomixer name=mixin force-live=true');
        expect(r.pipeline.match(/! mixin\./g)).toHaveLength(2);
        expect(r.pipeline).toContain('mixin_out. ! audioconvert');
    });

    it('encode leaves use NON-leaky queues — the decoder emits ~150ms PES-batch bursts, and a small leaky queue sheds most of every burst (gate01 stutter bug)', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus', 'aac'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline.match(/t\. ! queue leaky=0 max-size-time=500000000/g)).toHaveLength(2);
        expect(r.pipeline).not.toMatch(/t\. ! queue[^!]*leaky=2/);
    });

    it('shared trunk carries volume + VU level and one tee branch per rendition', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus', 'pcm', 'aac'),
            channels: 2,
            volume: 0.5,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain('volume name=vol volume=0.50');
        expect(r.pipeline).toContain('level post-messages=true');
        expect(r.pipeline.match(/t\. !/g)).toHaveLength(3);
    });

    it('encodes per rendition: opus / 302M / aac, each with its own TS mux', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus', 'pcm', 'aac'),
            channels: 2,
            volume: 1,
            tsAlignment: 1,
        })!;
        expect(r.pipeline).toContain('opusenc perfect-timestamp=true bitrate=128000');
        expect(r.pipeline).toContain('avenc_s302m');
        expect(r.pipeline).toContain('avenc_aac perfect-timestamp=true bitrate=128000 aac-is=0 aac-ms=0');
        // opus/aac take the configured alignment; the 302M branch is pinned SRT-aligned.
        expect(r.pipeline.match(/alignment=1/g)).toHaveLength(2);
        expect(r.pipeline.match(/alignment=7/g)).toHaveLength(1);
    });

    it('sinks carry rendition indexes so a pcm rendition never misaligns throughput labels', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus', 'pcm', 'aac'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.sinks.map((s) => s.renditionIndex)).toEqual([0, 1, 2]);
        expect(r.sinks.map((s) => s.sinkName)).toEqual([
            'busout_41000',
            'busout_41001',
            'busout_41002',
        ]);
    });

    it('every rendition ends in its own pinned-caps bus fan-out tee (no udpsink)', () => {
        const r = buildPipeline({
            frontEnd: MPEGTS_FE,
            outputs: outputs('opus', 'aac'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_41000 allow-not-linked=true',
        );
        expect(r.pipeline).toContain('tee name=busout_41001 allow-not-linked=true');
        expect(r.pipeline).not.toContain('udpsink');
    });

    it('is PTS-preserving on BOTH front-ends: no pulsesrc / do-timestamp / tsparse re-stamping', () => {
        for (const frontEnd of [
            MPEGTS_FE,
            {
                mode: 'mix' as const,
                sources: [
                    { port: 40010, socketPath: '/tmp/mr-bus-40010-c1.sock', connectionId: 'c1' },
                ],
                latencyMs: 200,
            },
        ]) {
            const r = buildPipeline({
                frontEnd,
                outputs: outputs('opus', 'pcm'),
                channels: 2,
                volume: 1,
                tsAlignment: 7,
            })!;
            expect(r.pipeline).not.toContain('pulsesrc');
            expect(r.pipeline).not.toContain('do-timestamp');
            expect(r.pipeline).not.toContain('set-timestamps');
        }
    });
});

describe('decoderChainFor', () => {
    it('maps probed codecs to parser+decoder chains (parser is load-bearing for libav)', () => {
        expect(decoderChainFor('opus')).toBe('opusdec');
        expect(decoderChainFor('aac')).toBe('aacparse ! avdec_aac');
        expect(decoderChainFor('mp2')).toBe('mpegaudioparse ! mpg123audiodec');
        expect(decoderChainFor('ac3')).toBe('ac3parse ! a52dec');
        expect(decoderChainFor('s302m')).toBe('avdec_s302m');
        expect(decoderChainFor(undefined)).toBe('decodebin');
        expect(decoderChainFor('unknown')).toBe('decodebin');
    });
});
