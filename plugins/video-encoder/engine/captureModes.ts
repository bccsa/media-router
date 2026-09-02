/**
 * Capture-mode selection for a probed V4L2 device — pure, no I/O. Split from
 * `videoEncoderPipeline.ts` so the format/resolution ladder and the pipeline
 * string assembly each stay one screen long.
 */

/**
 * Common raw pixel formats reported by V4L2 devices. `videoconvert` handles
 * any of these so we don't need format-specific branches — we just need to
 * tell v4l2src which one to pick at the device side. Order encodes a
 * heuristic: semi-planar (NV12/NV16) is preferred over planar (YU12/YV12)
 * which is preferred over packed (YUYV/UYVY). Within each layout class the
 * 4:2:0 variant comes first because it's lower bandwidth than 4:2:2.
 */
const RAW_FORMAT_PREFERENCE = ['NV12', 'NV16', 'YU12', 'YV12', 'YUYV', 'UYVY'];

/** Pixel formats we know how to pin at the source, in the order we want them. */
const FORMAT_PREFERENCE = ['MJPG', ...RAW_FORMAT_PREFERENCE];

/** One `{pixel format, resolution}` entry as reported by `v4l2-ctl --list-formats-ext`. */
export interface CaptureMode {
    pixelFormat: string;
    width: number;
    height: number;
    framerates: number[];
}

/**
 * Choose which probed capture mode to pin at v4l2src for a requested
 * {width × height}, or `undefined` when the device offers nothing we can
 * name (no modes at all, or only pixel formats outside FORMAT_PREFERENCE —
 * caller then falls back to bare negotiation).
 *
 * Two rungs:
 *  1. An exact {width × height} match, MJPG first then RAW_FORMAT_PREFERENCE.
 *     This is the original behaviour and stays byte-for-byte identical.
 *  2. Nothing at that resolution → widen to every probed mode, same format
 *     preference. Within the chosen pixel format take the SMALLEST mode whose
 *     both dimensions are ≥ the request (downscaling in `videoscale` is
 *     cheaper and cleaner than upscaling), and only when everything on offer
 *     is smaller do we take the largest and let the tail upscale.
 *
 * The format preference is applied across the whole mode list before
 * resolution is considered: a device that has MJPG anywhere stays on MJPG
 * rather than dropping to raw at a nearer resolution, because raw at HD
 * resolutions is usually bandwidth-capped to a few fps over USB.
 */
export function pickCaptureMode(
    modes: CaptureMode[],
    width: number,
    height: number,
): CaptureMode | undefined {
    const byPreference = (candidates: CaptureMode[]): CaptureMode[] | undefined => {
        for (const format of FORMAT_PREFERENCE) {
            const matching = candidates.filter((m) => m.pixelFormat === format);
            if (matching.length > 0) return matching;
        }
        return undefined;
    };
    // Rung 1 — exact resolution.
    const exact = byPreference(modes.filter((m) => m.width === width && m.height === height));
    if (exact) return exact[0];
    // Rung 2 — closest resolution within the preferred format.
    const candidates = byPreference(modes);
    if (!candidates) return undefined;
    const area = (m: CaptureMode) => m.width * m.height;
    const atLeast = candidates.filter((m) => m.width >= width && m.height >= height);
    if (atLeast.length > 0) {
        return atLeast.reduce((best, m) => (area(m) < area(best) ? m : best));
    }
    return candidates.reduce((best, m) => (area(m) > area(best) ? m : best));
}
