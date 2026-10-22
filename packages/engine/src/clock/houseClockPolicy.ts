// Pure decisions behind the house epoch E (design §10.3): when to latch, when to re-latch,
// when traceability flips. No I/O and no timers, so the whole table is unit-tested;
// `HouseClock` does the plumbing.

/** One `sample` line from mr-clockstate, parsed. */
export interface ClockSample {
    monoNs: bigint;
    eNs: bigint;
    bracketNs: number;
    synced: boolean;
    taiOffsetS: number;
    estErrorUs: number;
    maxErrorUs: number;
    freqPpm: number;
    status: number;
    leap: string;
}

/** The engine waits this long after start for sync, then latches untraceable. */
export const START_WAIT_MS = 30_000;

/** Longest an untraceable box holds a moved E for sync. On .50 chrony's boot step, TAI write
 *  and sync all came within 3 s (fixtures/clockstate-offline-boot.jsonl); 10 s is 3x that and
 *  bounds the stale E when no sync follows (no daemon: a hand-set date or TAI). */
export const SETTLE_MAX_MS = 10_000;

/** E is constant under slew and sandwich noise is µs, so 1 ms only trips on a real move. */
export const DIVERGENCE_TOLERANCE_NS = 1_000_000n;

/** Below this the kernel TAI offset was never set; not 37 so a future leap passes. */
export const MIN_TAI_UTC_OFFSET_S = 10;

/** Daemons hold the kernel's maxerror below this: ptp4l/phc2sys reset it to 0-500 µs each second,
 *  chrony to 4-20 ms per update (+500 ppm to the next, ≤ 0.53 s at its 1024 s poll). linuxptp's
 *  start-up set_leap(0) clears STA_UNSYNC for < 1 s at the 16 s limit; the flag is not sync. */
export const MAX_SYNCED_ERROR_US = 1_000_000;

/** Kernel synced with a daemon-asserted bound; the one test for "synced" (gate, logs, state). */
export function isSynced(sample: ClockSample): boolean {
    return sample.synced && sample.maxErrorUs < MAX_SYNCED_ERROR_US;
}

/** The kernel state stands in for the daemon's (OQ-7): synced and TAI offset set. */
export function qualifies(sample: ClockSample): boolean {
    return isSynced(sample) && sample.taiOffsetS >= MIN_TAI_UTC_OFFSET_S;
}

export type Decision =
    | { kind: 'latch'; reason: 'start' | 'timeout' }
    | { kind: 'relatch'; reason: 'sync' | 'step' | 'divergence' }
    | { kind: 'traceable'; traceable: boolean }
    /** E moved while untraceable and unsynced: keep the epoch until sync or the settle cap. */
    | { kind: 'settle' }
    /** `stepIgnored`: a REALTIME step left E alone (a leap insert), worth one log line. */
    | { kind: 'none'; stepIgnored?: boolean };

export interface Latched {
    eNs: bigint;
    traceable: boolean;
}

export interface DecideContext {
    /** The 30 s start wait has run out. */
    waitExpired: boolean;
    /** The sidecar reported a step since the previous sample, or since the settle began. */
    stepped: boolean;
    /** A settle has held a moved E for SETTLE_MAX_MS. */
    settleExpired: boolean;
}

export function deltaNs(a: bigint, b: bigint): bigint {
    const d = a - b;
    return d < 0n ? -d : d;
}

export function decide(
    latched: Latched | null,
    sample: ClockSample | null,
    now: DecideContext,
): Decision {
    if (!latched) {
        if (sample && qualifies(sample)) return { kind: 'latch', reason: 'start' };
        if (now.waitExpired && sample) return { kind: 'latch', reason: 'timeout' };
        return { kind: 'none' };
    }
    if (!sample) return { kind: 'none' };

    const moved = deltaNs(sample.eNs, latched.eNs) > DIVERGENCE_TOLERANCE_NS;
    const ok = qualifies(sample);
    // Sync arriving after an untraceable start: re-latch only if E moved with it.
    if (!latched.traceable && ok) {
        if (!moved) return { kind: 'traceable', traceable: true };
        return { kind: 'relatch', reason: now.stepped ? 'step' : 'sync' };
    }
    // Untraceable, a move waits for sync, so a boot step, its TAI write and the sync it brings
    // give one re-epoch (design Q15) instead of one each.
    if (moved && !latched.traceable && !now.settleExpired) return { kind: 'settle' };
    if (moved) return { kind: 'relatch', reason: now.stepped ? 'step' : 'divergence' };
    if (latched.traceable && !ok) return { kind: 'traceable', traceable: false };
    return now.stepped ? { kind: 'none', stepIgnored: true } : { kind: 'none' };
}

/** Parse one sidecar line; null for anything that is not a well-formed sample or step. */
export function parseClockLine(
    line: string,
): { type: 'sample'; sample: ClockSample } | { type: 'step'; monoNs: bigint } | null {
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    try {
        if (msg.type === 'step') return { type: 'step', monoNs: BigInt(String(msg.monoNs)) };
        if (msg.type !== 'sample') return null;
        return {
            type: 'sample',
            sample: {
                monoNs: BigInt(String(msg.monoNs)),
                eNs: BigInt(String(msg.eNs)),
                bracketNs: Number(msg.bracketNs),
                synced: msg.synced === true,
                taiOffsetS: Number(msg.taiOffsetS),
                estErrorUs: Number(msg.estErrorUs),
                maxErrorUs: Number(msg.maxErrorUs),
                freqPpm: Number(msg.freqPpm),
                status: Number(msg.status),
                leap: String(msg.leap),
            },
        };
    } catch {
        return null; // BigInt() throws on a malformed ns string
    }
}
