import { ExponentialBackoff, type ControlIpcMessage } from '@media-router/shared-types';
import { PythonProcess, FORCE_KILL_TIMEOUT_MS, type RunnerStartOptions } from './PythonProcess.js';
import { ParentIpc } from './ParentIpc.js';
import { unixFdSrcSocketPaths, waitForBusSockets } from './busSocketGate.js';

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

// The `startPipeline` wire message: the runner start options plus the two
// restart-policy knobs GstRunner consumes itself (not forwarded to Python).
interface StartPipelineMessage extends RunnerStartOptions {
    restartOnError?: boolean;
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
}

/**
 * Orchestrates the Python GStreamer runner child process.
 *
 * Owns the pipeline state machine (currentState + restart loop) and the
 * translation between parent IPC actions and Python commands. Spawning,
 * stdio wiring, and the raw JSON event stream live in `PythonProcess`. The
 * parent IPC channel and round-trip request tracking live in `ParentIpc`.
 * The surrounding `gst-runner.ts` entry script wires signals/IPC to a single
 * `GstRunner` instance.
 */
export class GstRunner {
    private python: PythonProcess | null = null;
    private readonly ipc = new ParentIpc();
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

    constructor(private readonly pythonRunnerPath: string) {}

    // --- Public entry points (called by the gst-runner entry script) ---

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
                this.restartBackoff.reset();
                if (this.restartTimer) {
                    clearTimeout(this.restartTimer);
                    this.restartTimer = null;
                }
                this.python?.stop();
                this.ipc.sendResponse(msg.id, { ok: true });
                setTimeout(() => process.exit(0), STOP_PIPELINE_EXIT_MS);
                break;

            case 'getState':
                this.ipc.sendResponse(msg.id, {
                    state: this.currentState,
                    pid: this.python?.pid,
                });
                break;

            case 'setProperty': {
                const d = msg.data as { element: string; property: string; value: unknown };
                const reqId = this.makeRequestId('setprop');
                this.ipc.trackPending(reqId, msg.id, 'set_property');
                this.python?.sendCommand({
                    cmd: 'set_property',
                    element: d.element,
                    property: d.property,
                    value: d.value,
                    id: reqId,
                });
                break;
            }

            case 'getProperty': {
                const d = msg.data as { element: string; property: string };
                const reqId = this.makeRequestId('prop');
                this.ipc.trackPending(reqId, msg.id, 'property');
                this.python?.sendCommand({
                    cmd: 'get_property',
                    element: d.element,
                    property: d.property,
                    id: reqId,
                });
                break;
            }

            case 'getStats': {
                const d = msg.data as { element: string };
                const reqId = this.makeRequestId('stats');
                this.ipc.trackPending(reqId, msg.id, 'stats');
                this.python?.sendCommand({ cmd: 'get_stats', element: d.element, id: reqId });
                break;
            }

            case 'trackThroughput': {
                const d = msg.data as { element: string; pad?: string };
                const reqId = this.makeRequestId('track');
                this.ipc.trackPending(reqId, msg.id, 'track_throughput');
                this.python?.sendCommand({
                    cmd: 'track_throughput',
                    element: d.element,
                    pad: d.pad ?? 'src',
                    id: reqId,
                });
                break;
            }

