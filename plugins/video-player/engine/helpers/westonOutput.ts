import * as fs from 'fs';
import { resolveConnectorMode } from '@media-router/engine';
import type { SurfaceSize } from './pipelines.js';

/**
 * Resolve the surface size for an output the way the *compositor* sees it,
 * not the way the kernel does.
 *
 * `resolveConnectorMode` reads the kernel's preferred mode out of sysfs —
 * the panel's PHYSICAL geometry. Weston renders into the LOGICAL canvas that
 * the `[output]` section of `/data/weston.ini` describes, which differs from
 * the physical mode in two ways:
 *
 * 1. `transform=rotate-90|rotate-270` swaps the canvas axes. A DSI panel whose
 *    preferred mode is 720x1280 (portrait) presents a 1280x720 landscape canvas
 *    once rotated. `waylandsink fullscreen=true` asks kiosk-shell to fit our
 *    surface into that canvas, and kiosk-shell fit-scales while preserving
 *    aspect — so a 720x1280 portrait surface lands as a narrow band in the
 *    middle of the landscape canvas with black either side, and the video is
 *    tiny. Observed on a Pi 5 DSI-2 with `transform=rotate-90`, 2026-07-30.
 *    Sizing the surface in logical (post-transform) orientation makes it fill
 *    the canvas exactly.
 * 2. A manual `mode=WxH[@rr]` overrides the kernel preferred mode outright
 *    (device-manager's `DisplayConfig.applyConfig` writes it). The compositor
 *    drives the panel at THAT mode, so it — not sysfs — is the basis for the
 *    surface. Sizing off the preferred mode instead reintroduces the active
 *    software scale that dynamic surface sizing exists to remove. This is
 *    finding F7 of `docs/video-player-display-handover.md`.
 *
 * Only the wayland path may use this: with `kmssink`/`autovideosink` no
 * compositor is running, so weston.ini describes nothing and the raw kernel
 * mode is correct.
 *
 * Its one consumer is the FALLBACK card's size (`surfaceCaps`) — the live path
 * renders at source resolution and lets the compositor scale, so it asks for no
 * size at all (see `buildLivePipeline`).
 */

/** Where device-manager writes the compositor config on target images. */
export const DEFAULT_WESTON_INI = '/data/weston.ini';

export interface WestonOutputConfig {
    /** Raw `mode=` value, e.g. `preferred`, `1920x1080`, `1280x720@60`. */
    mode?: string;
    /** Raw `transform=` value, e.g. `normal`, `rotate-90`, `flipped-rotate-270`. */
    transform?: string;
}

/**
 * Transform values that swap the output's logical axes. Weston accepts both the
 * `rotate-N` spelling and the bare number; `flipped-*` mirrors the canvas but
 * the 90/270 variants still swap width and height. `normal`, `rotate-180` and
 * `flipped`/`flipped-rotate-180` keep the axes as-is.
 */
const SWAPPED_TRANSFORMS = new Set([
    '90',
    '270',
    'rotate-90',
    'rotate-270',
    'flipped-90',
    'flipped-270',
    'flipped-rotate-90',
    'flipped-rotate-270',
]);

/**
 * Minimal INI walk: find the `[output]` section whose `name=` matches
 * `outputName` and return its `mode` / `transform` values. Returns `{}` when
 * there's no such section (or no keys in it).
 *
 * Hand-rolled rather than pulled from a package because weston.ini is a
 * handful of `key=value` lines under bracketed sections and we only care
 * about three keys — an INI dependency would be all cost and no benefit.
 */
export function parseWestonOutput(iniText: string, outputName: string): WestonOutputConfig {
    if (!outputName) return {};
    let inOutput = false;
    let keys: Record<string, string> = {};
    const matched = (): WestonOutputConfig | undefined => {
        if (!inOutput || keys.name !== outputName) return undefined;
        const config: WestonOutputConfig = {};
        if (keys.mode !== undefined) config.mode = keys.mode;
        if (keys.transform !== undefined) config.transform = keys.transform;
        return config;
    };
    for (const raw of iniText.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('[')) {
            // Section boundary: the previous section is complete, so if it was
            // ours we're done — no need to read the rest of the file.
            const found = matched();
            if (found) return found;
            inOutput = /^\[\s*output\s*\]$/i.test(line);
            keys = {};
            continue;
        }
        if (!inOutput) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        if (key === 'name' || key === 'mode' || key === 'transform') {
            keys[key] = line.slice(eq + 1).trim();
        }
    }
    return matched() ?? {};
}

/**
 * Size of an explicit `mode=WxH` / `mode=WxH@rr` value. `preferred`, `current`,
 * `off`, a raw modeline, or junk → `undefined` (caller falls back to sysfs).
 */
function parseModeSize(mode: string | undefined): SurfaceSize | undefined {
    if (!mode) return undefined;
    const m = /^(\d+)x(\d+)(?:@[\d.]+)?$/.exec(mode.trim());
    if (!m) return undefined;
    const width = parseInt(m[1], 10);
    const height = parseInt(m[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    if (width <= 0 || height <= 0) return undefined;
    return { width, height };
}

/** Does this `transform=` value swap the output's logical width and height? */
function swapsAxes(transform: string | undefined): boolean {
    if (!transform) return false;
    return SWAPPED_TRANSFORMS.has(transform.trim().toLowerCase());
}

/**
 * Logical (post-transform) surface size for `connector` as the compositor
 * presents it. `undefined` when the size can't be determined at all — same
 * contract as `resolveConnectorMode`, so callers keep their `?? DEFAULT_SURFACE`.
 *
 * A missing or unreadable weston.ini is not an error: dev boxes and KMS-only
 * hosts don't have one, and we then behave exactly as before (kernel preferred
 * mode, no swap).
 */
export function resolveWestonSurface(
    connector: string,
    iniPath: string = DEFAULT_WESTON_INI,
): SurfaceSize | undefined {
    let output: WestonOutputConfig = {};
    try {
        output = parseWestonOutput(fs.readFileSync(iniPath, 'utf-8'), connector);
    } catch {
        /* no weston.ini (or unreadable) — fall through to the sysfs mode */
    }
    const base = parseModeSize(output.mode) ?? resolveConnectorMode(connector);
    if (!base) return undefined;
    return swapsAxes(output.transform)
        ? { width: base.height, height: base.width }
        : base;
}
