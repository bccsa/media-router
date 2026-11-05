import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { DEFAULT_PLAYOUT_OFFSET_MS } from '../plugins/playoutOffset.js';
import {
    RouteReanchor,
    judgeCause,
    raiseCapMs,
    type PlayoutLegOffset,
    type PlayoutRaise,
    type PlayoutRebaseNote,
    type ReanchorRaiseRequest,
    type ReanchorRebaseReport,
} from '../plugins/playoutReanchor.js';
import { decayDue, lateContent, noteLegLateness, type LegEntry } from './playoutDecay.js';
import {
    clearLeg,
    decayHead,
    holdLeg,
    reanchorLeg,
    settle,
    type HeadEntry,
    type StepContext,
} from './playoutSteps.js';

const log = createLogger('MediaRouter');

/** A route head as `MediaRouter.getRoutePlayoutHead` resolves it. */
export interface PlayoutHead {
    headId: string;
    label: string;
    declaredMs?: number;
}

/** What the raise bookkeeping needs from the router. */
export interface PlayoutRaisesDeps {
    head(moduleId: string, sinkPortId?: string): PlayoutHead | undefined;
    displayName(id: string): string;
    module(id: string): ModuleInstance | undefined;
    /** Re-push D to every consumer of `headId` (the edit fan-out). */
    fanOut(headId: string): Promise<void>;
}

/** `held`: a raise cannot help that leg; `leg`: it re-anchored on its own, its route not raised. */
export type PlayoutRaiseOutcome = 'raised' | 'covered' | 'ceiling' | 'held' | 'leg' | 'off';

/** What a leg sees of its route's re-anchor, read again by a restarted module (B-210). */
export interface PlayoutLegView {
    headLabel: string;
    baseMs: number;
    raise: PlayoutRaise | null;
    /** It asked this head for budget; held: a raise could not help it. */
    asked: boolean;
    held: boolean;
    own: PlayoutLegOffset | null;
}

/**
 * Playout re-anchor bookkeeping (ADR-0005 amendment 2026-10-08). A late leg asks
 * for more budget instead of dropping; the raise is stored per route HEAD (never
 * in config) and pushed through the same fan-out as an edit, so every leg of the
 * route moves together. Past the headroom the engine stops raising and alarms;
 * it never sheds on its own. B-210's hold, leg offset and decay: `playoutSteps.ts`.
 */
export class PlayoutRaises {
    private readonly heads = new Map<string, HeadEntry>();
    /** Every module that reported or asked: its lateness reports and its requests' history. */
    private readonly legs = new Map<string, LegEntry>();
    private enabled = false;
    private defaultOffsetMs = DEFAULT_PLAYOUT_OFFSET_MS;
    /** What the B-210 steps (`playoutSteps.ts`) act through. */
    private readonly steps: StepContext;

    constructor(private readonly deps: PlayoutRaisesDeps) {
        this.steps = { deps, legs: this.legs, tell: (id, fn) => this.tell(id, fn) };
    }

    /** Engine wiring: `EngineConfig.playoutReanchor`, else on unless `MR_PLAYOUT_REANCHOR=0`. */
    configure(enabled: boolean, defaultOffsetMs = DEFAULT_PLAYOUT_OFFSET_MS): void {
        this.enabled = enabled;
        this.defaultOffsetMs = defaultOffsetMs;
    }

    /** A head's playout offset in ms: its declared D, else the engine default, plus its raise. */
    offsetMs(head: PlayoutHead): number {
        return this.baseMs(head) + (this.heads.get(head.headId)?.raise?.raiseMs ?? 0);
    }

    /** The runtime raise on the route head feeding `moduleId`, in ms (0 when none). */
    raiseMs(moduleId: string, sinkPortId?: string): number {
        if (this.heads.size === 0) return 0;
        const head = this.deps.head(moduleId, sinkPortId);
        return (head && this.heads.get(head.headId)?.raise?.raiseMs) || 0;
    }

