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

const SOURCE = {
    port: 40001,
    socketPath: '/tmp/mr-bus-40001-abc123.sock',
    probedCodec: 'aac',
    bufferMs: 75,
};

describe('buildPipeline (audio transcoder)', () => {
    it('returns null with zero outputs', () => {
        expect(
            buildPipeline({
                source: SOURCE,
                outputs: [],
                channels: 2,
                volume: 1,
                tsAlignment: 7,
            }),
        ).toBeNull();
    });

    it('decode-once front-end: with parser-before-decoder, low non-leaky dejitter', () => {
        const r = buildPipeline({
            source: SOURCE,
            outputs: outputs('opus'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain(
            'unixfdsrc socket-path=/tmp/mr-bus-40001-abc123.sock ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! tsdemux name=demux latency=0',
        );
        // bufferMs honoured directly — no 300ms floor (no real-time sink here).
        expect(r.pipeline).toContain('queue leaky=0 max-size-time=75000000');
        expect(r.pipeline).toContain('aacparse ! avdec_aac');
        expect(r.pipeline.match(/avdec_aac/g)).toHaveLength(1);
    });

    it('clamps bufferMs to the 50ms floor', () => {
        const r = buildPipeline({
            source: { ...SOURCE, bufferMs: 0 },
            outputs: outputs('opus'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).toContain('max-size-time=50000000');
    });

    it('encode leaves use NON-leaky queues — the decoder emits ~150ms PES-batch bursts, and a small leaky queue sheds most of every burst (gate01 stutter bug)', () => {
        const r = buildPipeline({
            source: SOURCE,
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
            source: SOURCE,
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
            source: SOURCE,
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
            source: SOURCE,
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
            source: SOURCE,
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

    it('is PTS-preserving: no pulsesrc / do-timestamp / tsparse re-stamping', () => {
        const r = buildPipeline({
            source: SOURCE,
            outputs: outputs('opus', 'pcm'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).not.toContain('pulsesrc');
        expect(r.pipeline).not.toContain('do-timestamp');
        expect(r.pipeline).not.toContain('set-timestamps');
    });

    it('inlines a channel map as a trunk mix-matrix with pinned output caps (no mixer element)', () => {
        const r = buildPipeline({
            source: {
                ...SOURCE,
                channelMap: [
                    { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                    { srcChannel: 1, dstChannel: 0, gain: 0.5 },
                ],
            },
            outputs: outputs('opus'),
            channels: 2,
            volume: 1,
            tsAlignment: 7,
        })!;
        expect(r.pipeline).not.toContain('audiomixer');
        expect(r.pipeline).toContain(
            'mix-matrix="<<(float)0.5000, (float)0.5000>, <(float)0.0000, (float)0.0000>>"',
        );
        expect(r.pipeline).toContain('audio/x-raw,channels=2');
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

describe('buildPipeline — PCM rendition word length', () => {
    const pcm = {
        source: { port: 40000, bufferMs: 75 },
        outputs: [{ portId: 'out-0', port: 40008, rendition: { codec: 'pcm', bitrate: 0 } as never }],
        channels: 2,
        volume: 1,
        tsAlignment: 7,
    };

    it('encodes PCM renditions as 16-bit 302M by default', () => {
        const r = buildPipeline(pcm);
        expect(r!.pipeline).toContain('audio/x-raw,format=S16LE,rate=48000,channels=2 ! avenc_s302m');
    });

    it('encodes 24-bit when pcmFormat=S32LE', () => {
        const r = buildPipeline({ ...pcm, pcmFormat: 'S32LE' });
        expect(r!.pipeline).toContain('audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m');
    });
});
