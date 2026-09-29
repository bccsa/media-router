import { coerceArray, joinPath, type PatchOp } from '@media-router/shared-types';

type Obj = Record<string, unknown>;

/** Top-level keys that are the routing graph; everything else is plain data. */
export const GRAPH_KEYS = ['modules', 'connections', 'interlocks'];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const EDGE = ['sourceModuleId', 'sourcePortId', 'sinkModuleId', 'sinkPortId'];

/** Set-or-drop op for one key of an object that exists on both sides. */
function keyOp(path: string, had: boolean, value: unknown): PatchOp {
    if (value === undefined) return { op: 'remove', path };
    return { op: had ? 'replace' : 'add', path, value };
}

function moduleOps(id: string, prev: Obj, next: Obj): PatchOp[] {
    const ops: PatchOp[] = [];
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (key === 'settings' && prev.settings && next.settings) continue;
        if (!same(prev[key], next[key])) ops.push(keyOp(joinPath(['modules', id, key]), key in prev, next[key]));
    }
    const a = prev.settings as Obj | undefined;
    const b = next.settings as Obj | undefined;
    if (!a || !b) return ops;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!same(a[key], b[key])) ops.push(keyOp(joinPath(['modules', id, 'settings', key]), key in a, b[key]));
    }
    return ops;
}

/**
 * Ops that turn the running config `from` into `to`, shaped for the engine's
 * patch router so each has its live effect (ADR-0025): modules added or
 * removed whole, settings per key, other module fields whole; connections
 * by id (a re-pointed edge is removed and re-added), channel maps in place;
 * interlocks whole. Removes come first.
 */
export function diffConfig(from: Obj, to: Obj): PatchOp[] {
    const ops: PatchOp[] = [];
    const conns = (c: Obj) => new Map(coerceArray<Obj>(c.connections).map((e) => [e.id as string, e]));
    const ca = conns(from);
    const cb = conns(to);
    const sameEdge = (x: Obj, y: Obj) => EDGE.every((k) => x[k] === y[k]);
    for (const [id, e] of ca) {
        const n = cb.get(id);
        if (!n || !sameEdge(e, n)) ops.push({ op: 'remove', path: joinPath(['connections', id]) });
    }

    const ma = (from.modules ?? {}) as Record<string, Obj>;
    const mb = (to.modules ?? {}) as Record<string, Obj>;
    for (const id of Object.keys(ma)) if (!(id in mb)) ops.push({ op: 'remove', path: joinPath(['modules', id]) });
    for (const [id, mod] of Object.entries(mb)) {
        if (!ma[id]) ops.push({ op: 'add', path: joinPath(['modules', id]), value: mod });
        else ops.push(...moduleOps(id, ma[id], mod));
    }

    for (const [id, n] of cb) {
        const e = ca.get(id);
        if (!e || !sameEdge(e, n)) {
            ops.push({ op: 'add', path: '/connections/-', value: n });
        } else if (!same(e.channelMap, n.channelMap)) {
            ops.push({ op: 'replace', path: joinPath(['connections', id, 'channelMap']), value: n.channelMap ?? null });
        } else if (!same(e, n)) {
            ops.push({ op: 'replace', path: joinPath(['connections', id]), value: n });
        }
    }

    if (!same(from.interlocks ?? [], to.interlocks ?? [])) {
        ops.push({ op: from.interlocks ? 'replace' : 'add', path: '/interlocks', value: to.interlocks ?? [] });
    }
    return ops;
}
