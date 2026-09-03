import type { RunnerChannel } from './ControlIpc.js';

/**
 * Where a module's `GstRunner` lives, as seen by `GstChildProcess`. Two
 * implementations: `InProcessRunnerHost` (the default — the runner shares the
 * engine process, ADR-0012) and `ForkedRunnerBackend` (the runner behind a
 * forked `gst-runner.js` shim, the `MR_GST_RUNNER_FORK=1` rollback).
 */
export interface RunnerBackend {
    /** Control traffic to the runner. */
    readonly channel: RunnerChannel;
    /** PID of the process this runner owns (python in-process, the shim under the fork). */
    readonly pid: number | undefined;
    /**
     * Fires when the runner is gone: the shim process exited (its exit code)
     * or the hosted runner handed itself back (0). A non-zero code is the
     * fork's "shim died" — the only exit that warrants an outer respawn.
     */
    onExit(cb: (code: number | null) => void): void;
    /** Orderly teardown, bounded by `capMs`, after which Python is SIGKILLed. */
    stop(capMs: number): Promise<void>;
    /** Detach; a still-live runner is shut down, never leaked. */
    destroy(): void;
}
