import { BACKLOG_SHED_SANITY_MS } from './backlogShed.js';

/**
 * Late audio on a sink-point presentation leg — the engine half of the
 * runners' `playout_lateness` report (ADR-0005, Stage 3c note of 2026-10-04).
 *
 * On a `sync=true` GstAudioBaseSink leg, audio that reaches the sink after its
 * playout time is not played late, it is LOST: pulsesink writes it at its
 * timestamp's ring offset, pipewire-pulse has already read past that, and
 * silence plays — no bus message, no QoS, the buffer counted as rendered
 * (`max-lateness` is never consulted for audio sinks). That is how .24's 302M
 * headphone lost 23.7 % of its audio with health "ok". The backlog shedder's
 * probe already measures every buffer against `ts-offset + latency` on the
 * sink's own pad; armed there (shed element == sink), both runners report one
 * window per 10 s of running time, sent from the main loop. GAP buffers count
 * no audio, so a muted (`volume=0`) leg's windows carry none (`mediaMs` 0).
 *
 * RESOLUTION. The probe's deadline can sit up to ±40 ms (alignment-threshold)
 * off the one the sink really plays to — absorbed skew corrections and
 * ts-offset pushes move the sink, not the probe — so `lateMs` is an estimate
 * and a window is judged only late (> 0) or clean. Two late windows in a row
 * trip the owned 'late' warning and a clean minute clears it: that catches
 * .24's 23.7 % (lipSync 0) and 2.3 % (lipSync 80) states, while loss of
 * ~0.1 % (a click every 10–20 s) is below its resolution. A window with no
 * audio in it ends both at once — no section, no warning, no streak — or a
 * muted leg would show its last late window as the present one (.24,
 * 2026-10-05: a muted Headphone1 kept its warning for the whole mute).
 */

/** Runner plugin-event channel (both runners, sink-point shed legs only). */
export const PLAYOUT_LATENESS_EVENT = 'playout_lateness';

/** Dynamic status section showing the last window (`timingStatus`). */
export const PLAYOUT_TIMING_SECTION = {
    id: 'timing',
    label: 'Playout timing',
    fields: [
        { key: 'latePct', label: 'Late audio, last 10 s (estimate)', unit: '%' },
        { key: 'worstMs', label: 'Worst lateness, last 10 s', unit: 'ms' },
        { key: 'budgetMs', label: 'Playout budget (ts-offset + latency)', unit: 'ms' },
        { key: 'latencyMs', label: 'Sink latency', unit: 'ms' },
    ],
};

/** Late windows in a row that trip the warning — one alone is a start-up step
 *  or an onset after silence, never a fault. */
const TRIP_WINDOWS = 2;
/** Clean windows in a row that clear it: a minute, so a leg at the edge stays
 *  latched instead of flapping. */
const CLEAR_WINDOWS = 6;
/** GstAudioBaseSink `alignment-threshold`: the probe's deadline error, and the
 *  step under which a live trim is absorbed — added to every budget advice. */
const ALIGNMENT_MS = 40;

/** One runner window. Lateness is ms past `ts-offset + latency` (= budget). */
export interface LatenessWindow {
    mediaMs: number;
    lateMs: number;
    maxLatenessMs: number;
    minLatenessMs: number;
    budgetMs: number;
    latencyMs: number;
}

const WINDOW_KEYS = [
    'mediaMs',
    'lateMs',
    'maxLatenessMs',
    'minLatenessMs',
    'budgetMs',
    'latencyMs',
] as const;

/** The runner payload as a window; null when malformed (an older or newer runner). */
export function readLatenessWindow(payload: unknown): LatenessWindow | null {
    const p = payload as Record<string, unknown> | null;
    return p && WINDOW_KEYS.every((k) => Number.isFinite(p[k]))
        ? (p as unknown as LatenessWindow)
        : null;
}

const latePct = (w: LatenessWindow): number =>
    w.mediaMs > 0 ? Math.round((1000 * w.lateMs) / w.mediaMs) / 10 : 0;

/** The 'timing' section's values for one window; null for a window with no
 *  audio in it — a muted leg shows no timing, as one that was never unmuted. */
export function timingStatus(w: LatenessWindow): Record<string, number> | null {
    if (w.mediaMs <= 0) return null;
    return {
        latePct: latePct(w),
        worstMs: Math.round(w.maxLatenessMs),
        budgetMs: Math.round(w.budgetMs),
        latencyMs: Math.round(w.latencyMs),
    };
}

/**
 * The warning text for a late window. Lateness past the sanity ceiling (10 s,
 * the largest playout budget there is) is no budget problem: the leg is on a
 * timeline it is not playing, and raising its budget by minutes is not advice
 * (.24, 2026-10-04: the decoder leg sat 588 s late after its source restarted).
 * A floor past the ceiling means every buffer of the window was discarded.
 */
export function lateAudioMessage(w: LatenessWindow): string {
    if (w.maxLatenessMs > BACKLOG_SHED_SANITY_MS) {
        const all = w.minLatenessMs > BACKLOG_SHED_SANITY_MS ? ', all audio discarded' : '';
        return (
            `Audio timeline ${Math.round(w.maxLatenessMs / 1000)} s behind the house clock${all} — ` +
            'upstream timeline fault, not a budget problem'
        );
    }
    const worst = Math.round(w.maxLatenessMs);
    return (
        `Audio reaches the output after its playout time and plays as silence (worst +${worst} ms, ` +
        `≈${latePct(w)} % late in the last 10 s) — needs ≥ ${worst + ALIGNMENT_MS} ms more budget ` +
        "(route Playout Offset or this output's trim)"
    );
}

/** The journal line that ends a warning: a clean minute, or no audio at all. */
export function lateAudioClearedMessage(w: LatenessWindow): string {
    return w.mediaMs > 0
        ? 'Late audio cleared — on time for a minute'
        : 'Late audio cleared — no audio in the last 10 s (muted or no source)';
}

/**
 * Trip/clear hysteresis over consecutive windows. `offer` returns the warning
 * for every late window once tripped (`tripped` only on the first), 'clear'
 * once a clean minute — or a window with no audio in it — ends it, and null
 * otherwise.
 */
export class LateAudioWatch {
    private lateRun = 0;
    private cleanRun = 0;
    private tripped = false;

    offer(w: LatenessWindow): { message: string; tripped: boolean } | 'clear' | null {
        if (w.mediaMs <= 0) {
            // Muted: nothing can be late, and no streak spans the mute.
            const clear = this.tripped;
            this.reset();
            return clear ? 'clear' : null;
        }
        if (w.lateMs > 0) {
            this.cleanRun = 0;
            if (!this.tripped && ++this.lateRun < TRIP_WINDOWS) return null;
            const tripped = !this.tripped;
            this.tripped = true;
            return { message: lateAudioMessage(w), tripped };
        }
        this.lateRun = 0;
        if (!this.tripped || ++this.cleanRun < CLEAR_WINDOWS) return null;
        this.reset();
        return 'clear';
    }

    /** A new pipeline incarnation (PLAYING) has to earn the warning again. */
    reset(): void {
        this.lateRun = 0;
        this.cleanRun = 0;
        this.tripped = false;
    }
}
