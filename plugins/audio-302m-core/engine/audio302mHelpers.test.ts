import { describe, it, expect } from 'vitest';
import {
    RETIMED_PACER_SLACK_MS,
    branchIgnorePcr,
    clampMixLatencyMs,
    retimedMixLatencyMs,
    buildAudioMixInput,
    build302mEncodeBranch,
    build302mMixBranch,
    liveDemuxName,
    liveMixInputBranch,
    mixInputBranchName,
    normalize302mChannels,
    pacedMixer,
} from './audio302mHelpers.js';

const SRC = { port: 40001, connectionId: 'c1' };
const SRC2 = { port: 40002, connectionId: 'c2' };

describe('pacedMixer', () => {
    it('always ends in the identity clock pacer — the OOM fix lives here only', () => {
        expect(
            pacedMixer({
                name: 'omix0',
                latencyNs: 50_000_000,
                caps: 'audio/x-raw,rate=48000,channels=2',
                pacerName: 'omix0_pace',
            }),
        ).toBe(
            'audiomixer name=omix0 force-live=true latency=50000000' +
                ' start-time-selection=first' +
                ' ! audio/x-raw,rate=48000,channels=2' +
                ' ! identity name=omix0_pace sync=true',
        );
    });

    it('anchors the output timeline at the first input (never at running time 0)', () => {
        // Default `zero` + the base_time=0 house clock = the mixer starts at
        // BOOT and races the box's uptime as silence before consuming a sample
        // (10.9.16.111, 2026-09-08: 13 min of dead Audio Out after a restart).
        const s = pacedMixer({
            name: 'm',
            latencyNs: 200_000_000,
            caps: 'audio/x-raw,rate=48000,channels=2',
            pacerName: 'm_out',
        });
        expect(s).toMatch(/^audiomixer name=m [^!]*\bstart-time-selection=first\b[^!]* ! /);
    });

    it('names the capsfilter only when the caller needs to address it', () => {
        expect(
            pacedMixer({
                name: 'mixin',
                latencyNs: 200_000_000,
                caps: 'audio/x-raw,rate=48000,channels=2',
                capsName: 'mixin_caps',
                pacerName: 'mixin_out',
            }),
        ).toContain('! capsfilter name=mixin_caps caps="audio/x-raw,rate=48000,channels=2" !');
    });
});

describe('buildAudioMixInput — many sources (mixer arm)', () => {
    it('emits a force-live audiomixer with the latency budget applied', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [SRC, SRC2] });
        // Callers continue from the named terminal element, not the raw mixer.
        expect(continuationName).toBe('mixin_out');
        expect(fragment).toContain('audiomixer name=mixin force-live=true');
        expect(fragment).toContain('latency=200000000');
        expect(fragment).not.toContain('min-upstream-latency');
    });

    it('pins the mixer OUTPUT caps — a force-live aggregator fixates before inputs deliver caps and otherwise goes mono (gate01 VU bug)', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], channels: 2 });
        expect(fragment).toContain(
            'capsfilter name=mixin_caps caps="audio/x-raw,rate=48000,channels=2"',
        );
    });

    it('paces the mixer on the pipeline clock — force-live free-runs after all pads EOS', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [SRC, SRC2] });
        // The pacer IS the continuation point: a caller branching off the
        // capsfilter instead would bypass it and get the free-run back.
        expect(fragment).toContain(
            'capsfilter name=mixin_caps caps="audio/x-raw,rate=48000,channels=2"' +
                ' ! identity name=mixin_out sync=true',
        );
        expect(continuationName).toBe('mixin_out');
        expect(fragment.endsWith(`${continuationName}.`)).toBe(false);
        // Minimal props — identity's `single-segment` already defaults to false.
        expect(fragment).not.toContain('single-segment');
    });

    it('names the pacer off a custom mixer name', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC, SRC2],
            mixerName: 'progmix',
        });
        expect(continuationName).toBe('progmix_out');
        expect(fragment).toContain('identity name=progmix_out sync=true');
    });

    it('clamps the latency budget to 20–2000 ms', () => {
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 5 }).fragment).toContain(
            'latency=20000000',
        );
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 9999 }).fragment).toContain(
            'latency=2000000000',
        );
    });

    it('builds one branch per source, each ending at the mixer', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment.match(/! mixin\./g)).toHaveLength(2);
        expect(fragment.match(/avdec_s302m/g)).toHaveLength(2);
    });

    it('pins 48 kHz and the requested channel count on every branch', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], channels: 2 });
        expect(fragment.match(/! audio\/x-raw,rate=48000,channels=2 ! queue/g)).toHaveLength(2);
    });

    it('keeps the mixer (and the pacer) for a fan-in with no sources yet', () => {
        const { fragment, continuationName } = buildAudioMixInput({ sources: [] });
        expect(fragment).toBe(
            'audiomixer name=mixin force-live=true latency=200000000' +
                ' start-time-selection=first' +
                ' ! capsfilter name=mixin_caps caps="audio/x-raw,rate=48000,channels=2"' +
                ' ! identity name=mixin_out sync=true',
        );
        expect(continuationName).toBe('mixin_out');
    });
});

