import { execFile } from 'child_process';

/** How long one pactl call may wait for PipeWire's answer. */
export const PACTL_TIMEOUT_MS = 5000;

/** A pactl call PipeWire did not answer within the timeout, told apart from one that failed (B-207). */
export class PactlNoAnswer extends Error {}

/**
 * Rate-limited command queue for PulseAudio/PipeWire `pactl` commands.
 *
 * PipeWire can handle commands faster than PulseAudio, but we still
 * need to serialise them to avoid race conditions (e.g. creating a
 * null-sink and immediately trying to use it as a loopback target).
 *
 * All mutating pactl commands (load-module, unload-module, set-*) go
 * through `exec()`. Read-only commands (list, get-*) use `execImmediateAsync()`.
 * Neither blocks the event loop: a hung PipeWire must not stall the engine (B-200).
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
    private readonly timeoutMs: number;

    /**
     * Invoked after every QUEUED (mutating) command settles, success or
     * failure, so read-side caches can drop state that the command may have
     * changed — `AudioDeviceOps` hangs its device-listing cache here (a
     * `load-module`/`unload-module`/`set-*-volume` changes what `pactl list`
     * reports). Not called for `execImmediateAsync` (read-only by contract).
     */
    onMutation: (() => void) | null = null;

    constructor(delayMs = 100, timeoutMs = PACTL_TIMEOUT_MS) {
        this.delayMs = delayMs;
        this.timeoutMs = timeoutMs;
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
     * Run a read-only pactl command now (bypasses the queue), e.g. `pactl list`.
     * @param args  Arguments to pass to `pactl`
     */
    execImmediateAsync(args: string[]): Promise<string> {
        return this.run(args);
    }

    /** One pactl call: its stdout, or a rejection when it fails or PipeWire gives no answer in time. */
    private run(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                'pactl',
                args,
                {
                    timeout: this.timeoutMs,
                    // On SIGTERM pactl quits with 0 and no output, which reads as an empty answer.
                    killSignal: 'SIGKILL',
                    encoding: 'utf-8',
                    env: { ...process.env, DISPLAY: '' },
                },
                (err, stdout, stderr) => {
                    if (!err) return resolve(stdout.trim());
                    const failed = `pactl command failed: pactl ${args.join(' ')}\n`;
                    if (err.killed) {
                        return reject(
                            new PactlNoAnswer(`${failed}no answer within ${this.timeoutMs} ms`),
                        );
                    }
                    reject(new Error(failed + (stderr?.trim() || err.message)));
                },
            );
        });
    }

    private processNext(): void {
        if (this.queue.length === 0) {
            this.processing = false;
            return;
        }

        this.processing = true;
        const item = this.queue[0];

        // The caches drop in the same tick as the answer, before its caller reads again.
        const settle = (answer: () => void) => {
            this.queue.shift();
            answer();
            try {
                this.onMutation?.();
            } catch {
                /* a listener bug must never stall the command queue */
            }

            // Delay before next command
            setTimeout(() => this.processNext(), this.delayMs);
        };
        void this.run(item.args).then(
            (stdout) => settle(() => item.resolve(stdout)),
            (err: Error) => settle(() => item.reject(err)),
        );
    }

    /** Number of pending commands in the queue. */
    get pending(): number {
        return this.queue.length;
    }
}
