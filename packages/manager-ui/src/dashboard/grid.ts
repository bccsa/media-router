import type { Dashboard, DashboardWidget } from '@media-router/shared-types';

/** Cell side when a dashboard scrolls instead of fitting the screen. */
export const CELL_PX = 64;

export interface GridMetrics {
    cw: number;
    ch: number;
    width: number;
    height: number;
}

type Grid = Pick<Dashboard, 'cols' | 'rows' | 'scroll'>;
type Box = { x: number; y: number; w: number; h: number };

/** Cell size and content size: stretched to the box, or fixed cells when scrolling. */
export function gridMetrics(d: Grid, box: { width: number; height: number }): GridMetrics {
    const cw = d.scroll ? CELL_PX : Math.max(1, box.width) / d.cols;
    const ch = d.scroll ? CELL_PX : Math.max(1, box.height) / d.rows;
    return { cw, ch, width: cw * d.cols, height: ch * d.rows };
}

export function rectOf(w: Box, m: GridMetrics): { left: number; top: number; width: number; height: number } {
    return { left: w.x * m.cw, top: w.y * m.ch, width: w.w * m.cw, height: w.h * m.ch };
}

/** A box moved and sized to lie inside the grid (at least one cell). */
export function clampBox(b: Box, d: Pick<Dashboard, 'cols' | 'rows'>): Box {
    const w = Math.min(Math.max(1, Math.round(b.w)), d.cols);
    const h = Math.min(Math.max(1, Math.round(b.h)), d.rows);
    const x = Math.min(Math.max(0, Math.round(b.x)), d.cols - w);
    const y = Math.min(Math.max(0, Math.round(b.y)), d.rows - h);
    return { x, y, w, h };
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The first free spot for a box of this size, row by row; (0, 0) when the grid is full. */
export function firstFree(widgets: readonly Box[], size: { w: number; h: number }, d: Pick<Dashboard, 'cols' | 'rows'>): { x: number; y: number } {
    const w = Math.min(size.w, d.cols);
    const h = Math.min(size.h, d.rows);
    for (let y = 0; y + h <= d.rows; y++) {
        for (let x = 0; x + w <= d.cols; x++) {
            if (!widgets.some((o) => overlaps({ x, y, w, h }, o))) return { x, y };
        }
    }
    return { x: 0, y: 0 };
}

/** The smallest box around some widgets. */
export function bounds(ws: readonly DashboardWidget[]): Box {
    const x = Math.min(...ws.map((w) => w.x));
    const y = Math.min(...ws.map((w) => w.y));
    return { x, y, w: Math.max(...ws.map((w) => w.x + w.w)) - x, h: Math.max(...ws.map((w) => w.y + w.h)) - y };
}
