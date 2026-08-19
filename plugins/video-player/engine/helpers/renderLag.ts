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

/**
 * How often a chain that is STILL degraded re-states itself in the journal.
 *
 * One a minute against runner lag events every 2 s: quiet enough that a
 * two-window blip is one line, loud enough that a dead chain cannot be mistaken
 * for a recovered one by anyone reading (or grepping) the journal.
 */
export const RENDER_LAG_REEMIT_MS = 60_000;

/**
 * How often the module CHECKS whether a lag episode has gone quiet, and the
 * minimum event silence that counts as "the runner stopped reporting".
 *
 * The runner's renderWatch reports per window (2 s), so 15 s is several missed
 * windows — not a scheduling hiccup. It also has to divide `RENDER_LAG_REEMIT_MS`
 * finely enough that a re-emit lands near its minute rather than a whole window
 * late: the timer can only fire on its own tick.
 */
export const RENDER_LAG_SILENT_TICK_MS = 15_000;

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
    /**
     * RETAINED pipeline latency in ms, measured by the runner's backlog shedder
     * on the shed point's pad. Present only on a leg the time-sync contract
     * paces (the shedder is what measures it); absent on legacy/unpaced legs and
     * on older runners, which is why every branch below has to work without it.
     */
    retainedMs?: number;
    /** The route's playout budget D in ms, as the sink's live `ts-offset`. */
    budgetMs?: number;
    /** Retained latency OVER budget (`retainedMs − budgetMs`). Positive = ratchet. */
    latenessMs?: number;
    /** The shedder is mid-episode — frames are being dropped deliberately. */
    shedding?: boolean;
    /** Sheds on this leg since the pipeline started. */
    shedCount?: number;
}

/** What the shortfall was attributed to — drives the message and the journal line. */
export type RenderLagKind =
    /** The sink presents fewer frames than reach it. */
    | 'render-chain'
    /** Fewer frames arrive in the first place — a feed/link problem. */
    | 'source-shortfall'
    /** NOTHING is presented and nothing reaches the sink. */
    | 'total-stall'
    /**
     * The leg is holding more latency than the route's playout budget: frames
     * are late, not missing. See `describeRenderLag` for why nothing else in
     * the payload can tell you this.
     */
    | 'presentation-backlog';

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
 *
 * THE RATCHET outranks both, and could not be told from either without
 * `retainedMs`. When the leg is running a second behind the house clock, the
 * `sync=true` sink's own back-pressure throttles ARRIVALS at its pad down to the
 * rate it presents, and the frames that never make it are QoS-dropped in
 * `videoconvert` — upstream of the sink, so the sink's `dropped` counter stays
 * 0. The payload is then `achieved ≈ arrivals ≈ 1 fps, dropped 0`, which every
 * rule below reads as "the source is under-delivering" while the source
 * delivers a clean 50 fps and the decoder decodes all of it. That verbatim line
 * is what .42 logged for hours (2026-08-14 07:19). Retained latency against the
 * route's budget is the only field that separates them, so it is checked first.
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

    // Retained latency past the budget, with frames still moving: the leg is
    // late, not starved. `latenessMs > 0` IS "retained beyond D" (the runner
    // computes it against the sink's live ts-offset), and only a shedder-armed
    // leg reports it at all — so this branch simply does not exist on legacy
    // legs and older runners, and the attribution below is unchanged for them.
    if (typeof p.latenessMs === 'number' && p.latenessMs > 0) {
        const retained = typeof p.retainedMs === 'number' ? Math.round(p.retainedMs) : undefined;
        const budget = typeof p.budgetMs === 'number' ? Math.round(p.budgetMs) : undefined;
        const held =
            retained !== undefined && budget !== undefined
                ? ` — holding ${retained} ms against a ${budget} ms playout budget`
                : ` — holding ${Math.round(p.latenessMs)} ms more latency than the playout budget`;
        return {
            kind: 'presentation-backlog',
            // A rebuild is a legitimate answer to a wedged chain, and shedding
            // is the cheaper one already under way — either way the SOURCE is
            // not at fault, so this must not read as a shortfall.
            sourceShortfall: false,
            message:
                `Video running behind the house clock${rate}${held}` +
                (p.shedding ? ' — shedding backlog now' : ''),
        };
    }
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

