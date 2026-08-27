/**
 * Coalesced restart driver: ONE cycle in flight plus ONE queued follow-up.
 *
 * Extracted from `AudioTranscoderModule.restartPipeline`, which had grown the
 * in-progress latch, the queued-follow-up `do/while` and the per-cycle error
 * handling around what is really one line of work (stop, then start). The
 * machinery is the reusable part; what a cycle DOES — including its
 * preconditions — stays with the module.
 *
 * `VideoPlayerModule.restartPipeline` holds a verbatim copy of the same latch
 * and loop (it is the pattern this was written from, see [[0009]]); adopting
 * this driver there is a deliberate follow-up, not part of this change.
 */

export interface CoalescedRestartHooks {
    /**
     * One restart cycle. Runs to completion before any queued follow-up, so it
     * may re-check its own preconditions on entry and return early — a cycle
     * that decides to do nothing is a valid cycle.
     */
    cycle: () => Promise<void>;
    /**
     * A cycle threw. The driver has already swallowed it (a failed cycle must
     * not reject the trigger that scheduled it, nor cancel a queued follow-up);
     * this is where the caller logs and decides what recovery, if any, is owed.
     */
    onError?: (err: unknown) => void;
}

export class CoalescedRestart {
    private inProgress = false;
    private pending = false;

    constructor(private readonly hooks: CoalescedRestartHooks) {}

    /** True while a cycle is running, including between queued cycles. */
    get inFlight(): boolean {
        return this.inProgress;
    }

    /**
     * Run a cycle, or — if one is already running — queue exactly ONE
     * follow-up. Coalescing is the point: a burst of triggers collapses to a
     * single extra cycle, and that cycle runs against the LATEST state instead
     * of being dropped (the trigger that arrives mid-cycle is usually the one
     * carrying the new information).
     *
     * Resolves when the cycle chain this call started — or joined — is done.
     * A queued trigger resolves immediately; it does not wait for its cycle.
     */
    async trigger(): Promise<void> {
        if (this.inProgress) {
            this.pending = true;
            return;
        }
        this.inProgress = true;
        try {
            do {
                this.pending = false;
                try {
                    await this.hooks.cycle();
                } catch (err) {
                    this.hooks.onError?.(err);
                }
            } while (this.pending);
        } finally {
            this.inProgress = false;
        }
    }
}
