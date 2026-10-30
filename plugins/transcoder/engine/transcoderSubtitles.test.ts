import { describe, it, expect } from 'vitest';
import {
    BURNIN_ALIGNER,
    BURNIN_VIDEO_WATCH,
    buildBurninWatch,
    transcoderSubtitles,
} from './transcoderSubtitles.js';

describe('transcoder subtitle wiring', () => {
    it("the video's burn-in watch: the pace group's video member, 5 s at 64 Mbit/s (WI-P3-13)", () => {
        expect(buildBurninWatch()).toBe(
            'mralignwatch name=aw_burnv aligner=burnin input=video max-size-bytes=40000000 ! ',
        );
        expect([BURNIN_ALIGNER, BURNIN_VIDEO_WATCH]).toEqual(['burnin', 'aw_burnv']);
    });

    it('nothing without a subtitle source', () => {
        expect(transcoderSubtitles(undefined)).toBeNull();
    });

    it('with a source: overlay, video watch, cue input, the bridge in the pace group, python', () => {
        const subs = transcoderSubtitles({ port: 5600, socketPath: '/tmp/s.sock', config: {} })!;
        expect(subs.overlay).toMatch(/^textoverlay name=subov .* ! $/);
        expect(subs.videoWatch).toBe(buildBurninWatch());
        expect(subs.inputFragment).toMatch(/ mrtsdemux name=subdemux media=private$/);
        // The bridge makes each cue pad's reader a sparse watch of the same group (S36).
        expect(subs.runnerHooks).toEqual([
            {
                module: 'subtitle_bridge',
                config: { overlay: { demux: 'subdemux', overlay: 'subov', aligner: 'burnin' } },
            },
        ]);
        expect(subs.runner).toBe('python');
        // No hold queue of any kind is left (OQ-24).
        expect(Object.keys(subs).sort()).toEqual([
            'inputFragment',
            'overlay',
            'runner',
            'runnerHooks',
            'videoWatch',
        ]);
    });
});
