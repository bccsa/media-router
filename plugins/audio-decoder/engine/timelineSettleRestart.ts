import { BACKLOG_SHED_EVENT } from '@media-router/engine';

// FF9 recovery: after a playout rebase or a bus-stall resume, relaunch this output's own
// pipeline once its source timeline has settled. Deleted with the shedder in Phase 4.
// TWIN of plugins/audio-output-302m/engine/timelineSettleRestart.ts — keep the two in step.

/** No rebase, implausible report or stall-resume for this long = the source timeline settled. */
export const SETTLE_QUIET_MS = 10_000;
/** At most one relaunch per this long; a trigger inside it is dropped, never deferred. */
export const SETTLE_RESTART_GAP_MS = 60_000;
/**
 * A VU gap this long is a stalled source: the codebase's 5 s bus stall (`buswd` watchdogs), not
 * the 2.5 s "VU meter stalled" log line. A shorter gap (a RIST loss inside its session timeout)
 * keeps a continuous PCR, so there is nothing to relaunch.
 */
export const VU_STALL_MS = 5_000;
/** The runner's re-anchor channel (`PLAYOUT_REANCHOR_EVENT`, not exported by the engine). */
const PLAYOUT_REANCHOR_EVENT = 'playout_reanchor';

export type SettleTrigger = 'playout rebase' | 'bus-stall resume';

/** The slice of `GstChildProcess` this needs. */
export interface SettlePipeline {
    readonly pipelineLaunchedAt: number | undefined;
    restartPipeline(reason: string): Promise<void>;
}

export interface SettleRestartHost {
    pipeline(): SettlePipeline | null;
    log(): {
        info(obj: object, msg: string): void;
        warn(obj: object, msg: string): void;
    };
}

export class TimelineSettleRestart {
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** What armed the pending relaunch; null = none pending. */
    private trigger: SettleTrigger | null = null;
    private lastRestartAt: number | undefined;
    private lastVu: { at: number; launch: number | undefined } | undefined;

    constructor(
        private readonly host: SettleRestartHost,
        private readonly now: () => number = () => performance.now(),
    ) {}

    /** Runner plugin events: a rebase arms the relaunch, an implausible report pushes it back. */
    onPluginEvent(channel: string, payload: unknown): void {
        const p = (payload ?? {}) as { kind?: unknown; outcome?: unknown };
        if (channel === PLAYOUT_REANCHOR_EVENT && p.kind === 'rebase') this.arm('playout rebase');
        else if (channel === BACKLOG_SHED_EVENT && p.outcome === 'implausible') this.extend();
    }

    /** A VU reading; the first after a stall within the same launch is a bus-stall resume. */
    onVu(peaks: readonly number[]): void {
        if (peaks.length === 0) return; // a cleared meter, not a reading
        const at = this.now();
        const launch = this.host.pipeline()?.pipelineLaunchedAt;
        const prev = this.lastVu;
        this.lastVu = { at, launch };
        if (prev && prev.launch === launch && at - prev.at >= VU_STALL_MS) {
            this.arm('bus-stall resume');
        }
    }

    /** Stop, destroy, or a fresh pipeline (PLAYING): nothing is left to relaunch. */
    cancel(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.trigger = null;
    }

    private arm(trigger: SettleTrigger): void {
        if (this.trigger === null) {
            const sinceMs = this.now() - (this.lastRestartAt ?? -Infinity);
            if (sinceMs < SETTLE_RESTART_GAP_MS) {
                this.host
                    .log()
                    .info(
                        { trigger, sinceRelaunchMs: Math.round(sinceMs) },
                        `Source timeline unsettled (${trigger}) — no relaunch: at most one per ${SETTLE_RESTART_GAP_MS / 1000} s`,
                    );
                return;
            }
            this.trigger = trigger;
            this.host
                .log()
                .info(
                    { trigger },
                    `Source timeline unsettled (${trigger}) — relaunching this pipeline once it has gone ${SETTLE_QUIET_MS / 1000} s without a re-anchor`,
                );
        }
        this.extend();
    }

    /** Restart the quiet period from now; no-op with nothing pending. */
    private extend(): void {
        if (this.trigger === null) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fire(), SETTLE_QUIET_MS);
        this.timer.unref?.();
    }

    private fire(): void {
        this.timer = null;
        const trigger = this.trigger;
        if (trigger === null) return;
        // A source that is silent right now has not settled: wait for it to come back.
        if (!this.lastVu || this.now() - this.lastVu.at >= VU_STALL_MS) {
            this.extend();
            return;
        }
        this.trigger = null;
        const pipeline = this.host.pipeline();
        if (!pipeline) return;
        this.lastRestartAt = this.now();
        this.host
            .log()
            .warn(
                { trigger },
                `Source timeline settled after a ${trigger} — relaunching this pipeline once`,
            );
        pipeline
            .restartPipeline(`source timeline settled after a ${trigger}`)
            .catch((err: unknown) => this.host.log().warn({ err }, 'Settle relaunch failed'));
    }
}
