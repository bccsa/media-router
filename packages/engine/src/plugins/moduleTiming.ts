// Per-module lateness display (WI-P0-9): the reporter, the 2 s tick with its change throttle,
// the sink reads for D and device latency, and the aligners' warnings and events (WI-P2-13).
// GstPluginBase owns one and merges it into `getState()`, so a subclass's own sections keep it.
import type { ModuleTimingSummary } from '@media-router/shared-types';
import type { PipelineDescription, TimingInputRef, TimingSink } from './PluginModule.js';
import { readNodeLatency } from '../audio/pipeWireLatency.js';
import { latInName, shortHash } from './busHelpers.js';
import type { AlignerInputRef, AlignerWatchRef } from './alignerWatches.js';
import {
    LatenessReporter,
    type LabelledAlignerEvent,
    type LatenessWindowMs,
} from './latenessReporter.js';
import { latenessTapAvailable } from './latenessTap.js';
import { timingChanged, timingPublication, type TimingPublication } from './timingSections.js';

const TICK_MS = 2000;
/** D moves live (route playout offset pushes), so the sink is re-read every 5 ticks. */
const SINK_READ_EVERY = 5;
/** A video output whose mode is unknown: one refresh at this rate stands in, and says so. */
const ASSUMED_REFRESH_HZ = 60;
const PIPEWIRE_POLL_MS = 10_000;

export interface BusSourceRef {
    port: number;
    socketPath: string;
    connectionId: string;
    sourceModuleId: string;
    sourcePortId?: string;
    sinkPortId: string;
}

/** The ingress tap of an edge-keyed bus source (`buildBusSrc` with no `name`). */
export function edgeTapName(s: Pick<BusSourceRef, 'port' | 'socketPath'>): string {
    return latInName(`${s.port}_${shortHash(s.socketPath)}`);
}

