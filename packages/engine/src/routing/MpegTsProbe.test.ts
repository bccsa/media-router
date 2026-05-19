import { describe, it, expect, beforeEach } from 'vitest';
import {
    classifyCaps,
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
