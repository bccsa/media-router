import * as fs from 'fs';

/**
 * Read the `transform=…` value for a given DRM connector out of weston.ini.
 * Returns `'normal'` when the file is missing, the connector has no entry,
 * or the entry has no transform. Weston's kiosk-shell rotates the output
 * framebuffer by this value — clients (us) have to pre-rotate to compensate
 * if they want their surface to land upright on the physical screen.
 *
 * Default path matches the deployed Yocto layout (`/data/weston.ini`); the
 * helper takes the path as an arg so tests can drive a fixture.
 */
export function getWestonOutputTransform(
    connectorName: string,
    westonIniPath: string = '/data/weston.ini',
): string {
    if (!connectorName) return 'normal';
    let contents: string;
    try {
        contents = fs.readFileSync(westonIniPath, 'utf-8');
    } catch {
        return 'normal';
    }
    let inOutputBlock = false;
    let currentBlockName: string | null = null;
    let currentBlockTransform: string | null = null;
    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#') || line === '') continue;
        const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
        if (sectionMatch) {
            // Flush the previous block: if it matched the connector, return.
            if (inOutputBlock && currentBlockName === connectorName) {
                return currentBlockTransform ?? 'normal';
            }
            inOutputBlock = sectionMatch[1] === 'output';
            currentBlockName = null;
            currentBlockTransform = null;
            continue;
        }
        if (!inOutputBlock) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === 'name') currentBlockName = value;
        else if (key === 'transform') currentBlockTransform = value;
    }
    // Catch the case where the matching block is the last in the file.
    if (inOutputBlock && currentBlockName === connectorName) {
        return currentBlockTransform ?? 'normal';
    }
    return 'normal';
}

/**
 * Map a weston output `transform=…` to the `videoflip` method enum value
 * that compensates for the rotation. The compensation is the *inverse* of
 * the weston transform: if weston rotates the output 90° clockwise, we
 * pre-rotate the buffer 90° counter-clockwise (`counterclockwise`) so the
 * two cancel out and the displayed image is upright. `videoflip` rotates
 * the buffer content AND swaps the WxH caps, which is what we need to
 * also satisfy kiosk-shell's xdg_surface geometry check on rotated
 * outputs.
 *
 * Returns `'identity'` (sentinel) when no rotation is needed so the caller
 * can omit the element entirely on un-rotated outputs — keeps the pipeline
 * string clean and identical to the pre-rotation-support behaviour on
 * normal displays.
 */
export function westonTransformToGstRotate(transform?: string): string {
    // Mapping verified empirically on 10.9.1.166 (HDMI-A-1, transform=rotate-90):
    // counterclockwise yielded a 180°-flipped image, clockwise produced the
    // correctly-oriented video. The rotate-270 mapping is the mirror image
    // by symmetry. If the diagonal-flip cases ever ship in real configs we'll
    // verify those the same way.
    switch (transform) {
        case 'rotate-90': return 'clockwise';
        case 'rotate-180': return 'rotate-180';
        case 'rotate-270': return 'counterclockwise';
        case 'flipped': return 'horizontal-flip';
        case 'flipped-rotate-180': return 'vertical-flip';
        case 'flipped-rotate-90': return 'upper-left-diagonal';
        case 'flipped-rotate-270': return 'upper-right-diagonal';
        default: return 'identity';
    }
}
