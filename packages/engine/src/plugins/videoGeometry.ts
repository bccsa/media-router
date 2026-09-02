/**
 * Parse a `"<width>x<height>"` resolution string as used by every video
 * module's `resolution` config field. Anything unparsable defaults to
 * 1920x1080 — the field's own manifest default — rather than throwing, so a
 * hand-edited profile degrades to a working pipeline instead of no pipeline.
 */
export function parseResolution(resolution: string): { width: number; height: number } {
    const m = /^(\d+)x(\d+)$/.exec(resolution);
    if (!m) return { width: 1920, height: 1080 };
    return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}
