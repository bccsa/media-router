/** A non-null, non-array object. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** An object or an array — something a tree path can descend into. */
export function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
    return v !== null && typeof v === 'object';
}

/** Delete keys whose value is `undefined`, in place; returns the object. */
export function dropUndefined<T extends object>(o: T): T {
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    return o;
}

/** Log lines a server keeps per router for new subscribers. */
export const LOG_RING_MAX = 1000;

/** Append to a bounded ring, dropping the oldest entries; in place. */
export function appendRing<T>(ring: T[], batch: readonly T[], max = LOG_RING_MAX): void {
    ring.push(...batch);
    if (ring.length > max) ring.splice(0, ring.length - max);
}
