// What an ingest's timing messages say (house-clock plan ch. 5 part 10), kept for its card: per
// program the clock, per PID the lead and trims, the ASRC, the transport counters, and the windows
// behind part 10's warnings. IngestTimingReporter feeds it; ingestTimingView.ts renders it.

const MINUTE = 60_000;
const NS_PER_MS = 1_000_000;
// Part 10's windows: re-locks over 10 min, a lead clamp held a minute, dropped PES over 10 min,
// transport errors over 10 s; the source rate past 100 ppm and the ASRC ratio past 200 ppm.
const RELOCK_WINDOW_MS = 10 * MINUTE;
const LEAD_CLAMP_HOLD_MS = MINUTE;
const DROPPED_WINDOW_MS = 10 * MINUTE;
export const CORRUPTION_MS = 10_000;
const RATE_ALARM_PPB = 100_000;
const ASRC_ALARM_PPB = 200_000;

export type ClockState = 'acquiring' | 'locked' | 'degraded' | 'lost';
const CLOCK_STATES = new Set<string>(['acquiring', 'locked', 'degraded', 'lost']);

/** A cumulative counter: its rise over a trailing window, and how long it has kept rising
 *  (rises less than a window apart). A fall means the element restarted from 0: the count goes
 *  on from the total, so a window across the restart keeps what was counted before it. */
export class Counter {
    private samples: Array<[at: number, value: number]> = [];
    /** The element's last value, and the total it had reached at its last restart. */
    private lastRaw = 0;
    private carried = 0;
    private since: number | undefined;
    private lastRise: number | undefined;

    constructor(private readonly windowMs: number) {}

    add(at: number, raw: number): void {
        const last = this.samples[this.samples.length - 1];
        if (last && raw < this.lastRaw) this.carried = last[1];
        this.lastRaw = raw;
        const value = this.carried + raw;
        if (last && value > last[1]) {
            if (this.lastRise === undefined || at - this.lastRise >= this.windowMs) this.since = at;
            this.lastRise = at;
        }
        this.samples.push([at, value]);
        this.prune(at);
    }

    /** Measured from the newest sample at or before the window's start, else the oldest. */
    over(now: number): number {
        this.prune(now);
        const s = this.samples;
        return s.length ? s[s.length - 1][1] - s[0][1] : 0;
    }

    /** How long it has kept rising; 0 once a window has passed since the last rise, when `over`
     *  no longer counts it. */
    risingFor(now: number): number {
        const { since, lastRise } = this;
        if (since === undefined || lastRise === undefined || now - lastRise >= this.windowMs) {
            return 0;
        }
        return lastRise - since;
    }

    private prune(now: number): void {
        const s = this.samples;
        while (s.length > 1 && s[1][0] <= now - this.windowMs) s.shift();
    }
}

export interface ProgramClock {
    /** Arrival of its last stats; unset while only events have come. */
    at?: number;
    state: ClockState;
    reason: string;
    ppb?: number;
    residualMs?: number;
    relocks?: number;
    /** The PCR's own cadence (B-86); unset while unknown. */
    pcrCadenceMs?: number;
    /** The longest late PCR interval of the last minute. */
    pcrGapMaxMs?: number;
    cadence: boolean;
    /** Since when |ppb| is past 100 ppm. */
    rateOffSince?: number;
    relockLog: Array<{ at: number; reason: string }>;
    lastEvent?: { at: number; kind: string; reason: string };
    /** The PID the `degraded` event named: the one whose PTS the timing follows. */
    refPid?: number;
}

export interface PidClock {
    at: number;
    streamType: number;
    lead?: [min: number, median: number, max: number];
    trimMs?: number;
    shiftMs?: number;
    dropped: Counter;
}

export interface AsrcClock {
    at: number;
    ratioPpb?: number;
    phaseMs?: number;
    relocks?: number;
    /** Since when |ratio| is past 200 ppm. */
    offSince?: number;
}

type Payload = Record<string, unknown>;
const num = (p: Payload, key: string): number | undefined => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const nsToMs = (p: Payload, key: string): number | undefined => {
    const v = num(p, key);
    return v === undefined ? undefined : v / NS_PER_MS;
};
export const str = (p: Payload, key: string): string => {
    const v = p[key];
    return typeof v === 'string' ? v : '';
};
const offSince = (v: number | undefined, limit: number, since: number | undefined, now: number) =>
    v !== undefined && Math.abs(v) > limit ? (since ?? now) : undefined;

/** One ingest's clock, from the `mrtsrestamp-*` and `mrasrc-*` payloads (ns fields → ms). */
export class IngestClock {
    readonly programs = new Map<number, ProgramClock>();
    readonly pids = new Map<number, PidClock>();
    /** PID → its last `lead-clamp` event. */
    readonly leadClamps = new Map<number, number>();
    asrc: AsrcClock | undefined;
    readonly ccLost = new Counter(CORRUPTION_MS);
    readonly desyncBytes = new Counter(CORRUPTION_MS);
    /** Arrival of the newest periodic report: entries far behind it have left the stream. */
    private newest = 0;

