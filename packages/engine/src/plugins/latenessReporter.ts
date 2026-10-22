// LatenessReporter (§9.5, WI-P0-9): taps' and sidecars' `mrlateness` windows as the timing
// summary (`lat_busin…` in; `lat_render`/`lat_egress`/`lat_busout…` out), no threshold (OQ-8);
// aligner modules add their `mralignwatch` reports and warnings (WI-P2-13).
import type {
    AlignerInputState,
    LatenessStatsMs,
    ModuleTimingInput,
    ModuleTimingSummary,
} from '@media-router/shared-types';
import {
    ALIGNER_EVENT,
    AlignerWatches,
    type AlignerEvent,
    type AlignerInputRef,
    type AlignerWatch,
    type AlignerWatchRef,
} from './alignerWatches.js';
import type { TimingInputRef } from './PluginModule.js';
import { LAT_IN_PREFIX, LAT_OUT_PREFIX, LATENESS_EVENT } from './latenessTap.js';

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
// Past this a window is off the house timeline: a producer egress reads raw mux PTS until its
// first consumer arms the stamper (measured ~24 days, the uptime), so it is hidden, not shown.
const OFF_TIMELINE_MS = 3_600_000;

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
}

/** One input on display: its key (a tap, or `mralignwatch:<label>`), place and label, and the
 *  aligner watches that serve it (none for a tap alone). */
interface InputRow {
    key: string;
    n: number;
    label: string;
    watches: AlignerWatch[];
}

/** Several watches on one input (a muxer input's routes): absent when any is. */
function rowState(watches: AlignerWatch[]): AlignerInputState {
    const states = new Set(watches.map((w) => w.report.state));
    if (states.has('absent')) return 'absent';
    return states.has('present') ? 'present' : 'waiting';
}

function alignerFields(watches: AlignerWatch[]): Partial<ModuleTimingInput> {
    const r = watches.map((w) => w.report);
    return {
        state: rowState(watches),
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
    /** Window length the taps run at; staleness is measured in these. */
    intervalMs?: number;
}

export class LatenessReporter {
    private readonly taps = new Map<string, Entry>();
    private readonly watches = new AlignerWatches();
    private presentationDelayMs: number | undefined;
    private deviceLatencyMs: number | undefined;
    private deviceLatencyNote: string | undefined;
    private pipeWireLatencyMs: number | undefined;
    private processingLatencyMs: number | undefined;
    private instrument = true;
    private readonly intervalMs: number;

    constructor(private readonly opts: LatenessReporterOptions = {}) {
        this.intervalMs = opts.intervalMs ?? 2000;
    }

    /** Takes `mrlateness:<tap>` and `mralignwatch:<element>` plugin events; false for any
     *  other channel. */
    onEvent(channel: string, payload: unknown, now = Date.now()): boolean {
        if (this.onAligner(channel, payload, now)) return true;
        if (!channel.startsWith(`${LATENESS_EVENT}:`)) return false;
        const tap = channel.slice(LATENESS_EVENT.length + 1);
        const window = parseLatenessPayload(payload);
        if (window && Math.abs(window.meanMs) >= OFF_TIMELINE_MS) this.taps.delete(tap);
        else if (window) this.addWindow(tap, window, now);
        return true;
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

    /** A window from any source: a tap, or a sidecar's stats line. */
    addWindow(tap: string, window: LatenessWindowMs, now = Date.now()): void {
        this.taps.set(tap, { window, at: now });
    }

    setPresentation(p: {
        presentationDelayMs?: number;
        deviceLatencyMs?: number;
        deviceLatencyNote?: string;
    }): void {
        this.presentationDelayMs = p.presentationDelayMs;
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
        this.watches.clear();
        this.presentationDelayMs = this.deviceLatencyMs = this.pipeWireLatencyMs = undefined;
        this.deviceLatencyNote = undefined;
        this.processingLatencyMs = undefined;
        this.instrument = true;
    }

    private expire(now: number): void {
        const staleMs = STALE_WINDOWS * this.intervalMs;
        for (const [tap, e] of this.taps) {
            if (now - e.at > staleMs) this.taps.delete(tap);
        }
        this.watches.expire(now, staleMs);
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
        const sorted = [...keys].sort((a, b) => a.localeCompare(b));
        const placed = sorted.length ? placeInputs(sorted, this.opts.inputs?.() ?? []) : [];
        const rows = sorted.map((key, i) => ({
            key,
            n: placed[i].n,
            label: placed[i].label,
            watches: served.get(key) ?? [],
        }));
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
        const absent = rows.filter((r) => rowState(r.watches) === 'absent').map((r) => r.label);
        const waitingFor = absent.length ? absent.join(', ') : held?.label;
        return {
            ...(paceMs !== undefined ? { paceMs } : {}),
            ...(waitingFor !== undefined ? { waitingFor } : {}),
        };
    }

    /** The warning texts: every absent input with its W; every input whose queue is full. */
    alignerWarnings(now = Date.now()): AlignerWarnings {
        this.expire(now);
        const { rows, internal } = this.inputRows();
        const absent = rows
            .filter((r) => rowState(r.watches) === 'absent')
            .map((r) => {
                const w = r.watches.filter((x) => x.report.state === 'absent');
                const limitMs = Math.round(Math.min(...w.map((x) => x.report.silenceLimitMs)));
                return `Input ${r.label} silent for ${limitMs} ms — continuing without it`;
            });
        const full = [
            ...rows.filter((r) => r.watches.some((w) => w.full)).map((r) => r.label),
            ...internal.filter((w) => w.full).map((w) => w.ref.input),
        ].map((label) => `Input ${label} queue full — upstream held`);
        return {
            absent: absent.length ? absent.join('; ') : null,
            full: full.length ? full.join('; ') : null,
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
        const inputs: ModuleTimingInput[] = rows.map((row) => {
            const tap = row.key.startsWith(LAT_IN_PREFIX) ? this.taps.get(row.key) : undefined;
            return {
                tap: row.key,
                n: row.n,
                label: row.label,
                ...(tap ? { lateness: tap.window } : {}),
                ...(tap && output ? { addedMs: output.meanMs - tap.window.meanMs } : {}),
                ...(row.watches.length ? alignerFields(row.watches) : {}),
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
        if (render) {
            if (slowestIn) summary.decodeMs = render.meanMs - slowestIn.lateness!.meanMs;
            const d = this.presentationDelayMs;
            const device = this.deviceLatencyMs ?? 0;
            if (d !== undefined) summary.presentationDelayMs = d;
            if (this.deviceLatencyMs !== undefined) summary.deviceLatencyMs = device;
            if (this.deviceLatencyNote) summary.deviceLatencyNote = this.deviceLatencyNote;
            // Phase 0: sinks still wait for D, so render is max(λ, D) + device.
            summary.renderMs = Math.max(render.meanMs, d ?? 0) + device;
        }
        if (this.pipeWireLatencyMs !== undefined)
            summary.pipeWireLatencyMs = this.pipeWireLatencyMs;
        if (this.processingLatencyMs !== undefined)
            summary.processingLatencyMs = this.processingLatencyMs;
        return summary;
    }
}
