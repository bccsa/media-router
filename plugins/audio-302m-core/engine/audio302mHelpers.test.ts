import { describe, it, expect } from 'vitest';
import { buildBusSrc, buildRestamp, quoteGstString, shortHash } from '@media-router/engine';
import {
    alignedMixer,
    buildAudioMixInput,
    build302mEncodeBranch,
    build302mMixBranch,
    liveDemuxName,
    liveInputBranchFor,
    liveMixInputBranch,
    mixInputBranchName,
    mixInputDemuxes,
    normalize302mChannels,
    type AudioMixSource,
} from './audio302mHelpers.js';
import { positionedChannelsClause } from './channelLayout.js';
import { mixMatrixClause } from './channelMapMatrix.js';
import * as core from './index.js';

const SRC = { port: 40001, connectionId: 'c1' };
const SRC2 = { port: 40002, connectionId: 'c2' };
const CAPS2 = 'audio/x-raw,rate=48000,channels=2';

/** A branch up to its decode; the bus source itself is the engine's (`buildBusSrc`). */
const decoded = (port: number, demux: string): string =>
    `${buildBusSrc({ port })} ! mrtsdemux name=${demux} select=audio/x-smpte-302m` +
    ' ! avdec_s302m ! audioconvert ! audioresample';
/** The watchdog every mixer-arm branch ends in. */
const watch = (mixer: string, connectionId: string): string =>
    `mralignwatch name=${mixer}_aw_${shortHash(connectionId)} aligner=${mixer}` +
    ` input="${connectionId}" hold-on-eos=true`;

describe('alignedMixer', () => {
    it('is a non-live audiomixer with no budget, anchored at its first input, caps pinned on the continuation', () => {
        expect(alignedMixer({ name: 'omix0', caps: CAPS2, outName: 'omix0_out' })).toBe(
            'audiomixer name=omix0 latency=0 start-time-selection=first' +
                ` ! capsfilter name=omix0_out caps="${CAPS2}"`,
        );
    });
});

describe('buildAudioMixInput — the three arms, snapshot', () => {
    it('one source: the direct branch, mrtsdemux and the branch queue, no aggregator or watchdog', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [SRC] });
        expect(fragment).toBe(
            `${decoded(40001, 'mixin_demux0')}` +
                ' ! queue leaky=0 max-size-time=100000000 max-size-buffers=0 max-size-bytes=0' +
                ` ! capsfilter name=mixin_out caps="${CAPS2}"`,
        );
        expect(continuationName).toBe('mixin_out');
    });

    it('many sources: the aligned mixer, every branch through its mralignwatch', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment).toBe(
            'audiomixer name=mixin latency=0 start-time-selection=first' +
                ` ! capsfilter name=mixin_out caps="${CAPS2}"` +
                ` ${decoded(40001, 'mixin_demux0')} ! ${CAPS2} ! ${watch('mixin', 'c1')} ! mixin.` +
                ` ${decoded(40002, 'mixin_demux1')} ! ${CAPS2} ! ${watch('mixin', 'c2')} ! mixin.`,
        );
        expect(continuationName).toBe('mixin_out');
    });

    it('live inputs: the aligned mixer, each branch a named bin on an explicit pad', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC, SRC2],
            liveInputs: true,
        });
        const bin = (s: typeof SRC, i: number): string =>
            ` ( name=${mixInputBranchName('mixin', s.connectionId)}` +
            ` ${decoded(s.port, liveDemuxName('mixin', s.connectionId))} ! ${CAPS2}` +
            ` ! ${watch('mixin', s.connectionId)} ) ! mixin.sink_${i}`;
        expect(fragment).toBe(
            'audiomixer name=mixin latency=0 start-time-selection=first' +
                ` ! capsfilter name=mixin_out caps="${CAPS2}"` +
                bin(SRC, 0) +
                bin(SRC2, 1),
        );
        expect(continuationName).toBe('mixin_out');
    });

    it('no sources: the aligned mixer alone', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [] });
        expect(fragment).toBe(alignedMixer({ name: 'mixin', caps: CAPS2, outName: 'mixin_out' }));
        expect(continuationName).toBe('mixin_out');
    });

    it('returns only the fragment and the continuation — no latency, no demux list to align', () => {
        for (const sources of [[], [SRC], [SRC, SRC2]]) {
            expect(Object.keys(buildAudioMixInput({ sources })).sort()).toEqual([
                'continuationName',
                'fragment',
            ]);
        }
    });
});

