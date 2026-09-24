/**
 * Warns once when a module's VU stream stops while it keeps running (#677).
 *
 * The runner re-sends an unchanged meter at least once per second, so a gap of
 * `staleMs` with no reading means the pipeline itself stopped delivering audio
 * buffers (starved source, wedged runner) — as opposed to a meter that only went
 * missing downstream on its way to the UI. Armed by the first reading of a run,
 * disarmed by `reset()` on stop, so a stopped module never logs.
 */
export class VuStallWatch {
    private lastVuAt = 0;
    private stalled = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly hooks: {
            onStall: (gapMs: number) => void;
            onResume: (gapMs: number) => void;
        },
        private readonly staleMs = 2500,
        private readonly now: () => number = Date.now,
    ) {}

    /** A VU reading arrived. */
    tick(): void {
        const t = this.now();
        if (this.stalled) {
            this.stalled = false;
            this.hooks.onResume(t - this.lastVuAt);
        }
        this.lastVuAt = t;
        if (!this.timer) {
            this.timer = setInterval(() => this.check(), 1000);
            this.timer.unref?.();
        }
    }

    /** Module stopped or destroyed: disarm without logging. */
    reset(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.lastVuAt = 0;
        this.stalled = false;
    }

    private check(): void {
        if (this.stalled || !this.lastVuAt) return;
        const gap = this.now() - this.lastVuAt;
        if (gap > this.staleMs) {
            this.stalled = true;
            this.hooks.onStall(gap);
        }
    }
}
