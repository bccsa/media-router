/**
 * Pure KLV name-payload parsing + merge for the MPEG-TS demuxer (plan D6,
 * wire format in section 3 of docs/mpegts-dynamic-streams-plan.md).
 *
 * Kept free of GStreamer / engine imports so it's unit-testable with plain
 * inputs. The runner reads the metadata-PID payload off an appsink and emits a
 * `stream_names` event carrying the raw string; the demuxer module merges the
 * names this parses onto its PID-keyed inspector streams.
 *
 * D6 invariant: no state of the KLV channel — absent, malformed, oversized, or
 * stale — may affect routing or pipeline health. So every function here is
 * total: it never throws, returns a (possibly empty) name map, and flags
 * garbage so the caller can emit a *one-shot* warning rather than an exception.
 */

/** Payload parse cap (plan section 3: "a few KB"). Anything larger is dropped
 *  as garbage without parsing — a sane name table is well under this. */
export const KLV_PAYLOAD_MAX_BYTES = 4096;

/** Supported wire-format version. Unknown versions are ignored (forward-compat
 *  rule, plan section 3) — treated as "no names", never an error. */
export const KLV_SUPPORTED_VERSION = 1;

export interface KlvParseResult {
    /** PID → name. Empty when absent, unparseable, or an unknown version. */
    names: Map<number, string>;
    /** True only for *malformed* input the caller should warn about once
     *  (bad JSON, wrong shape, oversized). An unknown but well-formed version
     *  is not "malformed" — it's a clean forward-compat skip, so `false`. */
    malformed: boolean;
}

const EMPTY: () => KlvParseResult = () => ({ names: new Map(), malformed: false });

/**
 * Parse a KLV name payload (already decoded to a string by the caller).
 *
 * Total function — never throws. Returns the PID→name map plus a `malformed`
 * flag for the one-shot warning path. Entries with a non-number pid or a
 * non-string/blank name are skipped individually; unknown extra fields are
 * ignored (forward-compat).
 */
export function parseKlvPayload(raw: string | null | undefined): KlvParseResult {
    if (raw == null) return EMPTY();
    // Size cap on the decoded text — a runaway/oversized buffer is garbage.
    if (raw.length > KLV_PAYLOAD_MAX_BYTES) return { names: new Map(), malformed: true };

    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return { names: new Map(), malformed: true };
    }
    if (typeof obj !== 'object' || obj === null) {
        return { names: new Map(), malformed: true };
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.v !== 'number') return { names: new Map(), malformed: true };
    // Well-formed but a version we don't understand → ignore cleanly, no warn.
    if (rec.v !== KLV_SUPPORTED_VERSION) return EMPTY();
    if (!Array.isArray(rec.streams)) return { names: new Map(), malformed: true };

    const names = new Map<number, string>();
    for (const entry of rec.streams) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.pid !== 'number' || !Number.isFinite(e.pid)) continue;
        if (typeof e.name !== 'string') continue;
        const name = e.name.trim();
        if (!name) continue;
        names.set(e.pid, name);
    }
    return { names, malformed: false };
}

/**
 * Merge freshly-parsed names into a last-known label store (plan: keep
 * last-known labels if metadata disappears). Mutates and returns `store`. Only
 * non-empty maps update it — an empty parse (absence / unknown version) leaves
 * prior labels intact, which is exactly "stale labels survive a metadata gap".
 */
export function mergeKlvNames(
    store: Map<number, string>,
    parsed: Map<number, string>,
): Map<number, string> {
    for (const [pid, name] of parsed) store.set(pid, name);
    return store;
}
