import {
    DECAY_HOLD_MS,
    PLAYOUT_SECTION,
    type PlayoutRaise,
    type PlayoutRebaseNote,
    type ReanchorCause,
    type ReanchorEvent,
    type ReanchorRaiseRequest,
    type ReanchorRebaseReport,
} from './playoutReanchor.js';

/** Playout re-anchor's operator-facing text: warnings, status sections, badge (ADR-0005 2026-10-08). */

const ms = (v: number): string => `${Math.round(v)}`;
const secs = (v: number): string => `${Math.round(v / 1000)} s`;
const offBy = (latenessMs: number): string => (Math.abs(latenessMs) / 1000).toFixed(1);

/** The route head's warning while a raise is active (below the ceiling). */
export function raiseWarningHead(r: PlayoutRaise): string {
    const to = r.baseMs + r.raiseMs;
    const by = r.lastBy;
    const why =
        by.cause === 'backlog'
            ? `and held ${ms(by.queuedMs)} ms of backlog after a stall`
            : 'with nothing queued (hop transit or late timeline)';
    return (
        `Playout re-anchored: offset raised ${ms(r.baseMs)} → ${ms(to)} ms because ` +
        `${by.label} (${by.element}) arrived ${ms(by.excessMs)} ms late for ${secs(by.holdMs)} ` +
        `${why}. Nothing was dropped. To keep it, set Playout Offset to ${ms(to)} ms; ` +
        'any edit of Playout Offset resets the raise.'
    );
}

/** The requesting leg's warning after its raise request. */
export function raiseWarningLeg(
    req: Pick<ReanchorRaiseRequest, 'excessMs' | 'holdMs'>,
    headLabel: string,
    fromMs: number,
    toMs: number,
): string {
    return (
        `Arrived ${ms(req.excessMs)} ms past the playout budget for ${secs(req.holdMs)} — ` +
        `asked route head ${headLabel} to raise the playout offset ${ms(fromMs)} → ${ms(toMs)} ms; ` +
        'nothing dropped.'
    );
}

/** The leg whose excess a landed raise did not change (B-210): it plays that late anyway. */
export function heldWarningLeg(excessMs: number, headLabel: string, toMs: number): string {
    return (
        `Plays ${ms(excessMs)} ms late at its device: a larger playout offset cannot help, ` +
        `so route head ${headLabel} is held at ${ms(toMs)} ms; nothing dropped.`
    );
}

/** A late timeline past what the route can still be raised: this leg alone (B-210). */
export function legReanchorWarning(
    req: Pick<ReanchorRaiseRequest, 'excessMs' | 'holdMs'>,
    legMs: number,
    headLabel: string,
): string {
    return (
        `Arrived ${ms(req.excessMs)} ms past the playout budget for ${secs(req.holdMs)}, more than ` +
        `route head ${headLabel} can be raised: re-anchored this output on its own by ` +
        `+${ms(legMs)} ms. Lipsync with other outputs of ${headLabel} is NOT guaranteed until its ` +
        'source is back on time; nothing dropped.'
    );
}

/** The INFO line of a raise coming back down (B-210): the head, the step, what is skipped. */
export function decayText(headLabel: string, baseMs: number, stepMs: number): string {
    return (
        `Playout re-anchor: ${headLabel} back to its configured ${ms(baseMs)} ms, down ` +
        `${ms(stepMs)} ms in one step: the outputs that asked arrived on time for ` +
        `${secs(DECAY_HOLD_MS)}; about ${ms(stepMs)} ms of held content skipped at each, its time passed`
    );
}

/** The INFO line of a leg's own re-anchor clearing (B-210). */
export function legClearText(legLabel: string, headLabel: string, stepMs: number): string {
    return (
        `Playout re-anchor: ${legLabel} back on route head ${headLabel}'s playout offset, down ` +
        `${ms(stepMs)} ms in one step: its source arrives on time again; about ${ms(stepMs)} ms ` +
        'of held content skipped, its time passed'
    );
}

/** Head and leg alike, once the route can be raised no further. */
export function ceilingWarning(raiseMs: number, baseMs: number): string {
    return (
        `Playout re-anchor ceiling reached (+${ms(raiseMs)} ms over a ${ms(baseMs)} ms budget) — ` +
        'no further re-anchor; nothing dropped — restart this output to reclaim its queues ' +
        'or raise Playout Offset manually.'
    );
}

/** The leg that re-anchored itself onto an implausible timeline. */
export function rebaseWarningLeg(
    report: Pick<ReanchorRebaseReport, 'latenessMs'>,
    headLabel: string,
): string {
    const side = report.latenessMs > 0 ? 'behind' : 'ahead of';
    return (
        `Timeline ${offBy(report.latenessMs)} s ${side} the house clock — re-anchored this ` +
        `output onto arrival + playout offset. Lipsync with other outputs of ${headLabel} is ` +
        'NOT guaranteed until its timeline is fixed.'
    );
}

