import type { PatchOp } from '../index.js';
import { splitPath } from './paths.js';
import { isContainer } from './object.js';

type Container = Record<string, unknown> | unknown[];


/** Index of an array element addressed by `id`, else by numeric index; -1 if absent. */
function elementIndex(arr: unknown[], key: string): number {
    const byId = arr.findIndex((item) => isContainer(item) && (item as { id?: unknown }).id === key);
    if (byId >= 0) return byId;
    return /^\d+$/.test(key) && Number(key) < arr.length ? Number(key) : -1;
}

function child(node: Container, key: string): unknown {
    if (Array.isArray(node)) {
        const i = elementIndex(node, key);
        return i >= 0 ? node[i] : undefined;
    }
    return node[key];
}

/** The value at `segments` below `root`; array elements by id, then index. */
export function getAt(root: unknown, segments: readonly string[]): unknown {
    let node: unknown = root;
    for (const key of segments) {
        if (!isContainer(node)) return undefined;
        node = child(node, key);
    }
    return node;
}

/** Child keys of a node: object keys, or array element ids (index when none). */
export function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item, i) => {
            const id = isContainer(item) ? (item as { id?: unknown }).id : undefined;
            return typeof id === 'string' ? id : String(i);
        });
    }
    return isContainer(value) ? Object.keys(value) : [];
}

/**
 * Apply one tree op in place. `add` creates missing parents; `replace` and
 * `remove` on a missing parent are dropped. Appending (`-`) an element whose
 * `id` is already present replaces it, so an echoed add never duplicates.
 * Returns false when the op did not apply.
 */
export function applyTreeOp(root: Container, op: PatchOp): boolean {
    const segments = splitPath(op.path);
    const last = segments.pop();
    if (last === undefined) return false;
    let node: Container = root;
    for (let i = 0; i < segments.length; i++) {
        const next = child(node, segments[i]);
        if (isContainer(next)) {
            node = next;
            continue;
        }
        if (op.op !== 'add' || Array.isArray(node)) return false;
        const nextKey = i + 1 < segments.length ? segments[i + 1] : last;
        const created: Container = nextKey === '-' ? [] : {};
        node[segments[i]] = created;
        node = created;
    }
    if (Array.isArray(node)) return applyToArray(node, last, op);
    if (op.op === 'remove') {
        if (!(last in node)) return false;
        delete node[last];
        return true;
    }
    node[last] = op.value;
    return true;
}

function applyToArray(arr: unknown[], key: string, op: PatchOp): boolean {
    if (key === '-') {
        if (op.op === 'remove') return false;
        const id = isContainer(op.value) ? (op.value as { id?: unknown }).id : undefined;
        const existing = typeof id === 'string' ? elementIndex(arr, id) : -1;
        if (existing >= 0) arr[existing] = op.value;
        else arr.push(op.value);
        return true;
    }
    const i = elementIndex(arr, key);
    if (i < 0) return false;
    if (op.op === 'remove') arr.splice(i, 1);
    else arr[i] = op.value;
    return true;
}
