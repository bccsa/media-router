// Button scripts (ADR-0027): data, never code. Zod-free — the router's viewer
// bundles `shared-types/browser`. The schema is in dashboard.ts.

export const SCRIPT_OPS = ['+', '-', '*', '/', '=', '!=', '<', '>', '<=', '>=', 'and', 'or'] as const;
export type ScriptOp = (typeof SCRIPT_OPS)[number];

/** A value inside a script: a literal, a tree value read at run time, or a combination. */
export type ScriptExpr =
    | { lit: number | string | boolean }
    | { read: string }
    | { op: ScriptOp; a: ScriptExpr; b: ScriptExpr }
    | { not: ScriptExpr };

/** Calls a step may make: what the button's single action already offered. */
export const SCRIPT_CALLS = ['restart', 'reset', 'reboot'] as const;

export type ScriptStep =
    | { do: 'call'; path: string; method: (typeof SCRIPT_CALLS)[number] }
    | { do: 'write'; path: string; value: ScriptExpr }
    | { do: 'wait'; seconds: ScriptExpr }
    | { do: 'if'; cond: ScriptExpr; then: ScriptStep[]; else?: ScriptStep[] }
    | { do: 'repeat'; times: ScriptExpr; body: ScriptStep[] }
    | { do: 'until'; cond: ScriptExpr; body: ScriptStep[] }
    | { do: 'waitUntil'; cond: ScriptExpr; timeoutS: number }
    | { do: 'stop' };

export interface DashboardScript {
    steps: ScriptStep[];
    /** The longest a run may take (default SCRIPT_DEFAULT_TIMEOUT_S). */
    timeoutS?: number;
}

export const SCRIPT_DEFAULT_TIMEOUT_S = 60;
export const SCRIPT_MAX_TIMEOUT_S = 3600;
/** Blocks in one script, and how deep they may nest. */
export const SCRIPT_MAX_BLOCKS = 200;
export const SCRIPT_MAX_DEPTH = 8;
/** Steps one run may execute (loops included), and a repeat's largest count. */
export const SCRIPT_MAX_EXECUTED = 10_000;
export const SCRIPT_MAX_REPEAT = 1000;

/** The child lists of a step (if/else, loop bodies). */
export function childLists(s: ScriptStep): ScriptStep[][] {
    if (s.do === 'if') return s.else ? [s.then, s.else] : [s.then];
    if (s.do === 'repeat' || s.do === 'until') return [s.body];
    return [];
}

function exprsOf(s: ScriptStep): ScriptExpr[] {
    switch (s.do) {
        case 'write':
            return [s.value];
        case 'wait':
            return [s.seconds];
        case 'if':
        case 'until':
        case 'waitUntil':
            return [s.cond];
        case 'repeat':
            return [s.times];
        default:
            return [];
    }
}

function exprPaths(e: ScriptExpr, out: string[]): void {
    if ('read' in e) out.push(e.read);
    else if ('op' in e) {
        exprPaths(e.a, out);
        exprPaths(e.b, out);
    } else if ('not' in e) exprPaths(e.not, out);
}

/** Every tree path a script reads, writes or calls. */
export function scriptPaths(steps: readonly ScriptStep[]): string[] {
    const out: string[] = [];
    for (const s of steps) {
        if (s.do === 'call' || s.do === 'write') out.push(s.path);
        for (const e of exprsOf(s)) exprPaths(e, out);
        for (const list of childLists(s)) out.push(...scriptPaths(list));
    }
    return out;
}

function mapExpr(e: ScriptExpr, move: (p: string) => string): ScriptExpr {
    if ('read' in e) return { read: move(e.read) };
    if ('op' in e) return { op: e.op, a: mapExpr(e.a, move), b: mapExpr(e.b, move) };
    if ('not' in e) return { not: mapExpr(e.not, move) };
    return e;
}

/** The steps with every path moved (Copy to…, Duplicate for…, a router rename). */
export function mapScriptPaths(steps: readonly ScriptStep[], move: (p: string) => string): ScriptStep[] {
    return steps.map((s): ScriptStep => {
        switch (s.do) {
            case 'call':
                return { ...s, path: move(s.path) };
            case 'write':
                return { ...s, path: move(s.path), value: mapExpr(s.value, move) };
            case 'wait':
                return { ...s, seconds: mapExpr(s.seconds, move) };
            case 'if':
                return {
                    ...s,
                    cond: mapExpr(s.cond, move),
                    then: mapScriptPaths(s.then, move),
                    ...(s.else ? { else: mapScriptPaths(s.else, move) } : {}),
                };
            case 'repeat':
                return { ...s, times: mapExpr(s.times, move), body: mapScriptPaths(s.body, move) };
            case 'until':
                return { ...s, cond: mapExpr(s.cond, move), body: mapScriptPaths(s.body, move) };
            case 'waitUntil':
                return { ...s, cond: mapExpr(s.cond, move) };
            default:
                return s;
        }
    });
}

/** Blocks in a script, and its deepest nesting (1 = a flat list). */
export function scriptShape(steps: readonly ScriptStep[]): { blocks: number; depth: number } {
    let blocks = 0;
    let depth = steps.length > 0 ? 1 : 0;
    for (const s of steps) {
        blocks += 1;
        for (const list of childLists(s)) {
            const inner = scriptShape(list);
            blocks += inner.blocks;
            depth = Math.max(depth, inner.depth + 1);
        }
    }
    return { blocks, depth };
}

/** Whether a script may reboot the router (a reboot without a manager asks first). */
export function scriptReboots(steps: readonly ScriptStep[]): boolean {
    return steps.some((s) => (s.do === 'call' && s.method === 'reboot') || childLists(s).some(scriptReboots));
}
