// A network ingest's Trust gate as its card shows it (house-clock plan ch. 9 parts 8 and 10,
// WI-P5-11): per program the `mrtsrestamp-trust` report and the Trust events, the `trust` section,
// the `timing` badge, the three warnings, and the drain origin key p5-20 groups by.
import type { ModuleBadge } from '@media-router/shared-types';

const NS_PER_MS = 1_000_000;
/** Part 10: Trust selected and never qualified this long is a warning. */
export const NEVER_QUALIFIED_MS = 60_000;
/** B-204/B-205: an aligner paces at most 4 s; past it an input is re-anchored (S11). */
export const ALIGNER_CEILING_MS = 4_000;
/** p5-1's text form of `timeline_id` 0, "none". */
const NO_TIMELINE = '0000000000000000';

export const TRUST_SECTION = 'trust';
export const TRUST_BADGE = 'timing';

export type TrustState =
    | 'restamp'
    | 'deciding'
    | 'qualifying'
    | 'trust'
    | 'converging'
    | 'fallback'
    | 'returning';
const TRUST_STATES = new Set<string>([
    'restamp',
    'deciding',
    'qualifying',
    'trust',
    'converging',
    'fallback',
    'returning',
]);
/** Labels on the Trust timeline: the drain groups key them by the sender's timeline (p5-20). */
const MAPPED = new Set<TrustState>(['trust', 'converging']);

export interface TrustDecl {
    tai: boolean;
    disciplined: boolean;
    traceable: boolean;
    source: string;
    taiOffsetS?: number;
    /** -1: the sender declares no PTP. */
    ptpDomain: number;
    gm: string;
    errorClass?: number;
    epochSeq?: number;
    dEMs?: number;
    timeline: string;
}

export interface ProgramTrust {
    /** Arrival of its last report or event. */
    at: number;
    selected: 'restamp' | 'trust';
    effective: TrustState;
    /** The first failing condition's code; '' while the link qualifies. */
    failed: string;
    transit?: [min: number, median: number, max: number];
    boundLoMs?: number;
    boundMs?: number;
    lMs?: number;
    convergingLeftMs?: number;
    decl?: TrustDecl;
    /** Since when Trust is selected, and whether it reached the Trust timeline since. */
    selectedSince?: number;
    qualified: boolean;
    /** What put it in fallback, kept through `returning` (the report then qualifies). */
    fallbackFailed?: string;
    lastSwitch?: { at: number; toTrust: boolean; gapMs?: number; convergingMs?: number };
    /** Its transport dropped since its last report (B-118). */
    down?: boolean;
}

