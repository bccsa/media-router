import type { ChannelMapEntry } from '@media-router/engine';

/**
 * Per-connection channel mapping, rendered as an `audioconvert mix-matrix`.
 *
 * One matrix covers everything pw-links used to do badly or not at all:
 * mono→stereo fan-out, stereo→mono downmix, picking channels out of a
 * multichannel stream, and per-channel gain. Cells are `matrix[dst][src]`;
 * anything the map doesn't mention stays 0 (silent), so a partial map is a
 * deliberate mute, not a fallback to default conversion.
 */
export function mixMatrixClause(
    channelMap: ChannelMapEntry[],
    srcChannels: number,
    dstChannels: number,
): string {
    const m: number[][] = Array.from({ length: dstChannels }, () =>
        new Array<number>(srcChannels).fill(0),
    );
    for (const e of channelMap) {
        const src = Math.trunc(Number(e.srcChannel));
        const dst = Math.trunc(Number(e.dstChannel));
        if (src < 0 || src >= srcChannels || dst < 0 || dst >= dstChannels) continue;
        const gain = Number(e.gain ?? 1);
        m[dst][src] = Number.isFinite(gain) ? gain : 1;
    }
    const rows = m
        .map((row) => `<${row.map((v) => `(float)${v.toFixed(4)}`).join(', ')}>`)
        .join(', ');
    return ` mix-matrix="<${rows}>"`;
}
