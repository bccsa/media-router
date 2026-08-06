import type { Device } from '@media-router/shared-types';
import { runV4l2Ctl, v4l2CtlBlocked } from './v4l2Ctl.js';

export interface V4l2Format {
    pixelFormat: string;
    width: number;
    height: number;
    framerates: number[];
}

/** Result of the last completed enumeration — served while one is skipped. */
let cachedDevices: Device[] = [];
/** True while an enumeration is running, so the 2 s poll can't stack runs. */
let enumerationPending = false;

/**
 * Enumerate V4L2 capture devices using `v4l2-ctl`.
 *
 * Pi 5 exposes a dozen `/dev/video*` entries for ISP sub-devices and codec
 * nodes that cannot capture raw frames. We detect capture-capable devices by
 * running `v4l2-ctl --device=<path> --all` and checking for the `Video
 * Capture` capability in its output. Anything missing that flag is filtered
 * out so the UI dropdown only lists real cameras / capture cards.
 *
 * Single-flight: this is polled every 2 s by the device-provider registry, and
 * every `v4l2-ctl` it runs can wedge in the kernel (see `v4l2Ctl.ts`). While a
 * run is in progress — or a child from an earlier run has not exited — nothing
 * is spawned and the last known list is returned unchanged.
 */
export async function listV4l2Devices(): Promise<Device[]> {
    if (enumerationPending || v4l2CtlBlocked()) return cachedDevices;
    enumerationPending = true;
    try {
        const devices = await enumerate();
        if (devices) cachedDevices = devices;
        return cachedDevices;
    } finally {
        enumerationPending = false;
    }
}

/**
 * One full enumeration pass. Returns `null` when the guard cut the run short,
 * so the caller keeps its cache rather than publishing a truncated list.
 */
async function enumerate(): Promise<Device[] | null> {
    const listing = await runV4l2Ctl(['--list-devices'], 5000);
    if (listing.kind === 'blocked') return null;
    if (listing.kind === 'failed') return [];

    const candidates: Array<{ path: string; name: string }> = [];
    let currentName = '';
    for (const line of listing.stdout.split('\n')) {
        if (!line) continue;
        if (!line.startsWith('\t') && !line.startsWith(' ')) {
            currentName = line
                .replace(/\s*\(.*\):\s*$/, '')
                .replace(/:$/, '')
                .trim();
            continue;
        }
        const path = line.trim();
        if (path.startsWith('/dev/video') && currentName) {
            candidates.push({ path, name: currentName });
        }
    }

    const results: Device[] = [];
    for (const cand of candidates) {
        const hasCapture = await deviceSupportsCapture(cand.path);
        if (hasCapture === null) return null;
        if (!hasCapture) continue;
        const formats = await listFormats(cand.path);
        if (formats === null) return null;
        results.push({
            name: cand.path,
            label: `${cand.name} (${cand.path})`,
            meta: { path: cand.path, model: cand.name, formats },
        });
    }
    return results;
}

/** Pi 5 platform helpers that advertise `Video Capture` but aren't cameras. */
const PLATFORM_DRIVER_BLACKLIST = new Set([
    'pispbe',
    'bcm2835-isp',
    'bcm2835-codec-decode',
    'bcm2835-codec',
    'rpivid',
]);

/** `null` when the probe was skipped by the guard. */
async function deviceSupportsCapture(path: string): Promise<boolean | null> {
    const res = await runV4l2Ctl(['--device', path, '--all'], 3000);
    if (res.kind === 'blocked') return null;
    if (res.kind === 'failed') return false;
    const driverMatch = res.stdout.match(/Driver name\s*:\s*(\S+)/);
    if (driverMatch && PLATFORM_DRIVER_BLACKLIST.has(driverMatch[1])) return false;
    // `Device Caps      : 0x...` is followed by capability names on
    // indented next lines. Grab the block up to the next top-level
    // section and check for `Video Capture`.
    const block = res.stdout.match(/Device Caps\s*:[\s\S]*?(?=\n\S)/);
    return !!block && /\bVideo Capture\b/.test(block[0]);
}

/** `null` when the probe was skipped by the guard. */
async function listFormats(path: string): Promise<V4l2Format[] | null> {
    const res = await runV4l2Ctl(['--device', path, '--list-formats-ext'], 3000);
    if (res.kind === 'blocked') return null;
    if (res.kind === 'failed') return [];
    return parseFormats(res.stdout);
}

/** Exported for tests. */
export function parseFormats(output: string): V4l2Format[] {
    const result: V4l2Format[] = [];
    let currentFormat = '';
    let currentSize: { width: number; height: number } | null = null;
    let currentFramerates: number[] = [];

    const flushSize = () => {
        if (currentFormat && currentSize) {
            result.push({
                pixelFormat: currentFormat,
                width: currentSize.width,
                height: currentSize.height,
                framerates: currentFramerates,
            });
        }
        currentSize = null;
        currentFramerates = [];
    };

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        // Format header: `[0]: 'YUYV' (YUYV 4:2:2)` or alt `Pixel Format: 'YUYV'`.
        const pixelMatch = line.match(/^(?:\[\d+\]:|Pixel Format:)\s*'([^']+)'/);
        if (pixelMatch) {
            flushSize();
            currentFormat = pixelMatch[1];
            continue;
        }
        const sizeMatch = line.match(/Size:\s*\S+\s+(\d+)x(\d+)/);
        if (sizeMatch) {
            flushSize();
            currentSize = {
                width: parseInt(sizeMatch[1], 10),
                height: parseInt(sizeMatch[2], 10),
            };
            continue;
        }
        const fpsMatch = line.match(/\(([\d.]+)\s*fps\)/);
        if (fpsMatch && currentSize) {
            currentFramerates.push(parseFloat(fpsMatch[1]));
        }
    }
    flushSize();
    return result;
}

/** Test-only: drop the cached device list and the in-flight flag. */
export function _resetV4l2DeviceCacheForTests(): void {
    cachedDevices = [];
    enumerationPending = false;
}
