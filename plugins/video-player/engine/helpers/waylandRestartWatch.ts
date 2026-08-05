import * as fs from 'fs';
import { currentWaylandSessionIdent } from './wayland.js';

/**
 * Process-wide watch for compositor (Weston/labwc) restarts.
 *
 * When Weston/labwc restarts the wayland socket is replaced (new inode,
 * possibly new name). gst-runner children built against the old socket keep
 * "playing" against a dead connection — the pipeline doesn't report an error
 * because waylandsink doesn't observe the broken socket until it tries to draw
 * the next buffer, by which time the compositor restart has reattached our
 * surface to nothing. Watching the runtime dir for socket replacement lets
 * registered pipelines proactively restart against the fresh session.
 *
 * One watcher per engine process, shared by every running video-player
 * instance: the signal is global, and N watchers on one directory would only
 * multiply the debounce work.
 */

/** Called with the new `<filename>:<inode>` when the session actually changed. */
export type WaylandSessionChangeHandler = (ident: string) => void;

/** Registered pipelines, keyed by the module instance that owns each one. */
const targets = new Map<object, WaylandSessionChangeHandler>();
let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
/** `<filename>:<inode>` of the currently-known compositor socket. Empty when none. */
let sessionIdent = '';
/** Pending reinstall attempt after a watcher error — see `planWatcherReinstall`. */
let reinstallTimer: NodeJS.Timeout | null = null;
/** Reinstall attempts spent on the current outage. Reset by a good install. */
let reinstallAttempts = 0;

/**
 * Only the compositor sockets matter. The runtime dir also carries
 * `wayland-1.lock`, `pulse/`, `bus`, systemd's own files and whatever else the
 * session drops there; without this filter every one of them would cost a
 * debounce cycle and a stat of the dir.
 *
 * Deliberately a PREFIX match (`/^wayland-\d+/`, not anchored at the end): the
 * lock file `wayland-1.lock` is written and removed as part of the very restart
 * we're watching for, and on some compositor versions it is the only event that
 * lands before the socket reappears. Extracted from the `fs.watch` callback so
 * the rule is testable without a real watcher.
 */
export function isWaylandSocketEvent(filename: string | Buffer | null | undefined): boolean {
    if (!filename) return false;
    return /^wayland-\d+/.test(String(filename));
}

/** How long to wait before rebuilding a watcher that errored out. */
export const WATCHER_REINSTALL_DELAY_MS = 2000;
/**
 * Reinstall attempts per outage. The runtime dir going away for good (user
 * session ended) must not leave a timer respawning forever; five tries spans
 * ~10 s, which covers a compositor restart that briefly re-creates the dir.
 * A later `registerWaylandRestartTarget` (module restart) starts a fresh
 * budget, so a longer outage still self-heals on the next pipeline start.
 */
export const WATCHER_REINSTALL_MAX_ATTEMPTS = 5;

/**
 * Should a watcher error be followed by a reinstall attempt?
 *
 * fs.watch tears its own watcher down on error (EBADF when the inotify watch
 * is dropped, ENOENT when the runtime dir is recreated by a session restart).
 * Before this, the error handler dropped the watcher and RETURNED — leaving
 * every target registered with nothing watching for them, so a long-lived
 * pipeline silently lost compositor-restart self-heal for the rest of the
 * engine session (nothing calls `register` again until the module restarts,
 * which is precisely the thing the watch exists to trigger).
 *
 * Pure so the decision is testable without a real watcher.
 */
export function planWatcherReinstall(targetCount: number, attempts: number): boolean {
    return targetCount > 0 && attempts < WATCHER_REINSTALL_MAX_ATTEMPTS;
}

/** Registered targets — exposed for status/logging and tests. */
export function waylandRestartTargets(): ReadonlySet<object> {
    return new Set(targets.keys());
}

export function registerWaylandRestartTarget(
    key: object,
    onSessionChange: WaylandSessionChangeHandler,
): void {
    targets.set(key, onSessionChange);
    // A registration is a fresh chance for a dir that was unwatchable earlier
    // (engine started before the compositor) — so the retry budget starts over.
    reinstallAttempts = 0;
    installWaylandWatcher();
}

