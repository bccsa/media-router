import { EventEmitter } from 'events';
import * as path from 'path';
import { createLogger, ExponentialBackoff } from '@media-router/shared-types';
import type { RunnerChannel } from './ControlIpc.js';
import type { RunnerBackend } from './RunnerBackend.js';
import { InProcessRunnerHost } from './InProcessRunnerHost.js';
import { ForkedRunnerBackend } from './ForkedRunnerBackend.js';
import type { PipelineDescription } from '../plugins/PluginModule.js';

const log = createLogger('GstChildProcess');

const MAX_RESTARTS = 10;

/**
 * How long a runner gets to finish shutting down before its Python is
 * SIGKILLed. Must outlast the runner's own shutdown budget, which in turn
 * outlasts the Python EOS drain (`EOS_DRAIN_TIMEOUT_MS`) — see `stop()`.
 *
 * Tail of the chain: 6000 ms drain → 8000 FORCE_KILL_TIMEOUT_MS → 8500
 * SHUTDOWN_EXIT_MS in GstRunner → 9000 here. In-process it caps the wait for
 * the hosted runner to hand itself back; under the fork it is the SIGTERM →
 * SIGKILL window on the shim (whose exit hook SIGKILLs Python).
 */
const GST_RUNNER_KILL_TIMEOUT_MS = 9000;

/**
 * Rollback switch: `MR_GST_RUNNER_FORK=1` puts every runner back behind a
 * forked `gst-runner.js` shim (one extra node process per module — ~60 MB RSS
 * on a Pi 4 — which is what hosting the runner in-process removes). Read per
 * spawn so a test can flip it; documented in ADR-0012.
 */
export function useForkedRunner(): boolean {
    return process.env.MR_GST_RUNNER_FORK === '1';
}

/**
 * Reject when a Python-side RPC handler emitted `command_error` (surfaced by
 * the gst-runner as `{ error: "..." }` on the response). Without this the
 * caller silently gets `undefined` / `{}` and never knows the call failed.
 *
 * Exported for direct testing — the production callers are the wrappers in
 * this file (setProperty / getProperty / getStats / trackThroughput /
 * getThroughput), but the contract belongs to its own unit test so the
 * bridge between Python command_error and a thrown Error is locked in.
 */
export function throwIfRpcError(result: unknown, label: string): void {
    const err = (result as { error?: unknown } | null | undefined)?.error;
    if (typeof err === 'string') throw new Error(`${label}: ${err}`);
}

/**
 * One module's GStreamer runner: a `GstRunner` hosted in this process
 * (`InProcessRunnerHost`) that owns the module's python
 * `gst-pipeline-runner.py` child — or, under `MR_GST_RUNNER_FORK=1`, the same
 * runner behind a forked `gst-runner.js` shim.
 *
 * Manages lifecycle (start, stop, restart), monitors health,
 * and provides typed event subscriptions.
 *
 * Emits:
 *   - 'stateChange' (state) — pipeline state change
 *   - 'vuData' (data) — VU meter data
 *   - 'pluginEvent' ({channel, payload}) — generic pipeline→plugin data
 *   - 'error' (data) — error from pipeline
 *   - 'exit' (code) — the runner finished (in-process: after `stop()`;
 *     fork: the shim process exited)
 */
export class GstChildProcess extends EventEmitter {
    private backend: RunnerBackend | null = null;
    /** `backend.channel` — its own field so tests can inject a fake channel. */
    private ipc: RunnerChannel | null = null;
    private pipelineDesc: PipelineDescription | null = null;
    private running = false;
    private backoff = new ExponentialBackoff(3000, 60000, MAX_RESTARTS, 30000);
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    /** Fork backend only: an explicit shim script (tests); default resolved by the backend. */
    private readonly gstRunnerPath: string | undefined;
    private readonly pythonRunnerPath = path.resolve(__dirname, 'gst-pipeline-runner.py');
    /**
     * Last value set per element property since `start()`. Replayed on every
     * PLAYING transition: any restart layer (runner-internal Python respawn or
     * a full gst-runner respawn) rebuilds the pipeline from the original
     * string, which carries only start-time values — without the replay, live
     * changes (volume, overlay text, encoder bitrate…) silently revert.
     */
    private stickyProps = new Map<string, { element: string; property: string; value: unknown }>();

