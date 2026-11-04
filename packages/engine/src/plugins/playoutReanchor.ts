import { MAX_PLAYOUT_OFFSET_MS } from './playoutOffset.js';

/**
 * Playout re-anchor — ADR-0005 amendment 2026-10-08: never drop on lateness.
 *
 * A presentation leg whose lateness FLOOR sits past its budget for a hold asks
 * the engine to raise its ROUTE's playout offset D (runner → `playout_reanchor`
 * `{kind:"raise"}`). The engine raises it for every leg of the route at once
 * through the existing fan-out, so lipsync holds by construction (decision 4).
 * The raise is a runtime overlay on the head's configured D, in memory only:
 * an operator edit of the head's `playoutOffsetMs` clears it and an engine
 * restart forgets it. Past `REANCHOR_HEADROOM_MS` the engine stops raising and
 * alarms — nothing is ever shed automatically. An implausible timeline
 * (|lateness| > 10 s) is never a budget problem: the runner re-anchors THAT leg
 * itself (`{kind:"rebase"}`) and both ends warn.
 *
 * B-210: a raise that did not help (the leg's next excess the same) is `held`; a
 * late timeline past what the route can still be raised re-anchors that leg alone
 * by its own offset; both come back down once the legs arrive on time again.
 *
 * The numbers live here once; `backlogShedConfig` carries them to the runners.
 * The operator-facing text is `playoutReanchorText.ts`.
 */

/** Plugin-event channel of raise requests and rebase reports (runner → module). */
export const PLAYOUT_REANCHOR_EVENT = 'playout_reanchor';
/** Floor excess over the budget that counts as late: the probe's resolution (40 ms `alignment-threshold`). */
export const REANCHOR_TOLERANCE_MS = 40;
/** Longer than the producer stamper's 10 s late hold, so a producer that can fix its anchor does so first. */
export const REANCHOR_HOLD_MS = 15_000;
/** After a request a leg asks again only once its live ts-offset moved, or after this. */
export const REANCHOR_RETRY_MS = 30_000;
/** Raises land on this grid. */
export const REANCHOR_STEP_MS = 20;
/** Added to the measured excess so the raised budget clears the floor rather than meets it. */
export const REANCHOR_MARGIN_MS = 40;
/** Most a route is auto-raised; past it the engine alarms instead (it never sheds). */
export const REANCHOR_HEADROOM_MS = 2_000;
/** A request this soon after a raise on the same head was measured against the old budget. */
export const REANCHOR_SETTLE_MS = 2_000;
/** A past-stamped implausible reading must hold this long before the leg rebases. */
export const REBASE_HOLD_MS = 3_000;
/** At most one rebase per leg per this long. */
export const REBASE_COOLDOWN_MS = 60_000;
/** A raise comes back down once every leg that asked has arrived inside the configured D this long. */
export const DECAY_HOLD_MS = 60_000;
/** A leg's own re-anchor clears once it arrives inside its D this long (the aligner's clear, B-205). */
export const LEG_OFFSET_CLEAR_MS = 3_000;

/** Status section and badge ids, on the head and on the leg alike. */
export const PLAYOUT_SECTION = 'playout';
export const PLAYOUT_BADGE = 'reanchor';

export type ReanchorCause = 'backlog' | 'timeline';

/** A leg asking for more budget (runner payload, validated). */
export interface ReanchorRaiseRequest {
    kind: 'raise';
    element: string;
    /** Minimum lateness over the hold — the level the raise has to cover. */
    excessMs: number;
    worstMs: number;
    cause: ReanchorCause;
    queuedMs: number;
    budgetMs: number;
    tsOffsetMs: number;
    latencyMs: number;
    holdMs: number;
}

/** A leg that re-anchored itself onto arrival + D (runner payload, validated). */
export interface ReanchorRebaseReport {
    kind: 'rebase';
    element: string;
    latenessMs: number;
    appliedOffsetNs: number;
    padOffsetNs: number;
    flushed: boolean;
    sanityMs: number;
    budgetMs: number;
    count: number;
}

export type ReanchorEvent = ReanchorRaiseRequest | ReanchorRebaseReport;

/** The engine's raise on one route head (`MediaRouter`, memory only). */
export interface PlayoutRaise {
    headId: string;
    /** The head's configured D, or the engine default, the raise sits on. */
    baseMs: number;
    raiseMs: number;
    /** Epoch ms of the first raise and of the latest. */
    since: number;
    lastRaiseAt: number;
    requests: number;
    lastBy: {
        moduleId: string;
        label: string;
        element: string;
        cause: ReanchorCause;
        excessMs: number;
        queuedMs: number;
        holdMs: number;
    };
    atCeiling: boolean;
    /** A leg whose excess this raise did not change: no further raise for it (B-210). */
    held?: { moduleId: string; label: string; excessMs: number; since: number };
}

/** A leg late past what its route can be raised, re-anchored on its own (B-210). */
export interface PlayoutLegOffset {
    headId: string;
    /** Added to this leg's ts-offset on top of its route's D. */
    offsetMs: number;
    since: number;
    excessMs: number;
    /** What its head was told, and shows again after a restart. */
    note: PlayoutRebaseNote;
}

/** A leg below this head rebased itself (passed to the head, not stored). */
export interface PlayoutRebaseNote {
    moduleId: string;
    label: string;
    element: string;
    latenessMs: number;
    at: number;
}

