// Per-module lateness display (WI-P0-9): the reporter, the 2 s publication tick with its
// change throttle, and the sink reads for D and device latency. GstPluginBase owns one and
// merges its publication into `getState()`, so a subclass replacing its own sections keeps it.
import type { ModuleTimingSummary } from '@media-router/shared-types';
import type { PipelineDescription, TimingSink } from './PluginModule.js';
import { readNodeLatency } from '../audio/pipeWireLatency.js';
import { latInName, shortHash } from './busHelpers.js';
import { LatenessReporter, type LatenessWindowMs } from './latenessReporter.js';
import { latenessTapAvailable } from './latenessTap.js';
import { timingChanged, timingPublication, type TimingPublication } from './timingSections.js';

const TICK_MS = 2000;
/** D moves live (route playout offset pushes), so the sink is re-read every 5 ticks. */
const SINK_READ_EVERY = 5;
/** No display mode is known here: one refresh at 60 Hz stands in for the panel. */
const VIDEO_DEVICE_MS = 1000 / 60;
const PIPEWIRE_POLL_MS = 10_000;

export interface BusSourceRef {
    port: number;
    socketPath: string;
    sourceModuleId: string;
    sinkPortId: string;
}

/** Label an input tap by the module feeding it, when the tap is keyed by its edge. */
export function inputLabel(tap: string, sources: BusSourceRef[]): string {
    for (const s of sources) {
        if (tap === latInName(`${s.port}_${shortHash(s.socketPath)}`)) {
            return `${s.sourceModuleId} (${s.sinkPortId})`;
        }
    }
    if (sources.length === 1) return `${sources[0].sourceModuleId} (${sources[0].sinkPortId})`;
    return tap.replace(/^lat_/, '');
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

    constructor(private readonly host: ModuleTimingHost) {
        this.reporter = new LatenessReporter({
            labelFor: (tap) => inputLabel(tap, host.busSources()),
            intervalMs: TICK_MS,
        });
    }

    get publication(): TimingPublication {
        return this.pub;
    }

    /** Called with the description the runner is given (null: idle module). */
    start(desc: PipelineDescription | null): void {
        this.stop(false);
        this.sink = desc?.timingSink;
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

    stop(emit = true): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.stopPipeWire();
        this.reporter.reset();
        this.sink = undefined;
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
        let device: number | undefined = VIDEO_DEVICE_MS;
        if (sink.kind === 'audio') {
            // Audio base sinks: the ring is `buffer-time` µs deep.
            const bufferUs = Number(await this.host.getProperty(sink.element, 'buffer-time'));
            device = Number.isFinite(bufferUs) ? bufferUs / 1000 : undefined;
        }
        if (this.sink !== sink) return; // stopped or restarted meanwhile
        this.reporter.setPresentation({
            presentationDelayMs: Number.isFinite(offset) ? offset / 1_000_000 : undefined,
            deviceLatencyMs: device,
        });
    }
}