describe('helper strings carry none of the replaced mechanisms', () => {
    const MAP = [
        { srcChannel: 0, dstChannel: 0 },
        { srcChannel: 0, dstChannel: 1 },
    ];
    const SOURCES: AudioMixSource[] = [
        { ...SRC, channelMap: MAP, sourceChannels: 1, seedLatenessMs: 40 },
        { ...SRC2, socketPath: '/tmp/mr-bus-40002-abc.sock' },
        { port: 40003, connectionId: 'mod-a:out-0-mod-b:in-0', sourceChannels: 8 },
    ];

    function everyString(): string[] {
        const out: string[] = [alignedMixer({ name: 'm', caps: CAPS2, outName: 'm_out' })];
        for (let n = 0; n <= SOURCES.length; n++) {
            for (const liveInputs of [false, true]) {
                for (const channels of [1, 2, 8]) {
                    const sources = SOURCES.slice(0, n);
                    out.push(buildAudioMixInput({ sources, liveInputs, channels }).fragment);
                }
            }
        }
        for (const s of SOURCES) {
            out.push(build302mMixBranch(s, { mixerName: 'm', demuxName: 'd' }));
            out.push(liveMixInputBranch('m', s, { channels: 8 }).description!);
            out.push(liveInputBranchFor('m', s.connectionId, s).description!);
        }
        return out;
    }

    it('no tsdemux, no ignore-pcr, no force-live, no clock pacer (sync=true)', () => {
        const all = everyString();
        expect(all.length).toBeGreaterThan(20);
        for (const s of all) {
            expect(s).not.toMatch(/\btsdemux\b/);
            expect(s).not.toContain('ignore-pcr');
            expect(s).not.toContain('force-live');
            expect(s).not.toContain('sync=true');
            expect(s).not.toContain('identity');
        }
    });

    it('every mrtsdemux selects 302M, so a TS without it fails soft (no stream, silent pad)', () => {
        for (const s of everyString()) {
            const demuxes = s.match(/\bmrtsdemux [^!]*/g) ?? [];
            for (const d of demuxes) expect(d).toMatch(/ select=audio\/x-smpte-302m $/);
            expect(demuxes.length).toBe(s.match(/avdec_s302m/g)?.length ?? 0);
        }
    });

    it('no string the package builds is force-live or syncs to the clock (WI-P2-9)', () => {
        const all = everyString();
        const restamp = buildRestamp({ mode: 'fixed', offsetMs: -40 });
        for (const format of ['S16LE', 'S32LE'] as const) {
            for (const channels of [1, 2, 3, 4, 6, 8]) {
                for (const asrc of [false, true]) {
                    all.push(build302mEncodeBranch({ format, channels, asrc }));
                    all.push(build302mEncodeBranch({ format, channels, asrc, restamp }));
                }
            }
        }
        for (const n of [2, 4, 6, 8]) {
            all.push(positionedChannelsClause(n));
            all.push(mixMatrixClause(MAP, 2, n));
        }
        expect(all.length).toBeGreaterThan(80);
        for (const s of all) {
            expect(s).not.toContain('force-live');
            expect(s).not.toContain('sync=true');
            expect(s).not.toMatch(/\bidentity\b/);
        }
    });

    it("names each branch's demux and the connection it decodes, as the fragment has it", () => {
        for (let n = 1; n <= SOURCES.length; n++) {
            for (const liveInputs of [false, true]) {
                const opts = { sources: SOURCES.slice(0, n), liveInputs, mixerName: 'progmix' };
                const named = [
                    ...buildAudioMixInput(opts).fragment.matchAll(/mrtsdemux name=(\S+)/g),
                ];
                const demuxes = mixInputDemuxes(opts);
                expect([...demuxes.keys()]).toEqual(named.map((m) => m[1]));
                expect([...demuxes.values()]).toEqual(opts.sources.map((x) => x.connectionId));
                // A live branch's ends in its connection's hash: the engine's rule needs no hook.
                for (const [name, c] of demuxes) {
                    if (liveInputs) expect(name.endsWith(`_${shortHash(c)}`)).toBe(true);
                }
            }
        }
        expect(mixInputDemuxes({ sources: [] })).toEqual(new Map());
    });

    it('exports no paced mixer; a new builder must join the test above', () => {
        expect(Object.keys(core).sort()).toEqual([
            'DEFAULT_302M_BIT_DEPTH',
            'POSITIONED_302M_MASK',
            'alignedMixer',
            'build302mEncodeBranch',
            'build302mMixBranch',
            'buildAudioMixInput',
            'channelRange',
            'liveDemuxName',
            'liveInputBranchFor',
            'liveMixInputBranch',
            'mixInputBranchName',
            'mixInputDemuxes',
            'mixMatrixClause',
            'normalize302mChannels',
            'positionedChannelsClause',
            'probe302mSupport',
            's302mFormatFor',
        ]);
    });
});