const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Validate a `playout_reanchor` payload; null for anything malformed. */
export function readReanchorRequest(payload: unknown): ReanchorEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const element = typeof p.element === 'string' ? p.element : '';
    if (p.kind === 'raise') {
        const excessMs = num(p.excessMs);
        if (excessMs === undefined || excessMs <= 0) return null;
        return {
            kind: 'raise',
            element,
            excessMs,
            worstMs: num(p.worstMs) ?? excessMs,
            cause: p.cause === 'backlog' ? 'backlog' : 'timeline',
            queuedMs: num(p.queuedMs) ?? 0,
            budgetMs: num(p.budgetMs) ?? 0,
            tsOffsetMs: num(p.tsOffsetMs) ?? 0,
            latencyMs: num(p.latencyMs) ?? 0,
            holdMs: num(p.holdMs) ?? REANCHOR_HOLD_MS,
        };
    }
    if (p.kind === 'rebase') {
        const latenessMs = num(p.latenessMs);
        if (latenessMs === undefined) return null;
        return {
            kind: 'rebase',
            element,
            latenessMs,
            appliedOffsetNs: num(p.appliedOffsetNs) ?? 0,
            padOffsetNs: num(p.padOffsetNs) ?? 0,
            flushed: p.flushed === true,
            sanityMs: num(p.sanityMs) ?? MAX_PLAYOUT_OFFSET_MS,
            budgetMs: num(p.budgetMs) ?? 0,
            count: num(p.count) ?? 1,
        };
    }
    return null;
}

/** `legMs`: the leg's own re-anchor, its route not raised; `held`: a raise cannot help it. */
export type RaiseOffer = { raiseToMs: number } | { legMs: number } | 'covered' | 'ceiling' | 'held';

/** The most a route on `baseMs` may be raised: the headroom, within the offset ceiling. */
export function raiseCapMs(baseMs: number): number {
    return Math.max(0, Math.min(REANCHOR_HEADROOM_MS, MAX_PLAYOUT_OFFSET_MS - baseMs));
}

/** A cause of `backlog` only for a queue the standing raise did not fill (B-210). */
export function judgeCause(
    req: Pick<ReanchorRaiseRequest, 'cause' | 'queuedMs'>,
    standingMs: number,
): ReanchorCause {
    return req.cause === 'backlog' && req.queuedMs - standingMs < REANCHOR_TOLERANCE_MS
        ? 'timeline'
        : req.cause;
}

/** What one leg's earlier requests left on its head (`PlayoutRaises`). */
export interface LegHistory {
    /** The excess of this leg's request that last raised the route, and when it landed. */
    landedForMs?: number;
    landedAt?: number;
    /** The excess a landed raise did not change: requests within the tolerance are held. */
    heldAtMs?: number;
    /** Its own re-anchor, ms (0 when none). */
    ownMs?: number;
    /** Its content itself arrives later than the configured D (its last lateness report). */
    lateContent?: boolean;
}

/**
 * What one raise request is worth on one route head. Pure (the clock is
 * injected); coalescing is the settle window, not per-leg bookkeeping — a leg
 * that needed more than a fresh raise gave asks again after its own hold.
 */
export class RouteReanchor {
    private lastRaiseAt: number | undefined;

    constructor(private readonly now: () => number = () => Date.now()) {}

    offer(
        req: Pick<ReanchorRaiseRequest, 'excessMs'> & { cause?: ReanchorCause },
        baseMs: number,
        currentRaiseMs: number,
        leg: LegHistory = {},
    ): RaiseOffer {
        const t = this.now();
        const settling =
            this.lastRaiseAt !== undefined && t - this.lastRaiseAt < REANCHOR_SETTLE_MS;
        // The leg's next request after its raise landed measured that raise; held once, it stays so.
        const measured =
            leg.landedAt !== undefined && t - leg.landedAt <= REANCHOR_HOLD_MS + REANCHOR_SETTLE_MS;
        const ref = leg.heldAtMs ?? (measured ? leg.landedForMs : undefined);
        if (
            !settling &&
            ref !== undefined &&
            Math.abs(req.excessMs - ref) <= REANCHOR_TOLERANCE_MS
        ) {
            return 'held';
        }
        const cap = raiseCapMs(baseMs);
        const needed =
            Math.ceil((Math.max(0, req.excessMs) + REANCHOR_MARGIN_MS) / REANCHOR_STEP_MS) *
            REANCHOR_STEP_MS;
        const own = leg.ownMs ?? 0;
        // A late timeline the route cannot reach (its content itself late): never the route to
        // its cap, the leg on its own. Content on time is a lateness at the sink: raised, then held.
        const beyond = own > 0 || currentRaiseMs + needed > cap;
        if (req.cause === 'timeline' && leg.lateContent === true && beyond) {
            if (settling) return 'covered';
            const room = Math.max(0, MAX_PLAYOUT_OFFSET_MS - baseMs - currentRaiseMs);
            return own >= room ? 'ceiling' : { legMs: Math.min(room, own + needed) };
        }
        if (currentRaiseMs >= cap) return 'ceiling';
        if (settling) return 'covered';
        this.lastRaiseAt = t;
        return { raiseToMs: Math.min(cap, currentRaiseMs + needed) };
    }
}