export function unregisterWaylandRestartTarget(key: object): void {
    targets.delete(key);
    if (targets.size === 0) {
        teardownWaylandWatcher();
    }
}

/**
 * Watch the user runtime dir for wayland socket replacement. We can't use
 * the *socket file itself* as the watch target — when Weston restarts the
 * old inode is unlinked and fs.watch silently goes mute. Watching the
 * containing directory survives that.
 */
function installWaylandWatcher(): void {
    if (watcher) return;
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime) return;
    sessionIdent = currentWaylandSessionIdent(runtime);
    try {
        watcher = fs.watch(runtime, (_event, filename) => {
            if (!isWaylandSocketEvent(filename)) return;
            scheduleWaylandRestartCheck();
        });
        watcher.on('error', () => {
            // The watcher is dead either way (fs.watch closes it on error), so
            // drop it — then put a new one up while anyone still depends on it.
            // Remember the session we knew: teardown wipes it, and the reinstall
            // has to be able to tell "same compositor" from "we missed one".
            const knownIdent = sessionIdent;
            teardownWaylandWatcher();
            scheduleWatcherReinstall(knownIdent);
        });
    } catch {
        /* runtime dir not watchable — silently skip; pipeline still works,
           it just won't self-heal across a compositor restart */
    }
}

/**
 * Rebuild an errored watcher after a short delay, up to the per-outage budget.
 * Delayed rather than immediate: the usual cause is the runtime dir being
 * swapped out under us, and re-watching the same instant just errors again.
 *
 * `knownIdent` is the session that was live before the watcher died. A fresh
 * watcher adopts whatever socket it finds, so without this comparison a
 * compositor restart that happened DURING the outage would be adopted silently
 * and the registered pipelines would keep drawing at a dead socket — the very
 * thing the watch exists to catch.
 */
function scheduleWatcherReinstall(knownIdent: string): void {
    if (reinstallTimer) return;
    if (!planWatcherReinstall(targets.size, reinstallAttempts)) return;
    reinstallAttempts++;
    reinstallTimer = setTimeout(() => {
        reinstallTimer = null;
        // Everyone may have unregistered while we waited.
        if (targets.size === 0) return;
        installWaylandWatcher();
        if (!watcher) {
            // Still nothing watching → the dir is still gone; try again until
            // the budget runs out.
            scheduleWatcherReinstall(knownIdent);
            return;
        }
        reinstallAttempts = 0;
        if (knownIdent && sessionIdent && sessionIdent !== knownIdent) {
            for (const handler of [...targets.values()]) handler(sessionIdent);
        }
    }, WATCHER_REINSTALL_DELAY_MS);
    reinstallTimer.unref?.();
}

function teardownWaylandWatcher(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (reinstallTimer) {
        clearTimeout(reinstallTimer);
        reinstallTimer = null;
    }
    if (watcher) {
        try {
            watcher.close();
        } catch {
            /* already closed */
        }
        watcher = null;
    }
    sessionIdent = '';
}

/**
 * Debounce socket events: Weston's restart sequence usually fires
 * delete + create within a few hundred ms, sometimes with an intermediate
 * `.lock` rename. Coalescing to a single restart-decision avoids
 * tearing the pipeline down twice.
 */
export function scheduleWaylandRestartCheck(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const runtime = process.env.XDG_RUNTIME_DIR;
        if (!runtime) return;
        const ident = currentWaylandSessionIdent(runtime);
        // No socket present (mid-restart) → wait for the next event.
        if (!ident) return;
        // Same session we already know about → spurious event, ignore.
        if (ident === sessionIdent) return;
        sessionIdent = ident;
        for (const handler of [...targets.values()]) {
            handler(ident);
        }
    }, 500);
}

/** Test hook: drop the watcher, the retry budget and every registration. */
export function resetWaylandRestartWatch(): void {
    teardownWaylandWatcher();
    reinstallAttempts = 0;
    targets.clear();
}

/**
 * Test hook: is a watcher currently installed? Lets the reinstall path be
 * asserted without reaching into module state.
 */
export function waylandWatcherInstalled(): boolean {
    return watcher !== null;
}
