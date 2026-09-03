import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ControlIpc } from './ControlIpc.js';
import type { RunnerBackend } from './RunnerBackend.js';
import { runnerEnv } from './runnerEnv.js';

/**
 * LEGACY backend (`MR_GST_RUNNER_FORK=1`): the runner behind a forked
 * `gst-runner.js` shim, one node process per module. Kept for one release as
 * the rollback for ADR-0012; delete together with `gst-runner.ts` and
 * `ControlIpc` once a release has soaked without it.
 */
export class ForkedRunnerBackend implements RunnerBackend {
    readonly channel: ControlIpc;
    private readonly child: ChildProcess;

    constructor(gstRunnerPath = ForkedRunnerBackend.defaultScriptPath()) {
        // Determine execArgv: if running a .ts file, use tsx loader
        const execArgv = gstRunnerPath.endsWith('.ts') ? ['--import', 'tsx'] : [];
        this.child = fork(gstRunnerPath, [], {
            // fork() automatically creates IPC on fd 3
            // Use 'pipe' for stdin/stdout (MPEG-TS data), inherit stderr for debugging
            stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
            execArgv,
            env: runnerEnv(),
        });
        this.channel = new ControlIpc(this.child);
    }

    /** Prefer the compiled dist/ shim; fall back to a sibling .js, then the .ts under tsx. */
    static defaultScriptPath(): string {
        // __dirname is src/child-process/ under tsx, dist/child-process/ when compiled
        const candidates = [
            path.resolve(__dirname, '../../dist/child-process/gst-runner.js'),
            path.resolve(__dirname, 'gst-runner.js'),
        ];
        return candidates.find((p) => fs.existsSync(p)) ?? path.resolve(__dirname, 'gst-runner.ts');
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    /** Data-pipe mode only: the shim's stdin (MPEG-TS in). */
    get stdin() {
        return this.child.stdin;
    }

    /** Data-pipe mode only: the shim's stdout (MPEG-TS out). */
    get stdout() {
        return this.child.stdout;
    }

    onExit(cb: (code: number | null) => void): void {
        this.child.on('exit', (code) => cb(code));
    }

    /**
     * Graceful stop via IPC, then SIGTERM the shim and wait for a clean exit,
     * SIGKILLing at `capMs`. The window covers the whole shutdown chain below
     * us: the shim tells Python to stop, Python EOS-drains its pipeline before
     * NULL (so a stateless HEVC decoder is never stopped mid-decode — that
     * wedges the kernel driver), and the shim exits after its own SIGKILL
     * deadline. Killing the fork sooner orphans a draining Python.
     */
    async stop(capMs: number): Promise<void> {
        const child = this.child;
        // Already dead — nothing to do
        if (!child.connected && child.exitCode !== null) return;
        try {
            if (child.connected) await this.channel.sendRequest('stopPipeline', undefined, 2000);
        } catch {
            // Channel closed or timeout — will force kill below
        }
        if (child.exitCode !== null) return;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
            const killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* already dead */
                }
                resolve();
            }, capMs);
            child.once('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
        });
    }

    destroy(): void {
        this.channel.destroy();
    }
}
