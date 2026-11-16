// Network egress on the house-time writer (house-clock plan ch. 9 WI-P5-10): the `mrtsegress`
// fragment and its bus reports, and EgressTimingReporter, which reads the writer's messages for
// the timing section's rows, the `net-time` badge, part 10's warnings and its log lines.
import type { EgressTimingSummary } from '@media-router/shared-types';
import type { HouseClockFields } from '../clock/houseClockProperty.js';
import type { BusReport } from './PluginModule.js';

/** `name=` of every egress module's writer: the house-clock binding and the stats address it. */
export const EGRESS_ELEMENT = 'egress';
export const EGRESS_STATS = 'mrtsegress-stats';
export const EGRESS_EVENT = 'mrtsegress-event';
/** Shown only while the wire's network time is not traceable (plan ch. 9 part 8). */
export const NET_TIME_BADGE = 'net-time';
/** The descriptor the writer puts in every PMT (`hcdesc::VERSION` 1). */
export const MRHT_TEXT = 'MRHT v1';

export const EGRESS_UNSTABLE_TEXT = (n: number): string =>
    `Egress delay unstable: ${n} changes in 10 min`;
export const EGRESS_AT_MAX_TEXT = 'Egress delay held at max; receivers get late content';
export const EGRESS_E_UNKNOWN_TEXT = 'Network time unknown: the egress carries no house time';

/** `mrtsegress name=<name> house-clock="…"`; `houseClock` is GstPluginBase.houseClockProperty()'s. */
export function buildEgressWriter({
    name = EGRESS_ELEMENT,
    houseClock,
}: {
    name?: string;
    houseClock: string;
}): string {
    return `mrtsegress name=${name} ${houseClock}`;
}

/** The writer's two messages, as `mrtsegress-stats:<name>` and `mrtsegress-event:<name>`. */
export function egressBusReports(name = EGRESS_ELEMENT): BusReport[] {
    return [
        { element: name, structure: EGRESS_STATS },
        { element: name, structure: EGRESS_EVENT },
    ];
}

/** What the wire declares: TAI with its epoch, source and error, or why it is not traceable. */
export function netTimeText(
    traceable: boolean,
    seq: number,
    clock: HouseClockFields | null | undefined,
): string {
    if (!clock || clock.eNs === 0n) return 'Not traceable (no house time)';
    if (!traceable) {
        const why =
            clock.source === 'none' || !clock.disciplined
                ? 'clock not synchronised'
                : 'clock not traceable to TAI';
        return `Not traceable (${why})`;
    }
    const source = clock.source === 'ptp' ? 'PTP' : 'chrony';
    const error =
        clock.errorUs === undefined
            ? 'error unknown'
            : `≤ ${Math.max(1, Math.ceil(clock.errorUs / 1000))} ms`;
    return `TAI, epoch ${seq}, ${source}, ${error}`;
}

export interface EgressLogLine {
    level: 'info' | 'warn';
    obj: Record<string, unknown>;
    msg: string;
}

interface Program {
    /** Last message of any kind; the stats' arrival, once one came. */
    seenAt: number;
    statsAt?: number;
    dENs: number;
    pcrIntervalMaxNs?: number;
    pcrInserted: number;
    pcrInsertedPerS?: number;
    packets: number;
    epochSeq: number;
    traceable: boolean;
    atMax: boolean;
    descriptorDropped: boolean;
}

const NS_PER_MS = 1_000_000;
const STALE_REPORTS = 3;
const CHANGE_WINDOW_MS = 600_000;
/** Part 10: more than this many D_e changes in 10 min is unstable. */
const UNSTABLE_CHANGES = 3;
const PCR_LATE_NS = 40 * NS_PER_MS;
const PCR_LOG_EVERY_MS = 3_600_000;
/** Engine log once per kind and programme each run (part 10). */
const ONCE_KINDS = new Set(['pcr-pid-assigned', 'pmt-grew', 'descriptor-dropped', 'cc-lost-in']);

type Payload = Record<string, unknown>;
const num = (p: Payload, k: string): number => Number(p[k] ?? NaN);
const ms = (ns: number): number => Math.round(ns / NS_PER_MS);

