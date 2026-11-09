// LatenessReporter (§9.5, WI-P0-9): taps' and sidecars' `mrlateness` windows as the timing
// summary (`lat_busin…` in; `lat_render`/`lat_egress`/`lat_busout…` out), no threshold (OQ-8) but
// the off-clock warning (B-203); aligner modules add their `mralignwatch` reports and warnings
// (WI-P2-13), consumers their demuxes' counters and their ASRCs' clocks (WI-P3-6), outputs their
// presentation's own render lateness, rate match and trend (WI-P4-12).
import type {
    AlignerInputState,
    ClockCorrection,
    DemuxCounters,
    LatenessStatsMs,
    ModuleTimingInput,
    ModuleTimingSummary,
} from '@media-router/shared-types';
import {
    ALIGNER_EVENT,
    AlignerWatches,
    PACE_CEILING_MS,
    reanchorText,
    type AlignerEvent,
    type AlignerInputRef,
    type AlignerWatch,
    type AlignerWatchRef,
} from './alignerWatches.js';
import type { TimingInputRef } from './PluginModule.js';
import { LAT_IN_PREFIX, LAT_OUT_PREFIX, LATENESS_EVENT } from './latenessTap.js';
import {
    DEMUX_EVENT,
    DemuxWatches,
    demuxWarningText,
    type DemuxProgram,
    type DemuxWatch,
} from './demuxWatches.js';
import {
    ASRC_EVENT,
    ASRC_STATS,
    AsrcWatches,
    asrcWarningText,
    DEVICE_STALLED_TEXT,
    type AsrcLogEvent,
    type AsrcWatch,
} from './asrcWatches.js';
import {
    DISPLAY_NOT_PRESENTING_TEXT,
    VIDEO_PACE_EVENT,
    VideoPaceWatches,
    type VideoPaceWatch,
} from './videoPaceWatches.js';
import { LatenessTrend } from './latenessTrend.js';
import { launchElements } from './launchElements.js';
import { OFF_CLOCK_MS, offClockText } from './offClock.js';

export interface LatenessWindowMs extends LatenessStatsMs {
    count: number;
}

interface Entry {
    window: LatenessWindowMs;
    at: number;
}

/** A tap that has not reported for this many windows is gone (input removed or dark). */
const STALE_WINDOWS = 3;
const NS_PER_MS = 1_000_000;
// Past this a window is off the house timeline. The runners forward no unstamped egress window
// (B-26), so only a fault makes one now: it is hidden, not shown, and warned once per tap.
const OFF_TIMELINE_MS = 3_600_000;

/** An output tap: what the module writes (render, wire, bus egress), not what it reads. */
const isOutputTap = (tap: string): boolean =>
    tap === 'lat_render' || tap === 'lat_egress' || tap.startsWith(LAT_OUT_PREFIX);

/** One `mrlateness` message payload (ns fields) as a ms window; null when it carried no samples. */
export function parseLatenessPayload(payload: unknown): LatenessWindowMs | null {
    const p = (payload ?? {}) as Record<string, unknown>;
    const count = Number(p.count ?? 0);
    const mean = Number(p['mean-ns']);
    if (!(count > 0) || !Number.isFinite(mean)) return null;
    return {
        count,
        meanMs: mean / NS_PER_MS,
        minMs: Number(p['min-ns'] ?? mean) / NS_PER_MS,
        maxMs: Number(p['max-ns'] ?? mean) / NS_PER_MS,
    };
}

/** Count-weighted merge (several egress taps or sidecar outputs → one output). */
function merge(windows: LatenessWindowMs[]): LatenessStatsMs | undefined {
    const total = windows.reduce((n, w) => n + w.count, 0);
    if (total === 0) return undefined;
    return {
        meanMs: windows.reduce((s, w) => s + w.meanMs * w.count, 0) / total,
        minMs: Math.min(...windows.map((w) => w.minMs)),
        maxMs: Math.max(...windows.map((w) => w.maxMs)),
    };
}

/** The input an aligner event names, as the display labels it. */
export type LabelledAlignerEvent = AlignerEvent & { label: string };

/** The aligners' warning texts; null where nothing stands. */
export interface AlignerWarnings {
    absent: string | null;
    full: string | null;
    /** Inputs re-anchored past their aligner's pace ceiling (B-205). */
    reanchored: string | null;
}

