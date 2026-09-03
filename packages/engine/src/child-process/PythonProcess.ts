import { spawn, type ChildProcess } from 'child_process';
import type { PadLinkRule, BusReport, RistRunnerConfig, TsProbeRunnerConfig, RenderWatchRunnerConfig, KeyframeGateConfig, BacklogShedConfig, PreserveSourceTimelineConfig } from '../plugins/PluginModule.js';
import type { ClockConfig } from './ClockAuthority.js';
import { pluginPythonPaths } from './nativeBinaries.js';
import { runnerEnv } from './runnerEnv.js';

export type PythonEventHandler = (event: Record<string, unknown>) => void;

/**
 * How long a `stop`ped Python runner gets before SIGKILL.
 *
 * LOAD-BEARING: the runner EOS-drains the pipeline before taking it to NULL
 * (`EOS_DRAIN_TIMEOUT_MS` in gst-pipeline-runner.py) so the Pi's stateless HEVC
 * decoder is never stopped mid-decode — a mid-decode STREAMOFF wedges the
 * kernel driver in an uninterruptible wait and takes the box down. SIGKILLing
 * halfway through that drain re-arms exactly the bug the drain avoids, so this
 * window must stay above the drain timeout plus the NULL transition. Pinned by
 * eosDrainContract.test.ts.
 *
 * Head of the derived chain: 6000 ms drain → 8000 here → GstRunner's
 * SHUTDOWN_KILL_MS/SHUTDOWN_EXIT_MS/STOP_PIPELINE_EXIT_MS → GstChildProcess's
 * GST_RUNNER_KILL_TIMEOUT_MS. Widen from the top; the rest follow.
 */
export const FORCE_KILL_TIMEOUT_MS = 8000;

/**
 * Everything the Python runner needs to start (and replay on restart) a
 * pipeline — the runner-relevant subset of PipelineDescription, passed verbatim
 * through GstChildProcess → GstRunner → here → Python. A new runner knob is one
 * field here + one `data.get()` in the runner; no positional args to drift out
 * of sync (which is how `decoderThreadType` was silently lost before).
 */
export interface RunnerStartOptions {
    pipeline: string;
    useStdioForData?: boolean;
    linkOnPadAdded?: PadLinkRule[];
    readKlvNames?: boolean;
    /** Applied at fork (spawn env), not sent in the start command. */
    env?: Record<string, string>;
    clock?: ClockConfig;
    timeSyncContract?: boolean;
    /** Contract clock WITHOUT the base-time zeroing — see
     *  `PipelineDescription.liveCaptureClock`. Only read under the contract. */
    liveCaptureClock?: boolean;
    decoderThreadType?: 'auto' | 'frame';
    busReports?: BusReport[];
    rist?: RistRunnerConfig;
    tsProbe?: TsProbeRunnerConfig;
    renderWatch?: RenderWatchRunnerConfig;
    keyframeGate?: KeyframeGateConfig;
    backlogShed?: BacklogShedConfig;
    preserveSourceTimeline?: PreserveSourceTimelineConfig;
}

export interface PythonProcessOptions {
    pythonRunnerPath: string;
    /**
     * Data-pipe mode: parent stdin/stdout carry binary MPEG-TS, commands go on
     * fd 3, events come on fd 4. Bus-messages mode: commands go on stdin,
     * events come on stderr (GST_JSON: prefix).
     */
    useStdioForData: boolean;
    onEvent: PythonEventHandler;
    /** Fires once the spawned process exits. */
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    /** Spawn-time failure (ENOENT, etc.). */
    onSpawnError: (err: Error) => void;
}

/**
 * Owns one `gst-pipeline-runner.py` child: spawn + stdio wiring, JSON event
 * parsing, command writing, kill. One Python lifetime per instance — the
 * `GstRunner` constructs a fresh `PythonProcess` for every (re)start.
 *
 * Late events from a stopped/replaced instance still fire callbacks; the
 * caller decides whether to ignore them by tracking which instance is current
 * (the `pyProcess !== myProc` guard previously inside `GstRunner`).
 */
export class PythonProcess {
    private proc: ChildProcess | null = null;

    constructor(private readonly options: PythonProcessOptions) {}