describe('build302mMixBranch — the watchdog in front of the aggregator', () => {
    it('ends in the mralignwatch (the unlinked src pad a live add ghosts) and links nothing', () => {
        const branch = build302mMixBranch(SRC, { mixerName: 'mixin', demuxName: 'd1' });
        expect(branch).toBe(`${decoded(40001, 'd1')} ! ${CAPS2} ! ${watch('mixin', 'c1')}`);
        expect(branch).not.toContain('mixin.');
    });

    it('joins the pace group of the mixer it feeds, holding EOS as absence', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], mixerName: 'progmix' });
        const watches = fragment.match(/mralignwatch [^!]+/g)!;
        expect(watches).toHaveLength(2);
        for (const w of watches) {
            expect(w).toContain(' aligner=progmix ');
            expect(w).toContain(' hold-on-eos=true');
        }
        // The queue it replaced is gone from the mixer arm.
        expect(fragment).not.toContain('queue leaky=0');
    });

    it('names the watchdog and labels the input by connection, never by position', () => {
        const ab = buildAudioMixInput({ sources: [SRC, SRC2] }).fragment;
        const ba = buildAudioMixInput({ sources: [SRC2, SRC] }).fragment;
        for (const id of ['c1', 'c2']) {
            expect(ab).toContain(watch('mixin', id));
            expect(ba).toContain(watch('mixin', id));
        }
    });

    it('quotes the input label, so any connection id parses', () => {
        const id = 'odd id "x" \\ y';
        const branch = build302mMixBranch(
            { port: 40001, connectionId: id },
            { mixerName: 'mixin', demuxName: 'd' },
        );
        expect(branch).toContain(
            `mralignwatch name=mixin_aw_${shortHash(id)} aligner=mixin input=${quoteGstString(id)} `,
        );
        expect(quoteGstString(id)).toBe('"odd id \\"x\\" \\\\ y"');
    });

    it('renders a seed lateness as seed-lateness in ns, and none without one', () => {
        const seeded = (seedLatenessMs: number | undefined): string =>
            build302mMixBranch({ ...SRC, seedLatenessMs }, { mixerName: 'mixin', demuxName: 'd' });
        expect(seeded(12.5)).toMatch(/ hold-on-eos=true seed-lateness=12500000$/);
        // A mean (WI-P2-13 fills it) renders whole ns: gst-parse refuses a fractional int64.
        expect(seeded(12.3456789)).toMatch(/ seed-lateness=12345679$/);
        expect(seeded(0.0000004)).toMatch(/ seed-lateness=0$/);
        expect(seeded(0)).toMatch(/ seed-lateness=0$/);
        // Inside the element's range: an early producer seeds 0, a seed past 1 h is 1 h.
        expect(seeded(-3)).toMatch(/ seed-lateness=0$/);
        expect(seeded(5_000_000)).toMatch(/ seed-lateness=3600000000000$/);
        for (const none of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(seeded(none)).not.toContain('seed-lateness');
            expect(seeded(none)).toMatch(/ hold-on-eos=true$/);
        }
    });

    it('a seed reaches the start-time pipeline in both mixer modes, but not the direct branch', () => {
        const s = { ...SRC, seedLatenessMs: 250 };
        for (const liveInputs of [false, true]) {
            const { fragment } = buildAudioMixInput({ sources: [s, SRC2], liveInputs });
            expect(fragment.match(/seed-lateness=250000000/g)).toHaveLength(1);
        }
        // One source, no watchdog: nothing to seed.
        expect(buildAudioMixInput({ sources: [s] }).fragment).not.toContain('seed-lateness');
    });
});

