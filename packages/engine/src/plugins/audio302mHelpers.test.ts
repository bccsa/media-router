import { describe, it, expect } from 'vitest';
import { buildAudioMixInput, build302mEncodeBranch, mixMatrixClause } from './audio302mHelpers.js';

const SRC = { port: 40001, connectionId: 'c1' };

describe('buildAudioMixInput', () => {
    it('emits a force-live audiomixer with the latency budget applied', () => {
        const { fragment, mixerName } = buildAudioMixInput({ sources: [SRC] });
        // Callers continue from the named output capsfilter, not the raw mixer.
        expect(mixerName).toBe('mixin_out');
        expect(fragment).toContain('audiomixer name=mixin force-live=true');
        expect(fragment).toContain('latency=200000000');
        expect(fragment).toContain('min-upstream-latency=200000000');
    });

    it('pins the mixer OUTPUT caps — a force-live aggregator fixates before inputs deliver caps and otherwise goes mono (gate01 VU bug)', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC], channels: 2 });
        expect(fragment).toContain(
            'capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=2"',
        );
    });

    it('clamps the latency budget to 50–2000 ms', () => {
        expect(buildAudioMixInput({ sources: [SRC], latencyMs: 10 }).fragment).toContain(
            'latency=50000000',
        );
        expect(buildAudioMixInput({ sources: [SRC], latencyMs: 9999 }).fragment).toContain(
            'latency=2000000000',
        );
    });

    it('builds one branch per source, each ending at the mixer', () => {
        const { fragment } = buildAudioMixInput({
            sources: [SRC, { port: 40002, connectionId: 'c2' }],
        });
        expect(fragment.match(/! mixin\./g)).toHaveLength(2);
        expect(fragment.match(/avdec_s302m/g)).toHaveLength(2);
    });

    it('ingests each source over unixfd, defaulting to the channel socket', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC] });
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40001.sock');
    });

    it('uses the per-connection unixfd edge socket when supplied', () => {
        const { fragment } = buildAudioMixInput({
            sources: [{ ...SRC, socketPath: '/tmp/mr-bus-40001-abc.sock' }],
        });
        expect(fragment).toContain('unixfdsrc socket-path=/tmp/mr-bus-40001-abc.sock');
    });

    it('steers tsdemux pad selection with 302M caps (wrong-content TS fails soft)', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC] });
        expect(fragment).toContain('tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m');
    });

    it('pins 48 kHz and the requested channel count on every branch', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC], channels: 2 });
        expect(fragment).toContain('audio/x-raw,rate=48000,channels=2');
    });

    it('is PTS-preserving: no pulsesrc, no do-timestamp, no tsparse re-stamping', () => {
        const { fragment } = buildAudioMixInput({ sources: [SRC] });
        expect(fragment).not.toContain('pulsesrc');
        expect(fragment).not.toContain('do-timestamp');
        expect(fragment).not.toContain('set-timestamps');
    });
});

describe('mixMatrixClause / per-connection channel maps', () => {
    it('renders identity-with-gain entries as a [dst][src] matrix', () => {
        const clause = mixMatrixClause(
            [
                { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                { srcChannel: 1, dstChannel: 1 },
            ],
            2,
            2,
        );
        expect(clause).toBe(
            ' mix-matrix="<<(float)0.5000, (float)0.0000>, <(float)0.0000, (float)1.0000>>"',
        );
    });

    it('mono→stereo fan-out and stereo→mono downmix', () => {
        expect(
            mixMatrixClause(
                [
                    { srcChannel: 0, dstChannel: 0 },
                    { srcChannel: 0, dstChannel: 1 },
                ],
                1,
                2,
            ),
        ).toBe(' mix-matrix="<<(float)1.0000>, <(float)1.0000>>"');
        expect(
            mixMatrixClause(
                [
                    { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                    { srcChannel: 1, dstChannel: 0, gain: 0.5 },
                ],
                2,
                1,
            ),
        ).toBe(' mix-matrix="<<(float)0.5000, (float)0.5000>>"');
    });

    it('ignores out-of-range entries and non-finite gains', () => {
        const clause = mixMatrixClause(
            [
                { srcChannel: 7, dstChannel: 0 },
                { srcChannel: -1, dstChannel: 1 },
                { srcChannel: 0, dstChannel: 0, gain: Number.NaN },
            ],
            2,
            2,
        );
        expect(clause).toBe(
            ' mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)0.0000, (float)0.0000>>"',
        );
    });

    it('buildAudioMixInput renders a source channelMap on that branch only', () => {
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
            'audioconvert mix-matrix="<<(float)1.0000>, <(float)1.0000>>" ! audioresample',
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
});
