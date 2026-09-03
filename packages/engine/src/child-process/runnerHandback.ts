/**
 * The one-shot hand-back of a finished `GstRunner` to its host.
 *
 * A teardown arms deadlines from two places (`stopPipeline`'s cap and
 * `shutdown`'s cap) and the drain adds a short flush once Python is gone;
 * whichever fires first hands the runner back, and every other timer is
 * cleared so a finished runner holds none — in-process, a stray 8.5 s timer
 * per stopped module would otherwise keep firing into a host that has already
 * let go of it. Under the fork the hand-back is `process.exit(0)`.
 */
export class RunnerHandback {
    private done = false;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();

    constructor(private readonly onDone: () => void) {}

    get isDone(): boolean {
        return this.done;
    }

    /** A deadline is armed and has not fired. */
    get isArmed(): boolean {
        return this.timers.size > 0;
    }

    /** Hand back after `ms`, unless something hands back first. */
    after(ms: number): void {
        if (this.done) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.now();
        }, ms);
        this.timers.add(timer);
    }

    /** Hand back now — exactly once. */
    now(): void {
        if (this.done) return;
        this.done = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.onDone();
    }
}