type Payload = Record<string, unknown>;
const num = (p: Payload, key: string): number | undefined => {
    const v = p[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const ms = (p: Payload, key: string): number | undefined => {
    const v = num(p, key);
    return v === undefined ? undefined : v / NS_PER_MS;
};
const text = (p: Payload, key: string): string => {
    const v = p[key];
    return typeof v === 'string' ? v : '';
};

/** One ingest's Trust gates, from `mrtsrestamp-trust` and the Trust kinds of `mrtsrestamp-event`. */
export class IngestTrust {
    readonly programs = new Map<number, ProgramTrust>();

    report(p: Payload, now: number): void {
        const t = this.program(num(p, 'program') ?? 0, now);
        t.at = now;
        t.down = undefined;
        t.selected = text(p, 'selected') === 'trust' ? 'trust' : 'restamp';
        this.enter(t, text(p, 'effective'), text(p, 'failed'), now);
        t.failed = p.qualifies === true ? '' : text(p, 'failed');
        const [min, median, max] = ['transit-min-ns', 'transit-median-ns', 'transit-max-ns'].map(
            (k) => ms(p, k),
        );
        t.transit =
            min !== undefined && median !== undefined && max !== undefined
                ? [min, median, max]
                : undefined;
        t.boundLoMs = ms(p, 'bound-lo-ns');
        t.boundMs = ms(p, 'bound-ns');
        t.lMs = ms(p, 'l-ns');
        t.convergingLeftMs = ms(p, 'converging-remaining-ns');
        t.decl = p['decl-present'] === true ? declOf(p) : undefined;
        if (t.selected === 'trust') t.selectedSince ??= now;
        else {
            t.selectedSince = undefined;
            t.qualified = false;
            t.fallbackFailed = undefined;
        }
    }

    /** A Trust event moves the program at once, not at its next report (up to 2 s later): the drain
     *  key follows a fallback at the next drain refresh (p5-20, V-P5-13). */
    event(p: Payload, now: number): void {
        const kind = text(p, 'kind');
        if (!kind.startsWith('trust-')) return;
        const t = this.program(num(p, 'program') ?? 0, now);
        const state = text(p, 'state');
        this.enter(t, state, text(p, 'failed'), now);
        if (kind === 'trust-switch' && TRUST_STATES.has(state)) {
            const gap = ms(p, 'gap-ns');
            const conv = ms(p, 'converging-ns');
            t.lastSwitch = {
                at: now,
                toTrust: MAPPED.has(state as TrustState),
                gapMs: gap !== undefined && gap > 0 ? gap : undefined,
                convergingMs: state === 'converging' ? conv : undefined,
            };
        }
    }

    /** The transport dropped: no program is on any timeline until its next report. */
    down(): void {
        for (const t of this.programs.values()) t.down = true;
    }

    expire(newest: number, staleMs: number): void {
        for (const [n, t] of this.programs) if (newest - t.at > staleMs) this.programs.delete(n);
    }

    /** p5-20's key: the sender's `timeline_id` (16 hex digits) when every program the restamp
     *  reports is on the Trust timeline (`trust` or `converging`) and all declare one non-zero id;
     *  else undefined, and the module groups by its own id. */
    originKey(): string | undefined {
        return this.origin().key;
    }

    /** The key, and why an MPTS has none though one of its programs is on the Trust timeline. */
    origin(): { key?: string; disagree?: string } {
        const all = [...this.programs].sort(([a], [b]) => a - b);
        if (!all.length) return {};
        const on = all.filter(([, t]) => !t.down && MAPPED.has(t.effective));
        const ids = new Set(on.map(([, t]) => t.decl?.timeline ?? NO_TIMELINE));
        if (on.length === all.length && ids.size === 1 && !ids.has(NO_TIMELINE)) {
            return { key: [...ids][0] };
        }
        if (!on.length || all.length < 2) return {};
        const parts = all.map(
            ([n, t]) =>
                `program ${n} ${t.down ? 'down' : t.effective}${MAPPED.has(t.effective) ? ` ${t.decl?.timeline ?? NO_TIMELINE}` : ''}`,
        );
        return { disagree: parts.join(', ') };
    }

    private enter(t: ProgramTrust, state: string, failed: string, now: number): void {
        if (!TRUST_STATES.has(state)) return;
        const s = state as TrustState;
        if (MAPPED.has(s)) t.qualified = true;
        if (s === 'fallback' && failed) t.fallbackFailed = failed;
        if (s === 'trust' || s === 'converging' || s === 'restamp') t.fallbackFailed = undefined;
        if (s !== 'restamp' && t.selected === 'restamp' && t.effective === 'restamp') {
            // An event ahead of the report naming the selection: Trust is selected.
            t.selected = 'trust';
            t.selectedSince ??= now;
        }
        t.effective = s;
    }

    private program(n: number, now: number): ProgramTrust {
        let t = this.programs.get(n);
        if (!t) {
            t = {
                at: now,
                selected: 'restamp',
                effective: 'restamp',
                failed: '',
                qualified: false,
            };
            this.programs.set(n, t);
        }
        return t;
    }
}

function declOf(p: Payload): TrustDecl {
    const cls = num(p, 'decl-error-class');
    return {
        tai: p['decl-tai'] === true,
        disciplined: p['decl-disciplined'] === true,
        traceable: p['decl-traceable'] === true,
        source: text(p, 'decl-source'),
        taiOffsetS: num(p, 'decl-tai-offset-s'),
        ptpDomain: num(p, 'decl-ptp-domain') ?? -1,
        gm: text(p, 'decl-gm'),
        errorClass: cls,
        epochSeq: num(p, 'decl-epoch-seq'),
        dEMs: ms(p, 'decl-d-e-ns'),
        timeline: /^[0-9a-f]{16}$/.test(text(p, 'decl-timeline-id'))
            ? text(p, 'decl-timeline-id')
            : NO_TIMELINE,
    };
}

// ---- The card ----

/** "40 ms" under a second, "2.2 s" from one: transit, bounds and remaining k. */
export const spanText = (v: number): string =>
    Math.abs(v) < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;

const EFFECTIVE: Record<TrustState, string> = {
    restamp: 'Restamp',
    deciding: 'Deciding',
    qualifying: 'Qualifying',
    trust: 'Trust',
    converging: 'Converging',
    fallback: 'Restamp — fallback',
    returning: 'Returning',
};

// Part 8's badge: none in Restamp; with several programs the worst.
const BADGE: Partial<Record<TrustState, { text: string; color: string; rank: number }>> = {
    trust: { text: 'Trust', color: '#10b981', rank: 0 },
    converging: { text: 'Converging', color: '#10b981', rank: 1 },
    deciding: { text: 'Deciding', color: '#6b7280', rank: 2 },
    qualifying: { text: 'Qualifying', color: '#6b7280', rank: 2 },
    returning: { text: 'Fallback', color: '#f59e0b', rank: 3 },
    fallback: { text: 'Fallback', color: '#f59e0b', rank: 3 },
};

const SOURCES = new Map([
    ['ntp', 'NTP'],
    ['sntp', 'SNTP'],
    ['ptp', 'PTP'],
    ['none', 'none'],
]);

/** A failed condition in words: `long` for the section (with the figures), `short` for a
 *  warning, whose text must not move with every report. */
export function failedText(code: string, t: ProgramTrust, long: boolean): string {
    const bound = t.boundMs === undefined ? 'its' : `the ${spanText(t.boundMs)}`;
    switch (code) {
        case 'no-descriptor':
            return long ? 'No house-time descriptor from the sender' : 'no house-time descriptor';
        case 'not-house-time':
            return long ? 'The sender does not declare house time' : 'sender not on house time';
        case 'sender-undisciplined':
            return long
                ? "The sender's clock is not synchronised"
                : 'sender clock not synchronised';
        case 'local-undisciplined':
            return long ? "This box's clock is not synchronised" : 'this clock not synchronised';
        case 'transit-high':
            return long && t.transit
                ? `Transit ${spanText(t.transit[2])} above ${bound} bound`
                : `transit above ${bound} bound`;
        case 'transit-negative':
            return long && t.transit
                ? `Transit ${spanText(t.transit[0])}, below the ${spanText(t.boundLoMs ?? 0)} floor`
                : 'transit below zero';
        default:
            return code;
    }
}

export interface TrustRowSpec {
    key: string;
    label: string;
    unit?: string;
    /** A number (compared in ms), a text, or undefined for a dash. */
    value: number | string | undefined;
    /** For a [min, median, max] triple. */
    triple?: [number, number, number];
}

const yes = (b: boolean): string => (b ? 'yes' : 'no');

/** "≤ 2.0 ms": class c bounds the sender's error by 2^c µs; 0xFF (or past 31) is unknown. */
function errorText(cls: number | undefined): string {
    if (cls === undefined || cls < 0 || cls > 31) return 'unknown';
    const us = 2 ** cls;
    if (us < 1000) return `≤ ${us} µs`;
    return us < 10_000 ? `≤ ${(us / 1000).toFixed(1)} ms` : `≤ ${spanText(us / 1000)}`;
}

function ago(at: number, now: number): string {
    const min = Math.max(0, Math.floor((now - at) / 60_000));
    if (min < 1) return 'just now';
    return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

/** The `trust` section's rows (part 8). `lSource` names where L comes from ("SRT negotiated"). */
export function trustRows(t: ProgramTrust, now: number, lSource: string): TrustRowSpec[] {
    const rows: TrustRowSpec[] = [];
    const inTrust = t.selected === 'trust';
    rows.push({ key: 'mode', label: 'Timing mode', value: inTrust ? 'Trust' : 'Restamp' });
    const left = t.convergingLeftMs;
    const effective =
        t.down === true
            ? 'No stream'
            : t.effective === 'converging' && left !== undefined
              ? `Converging (${spanText(left)} left)`
              : EFFECTIVE[t.effective];
    rows.push({ key: 'effective', label: 'In effect', value: effective });
    if (inTrust) {
        rows.push({
            key: 'failed',
            label: 'Failed condition',
            value: t.failed ? failedText(t.failed, t, true) : undefined,
        });
    } else if (t.decl) {
        // In Restamp the gate runs for display only: would the link qualify (ch. 9 part 4.8)?
        const why = t.failed ? `no (${failedText(t.failed, t, true)})` : 'yes';
        rows.push({ key: 'qualify', label: 'Would qualify for Trust', value: why });
    }
    rows.push({
        key: 'transit',
        label: 'Transit min / median / max',
        unit: 'ms',
        value: undefined,
        triple: t.transit,
    });
    rows.push({ key: 'bound', label: 'Bound L + τ', unit: 'ms', value: t.boundMs });
    const l = t.lMs === undefined ? undefined : `${Math.round(t.lMs)} ms`;
    rows.push({
        key: 'latency',
        label: 'Link latency L',
        value: l && lSource ? `${lSource} ${l}` : l,
    });
    if (t.boundMs !== undefined) {
        const b = spanText(t.boundMs);
        rows.push({
            key: 'ceiling',
            label: "Bound against the aligners' 4 s ceiling",
            value:
                t.boundMs > ALIGNER_CEILING_MS
                    ? `${b}, above: aligners re-anchor this input`
                    : `${b} of 4 s`,
        });
    }
    const d = t.decl;
    if (d) {
        const src = SOURCES.get(d.source) ?? d.source;
        rows.push(
            { key: 'senderHouseTime', label: 'Sender house time', value: yes(d.tai) },
            {
                key: 'senderSync',
                label: 'Sender sync',
                value: `${src}${d.disciplined ? '' : ', not synchronised'}, ${d.traceable ? 'traceable' : 'not traceable'}`,
            },
            {
                key: 'senderTaiUtc',
                label: 'Sender TAI − UTC',
                value: d.taiOffsetS === undefined ? undefined : `${d.taiOffsetS} s`,
            },
            {
                key: 'senderPtp',
                label: 'Sender PTP',
                value:
                    d.ptpDomain >= 0
                        ? `domain ${d.ptpDomain}${d.gm ? `, grandmaster ${d.gm}` : ''}`
                        : undefined,
            },
            { key: 'senderError', label: 'Sender clock error', value: errorText(d.errorClass) },
            { key: 'senderDelay', label: 'Sender delay D_e', unit: 'ms', value: d.dEMs },
            { key: 'senderEpoch', label: 'Sender epoch', value: d.epochSeq },
            {
                key: 'timeline',
                label: 'Sender timeline',
                value: d.timeline === NO_TIMELINE ? 'none' : d.timeline,
            },
        );
    }
    const s = t.lastSwitch;
    let last: string | undefined;
    if (s) {
        const what =
            s.convergingMs !== undefined
                ? `, converging ${spanText(s.convergingMs)}`
                : s.gapMs !== undefined
                  ? `, gap ${spanText(s.gapMs)}`
                  : '';
        last = `to ${s.toTrust ? 'Trust' : 'Restamp'}${what}, ${ago(s.at, now)}`;
    }
    rows.push({ key: 'lastSwitch', label: 'Last switch', value: last });
    return rows;
}

/** Part 10's Trust warnings for one program, and its badge state (none in Restamp). */
export function trustWarnings(t: ProgramTrust, now: number): string[] {
    if (t.selected !== 'trust' || t.down) return [];
    const out: string[] = [];
    if (!t.qualified) {
        // Never on the Trust timeline since the selection, and still failing after 60 s.
        const held = t.selectedSince !== undefined && now - t.selectedSince >= NEVER_QUALIFIED_MS;
        if (held && t.failed) {
            out.push(
                `Trust selected but stream does not qualify: ${failedText(t.failed, t, false)}`,
            );
        }
    } else if (t.effective === 'fallback' || t.effective === 'returning') {
        const reason = t.failed || t.fallbackFailed;
        out.push(
            `Trust fallback: ${reason ? failedText(reason, t, false) : 'disqualified'}; restamping`,
        );
    }
    if (t.boundMs !== undefined && t.boundMs > ALIGNER_CEILING_MS) {
        out.push(`Trust bound above the aligners' 4 s ceiling (${spanText(t.boundMs)})`);
    }
    return out;
}

/** The worst program's `timing` badge; null with every program in Restamp (or none). */
export function trustBadge(programs: ProgramTrust[]): Omit<ModuleBadge, 'id'> | null {
    let worst: { text: string; color: string; rank: number } | undefined;
    for (const t of programs) {
        if (t.selected !== 'trust' || t.down) continue;
        const b = BADGE[t.effective];
        if (b && (!worst || b.rank > worst.rank)) worst = b;
    }
    return worst ? { icon: 'clock', text: worst.text, color: worst.color } : null;
}
