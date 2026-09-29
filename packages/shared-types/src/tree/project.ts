import type { PatchOp } from '../index.js';
import { WILDCARD, covers, isAncestorOf } from './patterns.js';
import { isPlainObject } from './object.js';


/** Array elements are addressed by `id` when they have one, else by index. */
function elementKeys(item: unknown, index: number): string[] {
    const id = isPlainObject(item) ? item.id : undefined;
    return typeof id === 'string' ? [id, String(index)] : [String(index)];
}

/**
 * Keep only the parts of `value` that one of the relative patterns reaches.
 * An empty relative pattern keeps the whole node. Returns undefined when
 * nothing matched.
 */
export function prune(value: unknown, rels: ReadonlyArray<readonly string[]>): unknown {
    if (rels.some((r) => r.length === 0)) return value;
    const step = (keys: string[]) =>
        rels.filter((r) => r[0] === WILDCARD || keys.includes(r[0])).map((r) => r.slice(1));
    if (Array.isArray(value)) {
        const kept: unknown[] = [];
        value.forEach((item, i) => {
            const next = step(elementKeys(item, i));
            if (next.length === 0) return;
            const sub = prune(item, next);
            if (sub !== undefined) kept.push(sub);
        });
        return kept.length > 0 ? kept : undefined;
    }
    if (!isPlainObject(value)) return undefined;
    const out: Record<string, unknown> = {};
    let any = false;
    for (const [key, child] of Object.entries(value)) {
        const next = step([key]);
        if (next.length === 0) continue;
        const sub = prune(child, next);
        if (sub !== undefined) {
            out[key] = sub;
            any = true;
        }
    }
    return any ? out : undefined;
}

/**
 * Shape an op at `path` for a subscriber holding `patterns`. A pattern that
 * covers the path takes the op as-is; an op at an ancestor is pruned to what
 * the patterns reach, so nothing outside them leaks and vanished parts clear.
 * Null when no pattern overlaps.
 */
export function projectOp(
    op: PatchOp,
    path: readonly string[],
    patterns: ReadonlyArray<readonly string[]>,
): PatchOp | null {
    if (patterns.some((p) => covers(p, path))) return op;
    const rels = patterns.filter((p) => isAncestorOf(path, p)).map((p) => p.slice(path.length));
    if (rels.length === 0) return null;
    if (op.op === 'remove') return op;
    const pruned = prune(op.value, rels);
    if (pruned !== undefined) return { op: op.op, path: op.path, value: pruned };
    if (Array.isArray(op.value)) return { op: op.op, path: op.path, value: [] };
    if (isPlainObject(op.value)) return { op: op.op, path: op.path, value: {} };
    return { op: 'remove', path: op.path };
}
