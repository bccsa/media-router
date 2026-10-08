import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { DEFAULT_PLAYOUT_OFFSET_MS } from '../plugins/playoutOffset.js';
import {
    RouteReanchor,
    raiseCapMs,
    type PlayoutRaise,
    type ReanchorRaiseRequest,
    type ReanchorRebaseReport,
} from '../plugins/playoutReanchor.js';

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

/**
 * Playout re-anchor bookkeeping (ADR-0005 amendment 2026-10-08). A late leg asks
 * for more budget instead of dropping; the raise is stored per route HEAD (never
 * in config) and pushed through the same fan-out as an edit, so every leg of the
 * route moves together. Past the headroom the engine stops raising and alarms;
 * it never sheds on its own.
 */
export class PlayoutRaises {
    private readonly heads = new Map<
        string,
        { raise?: PlayoutRaise; reanchor: RouteReanchor; legs: Set<string> }
    >();
    private enabled = false;
    private defaultOffsetMs = DEFAULT_PLAYOUT_OFFSET_MS;

    constructor(private readonly deps: PlayoutRaisesDeps) {}

    /** Engine wiring: on only with the contract on and `MR_PLAYOUT_REANCHOR` not 0. */
    configure(enabled: boolean, defaultOffsetMs = DEFAULT_PLAYOUT_OFFSET_MS): void {
        this.enabled = enabled;
        this.defaultOffsetMs = defaultOffsetMs;
    }

    /** The runtime raise on the route head feeding `moduleId`, in ms (0 when none). */
    raiseMs(moduleId: string, sinkPortId?: string): number {
        if (this.heads.size === 0) return 0;
        const head = this.deps.head(moduleId, sinkPortId);
        return (head && this.heads.get(head.headId)?.raise?.raiseMs) || 0;
    }

    /** See `MediaRouter.requestPlayoutRaise`. */
    async request(
        moduleId: string,
        sinkPortId: string | undefined,
        req: ReanchorRaiseRequest,
    ): Promise<'raised' | 'covered' | 'ceiling' | 'off'> {
        if (!this.enabled) return 'off';
        const head = this.deps.head(moduleId, sinkPortId);
        if (!head) return 'off';
        const baseMs = head.declaredMs ?? this.defaultOffsetMs;
        const entry = this.heads.get(head.headId) ?? {
            reanchor: new RouteReanchor(),
            legs: new Set<string>(),
        };
        this.heads.set(head.headId, entry);
        entry.legs.add(moduleId);
        const offer = entry.reanchor.offer(req, baseMs, entry.raise?.raiseMs ?? 0);
        if (offer === 'covered') return 'covered';
        const now = Date.now();
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
                cause: req.cause,
                excessMs: req.excessMs,
                queuedMs: req.queuedMs,
                holdMs: req.holdMs,
            },
            // A raise landing on the cap is the last one: warn on it, not on the retry.
            atCeiling: offer === 'ceiling' || raiseMs >= raiseCapMs(baseMs),
        };
        log.warn(
            { headId: head.headId, moduleId, offer, request: req },
            offer === 'ceiling'
                ? 'Playout re-anchor ceiling reached — no further raise, nothing shed'
                : 'Playout re-anchored: route offset raised',
        );
        if (offer !== 'ceiling') await this.deps.fanOut(head.headId);
        const raise = entry.raise;
        this.tell(head.headId, (m) => m.notifyRoutePlayoutRaised?.(raise));
        return offer === 'ceiling' ? 'ceiling' : 'raised';
    }

    /** See `MediaRouter.clearPlayoutRaise`. */
    clear(headId: string): void {
        const entry = this.heads.get(headId);
        if (!entry) return;
        this.heads.delete(headId);
        this.tell(headId, (m) => m.notifyRoutePlayoutRaised?.(null));
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
