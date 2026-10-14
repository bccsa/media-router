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
    /** Its fixed place in the module's inputs (`timing-in-<n>`): a dark input leaves a gap. */
    n: number;
    label: string;
    lateness: LatenessStatsMs;
    /** Output mean − this input's mean; absent while the output is unknown. */
    addedMs?: number;
}

/** One bus output (`lat_busout_<port>`), listed when a module has two or more. */
export interface ModuleTimingOutput {
    tap: string;
    /** The bus port, from the tap name. */
    port: string;
    lateness: LatenessStatsMs;
}

/** Built by the engine's LatenessReporter; display only, no alarm (OQ-8). */
export interface ModuleTimingSummary {
    output?: LatenessStatsMs;
    /** `output` merges every bus output; with two or more each is listed too, by tap name, so
     *  a consumer's input lateness can be read against the output that feeds it. */
    outputs?: ModuleTimingOutput[];
    inputs: ModuleTimingInput[];
    /** Label of the input with the highest lateness, with two or more inputs. */
    slowest?: string;
    /** Outputs that render: λ(render) − λ(input). */
    decodeMs?: number;
    /** The sink's ts-offset (D) while sinks still wait for it. */
    presentationDelayMs?: number;
    deviceLatencyMs?: number;
    /** Set when the device latency is a stand-in (`60 Hz assumed`: the output mode is unknown). */
    deviceLatencyNote?: string;
    /** max(λ(render), D) + device: when the content is seen or heard. */
    renderMs?: number;
    /** PipeWire-graph modules carry no PTS; they show the graph's latency. */
    pipeWireLatencyMs?: number;
    /** False when libgstmrlateness.so is not installed. */
    instrument: boolean;
}