/** What the demuxes and the consumer ASRCs warn of (WI-P3-6), and an output's presentation
 *  (WI-P4-12), each kind owned by the module. */
export type StreamWarningKind =
    | 'demux-unknown-stream'
    | 'input-not-house-time'
    | 'input-no-stream'
    | 'asrc-out-of-bounds'
    | 'device-stalled'
    | 'display-not-presenting';

export interface StreamWarning {
    kind: StreamWarningKind;
    text: string;
}

/** A demux's new program, a consumer ASRC's event, with the input it names (none: the
 *  module's own ASRC), or a display that stopped or went on presenting. */
export type StreamLogEvent =
    | { source: 'demux'; label: string; program: DemuxProgram }
    | { source: 'asrc'; label?: string; event: AsrcLogEvent }
    | { source: 'display'; name: string; presenting: boolean };

const STREAM_CHANNELS = [DEMUX_EVENT, ASRC_STATS, ASRC_EVENT, VIDEO_PACE_EVENT].map((c) => `${c}:`);

/** The presentation's own render lateness (the largest of several), and its gap mark. */
interface RenderReading {
    ms: number;
    mark: string;
}

function renderReading(paces: VideoPaceWatch[], asrcs: AsrcWatch[]): RenderReading | undefined {
    const from = (xs: Array<{ ms?: number; mark: string }>, kind: string) => {
        const known = xs.filter((x): x is { ms: number; mark: string } => x.ms !== undefined);
        if (!known.length) return undefined;
        const ms = Math.max(...known.map((x) => x.ms));
        return { ms, mark: `${kind}:${known.map((x) => x.mark).join(',')}` };
    };
    return (
        from(
            paces.map((p) => ({ ms: p.presentLatenessMs, mark: p.gapMark })),
            'pace',
        ) ??
        from(
            asrcs.map((a) => ({ ms: a.renderLatenessMs, mark: a.gapMark })),
            'asrc',
        )
    );
}

/** Several demuxes on one input (none today): their counters add up. */
function sumDemux(watches: DemuxWatch[]): DemuxCounters | undefined {
    const c = watches.flatMap((w) => (w.counters ? [w.counters] : []));
    if (!c.length) return undefined;
    const add = (k: keyof DemuxCounters): number => c.reduce((s, x) => s + x[k], 0);
    return {
        pesPerS: add('pesPerS'),
        gaps: add('gaps'),
        ccLost: add('ccLost'),
        unknownStreams: add('unknownStreams'),
    };
}

/** Several decode terms in one place: the largest correction, else one still measuring, else none. */
function mergeCorrection(watches: AsrcWatch[]): ClockCorrection | undefined {
    const c = watches.flatMap((w) => (w.correction ? [w.correction] : []));
    if (!c.length) return undefined;
    const engaged = c.filter((x) => x.sourcePpm !== undefined);
    if (!engaged.length) return c.some((x) => x.measuring) ? { measuring: true } : {};
    return engaged.reduce((a, b) => (Math.abs(b.sourcePpm!) > Math.abs(a.sourcePpm!) ? b : a));
}

/** One input on display: its key (a tap, or `mralignwatch:<label>`), place and label, the
 *  aligner watches that serve it (none for a tap alone) and, with watches, its state. */
interface InputRow {
    key: string;
    n: number;
    label: string;
    watches: AlignerWatch[];
    state?: AlignerInputState;
}

/** Several watches on one input (a muxer input's routes): absent when any is. */
function rowState(watches: AlignerWatch[]): AlignerInputState {
    const states = new Set(watches.map((w) => w.report.state));
    if (states.has('absent')) return 'absent';
    return states.has('present') ? 'present' : 'waiting';
}

function alignerFields(row: InputRow): Partial<ModuleTimingInput> {
    const r = row.watches.map((w) => w.report);
    return {
        state: row.state ?? rowState(row.watches),
        silenceLimitMs: Math.min(...r.map((x) => x.silenceLimitMs)),
        absences: Math.max(...r.map((x) => x.absences)),
        staleMs: Math.max(...r.map((x) => x.staleMs)),
    };
}

/** The display key of the input a watch serves: its tap, or one of its own by its label. */
function rowKey(ref: Exclude<AlignerInputRef, null>): string {
    return 'tap' in ref ? ref.tap : `${ALIGNER_EVENT}:${ref.label}`;
}

