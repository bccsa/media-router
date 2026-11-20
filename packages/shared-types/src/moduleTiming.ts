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

/** An input's demux as its `mrtsdemux` interval reports show it (house-clock WI-P3-6). */
export interface DemuxCounters {
    /** PES per second over the last 10 s of reports. */
    pesPerS: number;
    /** Holes on the timeline (a jump, a bus gap marker), since the demux started. */
    gaps: number;
    /** TS packets lost by continuity count, since the demux started. */
    ccLost: number;
    /** Streams of the current program that the demux does not demux (no known stream type). */
    unknownStreams: number;
}

/** What a consumer's decode ASRC does to its source (WI-P3-6). */
export interface ClockCorrection {
    /** The source clock against house time (ppm, positive when fast) while the ASRC resamples
     *  it; absent while its buffers pass at house rate. */
    sourcePpm?: number;
    /** It resamples before the source's rate is measured (a phase engage in its lock's first
     *  seconds, B-148); no sourcePpm then. */
    measuring?: true;
}

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
    /** Its demux's counters (house-clock Phase 3). */
    demux?: DemuxCounters;
    /** Its decode ASRC, where each input has its own (the 302M fan-ins). */
    clockCorrection?: ClockCorrection;
}

/** One bus output (`lat_busout_<port>`), listed when a module has two or more. */
export interface ModuleTimingOutput {
    tap: string;
    /** The bus port, from the tap name. */
    port: string;
    lateness: LatenessStatsMs;
}

/** A video output's rate match: the content's frame rate, the display's (achieved, else the
 *  mode's measured or nominal refresh; 0: unknown) and the pace's drops for it, per minute. */
export interface RateMatch {
    contentFps: number;
    displayHz: number;
    displaySource: 'achieved' | 'measured' | 'nominal' | 'none';
    dropsPerMin: number;
}

/** waylandsink's (Yocto 0008) `display-stats`, read every 10 s (B-242): frames the sink replaced
 *  before committing them, and presentation feedback the compositor discarded. Totals since the
 *  sink started; per minute over the last minute. */
export interface DisplayFrames {
    replaced: number;
    discarded: number;
    replacedPerMin: number;
    discardedPerMin: number;
}

/** An output's drain back to its latency target (house-clock WI-P4-18, B-179): `mrasrc`'s or
 *  `mrvideopace`'s servo. No setting, no alarm. */
/** Why an underrun did not raise the margin (B-240): the first test it failed. */
export type UnderrunReason =
    | 'drain'
    | 'after-drain'
    | 'video'
    | 'warm-up'
    | 'input'
    | 'load'
    | 'not-margin';

export interface DrainSummary {
    /** What it holds to: its own target, or its group's while it follows one (ms). */
    targetMs: number;
    /** Its render lateness now (ms). */
    nowMs: number;
    /** What it would drain alone: the trough of its buffer less its margin (ms). */
    excessMs: number;
    /** Signed rate: > 0 drains (plays faster), < 0 rises to its group (plays slower). */
    ppm: number;
    /** The margin it keeps, measured (ms). */
    marginMs: number;
    drainedMs: number;
    /** Short starvations (audio) or late frames (video) counted, and those that raised the margin. */
    underruns: number;
    raises: number;
    /** Those that did not raise, by reason (B-240); absent from an element that has none. */
    underrunReasons?: Partial<Record<UnderrunReason, number>>;
    state: 'warm-up' | 'idle' | 'draining' | 'rising';
    /** The target it publishes to its group (ms); absent: none (a device stalled, a display off). */
    publishedMs?: number;
    /** No display rate is known: nothing drains (video). */
    notMeasured?: true;
    /** Held 1 s above its own target, its group's higher. */
    capped?: true;
    /** The other modules of its A/V group. */
    groupWith?: string[];
    /** The member furthest from it in render lateness, past 45 ms (ms, positive: it plays later). */
    groupApart?: { name: string; ms: number };
    /** A member's render lateness unknown: the group's sync not judged (B-241). */
    groupUnjudged?: true;
    /** Its origins touch two groups: it drains alone (two programmes). */
    neither?: true;
    /** Video: frames the drain skipped, per minute. */
    drainDropsPerMin?: number;
}

