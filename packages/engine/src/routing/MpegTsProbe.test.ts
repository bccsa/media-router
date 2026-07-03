import { describe, it, expect, beforeEach } from 'vitest';
import {
    classifyCaps,
    selectAudioCaps,
    registerCodecClassifier,
    _resetCodecClassifiersForTests,
    type CodecClassifier,
} from './MpegTsProbe.js';

describe('codec classifier registry', () => {
    beforeEach(() => {
        _resetCodecClassifiersForTests();
    });

    it('returns codec=unknown when no classifier is registered', () => {
        const result = classifyCaps('audio/x-opus, rate=(int)48000');
        expect(result.codec).toBe('unknown');
    });

    it('uses a single registered classifier when it matches', () => {
        const opus: CodecClassifier = {
            test: (caps) => caps.startsWith('audio/x-opus'),
            classify: () => 'opus',
        };
        registerCodecClassifier(opus);
        expect(classifyCaps('audio/x-opus, rate=(int)48000').codec).toBe('opus');
    });

    it('returns unknown when the registered classifier does not match', () => {
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-opus'),
            classify: () => 'opus',
        });
        expect(classifyCaps('audio/x-ac3').codec).toBe('unknown');
    });

    it('first-match-wins — most recently registered classifier is consulted first', () => {
        registerCodecClassifier({
            test: () => true,
            classify: () => 'catch-all',
        });
        // Registered later → unshift → tried first
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-opus'),
            classify: () => 'opus',
        });
        expect(classifyCaps('audio/x-opus').codec).toBe('opus');
        // Anything else falls through to the catch-all
        expect(classifyCaps('audio/x-anything').codec).toBe('catch-all');
    });

    it('extracts sampleRate and channels regardless of codec match', () => {
        // No classifier registered — but rate/channels parsing still works
        const result = classifyCaps(
            'audio/x-opus, rate=(int)48000, channels=(int)2, stream-format=(string)tdf',
        );
        expect(result.sampleRate).toBe(48000);
        expect(result.channels).toBe(2);
        expect(result.codec).toBe('unknown');
    });

    it('handles caps with neither rate nor channels', () => {
        const result = classifyCaps('audio/x-opus');
        expect(result.sampleRate).toBeUndefined();
        expect(result.channels).toBeUndefined();
    });

    it('preserves the rawCaps verbatim on the result', () => {
        const caps = 'audio/x-opus, rate=(int)44100';
        expect(classifyCaps(caps).rawCaps).toBe(caps);
    });
});

describe('selectAudioCaps', () => {
    // Real `gst-launch -v` output for a 4-channel AAC stream through the probe
    // pipeline `tsdemux ! parsebin ! fakesink`: the bare tsdemux pad caps omit
    // `channels`, the parsebin src pad carries it. selectAudioCaps must pick the
    // parsed line so the decoder sizes its null-sink to 4, not the default 2.
    const AAC_4CH_OUTPUT = [
        '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:audio_0100: caps = audio/mpeg, mpegversion=(int)4, stream-format=(string)adts',
        '/GstPipeline:pipeline0/GstAacParse:aacparse0.GstPad:src: caps = audio/mpeg, framed=(boolean)true, mpegversion=(int)4, level=(string)4, base-profile=(string)lc, profile=(string)lc, rate=(int)48000, channels=(int)4, stream-format=(string)adts',
        '/GstPipeline:pipeline0/GstFakeSink:fakesink0.GstPad:sink: caps = audio/mpeg, framed=(boolean)true, mpegversion=(int)4, rate=(int)48000, channels=(int)4, stream-format=(string)adts',
    ].join('\n');

    it('prefers the parsed caps line that carries channels over the bare tsdemux caps', () => {
        const caps = selectAudioCaps(AAC_4CH_OUTPUT);
        expect(caps).not.toBeNull();
        expect(classifyCaps(caps!).channels).toBe(4);
        expect(classifyCaps(caps!).sampleRate).toBe(48000);
    });

    it('falls back to the first audio caps when none report channels', () => {
        const output =
            '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:audio_0100: caps = audio/mpeg, mpegversion=(int)4, stream-format=(string)adts';
        expect(selectAudioCaps(output)).toBe(
            'audio/mpeg, mpegversion=(int)4, stream-format=(string)adts',
        );
    });

    it('returns null when no audio caps are present', () => {
        const output =
            '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:video_0101: caps = video/x-h264, stream-format=(string)byte-stream';
        expect(selectAudioCaps(output)).toBeNull();
    });

    it('ignores video caps and selects the audio caps with channels', () => {
        const output = [
            '/GstPipeline:pipeline0/GstTSDemux:tsdemux0.GstPad:video_0101: caps = video/x-h264, stream-format=(string)byte-stream',
            '/GstPipeline:pipeline0/GstAacParse:aacparse0.GstPad:src: caps = audio/mpeg, mpegversion=(int)4, rate=(int)48000, channels=(int)2, stream-format=(string)adts',
        ].join('\n');
        const caps = selectAudioCaps(output);
        expect(caps).not.toBeNull();
        expect(caps!.startsWith('audio/mpeg')).toBe(true);
        expect(classifyCaps(caps!).channels).toBe(2);
    });
});

describe('built-in mpegts-demuxer classifiers (smoke)', () => {
    // The actual classifiers live in mpegts-demuxer/MpegTsDemuxerModule.ts —
    // these tests duplicate the contracts so a future change in *either*
    // location surfaces. If the demuxer plugin changes the codec id strings,
    // update both.
    beforeEach(() => {
        _resetCodecClassifiersForTests();
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-ac3'),
            classify: () => 'ac3',
        });
        registerCodecClassifier({
            test: (caps) =>
                caps.startsWith('audio/mpeg') && /mpegversion=\(int\)1\b/.test(caps),
            classify: () => 'mp2',
        });
        registerCodecClassifier({
            test: (caps) =>
                caps.startsWith('audio/mpeg') && /mpegversion=\(int\)4\b/.test(caps),
            classify: () => 'aac',
        });
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-opus'),
            classify: () => 'opus',
        });
    });

    it.each([
        ['audio/x-opus, rate=(int)48000', 'opus'],
        ['audio/mpeg, mpegversion=(int)4, rate=(int)48000', 'aac'],
        ['audio/mpeg, mpegversion=(int)1, rate=(int)44100', 'mp2'],
        ['audio/x-ac3, rate=(int)48000', 'ac3'],
        ['audio/x-flac', 'unknown'],
    ])('classifies %s as %s', (caps, expected) => {
        expect(classifyCaps(caps).codec).toBe(expected);
    });
});
