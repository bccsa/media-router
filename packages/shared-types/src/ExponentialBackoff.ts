/**
 * Reusable exponential backoff with jitter.
 *
 * Used for auto-restart (GstChildProcess) and reconnection (ManagerConnection).
 * Tracks attempt count, computes delay, and resets after a stability period.
 *
 * Does NOT manage timers — the caller is responsible for scheduling.
 * This keeps the utility pure and testable.
 */
export class ExponentialBackoff {
    private _attempts = 0;
    private stabilityTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param baseDelayMs    Initial delay (default 3000ms)
     * @param maxDelayMs     Delay cap (default 60000ms)
     * @param maxAttempts    Give up after this many attempts (0 = unlimited)
     * @param stabilityMs   Reset attempts after this duration of no failures (default 30000ms)
     */
    constructor(
        private baseDelayMs = 3000,
        private maxDelayMs = 60000,
        private readonly maxAttempts = 0,
        private readonly stabilityMs = 30000,
    ) {}

    /**
     * Rebind the delay window in place. Use when the same backoff instance is
     * reused across configurations (e.g. gst-runner reapplies per-pipeline
     * restartBackoffMs without reallocating the stability timer). Clamps
     * `max` to be at least `base` so a swapped-min/max pair still produces a
     * valid non-decreasing schedule (it collapses to a flat `base` delay
     * rather than escalating, but it doesn't break callers).
     */
    setBounds(baseDelayMs: number, maxDelayMs: number): void {
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = Math.max(baseDelayMs, maxDelayMs);
    }

    /** Current attempt count. */
    get attempts(): number {
        return this._attempts;
    }

    /** Whether max attempts have been exceeded. */
    get exhausted(): boolean {
        return this.maxAttempts > 0 && this._attempts >= this.maxAttempts;
    }

    /**
     * Get the next delay and increment the attempt counter.
     * Returns null if max attempts exceeded.
     *
     * Adds ±25% multiplicative jitter so N owners that failed at the same
     * instant don't all retry on the same tick — a stampede the engine sees
     * when several SRT plugins lose the same peer and re-enter the restart
     * loop together.
     */
    nextDelay(): number | null {
        if (this.exhausted) return null;

        const base = Math.min(this.baseDelayMs * Math.pow(2, this._attempts), this.maxDelayMs);
        const jitter = 1 + (Math.random() - 0.5) * 0.5; // 0.75 .. 1.25
        this._attempts++;
        return Math.round(base * jitter);
    }

    /**
     * Signal that the operation succeeded.
     * Starts the stability timer — if no failure occurs within stabilityMs,
     * the attempt counter resets to 0.
     */
    markStable(): void {
        this.clearStabilityTimer();
        this.stabilityTimer = setTimeout(() => {
            this._attempts = 0;
        }, this.stabilityMs);
    }

    /** Reset attempt counter and clear timers. */
    reset(): void {
        this._attempts = 0;
        this.clearStabilityTimer();
    }

    /** Clean up timers. Call when the owner is destroyed. */
    destroy(): void {
        this.clearStabilityTimer();
    }

    private clearStabilityTimer(): void {
        if (this.stabilityTimer) {
            clearTimeout(this.stabilityTimer);
            this.stabilityTimer = null;
        }
    }
}