/** A network egress's writer (`mrtsegress`, house-clock WI-P5-10, plan ch. 9 parts 8 and 10);
 *  with several programmes, the largest D_e and PCR interval and the summed counts. */
export interface EgressTimingSummary {
    /** D_e: the wire's PCR runs this far behind house time (ms). */
    delayMs: number;
    /** D_e raises and lowers over the last 10 min. */
    delayChanges: number;
    /** The largest PCR interval in the writer's last stats window (ms). */
    pcrIntervalMaxMs?: number;
    /** PCR packets the writer inserted, per second over its last stats window. */
    pcrInsertedPerS?: number;
    /** Stats windows with a PCR interval over 40 ms while data flowed, since the start (R17). */
    pcrLateWindows: number;
    /** Epoch changes put on the wire since the start. */
    reEpochs: number;
    /** "TAI, epoch n, chrony, ≤ 2 ms" or "Not traceable (reason)". */
    netTime: string;
    traceable: boolean;
    /** The PMT's house-time descriptor: "MRHT v1", or why it is left out. */
    descriptor: string;
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
    /** Aligner modules: the slowest present input of the aligner whose pace adds the most (an
     *  absent input is gapped, not waited for: B-245). Replaces `slowest` on the display. */
    waitingFor?: string;
    /** Outputs that render: λ(render) − λ(input). */
    decodeMs?: number;
    /** Render lateness − λ(render) where the presentation reports its own; else a stand-in
     *  (the audio ring, one display refresh). */
    deviceLatencyMs?: number;
    /** Set when the device latency is a stand-in (`60 Hz assumed`: the output mode is unknown). */
    deviceLatencyNote?: string;
    /** When the content is seen or heard: `mrvideopace`'s or `mrasrc`'s render lateness, else
     *  λ(render) + device (house-clock WI-P4-12). */
    renderMs?: number;
    /** Video outputs: the content's rate against the rate the display takes (`mrvideopace`). */
    rateMatch?: RateMatch;
    /** Video outputs on waylandsink: the display's replaced and discarded frames (B-242). */
    displayFrames?: DisplayFrames;
    /** Video outputs: frames the pace released after their slot, per minute. */
    lateReleasesPerMin?: number;
    /** Video outputs: the pace's mean hold of a frame before its slot (ms). */
    paceHoldMs?: number;
    /** Outputs that render: the slope of render lateness over 3 min, across collapsed holes and
     *  gaps (B-241); no msPerMin while it measures (no alarm, OQ-34); `underLoad`: an underrun
     *  under load (B-240) in the window. */
    latenessTrend?: { msPerMin?: number; underLoad?: true };
    /** PipeWire-graph modules carry no PTS; they show the graph's latency. */
    pipeWireLatencyMs?: number;
    /** What the module's processing delays its content by that its PTS do not carry (a
     *  limiter's lookahead, filters): reported, not corrected (house-clock OQ-22). */
    processingLatencyMs?: number;
    /** The module's decode ASRC, where it is not one per input (house-clock Phase 3). */
    clockCorrection?: ClockCorrection;
    /** An audio output's device clock against house time (ppm, positive when fast). */
    deviceClockPpm?: number;
    /** An audio output's device term: its relocks and stalls since the element started. */
    deviceRelocks?: number;
    deviceStalls?: number;
    /** Device outputs: the drain back to the latency target (WI-P4-18). */
    drain?: DrainSummary;
    /** Network egress: the writer's D_e, PCR and network time (WI-P5-10). */
    egress?: EgressTimingSummary;
    /** False when libgstmrlateness.so is not installed. */
    instrument: boolean;
}
