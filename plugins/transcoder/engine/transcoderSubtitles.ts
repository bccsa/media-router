/**
 * The transcoder's subtitle burn-in wiring: the shared render plan (overlay on
 * the conformed frame, cue input, bridge hook, python runner) plus the sync
 * hold on the compressed video (ADR-0005 note, ADR-0016 amendment 2026-10-09).
 */

import type { RunnerHook } from '@media-router/engine';
import { subtitleRenderPlan } from '@media-router/plugin-subtitle-core';

/** `name=` of the subtitle-sync hold queue on the compressed video path. */
export const SUBTITLE_HOLD_NAME = 'subhold';
/** Runaway cap of the hold (≈ 12 s at 10 Mbit/s): its time level follows the retimed stamps. */
export const SUBTITLE_HOLD_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Non-leaky delay line before h264parse (~2 MB/s at 1080i, never raw frames): min-threshold
 * keeps it `holdMs` full, max-size-time 1 s above (else it fills first and stalls), and the
 * byte cap bounds a time level a re-anchor step mis-states. '' when `holdMs` ≤ 0.
 */
export function buildSubtitleHold(holdMs: number): string {
    if (!(holdMs > 0)) return '';
    return (
        `queue name=${SUBTITLE_HOLD_NAME} max-size-buffers=0 max-size-bytes=${SUBTITLE_HOLD_MAX_BYTES} ` +
        `max-size-time=${(holdMs + 1000) * 1_000_000} min-threshold-time=${holdMs * 1_000_000} ! `
    );
}

export interface TranscoderSubtitles {
    /** `textoverlay … ! ` — before the rendition tee. */
    overlay: string;
    /** The hold fragment (`… ! `) before h264parse, '' without a delay. */
    hold: string;
    /** Appended to the pipeline string with a space. */
    inputFragment: string;
    runnerHooks: RunnerHook[];
    runner: 'python';
}

/** Everything a wired subtitle source adds to the transcode pipeline; null without one. */
export function transcoderSubtitles(
    source: { port: number; socketPath?: string; config: Record<string, unknown> } | undefined,
    delayMs: number | undefined,
): TranscoderSubtitles | null {
    if (!source) return null;
    const plan = subtitleRenderPlan(source, source.config);
    return {
        overlay: `${plan.overlayElement} ! `,
        hold: buildSubtitleHold(delayMs ?? 0),
        inputFragment: plan.inputFragment,
        runnerHooks: plan.runnerHooks,
        runner: plan.runner,
    };
}
