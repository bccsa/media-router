/**
 * Render keep-up reporting — what the runner's `renderwatch:lag` event means
 * for the operator, and when it earns a free pipeline rebuild.
 *
 * Lag means frames are being shed by the leaky queues: the decode/convert/
 * render chain cannot sustain the source rate. Nothing in the module can fix
 * that, so the health message has to tell the operator what to change — and
 * getting the attribution right is the whole job here.
 */

/** How long after a stall-resume a renderwatch lag earns a free rebuild. */
export const POST_RESUME_HEAL_WINDOW_MS = 120_000;

/** Payload shape of `renderwatch:lag` (all fields optional — older runners). */
export interface RenderLagPayload {
    achievedFps?: number;
    expectedFps?: number;
    arrivalsFps?: number;
}

export interface RenderLagReport {
    /** Operator-facing health warning. */
    message: string;
    /**
     * The SOURCE is under-delivering rather than the render chain falling
     * behind. Also gates the self-heal: a rebuild can't manufacture frames the
     * stream never carried.
     */
    sourceShortfall: boolean;
}

/**
 * Attribute the shortfall correctly: when the sink presents essentially
 * everything that ARRIVES, the render chain isn't the problem — the source is
 * delivering fewer frames (link jitter, encoder hiccup). Telling the operator
 * to lower the resolution for that would be wrong advice. Field case,
 * 2026-08-01: OCC link dips to ~41 fps for a few seconds; arrivals ==
 * presented, drops == 0.
 */
export function describeRenderLag(payload: unknown): RenderLagReport {
    const p = (payload ?? {}) as RenderLagPayload;
    const rate =
        typeof p.achievedFps === 'number' && typeof p.expectedFps === 'number'
            ? ` (${p.achievedFps}/${p.expectedFps} fps)`
            : '';
    const sourceShortfall =
        typeof p.achievedFps === 'number' &&
        typeof p.arrivalsFps === 'number' &&
        p.achievedFps >= p.arrivalsFps - 1;
    return {
        sourceShortfall,
        message: sourceShortfall
            ? `Stream under-delivering${rate} — check the source/link (display is keeping up)`
            : `Video output can't keep up${rate} — lower the stream or display resolution`,
    };
}

export interface SelfHealInput {
    sourceShortfall: boolean;
    /** Whether this resume's one free rebuild has already been spent. */
    healDone: boolean;
    /**
     * When the last stall-resume rebuilt the live pipeline (0 = never), on the
     * BOOT-relative clock (`bootNowMs`) — the same one the cog-restack ordering
     * uses.
     */
    lastStallResumeAt: number;
    /**
     * "Now" on the SAME clock as `lastStallResumeAt`. Required, not defaulted:
     * the Pi has no RTC, so it boots at whatever epoch the last shutdown left
     * and NTP steps the wall clock by hours seconds into the session. A step
     * landing inside this 120 s window would make a just-resumed pipeline look
     * hours old (heal silently skipped) or the reverse. Taking the value from
     * the caller means both sides can only ever come from `bootNowMs`.
     */
    now: number;
}

/**
 * Self-heal: lag right after a stall-resume means the live pipeline rebuilt
 * against a source that had not fully settled (field case 2026-08-02: skewed
 * timing baseline → green slice corruption + steady late-drops until a MANUAL
 * restart). One free rebuild per resume; a rebuild that lags again is a real
 * render problem and stays for the operator to see.
 */
export function shouldSelfHealAfterResume(input: SelfHealInput): boolean {
    if (input.sourceShortfall || input.healDone) return false;
    if (input.lastStallResumeAt <= 0) return false;
    return input.now - input.lastStallResumeAt < POST_RESUME_HEAL_WINDOW_MS;
}
