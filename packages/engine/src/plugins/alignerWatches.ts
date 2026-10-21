// The aligner inputs' `mralignwatch` reports (house-clock WI-P2-13): state, pace, W, absences
// and stale discards, on a change and every second, kept per element. LatenessReporter maps them
// to the module's inputs; the rejoin and late-cue events go to the module's log.
import type { AlignerInputState } from '@media-router/shared-types';

/** Plugin-event channel prefix: `mralignwatch:<element name>`. */
export const ALIGNER_EVENT = 'mralignwatch';

/** One watch, as a module's resolver sees it. */
export interface AlignerWatchRef {
    /** Its element name (the channel's suffix). */
    name: string;
    /** Its aggregator, the pace group it belongs to. */
    aligner: string;
    /** Its `input` label: the bus connection id on the 302M fan-ins. */
    input: string;
}

/** The input a watch serves: a lateness tap's input, an input of its own named by `label`,
 *  or `null` for an internal stage, whose pace and full queue count and nothing else. */
export type AlignerInputRef = { tap: string } | { label: string } | null;

/** One report, ns fields in ms. */
export interface AlignerReport {
    reason: string;
    aligner: string;
    input: string;
    state: AlignerInputState;
    latenessMs: number;
    paceMs: number;
    silenceLimitMs: number;
    absences: number;
    staleMs: number;
    fullCount: number;
    levelTimeMs: number;
    levelBytes: number;
    /** `reason=late-cue`: how late the cue came. */
    cueLatenessMs?: number;
}

/** What goes in the module's log (chapter 6 part 10's events). */
export type AlignerEvent =
    | { kind: 'rejoin'; watch: AlignerWatchRef; absentMs: number; discardedMs: number }
    | { kind: 'late-cue'; watch: AlignerWatchRef; cueLatenessMs: number; raisedMs: number };

export interface AlignerWatch {
    ref: AlignerWatchRef;
    /** The latest report and when it came. */
    report: AlignerReport;
    at: number;
    /** True from a full episode's report until the queue drained to half of its levels. */
    full: boolean;
}

interface Entry extends AlignerWatch {
    absentSince?: number;
    /** After a return from absence, until the stale discard settles (no growth over a report). */
    rejoin?: { absentMs: number; baseStaleMs: number; lastStaleMs: number };
    /** The levels a full episode began at; it ends once both are at half or less. */
    fullAt?: { timeMs: number; bytes: number };
}

const NS_PER_MS = 1_000_000;
const STATES: ReadonlySet<string> = new Set(['waiting', 'present', 'absent']);

/** One `mralignwatch` payload as a report; null without a known state. */
export function parseAlignerPayload(payload: unknown): AlignerReport | null {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (typeof p.state !== 'string' || !STATES.has(p.state)) return null;
    const num = (k: string): number => {
        const v = Number(p[k]);
        return Number.isFinite(v) ? v : 0;
    };
    const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
    const report: AlignerReport = {
        reason: str('reason'),
        aligner: str('aligner'),
        input: str('input'),
        state: p.state as AlignerInputState,
        latenessMs: num('lateness') / NS_PER_MS,
        paceMs: num('pace') / NS_PER_MS,
        silenceLimitMs: num('silence-limit') / NS_PER_MS,
        absences: num('absences'),
        staleMs: num('stale-time') / NS_PER_MS,
        fullCount: num('full-count'),
        levelTimeMs: num('level-time') / NS_PER_MS,
        levelBytes: num('level-bytes'),
    };
    if (report.reason === 'late-cue') report.cueLatenessMs = num('cue-lateness') / NS_PER_MS;
    return report;
}

/** A new element under an old name (a runner respawn): its counters start again. */
function restarted(prev: AlignerReport, r: AlignerReport): boolean {
    return r.absences < prev.absences || r.staleMs < prev.staleMs || r.fullCount < prev.fullCount;
}

export class AlignerWatches {
    private readonly entries = new Map<string, Entry>();

    /** One report from element `name`: whether a state or a full episode changed, and the
     *  events it completes. Null when the payload is no report. */
    take(
        name: string,
        payload: unknown,
        now: number,
    ): { changed: boolean; events: AlignerEvent[] } | null {
        const r = parseAlignerPayload(payload);
        if (!r) return null;
        const old = this.entries.get(name);
        const prev = old && !restarted(old.report, r) ? old : undefined;
        const ref = { name, aligner: r.aligner, input: r.input };
        const groupPace = this.groupPace(r.aligner);
        const e: Entry = { ref, report: r, at: now, full: prev?.full ?? false };
        e.absentSince = prev?.absentSince;
        e.rejoin = prev?.rejoin;
        e.fullAt = prev?.fullAt;
        const events: AlignerEvent[] = [];
        const was = prev?.report.state;

        if (r.state === 'absent') {
            if (was !== 'absent') {
                this.settle(e, r.staleMs, events); // gone again before its rejoin settled
                e.absentSince = now;
            }
        } else if (was === 'absent' && r.state === 'present') {
            // Back (a flush instead makes it wait again: no rejoin).
            const absentMs = now - (e.absentSince ?? now);
            e.rejoin = { absentMs, baseStaleMs: prev!.report.staleMs, lastStaleMs: r.staleMs };
        } else if (e.rejoin) {
            // The backlog is discarded on arrival: over once a report finds no more.
            if (r.staleMs === e.rejoin.lastStaleMs) this.settle(e, r.staleMs, events);
            else e.rejoin.lastStaleMs = r.staleMs;
        }

        if (r.reason === 'full' || (prev && r.fullCount > prev.report.fullCount)) {
            e.fullAt = { timeMs: r.levelTimeMs, bytes: r.levelBytes };
        } else if (
            e.fullAt &&
            r.levelTimeMs <= e.fullAt.timeMs / 2 &&
            r.levelBytes <= e.fullAt.bytes / 2
        ) {
            e.fullAt = undefined;
        }
        e.full = e.fullAt !== undefined;

        if (r.reason === 'late-cue') {
            events.push({
                kind: 'late-cue',
                watch: ref,
                cueLatenessMs: r.cueLatenessMs ?? 0,
                raisedMs: Math.max(0, r.paceMs - groupPace),
            });
        }
        this.entries.set(name, e);
        return { changed: was !== r.state || (prev?.full ?? false) !== e.full, events };
    }

    /** A rejoin's discard has settled, or the input left again: its one event. */
    private settle(e: Entry, staleMs: number, events: AlignerEvent[]): void {
        if (!e.rejoin) return;
        events.push({
            kind: 'rejoin',
            watch: e.ref,
            absentMs: e.rejoin.absentMs,
            discardedMs: Math.max(0, staleMs - e.rejoin.baseStaleMs),
        });
        e.rejoin = undefined;
    }

    /** The pace an aligner's members reported last. */
    private groupPace(aligner: string): number {
        let pace = 0;
        for (const e of this.entries.values()) {
            if (e.report.aligner === aligner) pace = Math.max(pace, e.report.paceMs);
        }
        return pace;
    }

    /** Forget watches that stopped reporting (input removed, pipeline gone). */
    expire(now: number, staleMs: number): void {
        for (const [name, e] of this.entries) {
            if (now - e.at > staleMs) this.entries.delete(name);
        }
    }

    list(): AlignerWatch[] {
        return [...this.entries.values()];
    }

    clear(): void {
        this.entries.clear();
    }
}