    constructor(gstRunnerPath?: string) {
        super();
        this.gstRunnerPath = gstRunnerPath;
    }

    /** Start a GStreamer pipeline. */
    async start(desc: PipelineDescription): Promise<void> {
        if (this.destroyed) throw new Error('GstChildProcess is destroyed');

        this.pipelineDesc = desc;
        this.stickyProps.clear(); // fresh description = fresh baseline
        await this.spawnChild();
    }

    private async spawnChild(): Promise<void> {
        if (!this.pipelineDesc) return;

        // Clean up previous runner/ipc if restarting (prevents listener leaks)
        this.cleanup();

        const backend = useForkedRunner()
            ? new ForkedRunnerBackend(this.gstRunnerPath)
            : this.hostRunner(this.pipelineDesc);
        if (!backend) return;
        this.backend = backend;
        this.ipc = backend.channel;
        this.wireRunnerEvents(this.ipc);
        backend.onExit((code) => {
            if (this.backend !== backend) return; // superseded — a later start owns the state
            this.running = false;
            this.emit('exit', code);
            // A hosted runner only ever hands back with 0, after stop(); a
            // non-zero code is the fork's shim dying — respawn it.
            if (!this.destroyed && this.pipelineDesc && code !== 0) {
                this.clearRestartTimer();
                this.scheduleRestart();
            }
        });

        // Send the pipeline to the runner
        try {
            await this.ipc.sendRequest('startPipeline', this.startPayload(this.pipelineDesc));
        } catch (err) {
            // Synthesised by this layer, not posted by the gst bus: it names no
            // element, so plugins doing per-element attribution (video-player's
            // decoder demotion) must be able to tell it apart — hence `kind`.
            this.emit('error', {
                kind: 'spawn_failed',
                message: `Failed to start pipeline: ${err}`,
            });
        }
    }

    /**
     * Default backend: host the runner here. There is no process to die
     * unexpectedly, so no outer restart loop — the runner's own restart loop
     * (bus error / Python exit → respawn Python) is the whole recovery path,
     * and `exit` fires only after `stop()` has finished with it.
     */
    private hostRunner(desc: PipelineDescription): InProcessRunnerHost | null {
        if (desc.useStdioForData) {
            // The data-pipe mode relays MPEG-TS over the SHIM's stdin/stdout;
            // hosted in the engine those would be the engine's own stdio. No
            // plugin uses it — refuse loudly rather than wire the engine's
            // stdin into a pipeline.
            this.emit('error', {
                kind: 'spawn_failed',
                message:
                    'useStdioForData needs the forked runner (MR_GST_RUNNER_FORK=1); in-process runners carry data on the unixfd bus',
            });
            return null;
        }
        return new InProcessRunnerHost(this.pythonRunnerPath);
    }