export class EgressTimingReporter {
    private readonly programs = new Map<number, Program>();
    /** When each D_e raise or lower came, over the last 10 min. */
    private changes: number[] = [];
    private readonly reEpochs = new Set<number>();
    private readonly told = new Set<string>();
    private pcrLateWindows = 0;
    private pcrLoggedAt: number | undefined;
    private unstable = false;

    constructor(private readonly intervalMs = 2000) {}

    /** `mrtsegress-stats:` and `mrtsegress-event:` channels: the log lines they make; null for
     *  any other channel. */
    onEvent(channel: string, payload: unknown, now = Date.now()): EgressLogLine[] | null {
        const p = (payload ?? {}) as Payload;
        if (channel.startsWith(`${EGRESS_STATS}:`)) return this.stats(p, now);
        if (channel.startsWith(`${EGRESS_EVENT}:`)) return this.event(p, now);
        return null;
    }

    reset(): void {
        this.programs.clear();
        this.changes = [];
        this.reEpochs.clear();
        this.told.clear();
        this.pcrLateWindows = 0;
        this.pcrLoggedAt = undefined;
        this.unstable = false;
    }

    /** The rows while the writer reports; undefined before its first stats and once stale. */
    summary(
        now: number,
        clock: HouseClockFields | null | undefined,
    ): EgressTimingSummary | undefined {
        const live = this.live(now);
        if (!live.length) return undefined;
        const defined = (xs: Array<number | undefined>): number[] =>
            xs.filter((x): x is number => x !== undefined);
        const intervals = defined(live.map((p) => p.pcrIntervalMaxNs));
        const rates = defined(live.map((p) => p.pcrInsertedPerS));
        const traceable = live.every((p) => p.traceable);
        const seq = Math.max(...live.map((p) => p.epochSeq));
        return {
            delayMs: Math.max(...live.map((p) => p.dENs)) / NS_PER_MS,
            delayChanges: this.recentChanges(now),
            ...(intervals.length ? { pcrIntervalMaxMs: Math.max(...intervals) / NS_PER_MS } : {}),
            ...(rates.length ? { pcrInsertedPerS: rates.reduce((a, b) => a + b, 0) } : {}),
            pcrLateWindows: this.pcrLateWindows,
            reEpochs: this.reEpochs.size,
            netTime: netTimeText(traceable, seq, clock),
            traceable: traceable && !!clock && clock.eNs !== 0n,
            descriptor: live.some((p) => p.descriptorDropped)
                ? 'Left out: the PMT would pass 1024 bytes'
                : MRHT_TEXT,
        };
    }

    /** Part 10's warnings, one text; null when none stands. Each clears by itself. */
    warning(now: number, clock: HouseClockFields | null | undefined): string | null {
        const n = this.recentChanges(now);
        if (n > UNSTABLE_CHANGES) this.unstable = true;
        else if (n === 0) this.unstable = false; // 10 min quiet
        const live = this.live(now);
        const parts = [
            ...(this.unstable ? [EGRESS_UNSTABLE_TEXT(n)] : []),
            ...(live.some((p) => p.atMax) ? [EGRESS_AT_MAX_TEXT] : []),
            ...(live.length && (!clock || clock.eNs === 0n) ? [EGRESS_E_UNKNOWN_TEXT] : []),
        ];
        return parts.length ? parts.join('; ') : null;
    }

    private live(now: number): Program[] {
        const staleMs = STALE_REPORTS * this.intervalMs;
        for (const [n, p] of this.programs) if (now - p.seenAt > staleMs) this.programs.delete(n);
        return [...this.programs.values()].filter((p) => p.statsAt !== undefined);
    }

    private recentChanges(now: number): number {
        this.changes = this.changes.filter((t) => now - t < CHANGE_WINDOW_MS);
        return this.changes.length;
    }

    private program(n: number, now: number): Program {
        let p = this.programs.get(n);
        if (!p) {
            p = {
                seenAt: now,
                dENs: 0,
                pcrInserted: 0,
                packets: 0,
                epochSeq: 0,
                traceable: false,
                atMax: false,
                descriptorDropped: false,
            };
            this.programs.set(n, p);
        }
        p.seenAt = now;
        return p;
    }

