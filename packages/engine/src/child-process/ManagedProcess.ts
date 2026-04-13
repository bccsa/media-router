import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { createReadStream } from 'fs';
import { createLogger, ExponentialBackoff } from '@media-router/shared-types';

export interface ManagedProcessOptions {
    /** Unique label for this process (used in logs). */
    label: string;
    /** Executable path or command name. */
    command: string;
    /** Arguments array. */
    args?: string[];
    /** Environment variables (merged with process.env). */
    env?: Record<string, string>;
    /** Working directory. */
    cwd?: string;
    /** Enable auto-restart on crash (default: true). */
    autoRestart?: boolean;
    /** Backoff config overrides. */
    backoff?: {
        baseDelayMs?: number;
        maxDelayMs?: number;
        maxAttempts?: number;
        stabilityMs?: number;
    };
    /** Called for each line of stdout. */
    onStdout?: (line: string) => void;
    /** Called for each line of stderr. */
    onStderr?: (line: string) => void;
}

const DEFAULT_BACKOFF = {
    baseDelayMs: 3000,
    maxDelayMs: 60000,
    maxAttempts: 10,
    stabilityMs: 30000,
};

/**
 * Manages a single external child process with auto-restart,
 * graceful shutdown, and line-buffered stdout/stderr capture.
 *
 * Emits:
 *   - 'started' (pid: number)
 *   - 'stopped' (code: number | null, signal: string | null)
 *   - 'error' (message: string)
 *   - 'restarting' (attempt: number, delayMs: number)
 */
export class ManagedProcess extends EventEmitter {
    private child: ChildProcess | null = null;
    private _destroyed = false;
    private _startTime = 0;
    private _exitCode: number | null = null;
    private backoff: ExponentialBackoff;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private log;

    constructor(
        private options: ManagedProcessOptions,
        ownerId?: string,
    ) {
        super();
        const bo = { ...DEFAULT_BACKOFF, ...options.backoff };
        this.backoff = new ExponentialBackoff(bo.baseDelayMs, bo.maxDelayMs, bo.maxAttempts, bo.stabilityMs);
        this.log = createLogger(`Process:${ownerId ?? 'unknown'}:${options.label}`);
    }

    get pid(): number | undefined { return this.child?.pid; }
    get isRunning(): boolean { return this.child !== null && !this.child.killed && this.child.exitCode === null; }
    get uptime(): number { return this._startTime > 0 && this.isRunning ? Date.now() - this._startTime : 0; }
    get exitCode(): number | null { return this._exitCode; }
    get label(): string { return this.options.label; }
    get destroyed(): boolean { return this._destroyed; }

    /** Start the process. */
    start(): void {
        if (this._destroyed) return;
        if (this.isRunning) return;

        const { command, args = [], env, cwd } = this.options;

        this.log.info({ command, args }, 'Starting process');

        this.child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: env ? { ...process.env, ...env } : undefined,
            cwd,
        });

        this._startTime = Date.now();
        this._exitCode = null;

        // Line-buffered stdout (capped at 64KB to prevent OOM from long lines)
        if (this.child.stdout) {
            let buffer = '';
            this.child.stdout.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                if (buffer.length > 65536) buffer = buffer.slice(-32768);
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim()) {
                        this.log.debug({ stream: 'stdout' }, line);
                        this.options.onStdout?.(line);
                    }
                }
            });
        }

        // Line-buffered stderr (capped at 64KB to prevent OOM from long lines)
        if (this.child.stderr) {
            let buffer = '';
            this.child.stderr.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                if (buffer.length > 65536) buffer = buffer.slice(-32768);
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim()) {
                        if (this.options.onStderr) {
                            this.options.onStderr(line);
                        } else {
                            this.log.warn({ stream: 'stderr' }, line);
                        }
                    }
                }
            });
        }

        this.child.on('error', (err) => {
            this.log.error({ err: err.message }, 'Process error');
            this.emit('error', err.message);
        });

        this.child.on('exit', (code, signal) => {
            this._exitCode = code;
            this.log.info({ code, signal }, 'Process exited');
            this.emit('stopped', code, signal);
            this.child = null;

            // Auto-restart on non-zero exit
            if (!this._destroyed && this.options.autoRestart !== false && code !== 0) {
                this.scheduleRestart();
            }
        });

        this.emit('started', this.child.pid);
        this.log.info({ pid: this.child.pid }, 'Process started');
    }

    private scheduleRestart(): void {
        if (this._destroyed) return;
        const delay = this.backoff.nextDelay();
        if (delay === null) {
            this.log.error('Max restart attempts reached — giving up');
            this.emit('error', `Process ${this.options.label} exceeded max restart attempts`);
            return;
        }
        this.log.info({ attempt: this.backoff.attempts, delayMs: delay }, 'Scheduling restart');
        this.emit('restarting', this.backoff.attempts, delay);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start();
        }, delay);
    }

    /** Graceful stop: SIGTERM → wait 3s → SIGKILL. */
    async stop(): Promise<void> {
        this.clearRestartTimer();

        if (!this.child || this.child.killed) return;

        const child = this.child;

        // Try SIGTERM
        child.kill('SIGTERM');

        // Wait up to 3s for exit
        const exited = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 3000);
            child.once('exit', () => { clearTimeout(timer); resolve(true); });
        });

        if (!exited && !child.killed) {
            this.log.warn('Process did not exit after SIGTERM — sending SIGKILL');
            child.kill('SIGKILL');
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 2000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }

        this.child = null;
    }

    /** Destroy: stop and prevent any future restarts. */
    async destroy(): Promise<void> {
        this._destroyed = true;
        this.clearRestartTimer();
        this.backoff.destroy();
        await this.stop();
        this.removeAllListeners();
    }

    private clearRestartTimer(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }
}
