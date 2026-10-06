import type { BacklogShedConfig } from './PluginModule.js';

/**
 * Backlog shedding — the time-sync contract's latency RATCHET guard (ADR-0005).
 *
 * THE RATCHET. Under the contract every presentation consumer runs `sync=true`,
 * so its sink drains at exactly media rate. Backlog is then ONE-WAY: whatever
 * the leg's leaky queues absorb during a downstream hiccup (decode stall,
 * compositor hitch, CMA allocation) is never handed back, because a media-rate
 * sink has no spare rate to hand it back with. The legacy `sync=false` sink
 * presented on arrival and therefore gulped any backlog at max speed — which is
 * exactly the assumption the video leg's queue sizing was written against and
 * the contract falsified. Retained latency ratchets up one hiccup at a time
 * until the sink's own lateness handling (QoS upstream, then `max-lateness`)
 * costs nearly every frame. Field, .42 over ~16 h: 50 fps decoded, 2.5 fps on
 * the glass; a live +1 s `ts-offset` restored it instantly and reverting put it
 * straight back.
 *
 * WHY THIS LIVES AT THE CONTRACT LAYER. It is not a video-player problem and
 * not a queue-sizing problem — it is a property of every `sync=true` bus
 * consumer the contract creates (video-player, audio-decoder, and any future
 * presentation leg). So the knobs, the defaults and the gate on
 * `services.timeSyncContract` are defined ONCE here, exactly as
 * `effectivePlayoutOffsetMs` defines D once for both legs of a route. A leg
 * supplies only the two element names that are genuinely its own: where to
 * measure/shed, and which sink carries the route's `ts-offset`.
 *
 * WHAT IT IS NOT. Not a queue resize — the ES/jitter queues stay exactly as
 * they are, because their depth is field-measured IDR-burst absorption and
 * shrinking them re-breaks the picture. Not a bigger `ts-offset` — that is
 * unbounded and would desync the other leg of the same route. It is an ACTIVE
 * one-shot: detect retained latency past D, drop the OLDEST queued data (up to
 * the next keyframe on a video leg) until the leg is back at D, log it, and
 * stay quiet for a cooldown.
 *
 * The runner half is `_start_backlog_shedder` in `gst-pipeline-runner.py`
 * (measurement and dropping) plus `backlog_shed.py` (the sustained-excess and
 * rate-limit policy). The values below are the single source of truth for the
 * numbers; the runner's own fallbacks only exist so an older config still runs.
 */

/**
 * Plugin-event channel a shed episode is reported on. Pinned here because both
 * ends of a process boundary use it: the runner emits it, `GstPluginBase` logs
 * every leg's episodes off it.
 */
export const BACKLOG_SHED_EVENT = 'backlog_shed';

/**
 * Retained latency over D, in ms, that a leg may hold before it is shed. Sized
 * against the video leg's own queues: the ES queue holds 1 s and the jitter
 * queue `bufferMs` (200 ms default), so 250 ms is clear of a single absorbed
 * IDR burst (~200 ms of stream time at 8 Mbps on a Pi 4) and far below
 * `waylandsink max-lateness=1000000000`, the cliff past which the sink drops
 * nearly every frame.
 */
export const BACKLOG_SHED_TOLERANCE_MS = 250;

/**
 * How long the excess must hold before it counts. Every sample in the window
 * must be above tolerance (a floor, not an average — a spike relaxes, retained
 * latency does not), so a burst being absorbed and handed back cannot trip it.
 */
export const BACKLOG_SHED_HOLD_MS = 5_000;

/**
 * Minimum gap between sheds, per leg. A shed returns ALL of the excess, so
 * frequency buys nothing, and on a video leg each one costs the frames up to
 * the next IRAP — which the operator sees. One a minute, worst case.
 */
export const BACKLOG_SHED_COOLDOWN_MS = 60_000;

/**
 * Lateness past which a reading is NOT treated as a backlog. A real retained
 * backlog is bounded by the leg's queues (1 s ES + up to 5 s jitter); tens of
 * seconds means the buffer timeline and the pipeline clock are not the same
 * timeline, and shedding on that would drop the whole stream chasing a target
 * it can never reach. Reported, never SHED on (a sink-point leg held past it
 * re-anchors instead — `BACKLOG_SHED_REANCHOR_HOLD_MS`). Deliberately the same
 * 10 s as `MAX_PLAYOUT_OFFSET_MS` — no legitimate playout budget is larger.
 */
export const BACKLOG_SHED_SANITY_MS = 10_000;

