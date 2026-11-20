// The Lateness trend row (house-clock WI-P4-12, OQ-34): the least-squares slope of an output's
// render lateness over the last 3 min, pooled across the steps of collapsed holes and gaps (B-241).
// Shown with a label; no alarm, no setting.
import type { DrainSummary } from '@media-router/shared-types';
import { DRAIN_MAX_PPM } from './drainSummary.js';

export const TREND_WINDOW_MS = 180_000;

/** What its source counts: `reset` moves at a new element, a display that stops presenting, a
 *  device relock or stall, another source (the window empties); `step` at a collapsed hole or a
 *  gap (a new segment: its step is no growth). */
export interface GapMark {
    reset: string;
    step: string;
}

interface Sample {
    at: number;
    ms: number;
    /** Its segment: steps since the last reset. */
    seg: number;
    /** Underruns under load (B-240) its drain had counted by then. */
    load: number;
}

export class LatenessTrend {
    private samples: Sample[] = [];
    /** The first sample since the last reset. */
    private since: number | undefined;
    private mark: GapMark | undefined;
    private seg = 0;

    /** `holeMs`: readings further apart than this are a gap; `minStepMs`: closer ones are one. */
    constructor(
        private readonly holeMs: number,
        private readonly minStepMs: number,
    ) {}

    /** A render reading at `at` with its source's mark; `load`: its drain's `load` underruns. */
    add(at: number, ms: number, mark: GapMark, load = 0): void {
        const last = this.samples[this.samples.length - 1];
        if (last && at - last.at < this.minStepMs) return;
        if (!last || !this.mark || mark.reset !== this.mark.reset || at - last.at > this.holeMs) {
            this.samples = [];
            this.since = at;
            this.seg = 0;
        } else if (mark.step !== this.mark.step) {
            this.seg++;
        }
        this.mark = mark;
        this.samples.push({ at, ms, seg: this.seg, load });
        this.samples = this.samples.filter((s) => at - s.at <= TREND_WINDOW_MS);
    }

    /** No reading: the next one starts afresh. */
    gap(): void {
        this.samples = [];
        this.since = undefined;
        this.mark = undefined;
    }

    /** ms per minute once 3 min ran since the last reset: one slope through every segment of 2 or
     *  more readings, each its own level; `{}` while it measures; undefined: none. `underLoad`:
     *  an underrun under load counted in the window. */
    slope(): { msPerMin?: number; underLoad?: true } | undefined {
        const n = this.samples.length;
        if (!n || this.since === undefined) return undefined;
        const newest = this.samples[n - 1];
        if (newest.at - this.since < TREND_WINDOW_MS - this.minStepMs) return {};
        const segs = new Map<number, Sample[]>();
        for (const s of this.samples) segs.set(s.seg, [...(segs.get(s.seg) ?? []), s]);
        let sxy = 0;
        let sxx = 0;
        let used = 0;
        for (const xs of segs.values()) {
            if (xs.length < 2) continue;
            used++;
            const mx = xs.reduce((a, x) => a + x.at, 0) / xs.length;
            const my = xs.reduce((a, x) => a + x.ms, 0) / xs.length;
            for (const s of xs) {
                sxy += (s.at - mx) * (s.ms - my);
                sxx += (s.at - mx) ** 2;
            }
        }
        if (!used) return {};
        const out: { msPerMin?: number; underLoad?: true } = {
            msPerMin: sxx > 0 ? (sxy / sxx) * 60_000 : 0,
        };
        if (newest.load > this.samples[0].load) out.underLoad = true;
        return out;
    }
}

/** `+12 ms/min — decode or device slower than real time`, `−3 ms/min`, `0 ms/min`, `measuring`;
 *  `−300 ms/min — draining to its target`, `+40 ms/min — growing faster than it can drain (0.5 %)`
 *  by the drain (WI-P4-18), `+40 ms/min — falling behind under load` (B-240). */
export function latenessTrendText(
    t: { msPerMin?: number; underLoad?: true },
    drain?: Pick<DrainSummary, 'state' | 'ppm'>,
): string {
    if (t.msPerMin === undefined) return 'measuring';
    const r = Math.round(t.msPerMin);
    if (r < 0 && drain?.state === 'draining') return `−${-r} ms/min — draining to its target`;
    if (r > 0 && t.underLoad) return `+${r} ms/min — falling behind under load`;
    if (r > 0 && drain && drain.ppm >= DRAIN_MAX_PPM - 1) {
        return `+${r} ms/min — growing faster than it can drain (0.5 %)`;
    }
    if (r > 0) return `+${r} ms/min — decode or device slower than real time`;
    return r < 0 ? `−${-r} ms/min` : '0 ms/min';
}
