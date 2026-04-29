/**
 * GStreamer child process runner.
 *
 * Spawned by the engine via child_process.fork().
 * Receives a pipeline string via IPC, spawns gst-pipeline-runner.py,
 * monitors it, and reports state/VU/errors back to the parent.
 *
 * The Python runner provides programmatic access to GStreamer:
 * - Live property changes (set_property)
 * - Property reads (get_property)
 * - Element stats (get_stats)
 * - Structured VU data (no regex parsing)
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { ExponentialBackoff, type ControlIpcMessage } from '@media-router/shared-types';
import type { PadLinkRule } from '../plugins/PluginModule.js';

let pyProcess: ChildProcess | null = null;
let currentState: 'stopped' | 'playing' | 'error' = 'stopped';
let useStdioForData = false;
let restartOnError = false;
let lastPipelineString = '';
let restartTimer: ReturnType<typeof setTimeout> | null = null;

// Restart policy:
//   - 1s base, 5s cap — fast recovery for transient errors.
//   - No attempt cap (0 = unlimited): a long stream outage shouldn't make us
//     give up forever. The outer GstChildProcess layer also retries via its
//     own backoff, but it only sees gst-runner *process* exits, not
//     pipeline-internal failures, so abandoning here means silent death.
//   - 30s stable PLAYING marks attempts back to zero so transient blips don't
//     accumulate over long sessions.
const restartBackoff = new ExponentialBackoff(1000, 5000, 0, 30_000);

// Pending get_property/get_stats requests waiting for response from Python
const pendingRequests = new Map<
    string,
    { requestId: string; timer: ReturnType<typeof setTimeout> }
>();

// Path to the Python runner script (same directory as this file)
const PYTHON_RUNNER = path.resolve(__dirname, 'gst-pipeline-runner.py');

// --- IPC message handling (to parent Node.js process) ---

function sendToParent(msg: ControlIpcMessage): void {
    // Channel may be closed during graceful shutdown — late Python events
    // (stateChange on SIGTERM, final vu) would otherwise crash the child
    // with ERR_IPC_CHANNEL_CLOSED.
    if (!process.connected) return;
    try {
        process.send?.(msg);
    } catch {
        /* channel closed mid-write */
    }
}

function sendEvent(action: string, data?: unknown): void {
    sendToParent({ id: '', type: 'event', action, data });
}

function sendResponse(requestId: string, data?: unknown): void {
    sendToParent({ id: requestId, type: 'response', action: '', data });
}

// --- Python JSON event parsing ---

function handlePythonEvent(eventJson: Record<string, unknown>): void {
    const event = eventJson.event as string;

    switch (event) {
        case 'ready':
        case 'started':
            // No-op — the `Starting pipeline (...)` log already covers it.
            break;

        case 'state_change': {
            const state = eventJson.state as string;
            if (state === 'playing' && currentState !== 'playing') {
                currentState = 'playing';
                restartBackoff.markStable(); // Reset attempts after sustained PLAYING
                sendEvent('stateChange', { state: 'playing' });
            } else if (state === 'paused') {
                sendEvent('stateChange', { state: 'paused' });
            } else if (state === 'null') {
                currentState = 'stopped';
                sendEvent('stateChange', { state: 'stopped' });
            }
            break;
        }

        case 'vu_data':
            sendEvent('vuData', { peak: eventJson.peak });
            break;

        case 'error':
            currentState = 'error';
            console.error(
                `[gst-runner] Pipeline ERROR: ${eventJson.message}${eventJson.debug ? ` (${eventJson.debug})` : ''}`,
            );
            sendEvent('error', { message: eventJson.message });
            sendEvent('stateChange', { state: 'error' });
            if (restartOnError) scheduleRestart();
            break;

        case 'eos':
            console.error('[gst-runner] Pipeline EOS');
            currentState = 'stopped';
            sendEvent('stateChange', { state: 'stopped' });
            if (restartOnError) scheduleRestart();
            break;

        case 'pad_linked':
            console.error(
                `[gst-runner] Pad linked: rule=${eventJson.rule} index=${eventJson.index} pad=${eventJson.padName}`,
            );
            break;

        case 'property':
        case 'stats': {
            // Response to a get_property or get_stats request
            const id = eventJson.id as string;
            if (id) {
                const pending = pendingRequests.get(id);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRequests.delete(id);
                    sendResponse(pending.requestId, eventJson);
                }
            }
            break;
        }

        case 'property_set':
        case 'tracking':
            // Confirmations — nothing to relay
            break;

        case 'throughput': {
            const id = eventJson.id as string;
            if (id) {
                const pending = pendingRequests.get(id);
                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRequests.delete(id);
                    sendResponse(pending.requestId, eventJson);
                }
            }
            break;
        }
    }
}

