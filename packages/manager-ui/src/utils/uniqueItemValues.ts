/**
 * Per-array uniqueness for schema-driven array items (`x-unique`,
 * `x-reserved`, `x-autoAssign` on an item property — e.g. the muxer's input
 * PID). Scope is ONE array: values are only compared against sibling items.
 */

export interface AutoAssign {
    start: number;
    step: number;
}

/** Lowest `start + k·step` (≤ `max`) not taken and not reserved; undefined when none is left. */
export function nextFreeValue(
    taken: Iterable<unknown>,
    auto: AutoAssign,
    reserved: readonly number[] = [],
    max = Number.MAX_SAFE_INTEGER,
): number | undefined {
    const used = new Set(taken);
    const step = auto.step > 0 ? auto.step : 1;
    for (let v = auto.start; v <= max; v += step) {
        if (!used.has(v) && !reserved.includes(v)) return v;
    }
    return undefined;
}

export interface UniqueRule {
    unique?: boolean;
    reserved?: readonly number[];
}

/** Error text for `value` at item `index`, or undefined when it is allowed. */
export function uniqueValueError(
    label: string,
    value: unknown,
    index: number,
    siblings: readonly unknown[],
    opts: UniqueRule,
): string | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'number' && opts.reserved?.includes(value)) {
        return `${label} ${value} is reserved`;
    }
    if (!opts.unique) return undefined;
    const other = siblings.findIndex((v, i) => i !== index && v === value);
    return other === -1 ? undefined : `${label} ${value} is already used by Item ${other + 1}`;
}

/** An `x-autoAssign` field's bounds, as the item schema declares them. */
export interface AutoAssignField {
    key: string;
    autoAssign: AutoAssign;
    reserved?: readonly number[];
    minimum?: number;
    maximum?: number;
}

/**
 * Items with every unassigned auto field (blank, 0, non-integer or outside
 * [minimum, maximum]) filled with the next free value, in list order after
 * every assigned value is taken — the same order the muxer engine seeds in,
 * so the field shows the value the engine will write.
 */
export function fillAutoAssigned(
    items: Record<string, unknown>[],
    fields: readonly AutoAssignField[],
): Record<string, unknown>[] {
    let out = items;
    for (const f of fields) {
        const valid = (v: unknown): v is number =>
            typeof v === 'number' &&
            Number.isInteger(v) &&
            v >= (f.minimum ?? -Infinity) &&
            v <= (f.maximum ?? Infinity);
        const taken = out.flatMap((it) => (valid(it[f.key]) ? [it[f.key]] : []));
        out = out.map((it) => {
            if (valid(it[f.key])) return it;
            const v = nextFreeValue(taken, f.autoAssign, f.reserved, f.maximum);
            if (v === undefined) return it;
            taken.push(v);
            return { ...it, [f.key]: v };
        });
    }
    return out;
}
