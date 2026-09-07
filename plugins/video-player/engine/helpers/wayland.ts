import * as fs from 'fs';
import * as path from 'path';
import { ensureWaylandEnv } from '@media-router/engine';

// The env seeding is shared engine infrastructure now (any rendering plugin
// uses it); re-exported so this module's callers keep one import site.
export { ensureWaylandEnv };

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
 * Kernel clock ticks per second (`sysconf(_SC_CLK_TCK)`), the unit of
 * `/proc/<pid>/stat` field 22. 100 on every Linux Node can run on — the value
 * has been fixed in the userspace ABI since 2.6, independent of CONFIG_HZ, and
 * Node exposes no `sysconf` to read it.
 */
const USER_HZ = 100;

/**
 * BOOT-RELATIVE start time of a process (ms since boot), from
 * `/proc/<pid>/stat` field 22 (`starttime`). Used to order surface creation: a
 * cog whose process started after our pipeline did will map its surface above
 * ours under kiosk-shell's newest-on-top stacking. Returns undefined when the
 * process is gone (raced an exit) or the stat line doesn't parse.
 *
 * Boot-relative, NOT wall-clock (the /proc entry's mtime, which this used to
 * read): the Pi has no RTC, so it boots at the epoch the last shutdown left
 * behind and NTP steps the clock — by hours — some seconds into the session.
 * A step landing between the cog spawn and the start of our watch made a cog
 * that spawned *before* us look like it spawned after (or vice versa), and the
 * comparison is only ever consulted at boot, which is exactly when the step
 * happens. `starttime` is counted from boot by a monotonic tick counter, so no
 * clock adjustment can move either side of the comparison. Pair it with
 * `bootNowMs()` — never with `Date.now()`.
 *
 * Field 22 is read by slicing after the LAST `)`: field 2 is `comm`, the
 * executable name in parentheses, and it can itself contain spaces and
 * parentheses. Everything after that closing paren is whitespace-separated, so
 * field 22 is index 19 of the remainder (which starts at field 3).
 */
export function processStartMs(pid: number, procRoot: string = '/proc'): number | undefined {
    try {
        const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf-8');
        const tail = stat
            .slice(stat.lastIndexOf(')') + 1)
            .trim()
            .split(/\s+/);
        const ticks = Number(tail[19]);
        if (!Number.isFinite(ticks)) return undefined;
        return (ticks / USER_HZ) * 1000;
    } catch {
        return undefined;
    }
}

/**
 * "Now" on the same boot-relative timeline as `processStartMs`, from
 * `/proc/uptime` (seconds since boot, first field). The counterpart that makes
 * the cog-restack comparison immune to an NTP step — see `processStartMs`.
 * Falls back to 0 where /proc/uptime isn't readable (dev machines, non-Linux):
 * a zero "now" makes every cog look newer than the watch, which costs at most
 * one extra restack and never hides the video.
 */
export function bootNowMs(): number {
    try {
        return Number(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]) * 1000 || 0;
    } catch {
        return 0;
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
        const sock = fs.readdirSync(runtimeDir).find((entry) => /^wayland-\d+$/.test(entry));
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
        return fs.readdirSync(runtime).some((entry) => /^wayland-\d+$/.test(entry));
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