describe('buildAudioMixInput — one source (direct branch, no mixer)', () => {
    it('keeps the decode chain, the branch queue bound and the channel map', () => {
        const { fragment } = buildAudioMixInput({
            sources: [
                {
                    ...SRC,
                    socketPath: '/tmp/mr-bus-40001-abc.sock',
                    channelMap: [
                        { srcChannel: 0, dstChannel: 0 },
                        { srcChannel: 0, dstChannel: 1 },
                    ],
                    sourceChannels: 1,
                },
            ],
            branchQueueMs: 250,
        });
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40001-abc.sock');
        expect(fragment).toContain(
            'mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m ! avdec_s302m',
        );
        // `sourceChannels: 1` still means a stereo 302M wire (no mono layout
        // exists) — the matrix must be 2 columns wide.
        expect(fragment).toContain(
            'audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)1.0000, (float)0.0000>>" ! audioresample',
        );
        expect(fragment).toContain(
            'queue leaky=0 max-size-time=250000000 max-size-buffers=0 max-size-bytes=0',
        );
        expect(fragment).not.toContain('mralignwatch');
        expect(fragment).not.toContain('audiomixer');
    });

    it('clamps the branch queue to 20–2000 ms', () => {
        const q = (ms: number) =>
            buildAudioMixInput({ sources: [SRC], branchQueueMs: ms }).fragment;
        expect(q(5)).toContain('max-size-time=20000000 ');
        expect(q(9999)).toContain('max-size-time=2000000000 ');
    });

    it('honours a custom mixer name for the terminal element', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC],
            mixerName: 'inmix2',
        });
        expect(continuationName).toBe('inmix2_out');
        expect(fragment).toContain('capsfilter name=inmix2_out');
        expect(fragment).toContain('mrtsdemux name=inmix2_demux0 ');
    });
});

describe('buildAudioMixInput — mixer arm', () => {
    it('pins the mixer OUTPUT caps on the continuation — left to downstream it goes mono (gate01 VU bug)', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], channels: 2 });
        expect(fragment).toMatch(
            /^audiomixer name=mixin [^!]+ ! capsfilter name=mixin_out caps="audio\/x-raw,rate=48000,channels=2" /,
        );
    });

    it('anchors the output timeline at the first input (never at running time 0)', () => {
        // Default `zero` + the base_time=0 house clock = the mixer starts at
        // BOOT and races the box's uptime as silence before consuming a sample
        // (10.9.16.111, 2026-09-08: 13 min of dead Audio Out after a restart).
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment).toMatch(/^audiomixer name=mixin [^!]*\bstart-time-selection=first\b/);
    });

    it('builds one branch per source, each ending at the mixer', () => {
        const { fragment } = buildAudioMixInput({
            sources: [SRC, SRC2, { ...SRC, port: 40003, connectionId: 'c3' }],
        });
        expect(fragment.match(/ ! mixin\./g)).toHaveLength(3);
        expect(fragment.match(/avdec_s302m/g)).toHaveLength(3);
        expect(fragment.match(/mralignwatch /g)).toHaveLength(3);
        expect(fragment).toContain('mrtsdemux name=mixin_demux2 ');
    });

    it('pins 48 kHz and the requested channel count on every branch and the output', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], channels: 8 });
        expect(
            fragment.match(/! audio\/x-raw,rate=48000,channels=8 ! mralignwatch /g),
        ).toHaveLength(2);
        expect(fragment).toContain(
            'capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=8"',
        );
    });

    it('names the continuation off a custom mixer name', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC, SRC2],
            mixerName: 'progmix',
        });
        expect(continuationName).toBe('progmix_out');
        expect(fragment).toContain('capsfilter name=progmix_out ');
        expect(fragment).toContain('audiomixer name=progmix ');
    });
});

