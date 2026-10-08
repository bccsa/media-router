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

export type RaiseOffer = { raiseToMs: number } | 'covered' | 'ceiling';

/** The most a route on `baseMs` may be raised: the headroom, within the offset ceiling. */
export function raiseCapMs(baseMs: number): number {
    return Math.max(0, Math.min(REANCHOR_HEADROOM_MS, MAX_PLAYOUT_OFFSET_MS - baseMs));
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
        req: Pick<ReanchorRaiseRequest, 'excessMs'>,
        baseMs: number,
        currentRaiseMs: number,
    ): RaiseOffer {
        const cap = raiseCapMs(baseMs);
        if (currentRaiseMs >= cap) return 'ceiling';
        const t = this.now();
        if (this.lastRaiseAt !== undefined && t - this.lastRaiseAt < REANCHOR_SETTLE_MS) {
            return 'covered';
        }
        const needed = Math.max(0, req.excessMs) + REANCHOR_MARGIN_MS;
        this.lastRaiseAt = t;
        return {
            raiseToMs: Math.min(
                cap,
                currentRaiseMs + Math.ceil(needed / REANCHOR_STEP_MS) * REANCHOR_STEP_MS,
            ),
        };
    }
}
