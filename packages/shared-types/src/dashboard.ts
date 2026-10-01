import { z } from 'zod';
import { dropUndefined } from './tree/object.js';
import { createLogger } from './logger.js';
import {
    SCRIPT_CALLS,
    SCRIPT_MAX_BLOCKS,
    SCRIPT_MAX_DEPTH,
    SCRIPT_MAX_TIMEOUT_S,
    SCRIPT_OPS,
    mapScriptPaths,
    scriptShape,
    type DashboardScript,
    type ScriptExpr,
    type ScriptStep,
} from './script.js';

export * from './script.js';

export { absolutePath, widgetPaths } from './dashboardPaths.js';

/** Grid cells per side and widgets per dashboard (ADR-0026). */
export const DASHBOARD_MAX_CELLS = 96;
export const DASHBOARD_MAX_WIDGETS = 400;
/** Values one widget may show together (a trend's lines). */
export const DASHBOARD_MAX_BINDS = 8;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const TreePath = z.string().startsWith('/').max(400);
const Cell = z.number().int().min(0).max(DASHBOARD_MAX_CELLS - 1);
const Span = z.number().int().min(1).max(DASHBOARD_MAX_CELLS);

/** What a button does: a call on a node, or a fixed value written to one. */
export const DashboardActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('call'), path: TreePath, method: z.string().min(1).max(40) }),
    z.object({ kind: z.literal('write'), path: TreePath, value: z.unknown() }),
]);

const ScriptExprSchema: z.ZodType<ScriptExpr> = z.lazy(() =>
    z.union([
        z.object({ lit: z.union([z.number(), z.string().max(400), z.boolean()]) }).strict(),
        z.object({ read: TreePath }).strict(),
        z.object({ op: z.enum(SCRIPT_OPS), a: ScriptExprSchema, b: ScriptExprSchema }).strict(),
        z.object({ not: ScriptExprSchema }).strict(),
    ]),
);

const ScriptStepSchema: z.ZodType<ScriptStep> = z.lazy(() =>
    z.discriminatedUnion('do', [
        z.object({ do: z.literal('call'), path: TreePath, method: z.enum(SCRIPT_CALLS) }),
        z.object({ do: z.literal('write'), path: TreePath, value: ScriptExprSchema }),
        z.object({ do: z.literal('wait'), seconds: ScriptExprSchema }),
        z.object({ do: z.literal('if'), cond: ScriptExprSchema, then: z.array(ScriptStepSchema), else: z.array(ScriptStepSchema).optional() }),
        z.object({ do: z.literal('repeat'), times: ScriptExprSchema, body: z.array(ScriptStepSchema) }),
        z.object({ do: z.literal('until'), cond: ScriptExprSchema, body: z.array(ScriptStepSchema) }),
        z.object({ do: z.literal('waitUntil'), cond: ScriptExprSchema, timeoutS: z.number().positive().max(SCRIPT_MAX_TIMEOUT_S) }),
        z.object({ do: z.literal('stop') }),
    ]),
);

/** A button's actions (ADR-0027): run on the server the page talks to. An older `mode` is dropped. */
export const DashboardScriptSchema: z.ZodType<DashboardScript> = z
    .object({
        steps: z.array(ScriptStepSchema).min(1),
        timeoutS: z.number().int().min(1).max(SCRIPT_MAX_TIMEOUT_S).optional(),
    })
    .superRefine((s, ctx) => {
        const { blocks, depth } = scriptShape(s.steps);
        if (blocks > SCRIPT_MAX_BLOCKS) ctx.addIssue({ code: 'custom', message: `more than ${SCRIPT_MAX_BLOCKS} blocks` });
        if (depth > SCRIPT_MAX_DEPTH) ctx.addIssue({ code: 'custom', message: `nested deeper than ${SCRIPT_MAX_DEPTH}` });
    });

export const DashboardWidgetSchema = z.object({
    id: Id,
    type: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    x: Cell,
    y: Cell,
    w: Span,
    h: Span,
    /** The value shown or set, relative to the dashboard's root. */
    bind: TreePath.optional(),
    /** Several values shown together (a trend), in order. */
    binds: z.array(TreePath).min(1).max(DASHBOARD_MAX_BINDS).optional(),
    action: DashboardActionSchema.optional(),
    /** Several actions, or a script with logic (ADR-0027); replaces `action`. */
    script: DashboardScriptSchema.optional(),
    /** Display only, even on a writable value. */
    inputDisabled: z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
});

