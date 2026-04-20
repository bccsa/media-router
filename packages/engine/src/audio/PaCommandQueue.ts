import { execFileSync, execFile } from 'child_process';
import { formatError } from '@media-router/shared-types';

/**
 * Rate-limited command queue for PulseAudio/PipeWire `pactl` commands.
 *
 * PipeWire can handle commands faster than PulseAudio, but we still
 * need to serialise them to avoid race conditions (e.g. creating a
 * null-sink and immediately trying to use it as a loopback target).
 *
 * All mutating pactl commands (load-module, unload-module, set-*) go
 * through `exec()`. Read-only commands (list, get-*) use `execImmediate()`.
 *
 * Commands are passed as argument arrays to execFile (no shell) to
 * prevent command injection from untrusted device/module names.
 */
export class PaCommandQueue {
    private queue: Array<{
        args: string[];
        resolve: (stdout: string) => void;
        reject: (err: Error) => void;
    }> = [];
    private processing = false;
    private delayMs: number;

    constructor(delayMs = 100) {
        this.delayMs = delayMs;
    }

    /**
     * Queue a pactl command for sequential execution.
     * @param args  Arguments to pass to `pactl` (e.g. ['load-module', 'module-null-sink', ...])
     * Returns the stdout output on success.
     */
    exec(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            this.queue.push({ args, resolve, reject });
            if (!this.processing) {
                this.processNext();
            }
        });
    }

    /**
     * Execute a pactl command immediately (bypasses queue).
     * Use for read-only commands like `pactl list`.
     * @param args  Arguments to pass to `pactl`
     */
    execImmediate(args: string[]): string {
        try {
            return execFileSync('pactl', args, {
                timeout: 5000,
                encoding: 'utf-8',
                env: { ...process.env, DISPLAY: '' },
            }).trim();
        } catch (err) {
            throw new Error(`pactl command failed: pactl ${args.join(' ')}\n${formatError(err)}`);
        }
    }

    private processNext(): void {
        if (this.queue.length === 0) {
            this.processing = false;
            return;
        }

        this.processing = true;
        const item = this.queue[0];

        execFile(
            'pactl',
            item.args,
            {
                timeout: 5000,
                env: { ...process.env, DISPLAY: '' },
            },
            (err, stdout, stderr) => {
                this.queue.shift();

                if (err) {
                    const msg = stderr?.trim() || err.message;
                    item.reject(
                        new Error(`pactl command failed: pactl ${item.args.join(' ')}\n${msg}`),
                    );
                } else {
                    item.resolve(stdout.trim());
                }

                // Delay before next command
                setTimeout(() => this.processNext(), this.delayMs);
            },
        );
    }

    /** Number of pending commands in the queue. */
    get pending(): number {
        return this.queue.length;
    }
}
