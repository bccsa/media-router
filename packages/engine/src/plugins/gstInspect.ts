import { execFile } from 'child_process';

const elementCache = new Map<string, Promise<boolean>>();

/**
 * Is this GStreamer element installed on the system?
 *
 * Cached per process — plugin `initManifest` hooks call this at load time to
 * decide which codec/encoder entries to surface in a dropdown. Running
 * `gst-inspect-1.0` once per element is enough; the result doesn't change
 * while the engine is alive.
 */
export function probeGstElement(name: string): Promise<boolean> {
    const cached = elementCache.get(name);
    if (cached) return cached;
    const promise = new Promise<boolean>((resolve) => {
        execFile('gst-inspect-1.0', [name], { timeout: 2000 }, (err) => {
            resolve(!err);
        });
    });
    elementCache.set(name, promise);
    return promise;
}

/**
 * Parse the max channel count an encoder element accepts, by scanning
 * `channels: [ 1, N ]` ranges in `gst-inspect-1.0 <element>`. Returns `2` when
 * the element is missing or no range is declared.
 */
export function gstInspectMaxChannels(element: string): Promise<number> {
    return new Promise((resolve) => {
        execFile('gst-inspect-1.0', [element], { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(2);
            let min = Infinity;
            for (const m of stdout.matchAll(/channels:\s*\[\s*\d+\s*,\s*(\d+)\s*\]/g)) {
                min = Math.min(min, parseInt(m[1], 10));
            }
            resolve(min === Infinity ? 2 : min);
        });
    });
}
