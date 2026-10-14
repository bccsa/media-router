// Per-module lateness display (WI-P0-9): the reporter, the 2 s publication tick with its
// change throttle, and the sink reads for D and device latency. GstPluginBase owns one and
// merges its publication into `getState()`, so a subclass replacing its own sections keeps it.
import type { ModuleTimingSummary } from '@media-router/shared-types';
import type { PipelineDescription, TimingInputRef, TimingSink } from './PluginModule.js';
import { readNodeLatency } from '../audio/pipeWireLatency.js';
import { latInName, shortHash } from './busHelpers.js';
import { LatenessReporter, type LatenessWindowMs } from './latenessReporter.js';
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
    sourceModuleId: string;
    sinkPortId: string;
    connectionId: string;
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
        .map((s, i) => ({
            tap: latInName(`${s.port}_${shortHash(s.socketPath)}`),
            n: i + 1,
            label: busInputLabel(s),
        }));
}

export interface ModuleTimingHost {
    /** Push the module's state (the publication changed). */
    emit(): void;
    getProperty(element: string, property: string): Promise<unknown>;
    busSources(): BusSourceRef[];
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
    private declared: TimingInputRef[] | undefined;
    /** Bus inputs seen this run, by connection: a producer that stops releases its channel and
     *  leaves the router's list, and its siblings must keep their numbers. */
    private readonly seen = new Map<string, BusSourceRef>();

    constructor(private readonly host: ModuleTimingHost) {
        this.reporter = new LatenessReporter({ inputs: () => this.inputs(), intervalMs: TICK_MS });
    }

    get publication(): TimingPublication {
        return this.pub;
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

    onPlaying(): void {
        void this.readSink();
    }

    /** `mrlateness:<tap>` plugin events; false for any other channel. */
    onEvent(channel: string, payload: unknown): boolean {
        return this.reporter.onEvent(channel, payload);
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
        this.sink = undefined;
        this.declared = undefined;
        this.seen.clear();
        this.ticks = 0;
        const had = visible(this.pub);
        this.pub = EMPTY;
        this.last = null;
        if (emit && had) this.host.emit();
    }

    tick(now = Date.now()): void {
        if (this.sink && ++this.ticks % SINK_READ_EVERY === 0) void this.readSink();
        const s = this.reporter.summary(now);
        if (!timingChanged(this.last, s)) return;
        const next = timingPublication(s);
        const show = visible(next) || visible(this.pub);
        this.last = s;
        this.pub = next;
        if (show) this.host.emit();
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