/** An input's label when the module's inputs do not list it: an aligner input's own label, a
 *  tap's name without `lat_`. */
function ownLabel(key: string): string {
    const own = `${ALIGNER_EVENT}:`;
    return key.startsWith(own) ? key.slice(own.length) : key.slice(4);
}

/** Each input's place and label: its entry in the module's inputs, the only input when the
 *  module has one (a tap named per module), else after them in key order (taps first). */
function placeInputs(keys: string[], known: TimingInputRef[]): TimingInputRef[] {
    const byKey = new Map(known.map((k) => [k.tap, k]));
    const taps = keys.filter((k) => k.startsWith(LAT_IN_PREFIX));
    if (known.length === 1 && taps.length === 1) byKey.set(taps[0], known[0]);
    let next = Math.max(0, ...known.map((k) => k.n));
    return keys.map((key) => byKey.get(key) ?? { tap: key, n: ++next, label: ownLabel(key) });
}

export interface LatenessReporterOptions {
    /** The module's inputs in their fixed order, read only while an input (a tap or an aligner
     *  watch) reports: a dark input keeps its number, so a dashboard bound to `timing-in-<n>`
     *  never switches input. */
    inputs?: () => TimingInputRef[];
    /** Which input an aligner watch serves; default an input of its own, by its label. */
    alignerInput?: (watch: AlignerWatchRef) => AlignerInputRef;
    /** Which input a demux, or an ASRC on one input's branch, serves (WI-P3-6). Undefined: a
     *  demux serves the module's one input (several: a row of its own), an ASRC the module. */
    branchInput?: (element: string) => AlignerInputRef | undefined;
    /** Window length the taps run at; staleness is measured in these. */
    intervalMs?: number;
    /** A window hidden as off the house timeline: once per tap until `reset`. */
    onHidden?: (tap: string, window: LatenessWindowMs) => void;
}

export class LatenessReporter {
    private readonly taps = new Map<string, Entry>();
    /** Output taps whose last window was OFF_CLOCK_MS or more off the house clock (B-203). */
    private readonly offClock = new Map<string, Entry>();
    /** Input taps that reported this run: one gone quiet under watches that report on is an
     *  input whose stream stopped (a muxer pin whose producer stopped: its routes ended). */
    private readonly tapped = new Set<string>();
    private readonly hidden = new Set<string>();
    private readonly watches = new AlignerWatches();
    private readonly demuxes = new DemuxWatches();
    private readonly asrcs = new AsrcWatches();
    private readonly paces = new VideoPaceWatches();
    private readonly trend: LatenessTrend;
    /** Each demux's `media` as the description builds it, for the no-stream text. */
    private demuxMedia = new Map<string, string>();
    /** The stand-in where the presentation reports no render lateness (ring, refresh). */
    private deviceLatencyMs: number | undefined;
    private deviceLatencyNote: string | undefined;
    private pipeWireLatencyMs: number | undefined;
    private processingLatencyMs: number | undefined;
    private instrument = true;
    private readonly intervalMs: number;

    constructor(private readonly opts: LatenessReporterOptions = {}) {
        this.intervalMs = opts.intervalMs ?? 2000;
        this.trend = new LatenessTrend(STALE_WINDOWS * this.intervalMs, this.intervalMs / 2);
    }

    /** Takes `mrlateness:<tap>`, `mralignwatch:<element>`, `mrtsdemux:<element>`,
     *  `mrvideopace:<element>` and the `mrasrc-*:<element>` plugin events; false for others. */
    onEvent(channel: string, payload: unknown, now = Date.now()): boolean {
        if (this.onAligner(channel, payload, now)) return true;
        if (this.onStream(channel, payload, now)) return true;
        if (!channel.startsWith(`${LATENESS_EVENT}:`)) return false;
        const tap = channel.slice(LATENESS_EVENT.length + 1);
        const window = parseLatenessPayload(payload);
        if (window) this.addWindow(tap, window, now);
        return true;
    }

    /** Off the house timeline: not shown, and a tap's first such window goes to `onHidden`. */
    private hide(tap: string, window: LatenessWindowMs): void {
        this.taps.delete(tap);
        this.tapped.delete(tap); // hidden, not quiet
        if (this.hidden.has(tap)) return;
        this.hidden.add(tap);
        this.opts.onHidden?.(tap, window);
    }

