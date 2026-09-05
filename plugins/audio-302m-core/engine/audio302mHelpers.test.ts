import { describe, it, expect } from 'vitest';
import {
    buildAudioMixInput,
    build302mEncodeBranch,
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
                ' min-upstream-latency=50000000' +
                ' ! audio/x-raw,rate=48000,channels=2' +
                ' ! identity name=omix0_pace sync=true',
        );
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
        expect(fragment).toContain('min-upstream-latency=200000000');
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

    it('clamps the latency budget to 50–2000 ms', () => {
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 10 }).fragment).toContain(
            'latency=50000000',
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
                ' min-upstream-latency=200000000' +
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
        // Same clamp as the fragment: 50–2000 ms.
        expect(buildAudioMixInput({ sources: [SRC, SRC2], latencyMs: 10 }).mixerLatencyNs).toBe(
            50_000_000,
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
            'tsdemux name=mixin_demux0 latency=0 ! audio/x-smpte-302m ! avdec_s302m',
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
                'tsdemux name=mixin_demux0 latency=0 ! audio/x-smpte-302m ! avdec_s302m',
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
