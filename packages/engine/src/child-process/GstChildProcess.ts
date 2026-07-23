import { fork, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger, ExponentialBackoff } from '@media-router/shared-types';
import { ControlIpc } from './ControlIpc.js';
import type { PipelineDescription } from '../plugins/PluginModule.js';

const log = createLogger('GstChildProcess');

const MAX_RESTARTS = 10;

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
 * Wraps a forked gst-runner child process.
 *
 * Manages lifecycle (start, stop, restart), monitors health,
 * and provides typed event subscriptions.
 *
 * Emits:
 *   - 'stateChange' (state) — pipeline state change
 *   - 'vuData' (data) — VU meter data
 *   - 'pluginEvent' ({channel, payload}) — generic pipeline→plugin data
 *   - 'error' (data) — error from pipeline
 *   - 'exit' (code) — child process exited
 */
export class GstChildProcess extends EventEmitter {
    private child: ChildProcess | null = null;
    private ipc: ControlIpc | null = null;
    private pipelineDesc: PipelineDescription | null = null;
    private running = false;
    private backoff = new ExponentialBackoff(3000, 60000, MAX_RESTARTS, 30000);
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private gstRunnerPath: string;
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
        if (gstRunnerPath) {
            this.gstRunnerPath = gstRunnerPath;
        } else {
            // Prefer compiled dist/ version (always up-to-date after build)
            // __dirname is src/child-process/ under tsx, dist/child-process/ when compiled
            const distPath = path.resolve(__dirname, '../../dist/child-process/gst-runner.js');
            const localJs = path.resolve(__dirname, 'gst-runner.js');
            const localTs = path.resolve(__dirname, 'gst-runner.ts');
            if (fs.existsSync(distPath)) {
                this.gstRunnerPath = distPath;
            } else if (fs.existsSync(localJs)) {
                this.gstRunnerPath = localJs;
            } else {
                this.gstRunnerPath = localTs;
            }
        }
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

        // Clean up previous child/ipc if restarting (prevents listener leaks)
        this.cleanup();

        // Fork the gst-runner script
        // Determine execArgv: if running a .ts file, use tsx loader
        const isTsFile = this.gstRunnerPath.endsWith('.ts');
        const execArgv = isTsFile ? ['--import', 'tsx'] : [];

        this.child = fork(this.gstRunnerPath, [], {
            // fork() automatically creates IPC on fd 3
            // Use 'pipe' for stdin/stdout (MPEG-TS data), inherit stderr for debugging
            stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
            execArgv,
            env: childEnv(),
        });

        this.ipc = new ControlIpc(this.child);

