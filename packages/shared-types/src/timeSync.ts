// The engine's house epoch E and time-sync state (house-clock design §4.2, §10.3).

/** Who disciplines the clock: `chrony`, also on a PTP grandmaster (chronyd disciplines the clock
 *  it serves); `ptp`, linuxptp steers (slave-only boxes, and a master-capable box while it
 *  follows a better grandmaster); `none`, neither daemon runs. */
export type TimeSyncSource = 'chrony' | 'ptp' | 'none';

/** Why E was latched (`start`/`timeout`) or re-latched (`sync`/`step`/`divergence`). */
export type HouseEpochReason = 'start' | 'timeout' | 'sync' | 'step' | 'divergence';

/** One latched epoch. Engine-internal: the bigints never go on the wire. */
export interface HouseEpoch {
    /** TAI − MONOTONIC in ns, ~1.8e18: beyond 2^53, so bigint. */
    eNs: bigint;
    /** 1 at first latch, +1 per re-latch. */
    seq: number;
    latchedAtMonoNs: bigint;
    /** Synced and TAI offset set when latched (or since). */
    traceable: boolean;
    reason: HouseEpochReason;
    source: TimeSyncSource;
    /** Kernel TAI−UTC (adjtimex .tai). */
    taiOffsetS: number;
}

/** What chronyd itself reports (`chronyc -c tracking`): shown, never gated on (OQ-7). */
export interface ChronyTracking {
    reference: string;
    stratum: number;
    /** |offset| + root dispersion + root delay / 2, in µs. */
    estErrorUs: number;
    leap: string;
}

/** `SystemStats.timeSync`: JSON-safe, carried to `/system/timeSync` and the manager. */
export interface TimeSyncState {
    source: TimeSyncSource;
    /** STA_UNSYNC clear and maxerror under 1 s: the flag alone flips at a linuxptp start. */
    synced: boolean;
    traceable: boolean;
    taiOffsetS: number;
    estErrorUs: number;
    maxErrorUs: number;
    freqPpm: number;
    /** Modules are held until sync or the 30 s start wait ends. */
    waitingForSync: boolean;
    waitRemainingS?: number;
    /** 0 until the first latch. */
    epochSeq: number;
    /** ISO wall time of the latest (re-)latch. */
    epochLatchedAt?: string;
    epochReason?: HouseEpochReason;
    /** E as a decimal string, for diagnostics. */
    eNs?: string;
    /** False when mr-clockstate is not installed: no epoch, modules not held. */
    sidecar: boolean;
    chrony?: ChronyTracking;
}
