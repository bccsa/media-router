/**
 * "Has the silent source started flowing again?" — the decision behind the
 * video player's 1 Hz resume poller, kept free of module state so every rung
 * of it is testable without a pipeline.
 *
 * The poller is alive only while the module is latched in the colour-bars
 * fallback (a `bus_stall` error from the runner's 5 s stall watchdog). It has
 * two modes, decided when the fallback was built:
 *
 * TAP MODE (fallback carries the resume tap — `unixfdsrc ! fakesink
 * resume_sink` draining this module's own fan-out edge): read the tap's
 * sink-pad byte counter via the runner's throughput tracker; bytes advancing =
 * the producer is emitting again. The colour-bars fallback stays continuously
 * visible while we wait (no black gap — the same property the old passive
 * dgram probe had), resume latency ≤ ~2 ticks.
 *
 * NO-TAP MODE (edge socket was missing at build time — producer down): probe
 * for the socket reappearing (the same connect-probe the consumer start gate
 * uses) and then retry live directly — a freshly respawned producer is most
 * likely flowing, and if it is dark the live pipeline's stall watchdog just
 * sends us back here within 5 s.
 */

/**
 * Consecutive flowing 1 Hz polls required before a stall-resume rebuild.
 *
 * Resuming on the FIRST sign of bytes rebuilt the live pipeline against a
 * still-churning source (field case 2026-08-02: upstream restart chain —
 * tsparse latched a skewed timing baseline and the pipeline ran degraded for
 * minutes: green slice corruption, ~10 % late-drops). Requiring a short streak
 * costs RESUME_STABLE_POLLS-1 extra seconds of fallback and rebuilds against a
 * stream that has actually settled.
 */
export const RESUME_STABLE_POLLS = 3;

/** Poller state carried between ticks. */
export interface ResumePollState {
    /** Last byte count read off the resume tap — advance = source resumed. */
    lastBytes: number | undefined;
    /** Consecutive polls that saw the source flowing. */
    streak: number;
}

export interface ResumePollInput {
    /** Whether the current fallback pipeline carries the bus-resume tap. */
    tapActive: boolean;
    state: ResumePollState;
    /** Reads the tap sink's byte counter (tap mode only). */
    readTapBytes: () => Promise<number | undefined>;
    /** Producer edge socket, when the source has one (no-tap mode only). */
    socketPath?: string;
    probeSocket: (socketPath: string) => Promise<boolean>;
}

export interface ResumePollResult extends ResumePollState {
    /** The stability gate is satisfied — rebuild the live pipeline. */
    resumed: boolean;
}

/** One resume-poller tick: probe the configured mode, advance the streak. */
export async function pollResumeSignal(input: ResumePollInput): Promise<ResumePollResult> {
    let flowing = false;
    let lastBytes = input.state.lastBytes;
    if (input.tapActive) {
        const bytes = await input.readTapBytes();
        if (bytes !== undefined && lastBytes !== undefined && bytes > lastBytes) {
            flowing = true;
        }
        if (bytes !== undefined) lastBytes = bytes;
    } else if (input.socketPath && (await input.probeSocket(input.socketPath))) {
        flowing = true;
    }
    const streak = flowing ? input.state.streak + 1 : 0;
    return { lastBytes, streak, resumed: streak >= RESUME_STABLE_POLLS };
}