export const DashboardSchema = z
    .object({
        name: z.string().trim().min(1).max(64),
        cols: Span,
        rows: Span,
        /** Off: the grid fits the screen; on: fixed cells, the page scrolls. */
        scroll: z.boolean(),
        zoom: z.boolean(),
        /** No dashboard menu (the browser's own address bar and Back still work). */
        locked: z.boolean(),
        theme: z.enum(['dark', 'light']),
        /** Drawn in order: later widgets sit on top (frames first). */
        widgets: z.array(DashboardWidgetSchema).max(DASHBOARD_MAX_WIDGETS),
        /** Bumped on every save; a save based on an older one is a conflict. */
        rev: z.number().int().nonnegative().optional(),
    })
    .superRefine((d, ctx) => {
        const ids = new Set<string>();
        d.widgets.forEach((w, i) => {
            if (ids.has(w.id)) ctx.addIssue({ code: 'custom', path: ['widgets', i, 'id'], message: 'duplicate widget id' });
            ids.add(w.id);
            if (w.x + w.w > d.cols || w.y + w.h > d.rows) {
                ctx.addIssue({ code: 'custom', path: ['widgets', i], message: 'outside the grid' });
            }
        });
    });

export type DashboardAction = z.infer<typeof DashboardActionSchema>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DASHBOARD_DEFAULTS = { cols: 24, rows: 14, scroll: false, zoom: false, locked: false, theme: 'dark' } as const;

export function newDashboard(name: string): Dashboard {
    return { name, ...DASHBOARD_DEFAULTS, widgets: [] };
}

// Made on first use: this module is in the manager UI's bundle, and pino's Node streams must not start there.
let log: ReturnType<typeof createLogger> | undefined;
/** Stored dashboards already checked, by object: a profile is read far more often than it changes. */
const checked = new WeakMap<object, boolean>();

/** A stored dashboard that is valid; one that is not (hand-edited, older) is logged once and left out. */
export function isValidDashboard(id: string, d: unknown): d is Dashboard {
    if (!d || typeof d !== 'object') return false;
    let ok = checked.get(d);
    if (ok === undefined) {
        const r = DashboardSchema.safeParse(d);
        ok = r.success;
        checked.set(d, ok);
        if (!r.success) (log ??= createLogger('dashboards')).warn({ id, issue: r.error.issues[0] }, 'Invalid stored dashboard left out');
    }
    return ok;
}

/** A router profile's valid dashboards, keyed by id. */
export function dashboardsOf(config: Record<string, unknown> | null | undefined): Record<string, Dashboard> {
    const all = config?.dashboards;
    if (!all || typeof all !== 'object') return {};
    return Object.fromEntries(Object.entries(all).filter(([id, d]) => isValidDashboard(id, d))) as Record<string, Dashboard>;
}

/** The dashboard with this name, if any: names are unique where dashboards live. */
export function findDashboard(dashboards: Record<string, Dashboard>, name: string): [string, Dashboard] | undefined {
    return Object.entries(dashboards).find(([, d]) => d.name === name);
}

/** `path` moved from below `from` to below `to` (module paths, e.g. `/modules/a`); others unchanged. */
export function rebindPath(path: string, from: string, to: string): string {
    return path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
}

function mapPaths(w: DashboardWidget, move: (path: string) => string): DashboardWidget {
    return dropUndefined({
        ...w,
        bind: w.bind === undefined ? undefined : move(w.bind),
        binds: w.binds?.map(move),
        action: w.action ? { ...w.action, path: move(w.action.path) } : undefined,
        script: w.script ? { ...w.script, steps: mapScriptPaths(w.script.steps, move) } : undefined,
    });
}

/** A widget whose value and action follow a module from `from` to `to`. */
export function rebindWidget(w: DashboardWidget, from: string, to: string): DashboardWidget {
    return mapPaths(w, (p) => rebindPath(p, from, to));
}

/**
 * A copy of `d` for another router or profile: each path below a module in
 * `modules` (from → to) moves once; the rest are kept, so an unmatched module
 * shows as missing there. The copy starts a fresh revision history.
 */
export function copyDashboard(d: Dashboard, name: string, modules: Record<string, string>): Dashboard {
    const pairs = Object.entries(modules);
    const move = (p: string) => {
        for (const [from, to] of pairs) if (p === from || p.startsWith(`${from}/`)) return rebindPath(p, from, to);
        return p;
    };
    const { rev: _rev, ...rest } = d;
    return { ...rest, name, widgets: d.widgets.map((w) => mapPaths(w, move)) };
}
