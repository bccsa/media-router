import { describe, it, expect, vi } from 'vitest';
import { buildAudioMixInput, build302mEncodeBranch } from './audio302mHelpers.js';

const SRC = { host: '239.255.0.1', port: 40001, connectionId: 'c1' };

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
            sources: [SRC, { host: '239.255.0.1', port: 40002, connectionId: 'c2' }],
        });
        expect(fragment.match(/! mixin\./g)).toHaveLength(2);
        expect(fragment.match(/avdec_s302m/g)).toHaveLength(2);
    });

    it('uses the per-connection unixfd socket under unixfd transport', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        try {
            const { fragment } = buildAudioMixInput({
                sources: [{ ...SRC, socketPath: '/tmp/mr-bus-40001-abc.sock' }],
            });
            expect(fragment).toContain('unixfdsrc');
            expect(fragment).toContain('socket-path=/tmp/mr-bus-40001-abc.sock');
        } finally {
            vi.unstubAllEnvs();
        }
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
