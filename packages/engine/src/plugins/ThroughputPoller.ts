/**
 * Shared bytes-served → bitrate polling helper for producer plugins
 * (video/audio encoders, mpegts-muxer, transcoder). Replaces the hand-rolled
 * `setInterval` + lastBytes/lastPollTime bookkeeping each plugin used to carry.
 *
 * A small composable (constructed, not subclassed) so it doesn't grow
 * `GstPluginBase`. The plugin supplies how to read the cumulative byte counter
 * and how to publish a computed sample; the poller owns the timing, the
 * counter-reset guard and the idle skip.
 */

export interface ThroughputSample {
    /** Bitrate over the last interval, in kbps (rounded, never negative). */
    bitrateKbps: number;
    /** Cumulative bytes served so far. */
    totalBytes: number;
}

export interface ThroughputPollerOptions {
    /**
     * Return the current cumulative byte counter, or `undefined` when it's
     * unavailable (pipeline idle / not yet playing). When `undefined` the tick
     * is skipped: nothing is published and the baseline is left untouched, so an
     * idle module stops emitting spurious "0 kbps" updates.
     */
    getBytes: () => Promise<number | undefined>;
    /** Publish a computed sample. Not called on a skipped (idle) tick. */
    publish: (sample: ThroughputSample) => void;
    /** Poll interval in ms (default 2000). */
    intervalMs?: number;
}

export class ThroughputPoller {
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastBytes = 0;
    private lastPollTime = 0;
    private readonly intervalMs: number;

    constructor(private readonly opts: ThroughputPollerOptions) {
        this.intervalMs = opts.intervalMs ?? 2000;
    }

    /** (Re)start polling. Resets the baseline; no-op if already running. */
    start(): void {
        if (this.timer) return;
        this.lastBytes = 0;
        this.lastPollTime = Date.now();
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }

    /** Stop polling. Safe to call when not running. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async tick(): Promise<void> {
        let total: number | undefined;
        try {
            total = await this.opts.getBytes();
        } catch {
            return; // reader threw — treat as unavailable, skip this tick
        }
        if (typeof total !== 'number') return; // idle — skip publish

        const now = Date.now();
        const elapsed = (now - this.lastPollTime) / 1000;
        // The counter resets to 0 when a child process is re-spawned
        // (restartOnError). A sample below the last total is that reset — treat
        // it as a fresh baseline instead of reporting a negative rate.
        const counterReset = total < this.lastBytes;
        const deltaBytes = counterReset ? 0 : total - this.lastBytes;
        const bitrateKbps = elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0;
        this.lastBytes = total;
        this.lastPollTime = now;
        this.opts.publish({ bitrateKbps, totalBytes: total });
    }
}
