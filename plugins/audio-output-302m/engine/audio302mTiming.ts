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
 * Scheduling latency `pulsesink` is taken to DECLARE for that ring, in ms —
 * cancelled in `ts-offset` (see `audio302mTsOffsetNs`).
 *
 * A live GStreamer sink renders at `running-time + ts-offset + latency`, where
 * `latency` is the pipeline's min latency from the LATENCY query: the ring
 * PipeWire grants plus the sink's `processing-deadline`. The video leg's
 * `waylandsink` declares ~20 ms, so left alone the same route played audio
 * well behind the picture even with identical stamps and the same D. With the
 * 100 ms ring and this cancellation, plus `alignBranchesToStamps` on the
 * video-player, the transcoder and this module, the route on .103 was
 * confirmed in sync BY EAR (2026-09-03); the three are a tuple — change one
 * and re-check.
 *
 * 100 is a TEST-SOURCE calibration, not what this sink declares on the bus.
 * The 151.3/101.3/71.3 ms measured on .103 at 200/100/50 ms rings are the
 * granted ring (110/60/30 ms, PipeWire 1.6.3) + GStreamer's 20 ms default
 * deadline + 21.33 ms of the live `audiotestsrc` they were measured behind.
 * Behind the bus this sink declares 80 ms, the audio-decoder's 160 ms (its
 * 100 ms deadline) — replica chains on BCC Mulanje's .24, 2026-10-04.
 * RECORDED, NOT CHANGED: correcting it moves every leg above its floor and
 * voids the .103 tuple, a by-ear decision for all three legs at once
 * (ADR-0005, "audio-leg budget" note).
 *
 * Nor is the ring free slack: under `sync=true` a buffer is lost once it
 * reaches the sink later than `ts-offset + latency` past its stamp (late audio
 * is discarded, not played late). The .24 302M bus delivered up to ~200 ms
 * past its stamps; at the default D (ts-offset clamped to 0, an ~80 ms budget)
 * 23.7 % of the audio was discarded.
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
 * keeps presentation at `stamp + D + trim` in both arms above the clamp below
 * (at the default D the mixer arm clamps to 0 for any trim up to L + 40 ms).
 * The single-source arm declares no latency and passes 0.
 *
 * NEVER NEGATIVE. A trim past D (or L past D) is clamped to 0, for two reasons.
 * Audio cannot be presented before it arrives, so a negative offset buys
 * nothing: a sample due before it arrives is discarded by the pulse server,
 * not played late (`max-lateness` is never consulted on an audio sink). And
 * the backlog shedder measures lateness against this `ts-offset` plus the
 * sink's latency (`now − (rt + ts-offset + latency)`), so a negative value
 * makes every buffer read as retained backlog — field, 10.9.16.103,
 * 2026-09-03 11:28:53: the trim slider at −2000 ms put the sink at −1700 ms,
 * the shedder saw a "1943 ms backlog" and dropped 458 buffers (~10 s of audio)
 * chasing it.
 *
 * TWIN: `audioTsOffsetNs` in `plugins/audio-decoder/engine/AudioDecoderModule.ts`
 * cancels the same 100 ms and clamps the same way — although that sink declares
 * 160 ms to this one's 80 (above). Two copies on purpose — see the note there.
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