    get pid(): number | undefined {
        return this.proc?.pid;
    }

    /**
     * Spawn the Python runner and send the initial `start` command. Returns
     * once the process is spawned (not when GStreamer reaches PLAYING).
     *
     * `env` is merged on top of the runner env (`runnerEnv`: this process's
     * env plus Wayland seeding and the allocator cap) — values that
     * must be visible *before* `Gst.init()` runs in the child (e.g. the
     * runner's `MR_GLIB_PRGNAME` hook for pre-init `GLib.set_prgname`).
     * The contents are plugin-defined; the engine just passes them through.
     * A fresh `PythonProcess` is constructed for every pipeline (re)start,
     * so each spawn sees the env intended for that specific pipeline.
     */
    start(opts: RunnerStartOptions): void {
        if (this.proc) throw new Error('PythonProcess already started');
        const { pipeline, linkOnPadAdded = [], env = {} } = opts;

        const mode = this.options.useStdioForData ? 'data-pipe' : 'bus-messages';
        // Log the full pipeline string — truncating it hides the failing element
        // when a plugin's pipeline is rejected by parse_launch.
        console.error(`[gst-runner] Starting pipeline (${mode}): ${pipeline}`);
        if (linkOnPadAdded.length > 0) {
            console.error(`[gst-runner] Pad-link rules: ${JSON.stringify(linkOnPadAdded)}`);
        }

        const spawnEnv = { ...runnerEnv(), ...env };
        // Plugin-owned python (plugins/*/py) must be importable by the runner
        // (e.g. `import librist`, `import ts_psi`) — prepend those dirs so
        // repo-shipped modules win over anything system-wide. The runner's own
        // dir stays first overall (python puts the script dir at sys.path[0]).
        const pyPaths = pluginPythonPaths();
        if (pyPaths.length > 0) {
            spawnEnv.PYTHONPATH = [...pyPaths, spawnEnv.PYTHONPATH]
                .filter(Boolean)
                .join(':');
        }

        if (this.options.useStdioForData) {
            this.proc = spawn('python3', [this.options.pythonRunnerPath], {
                stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
                env: spawnEnv,
            });

            // Error handlers — Python can exit between our `.writable` check
            // and the actual `write()`, surfacing EPIPE async on the stream.
            // Without these the unhandled 'error' event crashes the runner.
            this.proc.stdin!.on('error', () => {});
            this.proc.stdout?.on('error', () => {});
            this.proc.stderr?.on('error', () => {});
            const cmdStream = (this.proc.stdio as Array<NodeJS.WritableStream | null>)[3];
            cmdStream?.on('error', () => {});
            const eventStream = (this.proc.stdio as Array<NodeJS.ReadableStream | null>)[4];
            eventStream?.on('error', () => {});
            process.stdin.on('error', () => {});
            process.stdout.on('error', () => {});

            // Relay MPEG-TS data: parent stdin ↔ python stdin, python stdout ↔ parent stdout
            process.stdin.pipe(this.proc.stdin!);
            this.proc.stdout?.pipe(process.stdout);

            // Events on fd 4
            if (eventStream) eventStream.on('data', this.parseEventFd);
            // Also watch stderr for fallback/debug
            this.proc.stderr?.on('data', this.parseStderr);
        } else {
            this.proc = spawn('python3', [this.options.pythonRunnerPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: spawnEnv,
            });

            // Mirror the data-mode error handlers (EPIPE during the narrow window
            // between sendCommand and Python exit used to crash the runner).
            this.proc.stdin?.on('error', () => {});
            this.proc.stdout?.on('error', () => {});
            this.proc.stderr?.on('error', () => {});

            // Events come on stderr (GST_JSON: prefix)
            this.proc.stderr?.on('data', this.parseStderr);
        }

        this.proc.on('exit', (code, signal) => {
            console.error(`[gst-runner] Python runner exited: code=${code} signal=${signal}`);
            this.options.onExit(code, signal);
        });
        this.proc.on('error', (err) => this.options.onSpawnError(err));

        // Pass the options verbatim (minus `env`, which is applied at spawn).
        // `useStdioForData` is fixed at construction, so it wins.
        const { env: _env, ...cmdOpts } = opts;
        this.sendCommand({
            cmd: 'start',
            ...cmdOpts,
            useStdioForData: this.options.useStdioForData,
        });
    }