/** Parse stderr from Python runner — look for GST_JSON: prefixed lines. */
function handlePythonStderr(data: Buffer): void {
    const text = data.toString();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('GST_JSON:')) {
            try {
                const json = JSON.parse(trimmed.substring(9));
                handlePythonEvent(json);
            } catch {
                // Not valid JSON — ignore
            }
        } else {
            // Forward raw GStreamer / Python stderr to engine logs so plugin
            // pipeline errors are visible. Without this, anything that doesn't
            // come through the bus (parse errors, GStreamer warnings, Python
            // tracebacks) is silently dropped.
            console.error(`[gst-py] ${trimmed}`);
        }
    }
}

/** Parse fd 4 output from Python runner (data-pipe mode). */
function handlePythonEventFd(data: Buffer): void {
    const text = data.toString();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('GST_JSON:')) {
            try {
                const json = JSON.parse(trimmed.substring(9));
                handlePythonEvent(json);
            } catch {
                /* ignore */
            }
        } else if (trimmed) {
            // Plain JSON line (no prefix on fd 4)
            try {
                const json = JSON.parse(trimmed);
                handlePythonEvent(json);
            } catch {
                /* ignore */
            }
        }
    }
}

// --- Send JSON command to Python runner ---

function sendToPython(cmd: Record<string, unknown>): void {
    if (!pyProcess) return;

    const line = JSON.stringify(cmd) + '\n';

    if (useStdioForData) {
        // Data-pipe mode: commands go on fd 3
        const cmdStream = (pyProcess.stdio as any)?.[3];
        if (cmdStream?.writable) {
            cmdStream.write(line);
        }
    } else {
        // Bus-messages mode: commands go on stdin
        pyProcess.stdin?.write(line);
    }
}

// --- Pipeline management ---

function scheduleRestart(): void {
    if (restartTimer) return;
    const delay = restartBackoff.nextDelay();
    if (delay === null) return; // unreachable with maxAttempts=0; defensive
    console.error(
        `[gst-runner] Restarting pipeline in ${delay}ms (attempt ${restartBackoff.attempts})`,
    );
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (lastPipelineString) {
            startPipeline(
                lastPipelineString,
                `restart-${restartBackoff.attempts}`,
                useStdioForData,
                lastPadLinkRules,
            );
        }
    }, delay);
}

let lastPadLinkRules: PadLinkRule[] = [];

