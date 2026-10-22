// What a module's `timing` status section shows (house-clock design §9.5):
// lateness = now − PTS on the house clock, in ms; negative means early.

/** One lateness window, or several merged. */
export interface LatenessStatsMs {
    meanMs: number;
    minMs: number;
    maxMs: number;
}

/** An aligner input as its `mralignwatch` reports it: `waiting` until its first arrival. */
export type AlignerInputState = 'waiting' | 'present' | 'absent';

export interface ModuleTimingInput {
    /** The tap it was read at (`lat_busin…`); `mralignwatch:<label>` for an aligner input
     *  that has no tap. */
    tap: string;
    /** Its fixed place in the module's inputs (`timing-in-<n>`), kept while it is dark. */
    n: number;
    label: string;
    /** The tap's window; absent while only an aligner reports the input (its tap is quiet). */
    lateness?: LatenessStatsMs;
    /** Output mean − this input's mean; absent while the output is unknown. */
    addedMs?: number;
    /** Aligner inputs (house-clock Phase 2): absent once silent past the silence limit. */
    state?: AlignerInputState;
    /** W: the silence after which the input is absent (ms). */
    silenceLimitMs?: number;
    /** Times the input went absent. */
    absences?: number;
    /** Content discarded as stale when the input rejoined, in total (ms). */
    staleMs?: number;
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
    /** Aligner modules: what the aligner's pace adds to its fastest present input (ms); with
     *  several aligners, the largest. */
    paceMs?: number;
    /** Aligner modules: the absent inputs, else the slowest input of the aligner whose pace
     *  adds the most. Replaces `slowest` on the display. */
    waitingFor?: string;
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
    /** What the module's processing delays its content by that its PTS do not carry (a
     *  limiter's lookahead, filters): reported, not corrected (house-clock OQ-22). */
    processingLatencyMs?: number;
    /** False when libgstmrlateness.so is not installed. */
    instrument: boolean;
}