    private stats(s: Payload, now: number): EgressLogLine[] {
        const n = num(s, 'program');
        if (!Number.isFinite(n)) return [];
        const logs: EgressLogLine[] = [];
        const p = this.program(n, now);
        const inserted = num(s, 'pcr-inserted');
        const packets = num(s, 'packets');
        if (p.statsAt !== undefined && now > p.statsAt && inserted >= p.pcrInserted) {
            p.pcrInsertedPerS = ((inserted - p.pcrInserted) * 1000) / (now - p.statsAt);
        }
        const flowing = packets > p.packets;
        const interval = num(s, 'pcr-interval-max-ns');
        p.pcrIntervalMaxNs = interval > 0 ? interval : undefined;
        if (flowing && interval > PCR_LATE_NS) {
            this.pcrLateWindows++;
            if (this.pcrLoggedAt === undefined || now - this.pcrLoggedAt >= PCR_LOG_EVERY_MS) {
                this.pcrLoggedAt = now;
                logs.push({
                    level: 'info',
                    obj: { egressPcrInterval: { program: n, maxMs: ms(interval) } },
                    msg: `Egress PCR interval ${ms(interval)} ms, over 40 ms (logged once an hour)`,
                });
            }
        }
        if (num(s, 'merged-buffers') > 0) logs.push(...this.once('merged-buffers', -1, s));
        p.statsAt = now;
        p.dENs = Number.isFinite(num(s, 'd-e-ns')) ? num(s, 'd-e-ns') : p.dENs;
        p.pcrInserted = Number.isFinite(inserted) ? inserted : p.pcrInserted;
        p.packets = Number.isFinite(packets) ? packets : p.packets;
        p.epochSeq = Number.isFinite(num(s, 'epoch-seq')) ? num(s, 'epoch-seq') : p.epochSeq;
        p.traceable = s.traceable === true;
        return logs;
    }

    private event(e: Payload, now: number): EgressLogLine[] {
        const kind = String(e.kind ?? '');
        const n = num(e, 'program');
        const p = this.program(Number.isFinite(n) ? n : 0, now);
        const from = ms(num(e, 'from-ns'));
        const to = ms(num(e, 'to-ns'));
        const lateness = ms(num(e, 'lateness-ns'));
        const obj = { egressEvent: e };
        switch (kind) {
            case 'd-e-start':
                p.dENs = num(e, 'to-ns');
                p.atMax = false;
                return [
                    {
                        level: 'info',
                        obj,
                        msg: `Egress D_e ${to} ms at start (lateness ${lateness} ms)`,
                    },
                ];
            case 'd-e-raise':
                this.changes.push(now);
                p.dENs = num(e, 'to-ns');
                return [
                    {
                        level: 'info',
                        obj,
                        msg: `Egress D_e ${from} → ${to} ms (lateness ${lateness} ms)`,
                    },
                ];
            case 'd-e-lower':
                this.changes.push(now);
                p.dENs = num(e, 'to-ns');
                p.atMax = false;
                return [
                    {
                        level: 'info',
                        obj,
                        msg: `Egress D_e ${from} → ${to} ms (gap ${ms(num(e, 'gap-ns'))} ms)`,
                    },
                ];
            case 'd-e-max':
                p.atMax = true;
                return [
                    {
                        level: 'warn',
                        obj,
                        msg: `Egress D_e held at its max ${from} ms (lateness ${lateness} ms): receivers get late content`,
                    },
                ];
            case 're-epoch': {
                this.reEpochs.add(num(e, 'seq'));
                const delta = (num(e, 'delta-ns') / NS_PER_MS).toFixed(1);
                return [
                    {
                        level: 'info',
                        obj,
                        msg: `Egress re-epoch on the wire: epoch ${num(e, 'from-seq')} → ${num(e, 'seq')} (E moved ${delta} ms)`,
                    },
                ];
            }
            default:
                if (kind === 'descriptor-dropped') p.descriptorDropped = true;
                return ONCE_KINDS.has(kind) ? this.once(kind, n, e) : [];
        }
    }

    private once(kind: string, program: number, payload: Payload): EgressLogLine[] {
        const key = `${kind}:${program}`;
        if (this.told.has(key)) return [];
        this.told.add(key);
        const where = program >= 0 ? ` (programme ${program}, PID ${num(payload, 'pid')})` : '';
        return [
            {
                level: 'info',
                obj: { egressEvent: { kind, ...payload } },
                msg: `Egress ${kind}${where}`,
            },
        ];
    }
}
