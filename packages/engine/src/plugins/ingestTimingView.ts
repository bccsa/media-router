// What an ingest card shows (house-clock plan ch. 5 part 8) and part 10's warnings, rendered from
// an IngestClock; plus the change test that throttles the publication.
import type { ModuleBadge, StatusValue } from '@media-router/shared-types';
import type { RestampMode } from './ingestTiming.js';
import {
    CORRUPTION_MS,
    type ClockState,
    type IngestClock,
    type PidClock,
} from './ingestTimingState.js';

export const CLOCK_SECTION = 'clock';
export const CLOCK_BADGE = 'clock';
/** The Per-PID Trim setting's `x-optionsFrom`. */
export const PIDS_OPTIONS = 'pids';

// Part 10: more than 3 re-locks in the window; a rate or ratio past its bound for a minute.
const RELOCK_ALARM = 3;
const OFF_HOLD_MS = 60_000;
const NONE = '—';

// Part 8's badge; with several programs it shows the worst.
const CLOCK_STATES: Record<ClockState, { text: string; color: string; rank: number }> = {
    locked: { text: 'Locked', color: '#10b981', rank: 0 },
    acquiring: { text: 'Acquiring', color: '#6b7280', rank: 1 },
    degraded: { text: 'Degraded', color: '#f59e0b', rank: 2 },
    lost: { text: 'No PCR', color: '#f59e0b', rank: 3 },
};

// The core's reason codes (ts_stc.cpp: failing validator rows, re-lock triggers) as words.
const REASONS = new Map([
    ['cadence', 'PCR too sparse'],
    ['rate', 'PCR rate out of range'],
    ['freeze', 'PCR frozen'],
    ['leap', 'PCR jump'],
    ['lead', 'lead out of range'],
    ['discontinuity', 'PCR discontinuity'],
    ['envelope-step', 'network delay step'],
    ['external', 'PCR PID changed'],
    ['ref-change', 'reference PID changed'],
    ['backlog', 'reconnect backlog'],
]);
const reasonText = (code: string): string => REASONS.get(code) ?? code;

// PMT stream_type (ISO/IEC 13818-1 table 2-34). 0x06 carries teletext, subtitles, Opus and 302M
// alike: only descriptors tell them apart, and the PID message carries none.
const STREAM_TYPES = new Map([
    [0x01, 'MPEG-1 video'],
    [0x02, 'MPEG-2 video'],
    [0x03, 'MPEG-1 audio'],
    [0x04, 'MPEG-2 audio'],
    [0x06, 'private data'],
    [0x0f, 'AAC audio'],
    [0x11, 'AAC-LATM audio'],
    [0x15, 'metadata'],
    [0x1b, 'H.264 video'],
    [0x24, 'H.265 video'],
    [0x81, 'AC-3 audio'],
    [0x87, 'E-AC-3 audio'],
]);
const streamTypeLabel = (t: number): string =>
    STREAM_TYPES.get(t) ?? `stream type 0x${t.toString(16).padStart(2, '0')}`;

/** `0x0100`, as the card and the trim widget show a PID. */
const pidHex = (pid: number): string => `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`;

/** A displayed row. `cmp` holds its values unrounded, in units where 1 is the display step
 *  (1 ms, 0.01 ppm, one count): the throttle publishes a move of 1 or a changed text. */
export interface Row {
    key: string;
    label: string;
    unit?: string;
    value: StatusValue;
    cmp: Array<number | string>;
}

export interface View {
    sections: Array<{ id: string; label: string; rows: Row[] }>;
    badge: Omit<ModuleBadge, 'id'> | null;
    options: Array<{ value: string; label: string }>;
    warnings: string[];
}

export const EMPTY_VIEW: View = { sections: [], badge: null, options: [], warnings: [] };

