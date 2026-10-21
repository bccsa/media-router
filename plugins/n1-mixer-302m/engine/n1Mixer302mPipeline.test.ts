import { describe, it, expect } from 'vitest';
import { shortHash } from '@media-router/engine';
import {
    alignedMixer,
    liveDemuxName,
    liveMixInputBranch,
    type AudioMixSource,
} from '@media-router/plugin-audio-302m-core';
import {
    activeOutputIndices,
    buildN1Pipeline,
    buildN1Ports,
    n1InputBranch,
    readChannels,
    readPairCount,
    type N1Output,
} from './n1Mixer302mPipeline.js';

function mkSource(i: number, n = 0): AudioMixSource {
    return {
        port: 40100 + i * 10 + n,
        connectionId: `c-${i}-${n}`,
        socketPath: `/tmp/mr-bus-${40100 + i * 10 + n}-abcdef.sock`,
    };
}

function mkInputs(indices: number[], sourcesPer = 1): Map<number, AudioMixSource[]> {
    return new Map(
        indices.map((i) => [i, Array.from({ length: sourcesPer }, (_, n) => mkSource(i, n))]),
    );
}

function mkOutputs(indices: number[]): N1Output[] {
    return indices.map((o) => ({ index: o, port: 40200 + o }));
}

/** Input i's matrix link into output o: its watchdog in that output's pace group, W ≥ 500 ms. */
const link = (i: number, o: number): string =>
    `in${i}t. ! mralignwatch name=omix${o}_aw${i} aligner=omix${o} input=in${i}` +
    ` silence-floor=500000000 ! omix${o}.`;
const MATRIX =
    /in(\d+)t\. ! mralignwatch name=omix(\d+)_aw(\d+) aligner=omix(\d+) input=in(\d+) silence-floor=500000000 ! omix(\d+)\./g;
const CAPS2 = 'audio/x-raw,rate=48000,channels=2';

describe('readPairCount', () => {
    it('defaults to 4 and clamps to 2–16', () => {
        expect(readPairCount({})).toBe(4);
        expect(readPairCount({ pairCount: 'junk' })).toBe(4);
        expect(readPairCount({ pairCount: 2 })).toBe(2);
        expect(readPairCount({ pairCount: 0 })).toBe(2);
        expect(readPairCount({ pairCount: 99 })).toBe(16);
    });
});

describe('readChannels', () => {
    it('accepts only the offered widths and falls back to stereo', () => {
        expect(readChannels({})).toBe(2);
        expect(readChannels({ channels: 'junk' })).toBe(2);
        expect(readChannels({ channels: 3 })).toBe(2);
        expect(readChannels({ channels: 16 })).toBe(2);
        expect(readChannels({ channels: 1 })).toBe(1);
        expect(readChannels({ channels: 8 })).toBe(8);
    });
});

