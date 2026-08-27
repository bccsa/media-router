/**
 * Re-probe loop for a start-time codec probe that saw nothing.
 *
 * The transcoder's decoder chain is chosen from a ONE-SHOT probe in `onStart`.
 * On engine startup the upstream (ts-splitter) is usually not producing yet, so
 * that probe returns `unknown` and the module builds the generic `decodebin`
 * fallback. Field failure (Pi, 2026-08): the fallback never produced the output
 * socket, so the whole downstream chain stayed wedged until a human restarted
 * the module. Recovery is no longer manual — this loop re-probes at a low rate
 * and asks for a self-restart the moment the source identifies itself.
 *
 * Armed ONLY while the running build is that degraded fallback (see
 * `AudioTranscoderModule.restartCycle` for why a healthy pipeline is never
 * bounced).
 */

import type { ProbeResult } from '@media-router/engine';

/** Re-probe period. Low rate on purpose: each tick spawns a short gst-launch
 *  probe against the input edge socket, and the wait is unbounded. */
export const REPROBE_INTERVAL_MS = 10_000;

/** Health text for the degraded fallback build, re-asserted on every tick —
 *  `GstPluginBase` stomps health to 'ok' on each PLAYING transition, so a
 *  one-shot warning at build time does not survive the spawn. */
export const FALLBACK_DECODER_WARNING =
    'Source codec unknown — using generic decoder; re-probing every 10s until the source identifies';

export interface ReprobeLoopHooks {
    /** Probe the wired input, or `null` when nothing is wired. */
    probe: () => Promise<ProbeResult | null>;
    /** Still no codec — re-assert the degraded health warning. */
    degraded: () => void;
    /**
     * A real codec came back: restart so the codec-specific chain is built.
     * The loop disarms BEFORE calling this, so a restart that fails owes the
     * loop a fresh `arm()` if the module is still degraded — the host owns that
     * decision (`AudioTranscoderModule.handleRestartCycleFailure`) because only
     * it can tell a failed cycle from a cycle that chose not to run.
     */
    restart: (result: ProbeResult) => Promise<void>;
}

/**
 * Low-rate probe timer with a non-overlapping tick.
 *
 * `arm()` is idempotent, `disarm()` is always safe, and a `disarm()` that lands
 * while a probe is in flight abandons that tick (generation counter) — that is
 * what keeps a restart from firing on a module that stopped mid-probe.
 */
export class ReprobeLoop {
    private timer: ReturnType<typeof setInterval> | null = null;
    private busy = false;
    private generation = 0;

    constructor(private readonly hooks: ReprobeLoopHooks) {}

    get armed(): boolean {
        return this.timer !== null;
    }

    arm(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), REPROBE_INTERVAL_MS);
    }

    disarm(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.generation++;
    }

    private async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        const generation = this.generation;
        try {
            const result = await this.hooks.probe();
            // Disarmed while the probe ran (module stopped, or restarted from
            // elsewhere) — this tick's answer is stale.
            if (generation !== this.generation) return;
            if (!result || result.codec === 'unknown') {
                this.hooks.degraded();
                return;
            }
            this.disarm();
            await this.hooks.restart(result);
        } finally {
            this.busy = false;
        }
    }
}
