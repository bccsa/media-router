/**
 * One point per second: its time (ms), and the lowest and highest value seen
 * in that second; `null` = a gap (no live value).
 */
export type Point = [t: number, lo: number, hi: number] | [t: number, gap: null];

/** Time windows a trend offers, in minutes. */
export const TREND_WINDOWS = [1, 5, 15, 60] as const;

/** A value as one trend line: a number, or a list's largest (levels: the loudest channel). */
export function trendValue(v: unknown, asNumber: (x: unknown) => number | undefined): number | undefined {
    if (!Array.isArray(v)) return asNumber(v);
    const nums = v.map(asNumber).filter((n): n is number => n !== undefined);
    return nums.length > 0 ? Math.max(...nums) : undefined;
}

const isGap = (p: Point): p is [number, null] => p[1] === null;

/**
 * A trend's history, in this browser tab only: every update lands in its
 * second's low/high, so a value moving faster than the chart can draw (a
 * level) shows as a band, not as a random sample of it.
 */
export class TrendHistory {
    private readonly lines = new Map<string, Point[]>();

    constructor(public windowMs: number) {}

    sample(path: string, now: number, v: number | null): void {
        let pts = this.lines.get(path);
        if (!pts) this.lines.set(path, (pts = []));
        const sec = Math.floor(now / 1000) * 1000;
        const last = pts.at(-1);
        if (last && last[0] === sec) {
            if (v === null) pts[pts.length - 1] = [sec, null];
            else if (isGap(last)) pts[pts.length - 1] = [sec, v, v];
            else pts[pts.length - 1] = [sec, Math.min(last[1], v), Math.max(last[2], v)];
        } else pts.push(v === null ? [sec, null] : [sec, v, v]);
        // Keep the last point before the window, so the line enters from the edge.
        const cutoff = now - this.windowMs;
        let drop = 0;
        while (drop + 1 < pts.length && pts[drop + 1][0] <= cutoff) drop++;
        if (drop > 0) pts.splice(0, drop);
    }

    points(path: string): readonly Point[] {
        return this.lines.get(path) ?? [];
    }

    /** Every value on the chart (lows and highs), for its scale. */
    values(paths: readonly string[]): number[] {
        return paths.flatMap((p) => this.points(p).flatMap((pt) => (isGap(pt) ? [] : [pt[1], pt[2]])));
    }

    /** Forget values no longer on the chart. */
    retain(paths: readonly string[]): void {
        for (const p of [...this.lines.keys()]) if (!paths.includes(p)) this.lines.delete(p);
    }
}

/** The vertical range: the data's, padded, unless the author fixed an end. */
export function yRange(values: readonly number[], min?: number, max?: number): [number, number] {
    let lo = min ?? (values.length ? Math.min(...values) : 0);
    let hi = max ?? (values.length ? Math.max(...values) : 1);
    if (min === undefined && max === undefined) {
        const pad = (hi - lo) * 0.05;
        lo -= pad;
        hi += pad;
    }
    if (hi <= lo) {
        const d = Math.abs(lo) * 0.1 || 1;
        if (min === undefined) lo -= d;
        if (max === undefined || hi <= lo) hi = lo + 2 * d;
    }
    return [lo, hi];
}

type Scale = { from: number; span: number; lo: number; hi: number };
const X = (t: number, s: Scale) => (((t - s.from) / s.span) * 1000).toFixed(1);
const Y = (v: number, s: Scale) => ((1 - (v - s.lo) / (s.hi - s.lo)) * 1000).toFixed(1);

/** Runs of points between gaps. */
function runs(pts: readonly Point[]): Array<Array<[number, number, number]>> {
    const out: Array<Array<[number, number, number]>> = [];
    let cur: Array<[number, number, number]> = [];
    for (const p of pts) {
        if (isGap(p)) {
            if (cur.length) out.push(cur);
            cur = [];
        } else cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
}

/** SVG path data for a line along each second's high, in a 1000×1000 box; a gap starts a new stroke. */
export function linePath(pts: readonly Point[], from: number, span: number, lo: number, hi: number): string {
    const s = { from, span, lo, hi };
    return runs(pts)
        .map((run) => run.map(([t, , h], i) => `${i ? 'L' : 'M'}${X(t, s)} ${Y(h, s)}`).join(''))
        .join('');
}

/** SVG path data for the band between each second's low and high (empty when they never differ). */
export function bandPath(pts: readonly Point[], from: number, span: number, lo: number, hi: number): string {
    const s = { from, span, lo, hi };
    return runs(pts)
        .filter((run) => run.some(([, l, h]) => h > l))
        .map((run) => {
            const top = run.map(([t, , h], i) => `${i ? 'L' : 'M'}${X(t, s)} ${Y(h, s)}`).join('');
            const bottom = [...run].reverse().map(([t, l]) => `L${X(t, s)} ${Y(l, s)}`).join('');
            return `${top}${bottom}Z`;
        })
        .join('');
}
