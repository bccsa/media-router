import { ExponentialBackoff, type ControlIpcMessage } from '@media-router/shared-types';
import { PythonProcess, FORCE_KILL_TIMEOUT_MS, type RunnerStartOptions } from './PythonProcess.js';
import { ParentIpc } from './ParentIpc.js';
import { unixFdSrcSocketPaths, waitForBusSockets } from './busSocketGate.js';
import { RunnerHandback } from './runnerHandback.js';

// Restart policy:
//   - Default 1s base, 5s cap — fast recovery for transient errors.
//   - No attempt cap (0 = unlimited): a long stream outage shouldn't make us
//     give up forever. The outer GstChildProcess layer also retries via its
//     own backoff, but it only sees gst-runner *process* exits, not
//     pipeline-internal failures, so abandoning here means silent death.
//   - 30s stable PLAYING marks attempts back to zero so transient blips don't
//     accumulate over long sessions.
//   - Plugins with slow/expensive failure modes (SRT caller against an
//     unreachable remote, etc.) widen the window via `restartBackoffMs` on
//     PipelineDescription — see SrtInputModule / SrtOutputModule.
const DEFAULT_RESTART_BASE_MS = 1000;
const DEFAULT_RESTART_MAX_MS = 5000;
const RESTART_STABILITY_MS = 30_000;

// Shutdown budget. Both windows exist for one reason: the Python runner
// EOS-drains its pipeline before NULL (`EOS_DRAIN_TIMEOUT_MS` in
// gst-pipeline-runner.py) so a stateless HEVC decoder is never stopped
// mid-decode — killing it mid-drain wedges the kernel driver and takes the box
// down. So we SIGKILL only after the drain can have finished, and we outlive
// that kill long enough to reap the child. Derived from FORCE_KILL_TIMEOUT_MS
// (8000 today, itself sized off the 6000 ms drain) so widening the drain widens
// these too — never re-type the numbers. Pinned by eosDrainContract.test.ts.
const SHUTDOWN_KILL_MS = FORCE_KILL_TIMEOUT_MS;
const SHUTDOWN_EXIT_MS = SHUTDOWN_KILL_MS + 500;
// Same budget for the explicit `stopPipeline` action: `python.stop()` runs its
// own FORCE_KILL_TIMEOUT_MS timer, and exiting before that fires would trip the
// process-exit emergency SIGKILL on a still-draining runner.
const STOP_PIPELINE_EXIT_MS = FORCE_KILL_TIMEOUT_MS + 1000;
// Those two windows are a DEADLINE for the drain, not a wait we owe anybody —
// see `exitWhenDrained`. Once Python has actually exited we linger only long
// enough for the last IPC events (`stateChange { state: 'stopped' }`) to reach
// the parent: `process.send` is asynchronous, so exiting in the same tick drops
// them and the parent's `stop()` sees a channel close instead of a clean exit.
export const SHUTDOWN_FLUSH_MS = 250;

// The `startPipeline` wire message: the runner start options plus the two
// restart-policy knobs GstRunner consumes itself (not forwarded to Python).
interface StartPipelineMessage extends RunnerStartOptions {
    restartOnError?: boolean;
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
}

/**
 * Whoever hosts a `GstRunner` — the one seam through which the runner reaches
 * the outside world. `post` carries every event/response to the parent;
 * `exit` is called ONCE, when a terminal path (`stopPipeline` / `shutdown`)
 * has finished draining Python (or hit its deadline) and the runner is done.
 *
 * In-process (`InProcessRunnerHost`, the default) `post` is a direct method
 * call and `exit` marks the host finished. Under the legacy fork
 * (`gst-runner.ts`) they are `process.send` and `process.exit(0)`. The runner
 * itself never touches `process`, so an in-process runner can never take the
 * engine down with it.
 */
export interface RunnerHost {
    post(msg: ControlIpcMessage): void;
    exit(): void;
}

/**
 * Orchestrates the Python GStreamer runner child process.
 *
 * Owns the pipeline state machine (currentState + restart loop) and the
 * translation between parent control actions and Python commands. Spawning,
 * stdio wiring, and the raw JSON event stream live in `PythonProcess`. The
 * outbound channel and round-trip request tracking live in `ParentIpc`.
 * One instance per pipeline, hosted in the engine by `InProcessRunnerHost`
 * (or, under `MR_GST_RUNNER_FORK=1`, by the `gst-runner.ts` entry script in
 * a forked child).
 */
