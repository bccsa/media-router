import type { SurfaceSize } from './pipelines.js';

/**
 * Operator-facing "how does the picture land on the screen" fields for the
 * module's `display` status section: the screen mode, the video's coded size,
 * and how the renderer fits one into the other.
 *
 * Both render paths scale the video to fit the screen and keep its aspect
 * ratio, centred: kiosk-shell does it for the fullscreen waylandsink surface
 * (see westonOutput.ts), and kmssink does it with `can-scale` (its default).
 * So a 16:9 picture on a 4:3 mode shows black bars top and bottom — the case
 * that sends an operator looking at the TV's settings when the real cause is a
 * screen running on the kernel's no-EDID fallback mode.
 *
 * Square pixels are assumed: the TS probe reports coded width and height but
 * not the sample aspect ratio, so anamorphic SD (720x576 at 16:9) is described
 * by its coded shape.
 */

/** Ratios worth naming; anything else prints as `1.85:1`. */
const NAMED_RATIOS: Array<[string, number]> = [
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['16:10', 16 / 10],
    ['5:4', 5 / 4],
    ['3:2', 3 / 2],
    ['21:9', 64 / 27],
];

/** Within 1 %: 1366x768 is 16:9 to an operator, not 1.78:1. */
function sameRatio(a: number, b: number): boolean {
    return Math.abs(a / b - 1) < 0.01;
}

export function aspectLabel(size: SurfaceSize): string {
    const r = size.width / size.height;
    for (const [label, value] of NAMED_RATIOS) {
        if (sameRatio(r, value)) return label;
        // Portrait panels (a rotated DSI display) read as 9:16, not 0.56:1.
        if (sameRatio(r, 1 / value)) return label.split(':').reverse().join(':');
    }
    return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

function sizeLabel(size: SurfaceSize): string {
    return `${size.width}x${size.height} (${aspectLabel(size)})`;
}

/** How a `video`-sized picture fits a `screen`-sized output, in words. */
export function describeFit(screen: SurfaceSize, video: SurfaceSize): string {
    if (screen.width === video.width && screen.height === video.height) return 'none (1:1)';
    const screenRatio = screen.width / screen.height;
    const videoRatio = video.width / video.height;
    if (sameRatio(screenRatio, videoRatio)) {
        const dir = video.width > screen.width ? 'down' : 'up';
        return `scaled ${dir} to fill the screen`;
    }
    if (videoRatio > screenRatio) {
        const h = Math.round((screen.width * video.height) / video.width);
        return `scaled to fit ${screen.width}x${h}, black bars top and bottom`;
    }
    const w = Math.round((screen.height * video.width) / video.height);
    return `scaled to fit ${w}x${screen.height}, black bars left and right`;
}

/**
 * `mode` / `video` / `fit` status fields. A field is left out when its input is
 * unknown (no screen mode readable, no SPS seen yet, fallback card showing), so
 * the status panel hides the row instead of printing a placeholder.
 *
 * `hasEdid === false` is called out on the mode: it is the actionable fact
 * (check the cable), the 4:3 fallback mode is only its symptom.
 */
export function describeDisplayFit(
    screen: SurfaceSize | undefined,
    video: SurfaceSize | undefined,
    hasEdid: boolean | undefined,
): Record<string, string> {
    const fields: Record<string, string> = {};
    if (screen) {
        fields.mode = sizeLabel(screen);
        if (hasEdid === false)
            fields.mode += ' — no EDID from the screen (fallback mode); check the HDMI cable';
    } else if (hasEdid === false) {
        fields.mode = 'no EDID from the screen; check the HDMI cable';
    }
    if (video) {
        fields.video = sizeLabel(video);
        if (screen) fields.fit = describeFit(screen, video);
    }
    return fields;
}