export interface RenderLagWarnInput {
    /** The module's lag latch: false means this event is the ok→degraded EDGE. */
    active: boolean;
    /** When this episode last warned, 0 = never. */
    lastWarnAt: number;
    /**
     * "Now" on the SAME clock as `lastWarnAt` — boot-relative (`bootNowMs`) for
     * the reason spelled out in `SelfHealInput.now`: an NTP step must not be
     * able to silence (or spam) the re-emit.
     */
    now: number;
}

/**
 * Should this lag event be written to the journal?
 *
 * THE LATCH ALONE MUTED A DEAD CHAIN. Warning only on the ok→degraded edge is
 * right for the transitions it was written for, but the clearing edge is a
 * `renderwatch:recovered` event — and a chain that never recovers never sends
 * one. Field (Pi 400, 2026-08-18): a post-shed decoder wedge produced ONE
 * "Render keep-up degraded" line and then nothing at all for 12 h at 0 achieved
 * fps, while the pipeline sat in PLAYING reporting itself degraded to nobody.
 * Health state said so; the journal, which is what fleet monitoring reads, did
 * not.
 *
 * So the edge still warns immediately (no transient is delayed) and a condition
 * that PERSISTS re-states itself every `RENDER_LAG_REEMIT_MS`. That is a
 * property of the episode's age, not of the payload, which is what makes it
 * cover the case that hid: `achievedFps: 0` with the chain still nominally
 * live, where every field in the payload stays constant for hours.
 */
export function shouldWarnRenderLag(input: RenderLagWarnInput): boolean {
    if (!input.active) return true;
    // Armed latch with no timestamp: an older state or a clock that never got
    // set. Warn rather than go quiet — silence is the failure being fixed here.
    if (input.lastWarnAt <= 0) return true;
    return input.now - input.lastWarnAt >= RENDER_LAG_REEMIT_MS;
}

export interface SilentChainInput {
    /** The module's lag latch. A tick outside an episode is never a warning. */
    active: boolean;
    /** When the last `renderwatch:lag` event arrived (0 = none this episode). */
    lastEventAt: number;
    /** When this episode last warned, by either path (0 = never). */
    lastWarnAt: number;
    /** "Now" on the SAME boot-relative clock as both — see `SelfHealInput.now`. */
    now: number;
}

/**
 * Should a TIMER tick re-state a degraded chain the runner has stopped
 * reporting on?
 *
 * `shouldWarnRenderLag` can only run when an event arrives, and that is exactly
 * what a hard render stall takes away: the runner's renderWatch reporter ticks
 * on RENDERS, so a sink that presents nothing sends nothing. Measured on target
 * (Pi 400, weston SIGSTOP for 150 s): one warning at onset, then total journal
 * silence until recovery — the same blind spot as before, one layer down. A
 * starved event stream at 0 fps is MORE alarming than a flowing one, so it has
 * to be the case that speaks loudest.
 *
 * Two gates. The event stream must actually be silent (`RENDER_LAG_SILENT_TICK_MS`
 * of it, i.e. several missed 2 s windows — not a late tick), and the episode
 * must be due a line at all: `lastWarnAt` is shared with the event-driven path,
 * so while events flow the timer can never double up on it.
 */
export function shouldWarnSilentChain(input: SilentChainInput): boolean {
    if (!input.active) return false;
    if (input.now - input.lastEventAt < RENDER_LAG_SILENT_TICK_MS) return false;
    if (input.lastWarnAt > 0 && input.now - input.lastWarnAt < RENDER_LAG_REEMIT_MS) return false;
    return true;
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