describe('buildAudioMixInput — named demuxers for stamp alignment', () => {
    it('names every branch tsdemux and returns them in source order', () => {
        const two = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(two.demuxes).toEqual(['mixin_demux0', 'mixin_demux1']);
        expect(two.fragment).toContain('tsdemux name=mixin_demux0 latency=0');
        expect(two.fragment).toContain('tsdemux name=mixin_demux1 latency=0');
        expect(buildAudioMixInput({ sources: [SRC], mixerName: 'prog' }).demuxes).toEqual([
            'prog_demux0',
        ]);
        expect(buildAudioMixInput({ sources: [] }).demuxes).toEqual([]);
    });
});

describe('buildAudioMixInput — declared aggregation latency', () => {
    it('the mixer arm reports its effective (clamped) latency so a paced sink can subtract it', () => {
        expect(buildAudioMixInput({ sources: [SRC, SRC2] }).mixerLatencyNs).toBe(200_000_000);
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 50 }).mixerLatencyNs).toBe(
            50_000_000,
        );
        // Same clamp as the fragment: 20–2000 ms.
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 5 }).mixerLatencyNs).toBe(
            20_000_000,
        );
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 9999 }).mixerLatencyNs).toBe(
            2_000_000_000,
        );
        expect(buildAudioMixInput({ sources: [] }).mixerLatencyNs).toBe(200_000_000);
    });

    it('the single-source arm declares none — nothing to compensate', () => {
        expect(
            buildAudioMixInput({ sources: [SRC], latencyMs: 500 }).mixerLatencyNs,
        ).toBeUndefined();
    });
});

describe('buildAudioMixInput — one source (direct branch, no mixer)', () => {
    it('drops the aggregator entirely: no audiomixer, no pacer, no mix latency', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC],
            latencyMs: 500,
        });
        expect(fragment).not.toContain('audiomixer');
        expect(fragment).not.toContain('identity');
        expect(fragment).not.toContain('latency=500000000');
        // Same continuation name as the mixer arm — callers stay topology-agnostic.
        expect(continuationName).toBe('mixin_out');
        expect(
            fragment.endsWith('capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=2"'),
        ).toBe(true);
    });

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
            'tsdemux name=mixin_demux0 latency=0 ignore-pcr=true ! audio/x-smpte-302m ! avdec_s302m',
        );
        // `sourceChannels: 1` still means a stereo 302M wire (no mono layout
        // exists) — the matrix must be 2 columns wide.
        expect(fragment).toContain(
            'audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)1.0000, (float)0.0000>>" ! audioresample',
        );
        expect(fragment).toContain(
            'queue leaky=0 max-size-time=250000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('honours a custom mixer name for the terminal element', () => {
        const { fragment, continuationName } = buildAudioMixInput({
            sources: [SRC],
            mixerName: 'inmix2',
        });
        expect(continuationName).toBe('inmix2_out');
        expect(fragment).toContain('capsfilter name=inmix2_out');
    });
});