    /** Route the runner's events to this emitter (same wiring for both backends). */
    private wireRunnerEvents(ipc: RunnerChannel): void {
        // Same wiring for both backends — the module never sees which one runs.
        ipc.on('stateChange', (data) => {
            const { state } = data as { state: string };
            if (state === 'playing') {
                this.running = true;
                this.startStabilityTimer();
                // Replay live property changes BEFORE announcing PLAYING —
                // Python executes commands in order, so anything a listener
                // (e.g. a plugin's onPipelinePlaying) sets afterwards
                // deterministically wins over the replayed values. If the
                // pipeline dies during the replay (fast-crash-after-PLAYING),
                // a stopped/error event has already flipped `running` false —
                // drop the stale 'playing' instead of announcing a dead
                // pipeline healthy.
                void this.replayStickyProps().finally(() => {
                    if (this.running) this.emit('stateChange', data);
                });
                return;
            }
            if (state === 'stopped' || state === 'error') {
                this.running = false;
            }
            this.emit('stateChange', data);
        });

        ipc.on('vuData', (data) => {
            this.emit('vuData', data);
        });

        // Generic pipeline→plugin data channel (channel + payload). Pure
        // passthrough — the module decides what to do with each channel (e.g.
        // `level:sclevel` for the audio-dynamics ducker, `stream:discovered` /
        // `stream:names` for the mpegts demuxer's inspector).
        ipc.on('pluginEvent', (data) => {
            this.emit('pluginEvent', data);
        });

        ipc.on('error', (data) => {
            this.emit('error', data);
        });

        // unixfd socket-gate progress: the runner is waiting (indefinitely)
        // for producer edge sockets before launching the pipeline. Forwarded
        // so the module can surface a health warning naming the pending
        // sockets — without it a gated module reports healthy while nothing
        // runs. `pending: []` clears the signal (gate opened).
        ipc.on('busGate', (data) => {
            this.emit('busGate', data);
        });
    }

    /**
     * The runner-relevant subset of the description, enumerated EXPLICITLY
     * (a field missing here is silently lost — the decoderThreadType trap).
     * Shared by `startPipeline` and `updatePipelineDesc` so the replay copy
     * can never drift from the start copy.
     */
    private startPayload(desc: PipelineDescription): Record<string, unknown> {
        return {
            pipeline: desc.pipeline,
            useStdioForData: desc.useStdioForData ?? false,
            restartOnError: desc.restartOnError ?? false,
            restartBackoffMs: desc.restartBackoffMs,
            linkOnPadAdded: desc.linkOnPadAdded ?? [],
            readKlvNames: desc.readKlvNames ?? false,
            env: desc.env ?? {},
            clock: desc.clock,
            timeSyncContract: desc.timeSyncContract ?? false,
            liveCaptureClock: desc.liveCaptureClock ?? false,
            decoderThreadType: desc.decoderThreadType ?? 'auto',
            busReports: desc.busReports ?? [],
            rist: desc.rist,
            tsProbe: desc.tsProbe,
            renderWatch: desc.renderWatch,
            keyframeGate: desc.keyframeGate,
            backlogShed: desc.backlogShed,
            preserveSourceTimeline: desc.preserveSourceTimeline,
            alignBranchesToStamps: desc.alignBranchesToStamps,
            inputStallWatch: desc.inputStallWatch,
        };
    }

    /**
     * Stop the pipeline and its runner. The backend owns the teardown shape
     * (see `InProcessRunnerHost.stop` / `ForkedRunnerBackend.stop`); the kill
     * window is the same for both and pinned by eosDrainContract.test.ts.
     */
    async stop(): Promise<void> {
        this.clearRestartTimer();
        this.backoff.reset();
        // Prevent auto-restart from firing
        this.pipelineDesc = null;
        this.stickyProps.clear();

        const backend = this.backend;
        if (backend) await backend.stop(GST_RUNNER_KILL_TIMEOUT_MS);
        this.cleanup();
    }

    /** Destroy — stop and prevent restarts. */
    async destroy(): Promise<void> {
        this.destroyed = true;
        await this.stop();
        this.backoff.destroy();
        this.removeAllListeners();
    }

    /** Fork backend only: the shim's stdin (data-pipe mode, MPEG-TS in). */
    getStdin() {
        return this.backend instanceof ForkedRunnerBackend ? this.backend.stdin : null;
    }

    /** Fork backend only: the shim's stdout (data-pipe mode, MPEG-TS out). */
    getStdout() {
        return this.backend instanceof ForkedRunnerBackend ? this.backend.stdout : null;
    }

    // --- Live element control ---

