import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Device } from '@media-router/engine';

const execFileAsync = promisify(execFile);

/**
 * Enumerate V4L2 capture devices using `v4l2-ctl`.
 *
 * Pi 5 exposes a dozen `/dev/video*` entries for ISP sub-devices and codec
 * nodes that cannot capture raw frames. We detect capture-capable devices by
 * running `v4l2-ctl --device=<path> --all` and checking for the `Video
 * Capture` capability in its output. Anything missing that flag is filtered
 * out so the UI dropdown only lists real cameras / capture cards.
 */
export async function listV4l2Devices(): Promise<Device[]> {
    let rawListing: string;
    try {
        const res = await execFileAsync('v4l2-ctl', ['--list-devices'], { timeout: 5000 });
        rawListing = res.stdout;
    } catch {
        return [];
    }

    const candidates: Array<{ path: string; name: string }> = [];
    let currentName = '';
    for (const line of rawListing.split('\n')) {
        if (!line) continue;
        if (!line.startsWith('\t') && !line.startsWith(' ')) {
            currentName = line.replace(/\s*\(.*\):\s*$/, '').replace(/:$/, '').trim();
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
        if (!hasCapture) continue;
        const formats = await listFormats(cand.path);
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

async function deviceSupportsCapture(path: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('v4l2-ctl', ['--device', path, '--all'], {
            timeout: 3000,
        });
        const driverMatch = stdout.match(/Driver name\s*:\s*(\S+)/);
        if (driverMatch && PLATFORM_DRIVER_BLACKLIST.has(driverMatch[1])) return false;
        // `Device Caps      : 0x...` is followed by capability names on
        // indented next lines. Grab the block up to the next top-level
        // section and check for `Video Capture`.
        const block = stdout.match(/Device Caps\s*:[\s\S]*?(?=\n\S)/);
        return !!block && /\bVideo Capture\b/.test(block[0]);
    } catch {
        return false;
    }
}

async function listFormats(
    path: string,
): Promise<
    Array<{ pixelFormat: string; width: number; height: number; framerates: number[] }>
> {
    try {
        const { stdout } = await execFileAsync(
            'v4l2-ctl',
            ['--device', path, '--list-formats-ext'],
            { timeout: 3000 },
        );
        return parseFormats(stdout);
    } catch {
        return [];
    }
}

/** Exported for tests. */
export function parseFormats(
    output: string,
): Array<{ pixelFormat: string; width: number; height: number; framerates: number[] }> {
    const result: Array<{
        pixelFormat: string;
        width: number;
        height: number;
        framerates: number[];
    }> = [];
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