export class GstRunner {
    private python: PythonProcess | null = null;
    private readonly ipc: ParentIpc;
    private currentState: 'stopped' | 'playing' | 'error' = 'stopped';
    private restartOnError = false;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    // The last start options, replayed verbatim by the restart loop. One field
    // instead of a mirror per knob — new knobs can't drift out of the replay.
    private lastStart: RunnerStartOptions | null = null;
    private readonly restartBackoff = new ExponentialBackoff(
        DEFAULT_RESTART_BASE_MS,
        DEFAULT_RESTART_MAX_MS,
        0,
        RESTART_STABILITY_MS,
    );
    /**
     * `busAttach`es that arrived before the Python child existed — i.e. while
     * the INPUT socket gate was still holding this pipeline back (see
     * `startPipeline`). Edge socket → tee name, so a duplicate attach collapses
     * (Python is idempotent per socket anyway) while insertion order — the order
     * the coordinator attached the consumers — survives the flush.
     *
     * Dropping them (which `this.python?.sendCommand` did silently) stranded
     * every consumer of a gated producer: the only other path that ever
     * (re)attaches is the producer's PLAYING edge
     * (`BusFanoutCoordinator.reattachProducer`), so a producer that gates for
     * minutes — or never reaches PLAYING at all — left its consumers reporting
     * "Waiting for producer bus socket(s)" forever against an edge nobody was
     * going to create.
     */
    private readonly queuedBusAttaches = new Map<string, string>();

    /** A terminal path (`stopPipeline` / `shutdown`) has begun — see `exitWhenDrained`. */
    private exiting = false;
    /** The one-shot hand-back to the host; every deadline below arms it. */
    private readonly handback = new RunnerHandback(() => {
        this.ipc.clearPending();
        this.host.exit();
    });

    constructor(
        private readonly pythonRunnerPath: string,
        private readonly host: RunnerHost,
    ) {
        this.ipc = new ParentIpc((msg) => host.post(msg));
    }

    /** PID of the live Python runner, if one is up (the process a module owns). */
    get pythonPid(): number | undefined {
        return this.python?.pid;
    }

    // --- Public entry points (called by the host: InProcessRunnerHost, or gst-runner.ts under the fork) ---