    /** `moduleId`'s own re-anchor on top of its route's D, in ms (0 when none). */
    legOffsetMs(moduleId: string): number {
        return this.legs.get(moduleId)?.own?.offsetMs ?? 0;
    }

    /** The raise `headId` carries, for its own display (null when none). */
    headRaise(headId: string): PlayoutRaise | null {
        return this.heads.get(headId)?.raise ?? null;
    }

    /** A leg below `headId` re-anchored on its own, as the head shows it (null when none). */
    headNote(headId: string): PlayoutRebaseNote | null {
        for (const leg of this.legs.values()) if (leg.own?.headId === headId) return leg.own.note;
        return null;
    }

    /** What `moduleId` sees of its route's re-anchor; null when nothing stands for it. */
    legView(moduleId: string, sinkPortId?: string): PlayoutLegView | null {
        const head = this.deps.head(moduleId, sinkPortId);
        if (!head) return null;
        const raise = this.heads.get(head.headId)?.raise ?? null;
        const leg = this.legs.get(moduleId);
        const held = leg?.heldAtMs !== undefined;
        if (!raise && !leg?.own && !held) return null;
        return {
            headLabel: head.label,
            baseMs: this.baseMs(head),
            raise,
            asked: this.heads.get(head.headId)?.legs.has(moduleId) ?? false,
            held,
            own: leg?.own ?? null,
        };
    }

    /** See `MediaRouter.requestPlayoutRaise`. */
    async request(
        moduleId: string,
        sinkPortId: string | undefined,
        req: ReanchorRaiseRequest,
    ): Promise<PlayoutRaiseOutcome> {
        if (!this.enabled) return 'off';
        const head = this.deps.head(moduleId, sinkPortId);
        if (!head) return 'off';
        const baseMs = this.baseMs(head);
        const entry = this.heads.get(head.headId) ?? {
            reanchor: new RouteReanchor(),
            legs: new Set<string>(),
        };
        this.heads.set(head.headId, entry);
        entry.legs.add(moduleId);
        const leg = this.legs.get(moduleId) ?? {};
        this.legs.set(moduleId, leg);
        leg.asked = true;
        const current = entry.raise?.raiseMs ?? 0;
        const own = leg.own?.offsetMs ?? 0;
        // A queue the standing raise filled is not backlog (B-210).
        const judged = { ...req, cause: judgeCause(req, current + own) };
        const now = Date.now();
        const offer = entry.reanchor.offer(judged, baseMs, current, {
            ...leg,
            ownMs: own,
            lateContent: lateContent(leg, baseMs, now),
        });
        if (offer === 'covered') return 'covered';
        if (offer === 'held')
            return holdLeg(this.steps, head.headId, entry, moduleId, leg, judged, now);
        leg.heldAtMs = undefined;
        if (typeof offer === 'object' && 'legMs' in offer) {
            await reanchorLeg(this.steps, head, moduleId, leg, judged, offer.legMs, now);
            return 'leg';
        }
        const prev = entry.raise;
        const raiseMs = offer === 'ceiling' ? (prev?.raiseMs ?? 0) : offer.raiseToMs;
        entry.raise = {
            headId: head.headId,
            baseMs,
            raiseMs,
            since: prev?.since ?? now,
            lastRaiseAt: offer === 'ceiling' ? (prev?.lastRaiseAt ?? now) : now,
            requests: (prev?.requests ?? 0) + 1,
            lastBy: {
                moduleId,
                label: this.deps.displayName(moduleId),
                element: req.element,
                cause: judged.cause,
                excessMs: req.excessMs,
                queuedMs: req.queuedMs,
                holdMs: req.holdMs,
            },
            // A raise landing on the cap is the last one: warn on it, not on the retry.
            atCeiling: offer === 'ceiling' || raiseMs >= raiseCapMs(baseMs),
        };
        if (offer !== 'ceiling') {
            leg.landedForMs = req.excessMs;
            leg.landedAt = now;
        }
        log.warn(
            { headId: head.headId, moduleId, offer, request: judged },
            offer === 'ceiling'
                ? 'Playout re-anchor ceiling reached — no further raise, nothing shed'
                : 'Playout re-anchored: route offset raised',
        );
        if (offer !== 'ceiling') await this.deps.fanOut(head.headId);
        const raise = entry.raise;
        this.tell(head.headId, (m) => m.notifyRoutePlayoutRaised?.(raise));
        return offer === 'ceiling' ? 'ceiling' : 'raised';
    }

