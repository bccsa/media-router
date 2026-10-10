import { describe, it, expect } from 'vitest';
import { buildMixerPipeline, mixerInputBranch } from './audioMixerPipeline.js';

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

    it('a lone source still builds the mixer arm — live inputs need the aggregator in place', () => {
        const r = buildMixerPipeline({
            sources: [SOURCES[0]],
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        expect(r.pipeline).toContain('audiomixer name=mixin force-live=true latency=200000000');
        expect(r.pipeline).toContain('identity name=mixin_out sync=true');
        expect(r.pipeline).toContain('mixin_out. ! audioconvert');
        expect(r.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-40010-c1.sock');
        expect(r.pipeline).toContain('avenc_s302m');
    });

    it('wraps every source in a named bin on an explicit mixer pad (#787)', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        const bins = [
            ...r.pipeline.matchAll(
                /\( name=(mixin_in_[0-9a-f]{6}) unixfdsrc [^)]+\) ! mixin\.sink_(\d)/g,
            ),
        ];
        expect(bins.map((m) => m[2])).toEqual(['0', '1']);
        // The bin name is the one `mixerInputBranch` gives the engine for a live remove.
        expect(bins.map((m) => m[1])).toEqual(
            SOURCES.map((s) => mixerInputBranch(s.connectionId, undefined, 2).name),
        );
        // Demuxers are keyed by connection too — no positional names to collide with a later add.
        expect(r.pipeline).toContain('tsdemux name=mixin_demux_');
        expect(r.pipeline).not.toContain('mixin_demux0');
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

describe('mixerInputBranch — the live-input branch handed to the engine (#787)', () => {
    it('for a wired source: the mixer, the bin name and the branch text (ending in its queue)', () => {
        const b = mixerInputBranch(
            'c1',
            { ...SOURCES[0], channelMap: [{ srcChannel: 0, dstChannel: 1 }] },
            2,
        );
        expect(b.element).toBe('mixin');
        expect(b.name).toMatch(/^mixin_in_[0-9a-f]{6}$/);
        expect(b.description).toContain('unixfdsrc socket-path=/tmp/mr-bus-40010-c1.sock');
        expect(b.description).toContain('tsdemux name=mixin_demux_');
        expect(b.description).toContain('mix-matrix=');
        expect(b.description).toMatch(/! queue leaky=0 [^!]+$/);
        expect(b.description).not.toContain('mixin.');
    });

    it('for a removed source: just the mixer and the bin name', () => {
        const b = mixerInputBranch('c1', undefined, 2);
        expect(b).toEqual({ element: 'mixin', name: mixerInputBranch('c1', SOURCES[0], 2).name });
    });

    it('the start-time pipeline renders the identical branch under the identical name', () => {
        const r = buildMixerPipeline({
            sources: [SOURCES[0]],
            outputPort: 41000,
            channels: 2,
            volume: 1,
            latencyMs: 200,
        })!;
        const b = mixerInputBranch('c1', SOURCES[0], 2);
        expect(r.pipeline).toContain(`( name=${b.name} ${b.description} ) ! mixin.sink_0`);
    });
});

describe('buildMixerPipeline — retimed (time-sync contract)', () => {
    const sources = [
        { port: 40001, connectionId: 'c1' },
        { port: 40002, connectionId: 'c2' },
    ];
    const base = { sources, outputPort: 41000, channels: 2, volume: 1, latencyMs: 20 };

    it('returns every start-time demux and renders the retimed branches', () => {
        const r = buildMixerPipeline({ ...base, retimed: true })!;
        expect(r.demuxes).toHaveLength(2);
        expect(r.pipeline).not.toContain('ignore-pcr');
        expect(r.pipeline).toContain('sync=true ts-offset=-');
    });

    it('the live branch for an edge equals its retimed start-time branch', () => {
        const r = buildMixerPipeline({ ...base, retimed: true })!;
        const b = mixerInputBranch('c2', sources[1], 2, true);
        expect(r.pipeline).toContain(`( name=${b.name} ${b.description} )`);
        // …and a non-retimed live branch would NOT match it (ignore-pcr differs).
        const legacy = mixerInputBranch('c2', sources[1], 2);
        expect(r.pipeline).not.toContain(`( name=${legacy.name} ${legacy.description} )`);
    });
});
