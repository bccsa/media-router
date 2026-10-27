// Per-module lateness display (WI-P0-9): the reporter, the 2 s tick with its change throttle,
// the sink reads for D and device latency, the aligners' warnings and events (WI-P2-13), and the
// demuxes' and ASRCs' (WI-P3-6). GstPluginBase owns one and merges it into `getState()`.
import type { ModuleTimingSummary } from '@media-router/shared-types';
import type { PipelineDescription, TimingInputRef, TimingSink } from './PluginModule.js';
import { readNodeLatency } from '../audio/pipeWireLatency.js';
import { latInName, shortHash } from './busHelpers.js';
import type { AlignerInputRef, AlignerWatchRef } from './alignerWatches.js';
import { DEMUX_EVENT, type DemuxInputRef } from './demuxWatches.js';
import { signedPpm } from './asrcWatches.js';
import {
    LatenessReporter,
    type LabelledAlignerEvent,
    type LatenessWindowMs,
    type StreamLogEvent,
    type StreamWarning,
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

/** The module's bus inputs in a fixed order (sink port, numeric-aware, then connection), each
 *  under the tap `buildBusSrc` gives an unnamed edge source. */
export function busInputs(sources: BusSourceRef[]): TimingInputRef[] {
    return [...sources]
        .sort(
            (a, b) =>
                a.sinkPortId.localeCompare(b.sinkPortId, 'en', { numeric: true }) ||
                byText(a.connectionId, b.connectionId),
        )
        .map((s, i) => ({ tap: edgeTapName(s), n: i + 1, label: busInputLabel(s) }));
}

/** The engine's rule: a watch whose `input` is a bus connection id serves that edge, whose
 *  tap is edge-keyed (the 302M fan-ins); any other is an input of its own, by its label. */
export function alignerInputFor(watch: AlignerWatchRef, sources: BusSourceRef[]): AlignerInputRef {
    const s = sources.find((x) => x.connectionId === watch.input);
    return s ? { tap: edgeTapName(s) } : { label: watch.input };
}

/** The engine's rule for a branch element (WI-P3-6): one named for a bus connection, as the live
 *  fan-in branches are (`…_<shortHash(connectionId)>`), serves that edge; undefined otherwise. */
export function branchInputFor(
    element: string,
    sources: BusSourceRef[],
): AlignerInputRef | undefined {
    const hash = /_([0-9a-f]{6})$/.exec(element)?.[1];
    const s = hash ? sources.find((x) => shortHash(x.connectionId) === hash) : undefined;
    return s ? { tap: edgeTapName(s) } : undefined;
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
    /** The demuxes' and consumer ASRCs' warnings (WI-P3-6), empty when none stands. */
    streamWarnings?(warnings: StreamWarning[]): void;
    /** The module's own answer for which input a demux, or an ASRC on one input's branch,
     *  serves; undefined: the engine's rule. */
    demuxInput?(element: string): DemuxInputRef | undefined;
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
    /** Bus inputs seen this run, by connection: a producer that stops releases its channel and
     *  leaves the router's list, and its siblings must keep their numbers. */
    private readonly seen = new Map<string, BusSourceRef>();

    constructor(private readonly host: ModuleTimingHost) {
        this.reporter = new LatenessReporter({
            inputs: () => this.inputs(),
            alignerInput: (watch) => this.alignerInput(watch),
            branchInput: (element) => this.branchInput(element),
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
        this.reporter.configure(desc?.pipeline);
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

    /** `mrlateness:`, `mralignwatch:` and `mrtsdemux:<element>` events, false for others; a state,
     *  full or warning change goes out at once. `mrasrc-*` are read and passed on (false): an
     *  ingest's card reads its capture ASRC's. */
    onEvent(channel: string, payload: unknown): boolean {
        const aligner = this.reporter.onAligner(channel, payload);
        const stream = aligner ? null : this.reporter.onStream(channel, payload);
        if (stream) {
            for (const e of stream.events) this.logStream(e);
            if (stream.changed) this.syncWarnings();
            return channel.startsWith(`${DEMUX_EVENT}:`);
        }
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
        for (const s of this.host.busSources()) this.seen.set(s.connectionId, s);
        return busInputs([...this.seen.values()]);
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
        // The demuxes' first: what the module shows only loses parts, never shows an old one.
        this.host.streamWarnings?.([]);
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
        this.host.streamWarnings?.(this.reporter.streamWarnings(now));
        if (!this.host.alignerWarnings) return;
        const w = this.reporter.alignerWarnings(now);
        this.host.alignerWarnings(w.absent, w.full);
    }

    /** The module's answer, else the engine's rule. A watch whose edge is gone served an input
     *  that was removed: internal until it expires, so it names nothing. */
    private alignerInput(watch: AlignerWatchRef): AlignerInputRef {
        const own = this.host.alignerInput?.(watch);
        if (own !== undefined) return own;
        const ref = alignerInputFor(watch, this.host.busSources());
        if (ref && 'tap' in ref) this.edgeWatches.add(watch.name);
        else if (this.edgeWatches.has(watch.name)) return null;
        return ref;
    }

    /** The module's answer, a connection or a port's one connection resolved to its edge; else
     *  the engine's rule. */
    private branchInput(element: string): AlignerInputRef | undefined {
        const sources = this.host.busSources();
        const own = this.host.demuxInput?.(element);
        if (own === undefined) return branchInputFor(element, sources);
        if (own === null || 'tap' in own || 'label' in own) return own;
        const on =
            'connection' in own
                ? sources.filter((x) => x.connectionId === own.connection)
                : sources.filter((x) => x.sinkPortId === own.port);
        return on.length === 1 ? { tap: edgeTapName(on[0]) } : undefined;
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
        const cueLatenessMs = Math.round(e.cueLatenessMs);
        const raisedMs = Math.round(e.raisedMs);
        this.host.log?.(
            'warn',
            { alignerLateCue: { name, aligner, input, cueLatenessMs, raisedMs } },
            `Input ${e.label}: cue after its time, forwarded late, pace raised by ${raisedMs} ms`,
        );
    }

    /** A demux's new program; a consumer ASRC's event (an engage worded as part 10 words it). */
    private logStream(e: StreamLogEvent): void {
        if (e.source === 'demux') {
            const { name, generation, pads, pcrPid } = e.program;
            this.host.log?.(
                'info',
                { demuxProgram: { name, generation, pads, pcrPid } },
                `Input ${e.label}: program changed (generation ${generation})`,
            );
            return;
        }
        const { kind, reason, payload, sourcePpm } = e.event;
        const who = e.label ? `Input ${e.label}: ` : '';
        const source = e.label ? `${who}source clock` : 'Source clock';
        const text =
            kind === 'engaged' && sourcePpm !== undefined
                ? `${source} ${signedPpm(sourcePpm)}: resampling`
                : `${who}mrasrc-event ${kind}${reason ? ` (${reason})` : ''}`;
        this.host.log?.(
            kind === 'ratio-out-of-bounds' ? 'warn' : 'info',
            { asrcEvent: { name: e.event.name, ...payload } },
            text,
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