    /** A leg's content lateness on the house clock without D (null: unknown), each timing
     *  tick: its own re-anchor and its head's raise come back down on it (B-210). */
    noteLateness(
        moduleId: string,
        sinkPortId: string | undefined,
        lateMs: number | null,
        now = Date.now(),
    ): void {
        if (!this.enabled) return;
        const leg = this.legs.get(moduleId) ?? {};
        this.legs.set(moduleId, leg);
        if (!leg.asked) {
            // Never asked: its last reading only, what a first request is judged with.
            leg.lastLateMs = lateMs;
            leg.reportedAt = now;
            return;
        }
        const head = this.deps.head(moduleId, sinkPortId);
        if (!head) return;
        if (noteLegLateness(leg, lateMs, this.baseMs(head), now)) {
            settle(clearLeg(this.steps, head, moduleId, leg), moduleId);
        }
        const entry = this.heads.get(head.headId);
        if (!entry?.raise || !entry.legs.has(moduleId)) return;
        // A leg that left this route (rewired, deleted) no longer holds its raise up.
        const asking = [...entry.legs]
            .filter((id) => this.deps.head(id)?.headId === head.headId)
            .map((id) => this.legs.get(id) ?? {});
        if (decayDue(asking, entry.raise.lastRaiseAt, now)) {
            settle(decayHead(this.steps, head, entry), head.headId);
        }
    }

    /** The leg's sink plays on time again: a hold on it is over (B-210). */
    notePlayingOnTime(moduleId: string): void {
        const leg = this.legs.get(moduleId);
        if (leg) leg.heldAtMs = undefined;
    }

    /** See `MediaRouter.clearPlayoutRaise`. */
    clear(headId: string): void {
        const entry = this.heads.get(headId);
        if (!entry) return;
        this.heads.delete(headId);
        this.tell(headId, (m) => m.notifyRoutePlayoutRaised?.(null));
        // The operator took the route: its legs' own re-anchors go with its raise.
        for (const legId of entry.legs) {
            const leg = this.legs.get(legId);
            if (!leg) continue;
            leg.landedForMs = leg.landedAt = undefined;
            if (leg.own?.headId !== headId) continue;
            leg.own = undefined;
            this.tell(legId, (m) => m.notifyPlayoutLegOffset?.(null));
        }
        if (!entry.raise) return;
        const reset = { ...entry.raise, raiseMs: 0, atCeiling: false };
        for (const legId of entry.legs) {
            this.tell(legId, (m) => m.notifyRoutePlayoutRaised?.(reset));
        }
    }

    /** A leg rebased itself onto an implausible timeline — tell its route head. */
    noteRebase(
        moduleId: string,
        sinkPortId: string | undefined,
        report: ReanchorRebaseReport,
    ): void {
        const head = this.deps.head(moduleId, sinkPortId);
        if (!head) return;
        const note = {
            moduleId,
            label: this.deps.displayName(moduleId),
            element: report.element,
            latenessMs: report.latenessMs,
            at: Date.now(),
        };
        this.tell(head.headId, (m) => m.notifyRoutePlayoutRebased?.(note));
    }

    private baseMs(head: PlayoutHead): number {
        return head.declaredMs ?? this.defaultOffsetMs;
    }

    /** A module's re-anchor hook must never break the routing path that called it. */
    private tell(id: string, fn: (m: ModuleInstance) => void): void {
        const m = this.deps.module(id);
        if (!m) return;
        try {
            fn(m);
        } catch (err) {
            log.warn({ err, moduleId: id }, 'Playout re-anchor notification failed');
        }
    }
}
