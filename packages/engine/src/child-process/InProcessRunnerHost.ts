import * as crypto from 'crypto';
import type { ControlIpcMessage } from '@media-router/shared-types';
import { GstRunner } from './GstRunner.js';
import type { RunnerChannel } from './ControlIpc.js';
import type { RunnerBackend } from './RunnerBackend.js';
import { PendingRequests } from './pendingRequests.js';

/**
 * Every in-process runner that has not handed itself back yet. The engine's
 * own exit is the last line of defence for their Python children: under the
 * fork each shim had `process.on('exit') → emergencyKill`; here one hook does
 * it for all of them. (Python also drains and exits on its own when its
 * command pipe closes — `command_reader_thread` funnels EOF into
 * `handle_stop` — so this only matters for a Python that is wedged.)
 */
const liveRunners = new Set<GstRunner>();
let exitHookInstalled = false;

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => {
        for (const runner of liveRunners) runner.emergencyKill();
    });
}

/**
 * Hosts one `GstRunner` inside the engine process and is its `RunnerChannel`
 * — the default `RunnerBackend`, replacing the forked `gst-runner.js` shim.
 *
 * The runner's `post` lands in `receive` (a method call, no serialisation);
 * its `exit` marks this host finished. Requests are dispatched into the
 * runner synchronously, so a response the runner sends from inside
 * `handleControlMessage` resolves the request that caused it — the pending
 * entry is registered BEFORE dispatch for exactly that reason.
 *
 * Fault boundary: a throw out of the runner rejects the one request that hit
 * it (or is logged for an event), and a throw out of a module-side event
 * handler is logged — the engine hosts every module's runner, so no runner
 * fault may become an uncaught exception.
 */
export class InProcessRunnerHost implements RunnerChannel, RunnerBackend {
    readonly runner: GstRunner;
    private readonly pending = new PendingRequests('Runner');
    private readonly handlers = new Map<string, (data: unknown) => void>();
    private readonly exitListeners: Array<(code: number | null) => void> = [];
    private exited = false;

    constructor(pythonRunnerPath: string) {
        this.runner = new GstRunner(pythonRunnerPath, {
            post: (msg) => this.receive(msg),
            exit: () => this.handleExit(),
        });
        liveRunners.add(this.runner);
        installExitHook();
    }

    // --- RunnerBackend ---

    get channel(): RunnerChannel {
        return this;
    }

    /** PID of the runner's live Python child — the process a module owns. */
    get pid(): number | undefined {
        return this.runner.pythonPid;
    }

    /** The runner has finished its terminal path and handed itself back. */
    get isExited(): boolean {
        return this.exited;
    }

    /** Called once: with 0 when the runner hands itself back, null when `stop()` gave up on it. */
    onExit(cb: (code: number | null) => void): void {
        this.exitListeners.push(cb);
    }

    /**
     * Orderly teardown: ask the runner to stop, give it the second nudge the
     * fork got as SIGTERM (`shutdown` sends Python `stop` + SIGTERM and arms
     * the drain deadline), then wait for it to hand itself back — the runner
     * does so as soon as Python is verifiably gone, or at its own deadline
     * after SIGKILLing a Python that will not drain. `capMs` is the backstop
     * for a runner that does neither: its Python gets the SIGKILL the shim's
     * process-exit hook would have delivered.
     */
    async stop(capMs: number): Promise<void> {
        if (this.exited) return;
        try {
            await this.sendRequest('stopPipeline', undefined, 2000);
        } catch {
            // Already exited or a throw — shutdown below still runs
        }
        this.shutdown('module stop');
        const handedBack = await this.waitForExit(capMs);
        if (!handedBack) {
            // The runner never handed back: SIGKILL its Python and close the
            // host anyway, so the module still sees `exit` (the fork emitted
            // one on its SIGKILL too) and nothing waits on a dead runner.
            this.runner.emergencyKill();
            this.handleExit(null);
        }
    }

    /** Shut the hosted runner down (idempotent; see `GstRunner.shutdown`). */
    shutdown(reason: string): void {
        if (!this.exited) this.runner.shutdown(reason);
    }

    /**
     * Detach from the runner and, if it is still up, shut it down — a host
     * that lets go of a live runner would leak it and its Python, and there
     * is no process boundary left to reap them. Exit listeners still fire
     * when the runner finishes (callers guard on host identity).
     */
    destroy(): void {
        this.handlers.clear();
        this.pending.rejectAll(new Error('InProcessRunnerHost destroyed'));
        this.shutdown('host destroyed');
    }

    /** Resolve true once the runner has exited, false after `capMs`. */
    waitForExit(capMs: number): Promise<boolean> {
        if (this.exited) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), capMs);
            this.onExit(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    // --- RunnerChannel ---

    sendRequest(action: string, data?: unknown, timeout = 10000): Promise<unknown> {
        const id = crypto.randomUUID();
        const result = this.pending.open(id, action, timeout);
        if (this.exited) {
            this.pending.reject(id, new Error('Runner exited'));
            return result;
        }
        try {
            this.runner.handleControlMessage({ id, type: 'request', action, data });
        } catch (err) {
            this.pending.reject(id, err instanceof Error ? err : new Error(String(err)));
        }
        return result;
    }

    sendEvent(action: string, data?: unknown): void {
        if (this.exited) return;
        try {
            this.runner.handleControlMessage({
                id: crypto.randomUUID(),
                type: 'event',
                action,
                data,
            });
        } catch (err) {
            console.error(`[gst-runner] control event handler threw (action=${action}):`, err);
        }
    }

    on(action: string, handler: (data: unknown) => void): void {
        this.handlers.set(action, handler);
    }

    off(action: string): void {
        this.handlers.delete(action);
    }

    // --- runner side ---

    private receive(msg: ControlIpcMessage): void {
        if (msg.type === 'response') {
            this.pending.resolve(msg.id, msg.data);
        } else if (msg.type === 'event') {
            const handler = this.handlers.get(msg.action);
            if (!handler) return;
            try {
                handler(msg.data);
            } catch (err) {
                // The runner's `post` is a plain call into this host, so a
                // module-side handler bug would surface INSIDE the runner's
                // Python-event dispatch. Bound it here, where it belongs.
                console.error(`[gst-runner] event handler threw (action=${msg.action}):`, err);
            }
        }
    }

    private handleExit(code: number | null = 0): void {
        if (this.exited) return;
        this.exited = true;
        liveRunners.delete(this.runner);
        this.pending.rejectAll(new Error('Runner exited'));
        for (const cb of this.exitListeners.splice(0)) {
            try {
                cb(code);
            } catch (err) {
                console.error('[gst-runner] exit listener threw:', err);
            }
        }
    }
}