    /** Dispatch one IPC message from the parent (the `child_process.fork`'er). */
    handleControlMessage(msg: ControlIpcMessage): void {
        switch (msg.action) {
            case 'startPipeline': {
                const { restartOnError, restartBackoffMs, ...opts } =
                    msg.data as StartPipelineMessage;
                this.restartOnError = restartOnError ?? false;
                this.restartBackoff.setBounds(
                    restartBackoffMs?.baseMs ?? DEFAULT_RESTART_BASE_MS,
                    restartBackoffMs?.maxMs ?? DEFAULT_RESTART_MAX_MS,
                );
                this.restartBackoff.reset();
                this.startPipeline(opts, msg.id);
                break;
            }

            case 'stopPipeline':
                this.restartOnError = false; // Cancel any pending restarts
                this.startEpoch++; // Invalidate any in-flight socket-gate wait
                this.clearQueuedBusAttaches('pipeline stopped');
                this.restartBackoff.reset();
                if (this.restartTimer) {
                    clearTimeout(this.restartTimer);
                    this.restartTimer = null;
                }
                this.exiting = true;
                this.python?.stop();
                this.ipc.sendResponse(msg.id, { ok: true });
                this.handback.after(STOP_PIPELINE_EXIT_MS);
                // …unless the drain is already over, in which case go now.
                this.exitWhenDrained();
                break;

            case 'getState':
                this.ipc.sendResponse(msg.id, {
                    state: this.currentState,
                    pid: this.python?.pid,
                });
                break;

            case 'setProperty': {
                const d = msg.data as { element: string; property: string; value: unknown };
                this.forwardTracked(msg.id, 'setprop', 'set_property', {
                    cmd: 'set_property',
                    element: d.element,
                    property: d.property,
                    value: d.value,
                });
                break;
            }

            case 'getProperty': {
                const d = msg.data as { element: string; property: string };
                this.forwardTracked(msg.id, 'prop', 'property', {
                    cmd: 'get_property',
                    element: d.element,
                    property: d.property,
                });
                break;
            }

            case 'getStats': {
                const d = msg.data as { element: string };
                this.forwardTracked(msg.id, 'stats', 'stats', { cmd: 'get_stats', element: d.element });
                break;
            }

            case 'trackThroughput': {
                const d = msg.data as { element: string; pad?: string };
                this.forwardTracked(msg.id, 'track', 'track_throughput', {
                    cmd: 'track_throughput',
                    element: d.element,
                    pad: d.pad ?? 'src',
                });
                break;
            }

            case 'getThroughput':
                this.forwardTracked(msg.id, 'tp', 'throughput', { cmd: 'get_throughput' });
                break;

            case 'setKlvPayload': {
                // In-band name carousel (mpegts muxer, Phase 2). Fire-and-forget
                // from the parent — the Python side stores the payload and
                // drives the ~1 s carousel itself, so there's no RPC to resolve.
                const d = msg.data as { element: string; payload: string };
                this.python?.sendCommand({
                    cmd: 'set_klv_payload',
                    element: d.element,
                    payload: d.payload,
                });
                break;
            }

            case 'busAttach': {
                // Per-consumer bus fan-out (unixfd). Fire-and-forget — the Python
                // side is idempotent per socket, so a duplicate (re-apply /
                // producer-restart re-attach) is a no-op.
                const d = msg.data as { tee: string; socket: string };
                if (this.python) {
                    this.python.sendCommand({ cmd: 'bus_attach', tee: d.tee, socket: d.socket });
                } else {
                    // No python yet: the INPUT socket gate is still holding this
                    // pipeline back (see startPipeline). Queue, don't drop.
                    this.queueBusAttach(d.tee, d.socket);
                }
                break;
            }

            case 'busDetach': {
                const d = msg.data as { socket: string };
                // A detach for an edge still sitting in the queue cancels it —
                // flushing it later would rebuild a branch the coordinator has
                // already torn down (and re-create its socket file).
                if (this.queuedBusAttaches.delete(d.socket)) {
                    console.error(
                        `[gst-runner] busDetach cancelled queued bus_attach: ${d.socket}`,
                    );
                }
                this.python?.sendCommand({ cmd: 'bus_detach', socket: d.socket });
                break;
            }

            case 'busReinput': {
                // Live input re-point: swap the named unixfdsrc onto a new edge
                // socket without a pipeline rebuild. Tracked — the executor must
                // know the swap landed before it detaches the old edge.
                const d = msg.data as { element: string; socket: string };
                this.forwardTracked(msg.id, 'reinput', 'bus_reinput', {
                    cmd: 'bus_reinput',
                    element: d.element,
                    socket: d.socket,
                });
                break;
            }

            case 'updatePipeline': {
                // Replace the replay description after a live mutation so a
                // runner-layer respawn rebuilds with the CURRENT sockets, not
                // the ones from the original start.
                this.lastStart = msg.data as RunnerStartOptions;
                this.ipc.sendResponse(msg.id, { ok: true });
                break;
            }

            default:
                console.warn(`[gst-runner] Unknown action: ${msg.action}`);
                this.ipc.sendResponse(msg.id, { error: `Unknown action: ${msg.action}` });
        }
    }

