import { findCogPidForDisplay, processStartMs } from './wayland.js';

/**
 * Kiosk-browser (cog) restack rule.
 *
 * Kiosk-shell stacks toplevels by surface-creation time — when the cog browser
 * on our output respawns (URL change, crash, etc.) its new surface ends up
 * above the video's, making the player look frozen even though the pipeline is
 * still happily decoding. We can't observe wayland surface stacking from
 * outside the compositor, but we can observe cog processes via /proc and use
 * their start time as a proxy: a cog newer than our pipeline gets one pipeline
 * restart, so our surface becomes the newest one and lands back on top.
 */

/**
 * A cog PROCESS can predate our pipeline while its SURFACE (mapped when the
 * page first renders, seconds after spawn) still lands on top of ours. Treat
 * any cog started within this window before our watch began as potentially
 * newer-surfaced and restack once. Cost when wrong: one extra ~2 s pipeline
 * blip after a compositor restart; cost of the old exact rule when wrong:
 * video invisible until a human intervenes.
 */
export const COG_SURFACE_GRACE_MS = 15_000;

export interface CogRestackInput {
    /** DRM connector our pipeline renders on — the `local.cog.<display>` key. */
    display: string;
    /** When this pipeline's cog watch (≈ surface creation) began, BOOT-relative. */
    watchStartedAt: number;
    /** Cog PID we already restacked for — one restart per cog incarnation. */
    lastRestackPid: number | undefined;
    /** Injected for tests; defaults are the real /proc readers. */
    findPid?: typeof findCogPidForDisplay;
    startMs?: typeof processStartMs;
}

/**
 * PID of a cog that needs a restack right now, or `undefined` for "nothing to
 * do" (no cog, cog mid-restart, already restacked for it, unreadable start
 * time, or a cog old enough to be safely below us).
 *
 * Restack rule: kiosk-shell stacks newest surface on top, so a cog whose
 * PROCESS started after this pipeline did will cover the video once its
 * page renders. A PID-change baseline missed the compositor-restart case
 * (field 2026-08-02, monitor power-cycle): the video pipeline and cog
 * respawn together, the baseline was captured AFTER the new cog spawned,
 * and the video stayed hidden behind the control panel with the pipeline
 * happily presenting to an occluded surface. Comparing process start
 * times has no baseline to race: cog newer than us → restart once (latched
 * per PID by the caller; the rebuilt pipeline is then newest and the rule goes
 * quiet).
 *
 * Both sides of the comparison are BOOT-relative ms — `processStartMs`
 * (/proc/<pid>/stat starttime) against the watch start (`bootNowMs`).
 * Wall-clock would break this exactly at boot, the only time it matters:
 * the Pi has no RTC and NTP steps the clock by hours a few seconds in.
 */
export function cogNeedingRestack(input: CogRestackInput): number | undefined {
    const findPid = input.findPid ?? findCogPidForDisplay;
    const startMs = input.startMs ?? processStartMs;
    if (!input.display) return undefined;
    const current = findPid(input.display);
    if (current === undefined) return undefined; // cog mid-restart, wait
    if (current === input.lastRestackPid) return undefined;
    const cogStart = startMs(current);
    if (cogStart === undefined) return undefined;
    if (cogStart <= input.watchStartedAt - COG_SURFACE_GRACE_MS) return undefined;
    return current;
}