describe('buildAudioMixInput — live-input mode (#787)', () => {
    it('always builds the mixer arm, each source a named bin on an explicit pad', () => {
        const one = buildAudioMixInput({ sources: [SRC], liveInputs: true });
        expect(one.fragment).toContain('audiomixer name=mixin force-live=true');
        expect(one.continuationName).toBe('mixin_out');
        expect(one.mixerLatencyNs).toBe(200_000_000);
        expect(one.fragment).toContain(`( name=${mixInputBranchName('mixin', 'c1')} unixfdsrc`);
        expect(one.fragment).toContain(') ! mixin.sink_0');

        const two = buildAudioMixInput({ sources: [SRC, SRC2], liveInputs: true });
        expect(two.fragment).toContain(') ! mixin.sink_0');
        expect(two.fragment).toContain(') ! mixin.sink_1');
        expect(two.fragment.match(/\( name=mixin_in_[0-9a-f]{6} /g)).toHaveLength(2);
    });

    it('keys demuxer names by connection, never by position', () => {
        const { fragment, demuxes } = buildAudioMixInput({
            sources: [SRC, SRC2],
            liveInputs: true,
        });
        expect(demuxes).toEqual([liveDemuxName('mixin', 'c1'), liveDemuxName('mixin', 'c2')]);
        expect(fragment).not.toContain('mixin_demux0');
        expect(fragment).toContain(`tsdemux name=${liveDemuxName('mixin', 'c1')} latency=0`);
    });

    it('renders every start-time branch through liveMixInputBranch, byte for byte', () => {
        const { fragment } = buildAudioMixInput({
            sources: [{ ...SRC, channelMap: [{ srcChannel: 0, dstChannel: 0, gain: 0.5 }] }],
            liveInputs: true,
            channels: 2,
            branchQueueMs: 250,
        });
        const b = liveMixInputBranch(
            'mixin',
            { ...SRC, channelMap: [{ srcChannel: 0, dstChannel: 0, gain: 0.5 }] },
            { channels: 2, branchQueueMs: 250 },
        );
        expect(b.element).toBe('mixin');
        expect(b.name).toBe(mixInputBranchName('mixin', 'c1'));
        expect(fragment).toContain(`( name=${b.name} ${b.description} ) ! mixin.sink_0`);
        expect(b.description).toContain('mix-matrix=');
        expect(b.description).toContain('max-size-time=250000000');
    });

    it('build302mMixBranch ends in the branch queue and carries no mixer link', () => {
        const branch = build302mMixBranch(SRC, { channels: 2, demuxName: 'd1' });
        expect(branch).toBe(
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000' +
                ' ! tsdemux name=d1 latency=0 ignore-pcr=true ! audio/x-smpte-302m ! avdec_s302m' +
                ' ! audioconvert ! audioresample' +
                ' ! audio/x-raw,rate=48000,channels=2' +
                ' ! queue leaky=0 max-size-time=100000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('off by default: the classic strings are untouched', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(fragment).not.toContain('( name=');
        expect(fragment).toContain('! mixin. ');
        expect(fragment).toContain('tsdemux name=mixin_demux0 latency=0');
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

    it('steers tsdemux pad selection with 302M caps (wrong-content TS fails soft)', () => {
        for (const sources of [[SRC], [SRC, SRC2]]) {
            const { fragment } = buildAudioMixInput({ sources });
            expect(fragment).toContain(
                'tsdemux name=mixin_demux0 latency=0 ignore-pcr=true ! audio/x-smpte-302m ! avdec_s302m',
            );
        }
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

describe('fan-in hop latency — the hop costs mixLatencyMs, not a PTS lead', () => {
    it('ignores the PCR on every branch unless a stamp-aligned caller opts out', () => {
        const dflt = buildAudioMixInput({ sources: [SRC, SRC2] });
        expect(dflt.fragment.match(/ignore-pcr=true/g)).toHaveLength(2);
        const kept = buildAudioMixInput({ sources: [SRC, SRC2], ignorePcr: false });
        expect(kept.fragment).not.toContain('ignore-pcr');
        const live = buildAudioMixInput({ sources: [SRC], liveInputs: true });
        expect(live.fragment).toContain('ignore-pcr=true');
    });

    it('never forces an upstream latency on the aggregator (it doubled the pacer hold)', () => {
        const m = pacedMixer({
            name: 'm',
            latencyNs: 50_000_000,
            caps: 'audio/x-raw',
            pacerName: 'o',
        });
        expect(m).toContain('latency=50000000');
        expect(m).not.toContain('min-upstream-latency');
    });

    it('floors the latency budget at 20 ms', () => {
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 5 }).mixerLatencyNs).toBe(
            20_000_000,
        );
    });
});

describe('buildAudioMixInput — retimed (transform-producer) fan-in', () => {
    it('the pacer keeps its sync but gets the ahead slack (content stamped ahead passes at arrival pace)', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC, SRC2], retimed: true });
        expect(fragment).toContain(
            `identity name=mixin_out sync=true ts-offset=-${RETIMED_PACER_SLACK_MS * 1_000_000}`,
        );
        expect(RETIMED_PACER_SLACK_MS).toBeGreaterThanOrEqual(9_000); // covers the 8.3 s lead measured
    });

    it('drops ignore-pcr on every branch: the retime replaces tsdemux timestamps', () => {
        const { fragment, demuxes } = buildAudioMixInput({
            sources: [SRC, SRC2],
            retimed: true,
            liveInputs: true,
        });
        expect(fragment).not.toContain('ignore-pcr');
        expect(demuxes).toEqual([liveDemuxName('mixin', 'c1'), liveDemuxName('mixin', 'c2')]);
        for (const d of demuxes) expect(fragment).toContain(`tsdemux name=${d} latency=0 !`);
    });

    it('a single-source retimed fan-in is the direct branch, no pacer', () => {
        const { fragment, demuxes } = buildAudioMixInput({ sources: [SRC], retimed: true });
        expect(fragment).not.toContain('identity');
        expect(fragment).not.toContain('ignore-pcr');
        expect(demuxes).toEqual(['mixin_demux0']);
    });

    it('a live add renders the same branch text as the retimed start-time branch', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC], retimed: true, liveInputs: true });
        const live = liveMixInputBranch('mixin', SRC, { ignorePcr: branchIgnorePcr({ retimed: true }) });
        expect(fragment).toContain(`( name=${live.name} ${live.description} )`);
    });

    it('off by default — every other caller keeps its string byte for byte', () => {
        const a = buildAudioMixInput({ sources: [SRC, SRC2] }).fragment;
        expect(a).toContain('ignore-pcr=true');
        expect(a).toMatch(/identity name=mixin_out sync=true(?! ts-offset)/);
        expect(pacedMixer({ name: 'm', latencyNs: 1, caps: 'c', pacerName: 'p' })).toMatch(
            /identity name=p sync=true$/,
        );
    });

    it('branchIgnorePcr: explicit wins, else off when retimed, else the default', () => {
        expect(branchIgnorePcr({})).toBeUndefined();
        expect(branchIgnorePcr({ retimed: true })).toBe(false);
        expect(branchIgnorePcr({ retimed: true, ignorePcr: true })).toBe(true);
        expect(branchIgnorePcr({ ignorePcr: false })).toBe(false);
    });
});

describe('retimedMixLatencyMs — a retimed fan-in waits at least the route D', () => {
    it('the larger of the configured budget and D, clamped like the fan-in', () => {
        expect(retimedMixLatencyMs(20, 600)).toBe(600);
        expect(retimedMixLatencyMs(800, 60)).toBe(800);
        expect(retimedMixLatencyMs(20, 5000)).toBe(2000);
        expect(retimedMixLatencyMs(20, 0)).toBe(20);
        expect(retimedMixLatencyMs(Number.NaN, Number.NaN)).toBe(20);
    });

    it('clampMixLatencyMs is the clamp buildAudioMixInput applies', () => {
        expect(clampMixLatencyMs(undefined)).toBe(200);
        expect(clampMixLatencyMs(5)).toBe(20);
        expect(clampMixLatencyMs(9000)).toBe(2000);
        const { mixerLatencyNs } = buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 9000 });
        expect(mixerLatencyNs).toBe(clampMixLatencyMs(9000) * 1_000_000);
    });
});