    /**
     * Graceful shutdown — the host is done with this runner (module stop /
     * destroy in-process; SIGTERM, SIGINT or parent disconnect under the fork).
     * Idempotent: a second call re-nudges a still-draining Python and re-arms
     * the same deadline, and the hand-back fires the host exactly once.
     */
    shutdown(reason: string): void {
        console.error(`[gst-runner] Shutting down: ${reason}`);
        // Disarm the auto-restart loop before we kill the child, otherwise the
        // child's exit handler will spawn a fresh Python within our exit
        // window — which then gets killed by the host's emergency SIGKILL
        // fallback, leaking a Python child every shutdown.
        this.restartOnError = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        // Invalidate an in-flight socket-gate wait and its queued attaches:
        // under the fork the process exit ended them, in-process nothing else
        // would — the probe loop is immortal until its epoch is superseded.
        this.startEpoch++;
        this.clearQueuedBusAttaches('runner shut down');
        this.exiting = true;
        if (this.python) {
            const py = this.python;
            py.sendCommand({ cmd: 'stop' });
            // SIGTERM is a second nudge, not a kill: the runner's handler runs
            // the same EOS drain as the `stop` command. The SIGKILL below is
            // the deadline for that drain (see SHUTDOWN_KILL_MS) — tracked so
            // a Python that drains in time leaves no timer holding it.
            py.kill('SIGTERM');
            this.clearShutdownKill();
            this.shutdownKillTimer = setTimeout(() => {
                this.shutdownKillTimer = null;
                try {
                    py.kill('SIGKILL');
                } catch (err) {
                    console.error('[gst-runner] SIGKILL fallback failed:', err);
                }
            }, SHUTDOWN_KILL_MS);
        }
        this.handback.after(SHUTDOWN_EXIT_MS);
        // …unless there is nothing left to drain.
        this.exitWhenDrained();
    }

    /**
     * Hand back as soon as Python is verifiably gone.
     *
     * `SHUTDOWN_EXIT_MS` / `STOP_PIPELINE_EXIT_MS` are the DEADLINE for the
     * Python EOS drain — the point past which a still-running drain must be
     * abandoned — not a period we have to sit out. Once `handlePythonExit` has
     * nulled `python`, the drain is over (or there was never a pipeline), and
     * every further millisecond is pure recovery latency handed to the parent:
     * `GstChildProcess.stop()` waits for this process to exit, so a module
     * rebuild cost a flat ~8.5 s no matter how fast the pipeline came down. The
     * video player pays that per rebuild, and an upstream codec flip needs
     * three of them — measured 8516 ms per stop on a `videotestsrc ! fakesink`
     * pipeline whose Python exited in ~100 ms, which is where the ~30 s field
     * recovery came from (Pi 400, 2026-08-05).
     *
     * Called from both terminal paths and again from `handlePythonExit`, so
     * whichever comes last arms it. Never from anywhere else: `exiting` is the
     * proof that a teardown — not a restart — asked for this.
     */
    private exitWhenDrained(): void {
        if (!this.exiting || this.python) return;
        this.handback.after(SHUTDOWN_FLUSH_MS);
    }

    /**
     * Last-ditch sync cleanup — the host's process is exiting (or gave up
     * waiting for the drain): SIGKILL whatever Python is still up, retiring
     * ones included.
     */
    emergencyKill(): void {
        this.python?.emergencyKill();
        for (const py of this.retiring) py.emergencyKill();
    }

    /** The `shutdown` SIGKILL deadline, cleared once its Python has exited. */
    private shutdownKillTimer: ReturnType<typeof setTimeout> | null = null;

    private clearShutdownKill(): void {
        if (this.shutdownKillTimer) {
            clearTimeout(this.shutdownKillTimer);
            this.shutdownKillTimer = null;
        }
    }

    /** One tracked RPC: register the pending id, forward the command to Python with it. */
    private forwardTracked(
        parentReqId: string,
        prefix: string,
        label: string,
        cmd: Record<string, unknown>,
    ): void {
        const reqId = this.makeRequestId(prefix);
        this.ipc.trackPending(reqId, parentReqId, label);
        this.python?.sendCommand({ ...cmd, id: reqId });
    }

    // --- Python event handling ---

    /**
     * Error boundary around every Python event. The runner shares the engine
     * process, so a throw here must stay a logged, dropped event — never an
     * uncaught exception that takes every other module's runner with it.
     */
    private dispatchPythonEvent(eventJson: Record<string, unknown>): void {
        try {
            this.handlePythonEvent(eventJson);
        } catch (err) {
            console.error(`[gst-runner] Python event handler threw (event=${String(eventJson.event)}):`, err);
        }
    }

