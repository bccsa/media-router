// LatenessReporter (design §9.5, WI-P0-9): the `mrlateness` windows a module's taps and
// sidecars post, as its timing summary. Display only: no threshold, no alarm (OQ-8). Taps are
// classified by name: `lat_busin…` inputs; `lat_render`/`lat_egress`/`lat_busout…` output.
import type {
    LatenessStatsMs,
    ModuleTimingInput,
    ModuleTimingSummary,
} from '@media-router/shared-types';
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

/** Each live input tap's place and label: its entry in the module's inputs, the only input when
 *  the module has one (a tap named per module), else after them by tap name. */
function placeInputs(taps: string[], known: TimingInputRef[]): TimingInputRef[] {
    const byTap = new Map(known.map((k) => [k.tap, k]));
    const only = known.length === 1 && taps.length === 1 ? known[0] : undefined;
    let next = Math.max(0, ...known.map((k) => k.n));
    return taps.map((tap) => byTap.get(tap) ?? only ?? { tap, n: ++next, label: tap.slice(4) });
}

export interface LatenessReporterOptions {
    /** The module's inputs in their fixed order, read only while an input tap reports: a dark
     *  input keeps its number, so a dashboard bound to `timing-in-<n>` never switches input. */
    inputs?: () => TimingInputRef[];
    /** Window length the taps run at; staleness is measured in these. */
    intervalMs?: number;
}

export class LatenessReporter {
    private readonly taps = new Map<string, Entry>();
    private presentationDelayMs: number | undefined;
    private deviceLatencyMs: number | undefined;
    private deviceLatencyNote: string | undefined;
    private pipeWireLatencyMs: number | undefined;
    private instrument = true;
    private readonly intervalMs: number;

    constructor(private readonly opts: LatenessReporterOptions = {}) {
        this.intervalMs = opts.intervalMs ?? 2000;
    }

    /** Takes `mrlateness:<tap>` plugin events; false for any other channel. */
    onEvent(channel: string, payload: unknown, now = Date.now()): boolean {
        if (!channel.startsWith(`${LATENESS_EVENT}:`)) return false;
        const tap = channel.slice(LATENESS_EVENT.length + 1);
        const window = parseLatenessPayload(payload);
        if (window && Math.abs(window.meanMs) >= OFF_TIMELINE_MS) this.taps.delete(tap);
        else if (window) this.addWindow(tap, window, now);
        return true;
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

    setInstrument(present: boolean): void {
        this.instrument = present;
    }

    reset(): void {
        this.taps.clear();
        this.presentationDelayMs = this.deviceLatencyMs = this.pipeWireLatencyMs = undefined;
        this.deviceLatencyNote = undefined;
        this.instrument = true;
    }

    summary(now = Date.now()): ModuleTimingSummary {
        for (const [tap, e] of this.taps) {
            if (now - e.at > STALE_WINDOWS * this.intervalMs) this.taps.delete(tap);
        }
        const all = [...this.taps.entries()].sort(([a], [b]) => a.localeCompare(b));
        const render = this.taps.get('lat_render')?.window;
        const sinkSide = all.filter(([t]) => t === 'lat_render' || t === 'lat_egress');
        const busOut = all.filter(([t]) => t.startsWith(LAT_OUT_PREFIX));
        const outSide = sinkSide.length ? sinkSide : busOut;
        const output = merge(outSide.map(([, e]) => e.window));
        const inTaps = all.filter(([t]) => t.startsWith(LAT_IN_PREFIX));
        const placed = inTaps.length
            ? placeInputs(
                  inTaps.map(([t]) => t),
                  this.opts.inputs?.() ?? [],
              )
            : [];
        const inputs: ModuleTimingInput[] = inTaps
            .map(([tap, e], i) => ({
                tap,
                n: placed[i].n,
                label: placed[i].label,
                lateness: e.window,
                ...(output ? { addedMs: output.meanMs - e.window.meanMs } : {}),
            }))
            .sort((a, b) => a.n - b.n);
        const slowestIn = inputs.reduce<ModuleTimingInput | undefined>(
            (s, i) => (!s || i.lateness.meanMs > s.lateness.meanMs ? i : s),
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
        if (inputs.length >= 2 && slowestIn) summary.slowest = slowestIn.label;
        if (render) {
            if (slowestIn) summary.decodeMs = render.meanMs - slowestIn.lateness.meanMs;
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
        return summary;
    }
}
