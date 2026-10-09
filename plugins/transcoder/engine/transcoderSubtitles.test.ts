import { describe, it, expect } from 'vitest';
import {
    SUBTITLE_HOLD_MAX_BYTES,
    SUBTITLE_HOLD_NAME,
    buildSubtitleHold,
    transcoderSubtitles,
} from './transcoderSubtitles.js';

describe('transcoder subtitle wiring', () => {
    it('hold: none at 0 ms, else a time-threshold queue with 1 s headroom and a byte cap', () => {
        expect(buildSubtitleHold(0)).toBe('');
        expect(buildSubtitleHold(-5)).toBe('');
        expect(buildSubtitleHold(1400)).toBe(
            `queue name=${SUBTITLE_HOLD_NAME} max-size-buffers=0 max-size-bytes=${SUBTITLE_HOLD_MAX_BYTES} ` +
                'max-size-time=2400000000 min-threshold-time=1400000000 ! ',
        );
        expect(SUBTITLE_HOLD_MAX_BYTES).toBe(16 * 1024 * 1024);
    });

    it('nothing without a subtitle source', () => {
        expect(transcoderSubtitles(undefined, 1400)).toBeNull();
    });

    it('with a source: overlay, hold, cue input, bridge hook and the python runner', () => {
        const subs = transcoderSubtitles(
            { port: 5600, socketPath: '/tmp/s.sock', config: {} },
            1400,
        )!;
        expect(subs.overlay).toMatch(/^textoverlay name=subov .* ! $/);
        expect(subs.hold).toBe(buildSubtitleHold(1400));
        expect(subs.inputFragment).toMatch(/tsdemux name=subdemux latency=0$/);
        expect(subs.runnerHooks.map((h) => h.module)).toEqual(['subtitle_bridge']);
        expect(subs.runner).toBe('python');
        expect(transcoderSubtitles({ port: 5600, config: {} }, undefined)!.hold).toBe('');
    });
});
