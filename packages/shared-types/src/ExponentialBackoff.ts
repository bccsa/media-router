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
        private readonly baseDelayMs = 3000,
        private readonly maxDelayMs = 60000,
        private readonly maxAttempts = 0,
        private readonly stabilityMs = 30000,
    ) {}

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
     */
    nextDelay(): number | null {
        if (this.exhausted) return null;

        const delay = Math.min(this.baseDelayMs * Math.pow(2, this._attempts), this.maxDelayMs);
        this._attempts++;
        return delay;
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
