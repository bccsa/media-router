import * as fs from 'fs';
import * as path from 'path';

/**
 * Helpers for working with Weston / labwc and the kiosk-shell cog browser.
 *
 * Each function is "pure" in the sense that it only reads from the file
 * system or process env — no module-instance state — so the production
 * caller in `VideoPlayerModule` can call them ad hoc and the unit tests
 * can drive them against tmp-dir fixtures.
 */

/**
 * How often to poll /proc for the kiosk-browser PID. 1s is fast enough that
 * the gap between cog respawning and the video reappearing on top is barely
 * noticeable; the /proc walk is cheap (a few hundred small reads) so this
 * doesn't show up in CPU profiles.
 */
export const COG_POLL_INTERVAL_MS = 1000;

/**
 * Wall-clock start time of a process, from its /proc entry's mtime (set at
 * process creation). Used to order surface creation: a cog whose process
 * started after our pipeline did will map its surface above ours under
 * kiosk-shell's newest-on-top stacking. Returns undefined when the process
 * is gone (raced an exit).
 */
export function processStartMs(pid: number, procRoot: string = '/proc'): number | undefined {
    try {
        return fs.statSync(path.join(procRoot, String(pid))).mtimeMs;
    } catch {
        return undefined;
    }
}

/**
 * Scan /proc for a `cog` process pinned to the given DRM connector via
 * `--gapplication-app-id=local.cog.<display>`. Returns the PID of the
 * matching top-level cog process, or `undefined` if none is currently
 * running on that output.
 *
 * cog spawns helper subprocesses (`WPENetworkProcess`, `WPEWebProcess`)
 * that don't carry the `--gapplication-app-id` arg — those are naturally
 * filtered out by the cmdline match. We only care about the top-level
 * surface owner, whose restart is what re-stacks the output.
 */
export function findCogPidForDisplay(
    display: string,
    procRoot: string = '/proc',
): number | undefined {
    if (!display) return undefined;
    const needle = `--gapplication-app-id=local.cog.${display}`;
    let entries: string[];
    try {
        entries = fs.readdirSync(procRoot);
    } catch {
        return undefined;
    }
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const cmdline = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf-8');
            if (cmdline.includes(needle)) {
                return parseInt(entry, 10);
            }
        } catch {
            /* process exited between readdir and read — skip */
        }
    }
    return undefined;
}

/**
 * Identity string for the wayland session that's currently reachable from
 * this runtime dir: `<socket-filename>:<inode>`. Empty string when no socket
 * is present. Inode is in the identity because Weston restarts often reuse
 * the same `wayland-1` filename — only the inode changes, and that's the
 * signal that the underlying compositor process is different.
 */
export function currentWaylandSessionIdent(runtimeDir: string): string {
    try {
        const sock = fs
            .readdirSync(runtimeDir)
            .find((entry) => /^wayland-\d+$/.test(entry));
        if (!sock) return '';
        const st = fs.statSync(path.join(runtimeDir, sock));
        return `${sock}:${st.ino}`;
    } catch {
        return '';
    }
}

/**
 * Probe the user runtime dir for a Wayland socket. We can't rely on
 * `WAYLAND_DISPLAY` being set when the engine is launched outside a desktop
 * session (systemd-user, SSH-spawned dev runs); the socket file existing is
 * the source of truth. `ensureWaylandEnv` populates the env before we get
 * here, so by build-pipeline time both signals agree.
 */
export function hasWaylandSession(): boolean {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return false;
    try {
        return fs
            .readdirSync(runtime)
            .some((entry) => /^wayland-\d+$/.test(entry));
    } catch {
        return false;
    }
}

/**
 * Poll until a Wayland socket appears in the user runtime dir, or `timeoutMs`
 * elapses. Re-runs `ensureWaylandEnv` between polls so `XDG_RUNTIME_DIR` /
 * `WAYLAND_DISPLAY` get set as soon as the compositor is ready. Returns
 * `true` if Wayland became available, `false` if the timeout was hit.
 */
export async function waitForWaylandSocket(timeoutMs: number, intervalMs = 250): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        ensureWaylandEnv();
        if (hasWaylandSession()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}

/**
 * Best-effort: if a Wayland socket is present in the user runtime dir but
 * `WAYLAND_DISPLAY` isn't exported (e.g. systemd-user launch with no inherited
 * session env), set it on the parent process so child gst-runner inherits.
 * Also seeds `XDG_RUNTIME_DIR` if missing — we use `/run/user/<uid>` which
 * exists for any logged-in user.
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
        const socket = fs
            .readdirSync(runtime)
            .find((entry) => /^wayland-\d+$/.test(entry));
        if (socket) {
            process.env.WAYLAND_DISPLAY = path.basename(socket);
        }
    } catch {
        /* runtime dir unreadable */
    }
}
