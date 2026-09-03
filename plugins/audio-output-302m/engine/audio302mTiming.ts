import { effectivePlayoutOffsetNs, type PlayoutOffsetServices } from '@media-router/engine';

/**
 * Sink timing for the 302M output leg: the numbers that decide WHEN this
 * output presents, split out of `AudioOutput302mModule` so that file stays
 * about the pipeline it builds.
 *
 * These were tuned together in the field and are pinned as a set — see
 * ADR-0005, "Implementation notes (302M output leg, 2026-09-03)". Change one
 * and the route has to be re-checked by ear.
 */

/**
 * `pulsesink slave-method` (GstAudioBaseSink): 1 = skew — the sink corrects the
 * DAC's drift against the pipeline clock by nudging its own timestamps, leaving
 * the samples alone. ADR-0005 decision 5 makes this the contract's slaving mode;
 * 0 = resample (the legacy default) absorbs the drift by rewriting samples, i.e.
 * by drifting off the time it was told to present at, which makes D approximate
 * on this leg alone. Same pin as the audio-decoder.
 */
export const SLAVE_METHOD_SKEW = 1;

/**
 * `pulsesink buffer-time` (µs) under the contract — the same 100 ms paced ring
 * the audio-decoder floors at (a 50 ms ring xrunned audibly on a field Pi 4).
 * With `sync=true` the ring is scheduling margin, not standing latency.
 */
export const SINK_BUFFER_US = 100_000;

/**
 * Scheduling latency `pulsesink` DECLARES for that ring, in ms — cancelled in
 * `ts-offset` (see `audio302mTsOffsetNs`).
 *
 * A live GStreamer sink renders at `running-time + ts-offset + latency`, where
 * `latency` is the pipeline's min latency from the LATENCY query — for an
 * audio sink essentially its ring. Measured on the 10.9.16.103 USB DAC
 * (PipeWire 1.6, GStreamer 1.28): 151.3 ms at the 200 ms default ring,
 * 101.3 ms at 100 ms, 71.3 ms at 50 ms. The video leg's `waylandsink`
 * declares ~20 ms, so left alone the same route played audio well behind the
 * picture even with identical stamps and the same D. With the 100 ms ring and
 * this cancellation, plus `alignBranchesToStamps` on the video-player, the
 * transcoder and this module, the route on .103 was confirmed in sync BY EAR
 * (2026-09-03); the three are a tuple — change one and re-check. Slack is
 * unaffected: buffers reach the sink well before their stamp.
 */
export const SINK_DECLARED_LATENCY_MS = 100;

/**
 * This output's sink `ts-offset` in nanoseconds under the time-sync contract.
 *
 * The route's playout offset D (engine default, or the route head's override —
 * resolved through the SAME `effectivePlayoutOffsetNs` the video-player and the
 * audio-decoder call, so one route resolves to one number on every leg), plus
 * this output's `lipSyncMs` trim, MINUS the mixer arm's declared aggregation
 * latency, MINUS the sink's own declared latency (`SINK_DECLARED_LATENCY_MS`).
 *
 * Why the subtraction: `audiomixer latency=L` is pipeline latency in
 * GStreamer's sense — the aggregator reports it on the LATENCY query and a
 * `sync=true` sink adds it to every render time. Left alone, the same route
 * would play L later through a mixer than through the single-source bypass,
 * i.e. "playout offset" would stop meaning "after the stamp". Subtracting it
 * keeps presentation at `stamp + D + trim` in both arms. The single-source arm
 * declares no latency and passes 0.
 *
 * NEVER NEGATIVE. A trim past D (or L past D) is clamped to 0, for two reasons.
 * Audio cannot be presented before it arrives, so a negative offset buys
 * nothing: the buffers are simply "late" and `max-lateness=-1` plays them on
 * arrival. And the backlog shedder reads this very `ts-offset` as the leg's
 * budget (`lateness = now − rt − ts_offset`), so a negative value makes every
 * buffer read as retained backlog — field, 10.9.16.103, 2026-09-03 11:28:53:
 * the trim slider at −2000 ms put the sink at −1700 ms, the shedder saw a
 * "1943 ms backlog" and dropped 458 buffers (~10 s of audio) chasing it.
 *
 * TWIN: `audioTsOffsetNs` in `plugins/audio-decoder/engine/AudioDecoderModule.ts`
 * cancels the same declared ring latency and clamps the same way. Two copies on
 * purpose — see the note there.
 */
export function audio302mTsOffsetNs(
    services: PlayoutOffsetServices | null | undefined,
    config: Record<string, unknown>,
    mixerLatencyNs = 0,
): number {
    return Math.max(
        0,
        effectivePlayoutOffsetNs(services, { trimMs: Number(config.lipSyncMs ?? 0) || 0 }) -
            mixerLatencyNs -
            SINK_DECLARED_LATENCY_MS * 1_000_000,
    );
}
