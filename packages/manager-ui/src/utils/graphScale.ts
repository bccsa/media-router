/**
 * SVG plot geometry for the generic `graph` widget.
 *
 * Scale maths only — linear / log mapping, gridline values, tick formatting.
 * Nothing here knows what is being plotted; the publisher of a `StatusGraph`
 * owns all of that (see `plugins/README.md` → "Graph status fields").
 */

export interface Point {
    x: number;
    y: number;
}

/** Inclusive value range of one axis, in that axis' own units. */
export interface Domain {
    min: number;
    max: number;
}

/** Pixel bounds of the plot area inside the SVG viewBox. */
export interface PlotBox {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** Domain value → x pixel. `log` spaces decades evenly (frequency axes). */
export function toX(value: number, domain: Domain, box: PlotBox, log = false): number {
    const v = clamp(value, domain.min, domain.max);
    const fraction = log
        ? (Math.log10(v) - Math.log10(domain.min)) /
          (Math.log10(domain.max) - Math.log10(domain.min))
        : (v - domain.min) / (domain.max - domain.min);
    return box.left + fraction * (box.right - box.left);
}

/** Domain value → y pixel. SVG y grows downward, so `domain.max` sits on top. */
export function toY(value: number, domain: Domain, box: PlotBox): number {
    const fraction =
        (clamp(value, domain.min, domain.max) - domain.min) / (domain.max - domain.min);
    return box.bottom - fraction * (box.bottom - box.top);
}

/**
 * `points=` attribute for an SVG polyline. Out-of-domain values are clamped to
 * the plot edge rather than dropped, so a curve pushed past the top by makeup
 * gain still reads as "pinned at the ceiling" instead of vanishing.
 */
export function polylinePoints(
    points: Point[],
    x: Domain,
    y: Domain,
    box: PlotBox,
    logX = false,
): string {
    return points
        .map((p) => `${toX(p.x, x, box, logX).toFixed(1)},${toY(p.y, y, box).toFixed(1)}`)
        .join(' ');
}

/** Evenly spaced gridline values across a domain, both endpoints included. */
export function axisTicks(domain: Domain, step: number): number[] {
    const ticks: number[] = [];
    for (let v = domain.min; v <= domain.max + 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
    return ticks;
}

/** Log-axis gridlines — 1-2-5 per decade, trimmed to the domain. */
export function logTicks(domain: Domain): number[] {
    const ticks: number[] = [];
    const firstDecade = Math.floor(Math.log10(domain.min));
    const lastDecade = Math.ceil(Math.log10(domain.max));
    for (let decade = firstDecade; decade <= lastDecade; decade++) {
        for (const mantissa of [1, 2, 5]) {
            const v = mantissa * 10 ** decade;
            if (v >= domain.min && v <= domain.max) ticks.push(v);
        }
    }
    return ticks;
}

/** Compact tick label — SI `k` above a thousand, trimmed decimals below. */
export function formatTick(value: number): string {
    if (Math.abs(value) >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
    return String(Number(value.toFixed(2)));
}
