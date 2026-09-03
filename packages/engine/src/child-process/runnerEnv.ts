import { seedWaylandEnv } from '../system/waylandEnv.js';

/**
 * The env block every GStreamer runner process is spawned with — the python
 * `gst-pipeline-runner.py` (and, under `MR_GST_RUNNER_FORK=1`, the legacy
 * `gst-runner.js` shim it used to sit behind). A copy of this process's env:
 * nothing here mutates `process.env`.
 *
 * Wayland is resolved at spawn time (`seedWaylandEnv`) so a compositor that
 * started after the engine is still picked up — and so an engine launched
 * without session env (SSH, systemd-user with no inherited environment)
 * still gets `WAYLAND_DISPLAY` when a wayland socket exists.
 *
 * `MALLOC_ARENA_MAX`: glibc gives every thread that mallocs its own arena, and
 * a GStreamer pipeline runs one streaming thread per queue/source (10–13 per
 * runner), each arena holding its own free-list slack. Two arenas are plenty
 * for a runner whose allocations are buffer pools, and the slack is the
 * largest single private-memory cost measured per python runner:
 * 71 → 54 MB RSS on a 3-rendition audio transcoder pipeline (Pi 4, glibc
 * 2.41, 2026-09-03). The node shim it replaced was 66 → 58 MB under the same
 * knob. Honoured only when the operator has not set it.
 */
export function runnerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!env.MALLOC_ARENA_MAX) env.MALLOC_ARENA_MAX = '2';
    seedWaylandEnv(env);
    return env;
}