            case 'getThroughput': {
                const reqId = this.makeRequestId('tp');
                this.ipc.trackPending(reqId, msg.id, 'throughput');
                this.python?.sendCommand({ cmd: 'get_throughput', id: reqId });
                break;
            }

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
                this.python?.sendCommand({ cmd: 'bus_attach', tee: d.tee, socket: d.socket });
                break;
            }

            case 'busDetach': {
                const d = msg.data as { socket: string };
                this.python?.sendCommand({ cmd: 'bus_detach', socket: d.socket });
                break;
            }

            case 'busReinput': {
                // Live input re-point: swap the named unixfdsrc onto a new edge
                // socket without a pipeline rebuild. Tracked — the executor must
                // know the swap landed before it detaches the old edge.
                const d = msg.data as { element: string; socket: string };
                const reqId = this.makeRequestId('reinput');
                this.ipc.trackPending(reqId, msg.id, 'bus_reinput');
                this.python?.sendCommand({
                    cmd: 'bus_reinput',
                    element: d.element,
                    socket: d.socket,
                    id: reqId,
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

    /** Graceful shutdown — SIGTERM, SIGINT, parent disconnect. */
    shutdown(reason: string): void {
        console.error(`[gst-runner] Shutting down: ${reason}`);
        // Disarm the auto-restart loop before we kill the child, otherwise the
        // child's exit handler will spawn a fresh Python within our exit
        // window — which then gets killed by the process.on('exit') SIGKILL
        // fallback, leaking a Python child every shutdown.
        this.restartOnError = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.python) {
            const py = this.python;
            py.sendCommand({ cmd: 'stop' });
            // SIGTERM is a second nudge, not a kill: the runner's handler runs
            // the same EOS drain as the `stop` command. The SIGKILL below is
            // the deadline for that drain (see SHUTDOWN_KILL_MS).
            py.kill('SIGTERM');
            setTimeout(() => {
                try {
                    py.kill('SIGKILL');
                } catch (err) {
                    console.error('[gst-runner] SIGKILL fallback failed:', err);
                }
            }, SHUTDOWN_KILL_MS);
        }
        setTimeout(() => process.exit(0), SHUTDOWN_EXIT_MS);
    }

    /** Last-ditch sync cleanup from `process.on('exit')`. */
    emergencyKill(): void {
        this.python?.emergencyKill();
    }

    // --- Python event handling ---

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
            if (this.lastStart) {
                this.startPipeline(this.lastStart, `restart-${this.restartBackoff.attempts}`);
            }
        }, delay);
    }

    /** Bumped on every start/stop; invalidates in-flight socket-gate waits. */
    private startEpoch = 0;

    private startPipeline(opts: RunnerStartOptions, requestId: string): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.python) this.python.stop();

        this.lastStart = opts;
        const epoch = ++this.startEpoch;

        const launch = () => {
            // Capture this instance locally — `this.python` may already point to a
            // newer spawn by the time the exit handler fires (a SIGKILL'd
            // predecessor can take hundreds of ms to reap). Without this guard the
            // late exit would clobber the live reference and trigger an extra
            // cascade restart.
            const py: PythonProcess = new PythonProcess({
                pythonRunnerPath: this.pythonRunnerPath,
                useStdioForData: opts.useStdioForData ?? false,
                onEvent: (event) => this.handlePythonEvent(event),
                onExit: (code, signal) => this.handlePythonExit(py, code, signal),
                onSpawnError: (err) => this.handlePythonSpawnError(py, err),
            });
            this.python = py;
            py.start(opts);
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
            }).then((ready) => {
                if (!ready || epoch !== this.startEpoch) return; // superseded by stop/newer start
                // All producer sockets accept — clear the gate signal, launch.
                this.ipc.sendEvent('busGate', { pending: [] });
                launch();
            });
        }

        this.ipc.sendResponse(requestId, { ok: true });
    }

    private handlePythonExit(
        py: PythonProcess,
        code: number | null,
        signal: NodeJS.Signals | null,
    ): void {
        if (this.python !== py) return; // a successor has taken over
        this.currentState = 'stopped';
        this.ipc.sendEvent('stateChange', { state: 'stopped', exitCode: code, signal });
        this.python = null;
        // An unexpected exit (non-zero code or fatal signal) means the
        // pipeline died without going through the bus — e.g. decoder
        // segfault, OOM, GStreamer assertion. Treat the same as a bus error:
        // schedule a restart. Without this, the gst-runner stays alive with
        // no Python child and no recovery path; the outer GstChildProcess
        // can't see it because *this* process is still healthy.
        if (this.restartOnError && (code !== 0 || signal)) {
            this.ipc.sendEvent('error', {
                // SYNTHESISED, not a bus error: it names no element because
                // the pipeline never got to post one. Plugins that attribute
                // failures to elements (video-player's decoder demotion) key
                // off this `kind` to leave their attribution state alone.
                kind: 'runner_exit',
                message: `Python runner exited unexpectedly (code=${code} signal=${signal ?? 'none'})`,
            });
            this.scheduleRestart();
        }
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
