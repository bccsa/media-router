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