    /** An `mralignwatch:<element>` report: whether a state or a full episode changed, and the
     *  events it completes. Null for any other channel. */
    onAligner(
        channel: string,
        payload: unknown,
        now = Date.now(),
    ): { changed: boolean; events: LabelledAlignerEvent[] } | null {
        if (!channel.startsWith(`${ALIGNER_EVENT}:`)) return null;
        const taken = this.watches.take(channel.slice(ALIGNER_EVENT.length + 1), payload, now);
        if (!taken) return { changed: false, events: [] };
        const events = taken.events.map((e) => ({ ...e, label: this.labelOf(e.watch) }));
        return { changed: taken.changed, events };
    }

    /** The run's elements as its description builds them (an ASRC's terms, a demux's `media`):
     *  what their messages do not carry. */
    configure(pipeline: string | undefined): void {
        this.asrcs.configure(pipeline);
        this.demuxMedia = new Map(
            [...launchElements(pipeline ?? '', 'mrtsdemux')].flatMap(([name, p]) =>
                p.media ? [[name, p.media] as [string, string]] : [],
            ),
        );
    }

    /** An `mrtsdemux:<element>`, `mrvideopace:<element>` or `mrasrc-stats`/`mrasrc-event:<element>`
     *  message: whether a warning changed, and what it completes for the log. Null for any other
     *  channel, and for a capture ASRC's (its ingest card's alone). */
    onStream(
        channel: string,
        payload: unknown,
        now = Date.now(),
    ): { changed: boolean; events: StreamLogEvent[] } | null {
        const prefix = STREAM_CHANNELS.find((c) => channel.startsWith(c));
        if (!prefix) return null;
        const name = channel.slice(prefix.length);
        if (prefix === `${DEMUX_EVENT}:`) {
            const taken = this.demuxes.take(name, payload, now);
            if (!taken) return { changed: false, events: [] };
            const { program } = taken;
            const label = program ? this.labelOfKey(this.demuxKey(name), name) : '';
            const events: StreamLogEvent[] = program ? [{ source: 'demux', label, program }] : [];
            return { changed: taken.changed, events };
        }
        if (prefix === `${VIDEO_PACE_EVENT}:`) {
            const { changed } = this.paces.take(name, payload, now);
            const presenting = (payload as Record<string, unknown> | null)?.['display-presenting'];
            const events: StreamLogEvent[] = changed
                ? [{ source: 'display', name, presenting: presenting !== false }]
                : [];
            return { changed, events };
        }
        const taken = this.asrcs.take(prefix.slice(0, -1), name, payload, now);
        if (!taken) return null;
        const events: StreamLogEvent[] = taken.event
            ? [{ source: 'asrc', label: this.asrcLabel(name), event: taken.event }]
            : [];
        return { changed: taken.changed, events };
    }

    /** A window from any source: a tap, or a sidecar's stats line. An output's 10 s or more off the
     *  house clock stands as a warning until it reads under that (B-203); 1 h or more is not shown. */
    addWindow(tap: string, window: LatenessWindowMs, now = Date.now()): void {
        if (isOutputTap(tap)) {
            if (Math.abs(window.meanMs) >= OFF_CLOCK_MS)
                this.offClock.set(tap, { window, at: now });
            else this.offClock.delete(tap);
        }
        if (Math.abs(window.meanMs) >= OFF_TIMELINE_MS) {
            this.hide(tap, window);
            return;
        }
        this.taps.set(tap, { window, at: now });
        if (tap.startsWith(LAT_IN_PREFIX)) this.tapped.add(tap);
    }

    /** The health text while an output reads OFF_CLOCK_MS or more off the house clock, the one
     *  furthest off named (B-203); null when none does. */
    offClockWarning(now = Date.now()): string | null {
        this.expire(now);
        let worst: LatenessWindowMs | undefined;
        for (const { window } of this.offClock.values())
            if (!worst || Math.abs(window.meanMs) > Math.abs(worst.meanMs)) worst = window;
        return worst ? offClockText(worst.meanMs) : null;
    }

    /** The device latency stand-in, read off the sink: used only while the presentation
     *  reports no render lateness of its own. */
    setDeviceStandIn(p: { deviceLatencyMs?: number; deviceLatencyNote?: string }): void {
        this.deviceLatencyMs = p.deviceLatencyMs;
        this.deviceLatencyNote = p.deviceLatencyNote;
    }

