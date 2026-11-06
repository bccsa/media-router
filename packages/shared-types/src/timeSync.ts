// The engine's house epoch E and time-sync state (house-clock design §4.2, §10.3).

/** Who disciplines the clock: `chrony`, also on a PTP grandmaster (it keeps the time served) and
 *  on a slave-only box on the NTP fallback (`TimeSyncState.ntpFallback`); `ptp`, linuxptp steers
 *  (slave-only boxes, a master-capable box following a better master); `none`, neither runs. */
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

/** The kernel's esterror until an NTP daemon writes one (NTP_PHASE_LIMIT, 16 s). chrony does,
 *  linuxptp never does: shown as no figure, never as 16 s (B-198). */
export const KERNEL_ESTERROR_UNSET_US = 16_000_000;

/** ptp4l's own view while linuxptp steers the clock: `pmc` GET PORT_DATA_SET and
 *  CURRENT_DATA_SET over its read-only socket, at each source poll (B-198). */
export interface PtpClockState {
    /** PORT_DATA_SET portState as pmc prints it: SLAVE, UNCALIBRATED, LISTENING, … */
    portState: string;
    /** CURRENT_DATA_SET offsetFromMaster in ns, only while the port is SLAVE or UNCALIBRATED:
     *  ptp4l keeps the last one when its master goes. */
    offsetNs?: number;
    /** CURRENT_DATA_SET meanPathDelay in ns, with offsetNs. */
    pathDelayNs?: number;
}

/** ns as the clock texts show them: 812 ns, 41.2 µs, 2.6 ms, 3.1 s. */
function nsText(ns: number): string {
    const a = Math.abs(ns);
    if (a < 1e3) return `${a} ns`;
    if (a < 1e6) return `${(a / 1e3).toFixed(1)} µs`;
    return a < 1e9 ? `${(a / 1e6).toFixed(1)} ms` : `${(a / 1e9).toFixed(1)} s`;
}

/** PTP's own error for the clock tooltip and the epoch log: its offset from the master, else
 *  n/a with the port state when ptp4l answered. Never the kernel's figure (B-198). */
export function ptpErrorText(ptp: PtpClockState | undefined): string {
    if (!ptp) return 'n/a (PTP)';
    const { offsetNs, pathDelayNs } = ptp;
    if (offsetNs === undefined || pathDelayNs === undefined)
        return `n/a (PTP port ${ptp.portState})`;
    return `±${nsText(offsetNs)} (PTP offset from master, path delay ${nsText(pathDelayNs)})`;
}

/** `SystemStats.timeSync`: JSON-safe, carried to `/system/timeSync` and the manager. */
export interface TimeSyncState {
    source: TimeSyncSource;
    /** STA_UNSYNC clear and maxerror under 1 s: the flag alone flips at a linuxptp start. */
    synced: boolean;
    traceable: boolean;
    taiOffsetS: number;
    /** The kernel's esterror (adjtimex), µs: KERNEL_ESTERROR_UNSET_US until chrony writes it.
     *  linuxptp never does, so under PTP it is not PTP's error: see `ptp`. */
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
    /** While source is `ptp` and ptp4l answered the last poll; a step drops it until the next
     *  periodic poll, since ptp4l's figure then measured the clock before the step. */
    ptp?: PtpClockState;
    /** A slave-only PTP box with no PTP master: chrony holds its clock until a master's lock has
     *  held 30 s (MR-048b). From ptp4l's status.env at each source poll; absent without it. */
    ntpFallback?: boolean;
}
