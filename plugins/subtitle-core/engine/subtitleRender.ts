/**
 * The one way a module RENDERS subtitles. Both renderers (video-player on its
 * display, transcoder as burn-in) do exactly the same three things when a
 * source is wired to `subtitles-in`: splice one `textoverlay` into their
 * video path, add a bus input for the cue TS, and install the subtitle bridge
 * on the pipeline. This module owns that trio and the element names the
 * bridge addresses, so the renderers differ only in WHERE the overlay sits.
 */

import type { RunnerHook } from '@media-router/engine';
import {
    buildSubtitleInput,
    buildSubtitleOverlayElement,
    subtitleOverlayLiveUpdates,
    subtitleRunnerHook,
    type SubtitleOverlayProps,
} from './subtitleOverlay.js';

/** `name=` of the textoverlay the bridge drives (one per pipeline). */
export const SUBTITLE_OVERLAY_NAME = 'subov';
/** `name=` of the tsdemux the cue TS arrives on (one per pipeline). */
export const SUBTITLE_DEMUX_NAME = 'subdemux';

/** The subtitle source as `getModuleBusSource(instanceId, SUBTITLE_INPUT_PORT_ID)` returns it. */
export interface SubtitleSource {
    port: number;
    socketPath?: string;
}

export interface SubtitleRenderPlan {
    /** `textoverlay …` — splice into the video path with `!` on both sides. */
    overlayElement: string;
    /** `unixfdsrc … ! tsdemux name=subdemux` — append as a separate fragment (space, not `!`). */
    inputFragment: string;
    /** Put on the PipelineDescription verbatim. */
    runnerHooks: RunnerHook[];
}

/** Everything a renderer adds to its description for a wired subtitle source. */
export function subtitleRenderPlan(
    source: SubtitleSource,
    config: Record<string, unknown>,
): SubtitleRenderPlan {
    return {
        overlayElement: buildSubtitleOverlayElement(SUBTITLE_OVERLAY_NAME, config),
        inputFragment: buildSubtitleInput({
            port: source.port,
            socketPath: source.socketPath,
            demuxName: SUBTITLE_DEMUX_NAME,
        }),
        runnerHooks: [
            subtitleRunnerHook({
                overlay: { demux: SUBTITLE_DEMUX_NAME, overlay: SUBTITLE_OVERLAY_NAME },
            }),
        ],
    };
}

/**
 * Push a live config change onto the running overlay. `setProperty` is the
 * module's `setElementProperty` bound to the overlay name; a miss (no subtitle
 * source wired → no overlay element) is reported through `onError`, never thrown.
 */
export async function applySubtitleLiveUpdates(
    changes: Record<string, unknown>,
    config: Record<string, unknown>,
    setProperty: (
        property: keyof SubtitleOverlayProps,
        value: string | number | boolean,
    ) => Promise<unknown>,
    onError: (err: unknown, property: string) => void,
): Promise<void> {
    for (const u of subtitleOverlayLiveUpdates(changes, config)) {
        try {
            await setProperty(u.property, u.value);
        } catch (err) {
            onError(err, u.property);
        }
    }
}
