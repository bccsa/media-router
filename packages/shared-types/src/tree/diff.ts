import type { PatchOp } from '../index.js';
import { joinPath } from './paths.js';
import { isPlainObject } from './object.js';


function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Leaf-level JSON Patch ops that turn `prev` into `next`, both plain JSON.
 * Objects are walked key by key; arrays and primitives are replaced whole.
 * An undefined key counts as absent; null is a value.
 */
export function diffValues(prev: unknown, next: unknown, base: readonly string[] = []): PatchOp[] {
    const ops: PatchOp[] = [];
    walk(prev, next, [...base], ops);
    return ops;
}

function walk(prev: unknown, next: unknown, path: string[], ops: PatchOp[]): void {
    if (isPlainObject(prev) && isPlainObject(next)) {
        for (const [key, value] of Object.entries(next)) {
            if (value === undefined) continue;
            const before = prev[key];
            if (before === undefined) ops.push({ op: 'add', path: joinPath([...path, key]), value });
            else walk(before, value, [...path, key], ops);
        }
        for (const [key, value] of Object.entries(prev)) {
            if (value !== undefined && next[key] === undefined) {
                ops.push({ op: 'remove', path: joinPath([...path, key]) });
            }
        }
        return;
    }
    if (next === undefined) {
        if (prev !== undefined) ops.push({ op: 'remove', path: joinPath(path) });
        return;
    }
    if (prev === undefined) ops.push({ op: 'add', path: joinPath(path), value: next });
    else if (!sameValue(prev, next)) ops.push({ op: 'replace', path: joinPath(path), value: next });
}
