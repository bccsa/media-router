/**
 * Link-health hysteresis on librist's quality metric (100 = no loss). RIST
 * recovers lost packets via retransmission, so a badly degraded link can carry
 * a perfect stream — invisible unless surfaced here. Field case, 2026-08-02:
 * production-hours loss storms of 10–20 % (all recovered, `lost=0`) were the
 * prime suspect behind intermittent video delivery dips, yet every ad-hoc
 * link check came back clean because only unrecovered loss is observable.
 * Warn after WARN_STREAK consecutive low-quality stats windows; clear only
 * after CLEAR_STREAK clean ones so a flapping link doesn't flap the health.
 */
const QUALITY_WARN = 85;
const QUALITY_CLEAR = 95;
const WARN_STREAK = 3;
const CLEAR_STREAK = 5;

/** What the hysteresis asks of its module: raise a warning, or clear one it owns. */
export interface LinkHealthHost {
    warn(message: string): void;
    /** Clear health only if it is still OUR warning (never stomp another path's). */
    clearOwnWarning(): void;
}

export class RistLinkHealth {
    private warnActive = false;
    private lowStreak = 0;
    private okStreak = 0;

    /** A rebuilt receiver re-measures from scratch — stale streaks must not
     *  suppress or fake a warning. */
    reset(): void {
        this.warnActive = false;
        this.lowStreak = 0;
        this.okStreak = 0;
    }

    update(quality: number, lossPct: number, rtt: string, host: LinkHealthHost): void {
        if (quality < QUALITY_WARN) {
            this.lowStreak++;
            this.okStreak = 0;
        } else if (quality >= QUALITY_CLEAR) {
            this.okStreak++;
            this.lowStreak = 0;
        } else {
            // In-between band: neither degrades further nor proves recovery.
            this.lowStreak = 0;
            this.okStreak = 0;
        }
        if (this.lowStreak >= WARN_STREAK) {
            this.warnActive = true;
            host.warn(
                `RIST link degraded — recovering ${lossPct.toFixed(0)}% packet loss ` +
                    `(RTT ${rtt} ms); stream still intact`,
            );
        } else if (this.okStreak >= CLEAR_STREAK && this.warnActive) {
            host.clearOwnWarning();
            this.warnActive = false;
        }
    }
}