/**
 * How long a SINK-POINT leg (`element === sink`: the audio presentation legs)
 * must read past `BACKLOG_SHED_SANITY_MS`, steadily, before the runner
 * re-anchors it IN PLACE: one pad offset on the sink's upstream peer puts the
 * run's least-late buffer on arrival, as a fresh start would. There the reading
 * is not a measurement to distrust but a leg that lost its own timeline and
 * plays NOTHING (field, .24 2026-10-04: after its source rebooted onto an
 * earlier PTS epoch the audio-decoder sat 588 s late, silent, health "ok", for
 * good). 3 s is three times the producer stamper's staleness hold (1 s), so a
 * producer that re-anchors its own egress lands first — the 302M leg of that
 * outage came back 1.06 s in through its transcoder and must not be touched —
 * and a single stale buffer (every AAC decoder flushes one after an outage)
 * never qualifies. Steadily: readings that keep moving, or an input gap,
 * restart the hold (a pad offset can only correct a constant), and the first
 * buffer the leg's own stamps put on time again moves it back at once
 * (`REANCHOR_STEADY_MS` and `"restore"` in the runner's `backlog_shed.py`).
 * Sent on every leg; the runner arms it only where the shed point is the sink,
 * and an older runner ignores it.
 */
export const BACKLOG_SHED_REANCHOR_HOLD_MS = 3_000;

/** A `backlog_shed` payload with outcome `reanchored` (both runners). */
export interface BacklogShedReanchor {
    /** The leg's playout budget: its sink's ts-offset plus latency. */
    budgetMs?: number;
    /**
     * The leg's NET move once this one is applied: + its own timeline is that
     * far late (moved later, to play on arrival), − that far early, 0 back on
     * its own stamps.
     */
    offsetMs?: number;
    /** False when the sink had no upstream peer to move — the leg is still lost. */
    applied?: boolean;
}

/**
 * The owned health warning of a leg the runner has moved off its own timeline
 * (`GstPluginBase`): audible again, but placed by arrival rather than by the
 * producer's stamps, so lip sync is no longer the contract's. The NET move
 * decides, not the last step: null once the leg sits within one budget of its
 * own stamps (field, .24 2026-10-05: three moves netting +52.8 ms left
 * "Timeline lost (200 s early)" on a module that was back on time).
 */
export function reanchorWarning(p: BacklogShedReanchor): string | null {
    const off = p.offsetMs ?? 0;
    if (Math.abs(off) <= (p.budgetMs ?? 0)) return null;
    const s = Math.abs(off) / 1000;
    const lost = `Timeline lost (${s < 10 ? s.toFixed(1) : Math.round(s)} s ${off < 0 ? 'early' : 'late'})`;
    return p.applied === false
        ? `${lost} — re-anchor failed, no audio`
        : `${lost} — re-anchored on arrival; lip sync is approximate`;
}

/** The slice of `ModuleServices` the gate reads. */
export interface BacklogShedServices {
    timeSyncContract?: boolean;
}

export interface BacklogShedOptions {
    /**
     * `name=` of the element whose SINK pad is measured and shed at.
     *
     * Video: the DECODER. The backlog sits upstream of it (the ES and jitter
     * queues are what absorbed the stall), compressed AUs drop at I/O speed
     * where decoded frames would drain no faster than the decoder runs, and
     * `h26xparse` has already marked every access unit `DELTA_UNIT` or not —
     * which is what makes keyframe alignment possible at all.
     *
     * Audio: the SINK itself. Raw PCM references nothing, so the drop is safe
     * anywhere, and the sink's own pad is the last point that still sees every
     * buffer.
     */
    element: string;
    /**
     * `name=` of the presentation sink. Read (live) for its `ts-offset`, which
     * IS the route's playout offset D — so the measurement is against the
     * route's real budget including any operator trim, and a live D change is
     * picked up without rebuilding anything.
     */
    sink: string;
    /**
     * End the shed only on a keyframe. MANDATORY on a video leg feeding a
     * decoder: handing a stateless V4L2 decoder a delta unit whose references
     * were dropped is the documented hardware wedge (the same hazard the
     * keyframe gate exists for). False on an audio leg, where the shed ends on
     * the first buffer inside budget.
     */
    keyframeAligned: boolean;
}

/**
 * The `backlogShed` runner config for a clock-paced consumer leg, or
 * `undefined` when the contract is off.
 *
 * `undefined` is the whole legacy story: with `MR_TIME_SYNC_CONTRACT=0` no
 * module sends this config, the runner arms nothing, and the leg behaves
 * exactly as it did — which it must, because a `sync=false` sink drains its own
 * backlog and has no ratchet to guard against.
 */
export function backlogShedConfig(
    services: BacklogShedServices | null | undefined,
    opts: BacklogShedOptions,
): BacklogShedConfig | undefined {
    if (services?.timeSyncContract !== true) return undefined;
    return {
        element: opts.element,
        sink: opts.sink,
        keyframeAligned: opts.keyframeAligned,
        toleranceMs: BACKLOG_SHED_TOLERANCE_MS,
        holdMs: BACKLOG_SHED_HOLD_MS,
        cooldownMs: BACKLOG_SHED_COOLDOWN_MS,
        sanityMs: BACKLOG_SHED_SANITY_MS,
        reanchorHoldMs: BACKLOG_SHED_REANCHOR_HOLD_MS,
    };
}
