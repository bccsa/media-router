import { ExponentialBackoff, type ControlIpcMessage } from '@media-router/shared-types';
import type { PadLinkRule } from '../plugins/PluginModule.js';
import { PythonProcess } from './PythonProcess.js';
import { ParentIpc } from './ParentIpc.js';

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

interface StartPipelineMessage {
    pipeline: string;
    useStdioForData?: boolean;
    restartOnError?: boolean;
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
    linkOnPadAdded?: PadLinkRule[];
    readKlvNames?: boolean;
    env?: Record<string, string>;
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
    private useStdioForData = false;
    private restartOnError = false;
    private lastPipelineString = '';
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private lastPadLinkRules: PadLinkRule[] = [];
    private lastReadKlvNames = false;
    private lastEnv: Record<string, string> = {};
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
                const d = msg.data as StartPipelineMessage;
                this.restartOnError = d.restartOnError ?? false;
                this.restartBackoff.setBounds(
                    d.restartBackoffMs?.baseMs ?? DEFAULT_RESTART_BASE_MS,
                    d.restartBackoffMs?.maxMs ?? DEFAULT_RESTART_MAX_MS,
                );
                this.restartBackoff.reset();
                this.startPipeline(
                    d.pipeline,
                    msg.id,
                    d.useStdioForData,
                    d.linkOnPadAdded ?? [],
                    d.env ?? {},
                    d.readKlvNames ?? false,
                );
                break;
            }

            case 'stopPipeline':
                this.restartOnError = false; // Cancel any pending restarts
                this.restartBackoff.reset();
                if (this.restartTimer) {
                    clearTimeout(this.restartTimer);
                    this.restartTimer = null;
                }
                this.python?.stop();
                this.ipc.sendResponse(msg.id, { ok: true });
                setTimeout(() => process.exit(0), 3000);
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

            default:
                console.warn(`[gst-runner] Unknown action: ${msg.action}`);
                this.ipc.sendResponse(msg.id, { error: `Unknown action: ${msg.action}` });
        }
    }

    /** Graceful shutdown — SIGTERM, SIGINT, parent disconnect. */
    shutdown(reason: string): void {
        console.error(`[gst-runner] Shutting down: ${reason}`);
        // Disarm the auto-restart loop before we kill the child, otherwise the
        // child's exit handler will spawn a fresh Python within our 1.5s exit
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
            py.kill('SIGTERM');
            setTimeout(() => {
                try {
                    py.kill('SIGKILL');
                } catch (err) {
                    console.error('[gst-runner] SIGKILL fallback failed:', err);
                }
            }, 1000);
        }
        setTimeout(() => process.exit(0), 1500);
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

            case 'error':
                // Fatal pipeline-lifecycle failure (bus ERROR, parse-fail,
                // PLAYING-fail, udpsrc timeout). Tear down + restart per
                // policy. RPC-handler failures use `command_error` (below).
                this.currentState = 'error';
                console.error(
                    `[gst-runner] Pipeline ERROR: ${eventJson.message}${eventJson.debug ? ` (${eventJson.debug})` : ''}`,
                );
                this.ipc.sendEvent('error', {
                    message: eventJson.message,
                    // Pass through `kind` so consumers can distinguish recoverable
                    // failures (e.g. udpsrc timeout when the source goes silent)
                    // from hard bus errors. Plugins use this to switch to a
                    // fallback pipeline instead of looping on the failing one.
                    kind: eventJson.kind,
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
                    `[gst-runner] Pad linked: rule=${eventJson.rule} index=${eventJson.index} pad=${eventJson.padName}`,
                );
                break;

            case 'stream_discovered':
                // A tsdemux pad appeared — forward the PID/codec/media to the
                // owning module's stream inspector. Pure report (plan D6): it
                // never affects routing or health, so it's not gated on
                // restartOnError or currentState.
                this.ipc.sendEvent('streamDiscovered', {
                    from: eventJson.from,
                    pid: eventJson.pid,
                    media: eventJson.media,
                    caps: eventJson.caps,
                    padName: eventJson.padName,
                });
                break;

            case 'stream_names':
                // KLV name payload parsed off the metadata PID (Phase 2).
                // Forward the raw payload + a parsed/malformed hint to the
                // owning module's name merge. Pure report (plan D6) — never
                // gates on restartOnError or currentState.
                this.ipc.sendEvent('streamNames', {
                    payload: eventJson.payload,
                    malformed: eventJson.malformed,
                });
                break;

            case 'property':
            case 'stats':
            case 'throughput':
            case 'property_set':
            case 'tracking':
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
            if (this.lastPipelineString) {
                this.startPipeline(
                    this.lastPipelineString,
                    `restart-${this.restartBackoff.attempts}`,
                    this.useStdioForData,
                    this.lastPadLinkRules,
                    this.lastEnv,
                    this.lastReadKlvNames,
                );
            }
        }, delay);
    }

    private startPipeline(
        pipeline: string,
        requestId: string,
        stdioForData = false,
        padLinkRules: PadLinkRule[] = [],
        env: Record<string, string> = {},
        readKlvNames = false,
    ): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.python) this.python.stop();

        this.lastPipelineString = pipeline;
        this.lastPadLinkRules = padLinkRules;
        this.lastReadKlvNames = readKlvNames;
        this.lastEnv = env;
        this.useStdioForData = stdioForData;

        // Capture this instance locally — `this.python` may already point to a
        // newer spawn by the time the exit handler fires (a SIGKILL'd
        // predecessor can take hundreds of ms to reap). Without this guard the
        // late exit would clobber the live reference and trigger an extra
        // cascade restart.
        const py: PythonProcess = new PythonProcess({
            pythonRunnerPath: this.pythonRunnerPath,
            useStdioForData: stdioForData,
            onEvent: (event) => this.handlePythonEvent(event),
            onExit: (code, signal) => this.handlePythonExit(py, code, signal),
            onSpawnError: (err) => this.handlePythonSpawnError(py, err),
        });
        this.python = py;
        py.start(pipeline, padLinkRules, env, readKlvNames);

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
                message: `Python runner exited unexpectedly (code=${code} signal=${signal ?? 'none'})`,
            });
            this.scheduleRestart();
        }
    }

    private handlePythonSpawnError(py: PythonProcess, err: Error): void {
        if (this.python !== py) return;
        this.currentState = 'error';
        this.ipc.sendEvent('error', { message: err.message });
        this.ipc.sendEvent('stateChange', { state: 'error' });
    }

    private makeRequestId(prefix: string): string {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
}