const unitOf = (unit?: string) => (unit ? { unit } : {});
function numRow(key: string, label: string, raw: number | undefined, unit?: string): Row {
    if (raw === undefined) return { key, label, ...unitOf(unit), value: NONE, cmp: [NONE] };
    return { key, label, ...unitOf(unit), value: Math.round(raw), cmp: [raw] };
}
/** ppm to two decimals (part 8), compared in hundredths of a ppm. */
function ppmRow(key: string, label: string, ppb: number | undefined): Row {
    const row = numRow(key, label, ppb === undefined ? undefined : ppb / 10, 'ppm');
    return typeof row.value === 'number' ? { ...row, value: row.value / 100 } : row;
}
const textRow = (key: string, label: string, text: string): Row => ({
    key,
    label,
    value: text,
    cmp: [text],
});
function leadRow(lead: PidClock['lead']): Row {
    const row = numRow('lead', 'Lead min / median / max', undefined, 'ms');
    return lead ? { ...row, value: lead.map((v) => Math.round(v)).join(' / '), cmp: lead } : row;
}

// Minute buckets: the text is the row's compare key, so a finer age would republish every tick.
function ago(ms: number): string {
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 1) return 'just now';
    return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}
const ppmOff = (ppb: number): number => Math.round(Math.abs(ppb) / 1000);
const held = (since: number | undefined, now: number): boolean =>
    since !== undefined && now - since >= OFF_HOLD_MS;
const sorted = <T>(m: Map<number, T>): Array<[number, T]> => [...m].sort(([a], [b]) => a - b);

/** The card and its warnings; a program without stats for `staleMs` reads "No PCR". */
export function ingestView(c: IngestClock, mode: RestampMode, now: number, staleMs: number): View {
    const v: View = { sections: [], badge: null, options: [], warnings: [] };
    if (mode === 'stc') networkView(v, c, now, staleMs);
    else captureView(v, c, now, staleMs);
    const rising = Math.max(c.ccLost.risingFor(now), c.desyncBytes.risingFor(now));
    if (rising >= CORRUPTION_MS) {
        const cc = c.ccLost.over(now);
        const bytes = c.desyncBytes.over(now);
        const what = [
            cc > 0 ? `${cc} continuity error${cc === 1 ? '' : 's'}` : '',
            bytes > 0 ? `${bytes} bytes out of sync` : '',
        ].filter(Boolean);
        v.warnings.push(`Transport errors: ${what.join(', ')} in 10 s`);
    }
    return v;
}