    private handlePythonEvent(eventJson: Record<string, unknown>): void {
        const event = eventJson.event as string;

        switch (event) {
            case 'ready':
            case 'started':
                // No-op — the `Starting pipeline (...)` log already covers it.
                break;

            case 'state_change': {
                const state = eventJson.state as string;
                if (state === 'playing' && this.currentState !== 'playing') {
                    this.currentState = 'playing';
                    this.restartBackoff.markStable(); // Reset attempts after sustained PLAYING
                    this.ipc.sendEvent('stateChange', { state: 'playing' });
                } else if (state === 'paused') {
                    this.ipc.sendEvent('stateChange', { state: 'paused' });
                } else if (state === 'null') {
                    this.currentState = 'stopped';
                    this.ipc.sendEvent('stateChange', { state: 'stopped' });
                }
                break;
            }

            case 'vu_data':
                this.ipc.sendEvent('vuData', { peak: eventJson.peak });
                break;

            case 'plugin_event':
                // Generic pipeline→plugin data channel. Forwarded verbatim; the
                // runner and the plugin are the only type-aware ends.
                this.ipc.sendEvent('pluginEvent', {
                    channel: eventJson.channel,
                    payload: eventJson.payload,
                });
                break;

            case 'error':
                // Fatal pipeline-lifecycle failure (bus ERROR, parse-fail,
                // PLAYING-fail, udpsrc timeout). Tear down + restart per
                // policy. RPC-handler failures use `command_error` (below).
                this.currentState = 'error';
                console.error(
                    `[gst-runner] Pipeline ERROR: ${eventJson.message}${eventJson.element ? ` [element: ${eventJson.element}]` : ''}${eventJson.debug ? ` (${eventJson.debug})` : ''}`,
                );
                this.ipc.sendEvent('error', {
                    message: eventJson.message,
                    // Pass through `kind` so consumers can distinguish recoverable
                    // failures (e.g. udpsrc timeout when the source goes silent)
                    // from hard bus errors. Plugins use this to switch to a
                    // fallback pipeline instead of looping on the failing one.
                    kind: eventJson.kind,
                    // Source element name (from the gst bus message) — error
                    // attribution for diagnostics and per-element policies.
                    element: eventJson.element,
                });
                this.ipc.sendEvent('stateChange', { state: 'error' });
                if (this.restartOnError) this.scheduleRestart();
                break;

            case 'command_error': {
                // Non-fatal RPC-handler failure (element not found, get/set
                // exception, unknown cmd). Reject the pending RPC and leave
                // the live pipeline alone — without this, a stale element
                // name in a `setElementProperty` call tore the pipeline down
                // via the bus-error path.
                console.error(`[gst-runner] Command error: ${eventJson.message}`);
                const reqId = eventJson.id as string | undefined;
                if (reqId) {
                    this.ipc.resolvePending(reqId, { error: eventJson.message });
                }
                break;
            }

            case 'eos':
                console.error('[gst-runner] Pipeline EOS');
                this.currentState = 'stopped';
                this.ipc.sendEvent('stateChange', { state: 'stopped' });
                if (this.restartOnError) this.scheduleRestart();
                break;

            case 'pad_linked':
                console.error(
                    `[gst-runner] Pad linked: rule=${eventJson.rule} index=${eventJson.index} pad=${eventJson.padName}` +
                        (eventJson.padOffsetNs !== undefined
                            ? ` padOffsetNs=${eventJson.padOffsetNs}`
                            : ''),
                );
                break;

            case 'warning':
                // Non-fatal runner diagnostics (parser fallback, bus_attach
                // retries, stale-socket cleanup). Dropping these hid real
                // failures — a video branch linked without its codec parser
                // warned here and nothing reached the logs.
                console.error(`[gst-runner] Warning: ${eventJson.message}`);
                break;

            case 'property':
            case 'stats':
            case 'throughput':
            case 'property_set':
            case 'tracking':
            case 'bus_reinput_done':
                // Round-trip response from a tracked Python request. The
                // confirmation-only emissions (property_set, tracking) also
                // carry an id now so the parent's setProperty/trackThroughput
                // RPCs can resolve on the actual Python outcome instead of an
                // optimistic immediate ack.
                if (eventJson.id) {
                    this.ipc.resolvePending(eventJson.id as string, eventJson);
                }
                break;
        }
    }

    // --- Pipeline lifecycle ---