        // Wire up event handlers
        this.ipc.on('stateChange', (data) => {
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

        this.ipc.on('vuData', (data) => {
            this.emit('vuData', data);
        });

        // Generic pipeline→plugin data channel (channel + payload). Pure
        // passthrough — the module decides what to do with each channel (e.g.
        // `level:sclevel` for the audio-dynamics ducker, `stream:discovered` /
        // `stream:names` for the mpegts demuxer's inspector).
        this.ipc.on('pluginEvent', (data) => {
            this.emit('pluginEvent', data);
        });

        this.ipc.on('error', (data) => {
            this.emit('error', data);
        });

        // unixfd socket-gate progress: the runner is waiting (indefinitely)
        // for producer edge sockets before launching the pipeline. Forwarded
        // so the module can surface a health warning naming the pending
        // sockets — without it a gated module reports healthy while nothing
        // runs. `pending: []` clears the signal (gate opened).
        this.ipc.on('busGate', (data) => {
            this.emit('busGate', data);
        });

        // Monitor child exit for auto-restart
        this.child.on('exit', (code) => {
            this.running = false;
            this.emit('exit', code);

            // Auto-restart if not intentionally stopped
            if (!this.destroyed && this.pipelineDesc && code !== 0) {
                this.clearRestartTimer();
                this.scheduleRestart();
            }
        });

        // Send the pipeline to the child
        try {
            await this.ipc.sendRequest('startPipeline', {
                pipeline: this.pipelineDesc.pipeline,
                useStdioForData: this.pipelineDesc.useStdioForData ?? false,
                restartOnError: this.pipelineDesc.restartOnError ?? false,
                restartBackoffMs: this.pipelineDesc.restartBackoffMs,
                linkOnPadAdded: this.pipelineDesc.linkOnPadAdded ?? [],
                readKlvNames: this.pipelineDesc.readKlvNames ?? false,
                env: this.pipelineDesc.env ?? {},
                clock: this.pipelineDesc.clock,
                decoderThreadType: this.pipelineDesc.decoderThreadType ?? 'auto',
                busReports: this.pipelineDesc.busReports ?? [],
                rist: this.pipelineDesc.rist,
                tsSplit: this.pipelineDesc.tsSplit,
                preserveSourceTimeline: this.pipelineDesc.preserveSourceTimeline,
            });
        } catch (err) {
            this.emit('error', { message: `Failed to start pipeline: ${err}` });
        }
    }

    /** Stop the pipeline and child process. */
    async stop(): Promise<void> {
        this.clearRestartTimer();
        this.backoff.reset();
        // Prevent auto-restart from firing
        this.pipelineDesc = null;
        this.stickyProps.clear();

        if (!this.child) {
            this.cleanup();
            return;
        }

        // If child is already dead, just clean up
        if (!this.child.connected && this.child.exitCode !== null) {
            this.cleanup();
            return;
        }

        // Try graceful stop via IPC
        try {
            if (this.ipc && this.child.connected) {
                await this.ipc.sendRequest('stopPipeline', undefined, 2000);
            }
        } catch {
            // Channel closed or timeout — will force kill below
        }

        // Kill the gst-runner child process directly
        const child = this.child;
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');

            // Wait up to 2s for clean exit, then SIGKILL
            await new Promise<void>((resolve) => {
                const killTimer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        /* already dead */
                    }
                    resolve();
                }, 2000);

                child.once('exit', () => {
                    clearTimeout(killTimer);
                    resolve();
                });
            });
        }

        this.cleanup();
    }

    /** Destroy — stop and prevent restarts. */
    async destroy(): Promise<void> {
        this.destroyed = true;
        await this.stop();
        this.backoff.destroy();
        this.removeAllListeners();
    }

    /** Get the child's stdin (for piping MPEG-TS data in). */
    getStdin() {
        return this.child?.stdin ?? null;
    }

    /** Get the child's stdout (for piping MPEG-TS data out). */
    getStdout() {
        return this.child?.stdout ?? null;
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
        if (!this.ipc) return;
        this.ipc.sendEvent('busAttach', { tee, socket });
    }

    /** Detach a per-consumer bus fan-out branch by its edge socket. Fire-and-forget. */
    sendBusDetach(socket: string): void {
        if (!this.ipc) return;
        this.ipc.sendEvent('busDetach', { socket });
    }

    /** Set a property on a named GStreamer element (live, no restart). */
    async setProperty(element: string, property: string, value: unknown): Promise<void> {
        // Record the intent first: a change made while the pipeline is down or
        // mid-restart is applied by the next PLAYING replay instead of lost.
        this.stickyProps.set(`${element} ${property}`, { element, property, value });
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

    /** Get the child PID. */
    get pid(): number | undefined {
        return this.child?.pid;
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
            this.emit('error', { message: `Max restarts reached` });
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
        this.ipc?.destroy();
        this.ipc = null;
        this.child = null;
        this.running = false;
    }
}

/**
 * Build the env block passed to the gst-runner child. Resolves Wayland
 * connectivity at spawn time so a compositor that started after the engine
 * is still picked up — and so an engine launched without session env (SSH,
 * systemd-user with no inherited environment) still gets `WAYLAND_DISPLAY`
 * set when a wayland socket exists in the user runtime dir.
 */
function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
        const candidate = `/run/user/${process.getuid()}`;
        try {
            if (fs.statSync(candidate).isDirectory()) env.XDG_RUNTIME_DIR = candidate;
        } catch {
            /* nothing to do */
        }
    }

    if (!env.WAYLAND_DISPLAY && env.XDG_RUNTIME_DIR) {
        try {
            const socket = fs
                .readdirSync(env.XDG_RUNTIME_DIR)
                .find((entry) => /^wayland-\d+$/.test(entry));
            if (socket) env.WAYLAND_DISPLAY = socket;
        } catch {
            /* runtime dir unreadable */
        }
    }
    return env;
}