describe('buildAudioMixInput — live-input mode (#787)', () => {
    it('always builds the mixer arm, each source a named bin on an explicit pad', () => {
        const one = buildAudioMixInput({ sources: [SRC], liveInputs: true });
        expect(one.fragment).toMatch(/^audiomixer name=mixin latency=0 /);
        expect(one.continuationName).toBe('mixin_out');
        expect(one.fragment).toContain(`( name=${mixInputBranchName('mixin', 'c1')} unixfdsrc`);
        expect(one.fragment).toContain(') ! mixin.sink_0');

        const two = buildAudioMixInput({ sources: [SRC, SRC2], liveInputs: true });
        expect(two.fragment).toContain(') ! mixin.sink_0');
        expect(two.fragment).toContain(') ! mixin.sink_1');
        expect(two.fragment.match(/\( name=mixin_in_[0-9a-f]{6} /g)).toHaveLength(2);
    });

    it('keys demuxer names by connection, never by position', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], liveInputs: true });
        expect(fragment).not.toContain('mixin_demux0');
        expect(fragment).toContain(`mrtsdemux name=${liveDemuxName('mixin', 'c1')} `);
        expect(fragment).toContain(`mrtsdemux name=${liveDemuxName('mixin', 'c2')} `);
    });

    it('renders every start-time branch through liveMixInputBranch, byte for byte', () => {
        const source = { ...SRC, channelMap: [{ srcChannel: 0, dstChannel: 0, gain: 0.5 }] };
        const { fragment } = buildAudioMixInput({
            sources: [source],
            liveInputs: true,
            channels: 2,
        });
        const b = liveMixInputBranch('mixin', source, { channels: 2 });
        expect(b.element).toBe('mixin');
        expect(b.name).toBe(mixInputBranchName('mixin', 'c1'));
        expect(fragment).toContain(`( name=${b.name} ${b.description} ) ! mixin.sink_0`);
        expect(b.description).toContain('mix-matrix=');
        expect(b.description).toMatch(/ ! mralignwatch [^!]+$/);
    });

    it('a removed edge is named without a description (the live remove)', () => {
        expect(liveInputBranchFor('mixin', 'c1', undefined)).toEqual({
            element: 'mixin',
            name: mixInputBranchName('mixin', 'c1'),
        });
        expect(liveInputBranchFor('mixin', 'c1', SRC)).toEqual(liveMixInputBranch('mixin', SRC));
    });

    it('off by default: the classic strings have no bins', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment).not.toContain('( name=');
        expect(fragment).toContain(' ! mixin. ');
        expect(fragment).toContain('mrtsdemux name=mixin_demux0 ');
    });
});

describe('buildAudioMixInput — shared branch contract', () => {
    it('ingests each source over unixfd, defaulting to the channel socket', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40001.sock');
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40002.sock');
    });

    it('uses the per-connection unixfd edge socket when supplied', () => {
        const { fragment } = buildAudioMixInput({
            sources: [{ ...SRC, socketPath: '/tmp/mr-bus-40001-abc.sock' }, SRC2],
        });
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40001-abc.sock');
    });

    it('is PTS-preserving: no pulsesrc, no do-timestamp, no tsparse re-stamping', () => {
        for (const sources of [[SRC], [SRC, SRC2]]) {
            const { fragment } = buildAudioMixInput({ sources });
            expect(fragment).not.toContain('pulsesrc');
            expect(fragment).not.toContain('do-timestamp');
            expect(fragment).not.toContain('set-timestamps');
        }
    });

    // The clause itself is covered in `channelMapMatrix.test.ts`; this pins
    // that the fan-in applies it per branch — and sizes it from the 302M wire
    // width: a producer configured mono still EMITS stereo 302M (the format has
    // no mono layout), so `sourceChannels: 1` must yield a 2-column matrix or
    // audioconvert rejects the dimensions at runtime.
    it('renders a source channelMap on that branch only', () => {
        const { fragment } = buildAudioMixInput({
            sources: [
                {
                    ...SRC,
                    channelMap: [
                        { srcChannel: 0, dstChannel: 0 },
                        { srcChannel: 0, dstChannel: 1 },
                    ],
                    sourceChannels: 1,
                },
                { port: 40002, connectionId: 'c2' },
            ],
        });
        expect(fragment).toContain(
            'audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)1.0000, (float)0.0000>>" ! audioresample',
        );
        // The unmapped branch keeps a bare audioconvert.
        expect(fragment.match(/avdec_s302m ! audioconvert ! audioresample/g)).toHaveLength(1);
    });
});

