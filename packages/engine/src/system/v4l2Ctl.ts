import { execFile } from 'child_process';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('v4l2Ctl');

/**
 * Outcome of a guarded `v4l2-ctl` run.
 * - `ok`      — the process exited 0; `stdout` holds its output.
 * - `failed`  — it ran but errored, or outlived its kill timeout.
 * - `blocked` — nothing was spawned: an earlier child has not exited yet.
 */
export type V4l2CtlOutcome =
    | { kind: 'ok'; stdout: string }
    | { kind: 'failed' }
    | { kind: 'blocked' };

/**
 * How long to keep waiting for the exec callback after the kill timeout has
 * passed. A child stuck in the kernel never emits `close`, so the callback
 * never fires — the caller's promise has to be settled by us instead.
 */
const KILL_GRACE_MS = 1000;

/** How long a killed child may stay alive before we call the driver wedged. */
const STUCK_AFTER_MS = 30_000;

/** Children spawned but not yet seen to exit. Never more than one — see below. */
let liveChildren = 0;
/** When the current live child was spawned. */
let spawnedAt = 0;
/** True once a live child has outlived STUCK_AFTER_MS. Logged once per episode. */
let stuck = false;

/**
 * Is a previously spawned `v4l2-ctl` still alive?
 *
 * When the kernel's V4L2 core wedges (a decoder driver stuck holding a lock),
 * `v4l2-ctl` blocks in uninterruptible D-state inside `v4l2_release`. The exec
 * timeout fires and SIGKILL is delivered, but the process cannot die — so a
 * 2 s poll loop accumulated ~3000 zombie-ish D-state processes in the service
 * cgroup over 12 h and starved the engine of its Tasks budget.
 *
 * The gate therefore keys on the child's actual exit, not on the promise
 * settling: while one is unaccounted for nothing new is spawned.
 */
export function v4l2CtlBlocked(): boolean {
    if (liveChildren === 0) return false;
    const aliveFor = Date.now() - spawnedAt;
    if (!stuck && aliveFor >= STUCK_AFTER_MS) {
        stuck = true;
        log.error(
            { aliveForMs: aliveFor },
            'v4l2-ctl survived SIGKILL (kernel V4L2 wedged) — suspending V4L2 enumeration until it exits',
        );
    }
    return true;
}

/**
 * Run `v4l2-ctl` unless a previous child is still alive.
 *
 * The in-flight flag is cleared on the child's `exit`/`close`/`error` event —
 * i.e. when the process really is gone — while the returned promise settles at
 * `timeoutMs + KILL_GRACE_MS` at the latest so callers never hang on a child
 * the kernel refuses to reap.
 */
export function runV4l2Ctl(args: string[], timeoutMs: number): Promise<V4l2CtlOutcome> {
    if (v4l2CtlBlocked()) return Promise.resolve({ kind: 'blocked' });

    return new Promise<V4l2CtlOutcome>((resolve) => {
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const settle = (outcome: V4l2CtlOutcome) => {
            if (settled) return;
            settled = true;
            if (watchdog) clearTimeout(watchdog);
            resolve(outcome);
        };

        liveChildren += 1;
        spawnedAt = Date.now();
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            liveChildren -= 1;
            if (liveChildren === 0 && stuck) {
                stuck = false;
                log.info('v4l2-ctl finally exited — V4L2 enumeration resumed');
            }
        };

        const child = execFile('v4l2-ctl', args, { timeout: timeoutMs }, (err, stdout) =>
            settle(err ? { kind: 'failed' } : { kind: 'ok', stdout }),
        );
        // `exit` fires before the exec callback on a healthy run; `close` and
        // `error` cover stdio-only and spawn-failure paths. First one wins.
        child.once('exit', release);
        child.once('close', release);
        child.once('error', release);

        watchdog = setTimeout(() => settle({ kind: 'failed' }), timeoutMs + KILL_GRACE_MS);
        watchdog.unref?.();
    });
}

/** Test-only: forget any live child and the stuck flag. */
export function _resetV4l2CtlGuardForTests(): void {
    liveChildren = 0;
    spawnedAt = 0;
    stuck = false;
}