    stats(p: Payload, now: number): void {
        this.newest = now;
        const prog = this.program(num(p, 'program') ?? 0);
        const state = str(p, 'state');
        prog.at = now;
        prog.state = CLOCK_STATES.has(state) ? (state as ClockState) : 'acquiring';
        const reason = str(p, 'reason') === 'none' ? '' : str(p, 'reason');
        // Degraded, the rate is the reference lock's: a switch either way restarts its alarm's hold.
        if ((reason !== '') !== (prog.reason !== '')) prog.rateOffSince = undefined;
        prog.reason = reason;
        prog.ppb = num(p, 'ppb');
        prog.residualMs = nsToMs(p, 'residual-p99-ns');
        prog.relocks = num(p, 'relocks');
        prog.pcrCadenceMs = nsToMs(p, 'pcr-cadence-ns') || undefined;
        prog.pcrGapMaxMs = nsToMs(p, 'pcr-gap-max-ns');
        prog.cadence = p['cadence-warning'] === true;
        prog.rateOffSince = offSince(prog.ppb, RATE_ALARM_PPB, prog.rateOffSince, now);
        // Chapter 3's counters are element-wide: each program's report carries the same totals.
        const cc = num(p, 'cc-lost');
        if (cc !== undefined) this.ccLost.add(now, cc);
        const desync = num(p, 'desync-bytes');
        if (desync !== undefined) this.desyncBytes.add(now, desync);
    }

    pid(p: Payload, now: number): void {
        const pid = num(p, 'pid');
        if (pid === undefined || pid < 0) return;
        this.newest = now;
        const c: PidClock = this.pids.get(pid) ?? {
            at: now,
            streamType: 0,
            dropped: new Counter(DROPPED_WINDOW_MS),
        };
        const [min, median, max] = ['lead-min-ns', 'lead-median-ns', 'lead-max-ns'].map((k) =>
            nsToMs(p, k),
        );
        c.at = now;
        c.streamType = num(p, 'stream-type') ?? c.streamType;
        const known = min !== undefined && median !== undefined && max !== undefined;
        c.lead = known ? [min, median, max] : undefined;
        c.trimMs = nsToMs(p, 'trim-ns');
        c.shiftMs = nsToMs(p, 'shift-ns');
        const dropped = num(p, 'dropped-pes');
        if (dropped !== undefined) c.dropped.add(now, dropped);
        this.pids.set(pid, c);
    }

    event(p: Payload, now: number): void {
        const kind = str(p, 'kind');
        const reason = str(p, 'reason');
        const pid = num(p, 'pid') ?? -1;
        const prog = this.program(num(p, 'program') ?? 0);
        prog.lastEvent = { at: now, kind, reason };
        if (kind === 'relock') prog.relockLog.push({ at: now, reason });
        // The degraded event names the reference PID whose PTS the timing then follows.
        if (kind === 'degraded') prog.refPid = pid >= 0 ? pid : undefined;
        if (kind === 'recovered') prog.refPid = undefined;
        if (kind === 'lead-clamp' && pid >= 0) this.leadClamps.set(pid, now);
    }

    asrcStats(p: Payload, now: number): void {
        this.newest = now;
        const ratioPpb = num(p, 'ratio-ppb');
        this.asrc = {
            at: now,
            ratioPpb,
            phaseMs: nsToMs(p, 'phase-err-ns'),
            relocks: num(p, 'relocks'),
            offSince: offSince(ratioPpb, ASRC_ALARM_PPB, this.asrc?.offSince, now),
        };
    }

    /** Drop what is behind the newest report by `staleMs` (gone from the stream; a silent
     *  stream keeps its last values) and what left part 10's windows. A program heard of only
     *  through events (a PAT change names program -1) goes by its last event. */
    expire(now: number, staleMs: number): void {
        for (const [n, p] of this.programs) {
            const at = p.at ?? p.lastEvent?.at;
            if (at !== undefined && this.newest - at <= staleMs) {
                p.relockLog = p.relockLog.filter((r) => now - r.at <= RELOCK_WINDOW_MS);
            } else this.programs.delete(n);
        }
        for (const [pid, c] of this.pids) if (this.newest - c.at > staleMs) this.pids.delete(pid);
        for (const [pid, at] of this.leadClamps) {
            if (now - at > LEAD_CLAMP_HOLD_MS) this.leadClamps.delete(pid);
        }
        if (this.asrc && this.newest - this.asrc.at > staleMs) this.asrc = undefined;
    }

    private program(n: number): ProgramClock {
        let p = this.programs.get(n);
        if (!p) {
            p = { state: 'acquiring', reason: '', cadence: false, relockLog: [] };
            this.programs.set(n, p);
        }
        return p;
    }
}