/** A bus input's label: the module feeding it, and the port it arrives on. */
export function busInputLabel(s: { sourceModuleId?: string | null; sinkPortId: string }): string {
    return s.sourceModuleId ? `${s.sourceModuleId} (${s.sinkPortId})` : s.sinkPortId;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** An aligner's fall-after as the log says it: whole minutes, else seconds. */
function steadyFor(ms: number): string {
    const s = Math.round(ms / 1000);
    return s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}

/** Bus inputs' fixed order: sink port, numeric-aware, then connection. */
function byPlace(a: BusSourceRef, b: BusSourceRef): number {
    return (
        a.sinkPortId.localeCompare(b.sinkPortId, 'en', { numeric: true }) ||
        byText(a.connectionId, b.connectionId)
    );
}

/** The module's bus inputs in their fixed order, each under the tap `buildBusSrc` gives an
 *  unnamed edge source. */
export function busInputs(sources: BusSourceRef[]): TimingInputRef[] {
    return [...sources]
        .sort(byPlace)
        .map((s, i) => ({ tap: edgeTapName(s), n: i + 1, label: busInputLabel(s) }));
}

/** The engine's rule: a watch whose `input` is a bus connection id serves that edge, whose
 *  tap is edge-keyed (the 302M fan-ins); any other is an input of its own, by its label. */
export function alignerInputFor(watch: AlignerWatchRef, sources: BusSourceRef[]): AlignerInputRef {
    const s = sources.find((x) => x.connectionId === watch.input);
    return s ? { tap: edgeTapName(s) } : { label: watch.input };
}

export interface ModuleTimingHost {
    /** Push the module's state (the publication changed). */
    emit(): void;
    getProperty(element: string, property: string): Promise<unknown>;
    busSources(): BusSourceRef[];
    /** The aligners' warning texts, null where none stands: on a change and every tick. */
    alignerWarnings?(absent: string | null, full: string | null): void;
    /** An aligner event, as a line in the module's log. */
    log?(level: 'info' | 'warn', obj: Record<string, unknown>, msg: string): void;
    /** The module's own answer for which input a watch serves; undefined: the engine's rule. */
    alignerInput?(watch: AlignerWatchRef): AlignerInputRef | undefined;
    /** The edge stands in the module's stored graph, whether or not it is applied now (its
     *  producer disabled, stopped or restarting): its input keeps its row (B-93). */
    wired?(source: BusSourceRef): boolean;
}

const EMPTY: TimingPublication = { sections: [], data: {}, badge: null };
const visible = (p: TimingPublication): boolean => p.sections.length > 0 || p.badge !== null;

export class ModuleTiming {
    private readonly reporter: LatenessReporter;
    private pub: TimingPublication = EMPTY;
    private last: ModuleTimingSummary | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private pwTimer: ReturnType<typeof setInterval> | null = null;
    private pwGen = 0;
    private sink: TimingSink | undefined;
    private ticks = 0;
    /** Watches that served a bus edge: once its connection is gone, the input was removed. */
    private readonly edgeWatches = new Set<string>();
    private declared: TimingInputRef[] | undefined;
    /** Bus inputs seen this run, by connection, each with the number it got when first seen: a
     *  producer that stops releases its channel and leaves the router's list, and an input wired
     *  later takes the next number, so no input ever changes number within a run. */
    private readonly seen = new Map<string, { source: BusSourceRef; n: number }>();

    constructor(private readonly host: ModuleTimingHost) {
        this.reporter = new LatenessReporter({
            inputs: () => this.inputs(),
            alignerInput: (watch) => this.alignerInput(watch),
            intervalMs: TICK_MS,
            onHidden: (tap, w) => this.logHidden(tap, w),
        });
    }

    get publication(): TimingPublication {
        return this.pub;
    }

    /** The summary last published; undefined before the first tick and after a stop. */
    summary(): ModuleTimingSummary | undefined {
        return this.last ?? undefined;
    }

    /** Called with the description the runner is given (null: idle module). */
    start(desc: PipelineDescription | null): void {
        this.stop(false);
        this.sink = desc?.timingSink;
        this.declared = desc?.timingInputs;
        // Only modules on the bus carry taps; say so when theirs are missing.
        const onBus = !!desc && /unixfdsrc|tee name=busout_/.test(desc.pipeline);
        this.reporter.setInstrument(!onBus || latenessTapAvailable());
        this.timer = setInterval(() => this.tick(), TICK_MS);
        this.timer.unref?.();
        this.tick();
    }

    /** Every PLAYING: the sink is read, and the warnings go back over the health it reset. */
    onPlaying(): void {
        void this.readSink();
        this.syncWarnings();
    }

    /** `mrlateness:<tap>` and `mralignwatch:<element>` plugin events; false for any other
     *  channel. A watch's state or full change is published at once, not at the next tick. */
    onEvent(channel: string, payload: unknown): boolean {
        const aligner = this.reporter.onAligner(channel, payload);
        if (!aligner) return this.reporter.onEvent(channel, payload);
        for (const e of aligner.events) this.logEvent(e);
        if (aligner.changed) this.publish();
        return true;
    }

    /** Put the aligners' warnings back after another health write (a description refresh). */
    reassertWarnings(): void {
        this.syncWarnings();
    }

    /** A sidecar stats-line window (`mrts::lateness_json_ms`: ms) from
     *  mr-tssplit or mr-bus-fanout, under the tap name it stands for. */
    addSidecarWindow(tap: string, json: unknown): void {
        const w = (json ?? {}) as Record<string, unknown>;
        const count = Number(w.count);
        const mean = Number(w.mean);
        if (!(count > 0) || !Number.isFinite(mean)) return;
        const window: LatenessWindowMs = {
            count,
            meanMs: mean,
            minMs: Number(w.min ?? mean),
            maxMs: Number(w.max ?? mean),
        };
        this.reporter.addWindow(tap, window);
    }

    /** PipeWire-graph modules (WI-P0-10) have no PTS: show the worst latency PipeWire reports
     *  for their nodes, polled every 10 s. Call after the module's start (start() clears it). */
    watchPipeWire(nodeNames: string[], read = readNodeLatency): void {
        this.stopPipeWire();
        const gen = this.pwGen;
        const poll = async (): Promise<void> => {
            const found = await read(nodeNames).catch(() => new Map());
            if (gen !== this.pwGen) return; // stopped while pw-dump ran
            const worst = Math.max(...[...found.values()].map((l) => l.latencyMs));
            this.reporter.setPipeWireLatency(found.size ? worst : undefined);
            this.tick();
        };
        void poll();
        this.pwTimer = setInterval(() => void poll(), PIPEWIRE_POLL_MS);
        this.pwTimer.unref?.();
    }

    /** What the module's processing delays its content by, past its PTS (OQ-22): the module
     *  reads it off its elements; shown from the next tick. Call after start (it clears it). */
    setProcessingLatency(ms: number | undefined): void {
        this.reporter.setProcessingLatency(ms);
    }

    private stopPipeWire(): void {
        if (this.pwTimer) clearInterval(this.pwTimer);
        this.pwTimer = null;
        this.pwGen++;
    }

    private inputs(): TimingInputRef[] {
        if (this.declared) return this.declared;
        this.noteSources();
        return [...this.seen.values()]
            .sort((a, b) => a.n - b.n)
            .map(({ source, n }) => ({
                tap: edgeTapName(source),
                n,
                label: busInputLabel(source),
            }));
    }

    /** The router's bus sources now, each new one numbered after those already seen (in the
     *  fixed order among themselves). */
    private noteSources(): BusSourceRef[] {
        const now = this.host.busSources();
        const fresh = now.filter((s) => !this.seen.has(s.connectionId));
        let next = this.seen.size;
        for (const s of now) {
            const had = this.seen.get(s.connectionId);
            if (had) had.source = s;
        }
        for (const s of fresh.sort(byPlace))
            this.seen.set(s.connectionId, { source: s, n: ++next });
        return now;
    }

    stop(emit = true): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.stopPipeWire();
        this.reporter.reset();
        this.edgeWatches.clear();
        this.sink = undefined;
        this.declared = undefined;
        this.seen.clear();
        this.ticks = 0;
        const had = visible(this.pub);
        this.pub = EMPTY;
        this.last = null;
        this.host.alignerWarnings?.(null, null);
        if (emit && had) this.host.emit();
    }

    tick(now = Date.now()): void {
        if (this.sink && ++this.ticks % SINK_READ_EVERY === 0) void this.readSink();
        this.publish(now);
    }

    /** The display when it changed (≥ 1 ms or a row), then the warnings. */
    private publish(now = Date.now()): void {
        const s = this.reporter.summary(now);
        if (timingChanged(this.last, s)) {
            const next = timingPublication(s);
            const show = visible(next) || visible(this.pub);
            this.last = s;
            this.pub = next;
            if (show) this.host.emit();
        }
        this.syncWarnings(now);
    }

    private syncWarnings(now = Date.now()): void {
        if (!this.host.alignerWarnings) return;
        const w = this.reporter.alignerWarnings(now);
        this.host.alignerWarnings(w.absent, w.full);
    }

    /** The module's answer, else the engine's rule. A watch whose edge left the router's list
     *  but stands in the module's graph serves it still (its producer stopped: B-93); one whose
     *  edge is gone from the graph served an input that was removed: internal until it expires. */
    private alignerInput(watch: AlignerWatchRef): AlignerInputRef {
        const own = this.host.alignerInput?.(watch);
        if (own !== undefined) return own;
        let ref = alignerInputFor(watch, this.noteSources());
        const stopped = this.seen.get(watch.input)?.source;
        if (!(ref && 'tap' in ref) && stopped && this.host.wired?.(stopped))
            ref = { tap: edgeTapName(stopped) };
        if (ref && 'tap' in ref) this.edgeWatches.add(watch.name);
        else if (this.edgeWatches.has(watch.name)) return null;
        return ref;
    }

    /** A window off the house timeline is a fault since B-26 (the runners forward no unstamped
     *  egress window), so its hiding is said once per tap and run. */
    private logHidden(tap: string, w: LatenessWindowMs): void {
        const meanMs = Math.round(w.meanMs);
        this.host.log?.(
            'warn',
            { latenessOffTimeline: { tap, meanMs } },
            `Lateness tap ${tap} read ${meanMs} ms, off the house timeline: not shown`,
        );
    }

    private logEvent(e: LabelledAlignerEvent): void {
        const { name, aligner, input } = e.watch;
        if (e.kind === 'rejoin') {
            const absentMs = Math.round(e.absentMs);
            const discardedMs = Math.round(e.discardedMs);
            const stale = discardedMs > 0 ? `; ${discardedMs} ms discarded as stale` : '';
            this.host.log?.(
                'info',
                { alignerRejoin: { name, aligner, input, absentMs, discardedMs } },
                `Input ${e.label} back after ${absentMs} ms absent${stale}`,
            );
            return;
        }
        if (e.kind === 'pace-fell') {
            const fellMs = Math.round(e.fellMs);
            const steady = steadyFor(e.fallAfterMs);
            this.host.log?.(
                'info',
                { alignerPaceFell: { name, aligner, fellMs, fallAfterMs: e.fallAfterMs } },
                `Pace fell by ${fellMs} ms: every input steady for ${steady}`,
            );
            return;
        }
        const cueLatenessMs = Math.round(e.cueLatenessMs);
        const raisedMs = Math.round(e.raisedMs);
        this.host.log?.(
            'warn',
            { alignerLateCue: { name, aligner, input, cueLatenessMs, raisedMs } },
            `Input ${e.label}: cue after its time, forwarded late, pace raised by ${raisedMs} ms`,
        );
    }

    private async readSink(): Promise<void> {
        const sink = this.sink;
        if (!sink) return;
        const offset = Number(await this.host.getProperty(sink.element, 'ts-offset'));
        let device: number | undefined;
        let note: string | undefined;
        if (sink.kind === 'audio') {
            // Audio base sinks: the ring is `buffer-time` µs deep.
            const bufferUs = Number(await this.host.getProperty(sink.element, 'buffer-time'));
            device = Number.isFinite(bufferUs) ? bufferUs / 1000 : undefined;
        } else {
            // Video: one refresh of the output mode the module resolved.
            const hz = sink.refreshHz && sink.refreshHz > 0 ? sink.refreshHz : undefined;
            device = 1000 / (hz ?? ASSUMED_REFRESH_HZ);
            if (!hz) note = `${ASSUMED_REFRESH_HZ} Hz assumed`;
        }
        if (this.sink !== sink) return; // stopped or restarted meanwhile
        this.reporter.setPresentation({
            presentationDelayMs: Number.isFinite(offset) ? offset / 1_000_000 : undefined,
            deviceLatencyMs: device,
            deviceLatencyNote: note,
        });
    }
}
