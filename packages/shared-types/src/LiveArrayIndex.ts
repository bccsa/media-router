import type { PatchOp } from './index.js';

/**
 * Live membership view of one config array (`/connections`, `/interlocks`)
 * while a batch of patch ops is dispatched.
 *
 * Lives next to `applyJsonPatch` because it is that function's array semantics
 * seen one op ahead: BOTH sides of the patch boundary need it. The manager
 * rewrites `/connections/<id>` to `/connections/<index>` before dispatching a
 * batch, and the engine resolves the reverse (index → connection id) before
 * applying one, so that it still knows which live routing to tear down. Two
 * folds of one semantics is precisely how they would drift apart.
 *
 * An index is only valid at the moment its op is applied: two id-based removes
 * in one batch both resolved against the pre-patch array means the second one
 * deletes whatever slid into the freed slot. Folding each emitted op back in
 * keeps later lookups honest.
 *
 * `track()` mirrors `applyJsonPatch`'s array semantics exactly — same key
 * resolution (numeric index, else `.id` match), same "add at a numeric index
 * assigns, it does not insert" behaviour — so `snapshot()` always matches what
 * the array will look like at that point in the processed op list.
 *
 * Only membership and order are live. Element *contents* stay pre-patch
 * (except where a whole-element `replace` swapped one out), which is what the
 * cascade rules want — they decide on the state as it was when the patch
 * arrived.
 */
export class LiveArrayIndex<T> {
    private items: T[];
    private readonly prefix: string;

    /**
     * @param arrayPath JSON-Pointer to the array, e.g. `/connections`.
     * @param initial   Pre-patch contents. A non-array (corrupt config) is
     *                  treated as empty rather than throwing — the same
     *                  tolerance `applyJsonPatch` shows.
     */
    constructor(
        private readonly arrayPath: string,
        initial: readonly T[],
    ) {
        this.items = Array.isArray(initial) ? [...initial] : [];
        this.prefix = `${arrayPath}/`;
    }

    /** Membership/order as of every op tracked so far. A copy — callers may keep it. */
    snapshot(): T[] {
        return [...this.items];
    }

    /**
     * The element one path segment addresses RIGHT NOW, under the same key
     * rules `applyJsonPatch` uses — for a caller that has to read something off
     * an element before its own op removes it (the engine reads the connection
     * id it will have to tear the routing down for). `undefined` when nothing
     * matches, including for `-`, which addresses no existing element.
     */
    at(key: string): T | undefined {
        const idx = this.resolveKey(key);
        return idx >= 0 ? this.items[idx] : undefined;
    }

    /**
     * Fold an op that is about to be applied into the view, so ops dispatched
     * after it resolve their ids against the shifted array.
     */
    track(op: PatchOp): void {
        // Whole-array write.
        if (op.path === this.arrayPath) {
            if (op.op === 'remove') this.items = [];
            else this.items = Array.isArray(op.value) ? [...(op.value as T[])] : [];
            return;
        }
        if (!op.path.startsWith(this.prefix)) return;

        const key = op.path.slice(this.prefix.length);
        // A deeper path (`/connections/2/channelMap`) edits an element, not the
        // array itself — membership is unchanged.
        if (key.includes('/')) return;

        if (key === '-') {
            // '-' appends; `remove /connections/-` matches nothing (as in applyJsonPatch).
            if (op.op !== 'remove') this.items.push(op.value as T);
            return;
        }

        const idx = this.resolveKey(key);
        if (idx < 0) return;
        if (op.op === 'remove') this.items.splice(idx, 1);
        // `add` at an index assigns rather than inserts — applyJsonPatch treats
        // add and replace identically once the target is an array.
        else this.items[idx] = op.value as T;
    }

    /** Same key resolution as `applyJsonPatch`: numeric index, else `.id` match. */
    private resolveKey(key: string): number {
        const n = parseInt(key, 10);
        if (!isNaN(n)) return n;
        return this.items.findIndex((item) => (item as { id?: unknown } | null)?.id === key);
    }
}