    setPipeWireLatency(ms: number | undefined): void {
        this.pipeWireLatencyMs = ms;
    }

    setProcessingLatency(ms: number | undefined): void {
        this.processingLatencyMs = ms;
    }

    setInstrument(present: boolean): void {
        this.instrument = present;
    }

    reset(): void {
        this.taps.clear();
        this.offClock.clear();
        this.tapped.clear();
        this.hidden.clear();
        this.watches.clear();
        this.demuxes.clear();
        this.asrcs.clear();
        this.paces.clear();
        this.trend.gap();
        this.configure(undefined);
        this.deviceLatencyMs = this.pipeWireLatencyMs = undefined;
        this.deviceLatencyNote = undefined;
        this.processingLatencyMs = undefined;
        this.instrument = true;
    }

    private expire(now: number): void {
        const staleMs = STALE_WINDOWS * this.intervalMs;
        for (const [tap, e] of this.taps) {
            if (now - e.at > staleMs) this.taps.delete(tap);
        }
        for (const [tap, e] of this.offClock) {
            if (now - e.at > staleMs) this.offClock.delete(tap);
        }
        this.watches.expire(now, staleMs);
        this.demuxes.expire(now, staleMs);
        this.asrcs.expire(now, staleMs);
        this.paces.expire(now, staleMs);
    }

    private labelOf(watch: AlignerWatchRef): string {
        const ref = this.resolve(watch);
        if (!ref) return watch.input;
        const key = rowKey(ref);
        return this.inputRows().rows.find((r) => r.key === key)?.label ?? ownLabel(key);
    }

    private resolve(watch: AlignerWatchRef): AlignerInputRef {
        return this.opts.alignerInput ? this.opts.alignerInput(watch) : { label: watch.input };
    }

    /** The row a demux joins (null: none): the module's answer, else its one input's, else a
     *  row of its own. A single-input module's tap is its input whatever it is called. */
    private demuxKey(name: string): string | null {
        const ref = this.opts.branchInput?.(name);
        if (ref !== undefined) return ref && rowKey(ref);
        const known = this.opts.inputs?.() ?? [];
        const taps = [...this.taps.keys()].filter((t) => t.startsWith(LAT_IN_PREFIX));
        if (known.length <= 1 && taps.length === 1) return taps[0];
        if (known.length === 1) return known[0].tap;
        return rowKey({ label: name });
    }

    /** The row an ASRC on one input's branch joins; null: the module's section. */
    private asrcKey(name: string): string | null {
        const ref = this.opts.branchInput?.(name);
        return ref && 'tap' in ref ? ref.tap : null;
    }

    /** The input a row key names: on display, else among the module's inputs (its row not
     *  shown yet). */
    private inputOf(
        key: string | null,
        rows = this.inputRows().rows,
    ): { n: number; label: string } | undefined {
        if (key === null) return undefined;
        return rows.find((r) => r.key === key) ?? this.opts.inputs?.().find((k) => k.tap === key);
    }

    /** A row's label by its key, else its own; `fallback` names what has no row. */
    private labelOfKey(key: string | null, fallback: string): string {
        if (key === null) return fallback;
        return this.inputOf(key)?.label ?? ownLabel(key);
    }

    /** An ASRC's input label while it serves one of the module's inputs; none: the module's own. */
    private asrcLabel(name: string): string | undefined {
        return this.inputOf(this.asrcKey(name))?.label;
    }

