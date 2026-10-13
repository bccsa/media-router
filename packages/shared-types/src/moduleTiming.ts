// What a module's `timing` status section shows (house-clock design §9.5):
// lateness = now − PTS on the house clock, in ms; negative means early.

/** One lateness window, or several merged. */
export interface LatenessStatsMs {
    meanMs: number;
    minMs: number;
    maxMs: number;
}

export interface ModuleTimingInput {
    /** The tap it was read at (`lat_busin…`). */
    tap: string;
    label: string;
    lateness: LatenessStatsMs;
    /** Output mean − this input's mean; absent while the output is unknown. */
    addedMs?: number;
}

/** Built by the engine's LatenessReporter; display only, no alarm (OQ-8). */
export interface ModuleTimingSummary {
    output?: LatenessStatsMs;
    inputs: ModuleTimingInput[];
    /** Label of the input with the highest lateness, with two or more inputs. */
    slowest?: string;
    /** Outputs that render: λ(render) − λ(input). */
    decodeMs?: number;
    /** The sink's ts-offset (D) while sinks still wait for it. */
    presentationDelayMs?: number;
    deviceLatencyMs?: number;
    /** max(λ(render), D) + device: when the content is seen or heard. */
    renderMs?: number;
    /** PipeWire-graph modules carry no PTS; they show the graph's latency. */
    pipeWireLatencyMs?: number;
    /** False when libgstmrlateness.so is not installed. */
    instrument: boolean;
}
