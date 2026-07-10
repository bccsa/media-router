/**
 * Shared bytes-served → bitrate polling helper for producer plugins
 * (video/audio encoders, mpegts-muxer, transcoder). Replaces the hand-rolled
 * `setInterval` + lastBytes/lastPollTime bookkeeping each plugin used to carry.
 *
 * A small composable (constructed, not subclassed) so it doesn't grow
 * `GstPluginBase`. The plugin supplies how to read the cumulative byte
 * counter(s) and how to publish computed samples; the poller owns the timing,
 * the per-counter reset guard and the idle skip. Single-counter plugins return
 * one number from `getBytes`; multi-output plugins (transcoder renditions)
 * return a `Record<name, bytes>` and receive a per-counter breakdown alongside
 * the aggregate.
 */

export interface ThroughputSample {
    /** Bitrate over the last interval, in kbps (rounded, never negative). */
    bitrateKbps: number;
    /** Cumulative bytes served so far. */
    totalBytes: number;
}

export interface ThroughputPollerOptions {
    /**
     * Return the current cumulative byte counter(s), or `undefined` when
     * unavailable (pipeline idle / not yet playing / a counter missing). When
     * `undefined` the tick is skipped: nothing is published and the baselines
     * are left untouched, so an idle module stops emitting spurious "0 kbps"
     * updates. Multi-counter readers should return all-or-nothing — a partial
     * read would misreport rates.
     */
    getBytes: () => Promise<number | Record<string, number> | undefined>;
    /**
     * Publish the computed samples. Not called on a skipped (idle) tick.
     * `total` aggregates across counters (for a single-counter reader it IS the
     * counter); `counters` carries the per-counter breakdown, keyed by the
     * reader's keys.
     */
    publish: (total: ThroughputSample, counters: Record<string, ThroughputSample>) => void;
    /** Poll interval in ms (default 2000). */
    intervalMs?: number;
}

export class ThroughputPoller {
    private timer: ReturnType<typeof setInterval> | null = null;
    private baselines = new Map<string, number>();
    private lastPollTime = 0;
    private readonly intervalMs: number;

    constructor(private readonly opts: ThroughputPollerOptions) {
        this.intervalMs = opts.intervalMs ?? 2000;
    }

    /** (Re)start polling. Resets the baselines; no-op if already running. */
    start(): void {
        if (this.timer) return;
        this.baselines.clear();
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
        let read: number | Record<string, number> | undefined;
        try {
            read = await this.opts.getBytes();
        } catch {
            return; // reader threw — treat as unavailable, skip this tick
        }
        if (read == null) return; // idle — skip publish
        const byCounter = typeof read === 'number' ? { out: read } : read;
        if (Object.keys(byCounter).length === 0) return; // no counters — same skip

        const now = Date.now();
        const elapsed = (now - this.lastPollTime) / 1000;
        this.lastPollTime = now;

        const counters: Record<string, ThroughputSample> = {};
        const total: ThroughputSample = { bitrateKbps: 0, totalBytes: 0 };
        for (const [key, bytes] of Object.entries(byCounter)) {
            const baseline = this.baselines.get(key) ?? 0;
            // A counter below its baseline is a child re-spawn resetting
            // bytes-served (restartOnError) — treat as a fresh baseline
            // instead of reporting a negative rate.
            const deltaBytes = bytes < baseline ? 0 : bytes - baseline;
            const bitrateKbps = elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0;
            this.baselines.set(key, bytes);
            counters[key] = { bitrateKbps, totalBytes: bytes };
            total.bitrateKbps += bitrateKbps;
            total.totalBytes += bytes;
        }
        this.opts.publish(total, counters);
    }
}
