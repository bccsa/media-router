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
    /**
     * Frames the sink itself reports DROPPED. Not read by the attribution
     * below — the render-chain/source split needs presented vs arrived, not the
     * sink's own count — but it is emitted by the runner and the module logs
     * the whole payload on the ok→warning edge (`renderWatch:` in the journal
     * line), which is where an operator reads it. Declared so that payload is
     * typed rather than `unknown`; do not delete it as unused.
     */
    droppedFps?: number;
}

/** What the shortfall was attributed to — drives the message and the journal line. */
export type RenderLagKind =
    /** The sink presents fewer frames than reach it. */
    | 'render-chain'
    /** Fewer frames arrive in the first place — a feed/link problem. */
    | 'source-shortfall'
    /** NOTHING is presented and nothing reaches the sink. */
    | 'total-stall';

export interface RenderLagReport {
    kind: RenderLagKind;
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
 * What the MODULE knows that the runner's payload cannot say.
 *
 * `arrivalsFps` is counted at the SINK pad, so a zero there is equally
 * consistent with "the source went quiet" and "the decoder wedged and nothing
 * gets that far" — the payload alone cannot separate them.
 */
export interface RenderLagContext {
    /**
     * The module's bus-stall latch (`busStallDetected`): the runner's 5 s stall
     * watchdog saw no buffer at all off the source socket. Omit when there is
     * no signal — the message then states the ambiguity instead of guessing.
     *
     * Ordering makes this trustworthy at the moment a lag event lands: the
     * stall watchdog trips after 5 s of silence, while a lag event needs
     * `trip_windows` (3) × `RENDER_WATCH_WINDOW_MS` (2 s) = 6 s of bad windows.
     * A genuinely dead source has therefore always latched the flag first.
     */
    sourceSilent?: boolean;
}

/**
 * Attribute the shortfall correctly: when the sink presents essentially
 * everything that ARRIVES, the render chain isn't the problem — the source is
 * delivering fewer frames (link jitter, encoder hiccup). Telling the operator
 * to lower the resolution for that would be wrong advice. Field case,
 * 2026-08-01: OCC link dips to ~41 fps for a few seconds; arrivals ==
 * presented, drops == 0.
 *
 * A TOTAL stall is the case that guard used to get backwards. With
 * `achievedFps` 0 and `arrivalsFps` 0, `achieved >= arrivals - 1` is trivially
 * true, so minutes of black screen were reported as "check the source/link
 * (display is keeping up)" — while the source was demonstrably healthy and the
 * display was presenting nothing at all. Nothing presented is never evidence
 * that the display is keeping up, so that branch now requires `achievedFps > 0`
 * and the stall is attributed from `context.sourceSilent`, honestly labelled as
 * unconfirmed when the module has no signal to offer.
 */
export function describeRenderLag(
    payload: unknown,
    context: RenderLagContext = {},
): RenderLagReport {
    const p = (payload ?? {}) as RenderLagPayload;
    const rate =
        typeof p.achievedFps === 'number' && typeof p.expectedFps === 'number'
            ? ` (${p.achievedFps}/${p.expectedFps} fps)`
            : '';
    /** The sink presented nothing at all this window. */
    const nothingRendered = typeof p.achievedFps === 'number' && p.achievedFps <= 0;
    /** Nothing reached the sink pad either — or an older runner didn't say. */
    const nothingArrived = typeof p.arrivalsFps !== 'number' || p.arrivalsFps <= 0;

    if (nothingRendered && nothingArrived) {
        // Source confirmed silent: the bus watchdog saw no bytes at all. A
        // rebuild can't manufacture frames, so this stays a source shortfall
        // for the self-heal gate.
        if (context.sourceSilent === true) {
            return {
                kind: 'source-shortfall',
                sourceShortfall: true,
                message: `No video arriving${rate} — the source has stopped delivering`,
            };
        }
        return {
            kind: 'total-stall',
            // NOT a source shortfall: bytes are still flowing (or we can't
            // tell), so a rebuild is a legitimate self-heal for a wedged
            // decode/display chain.
            sourceShortfall: false,
            message:
                context.sourceSilent === false
                    ? `Video output stalled${rate} — the source is still delivering, the decode/display chain has stopped`
                    : `Video output stalled${rate} — nothing is being rendered; check the display/pipeline (upstream delivery unconfirmed)`,
        };
    }

    const sourceShortfall =
        !nothingRendered &&
        typeof p.achievedFps === 'number' &&
        typeof p.arrivalsFps === 'number' &&
        p.achievedFps >= p.arrivalsFps - 1;
    return {
        kind: sourceShortfall ? 'source-shortfall' : 'render-chain',
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