    private scheduleRestart(): void {
        if (this.restartTimer) return;
        const delay = this.restartBackoff.nextDelay();
        if (delay === null) return; // unreachable with maxAttempts=0; defensive
        console.error(
            `[gst-runner] Restarting pipeline in ${delay}ms (attempt ${this.restartBackoff.attempts})`,
        );
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.lastStart) return;
            try {
                this.startPipeline(this.lastStart, `restart-${this.restartBackoff.attempts}`);
            } catch (err) {
                // In-process, a throw here would be an uncaught exception in
                // the engine. Log it and let the next tick retry.
                console.error('[gst-runner] restart failed:', err);
                this.scheduleRestart();
            }
        }, delay);
    }

    // --- Gated bus-attach queue ---

    /** Hold a `bus_attach` until the socket gate opens and Python exists. */
    private queueBusAttach(tee: string, socket: string): void {
        this.queuedBusAttaches.set(socket, tee);
        console.error(
            `[gst-runner] Queued bus_attach while gated (tee=${tee} socket=${socket}, ${this.queuedBusAttaches.size} queued)`,
        );
    }

    /** Replay the queue into a freshly-launched Python, in arrival order. */
    private flushQueuedBusAttaches(): void {
        if (this.queuedBusAttaches.size === 0) return;
        console.error(
            `[gst-runner] Flushing ${this.queuedBusAttaches.size} queued bus_attach(es) after gate opened`,
        );
        for (const [socket, tee] of this.queuedBusAttaches) {
            this.python?.sendCommand({ cmd: 'bus_attach', tee, socket });
        }
        this.queuedBusAttaches.clear();
    }

    /**
     * Drop the queue on a start-epoch change (`stopPipeline`, or any newer
     * start — including the restart loop's replay). The queued attaches belong
     * to the superseded epoch's topology; the parent re-attaches on the next
     * PLAYING edge, so replaying them into a different pipeline would only
     * build branches on tees the coordinator no longer believes in.
     */
    private clearQueuedBusAttaches(reason: string): void {
        if (this.queuedBusAttaches.size === 0) return;
        console.error(
            `[gst-runner] Dropping ${this.queuedBusAttaches.size} queued bus_attach(es): ${reason}`,
        );
        this.queuedBusAttaches.clear();
    }

    /** Bumped on every start/stop; invalidates in-flight socket-gate waits. */
    private startEpoch = 0;

    /**
     * Pythons a newer start has told to stop but which have not exited yet.
     * Off `this.python` the moment they retire: a gated start can wait
     * minutes for its producer, and a retiring Python's clean exit inside
     * that window used to pass the identity guard in `handlePythonExit`, fire
     * a spurious error, bump the backoff and re-enter `startPipeline` —
     * abandoning the live gate wait. Kept here only so `emergencyKill` can
     * still reach them.
     */
    private readonly retiring = new Set<PythonProcess>();

    private startPipeline(opts: RunnerStartOptions, requestId: string): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.python) {
            this.retiring.add(this.python);
            this.python.stop();
            this.python = null;
        }

        this.lastStart = opts;
        const epoch = ++this.startEpoch;
        this.clearQueuedBusAttaches('superseded by a newer start');

        const launch = () => {
            // Capture this instance locally — `this.python` may already point to a
            // newer spawn by the time the exit handler fires (a SIGKILL'd
            // predecessor can take hundreds of ms to reap). Without this guard the
            // late exit would clobber the live reference and trigger an extra
            // cascade restart.
            const py: PythonProcess = new PythonProcess({
                pythonRunnerPath: this.pythonRunnerPath,
                useStdioForData: opts.useStdioForData ?? false,
                onEvent: (event) => this.dispatchPythonEvent(event),
                onExit: (code, signal) => this.handlePythonExit(py, code, signal),
                onSpawnError: (err) => this.handlePythonSpawnError(py, err),
            });
            this.python = py;
            py.start(opts);
            // `py.start` writes the `start` command synchronously and Python
            // executes commands in order, so anything flushed here lands AFTER
            // the pipeline exists — the queued attaches find their tee (or the
            // runner's own 250 ms pending-attach retry covers a tee that is
            // created later, at pad-added).
            this.flushQueuedBusAttaches();
        };

        // unixfdsrc has no retry: connect() runs once in start(), so launching
        // before the producer's socket accepts burns a full start/timeout/
        // backoff cycle. Gate on a live connect-probe INDEFINITELY — waiting
        // spawns nothing and errors nothing, so large graphs converge
        // topologically instead of restart-storming (the old 10s
        // "start anyway" fallback guaranteed a failed start per consumer per
        // cycle and kept a 24-stream graph from ever settling). The abort
        // predicate stops a superseded wait's probe loop outright; the
        // periodic progress callback keeps the wait visible to the operator
        // (console + `busGate` event → module health warning).
        const busSockets = unixFdSrcSocketPaths(opts.pipeline);
        if (busSockets.length === 0) {
            launch();
        } else {
            void waitForBusSockets(busSockets, {
                shouldAbort: () => epoch !== this.startEpoch,
                onProgress: (pending) => {
                    console.error(
                        `[gst-runner] Waiting for producer bus socket(s): ${pending.join(', ')}`,
                    );
                    this.ipc.sendEvent('busGate', { pending });
                },
            })
                .then((ready) => {
                    if (!ready || epoch !== this.startEpoch) return; // superseded by stop/newer start
                    // All producer sockets accept — clear the gate signal, launch.
                    this.ipc.sendEvent('busGate', { pending: [] });
                    launch();
                })
                .catch((err) => {
                    // Fault boundary: an unhandled rejection here would be
                    // fatal to the ENGINE in-process (no handler installed).
                    // Surface it as a spawn failure; the restart loop retries.
                    console.error('[gst-runner] gated launch failed:', err);
                    this.ipc.sendEvent('error', {
                        kind: 'spawn_failed',
                        message: `Gated launch failed: ${err instanceof Error ? err.message : String(err)}`,
                    });
                    if (this.restartOnError) this.scheduleRestart();
                });
        }

        this.ipc.sendResponse(requestId, { ok: true });
    }

    private handlePythonExit(
        py: PythonProcess,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (this.retiring.delete(py)) return; // told to stop by a newer start — expected
        if (this.python !== py) return; // a successor has taken over
        this.clearShutdownKill();
        const priorState = this.currentState;
        this.currentState = 'stopped';
        this.ipc.sendEvent('stateChange', { state: 'stopped', exitCode: code, signal });
        this.python = null;
        // A teardown is already under way and its whole reason for waiting was
        // this exit — stop waiting (see exitWhenDrained). Returning here rather
        // than falling through is belt-and-braces: both terminal paths clear
        // `restartOnError` first, so the restart below could not fire anyway.
        if (this.exiting) {
            this.exitWhenDrained();
            return;
        }
        // Any exit outside a teardown means the pipeline died without the
        // runner asking it to — decoder segfault, OOM, GStreamer assertion —
        // and ALSO the clean `code=0` a fresh Python takes when its unixfd
        // teardown SIGSEGVs the predecessor and the replacement finds nothing
        // to serve (gate01, 2026-07-18). That clean exit used to be read as
        // "intentional stop": the runner stayed alive with no Python and no
        // recovery path, and every downstream consumer gated forever on a
        // socket that would never come back. Only the two terminal paths
        // (`exiting`, handled above) and a superseding start (`retiring`) are
        // intentional; everything else restarts per policy.
        if (!this.restartOnError) return;
        // Python also exits 0 AFTER every bus error / EOS / stall it reported
        // itself — those already scheduled this restart and carry the real
        // message. Posting a generic "exited unexpectedly" on top would
        // overwrite the bus error text in module health, so the synthesised
        // error is for the silent exits only.
        const alreadyReported = this.restartTimer !== null || priorState === 'error';
        if (!alreadyReported) {
            this.ipc.sendEvent('error', {
                // SYNTHESISED, not a bus error: it names no element because
                // the pipeline never got to post one. Plugins that attribute
                // failures to elements (video-player's decoder demotion) key
                // off this `kind` to leave their attribution state alone.
                kind: 'runner_exit',
                message: `Python runner exited unexpectedly (code=${code} signal=${signal ?? 'none'})`,
            });
        }
        this.scheduleRestart();
    }

    private handlePythonSpawnError(py: PythonProcess, err: Error): void {
        if (this.python !== py) return;
        this.currentState = 'error';
        // Synthesised — the python child never started, so nothing in the
        // pipeline can be blamed for it (see the `runner_exit` note above).
        this.ipc.sendEvent('error', { kind: 'spawn_failed', message: err.message });
        this.ipc.sendEvent('stateChange', { state: 'error' });
    }

    private makeRequestId(prefix: string): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
}