    sendCommand(cmd: Record<string, unknown>): void {
        if (!this.proc) return;
        const line = JSON.stringify(cmd) + '\n';

        // Wrap the write so an EPIPE during the narrow window between Python's
        // `exit` and the engine's bookkeeping reassignment doesn't escape as
        // an uncaught synchronous throw. The async path is handled by the
        // `.on('error', ...)` listeners installed in `start`.
        try {
            if (this.options.useStdioForData) {
                const cmdStream = (this.proc.stdio as Array<NodeJS.WritableStream | null>)[3];
                if (cmdStream?.writable) cmdStream.write(line);
            } else if (this.proc.stdin?.writable) {
                this.proc.stdin.write(line);
            }
        } catch (err) {
            console.error('[gst-runner] sendToPython failed:', err);
        }
    }

    /**
     * Send `stop`, unpipe binary streams, then SIGKILL after
     * `FORCE_KILL_TIMEOUT_MS` if Python hasn't exited (it EOS-drains the
     * pipeline first, so the exit is not immediate). Caller is responsible for
     * not calling `start` again on this instance — construct a new
     * `PythonProcess` for the next pipeline.
     */
    stop(): void {
        if (!this.proc) return;
        const proc = this.proc;
        console.error('[gst-runner] Stopping pipeline...');

        // Only the data-pipe mode (fork only) ever piped the host's stdio in;
        // in-process the host is the ENGINE, whose stdin/stdout are not ours.
        if (this.options.useStdioForData) {
            try {
                process.stdin.unpipe(proc.stdin!);
            } catch {
                /* nothing piped */
            }
            try {
                proc.stdout?.unpipe(process.stdout);
            } catch {
                /* nothing piped */
            }
        }

        this.sendCommand({ cmd: 'stop' });

        const killTimer = setTimeout(() => {
            if (proc.pid) {
                console.error('[gst-runner] Force killing Python runner...');
                this.killProcess(proc, 'SIGKILL');
            }
        }, FORCE_KILL_TIMEOUT_MS);

        proc.once('exit', () => clearTimeout(killTimer));
    }

    kill(signal: NodeJS.Signals): void {
        if (this.proc) this.killProcess(this.proc, signal);
    }

    /** Last-ditch sync cleanup from `process.on('exit')`. */
    emergencyKill(): void {
        if (this.proc?.pid) {
            try {
                process.kill(this.proc.pid, 'SIGKILL');
            } catch (err) {
                console.error('[gst-runner] Emergency SIGKILL on exit failed:', err);
            }
        }
    }

    private killProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
        if (!proc.pid) return;
        try {
            proc.kill(signal);
        } catch {
            /* already dead */
        }
    }

    // --- event parsing ---

    private parseStderr = (data: Buffer): void => {
        const text = data.toString();
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('GST_JSON:')) {
                this.dispatch(trimmed.substring(9));
            } else {
                // Forward raw GStreamer / Python stderr to engine logs so plugin
                // pipeline errors are visible. Without this, anything that doesn't
                // come through the bus (parse errors, GStreamer warnings, Python
                // tracebacks) is silently dropped.
                console.error(`[gst-py] ${trimmed}`);
            }
        }
    };

    private parseEventFd = (data: Buffer): void => {
        const text = data.toString();
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.dispatch(trimmed.startsWith('GST_JSON:') ? trimmed.substring(9) : trimmed);
        }
    };

    /**
     * Parse one event line and hand it to the runner. The parse failure is
     * ignored (a non-JSON line on the event channel is noise), but a throw
     * from the HANDLER is logged — it used to be swallowed by the same catch,
     * which hid real bugs and, now that the runner shares the engine process,
     * is the one place a handler fault must be visible.
     */
    private dispatch(jsonText: string): void {
        let json: Record<string, unknown>;
        try {
            json = JSON.parse(jsonText);
        } catch {
            return; // not valid JSON — ignore
        }
        try {
            this.options.onEvent(json);
        } catch (err) {
            console.error('[gst-runner] Python event handler threw:', err);
        }
    }
}
