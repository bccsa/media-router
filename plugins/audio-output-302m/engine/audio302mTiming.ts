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
 * 0 = resample absorbs the drift by rewriting samples, i.e.
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
 * this cancellation, plus content-time inputs (`alignBranchesToStamps` then, the
 * `mrtsdemux` formula demux since house-clock Phase 2), the route on .103 was
 * confirmed in sync BY EAR (2026-09-03); the three are a tuple — change one and
 * re-check. Slack is unaffected: buffers reach the sink well before their stamp.
 * The sink adds this ring only behind a live upstream, which the module's
 * `identity sync=true` gives it in the mixer arm too.
 */
export const SINK_DECLARED_LATENCY_MS = 100;

/**
 * This output's sink `ts-offset` in nanoseconds under the time-sync contract.
 *
 * The route's playout offset D (engine default, or the route head's override —
 * resolved through the SAME `effectivePlayoutOffsetNs` the video-player and the
 * audio-decoder call, so one route resolves to one number on every leg), plus
 * this output's `lipSyncMs` trim, MINUS the sink's own declared latency
 * (`SINK_DECLARED_LATENCY_MS`). The same in both fan-in arms: the aligned
 * mixer adds no latency (house-clock Phase 2), so there is nothing else to
 * give back.
 *
 * NEVER NEGATIVE. A trim past D is clamped to 0, for two reasons.
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
): number {
    return Math.max(
        0,
        effectivePlayoutOffsetNs(services, { trimMs: Number(config.lipSyncMs ?? 0) || 0 }) -
            SINK_DECLARED_LATENCY_MS * 1_000_000,
    );
}
