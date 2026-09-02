import * as fs from 'fs';
import * as path from 'path';

/**
 * Best-effort Wayland env seeding for a process that renders to the box's
 * compositor (waylandsink pipelines): a systemd-user engine inherits no
 * session env, so this points the process — and the gst-runner children that
 * inherit its env — at the compositor socket when one exists.
 *
 * Seeds `XDG_RUNTIME_DIR` from `/run/user/<uid>` when missing (it exists for
 * any logged-in user), then `WAYLAND_DISPLAY` from the first `wayland-N`
 * socket in that dir. Never overrides values that are already set. Pure
 * apart from the env writes — safe to call repeatedly (the video-player polls
 * it while waiting for the compositor to come up).
 *
 * Lives in the engine because every plugin that renders needs the identical
 * contract (video-player, mjpeg-monitor); ADR-0002 bars plugin-to-plugin
 * imports and a copy per plugin drifts.
 */
export function ensureWaylandEnv(): void {
    if (!process.env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
        const candidate = `/run/user/${process.getuid()}`;
        try {
            if (fs.statSync(candidate).isDirectory()) {
                process.env.XDG_RUNTIME_DIR = candidate;
            }
        } catch {
            /* /run/user/<uid> not present — nothing to do */
        }
    }
    if (process.env.WAYLAND_DISPLAY) return;
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return;
    try {
        const socket = fs.readdirSync(runtime).find((entry) => /^wayland-\d+$/.test(entry));
        if (socket) {
            process.env.WAYLAND_DISPLAY = path.basename(socket);
        }
    } catch {
        /* runtime dir unreadable */
    }
}
