// The Lateness trend row (house-clock WI-P4-12, OQ-34): the least-squares slope of an output's
// render lateness over the last 3 min with no gap. Shown with a label; no alarm, no setting.

export const TREND_WINDOW_MS = 180_000;

interface Sample {
    at: number;
    ms: number;
}

export class LatenessTrend {
    private samples: Sample[] = [];
    /** The first sample since the last gap. */
    private since: number | undefined;
    private mark: string | undefined;

    /** `holeMs`: readings further apart than this are a gap; `minStepMs`: closer ones are one. */
    constructor(
        private readonly holeMs: number,
        private readonly minStepMs: number,
    ) {}

    /** A render reading at `at`; `mark` changes at every gap its source counts (a collapsed
     *  hole, a relock, a stall, a display outage, a new element, another source). */
    add(at: number, ms: number, mark: string): void {
        const last = this.samples[this.samples.length - 1];
        if (last && at - last.at < this.minStepMs) return;
        if (!last || mark !== this.mark || at - last.at > this.holeMs) {
            this.samples = [];
            this.since = at;
        }
        this.mark = mark;
        this.samples.push({ at, ms });
        this.samples = this.samples.filter((s) => at - s.at <= TREND_WINDOW_MS);
    }

    /** No reading: the next one starts afresh. */
    gap(): void {
        this.samples = [];
        this.since = undefined;
        this.mark = undefined;
    }

    /** ms per minute once 3 min ran without a gap; `{}` while it measures; undefined: none. */
    slope(): { msPerMin?: number } | undefined {
        const n = this.samples.length;
        if (!n || this.since === undefined) return undefined;
        const newest = this.samples[n - 1].at;
        if (newest - this.since < TREND_WINDOW_MS - this.minStepMs || n < 2) return {};
        const mx = this.samples.reduce((s, x) => s + x.at, 0) / n;
        const my = this.samples.reduce((s, x) => s + x.ms, 0) / n;
        let sxy = 0;
        let sxx = 0;
        for (const s of this.samples) {
            sxy += (s.at - mx) * (s.ms - my);
            sxx += (s.at - mx) ** 2;
        }
        return { msPerMin: sxx > 0 ? (sxy / sxx) * 60_000 : 0 };
    }
}

/** `+12 ms/min — decode or device slower than real time`, `−3 ms/min`, `0 ms/min`, `measuring`. */
export function latenessTrendText(t: { msPerMin?: number }): string {
    if (t.msPerMin === undefined) return 'measuring';
    const r = Math.round(t.msPerMin);
    if (r > 0) return `+${r} ms/min — decode or device slower than real time`;
    return r < 0 ? `−${-r} ms/min` : '0 ms/min';
}
