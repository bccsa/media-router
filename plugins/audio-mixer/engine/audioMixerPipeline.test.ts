import { describe, it, expect } from 'vitest';
import { buildMixerPipeline } from './audioMixerPipeline.js';

const SOURCES = [
    { port: 40010, socketPath: '/tmp/mr-bus-40010-c1.sock', connectionId: 'c1' },
    { port: 40011, socketPath: '/tmp/mr-bus-40011-c2.sock', connectionId: 'c2' },
];

describe('buildMixerPipeline', () => {
    it('returns null with zero sources', () => {
        expect(
            buildMixerPipeline({
                sources: [],
                outputPort: 41000,
                channels: 2,
                volume: 1,
                latencyMs: 200,
            }),
        ).toBeNull();
    });

    it('sums N sources through one audiomixer into a 302M encode + bus sink', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        expect(r.pipeline).toContain('audiomixer name=mixin force-live=true');
        expect(r.pipeline.match(/! mixin\./g)).toHaveLength(2);
        expect(r.pipeline).toContain('mixin_out. ! audioconvert');
        // Clock pacer on the mixer output — the caller MUST chain from it.
        expect(r.pipeline).toContain('identity name=mixin_out sync=true');
        expect(r.pipeline).toContain('avenc_s302m');
        expect(r.pipeline).toContain('tee name=busout_41000');
        expect(r.sinkName).toBe('busout_41000');
    });

    it('a lone source bypasses the mixer — no aggregation latency in the path', () => {
        const r = buildMixerPipeline({
            sources: [SOURCES[0]],
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        expect(r.pipeline).not.toContain('audiomixer');
        expect(r.pipeline).not.toContain('latency=200000000');
        expect(r.pipeline).not.toContain('sync=true');
        // Same continuation point, so the tail is unchanged.
        expect(r.pipeline).toContain(
            'capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=2" mixin_out. ! audioconvert',
        );
        expect(r.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-40010-c1.sock');
        expect(r.pipeline).toContain('avenc_s302m');
    });

    it('master volume + VU level sit between the mix and the encode', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 0.5,
            latencyMs: 200,
        })!;
        expect(r.pipeline).toContain('volume name=vol volume=0.50');
        expect(r.pipeline).toContain('level post-messages=true');
    });

    it('renders a per-connection channel map as that branch mix-matrix', () => {
        const r = buildMixerPipeline({
            sources: [
                {
                    ...SOURCES[0],
                    channelMap: [
                        { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                        { srcChannel: 1, dstChannel: 0, gain: 0.5 },
                    ],
                },
                SOURCES[1],
            ],
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        expect(r.pipeline).toContain(
            'mix-matrix="<<(float)0.5000, (float)0.5000>, <(float)0.0000, (float)0.0000>>"',
        );
    });

    it('is PTS-preserving: no pulsesrc / do-timestamp / tsparse re-stamping', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        expect(r.pipeline).not.toContain('pulsesrc');
        expect(r.pipeline).not.toContain('do-timestamp');
        expect(r.pipeline).not.toContain('set-timestamps');
    });
});

describe('buildMixerPipeline — 302M word length', () => {
    const base = {
        sources: [{ port: 40000, connectionId: 'c1' }],
        outputPort: 40008,
        channels: 2,
        volume: 1,
        latencyMs: 200,
    };

    it('emits 16-bit 302M by default (pcmBitDepth unset)', () => {
        const r = buildMixerPipeline(base);
        expect(r!.pipeline).toContain(
            'audio/x-raw,format=S16LE,rate=48000,channels=2 ! avenc_s302m',
        );
        expect(r!.pipeline).not.toContain('format=S32LE');
    });

    it('emits 24-bit 302M when the module asks for S32LE', () => {
        const r = buildMixerPipeline({ ...base, pcmFormat: 'S32LE' });
        expect(r!.pipeline).toContain(
            'audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m',
        );
    });
});
