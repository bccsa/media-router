import type { ValueDescriptor } from '@media-router/shared-types';

// Kept free of imports: widget definitions use these while the registry loads them.
export const isNumber = (d: ValueDescriptor) => d.type === 'number' || d.type === 'integer';
export const hasRange = (d: ValueDescriptor) => typeof d.min === 'number' && typeof d.max === 'number';
export const isScalar = (d: ValueDescriptor) => d.type !== 'object';
/** A number with both ends of its range: what faders, sliders and gauges take. */
export const isRangedNumber = (d: ValueDescriptor) => isNumber(d) && hasRange(d);

/** A number option as set; unset or emptied is none. */
export const numberOption = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** `v` within `min…max` (either end optional), float noise from step math removed. */
export function clampNumber(v: number, min?: number, max?: number): number {
    const lo = typeof min === 'number' ? Math.max(min, v) : v;
    return Number((typeof max === 'number' ? Math.min(max, lo) : lo).toFixed(6));
}

/**
 * A number value as widgets use it: plugins send some number stats as text
 * ("2.01") and "—" while idle; that text is read, anything else is no value.
 */
export function asNumber(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    return typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : undefined;
}

/** Decimal places a step implies: 0.25 → 2, 1 → 0. */
export function stepDecimals(step: number | undefined): number {
    if (!step || step >= 1) return 0;
    const s = String(step);
    return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1]?.length ?? 0);
}

/** A value as a readout shows it: numbers to `decimals`, lists joined, true/false as On/Off. */
export function formatValue(v: unknown, decimals?: number, unit?: string): string {
    let text: string;
    if (v === undefined || v === null) text = '—';
    else if (typeof v === 'number') text = decimals === undefined ? String(Number(v.toFixed(3))) : v.toFixed(decimals);
    else if (typeof v === 'boolean') text = v ? 'On' : 'Off';
    else if (Array.isArray(v)) text = v.join(', ');
    else if (typeof v === 'object') text = JSON.stringify(v);
    else text = String(v);
    return unit && typeof v === 'number' ? `${text} ${unit}` : text;
}

/** The dashboards' page backgrounds (dashboard.css `--d-bg`), for contrast checks. */
const BACKGROUND = { dark: '#0f1117', light: '#eef2f6' } as const;

function luminance(hex: string): number | undefined {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return undefined;
    const [r, g, b] = [0, 2, 4].map((i) => {
        const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * `color` for text on the theme's background, or undefined (= the theme's
 * text colour) when it would be hard to read: under 3:1 contrast.
 */
export function readableText(color: string | undefined, theme: 'dark' | 'light'): string | undefined {
    if (!color) return undefined;
    const fg = luminance(color);
    const bg = luminance(BACKGROUND[theme]);
    if (fg === undefined || bg === undefined) return color;
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    return ratio >= 3 ? color : undefined;
}
