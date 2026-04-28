import * as fs from 'fs';
import * as path from 'path';
import type { Device } from '@media-router/engine';

const DRM_DIR = '/sys/class/drm';

/**
 * Enumerate DRM connectors by walking `/sys/class/drm`.
 *
 * `/sys/class/drm/card0-HDMI-A-1/status` → "connected" / "disconnected".
 * On embedded Linux the set rarely changes at runtime so this is called on
 * demand rather than polled — the provider registers with `pollMs: 2000` to
 * keep hotplug detection responsive when a cable is actually plugged in.
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
        const statusPath = path.join(dir, entry, 'status');
        let status = 'unknown';
        try {
            status = fs.readFileSync(statusPath, 'utf-8').trim();
        } catch {
            /* connector without a status file — skip reading, keep listed */
        }
        results.push({
            name: connectorName,
            label: `${connectorName} (${status})`,
            meta: { status, sysfsPath: path.join(dir, entry) },
        });
    }
    return results;
}