/** The head whose leg had to rebase: a producer timeline fault. */
export function rebaseWarningHead(note: PlayoutRebaseNote): string {
    return (
        `${note.label} found this producer's stamps ${offBy(note.latenessMs)} s off the house ` +
        'clock and re-anchored itself — producer timeline fault (stamper / PCR PID / ' +
        'identity unwrap).'
    );
}

/** Dynamic status section shape (`GstPluginBase.upsertStatusSection`). */
export interface PlayoutSection {
    id: string;
    label: string;
    fields: Array<{ key: string; label: string; unit?: string }>;
}

export const HEAD_PLAYOUT_SECTION: PlayoutSection = {
    id: PLAYOUT_SECTION,
    label: 'Playout re-anchor',
    fields: [
        { key: 'configured', label: 'Configured', unit: 'ms' },
        { key: 'raisedTo', label: 'Auto-raised to', unit: 'ms' },
        { key: 'raisedBy', label: 'Raised by' },
        { key: 'reason', label: 'Reason' },
        { key: 'since', label: 'Since' },
        { key: 'requests', label: 'Requests' },
    ],
};

export const LEG_PLAYOUT_SECTION: PlayoutSection = {
    id: PLAYOUT_SECTION,
    label: 'Playout re-anchor',
    fields: [
        { key: 'budget', label: 'Budget', unit: 'ms' },
        { key: 'lateBy', label: 'Arrived late by', unit: 'ms' },
        { key: 'cause', label: 'Cause' },
        { key: 'head', label: 'Route head' },
        { key: 'configured', label: 'Configured', unit: 'ms' },
        { key: 'raisedTo', label: 'Raised to', unit: 'ms' },
        { key: 'since', label: 'Since' },
    ],
};

const causeText = (cause: ReanchorCause, queuedMs: number): string =>
    cause === 'backlog' ? `backlog (${ms(queuedMs)} ms queued)` : 'hop transit or late timeline';

const isoSecond = (epochMs: number): string =>
    new Date(epochMs).toISOString().replace(/\.\d+Z$/, 'Z');

/** The head's section values; a rebase note, if any, is the reason shown. */
export function headPlayoutStatus(
    raise: PlayoutRaise | null,
    rebase: PlayoutRebaseNote | null,
    baseMs: number,
): Record<string, unknown> {
    const base = raise?.baseMs ?? baseMs;
    return {
        configured: Math.round(base),
        raisedTo: Math.round(base + (raise?.raiseMs ?? 0)),
        raisedBy: raise ? `${raise.lastBy.label} (${raise.lastBy.element})` : null,
        reason: rebase
            ? `${rebase.label} rebased: stamps ${offBy(rebase.latenessMs)} s off the house clock`
            : raise
              ? `${causeText(raise.lastBy.cause, raise.lastBy.queuedMs)}${raise.atCeiling ? ' — ceiling' : ''}` +
                (raise.held ? ` — held: a larger offset cannot help ${raise.held.label}` : '')
              : null,
        since: raise ? isoSecond(raise.since) : isoSecond(rebase?.at ?? 0),
        requests: raise?.requests ?? 0,
    };
}

/** Where a leg's D stands: its route's configured and raised offsets, since when (B-210). */
export interface LegPlayout {
    headLabel: string;
    configuredMs: number;
    raisedToMs: number | null;
    since: number | null;
}

/** The leg section's route half: where its D stands now. */
export function legPlayoutAt(at: LegPlayout): Record<string, unknown> {
    return {
        head: at.headLabel,
        configured: Math.round(at.configuredMs),
        raisedTo: at.raisedToMs === null ? null : Math.round(at.raisedToMs),
        since: at.since === null ? null : isoSecond(at.since),
    };
}

/** The leg's section values after a raise request or a rebase; with no event, its route's
 *  standing raise as a restarted leg shows it (B-210). */
export function legPlayoutStatus(
    ev: ReanchorEvent | null,
    at: LegPlayout,
): Record<string, unknown> {
    return {
        budget: ev ? Math.round(ev.budgetMs) : null,
        lateBy: ev ? Math.round(ev.kind === 'raise' ? ev.excessMs : ev.latenessMs) : null,
        cause: !ev
            ? null
            : ev.kind === 'raise'
              ? causeText(ev.cause, ev.queuedMs)
              : 'timeline fault — rebased this output',
        ...legPlayoutAt(at),
    };
}

/** The head badge: `re-anchored +180 ms` (red once at the ceiling, `held` once a raise held). */
export function reanchorBadge(raise: PlayoutRaise): { icon: string; text: string; color: string } {
    return {
        icon: 'clock-alert',
        text: `re-anchored +${ms(raise.raiseMs)} ms${raise.held ? ', held' : ''}`,
        color: raise.atCeiling ? '#ef4444' : '#f59e0b',
    };
}