    /** The demuxes' and the consumer ASRCs' warnings, in the order of the inputs they name. */
    streamWarnings(now = Date.now()): StreamWarning[] {
        this.expire(now);
        const out: Array<StreamWarning & { n: number }> = [];
        const { rows } = this.inputRows();
        for (const d of this.demuxes.list()) {
            const key = this.demuxKey(d.name);
            const input = this.inputOf(key, rows);
            const name = input?.label ?? (key === null ? d.name : ownLabel(key));
            for (const w of d.warnings) {
                const text = demuxWarningText(w, name, this.demuxMedia.get(d.name));
                out.push({ kind: w.kind, text, n: input?.n ?? Infinity });
            }
        }
        for (const a of this.asrcs.list()) {
            if (a.outOfBoundsPpm === undefined) continue;
            const input = this.inputOf(this.asrcKey(a.name), rows);
            const text = asrcWarningText(a.outOfBoundsPpm, input?.label);
            out.push({ kind: 'asrc-out-of-bounds', text, n: input?.n ?? Infinity });
        }
        // The output's own: its device stopped taking audio, its display stopped presenting.
        if (this.asrcs.list().some((a) => a.stalled)) {
            out.push({ kind: 'device-stalled', text: DEVICE_STALLED_TEXT, n: Infinity });
        }
        if (this.paces.list().some((p) => !p.presenting)) {
            const text = DISPLAY_NOT_PRESENTING_TEXT;
            out.push({ kind: 'display-not-presenting', text, n: Infinity });
        }
        return out.sort((a, b) => a.n - b.n).map(({ kind, text }) => ({ kind, text }));
    }

    /** Every input on display, at its place and in its order: the live input taps and the inputs
     *  the watches serve (a tap's, or one of their own); the internal watches apart. */
    private inputRows(): { rows: InputRow[]; internal: AlignerWatch[] } {
        const served = new Map<string, AlignerWatch[]>();
        const internal: AlignerWatch[] = [];
        for (const w of this.watches.list()) {
            const ref = this.resolve(w.ref);
            if (!ref) {
                internal.push(w);
                continue;
            }
            const key = rowKey(ref);
            served.set(key, [...(served.get(key) ?? []), w]);
        }
        const keys = new Set(served.keys());
        for (const tap of this.taps.keys()) if (tap.startsWith(LAT_IN_PREFIX)) keys.add(tap);
        // A demux reports on its input even while that input's tap is not there.
        for (const d of this.demuxes.list()) {
            const key = d.counters ? this.demuxKey(d.name) : null;
            if (key !== null) keys.add(key);
        }
        const sorted = [...keys].sort((a, b) => a.localeCompare(b));
        const placed = sorted.length ? placeInputs(sorted, this.opts.inputs?.() ?? []) : [];
        const rows = sorted.map((key, i): InputRow => {
            const watches = served.get(key) ?? [];
            const quiet = watches.length > 0 && this.tapped.has(key) && !this.taps.has(key);
            return {
                key,
                n: placed[i].n,
                label: placed[i].label,
                watches,
                ...(watches.length ? { state: quiet ? 'absent' : rowState(watches) } : {}),
            };
        });
        return { rows: rows.sort((a, b) => a.n - b.n), internal };
    }

    /** The pace's added latency (the most any aligner adds to its fastest present member) and
     *  what the module waits for: the absent inputs, else the slowest present member of the
     *  aligner that adds the most, among two or more. Internal stages are never named. */
    private alignerPace(rows: InputRow[], internal: AlignerWatch[]): Partial<ModuleTimingSummary> {
        const groups = new Map<string, Array<{ w: AlignerWatch; label?: string }>>();
        const join = (w: AlignerWatch, label?: string): void => {
            const g = groups.get(w.report.aligner) ?? [];
            g.push({ w, label });
            groups.set(w.report.aligner, g);
        };
        for (const row of rows) for (const w of row.watches) join(w, row.label);
        for (const w of internal) join(w);
        let paceMs: number | undefined;
        let held: { addedMs: number; label: string } | undefined;
        for (const members of groups.values()) {
            const present = members.filter((m) => m.w.report.state === 'present');
            if (!present.length) continue;
            const pace = Math.max(...members.map((m) => m.w.report.paceMs));
            const fastest = Math.min(...present.map((m) => m.w.report.latenessMs));
            const addedMs = pace - fastest; // < 0: every input later than the pace, none held
            paceMs = Math.max(paceMs ?? 0, addedMs);
            const named = present.filter((m) => m.label !== undefined);
            if (present.length < 2 || !named.length) continue;
            const slowest = named.reduce((a, b) =>
                b.w.report.latenessMs > a.w.report.latenessMs ? b : a,
            );
            if (!held || addedMs > held.addedMs) held = { addedMs, label: slowest.label! };
        }
        const absent = rows.filter((r) => r.state === 'absent').map((r) => r.label);
        const waitingFor = absent.length ? absent.join(', ') : held?.label;
        return {
            ...(paceMs !== undefined ? { paceMs } : {}),
            ...(waitingFor !== undefined ? { waitingFor } : {}),
        };
    }

