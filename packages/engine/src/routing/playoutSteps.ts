import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type {
    PlayoutRaise,
    ReanchorRaiseRequest,
    RouteReanchor,
} from '../plugins/playoutReanchor.js';
import { decayText, legClearText } from '../plugins/playoutReanchorText.js';
import type { LegEntry } from './playoutDecay.js';
import type { PlayoutHead, PlayoutRaisesDeps } from './PlayoutRaises.js';

const log = createLogger('MediaRouter');

/** One route head's re-anchor state (`PlayoutRaises`). */
export interface HeadEntry {
    raise?: PlayoutRaise;
    reanchor: RouteReanchor;
    /** The legs that asked this head. */
    legs: Set<string>;
}

/** What the B-210 steps act through: the router, every module's leg entry, its notifier. */
export interface StepContext {
    deps: PlayoutRaisesDeps;
    legs: Map<string, LegEntry>;
    tell(id: string, fn: (m: ModuleInstance) => void): void;
}

/** A raise the leg's excess did not move: D kept, said once an episode. */
export function holdLeg(
    ctx: StepContext,
    headId: string,
    entry: HeadEntry,
    moduleId: string,
    leg: LegEntry,
    req: ReanchorRaiseRequest,
    now: number,
): 'held' {
    const first = leg.heldAtMs === undefined;
    leg.heldAtMs ??= leg.landedForMs ?? req.excessMs;
    if (first) {
        log.warn(
            { headId, moduleId, request: req, raisedMs: entry.raise?.raiseMs ?? 0 },
            'Playout re-anchor held: the raise did not change how late this output plays — no further raise, nothing shed',
        );
    }
    const raise = entry.raise;
    if (!raise) return 'held';
    const label = ctx.deps.displayName(moduleId);
    const held = {
        ...raise,
        requests: raise.requests + 1,
        held: raise.held ?? { moduleId, label, excessMs: req.excessMs, since: now },
    };
    entry.raise = held;
    ctx.tell(headId, (m) => m.notifyRoutePlayoutRaised?.(held));
    return 'held';
}

/** Past the route's reach: this leg alone, by its own offset; its head is told. */
export async function reanchorLeg(
    ctx: StepContext,
    head: PlayoutHead,
    moduleId: string,
    leg: LegEntry,
    req: ReanchorRaiseRequest,
    offsetMs: number,
    now: number,
): Promise<void> {
    const since = leg.own?.since ?? now;
    const note = {
        moduleId,
        label: ctx.deps.displayName(moduleId),
        element: req.element,
        latenessMs: req.excessMs + req.budgetMs,
        at: now,
    };
    leg.own = { headId: head.headId, offsetMs, since, excessMs: req.excessMs, note };
    leg.landedForMs = req.excessMs;
    leg.landedAt = now;
    leg.onTimeSince = undefined;
    log.warn(
        { headId: head.headId, moduleId, request: req, legOffsetMs: offsetMs },
        'Playout re-anchor: late past what the route can be raised — this output re-anchored on its own, the route not raised',
    );
    await ctx.deps.module(moduleId)?.notifyRoutePlayoutOffsetChanged();
    ctx.tell(head.headId, (m) => m.notifyRoutePlayoutRebased?.(note));
}

/** The leg arrives inside its D again: its own re-anchor goes in one step. */
export async function clearLeg(
    ctx: StepContext,
    head: PlayoutHead,
    moduleId: string,
    leg: LegEntry,
): Promise<void> {
    const own = leg.own;
    if (!own) return;
    leg.own = undefined;
    leg.landedForMs = leg.landedAt = undefined;
    log.info(
        { headId: head.headId, moduleId, stepMs: own.offsetMs },
        legClearText(ctx.deps.displayName(moduleId), head.label, own.offsetMs),
    );
    await ctx.deps.module(moduleId)?.notifyRoutePlayoutOffsetChanged();
    ctx.tell(moduleId, (m) => m.notifyPlayoutLegOffset?.(null));
    const others = [...ctx.legs.values()].some((l) => l.own?.headId === own.headId);
    if (!others) ctx.tell(own.headId, (m) => m.notifyRoutePlayoutRebased?.(null));
}

/** Every leg that asked arrives inside the configured D: the raise goes in one step. */
export async function decayHead(
    ctx: StepContext,
    head: PlayoutHead,
    entry: HeadEntry,
): Promise<void> {
    const raise = entry.raise;
    if (!raise) return;
    entry.raise = undefined;
    for (const id of entry.legs) {
        const leg = ctx.legs.get(id);
        if (leg) leg.landedForMs = leg.landedAt = undefined;
    }
    log.info(
        { headId: head.headId, stepMs: raise.raiseMs, baseMs: raise.baseMs },
        decayText(head.label, raise.baseMs, raise.raiseMs),
    );
    await ctx.deps.fanOut(head.headId);
    ctx.tell(head.headId, (m) => m.notifyRoutePlayoutRaised?.(null));
    const reset = { ...raise, raiseMs: 0, atCeiling: false };
    for (const legId of entry.legs) ctx.tell(legId, (m) => m.notifyRoutePlayoutRaised?.(reset));
}

/** A step down runs from a timing tick: its failure is logged, never thrown into it. */
export function settle(step: Promise<void>, id: string): void {
    step.catch((err: unknown) =>
        log.warn({ err, moduleId: id }, 'Playout re-anchor step down failed'),
    );
}
