import { connect } from 'node:net';
import { liveInputLaunchText } from '../plugins/liveInputBranches.js';
import type { LiveInputBranch } from '../plugins/PluginModule.js';
import type { RunnerStartOptions } from './PythonProcess.js';

/**
 * Connect-probe gate for unixfd bus consumers.
 *
 * unixfdsrc has no retry: g_socket_connect() runs once in start(), so a
 * missing producer socket is a hard pipeline-start failure that burns a full
 * start/timeout/backoff cycle (~10s of python respawn churn). The runner
 * instead waits here — an actual connect() probe, NOT a file-existence check,
 * because a crashed producer leaves a stale socket file behind that refuses
 * connections — and only launches the pipeline once every producer socket
 * accepts.
 *
 * The wait is INDEFINITE by design (convergence over churn): on a large
 * graph, producer edge sockets appear only after the producer's data flows
 * (demuxer tees are created at pad-added), which can legitimately exceed any
 * fixed deadline. Waiting costs nothing — no python is spawned, no error is
 * raised, no restart cycle burns CPU — so the graph settles topologically:
 * producers publish, gates open, consumers launch. The old 10s
 * "start anyway" fallback guaranteed a failed start + backoff respawn per
 * consumer per cycle, which is exactly the measured storm that kept a
 * 24-stream graph from ever converging. Callers cancel a superseded wait via
 * `shouldAbort` (checked every iteration — without it, each superseded start
 * would leak an immortal probe loop) and surface progress via `onProgress`.
 *
 * Probing a LIVE serving unixfdsink is harmless (verified on gst 1.24 + 1.28:
 * connect-and-drop produces no bus error and the producer stays PLAYING).
 */

/** Socket paths of every unixfdsrc in a pipeline string. */
export function unixFdSrcSocketPaths(pipeline: string): string[] {
    return [...pipeline.matchAll(/unixfdsrc[^!]*?socket-path=(\S+)/g)].map((m) => m[1]);
}

/** True when a unix socket at `path` currently accepts a connection. */
export function probeUnixSocket(path: string, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = connect({ path });
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

/** Initial probe interval; backs off to `MAX_INTERVAL_MS` so a long wait
 *  doesn't keep hammering connect() at startup cadence. */
const INITIAL_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 1000;
/** Iterations between `onProgress` re-reports (~30s at the 1s interval). */
const PROGRESS_EVERY = 30;

export interface WaitForBusSocketsOpts {
    /** Cancel the wait: checked before every probe round. Return true when
     *  this wait has been superseded (newer start) or the pipeline stopped. */
    shouldAbort?: () => boolean;
    /** Called with the not-yet-ready paths when waiting begins, then
     *  re-called every ~PROGRESS_EVERY iterations while still waiting — the
     *  operator-visibility hook (an indefinitely-gated module must say what
     *  it is waiting for). */
    onProgress?: (pending: string[]) => void;
}

/** The probe loop: probe every path each round until `settle` answers; null when aborted. */
async function pollSockets<T>(
    paths: string[],
    settle: (up: (path: string) => boolean) => { done: T } | { pending: string[] },
    opts: WaitForBusSocketsOpts,
): Promise<T | null> {
    const { shouldAbort, onProgress } = opts;
    let interval = INITIAL_INTERVAL_MS;
    let iterations = 0;
    for (;;) {
        if (shouldAbort?.()) return null;
        const probed = await Promise.all(paths.map((p) => probeUnixSocket(p)));
        const accepting = new Set(paths.filter((_, i) => probed[i]));
        const state = settle((p) => accepting.has(p));
        if ('done' in state) return state.done;
        if (iterations % PROGRESS_EVERY === 0) onProgress?.(state.pending);
        iterations++;
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(interval * 2, MAX_INTERVAL_MS);
    }
}

/**
 * Resolve `true` once every path accepts connections; resolve `false` only
 * when `shouldAbort` cancels the wait. Never times out on its own.
 */
export async function waitForBusSockets(
    paths: string[],
    opts: WaitForBusSocketsOpts = {},
): Promise<boolean> {
    const ready = await pollSockets<boolean>(
        paths,
        (up) => (paths.every(up) ? { done: true } : { pending: paths.filter((p) => !up(p)) }),
        opts,
    );
    return ready ?? false;
}

/** A gate opened over `liveInputs`: the start to launch, and the inputs it leaves out. */
export interface LiveInputsGate {
    launch: RunnerStartOptions;
    absent: string[];
}

/** The gate over `liveInputs` (B-192): every socket in `pipeline` and one input whose sockets all
 *  accept, then launch with the inputs there (one that is not would fail the whole start); while
 *  none is, the pending report names them all. Null when aborted; no deadline of its own. */
export async function waitForLiveInputs(
    opts: RunnerStartOptions,
    wait: WaitForBusSocketsOpts = {},
): Promise<LiveInputsGate | null> {
    const required = unixFdSrcSocketPaths(opts.pipeline);
    const inputs = (opts.liveInputs ?? []).map((branch) => ({
        branch,
        sockets: unixFdSrcSocketPaths(branch.description ?? ''),
    }));
    const paths = [...new Set([...required, ...inputs.flatMap((i) => i.sockets)])];
    return pollSockets<LiveInputsGate>(
        paths,
        (up) => {
            const there = inputs.filter((i) => i.sockets.every(up));
            if (required.every(up) && there.length > 0) {
                return {
                    done: {
                        launch: launchWith(
                            opts,
                            there.map((i) => i.branch),
                        ),
                        absent: inputs.filter((i) => !there.includes(i)).map((i) => i.branch.name),
                    },
                };
            }
            const waiting = there.length > 0 ? [] : inputs.flatMap((i) => i.sockets);
            return { pending: [...required, ...waiting].filter((p) => !up(p)) };
        },
        wait,
    );
}

/** The start the runner gets: `pipeline` with `inputs` linked in, the field itself dropped. */
function launchWith(opts: RunnerStartOptions, inputs: LiveInputBranch[]): RunnerStartOptions {
    const { liveInputs: _all, ...rest } = opts;
    const links = inputs.map((b, i) => liveInputLaunchText(b, i));
    return { ...rest, pipeline: [opts.pipeline, ...links].join(' ') };
}
