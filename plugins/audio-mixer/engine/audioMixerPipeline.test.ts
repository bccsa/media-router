import { describe, it, expect } from 'vitest';
import { buildBusSink } from '@media-router/engine';
import { alignedMixer, build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
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
            }),
        ).toBeNull();
    });

    it('sums N sources through one audiomixer into a 302M encode + bus sink', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 1,
        })!;
        expect(r.pipeline).toContain(
            'audiomixer name=mixin latency=0 start-time-selection=first' +
                ' ! capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=2"',
        );
        expect(r.pipeline.match(/! mixin\./g)).toHaveLength(2);
        // Every input through its aligner watchdog; no force-live, no pacer.
        expect(
            r.pipeline.match(/! mralignwatch name=mixin_aw_[0-9a-f]{6} aligner=mixin /g),
        ).toHaveLength(2);
        expect(r.pipeline).toContain('mixin_out. ! audioconvert');
        expect(r.pipeline).not.toContain('force-live');
        expect(r.pipeline).not.toContain('identity');
        expect(r.pipeline).toContain('avenc_s302m');
        expect(r.pipeline).toContain('tee name=busout_41000');
        expect(r.sinkName).toBe('busout_41000');
    });

    it('the whole string: the aligned mixer, one watchdog-ended bin per source, master stage, 302M tail', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 0.8,
        })!;
        const bin = (i: number): string => {
            const b = mixerInputBranch(SOURCES[i].connectionId, SOURCES[i], 2);
            return ` ( name=${b.name} ${b.description} ) ! mixin.sink_${i}`;
        };
        expect(r.pipeline).toBe(
            alignedMixer({
                name: 'mixin',
                caps: 'audio/x-raw,rate=48000,channels=2',
                outName: 'mixin_out',
            }) +
                bin(0) +
                bin(1) +
                ' mixin_out. ! audioconvert ! volume name=vol volume=0.80' +
                ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
                ` ! ${build302mEncodeBranch({ format: 'S16LE' })} ! ${buildBusSink(41000)}`,
        );
        for (const i of [0, 1]) {
            expect(mixerInputBranch(SOURCES[i].connectionId, SOURCES[i], 2).description).toMatch(
                /mrtsdemux name=mixin_demux_[0-9a-f]{6} select=audio\/x-smpte-302m .* ! mralignwatch name=mixin_aw_[0-9a-f]{6} aligner=mixin input="c\d" hold-on-eos=true$/,
            );
        }
    });

    it('a lone source still builds the mixer arm — live inputs need the aggregator in place', () => {
        const r = buildMixerPipeline({
            sources: [SOURCES[0]],
            outputPort: 41000,
            channels: 2,
            volume: 1,
        })!;
        expect(r.pipeline).toContain('audiomixer name=mixin latency=0 start-time-selection=first');
        expect(r.pipeline).toContain('mralignwatch name=mixin_aw_');
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
        expect(r.pipeline).toContain('mrtsdemux name=mixin_demux_');
        expect(r.pipeline).not.toContain('mixin_demux0');
        expect(r.pipeline).not.toMatch(/\btsdemux\b/);
    });

    it('master volume + VU level sit between the mix and the encode', () => {
        const r = buildMixerPipeline({
            sources: SOURCES,
            outputPort: 41000,
            channels: 2,
            volume: 0.5,
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
    it('for a wired source: the mixer, the bin name and the branch text (ending in its watchdog)', () => {
        const b = mixerInputBranch(
            'c1',
            { ...SOURCES[0], channelMap: [{ srcChannel: 0, dstChannel: 1 }] },
            2,
        );
        expect(b.element).toBe('mixin');
        expect(b.name).toMatch(/^mixin_in_[0-9a-f]{6}$/);
        expect(b.description).toContain('unixfdsrc socket-path=/tmp/mr-bus-40010-c1.sock');
        expect(b.description).toContain('mrtsdemux name=mixin_demux_');
        expect(b.description).toContain('mix-matrix=');
        expect(b.description).toMatch(
            /! mralignwatch name=mixin_aw_[0-9a-f]{6} aligner=mixin [^!]+$/,
        );
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
        })!;
        const b = mixerInputBranch('c1', SOURCES[0], 2);
        expect(r.pipeline).toContain(`( name=${b.name} ${b.description} ) ! mixin.sink_0`);
    });
});