    /**
     * Push the KLV name carousel payload to the runner (mpegts muxer, Phase 2).
     * Fire-and-forget: the runner stores it and (re)starts the ~1 s carousel on
     * the metadata appsrc, so a name edit updates downstream labels without a
     * pipeline rebuild. No ack needed — the channel is report-only (D6), and a
     * dropped update is corrected by the next carousel tick.
     */
    sendKlvPayload(element: string, payload: string): void {
        // Gate only on the IPC channel — NOT on `running` (which flips true only
        // on the 'playing' state change). mpegtsmux is an aggregator: it never
        // reaches PLAYING until its KLV metadata pad receives a buffer, but that
        // buffer can only be seeded via this call — so gating on `running` is a
        // deadlock (no PLAYING → no send → no KLV → no PLAYING), and the whole
        // A/V mux produces no output. The runner stores the payload the moment
        // its IPC is up and its carousel pushes it onto the appsrc as soon as
        // the element exists, unblocking the mux.
        if (!this.ipc) return;
        this.ipc.sendEvent('setKlvPayload', { element, payload });
    }

    /**
     * Attach a per-consumer bus fan-out branch (`tee. ! queue leaky ! unixfdsink`)
     * on the producer's egress tee, so a new consumer reads its own isolated
     * socket. Fire-and-forget, and gated only on IPC — NOT on `running`: the
     * BusFanoutCoordinator re-attaches on the producer's 'playing' edge (a fresh
     * restartOnError process rebuilds from the base string with no branches), and
     * the attach must be queued to the runner the moment its IPC is up. The runner
     * is idempotent per socket, so a duplicate attach is a no-op.
     */
    sendBusAttach(tee: string, socket: string): void {
        if (!this.ipc) {
            // Pre-fork (or post-destroy): there is no runner to queue it in.
            // Left as a drop on purpose — the coordinator re-attaches on the
            // producer's next PLAYING edge — but logged, because the same
            // silent `return` inside the RUNNER stranded consumers for the
            // whole of a producer's socket gate.
            log.debug({ tee, socket }, 'sendBusAttach dropped — no runner IPC yet');
            return;
        }
        this.ipc.sendEvent('busAttach', { tee, socket });
    }

    /** Detach a per-consumer bus fan-out branch by its edge socket. Fire-and-forget. */
    sendBusDetach(socket: string): void {
        if (!this.ipc) return;
        this.ipc.sendEvent('busDetach', { socket });
    }

    /**
     * Live input re-point (single-input bus sinks): re-target the named
     * `unixfdsrc` at a new edge socket without rebuilding the pipeline — the
     * make-before-break half of a source swap. Tracked RPC (NOT fire-and-
     * forget): it resolves only once the Python side has the new source
     * linked and playing, so the caller may then safely detach the OLD edge.
     */
    async busReinput(element: string, socket: string): Promise<void> {
        if (!this.ipc || !this.running) throw new Error('busReinput: pipeline not running');
        const result = await this.ipc.sendRequest('busReinput', { element, socket }, 5000);
        throwIfRpcError(result, `busReinput(${element})`);
    }

    /**
     * Replace the stored pipeline description after a live mutation (input
     * swap): the fork-layer restart path rebuilds from `pipelineDesc`, and
     * the runner-layer respawn replays its own copy — without this update a
     * later crash-restart replays the ORIGINAL description and gates forever
     * on an edge socket that no longer exists.
     */
    async updatePipelineDesc(desc: PipelineDescription): Promise<void> {
        this.pipelineDesc = desc;
        if (!this.ipc || !this.running) return;
        await this.ipc.sendRequest('updatePipeline', this.startPayload(desc), 2000);
    }

