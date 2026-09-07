import { describe, it, expect } from 'vitest';
import { classifyCaps, type EngineServices } from '@media-router/engine';
import { TsSplitterModule } from './TsSplitterModule.js';

/**
 * The classifier set `TsSplitterModule.registerServices` installs is what
 * `probeMpegTsStream` uses engine-wide (audio-transcoder, audio-decoder).
 * These pin the codec ids the decoder chains switch on.
 */
describe('TsSplitterModule codec classifiers', () => {
    TsSplitterModule.registerServices({} as unknown as EngineServices);

    it('classifies SMPTE 302M PCM as s302m — the bare tsdemux caps carry no channels', () => {
        const r = classifyCaps('audio/x-smpte-302m');
        expect(r.codec).toBe('s302m');
        expect(r.channels).toBeUndefined();
    });

    it('keeps the compressed codecs', () => {
        expect(classifyCaps('audio/x-opus, rate=(int)48000, channels=(int)1').codec).toBe('opus');
        expect(
            classifyCaps('audio/mpeg, mpegversion=(int)4, stream-format=(string)adts').codec,
        ).toBe('aac');
        expect(classifyCaps('audio/mpeg, mpegversion=(int)1, layer=(int)2').codec).toBe('mp2');
        expect(classifyCaps('audio/x-ac3, rate=(int)48000').codec).toBe('ac3');
    });
});
