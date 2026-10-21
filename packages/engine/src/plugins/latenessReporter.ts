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

/** One display row and the watches that serve it. */
interface AlignerRow {
    key: string;
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

export interface LatenessReporterOptions {
    /** Human label for an input tap (its upstream module, when known). */
    labelFor?: (tap: string) => string;
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

    setPresentation(p: { presentationDelayMs?: number; deviceLatencyMs?: number }): void {
        this.presentationDelayMs = p.presentationDelayMs;
        this.deviceLatencyMs = p.deviceLatencyMs;
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

    private tapLabel(tap: string): string {
        return this.opts.labelFor?.(tap) ?? tap.slice(4);
    }

    private labelOf(watch: AlignerWatchRef): string {
        const ref = this.resolve(watch);
        if (ref && 'tap' in ref) return this.tapLabel(ref.tap);
        return ref ? ref.label : watch.input;
    }

    private resolve(watch: AlignerWatchRef): AlignerInputRef {
        return this.opts.alignerInput ? this.opts.alignerInput(watch) : { label: watch.input };
    }

    /** The watches by the input they serve (a tap's, or one of their own), in the display's
     *  order, and the internal ones apart. */
    private alignerRows(): { rows: AlignerRow[]; internal: AlignerWatch[] } {
        const rows = new Map<string, AlignerRow>();
        const internal: AlignerWatch[] = [];
        for (const w of this.watches.list()) {
            const ref = this.resolve(w.ref);
            if (!ref) {
                internal.push(w);
                continue;
            }
            const key = 'tap' in ref ? ref.tap : `${ALIGNER_EVENT}:${ref.label}`;
            const label = 'tap' in ref ? this.tapLabel(ref.tap) : ref.label;
            const row = rows.get(key) ?? { key, label, watches: [] };
            row.watches.push(w);
            rows.set(key, row);
        }
        const sorted = [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
        return { rows: sorted, internal };
    }

    /** The pace's added latency (the most any aligner adds to its fastest present member) and
     *  what the module waits for: the absent inputs, else the slowest present member of the
     *  aligner that adds the most, among two or more. Internal stages are never named. */
    private alignerPace(
        rows: AlignerRow[],
        internal: AlignerWatch[],
    ): Partial<ModuleTimingSummary> {
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
        const { rows, internal } = this.alignerRows();
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
        const byTap = new Map<string, ModuleTimingInput>();
        for (const [tap, e] of all.filter(([t]) => t.startsWith(LAT_IN_PREFIX))) {
            byTap.set(tap, {
                tap,
                label: this.tapLabel(tap),
                lateness: e.window,
                ...(output ? { addedMs: output.meanMs - e.window.meanMs } : {}),
            });
        }
        // An aligner input joins its tap's row, or is a row of its own (a dark input's tap
        // goes quiet, its watch reports on).
        const { rows, internal } = this.alignerRows();
        for (const row of rows) {
            const input = byTap.get(row.key) ?? { tap: row.key, label: row.label };
            byTap.set(row.key, { ...input, ...alignerFields(row.watches) });
        }
        const inputs = [...byTap.values()].sort((a, b) => a.tap.localeCompare(b.tap));
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