    /** The warning texts: every absent input with its W; every input whose queue is full; every
     *  input re-anchored past its aligner's pace ceiling, by how much (B-205). */
    alignerWarnings(now = Date.now()): AlignerWarnings {
        this.expire(now);
        const { rows, internal } = this.inputRows();
        const absent = rows
            .filter((r) => r.state === 'absent')
            .map((r) => {
                const w = r.watches.filter((x) => x.report.state === 'absent');
                // Its watches report on (a quiet tap): silent for as long as a tap takes to go stale.
                const limitMs = w.length
                    ? Math.round(Math.min(...w.map((x) => x.report.silenceLimitMs)))
                    : STALE_WINDOWS * this.intervalMs;
                return `Input ${r.label} silent for ${limitMs} ms — continuing without it`;
            });
        const full = [
            ...rows.filter((r) => r.watches.some((w) => w.full)).map((r) => r.label),
            ...internal.filter((w) => w.full).map((w) => w.ref.input),
        ].map((label) => `Input ${label} queue full — upstream held`);
        // An input's routes share one anchor once moved (the group's); the furthest stands.
        const moved = (watches: AlignerWatch[]): AlignerWatch | undefined => {
            let out: AlignerWatch | undefined;
            for (const w of watches) {
                const a = Math.abs(w.report.anchorMs ?? 0);
                if (a > 0 && (!out || a > Math.abs(out.report.anchorMs ?? 0))) out = w;
            }
            return out;
        };
        const byInput = new Map<string, AlignerWatch[]>();
        for (const r of rows) byInput.set(r.label, r.watches);
        // An internal stage's links (one per output mix) name one input once.
        for (const w of internal)
            byInput.set(w.ref.input, [...(byInput.get(w.ref.input) ?? []), w]);
        const reanchored = [...byInput]
            .map(([label, watches]) => ({ label, w: moved(watches) }))
            .filter((x): x is { label: string; w: AlignerWatch } => x.w !== undefined)
            .map(({ label, w }) =>
                reanchorText(label, w.report.anchorMs!, w.report.paceCeilingMs ?? PACE_CEILING_MS),
            );
        return {
            absent: absent.length ? absent.join('; ') : null,
            full: full.length ? full.join('; ') : null,
            reanchored: reanchored.length ? reanchored.join('; ') : null,
        };
    }

    summary(now = Date.now()): ModuleTimingSummary {
        this.expire(now);
        const all = [...this.taps.entries()].sort(([a], [b]) => a.localeCompare(b));
        const render = this.taps.get('lat_render')?.window;
        const sinkSide = all.filter(([t]) => t === 'lat_render' || t === 'lat_egress');
        const busOut = all.filter(([t]) => t.startsWith(LAT_OUT_PREFIX));
        const outSide = sinkSide.length ? sinkSide : busOut;
        const output = merge(outSide.map(([, e]) => e.window));
        // An aligner input joins its tap's row, or is a row of its own (a dark input's tap
        // goes quiet, its watch reports on).
        const { rows, internal } = this.inputRows();
        const streams = this.streamFields(rows);
        const inputs: ModuleTimingInput[] = rows.map((row) => {
            const tap = row.key.startsWith(LAT_IN_PREFIX) ? this.taps.get(row.key) : undefined;
            return {
                tap: row.key,
                n: row.n,
                label: row.label,
                ...(tap ? { lateness: tap.window } : {}),
                ...(tap && output ? { addedMs: output.meanMs - tap.window.meanMs } : {}),
                ...(row.watches.length ? alignerFields(row) : {}),
                ...streams.inputs.get(row.key),
            };
        });
        const tapped = inputs.filter((i) => i.lateness !== undefined);
        const slowestIn = tapped.reduce<ModuleTimingInput | undefined>(
            (s, i) => (!s || i.lateness!.meanMs > s.lateness!.meanMs ? i : s),
            undefined,
        );
        const summary: ModuleTimingSummary = { inputs, instrument: this.instrument };
        if (output) summary.output = output;
        // The merge hides each output's own lateness, which is what its consumers' inputs read.
        if (busOut.length >= 2) {
            summary.outputs = busOut.map(([tap, e]) => ({
                tap,
                port: tap.slice(LAT_OUT_PREFIX.length + 1),
                lateness: e.window,
            }));
        }
        if (tapped.length >= 2 && slowestIn) summary.slowest = slowestIn.label;
        Object.assign(summary, this.alignerPace(rows, internal));
        Object.assign(summary, this.renderFields(render, slowestIn, now));
        if (this.pipeWireLatencyMs !== undefined)
            summary.pipeWireLatencyMs = this.pipeWireLatencyMs;
        if (this.processingLatencyMs !== undefined)
            summary.processingLatencyMs = this.processingLatencyMs;
        Object.assign(summary, streams.module);
        return summary;
    }

