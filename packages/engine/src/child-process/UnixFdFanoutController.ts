import type { ManagedProcess } from './ManagedProcess.js';

/**
 * What the BusFanoutCoordinator needs from a producer to manage its
 * per-consumer fan-out branches. `GstChildProcess` satisfies it natively
 * (bus_attach/bus_detach runner commands); non-GStreamer producers expose it
 * via `UnixFdFanoutController` (below). See `PluginModule.getBusAttachTarget`.
 */
export interface BusAttachTarget {
    sendBusAttach(tee: string, socket: string): void;
    sendBusDetach(socket: string): void;
}

/**
 * Target of the tracked `bus_reinput` live-input-swap RPC (LiveInputSwap's
 * make-before-break re-point). `GstChildProcess.busReinput` satisfies it for
 * gst sinks; a native child process exposes it via `NativeSinkController`.
 */
export interface LiveSwapTarget {
    busReinput(element: string, socket: string): Promise<void>;
}

/**
 * Bus fan-out control for a non-GStreamer producer (hls-player): bridges the
 * BusFanoutCoordinator's attach/detach calls to the module's
 * `unixfd-fanout.py` sidecar over its stdin (JSON lines, same verbs as the
 * gst runner).
 *
 * Owns the DESIRED edge set so sidecar lifecycle is invisible to the engine:
 * commands sent while the sidecar is down/restarting are recorded, and every
 * `ready` event (first start and each autoRestart respawn — a fresh process
 * has no listeners) replays the full set. Attach is idempotent on the sidecar
 * side, so replays are harmless.
 *
 * The module feeds sidecar stdout lines to `handleLine` (from its
 * spawnRunnerProcess onStdout hook) and keeps using the parsed result for its
 * own stats handling.
 */
export class UnixFdFanoutController implements BusAttachTarget {
    /** Desired fan-out edges: socket path → tee/channel id (opaque here). */
    private readonly desired = new Map<string, string>();

    constructor(
        private readonly getProc: () => ManagedProcess | null,
        /** Called on every sidecar `ready` — the module triggers its
         *  producer-playing reattach path here (connections made while the
         *  module was down are only known to the coordinator). */
        private readonly onReady?: () => void,
    ) {}

    sendBusAttach(tee: string, socket: string): void {
        this.desired.set(socket, tee);
        this.write({ cmd: 'bus_attach', tee, socket });
    }

    sendBusDetach(socket: string): void {
        this.desired.delete(socket);
        this.write({ cmd: 'bus_detach', socket });
    }

    /**
     * Feed one sidecar stdout line. Returns the parsed JSON object (for the
     * module's own stats/event handling) or null for non-JSON noise.
     */
    handleLine(line: string): Record<string, unknown> | null {
        const i = line.indexOf('{');
        if (i < 0) return null;
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(line.slice(i)) as Record<string, unknown>;
        } catch {
            return null;
        }
        if (msg.event === 'ready') {
            for (const [socket, tee] of this.desired) {
                this.write({ cmd: 'bus_attach', tee, socket });
            }
            this.onReady?.();
        }
        return msg;
    }

    protected write(obj: Record<string, unknown>): void {
        this.getProc()?.writeLine(JSON.stringify(obj));
    }
}

/** How long a `reinput` verb may stay unanswered before the swap RPC rejects
 *  (the caller then falls back to the classic module restart). */
const REINPUT_TIMEOUT_MS = 6_000;

/** Ceiling on an unanswered `add_output`; on timeout the caller restarts the
 *  module instead (the respawn declares the output via argv). */
const ADD_OUTPUT_TIMEOUT_MS = 6_000;

/**
 * Controller for a native bus SINK child (mr-tssplit): everything the fan-out
 * controller does, plus the `reinput` verb — the native equivalent of the gst
 * runner's tracked `bus_reinput` RPC. The child answers `reinput_done` /
 * `reinput_failed`; no answer within the timeout rejects (a respawned child
 * has a fresh input from its argv, so a lost in-flight reinput is moot).
 */
export class NativeSinkController extends UnixFdFanoutController implements LiveSwapTarget {
    private pendingReinput: {
        resolve: () => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;

    /** In-flight `add_output` calls, keyed by pid (several can overlap when a
     *  source reveals multiple new PIDs in one discovery). */
    private readonly pendingOutputs = new Map<
        number,
        { resolve: () => void; reject: (err: Error) => void }
    >();

    /** `element` is part of the gst RPC shape; the native child has exactly
     *  one input, so only the socket travels. */
    busReinput(_element: string, socket: string): Promise<void> {
        this.pendingReinput?.reject(new Error('superseded by a newer reinput'));
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingReinput = null;
                reject(new Error('reinput timed out'));
            }, REINPUT_TIMEOUT_MS);
            this.pendingReinput = {
                resolve: () => {
                    clearTimeout(timer);
                    this.pendingReinput = null;
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timer);
                    this.pendingReinput = null;
                    reject(err);
                },
                timer,
            };
            this.write({ cmd: 'reinput', socket });
        });
    }

    /**
     * Declare an output discovered after the child spawned (its `--out` set is
     * fixed at spawn). Resolves on `output_added` — only then does the tee
     * exist, so the caller must await this before the engine attaches an edge
     * to it. Rejection is the caller's cue to fall back to a module restart,
     * which respawns the child with the new output in argv.
     */
    addOutput(pid: number, tee: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingOutputs.delete(pid);
                reject(new Error(`add_output ${pid} timed out`));
            }, ADD_OUTPUT_TIMEOUT_MS);
            this.pendingOutputs.get(pid)?.reject(new Error('superseded by a newer add_output'));
            this.pendingOutputs.set(pid, {
                resolve: () => {
                    clearTimeout(timer);
                    this.pendingOutputs.delete(pid);
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timer);
                    this.pendingOutputs.delete(pid);
                    reject(err);
                },
            });
            this.write({ cmd: 'add_output', pid, tee });
        });
    }

    override handleLine(line: string): Record<string, unknown> | null {
        const msg = super.handleLine(line);
        if (!msg) return null;
        if (msg.event === 'reinput_done') {
            this.pendingReinput?.resolve();
        } else if (msg.event === 'reinput_failed') {
            this.pendingReinput?.reject(
                new Error(typeof msg.message === 'string' ? msg.message : 'reinput failed'),
            );
        } else if (msg.event === 'output_added') {
            this.pendingOutputs.get(Number(msg.pid))?.resolve();
        } else if (msg.event === 'output_add_failed') {
            this.pendingOutputs
                .get(Number(msg.pid))
                ?.reject(
                    new Error(typeof msg.message === 'string' ? msg.message : 'add_output failed'),
                );
        }
        return msg;
    }
}
