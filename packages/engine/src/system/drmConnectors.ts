import * as fs from 'fs';
import * as path from 'path';
import type { Device } from '@media-router/shared-types';

const DRM_DIR = '/sys/class/drm';

/**
 * Enumerate DRM connectors by walking `/sys/class/drm`.
 *
 * `/sys/class/drm/card0-HDMI-A-1/status` → "connected" / "disconnected".
 * On embedded Linux the set rarely changes at runtime so this is called on
 * demand rather than polled — the provider registers with `pollMs: 2000` to
 * keep hotplug detection responsive when a cable is actually plugged in.
 *
 * `meta.connectorId` is the kernel's numeric DRM connector id (read from
 * `<dir>/connector_id`). GStreamer's `kmssink` needs the numeric id rather
 * than the connector name — older builds (e.g. Yocto-shipped GStreamer
 * 1.22) don't expose a `connector-name` property at all, so we resolve to
 * the id here.
 */
export function listDrmConnectors(dir: string = DRM_DIR): Device[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const results: Device[] = [];
    for (const entry of entries) {
        // `card0` is the device itself, `card0-HDMI-A-1` is a connector child.
        if (!/^card\d+-/.test(entry)) continue;
        const connectorName = entry.replace(/^card\d+-/, '');
        const sysfsPath = path.join(dir, entry);
        let status = 'unknown';
        try {
            status = fs.readFileSync(path.join(sysfsPath, 'status'), 'utf-8').trim();
        } catch {
            /* connector without a status file — skip reading, keep listed */
        }
        let connectorId: number | undefined;
        try {
            const raw = fs.readFileSync(path.join(sysfsPath, 'connector_id'), 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            if (Number.isFinite(parsed)) connectorId = parsed;
        } catch {
            /* older kernels may not expose connector_id — leave undefined */
        }
        results.push({
            name: connectorName,
            label: `${connectorName} (${status})`,
            meta: { status, sysfsPath, connectorId },
        });
    }
    return results;
}

export interface ActiveDisplayChoice {
    /** Connector name to actually render on (may differ from the requested one). */
    name: string;
    /** Numeric DRM connector id for `name`, when sysfs exposes it. */
    connectorId: number | undefined;
    /**
     * True when `name !== preferred` because the preferred connector wasn't
     * `connected`. Callers should surface this to the user — they asked for
     * one display and we're rendering on another.
     */
    substituted: boolean;
}

/**
 * DRM connector types that aren't user-facing displays and so must not be
 * picked as a substitute when the user's preferred output is disconnected.
 * `Writeback-*` is the common offender: it's the kernel's virtual capture
 * sink for compositor screencast / screen-record, and sysfs reports it as
 * `connected` whenever the writeback subsystem is wired up — sending video
 * there is invisible to the operator. Add others here as they surface.
 */
const NON_DISPLAY_CONNECTOR_RE = /^Writeback-/;

/**
 * Pick the DRM connector to render on given the user's preferred selection.
 *
 * - Empty `preferred` → returns an empty choice (caller keeps its existing
 *   "no display configured" behaviour: kmssink auto-picks, waylandsink lets
 *   the compositor decide).
 * - Preferred connector is `connected` → use it (honoured even if it's a
 *   non-display type like Writeback — the user asked for it explicitly).
 * - Preferred connector isn't connected but another *physical-output*
 *   connector is → return that one with `substituted: true`. Writeback-style
 *   virtual connectors are skipped so substitution lands on something the
 *   operator can actually see.
 * - Nothing connected → return the preferred name as-is so the rest of the
 *   pipeline still has something to target; the caller can warn separately.
 */
export function pickActiveDisplay(
    preferred: string,
    dir: string = DRM_DIR,
): ActiveDisplayChoice {
    if (!preferred) {
        return { name: '', connectorId: undefined, substituted: false };
    }
    const all = listDrmConnectors(dir);
    const requested = all.find((c) => c.name === preferred);
    if ((requested?.meta?.status as string | undefined) === 'connected') {
        return {
            name: preferred,
            connectorId: requested?.meta?.connectorId as number | undefined,
            substituted: false,
        };
    }
    const alt = all.find(
        (c) =>
            (c.meta?.status as string | undefined) === 'connected' &&
            !NON_DISPLAY_CONNECTOR_RE.test(c.name),
    );
    if (alt) {
        return {
            name: alt.name,
            connectorId: alt.meta?.connectorId as number | undefined,
            substituted: true,
        };
    }
    return {
        name: preferred,
        connectorId: requested?.meta?.connectorId as number | undefined,
        substituted: false,
    };
}

export interface ConnectorMode {
    width: number;
    height: number;
}

/**
 * Name of the first `connected` connector that is a real physical output, or
 * `undefined` when nothing is lit.
 *
 * For callers that need *an* output when the user hasn't picked one —
 * `pickActiveDisplay('')` deliberately returns an empty name so sink selection
 * keeps its "let the compositor decide" behaviour, which leaves surface sizing
 * with nothing to measure.
 *
 * Skips `Writeback-*` via the same filter `pickActiveDisplay` uses: the kernel
 * reports it `connected` whenever the writeback subsystem is wired up, and it
 * advertises a huge preferred mode (4096x2160 on a Pi 4), so picking it would
 * size the surface to a 4K buffer nobody can see.
 */
export function firstConnectedDisplay(dir: string = DRM_DIR): string | undefined {
    return listDrmConnectors(dir).find(
        (c) =>
            (c.meta?.status as string | undefined) === 'connected' &&
            !NON_DISPLAY_CONNECTOR_RE.test(c.name),
    )?.name;
}

/**
 * Look up a connector's preferred mode (e.g. `1920x1080`) from
 * `/sys/class/drm/card<N>-<name>/modes`. The kernel lists modes best-first,
 * so line 1 is the preferred one — the same mode weston reports as
 * `preferred, current`.
 *
 * Callers use this to size the rendered surface to the actual panel instead
 * of a hard-coded constant: rendering 720p to a 1080p output made the
 * compositor upscale it straight back, costing a software downscale and half
 * the vertical resolution for nothing.
 *
 * Returns `undefined` when the connector is absent, has no modes (nothing
 * plugged in), or the first line isn't parseable — callers fall back to their
 * own default. Interlaced modes are reported as e.g. `1920x1080i`; the
 * trailing flag is ignored since only the pixel dimensions matter here.
 */
export function resolveConnectorMode(
    connectorName: string,
    dir: string = DRM_DIR,
): ConnectorMode | undefined {
    if (!connectorName) return undefined;
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    for (const entry of entries) {
        if (!/^card\d+-/.test(entry)) continue;
        if (entry.replace(/^card\d+-/, '') !== connectorName) continue;
        try {
            const raw = fs.readFileSync(path.join(dir, entry, 'modes'), 'utf-8');
            const first = raw.split('\n')[0]?.trim() ?? '';
            const m = /^(\d+)x(\d+)/.exec(first);
            if (!m) return undefined;
            const width = parseInt(m[1], 10);
            const height = parseInt(m[2], 10);
            if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
            if (width <= 0 || height <= 0) return undefined;
            return { width, height };
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Look up the numeric DRM connector id for a given connector name
 * (e.g. `"HDMI-A-1"`). Returns `undefined` when the name isn't found or
 * the kernel doesn't expose `connector_id` for that entry.
 *
 * Stand-alone helper rather than a `listDrmConnectors` re-walk so callers
 * resolving a single name don't pay the directory-listing cost twice.
 */
export function resolveConnectorId(
    connectorName: string,
    dir: string = DRM_DIR,
): number | undefined {
    if (!connectorName) return undefined;
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    for (const entry of entries) {
        if (!/^card\d+-/.test(entry)) continue;
        if (entry.replace(/^card\d+-/, '') !== connectorName) continue;
        try {
            const raw = fs.readFileSync(path.join(dir, entry, 'connector_id'), 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            return Number.isFinite(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}
