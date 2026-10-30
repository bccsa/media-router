/**
 * The transcoder's subtitle burn-in wiring: the shared render plan (overlay on the conformed
 * frame, cue input, bridge hook, python runner) and the burn-in pace group (house-clock
 * WI-P3-13, OQ-24): a watch on the compressed video here, one on each cue pad in the bridge.
 */

import { tsQueueByteCap, type RunnerHook } from '@media-router/engine';
import { subtitleRenderPlan } from '@media-router/plugin-subtitle-core';

/** The burn-in's pace group: the video watch and the bridge's cue readers share its pace. */
export const BURNIN_ALIGNER = 'burnin';
/** `name=` of the video's watch. */
export const BURNIN_VIDEO_WATCH = 'aw_burnv';

/**
 * The video's member of the pace group, on the compressed video before h264parse: an access
 * unit leaves at its time + the pace, the cue path's measured lateness, so each cue reaches the
 * bridge ahead of its frame by the decode latency. 5 s at 64 Mbit/s; full, it holds upstream.
 */
export function buildBurninWatch(): string {
    return (
        `mralignwatch name=${BURNIN_VIDEO_WATCH} aligner=${BURNIN_ALIGNER} input=video ` +
        `max-size-bytes=${tsQueueByteCap(5000)} ! `
    );
}

export interface TranscoderSubtitles {
    /** `textoverlay … ! ` — before the rendition tee. */
    overlay: string;
    /** The video's watch (`… ! `) before h264parse. */
    videoWatch: string;
    /** Appended to the pipeline string with a space. */
    inputFragment: string;
    runnerHooks: RunnerHook[];
    runner: 'python';
}

/** Everything a wired subtitle source adds to the transcode pipeline; null without one. */
export function transcoderSubtitles(
    source: { port: number; socketPath?: string; config: Record<string, unknown> } | undefined,
): TranscoderSubtitles | null {
    if (!source) return null;
    const plan = subtitleRenderPlan(source, source.config, { aligner: BURNIN_ALIGNER });
    return {
        overlay: `${plan.overlayElement} ! `,
        videoWatch: buildBurninWatch(),
        inputFragment: plan.inputFragment,
        runnerHooks: plan.runnerHooks,
        runner: plan.runner,
    };
}
