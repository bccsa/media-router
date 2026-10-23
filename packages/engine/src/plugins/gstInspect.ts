import { execFile } from 'child_process';

/**
 * Bound on one gst-inspect-1.0 run. One that finds the registry missing or stale rescans every
 * plugin and saves the registry only if it finishes: 2-3 s on a busy Pi 4, about 11 s on a
 * quarter of its core (B-102). The old 2 s killed every such run before it saved.
 */
export const GST_INSPECT_TIMEOUT_MS = 30_000;

/**
 * A gst-inspect-1.0 run killed at GST_INSPECT_TIMEOUT_MS. It says nothing about the element, so
 * no probe caches it: the next call runs gst-inspect again (B-102).
 */
export class GstInspectTimeoutError extends Error {
    constructor(args: readonly string[]) {
        const what = args.join(' ');
        super(
            `gst-inspect-1.0 ${what} timed out after ${GST_INSPECT_TIMEOUT_MS / 1000} s, so whether ` +
                `${what} is installed is not known (GStreamer's plugin registry scan hung or ran too slow)`,
        );
        this.name = 'GstInspectTimeoutError';
    }
}

/** A GstInspectTimeoutError, told by its name so it holds across copies of this package. */
export function isGstInspectTimeout(err: unknown): err is GstInspectTimeoutError {
    return err instanceof Error && err.name === 'GstInspectTimeoutError';
}

let firstRun: Promise<unknown> | null = null;

/**
 * One gst-inspect-1.0 run: its stdout on exit 0, null on a failed exit, GstInspectTimeoutError
 * when killed at the bound. The process's first run goes alone: on a cold registry it rescans
 * and saves it, and the rest load it instead of each rescanning at once (B-102).
 */
function gstInspect(args: string[]): Promise<string | null> {
    const run = () =>
        new Promise<string | null>((resolve, reject) => {
            execFile(
                'gst-inspect-1.0',
                args,
                { timeout: GST_INSPECT_TIMEOUT_MS },
                (err, stdout) => {
                    if (!err) resolve(stdout);
                    else if (err.killed) reject(new GstInspectTimeoutError(args));
                    else resolve(null);
                },
            );
        });
    if (firstRun) return firstRun.then(run);
    const first = run();
    firstRun = first.catch(() => undefined);
    return first;
}

/** Memoise a probe per key for the process; one that rejected is dropped, so the next call runs it. */
function memo<T>(cache: Map<string, Promise<T>>, key: string, probe: () => Promise<T>): Promise<T> {
    const cached = cache.get(key);
    if (cached) return cached;
    const promise = probe();
    cache.set(key, promise);
    promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
    });
    return promise;
}

const elementCache = new Map<string, Promise<boolean>>();

/**
 * Is this GStreamer element installed on the system?
 *
 * Cached per process — plugin `initManifest` hooks call this at load time to
 * decide which codec/encoder entries to surface in a dropdown. Running
 * `gst-inspect-1.0` once per element is enough; the result doesn't change
 * while the engine is alive. A run that timed out rejects with
 * GstInspectTimeoutError and is not cached (B-102).
 */
export function probeGstElement(name: string): Promise<boolean> {
    return memo(elementCache, name, async () => (await gstInspect([name])) !== null);
}

const capsCache = new Map<string, Promise<boolean>>();

/**
 * Does an installed element's pad-template caps mention a given media type?
 *
 * Used for capability gates that element EXISTENCE can't answer — e.g.
 * SMPTE-302M needs `mpegtsmux`/`tsdemux` to list `audio/x-smpte-302m` in
 * their caps (gst ≥ 1.26); the elements themselves exist on every version.
 * Cached per (element, caps) for the process lifetime, like probeGstElement.
 */
export function gstElementSupportsCaps(element: string, capsMediaType: string): Promise<boolean> {
    // The key separator is an escaped NUL — a character that can occur in
    // neither a gst element name nor a caps media type, so `a\0b` and `ab\0` can
    // never collide. Escaped, not literal: a raw NUL in the source is invisible
    // in editors, diffs and reviews, and makes `grep` treat the whole file as
    // binary. Same fix as GstChildProcess’s sticky-property keys.
    const key = `${element}\u0000${capsMediaType}`;
    return memo(capsCache, key, async () => {
        const stdout = await gstInspect([element]);
        return stdout !== null && stdout.includes(capsMediaType);
    });
}

let ladspaElementList: Promise<string[]> | null = null;

/**
 * Resolve a LADSPA-wrapped element name by suffix (e.g. `sc-compressor-stereo`).
 *
 * The GStreamer `ladspa` wrapper derives element names from the plugin's .so
 * filename — which for versioned libraries embeds the version (e.g.
 * `ladspa-lsp-plugins-ladspa-1-2-5-so-…-sc-compressor-stereo`) — so plugins
 * must discover the full name at runtime rather than hardcode it. Returns null
 * when the ladspa wrapper or the plugin library is not installed; rejects with
 * GstInspectTimeoutError when the run timed out.
 */
export function findLadspaElement(suffix: string): Promise<string | null> {
    ladspaElementList ??= gstInspect(['ladspa']).then(
        (stdout) => {
            if (stdout === null) {
                // Don't cache a failed probe — the wrapper may be mid-install
                ladspaElementList = null;
                return [];
            }
            const names: string[] = [];
            for (const m of stdout.matchAll(/^\s+(ladspa-[a-z0-9-]+):/gm)) {
                names.push(m[1]);
            }
            return names;
        },
        (err: unknown) => {
            ladspaElementList = null;
            throw err;
        },
    );
    return ladspaElementList.then((names) => names.find((n) => n.endsWith(suffix)) ?? null);
}

/**
 * Parse the max channel count an encoder element accepts, by scanning
 * `channels: [ 1, N ]` ranges in `gst-inspect-1.0 <element>`. Returns `2` when
 * the element is missing or no range is declared; rejects with
 * GstInspectTimeoutError when the run timed out.
 */
export async function gstInspectMaxChannels(element: string): Promise<number> {
    const stdout = await gstInspect([element]);
    if (stdout === null) return 2;
    let min = Infinity;
    for (const m of stdout.matchAll(/channels:\s*\[\s*\d+\s*,\s*(\d+)\s*\]/g)) {
        min = Math.min(min, parseInt(m[1], 10));
    }
    return min === Infinity ? 2 : min;
}