describe('buildN1Ports', () => {
    it('generates N input + N output 302M ports', () => {
        const ports = buildN1Ports(4);
        expect(ports).toHaveLength(8);
        expect(ports[0]).toEqual({
            id: 'in-0',
            direction: 'input',
            streamType: 'audio/302m',
            label: 'In 1',
            maxConnections: -1,
            // Strict intake: only genuine 302M sources — a muxed TS goes
            // through a transcoder first.
            acceptsStreamTypes: ['audio/302m'],
        });
        expect(ports[4]).toEqual({
            id: 'out-0',
            direction: 'output',
            streamType: 'audio/302m',
            label: 'Out 1 (N-1)',
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });

    it('scales to the pair-count bounds', () => {
        expect(buildN1Ports(2)).toHaveLength(4);
        expect(buildN1Ports(16)).toHaveLength(32);
    });
});

describe('activeOutputIndices', () => {
    it('an output is active when any OTHER input is connected', () => {
        expect(activeOutputIndices([0, 1, 2, 3], 4)).toEqual([0, 1, 2, 3]);
        expect(activeOutputIndices([2], 4)).toEqual([0, 1, 3]);
        expect(activeOutputIndices([1], 2)).toEqual([0]);
        expect(activeOutputIndices([], 4)).toEqual([]);
    });
});

describe('buildN1Pipeline', () => {
    it('returns null with no inputs or no outputs', () => {
        expect(buildN1Pipeline({ inputs: new Map(), outputs: mkOutputs([0]) })).toBeNull();
        expect(buildN1Pipeline({ inputs: mkInputs([0]), outputs: [] })).toBeNull();
    });

    it('builds the full N·(N-1) exclusion matrix with no self-branch', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1, 2, 3]),
            outputs: mkOutputs([0, 1, 2, 3]),
        })!;
        const matrix = [...pipeline.matchAll(MATRIX)];
        expect(matrix).toHaveLength(12);
        for (const [, i, o, aw, group, label, into] of matrix) {
            expect(i).not.toBe(o);
            // Named, labelled and grouped by the pair it links, never by position.
            expect([aw, label]).toEqual([i, i]);
            expect([group, into]).toEqual([o, o]);
        }
        for (let i = 0; i < 4; i++) {
            // One source per input pin still builds the input aggregator —
            // live inputs (#787) need it there to add a second source to
            // without a rebuild. Each source is a named bin on an explicit pad.
            expect(pipeline).toContain(
                `audiomixer name=inmix${i} latency=0 start-time-selection=first` +
                    ` ! capsfilter name=inmix${i}_out `,
            );
            expect(pipeline).toContain(`mralignwatch name=inmix${i}_aw_`);
            expect(pipeline).toContain(`( name=inmix${i}_in_`);
            expect(pipeline).toContain(`! inmix${i}.sink_0`);
            expect(pipeline).toContain(`tee name=in${i}t`);
            expect(pipeline).toContain(
                `audiomixer name=omix${i} latency=0 start-time-selection=first` +
                    ` ! capsfilter name=omix${i}_out caps="${CAPS2}"`,
            );
        }
        // One 302M encode + bus sink per output, one decode per source branch.
        expect(pipeline.match(/avenc_s302m/g)).toHaveLength(4);
        expect(pipeline.match(/avdec_s302m/g)).toHaveLength(4);
        expect(pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! mrlateness name=lat_busout_40200 reference=house ! tee name=busout_40200 allow-not-linked=true',
        );
        expect(pipeline.match(/tee name=busout_/g)).toHaveLength(4);
    });

    it('every output mixer is the aligned mixer, chained straight into its 302M encode', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1, 2, 3]),
            outputs: mkOutputs([0, 1, 2, 3]),
        })!;
        for (let o = 0; o < 4; o++) {
            expect(pipeline).toContain(
                alignedMixer({ name: `omix${o}`, caps: CAPS2, outName: `omix${o}_out` }) +
                    ' ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2' +
                    ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7' +
                    ` ! capssetter caps=`,
            );
        }
        // One active output is built the same way.
        const one = buildN1Pipeline({ inputs: mkInputs([1]), outputs: mkOutputs([0]) })!;
        expect(one).toContain(
            alignedMixer({ name: 'omix0', caps: CAPS2, outName: 'omix0_out' }) + ' ! audioconvert',
        );
        expect(one.match(/audiomixer name=omix/g)).toHaveLength(1);
    });

    it('nothing is force-live or clock-paced: no pacer, no fixed budget, anywhere (WI-P2-9)', () => {
        for (const sourcesPer of [1, 3]) {
            const pipeline = buildN1Pipeline({
                inputs: mkInputs([0, 1, 2], sourcesPer),
                outputs: mkOutputs([0, 1, 2]),
            })!;
            expect(pipeline).not.toContain('force-live');
            expect(pipeline).not.toContain('sync=true');
            expect(pipeline).not.toMatch(/\bidentity\b/);
            expect(pipeline).not.toContain('_pace');
            // Every mixer, input fan-in or output, waits for data or a gap: latency 0.
            const mixers = pipeline.match(/audiomixer [^!]*/g)!;
            expect(mixers).toHaveLength(6);
            for (const m of mixers) {
                expect(m).toMatch(
                    /^audiomixer name=(in|o)mix\d latency=0 start-time-selection=first $/,
                );
            }
        }
    });

    it('the matrix links are watchdogs, not the 500 ms queues they replaced', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1, 2]),
            outputs: mkOutputs([0, 1, 2]),
        })!;
        for (const [i, o] of [
            [1, 0],
            [2, 0],
            [0, 1],
            [2, 1],
            [0, 2],
            [1, 2],
        ]) {
            expect(pipeline).toContain(link(i, o));
        }
        // Each tee feeds only watchdogs; the only queues left are the bus ingress ones.
        expect(pipeline).not.toMatch(/in\dt\. ! queue/);
        expect(pipeline).not.toMatch(/max-size-time=500000000\s/);
        expect(pipeline.match(/ ! queue /g)).toHaveLength(3);
        expect(pipeline.match(/unixfdsrc /g)).toHaveLength(3);
    });

    it("a matrix link's W is at least 500 ms: its input mixer's holds are not silence", () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1, 2], 2),
            outputs: mkOutputs([0, 1, 2]),
        })!;
        expect(pipeline.match(MATRIX)).toHaveLength(6);
        // Only the matrix links: a source's own watchdog keeps the element's 100 ms floor, so a
        // dead source holds its input mixer for as short a time as its rhythm allows.
        expect(pipeline.match(/silence-floor=/g)).toHaveLength(6);
        expect(pipeline).toMatch(/mralignwatch name=inmix0_aw_[0-9a-f]{6} aligner=inmix0 [^!]*! /);
        expect(pipeline).not.toMatch(/name=inmix\d_aw_[^!]*silence-floor/);
    });

    it('sums multiple sources wired to one input port', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1], 3),
            outputs: mkOutputs([0, 1]),
        })!;
        expect(pipeline.match(/! inmix0\./g)).toHaveLength(3);
        expect(pipeline.match(/! inmix1\./g)).toHaveLength(3);
        // Summing goes through the aligned mixer, one watchdog per source.
        expect(pipeline).toContain('audiomixer name=inmix0 latency=0');
        expect(pipeline).toContain('capsfilter name=inmix0_out ');
        expect(
            pipeline.match(/mralignwatch name=inmix0_aw_[0-9a-f]{6} aligner=inmix0 /g),
        ).toHaveLength(3);
    });

    it('single connected input feeds every output except its own pair', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([1]),
            outputs: mkOutputs([0, 2, 3]),
        })!;
        expect(pipeline).not.toContain('omix1');
        for (const o of [0, 2, 3]) expect(pipeline).toContain(link(1, o));
    });

    it('never builds a pad-less output mixer — self-only output is dropped', () => {
        expect(buildN1Pipeline({ inputs: mkInputs([1]), outputs: mkOutputs([1]) })).toBeNull();
    });

    it('N=2 is a pure cross-feed', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
        })!;
        const matrix = [...pipeline.matchAll(MATRIX)];
        expect(matrix.map(([, i, o]) => `${i}>${o}`).sort()).toEqual(['0>1', '1>0']);
    });

    it('a live second source on a connected input: the branch liveMixInputBranch builds (#787)', () => {
        const added = mkSource(1, 1);
        const b = n1InputBranch(1, added.connectionId, added, 2);
        expect(b).toEqual(liveMixInputBranch('inmix1', added, { channels: 2 }));
        expect(b.element).toBe('inmix1');
        // Content time through the formula demux, then the watchdog the live add ghosts.
        expect(b.description).toContain(
            `mrtsdemux name=${liveDemuxName('inmix1', added.connectionId)}` +
                ' select=audio/x-smpte-302m ! avdec_s302m',
        );
        expect(b.description).toMatch(
            new RegExp(
                ` ! ${CAPS2} ! mralignwatch name=inmix1_aw_${shortHash(added.connectionId)}` +
                    ` aligner=inmix1 input="${added.connectionId}" hold-on-eos=true$`,
            ),
        );
        // A start with both sources renders the same text, so a later remove finds it.
        const pipeline = buildN1Pipeline({
            inputs: new Map([
                [0, [mkSource(0)]],
                [1, [mkSource(1), added]],
            ]),
            outputs: mkOutputs([0, 1]),
        })!;
        expect(pipeline).toContain(`( name=${b.name} ${b.description} ) ! inmix1.sink_1`);
        expect(n1InputBranch(1, added.connectionId, undefined, 2)).toEqual({
            element: 'inmix1',
            name: b.name,
        });
    });

    it('mixes and encodes every stage at the configured width', () => {
        const wide = buildN1Pipeline({
            inputs: mkInputs([0, 1], 2),
            outputs: mkOutputs([0, 1]),
            channels: 8,
        })!;
        // Input fan-in, matrix branches and output mixers all pin 8 channels…
        expect(
            wide.match(/capsfilter name=inmix\d_out caps="audio\/x-raw,rate=48000,channels=8"/g),
        ).toHaveLength(2);
        expect(
            wide.match(
                /audiomixer name=omix\d [^!]+! capsfilter name=omix\d_out caps="audio\/x-raw,rate=48000,channels=8" !/g,
            ),
        ).toHaveLength(2);
        // …and the 302M encode carries the same width on the wire.
        expect(wide.match(/format=S16LE,rate=48000,channels=8 ! avenc_s302m/g)).toHaveLength(2);
        expect(wide).not.toContain('channels=2');
        // A wide mix leaves the mixer unpositioned (wide 302M decodes that
        // way) and avenc_s302m refuses it — the tail after each output mixer
        // hands the encoder a layout via an identity matrix + explicit mask.
        expect(
            wide.match(
                /capsfilter name=omix\d_out caps="[^"]+" ! audioconvert mix-matrix="<<\(float\)1\.0000, \(float\)0\.0000[^"]*>" ! audio\/x-raw,channels=8,channel-mask=\(bitmask\)0x63f ! audioconvert ! audioresample/g,
            ),
        ).toHaveLength(2);

        // Stereo stays the default when nothing is configured.
        const stereo = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
        })!;
        expect(stereo).not.toContain('channels=8');
        expect(stereo.match(/rate=48000,channels=2/g)!.length).toBeGreaterThan(0);
        // Stereo decodes positioned already — no matrix stage, string unchanged.
        expect(stereo).not.toContain('mix-matrix');
        expect(stereo).not.toContain('channel-mask');
    });

    it('a mono mix is summed at one channel and encoded dual-mono stereo', () => {
        const mono = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
            channels: 1,
        })!;
        expect(
            mono.match(/capsfilter name=inmix\d_out caps="audio\/x-raw,rate=48000,channels=1"/g),
        ).toHaveLength(2);
        expect(
            mono.match(
                /audiomixer name=omix\d [^!]+! capsfilter name=omix\d_out caps="audio\/x-raw,rate=48000,channels=1" !/g,
            ),
        ).toHaveLength(2);
        expect(mono.match(/format=S16LE,rate=48000,channels=2 ! avenc_s302m/g)).toHaveLength(2);
        expect(mono).not.toContain('channels=1 ! avenc_s302m');
        expect(mono).not.toContain('mix-matrix');
    });

    it('per-edge unixfd sockets in, fan-out tees out', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
        })!;
        expect(pipeline).toContain('unixfdsrc');
        expect(pipeline).toContain('socket-path=/tmp/mr-bus-40100-abcdef.sock');
        expect(pipeline).toContain('tee name=busout_40200 allow-not-linked=true');
        expect(pipeline).toContain('tee name=busout_40201 allow-not-linked=true');
        expect(pipeline).not.toContain('udpsink');
    });
});