function networkView(v: View, c: IngestClock, now: number, staleMs: number): void {
    const programs = sorted(c.programs).filter(([, p]) => p.at !== undefined);
    let worst: ClockState | undefined;
    for (const [n, p] of programs) {
        // The element posts from the streaming thread: no stats means no packets.
        const fresh = now - (p.at ?? 0) <= staleMs;
        const state: ClockState = fresh ? p.state : 'lost';
        if (!worst || CLOCK_STATES[state].rank > CLOCK_STATES[worst].rank) worst = state;
        const why = p.reason ? ` (${reasonText(p.reason)})` : '';
        const e = p.lastEvent;
        const eventWhy = e?.reason ? ` (${reasonText(e.reason)})` : '';
        const one = programs.length === 1;
        v.sections.push({
            id: one ? CLOCK_SECTION : `${CLOCK_SECTION}-${n}`,
            label: one ? 'Clock' : `Clock · program ${n}`,
            rows: [
                textRow(
                    'state',
                    'State',
                    CLOCK_STATES[state].text + (state === 'degraded' ? why : ''),
                ),
                ppmRow('sourceRate', 'Source rate', p.ppb),
                numRow('residualP99', 'Residual p99', p.residualMs, 'ms'),
                numRow('relocks', 'Re-locks', p.relocks),
                textRow(
                    'lastEvent',
                    'Last event',
                    e ? `${e.kind.replace(/-/g, ' ')}${eventWhy}, ${ago(now - e.at)}` : NONE,
                ),
            ],
        });
        if (!fresh) continue;
        if (state === 'degraded') {
            const from = p.refPid === undefined ? "the reference PID's" : `PID ${pidHex(p.refPid)}`;
            const cause = p.reason ? reasonText(p.reason) : 'PCR unusable';
            v.warnings.push(`Degraded clock: ${cause} — timing from ${from} PTS against arrival`);
        }
        const relocks = p.relockLog.length;
        if (relocks > RELOCK_ALARM) {
            const last = reasonText(p.relockLog[relocks - 1].reason) || 'unknown';
            v.warnings.push(`Source clock unstable: ${relocks} re-locks in 10 min (last: ${last})`);
        }
        if (p.ppb !== undefined && held(p.rateOffSince, now)) {
            v.warnings.push(`Source clock off by ${ppmOff(p.ppb)} ppm`);
        }
        // The element's flag is part 10's condition (p99 over 10 s past 150 ms); n is the longest
        // interval of the last report, the only interval the stats carry.
        if (p.cadence && p.pcrMaxMs !== undefined) {
            v.warnings.push(`PCR every ${Math.round(p.pcrMaxMs)} ms (spec ≤ 100 ms)`);
        }
    }
    if (worst) {
        const { text, color } = CLOCK_STATES[worst];
        v.badge = { icon: 'clock', text, color };
    }
    for (const [pid, pc] of sorted(c.pids)) {
        const type = streamTypeLabel(pc.streamType);
        v.sections.push({
            id: `pid-${pid}`,
            label: `PID ${pidHex(pid)} · ${type}`,
            rows: [
                leadRow(pc.lead),
                numRow('trim', 'Trim', pc.trimMs, 'ms'),
                numRow('shift', 'Shift O + trim', pc.shiftMs, 'ms'),
                numRow('dropped', 'Dropped (last 10 min)', pc.dropped.over(now), 'PES'),
            ],
        });
        v.options.push({ value: String(pid), label: `${pidHex(pid)} ${type}` });
    }
    if (c.leadClamps.size) {
        const pids = sorted(c.leadClamps).map(([pid]) => pidHex(pid));
        v.warnings.push(`Source lead above 4 s on PID ${pids.join(', ')} — clamped`);
    }
}

function captureView(v: View, c: IngestClock, now: number, staleMs: number): void {
    const rows: Row[] = [];
    const a = c.asrc;
    if (a) {
        rows.push(
            ppmRow('asrcRatio', 'ASRC ratio', a.ratioPpb),
            numRow('phaseError', 'Phase error', a.phaseMs, 'ms'),
            numRow('relocks', 'Re-locks', a.relocks),
        );
        if (a.ratioPpb !== undefined && now - a.at <= staleMs && held(a.offSince, now)) {
            const ppm = ppmOff(a.ratioPpb);
            v.warnings.push(`Device clock off by ${ppm} ppm — check the device's sample rate`);
        }
    }
    // A capture has no trim (OQ-15): its PID's shift is O as the restamp applies it.
    const shift = sorted(c.pids)[0]?.[1].shiftMs;
    if (shift !== undefined) rows.push(numRow('ingestOffset', 'Ingest offset', shift, 'ms'));
    if (rows.length) v.sections.push({ id: CLOCK_SECTION, label: 'Clock', rows });
}

/** True when a section, row, badge, option or warning came, went or changed, or a number moved
 *  by its display step: changes ≥ 1 ms or a state flip, like Phase 0's LatenessReporter. */
export function viewChanged(prev: View, next: View): boolean {
    const shape = (v: View) =>
        JSON.stringify([
            v.sections.map((s) => [s.id, s.label, s.rows.map((r) => [r.key, r.label, r.unit])]),
            v.badge,
            v.options,
            v.warnings,
        ]);
    if (shape(prev) !== shape(next)) return true;
    return next.sections.some((s, i) =>
        s.rows.some((r, j) => {
            const was = prev.sections[i].rows[j].cmp;
            return r.cmp.some((x, k) => {
                const y = was[k];
                return typeof x === 'number' && typeof y === 'number'
                    ? Math.abs(x - y) >= 1
                    : x !== y;
            });
        }),
    );
}
