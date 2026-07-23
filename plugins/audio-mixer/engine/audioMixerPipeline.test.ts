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
        expect(r.pipeline).toContain('avenc_s302m');
        expect(r.pipeline).toContain('tee name=busout_41000');
        expect(r.sinkName).toBe('busout_41000');
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