function startPipeline(
    pipeline: string,
    requestId: string,
    stdioForData = false,
    padLinkRules: PadLinkRule[] = [],
): void {
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (pyProcess) {
        stopPipeline();
    }

    lastPipelineString = pipeline;
    lastPadLinkRules = padLinkRules;
    useStdioForData = stdioForData;
    const mode = stdioForData ? 'data-pipe' : 'bus-messages';
    // Log the full pipeline string — truncating it hides the failing element
    // when a plugin's pipeline is rejected by parse_launch.
    console.error(`[gst-runner] Starting pipeline (${mode}): ${pipeline}`);
    if (padLinkRules.length > 0) {
        console.error(`[gst-runner] Pad-link rules: ${JSON.stringify(padLinkRules)}`);
    }

    if (stdioForData) {
        // DATA MODE: stdin/stdout carry binary MPEG-TS data
        // fd 3 = commands (JSON), fd 4 = events (JSON)
        pyProcess = spawn('python3', [PYTHON_RUNNER], {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        });

        // Error handlers
        pyProcess.stdin!.on('error', () => {});
        pyProcess.stdout?.on('error', () => {});
        process.stdin.on('error', () => {});
        process.stdout.on('error', () => {});

        // Relay MPEG-TS data: parent stdin ↔ python stdin, python stdout ↔ parent stdout
        process.stdin.pipe(pyProcess.stdin!);
        pyProcess.stdout?.pipe(process.stdout);

        // Events come on fd 4
        const eventStream = (pyProcess.stdio as any)?.[4];
        if (eventStream) {
            eventStream.on('data', handlePythonEventFd);
        }

        // Also watch stderr for fallback/debug
        pyProcess.stderr?.on('data', handlePythonStderr);
    } else {
        // BUS MESSAGE MODE: stdin = commands, stderr = events, stdout = unused
        pyProcess = spawn('python3', [PYTHON_RUNNER], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Events come on stderr (GST_JSON: prefix)
        pyProcess.stderr?.on('data', handlePythonStderr);
    }

    // Capture this child locally — `pyProcess` may already point to a newer
    // spawn by the time this handler fires (a SIGKILL'd predecessor can take
    // hundreds of ms to reap). Without this guard the late exit would clobber
    // the live reference and trigger an extra cascade restart.
    const myProc = pyProcess;
    myProc.on('exit', (code, signal) => {
        console.error(`[gst-runner] Python runner exited: code=${code} signal=${signal}`);
        if (pyProcess !== myProc) return; // a successor has taken over
        currentState = 'stopped';
        sendEvent('stateChange', { state: 'stopped', exitCode: code, signal });
        pyProcess = null;
        // An unexpected exit (non-zero code or fatal signal) means the
        // pipeline died without going through the bus — e.g. decoder
        // segfault, OOM, GStreamer assertion. Treat the same as a bus error:
        // schedule a restart. Without this, the gst-runner stays alive with
        // no Python child and no recovery path; the outer GstChildProcess
        // can't see it because *this* process is still healthy.
        if (restartOnError && (code !== 0 || signal)) {
            sendEvent('error', {
                message: `Python runner exited unexpectedly (code=${code} signal=${signal ?? 'none'})`,
            });
            scheduleRestart();
        }
    });

    myProc.on('error', (err) => {
        if (pyProcess !== myProc) return;
        currentState = 'error';
        sendEvent('error', { message: err.message });
        sendEvent('stateChange', { state: 'error' });
    });

    // Send start command to Python runner
    sendToPython({
        cmd: 'start',
        pipeline,
        useStdioForData: stdioForData,
        linkOnPadAdded: padLinkRules,
    });

    sendResponse(requestId, { ok: true });
}

function killProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (!proc.pid) return;
    try {
        proc.kill(signal);
    } catch {
        /* already dead */
    }
}

function stopPipeline(): void {
    if (!pyProcess) return;

    console.error('[gst-runner] Stopping pipeline...');

    // Unpipe streams
    try {
        process.stdin.unpipe(pyProcess.stdin!);
    } catch {}
    try {
        pyProcess.stdout?.unpipe(process.stdout);
    } catch {}

    // Send stop command
    sendToPython({ cmd: 'stop' });

    // Give Python 2s to shut down gracefully, then force kill
    const killTimer = setTimeout(() => {
        if (pyProcess) {
            console.error('[gst-runner] Force killing Python runner...');
            killProcess(pyProcess, 'SIGKILL');
        }
    }, 2000);

    pyProcess.on('exit', () => {
        clearTimeout(killTimer);
    });
}

// --- Main IPC listener (from parent GstChildProcess) ---

