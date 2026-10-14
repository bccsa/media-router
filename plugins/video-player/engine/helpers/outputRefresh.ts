import * as fs from 'fs';
import * as path from 'path';
import { listDrmConnectors } from '@media-router/engine';
import { DEFAULT_WESTON_INI, parseWestonOutput } from './westonOutput.js';

// The refresh of the mode an output is driven at: the timing section's device latency is one
// refresh of it (house-clock plan WI-P0-9). Undefined when unknown; the engine then assumes
// 60 Hz and says so in the row.

export interface PreferredTiming {
    width: number;
    height: number;
    refreshHz: number;
}

/** A refresh to 0.01 Hz, or undefined outside 1–1000 Hz (junk, or a descriptor misread). */
function sane(hz: number): number | undefined {
    return Number.isFinite(hz) && hz >= 1 && hz <= 1000 ? Math.round(hz * 100) / 100 : undefined;
}

/** Refresh of a weston `mode=` that names one: `WxH@rr`, or a full modeline
 *  (`<MHz> <hdisp> <hss> <hse> <htotal> <vdisp> <vss> <vse> <vtotal> …`). */
export function modeRefreshHz(mode: string): number | undefined {
    const named = /^\d+x\d+@([\d.]+)$/.exec(mode.trim());
    if (named) return sane(Number(named[1]));
    const line = /^([\d.]+)\s+(?:\d+\s+){3}(\d+)\s+(?:\d+\s+){3}(\d+)\b/.exec(mode.trim());
    return line ? sane((Number(line[1]) * 1e6) / (Number(line[2]) * Number(line[3]))) : undefined;
}

const EDID_HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

/** The EDID's first detailed timing (bytes 54–71): the mode the kernel flags preferred.
 *  An interlaced timing gives its field rate. */
export function edidPreferredTiming(edid: Uint8Array): PreferredTiming | undefined {
    if (edid.length < 128 || EDID_HEADER.some((b, i) => edid[i] !== b)) return undefined;
    const d = edid.subarray(54, 72);
    const clockHz = (d[0] | (d[1] << 8)) * 10_000;
    if (clockHz === 0) return undefined; // a display descriptor, not a timing
    const width = d[2] | ((d[4] & 0xf0) << 4);
    const hBlank = d[3] | ((d[4] & 0x0f) << 8);
    const lines = d[5] | ((d[7] & 0xf0) << 4);
    const vBlank = d[6] | ((d[7] & 0x0f) << 8);
    const refreshHz = sane(clockHz / ((width + hBlank) * (lines + vBlank)));
    if (refreshHz === undefined) return undefined;
    return { width, height: d[17] & 0x80 ? lines * 2 : lines, refreshHz };
}

function readPreferredTiming(connector: string, drmDir?: string): PreferredTiming | undefined {
    const sysfs = listDrmConnectors(drmDir).find((c) => c.name === connector)?.meta?.sysfsPath;
    try {
        return sysfs
            ? edidPreferredTiming(fs.readFileSync(path.join(String(sysfs), 'edid')))
            : undefined;
    } catch {
        return undefined; // no EDID: a DSI panel, or nothing plugged in
    }
}

/** Refresh of the mode `connector` is driven at: through the compositor, weston.ini's `mode=`
 *  (a rate, a modeline, or the preferred mode); without one, the connector's preferred mode.
 *  A bare `WxH` is known only at the preferred size, the mode weston then picks first. */
export function resolveOutputRefreshHz(
    connector: string,
    waylandFullscreen: boolean,
    opts: { iniPath?: string; drmDir?: string } = {},
): number | undefined {
    if (!connector) return undefined;
    const preferred = readPreferredTiming(connector, opts.drmDir);
    if (!waylandFullscreen) return preferred?.refreshHz;
    let mode = '';
    try {
        const ini = fs.readFileSync(opts.iniPath ?? DEFAULT_WESTON_INI, 'utf-8');
        mode = parseWestonOutput(ini, connector).mode?.trim() ?? '';
    } catch {
        /* no weston.ini: weston drives the preferred mode */
    }
    if (!mode || mode === 'preferred') return preferred?.refreshHz;
    const named = modeRefreshHz(mode);
    if (named !== undefined) return named;
    const size = /^(\d+)x(\d+)$/.exec(mode);
    const fits =
        !!size && Number(size[1]) === preferred?.width && Number(size[2]) === preferred.height;
    return fits ? preferred?.refreshHz : undefined;
}