    /** Set a property on a named GStreamer element (live, no restart). */
    async setProperty(element: string, property: string, value: unknown): Promise<void> {
        // Record the intent first: a change made while the pipeline is down or
        // mid-restart is applied by the next PLAYING replay instead of lost.
        // The key separator is an escaped NUL — a character that cannot occur in a
        // gst element or property name, so `a\0b` and `ab\0` can never collide.
        // Escaped, not literal: a raw NUL in the source is invisible in editors,
        // diffs and reviews (it read as `${element}${property}` for months).
        this.stickyProps.set(`${element}\u0000${property}`, { element, property, value });
        if (!this.ipc || !this.running) return;
        const result = await this.ipc.sendRequest(
            'setProperty',
            { element, property, value },
            2000,
        );
        throwIfRpcError(result, `setProperty(${element}.${property})`);
    }

    /** Re-apply every recorded live property (see `stickyProps`). */
    private async replayStickyProps(): Promise<void> {
        if (this.stickyProps.size === 0) return;
        const results = await Promise.allSettled(
            [...this.stickyProps.values()].map((p) =>
                this.setProperty(p.element, p.property, p.value),
            ),
        );
        for (const r of results) {
            if (r.status === 'rejected') {
                log.debug({ err: r.reason }, 'Sticky property replay failed');
            }
        }
    }

    /** Get a property from a named GStreamer element. */
    async getProperty(element: string, property: string): Promise<unknown> {
        if (!this.ipc || !this.running) return undefined;
        const result = await this.ipc.sendRequest('getProperty', { element, property });
        throwIfRpcError(result, `getProperty(${element}.${property})`);
        return (result as any)?.value;
    }

    /** Read the 'stats' property from a named element (e.g. srtsrc). Returns a dict. */
    async getStats(element: string): Promise<Record<string, unknown>> {
        if (!this.ipc || !this.running) return {};
        const result = await this.ipc.sendRequest('getStats', { element });
        throwIfRpcError(result, `getStats(${element})`);
        return (result as any)?.data ?? {};
    }

    /** Start tracking throughput on a named element's pad. */
    async trackThroughput(element: string, pad = 'src'): Promise<void> {
        if (!this.ipc || !this.running) return;
        const result = await this.ipc.sendRequest('trackThroughput', { element, pad });
        throwIfRpcError(result, `trackThroughput(${element})`);
    }

    /** Get current throughput for all tracked elements. */
    async getThroughput(): Promise<
        Record<string, { total_bytes: number; bitrate_kbps: number; bitrate_mbps: number }>
    > {
        if (!this.ipc || !this.running) return {};
        const result = await this.ipc.sendRequest('getThroughput', {});
        throwIfRpcError(result, 'getThroughput');
        return (result as any)?.data ?? {};
    }

    /**
     * PID of the process this runner owns: the Python child in-process, the
     * shim under the fork (whose own exit hook reaps its Python).
     */
    get pid(): number | undefined {
        return this.backend?.pid;
    }

    /** Whether the pipeline is currently running. */
    get isRunning(): boolean {
        return this.running;
    }

    // --- Restart policy ---

    private scheduleRestart(): void {
        const delay = this.backoff.nextDelay();
        if (delay === null) {
            log.error({ maxRestarts: MAX_RESTARTS }, 'Max restarts reached, giving up');
            // Synthesised (see `spawn_failed` above) — the restart policy gave
            // up; no element posted this.
            this.emit('error', { kind: 'max_restarts', message: `Max restarts reached` });
            return;
        }

        log.info(
            { delayMs: delay, attempt: this.backoff.attempts, maxRestarts: MAX_RESTARTS },
            'Restarting',
        );

        this.restartTimer = setTimeout(async () => {
            if (!this.destroyed && this.pipelineDesc) {
                try {
                    await this.spawnChild();
                } catch (err) {
                    log.error({ err }, 'Restart failed');
                    this.scheduleRestart();
                }
            }
        }, delay);
    }

    private startStabilityTimer(): void {
        this.backoff.markStable();
    }

    private clearRestartTimer(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    private cleanup(): void {
        this.backend?.destroy();
        this.ipc?.destroy();
        this.backend = null;
        this.ipc = null;
        this.running = false;
    }
}