    /** Render lateness: the presentation's own (`mrvideopace`, `mrasrc`'s device term), else
     *  λ(render) + the stand-in; device latency, what it adds to λ(render); the pace's rows,
     *  the device term's counts, and the trend. */
    private renderFields(
        render: LatenessWindowMs | undefined,
        slowestIn: ModuleTimingInput | undefined,
        now: number,
    ): Partial<ModuleTimingSummary> {
        const out: Partial<ModuleTimingSummary> = {};
        const paces = this.paces.list();
        const devices = this.asrcs.list().filter((a) => a.deviceStalls !== undefined);
        const reading = renderReading(paces, devices);
        if (render && slowestIn) out.decodeMs = render.meanMs - slowestIn.lateness!.meanMs;
        if (reading) {
            out.renderMs = reading.ms;
            if (render) out.deviceLatencyMs = reading.ms - render.meanMs;
        } else if (render) {
            if (this.deviceLatencyMs !== undefined) out.deviceLatencyMs = this.deviceLatencyMs;
            if (this.deviceLatencyNote) out.deviceLatencyNote = this.deviceLatencyNote;
            out.renderMs = render.meanMs + (this.deviceLatencyMs ?? 0);
        }
        const pace = paces[0];
        if (pace) {
            out.rateMatch = pace.rateMatch;
            out.lateReleasesPerMin = pace.lateReleasesPerMin;
            out.paceHoldMs = pace.meanHoldMs;
        }
        if (devices.length) {
            out.deviceRelocks = devices.reduce((n, a) => n + a.deviceRelocks!, 0);
            out.deviceStalls = devices.reduce((n, a) => n + a.deviceStalls!, 0);
        }
        if (out.renderMs !== undefined) {
            this.trend.add(now, out.renderMs, reading?.mark ?? 'tap');
            const trend = this.trend.slope();
            if (trend) out.latenessTrend = trend;
        }
        return out;
    }

    /** Each row's demux counters and clock correction; the module's own ASRC and its device
     *  clock (the largest of several). */
    private streamFields(rows: InputRow[]): {
        inputs: Map<string, Partial<ModuleTimingInput>>;
        module: Partial<ModuleTimingSummary>;
    } {
        const onRow = new Set(rows.map((r) => r.key));
        const demuxes = new Map<string, DemuxWatch[]>();
        for (const d of this.demuxes.list()) {
            const key = this.demuxKey(d.name);
            if (key !== null) demuxes.set(key, [...(demuxes.get(key) ?? []), d]);
        }
        const asrcs = new Map<string | null, AsrcWatch[]>();
        let devicePpm: number | undefined;
        for (const a of this.asrcs.list()) {
            const key = this.asrcKey(a.name);
            const place = key !== null && onRow.has(key) ? key : null;
            asrcs.set(place, [...(asrcs.get(place) ?? []), a]);
            if (a.devicePpm !== undefined && Math.abs(a.devicePpm) >= Math.abs(devicePpm ?? 0)) {
                devicePpm = a.devicePpm;
            }
        }
        const inputs = new Map<string, Partial<ModuleTimingInput>>();
        for (const key of onRow) {
            const demux = sumDemux(demuxes.get(key) ?? []);
            const clockCorrection = mergeCorrection(asrcs.get(key) ?? []);
            inputs.set(key, {
                ...(demux ? { demux } : {}),
                ...(clockCorrection ? { clockCorrection } : {}),
            });
        }
        const clockCorrection = mergeCorrection(asrcs.get(null) ?? []);
        return {
            inputs,
            module: {
                ...(clockCorrection ? { clockCorrection } : {}),
                ...(devicePpm !== undefined ? { deviceClockPpm: devicePpm } : {}),
            },
        };
    }
}
