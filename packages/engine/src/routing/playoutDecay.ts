import { DECAY_HOLD_MS, LEG_OFFSET_CLEAR_MS } from '../plugins/playoutReanchor.js';
import type { LegHistory, PlayoutLegOffset } from '../plugins/playoutReanchor.js';

// When a playout re-anchor comes back down (B-210): on each leg's content lateness, read off
// its bus-ingress taps and its aligners' pace, which D does not move (the runner's reading does).

/** A report older than this does not count: the leg stopped, or its source went dark. */
export const REPORT_STALE_MS = 10_000;

/** One module's lateness reports and, once it asked for budget, its requests' history. */
export interface LegEntry extends LegHistory {
    asked?: boolean;
    /** Its own re-anchor, when its route could not be raised that far. */
    own?: PlayoutLegOffset;
    /** Since when every report read inside the configured D (undefined: late, or unknown). */
    onTimeSince?: number;
    reportedAt?: number;
    /** Its last report (null: no reading). */
    lastLateMs?: number | null;
}

/** Take one report (null: no reading); true when the leg's own re-anchor is due to clear. */
export function noteLegLateness(
    leg: LegEntry,
    lateMs: number | null,
    baseMs: number,
    now: number,
): boolean {
    const fresh = leg.reportedAt !== undefined && now - leg.reportedAt <= REPORT_STALE_MS;
    leg.reportedAt = now;
    leg.lastLateMs = lateMs;
    if (lateMs === null || lateMs >= baseMs) leg.onTimeSince = undefined;
    // A gap in the reports restarts the hold: what it did meanwhile is unknown.
    else if (!fresh || leg.onTimeSince === undefined) leg.onTimeSince = now;
    return (
        leg.own !== undefined &&
        leg.onTimeSince !== undefined &&
        now - leg.onTimeSince >= LEG_OFFSET_CLEAR_MS
    );
}

/** Its content arrives later than `baseMs` by its last report, still fresh. */
export function lateContent(leg: LegEntry, baseMs: number, now: number): boolean {
    return (
        leg.reportedAt !== undefined &&
        now - leg.reportedAt <= REPORT_STALE_MS &&
        typeof leg.lastLateMs === 'number' &&
        leg.lastLateMs >= baseMs
    );
}

/** A head's raise is due to come down: every leg that asked reports on time, for the hold since
 *  its last raise too (a leg whose content was on time all along was raised for its sink). */
export function decayDue(legs: LegEntry[], raisedAt: number, now: number): boolean {
    return (
        legs.length > 0 &&
        legs.every(
            (l) =>
                l.reportedAt !== undefined &&
                now - l.reportedAt <= REPORT_STALE_MS &&
                l.onTimeSince !== undefined &&
                now - Math.max(l.onTimeSince, raisedAt) >= DECAY_HOLD_MS,
        )
    );
}