describe('build302mEncodeBranch', () => {
    it('encodes S32LE (24-bit 302M) at 48 kHz stereo into an SRT-aligned TS', () => {
        const s = build302mEncodeBranch();
        expect(s).toContain('audio/x-raw,format=S32LE,rate=48000,channels=2');
        // strict=experimental: ffmpeg gates its (standard-output) s302m encoder.
        expect(s).toContain('avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7');
    });

    it('supports 16-bit via S16LE', () => {
        expect(build302mEncodeBranch({ format: 'S16LE' })).toContain('format=S16LE');
    });

    it('is PTS-preserving (no capture/re-stamp elements)', () => {
        const s = build302mEncodeBranch();
        expect(s).not.toContain('pulsesrc');
        expect(s).not.toContain('do-timestamp');
        expect(s).not.toContain('set-timestamps');
    });

    it('emits wider 302M on request, snapped onto the 2/4/6/8 set the encoder accepts', () => {
        expect(build302mEncodeBranch({ channels: 8 })).toContain('rate=48000,channels=8 !');
        expect(build302mEncodeBranch({ channels: 4 })).toContain('rate=48000,channels=4 !');
        // 302M has no odd or >8 layouts — never hand avenc_s302m a count it rejects.
        expect(build302mEncodeBranch({ channels: 3 })).toContain('channels=4 !');
        expect(build302mEncodeBranch({ channels: 32 })).toContain('channels=8 !');
    });

    it("pins the mixers' branch byte for byte: no ASRC, no restamp until Phase 2", () => {
        const tail = ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7';
        expect(build302mEncodeBranch()).toBe(
            'audioconvert ! audioresample ! audio/x-raw,format=S32LE,rate=48000,channels=2' + tail,
        );
        expect(build302mEncodeBranch({ format: 'S16LE', channels: 8, asrc: false })).toBe(
            'audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=8' + tail,
        );
    });

    it('a PCM capture resamples once, in mrasrc, and ends in its restamp (WI-P1-11)', () => {
        const restamp = 'mrtsrestamp name=restamp clock-mode=fixed offset-ns=-40000000';
        expect(build302mEncodeBranch({ format: 'S16LE', channels: 4, asrc: true, restamp })).toBe(
            'audioconvert ! mrasrc name=asrc ! audio/x-raw,format=S16LE,rate=48000,channels=4' +
                ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7 ! ' +
                restamp,
        );
        // The ASRC converts the nominal rate too, so nothing resamples twice (§13.1).
        expect(build302mEncodeBranch({ asrc: true })).not.toContain('audioresample');
        // The restamp follows the mux whichever resampler runs.
        expect(build302mEncodeBranch({ restamp })).toMatch(
            /audioresample .* alignment=7 ! mrtsrestamp /,
        );
    });
});

describe('normalize302mChannels', () => {
    it('snaps onto {2,4,6,8}: up to the next even count, clamped', () => {
        expect(normalize302mChannels(undefined)).toBe(2);
        expect(normalize302mChannels(1)).toBe(2);
        expect(normalize302mChannels(2)).toBe(2);
        expect(normalize302mChannels(3)).toBe(4);
        expect(normalize302mChannels(5)).toBe(6);
        expect(normalize302mChannels(7)).toBe(8);
        expect(normalize302mChannels(8)).toBe(8);
        expect(normalize302mChannels(48)).toBe(8);
        expect(normalize302mChannels(Number.NaN)).toBe(2);
    });

    it("sizes the per-branch mix matrix from the producer's real 302M width", () => {
        // An 8-channel 302M source with a map picking channels 7+8 (0-based 6,7)
        // → 2×8 matrix with those two cells lit. With the old stereo assumption
        // the same map would have been silently dropped (src index ≥ 2).
        const { fragment } = buildAudioMixInput({
            sources: [
                {
                    ...SRC,
                    sourceChannels: 8,
                    channelMap: [
                        { srcChannel: 6, dstChannel: 0 },
                        { srcChannel: 7, dstChannel: 1 },
                    ],
                },
            ],
        });
        const z = '(float)0.0000';
        const row0 = [z, z, z, z, z, z, '(float)1.0000', z].join(', ');
        const row1 = [z, z, z, z, z, z, z, '(float)1.0000'].join(', ');
        expect(fragment).toContain(`mix-matrix="<<${row0}>, <${row1}>>"`);
    });
});