process.on('message', (msg: ControlIpcMessage) => {
    switch (msg.action) {
        case 'startPipeline': {
            const d = msg.data as {
                pipeline: string;
                useStdioForData?: boolean;
                restartOnError?: boolean;
                linkOnPadAdded?: PadLinkRule[];
            };
            restartOnError = d.restartOnError ?? false;
            restartBackoff.reset();
            startPipeline(d.pipeline, msg.id, d.useStdioForData, d.linkOnPadAdded ?? []);
            break;
        }

        case 'stopPipeline':
            restartOnError = false; // Cancel any pending restarts
            restartBackoff.reset();
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            stopPipeline();
            sendResponse(msg.id, { ok: true });
            setTimeout(() => process.exit(0), 3000);
            break;

        case 'getState':
            sendResponse(msg.id, { state: currentState, pid: pyProcess?.pid });
            break;

        case 'setProperty': {
            const d = msg.data as { element: string; property: string; value: unknown };
            sendToPython({
                cmd: 'set_property',
                element: d.element,
                property: d.property,
                value: d.value,
            });
            sendResponse(msg.id, { ok: true });
            break;
        }

        case 'getProperty': {
            const d = msg.data as { element: string; property: string };
            const reqId = `prop_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            pendingRequests.set(reqId, {
                requestId: msg.id,
                timer: setTimeout(() => {
                    pendingRequests.delete(reqId);
                    sendResponse(msg.id, { error: 'Timeout waiting for property' });
                }, 5000),
            });
            sendToPython({
                cmd: 'get_property',
                element: d.element,
                property: d.property,
                id: reqId,
            });
            break;
        }

        case 'getStats': {
            const d = msg.data as { element: string };
            const reqId = `stats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            pendingRequests.set(reqId, {
                requestId: msg.id,
                timer: setTimeout(() => {
                    pendingRequests.delete(reqId);
                    sendResponse(msg.id, { error: 'Timeout waiting for stats' });
                }, 5000),
            });
            sendToPython({ cmd: 'get_stats', element: d.element, id: reqId });
            break;
        }

        case 'trackThroughput': {
            const d = msg.data as { element: string; pad?: string };
            sendToPython({ cmd: 'track_throughput', element: d.element, pad: d.pad ?? 'src' });
            sendResponse(msg.id, { ok: true });
            break;
        }

        case 'getThroughput': {
            const reqId = `tp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            pendingRequests.set(reqId, {
                requestId: msg.id,
                timer: setTimeout(() => {
                    pendingRequests.delete(reqId);
                    sendResponse(msg.id, { error: 'Timeout waiting for throughput' });
                }, 5000),
            });
            sendToPython({ cmd: 'get_throughput', id: reqId });
            break;
        }

        default:
            console.warn(`[gst-runner] Unknown action: ${msg.action}`);
            sendResponse(msg.id, { error: `Unknown action: ${msg.action}` });
    }
});

// --- Cleanup ---

function shutdown(reason: string): void {
    console.error(`[gst-runner] Shutting down: ${reason}`);
    // Disarm the auto-restart loop before we kill the child, otherwise the
    // child's exit handler will spawn a fresh Python within our 1.5s exit
    // window — which then gets killed by the process.on('exit') SIGKILL
    // fallback, leaking a Python child every shutdown.
    restartOnError = false;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    // Kill Python immediately — don't rely on timers that may not fire
    if (pyProcess) {
        sendToPython({ cmd: 'stop' });
        killProcess(pyProcess, 'SIGTERM');
        // Schedule SIGKILL as fallback
        const py = pyProcess;
        setTimeout(() => {
            try {
                killProcess(py, 'SIGKILL');
            } catch {}
        }, 1000);
    }
    setTimeout(() => process.exit(0), 1500);
}

process.on('disconnect', () => shutdown('parent disconnected'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Emergency cleanup: if this process exits for any reason, kill Python
process.on('exit', () => {
    if (pyProcess && pyProcess.pid) {
        try {
            process.kill(pyProcess.pid, 'SIGKILL');
        } catch {}
    }
});
