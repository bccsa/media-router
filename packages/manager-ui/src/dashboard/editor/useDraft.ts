import { computed, ref, toRaw } from 'vue';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { Dashboard, DashboardWidget } from '@media-router/shared-types';
import { WIDGETS } from '../registry';
import { bounds, clampBox, firstFree, overlaps } from '../grid';
import { moduleOf } from '../paths';

const { rebindWidget, widgetPaths } = shared;

export function newWidgetId(): string {
    return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Every module a widget is tied to (`/modules/m1`, or `/engines/e/modules/m1`). */
export function modulePathsOf(w: DashboardWidget): string[] {
    const mods = widgetPaths(w).map(moduleOf);
    return [...new Set(mods.filter((m): m is string => !!m))];
}

/** The one module a widget is tied to, if it is exactly one. */
export function modulePathOf(w: DashboardWidget): string | undefined {
    const mods = modulePathsOf(w);
    return mods.length === 1 ? mods[0] : undefined;
}

/** A dashboard's settings dialog fields. */
export type Settings = Pick<Dashboard, 'name' | 'cols' | 'rows' | 'scroll' | 'zoom' | 'locked' | 'theme'>;

/** Copied widgets, kept across dashboards for this session. */
const clipboard = ref<DashboardWidget[]>([]);

/**
 * A dashboard being edited (ADR-0026): changes stay in this copy until
 * Save. Selection is by widget id; every edit keeps widgets inside the grid.
 */
export function useDraft(start: Dashboard) {
    const base = structuredClone(toRaw(start));
    const draft = ref<Dashboard>(structuredClone(base));
    const selected = ref<string[]>([]);
    const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(base));
    const byId = (id: string) => draft.value.widgets.find((w) => w.id === id);
    const selection = computed(() => draft.value.widgets.filter((w) => selected.value.includes(w.id)));

    function select(id: string | null, extend = false) {
        if (id === null) selected.value = [];
        else if (!extend) selected.value = [id];
        else selected.value = selected.value.includes(id) ? selected.value.filter((s) => s !== id) : [...selected.value, id];
    }

    function add(type: string): DashboardWidget | undefined {
        const def = WIDGETS[type];
        if (!def) return undefined;
        const size = { w: Math.min(def.size.w, draft.value.cols), h: Math.min(def.size.h, draft.value.rows) };
        const w: DashboardWidget = { id: newWidgetId(), type, ...firstFree(draft.value.widgets, size, draft.value), ...size };
        draft.value.widgets.push(w);
        selected.value = [w.id];
        return w;
    }

    /** Move the selection together, as far as the grid allows. */
    function move(dx: number, dy: number) {
        if (selection.value.length === 0) return;
        const b = bounds(selection.value);
        const x = Math.min(Math.max(-b.x, dx), draft.value.cols - b.x - b.w);
        const y = Math.min(Math.max(-b.y, dy), draft.value.rows - b.y - b.h);
        for (const w of selection.value) {
            w.x += x;
            w.y += y;
        }
    }

    function resize(id: string, wCells: number, hCells: number) {
        const w = byId(id);
        if (!w) return;
        Object.assign(w, clampBox({ x: w.x, y: w.y, w: Math.min(wCells, draft.value.cols - w.x), h: Math.min(hCells, draft.value.rows - w.y) }, draft.value));
    }

    function remove() {
        draft.value.widgets = draft.value.widgets.filter((w) => !selected.value.includes(w.id));
        selected.value = [];
    }

    function update(id: string, patch: Partial<Pick<DashboardWidget, 'bind' | 'binds' | 'action' | 'script' | 'inputDisabled'>>) {
        const w = byId(id);
        if (!w) return;
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === false) delete (w as Record<string, unknown>)[k];
            else (w as Record<string, unknown>)[k] = v;
        }
    }

    function setOption(id: string, key: string, value: unknown) {
        const w = byId(id);
        if (!w) return;
        const options = { ...(w.options ?? {}) };
        if (value === undefined || value === '' || value === null) delete options[key];
        else options[key] = value;
        if (Object.keys(options).length > 0) w.options = options;
        else delete w.options;
    }

    /** Frames go behind: later widgets draw on top. */
    function restack(toFront: boolean) {
        const picked = selection.value;
        const rest = draft.value.widgets.filter((w) => !selected.value.includes(w.id));
        draft.value.widgets = toFront ? [...rest, ...picked] : [...picked, ...rest];
    }

    /**
     * Place copies as one block on a lattice of the originals' size, reading
     * order from them: the rest of their row, then the rows below from the
     * left, then above. Each goes wherever there is room when no slot fits.
     */
    function place(copies: DashboardWidget[], from: readonly DashboardWidget[]) {
        const d = draft.value;
        const b = bounds(from);
        const fits = (dx: number, dy: number) =>
            copies.every((c) => {
                const moved = { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h };
                return moved.x >= 0 && moved.y >= 0 && moved.x + moved.w <= d.cols && moved.y + moved.h <= d.rows && !d.widgets.some((o) => overlaps(moved, o));
            });
        const slots: Array<readonly [number, number]> = [];
        for (let y = b.y - Math.floor(b.y / b.h) * b.h; y + b.h <= d.rows; y += b.h) {
            for (let x = b.x - Math.floor(b.x / b.w) * b.w; x + b.w <= d.cols; x += b.w) {
                if (x !== b.x || y !== b.y) slots.push([x - b.x, y - b.y]);
            }
        }
        const after = ([dx, dy]: readonly [number, number]) => dy > 0 || (dy === 0 && dx > 0);
        const slot = [...slots.filter(after), ...slots.filter((s) => !after(s))].find(([dx, dy]) => fits(dx, dy));
        for (const c of copies) {
            if (slot) {
                c.x += slot[0];
                c.y += slot[1];
            } else Object.assign(c, firstFree(d.widgets, c, d));
        }
        d.widgets.push(...copies);
        selected.value = copies.map((c) => c.id);
    }

    function copy() {
        clipboard.value = selection.value.map((w) => structuredClone(toRaw(w)));
    }

    function paste() {
        if (clipboard.value.length === 0) return;
        const copies = clipboard.value.map((w) => ({ ...structuredClone(toRaw(w)), id: newWidgetId() }));
        for (const c of copies) Object.assign(c, clampBox(c, draft.value));
        place(copies, copies.map((c) => ({ ...c })));
    }

    /** The one module the selection is tied to, if it is exactly one. */
    const selectionModule = computed(() => {
        const paths = new Set(selection.value.map(modulePathOf).filter((p): p is string => !!p));
        return paths.size === 1 ? [...paths][0] : undefined;
    });

    /** Duplicate for… (ADR-0026): copies of the selection tied to another module. */
    function duplicateFor(toModule: string) {
        const from = selectionModule.value;
        if (!from) return;
        const originals = selection.value;
        const copies = originals.map((w) => ({ ...rebindWidget(structuredClone(toRaw(w)), from, toModule), id: newWidgetId() }));
        place(copies, originals);
    }

    /** Grid settings; a smaller grid pulls widgets back inside it. */
    function configure(patch: Partial<Settings>) {
        Object.assign(draft.value, patch);
        for (const w of draft.value.widgets) Object.assign(w, clampBox(w, draft.value));
    }

    return { draft, selected, selection, selectionModule, dirty, select, add, move, resize, remove, update, setOption, restack, copy, paste, duplicateFor, configure };
}

export type Draft = ReturnType<typeof useDraft>;
