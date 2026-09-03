# ADR-0008: The 302M fan-in contract — paced mixers, opaque continuation, single-source bypass

Three rules bind every 302M aggregation point in the fleet. They are cheap to
break by accident and expensive to diagnose, so they are recorded rather than
left to `audio302mHelpers.ts` comments alone.

1. **A `force-live` mixer MUST be clock-paced.** Build it through `pacedMixer()`
   — `audiomixer force-live=true ! <caps> ! identity sync=true`. Never assemble
   the string by hand and never drop the trailing `identity`.
2. **Callers chain ONLY from the returned `continuationName`.** Never hardcode
   an element name from inside the fragment.
3. **One source bypasses the mixer entirely**, with a deliberate behaviour
   change: a dying lone source stalls/EOSes the module instead of silence-filling.

## Why

**Pacing.** `force-live=true` is load-bearing for the mix — a dark input
silence-fills instead of stalling it — but the aggregator keeps producing after
every sink pad has gone EOS, by design: it cannot know a dead input will not come
back. Nothing else in a 302M chain paces it. Producer modules end in an unsynced
bus tee and the output module (time-sync contract off) in `pulsesink sync=false`,
so with no synced element downstream the mixer generates silence at CPU speed: `level` message storms,
faster-than-realtime bus traffic, a memory balloon that OOM'd a fleet box.
Measured 2026-08-25 on the fleet box (gst 1.28.2) — one EOS'd input into an
unsynced tail: **11.64 s CPU per 10 s wall**, the same pipeline with the pacer:
**0.07 s**. Reproduced bare on a dev box, same gst version, 9.16 s vs 0.03 s.
Healthy flow keeps its rate (a live stream already advances at clock rate; the
pacer only stops the pipeline running AHEAD of the clock). The cost is a one-off
startup offset of about 2× the mixer latency — measured 0.12 / 0.42 / 1.02 s at
latency 50 / 200 / 500 ms — and nothing per buffer after that. Sink-agnostic by
construction, so it holds for every 302M module's tail.

**Opaque continuation.** `buildAudioMixInput` returns
`{ fragment, continuationName }` and the continuation is a different ELEMENT
CLASS per arm: the `identity` pacer in the mixer arm, a `capsfilter` in the
single-source arm. `mixerName` is a name *prefix*, not the name of an
`audiomixer`. A caller that branched off the capsfilter in the mixer arm would
be chaining from *ahead* of the pacer and would silently get the free-run back —
i.e. rule 2 is what makes rule 1 hold at the call sites.

**Single-source bypass.** A lone input needs no summing, and the mixer was
costing it the whole `latencyMs` aggregation delay (200 ms by default) plus a
re-stamped timeline, for nothing. Without a force-live aggregator there is also
no post-EOS free-run to pace, so the arm needs no pacer.

## Consequences

- **Deliberate behaviour change on the single-source arm:** no silence-fill. A
  dying lone source EOSes/stalls the module and the runner's restart path takes
  over, instead of the mix degrading to silence. This is exactly what the
  single-input `audio-transcoder` has always done, so the fleet is consistent
  rather than split on this. A **multi-source** pin keeps force-live silence-fill:
  one dark contributor must not take the others down.
- The **zero-source** case keeps the mixer arm (callers that build a pad-less
  fan-in and wire it themselves) — which is precisely the never-fed free-run
  case rule 1 exists for, so it is paced too.
- `n1-mixer-302m`'s per-output feature mixers never pass through
  `buildAudioMixInput`, so they build through the shared `pacedMixer()`
  directly. Any new aggregation point does the same; the fix cannot be dropped
  from one side.

## References

- `plugins/audio-302m-core/engine/audio302mHelpers.ts` — `pacedMixer()` and
  `buildAudioMixInput()`; the header comments carry the per-arm detail. The
  shared 302M TypeScript lives in the `audio-302m-core` library plugin, not in
  `packages/engine`, per [[0001]]'s `<domain>-core` rule; consumers import
  `@media-router/plugin-audio-302m-core`.
- `docs/TodoNotes.md` — "302M mixers free-run after EOS — `identity sync=true`
  pacer" and "Single-source 302M fan-in bypasses the mixer entirely" (both
  2026-08-25, both live-deployed to the two test boxes).
- `plugins/README.md` → "Shared 302M audio helpers".

## Addendum (2026-09-03): the output module's sink is contract-paced

Under the engine-wide time-sync contract ([[0005]] decisions 1 and 4) the
`audio-output-302m` tail is no longer `pulsesink sync=false`: it presents at
`stamped-time + D` on the house clock (`sync=true ts-offset=D+trim
provide-clock=false slave-method=skew max-lateness=-1 name=sink`, backlog
shedder on the sink pad, live D push, `lipSyncMs` trim), exactly like the
audio-decoder leg — so a 302M output and a video-player fed from one source
schedule off the same number. Field cause and measurements are in ADR-0005's
"Implementation notes (302M output leg)". The kill-switch path still emits the
legacy string byte for byte.

Two consequences for the three rules above:

- **Rule 1 stands.** The paced sink bounds the mixer's post-EOS free-run only
  by back-pressure through the sink's ring; the `identity sync=true` pacer is
  still what keeps the mixer at real time everywhere upstream of that ring
  (`level` storms, bus traffic). Do not drop it because the tail is synced now.
- **The mixer's latency is now visible to the caller.** `buildAudioMixInput`
  returns `mixerLatencyNs` (the clamped `latencyMs`) in the mixer arm and
  nothing in the single-source arm. It is pipeline latency in GStreamer's sense
  — a `sync=true` sink adds it to every render time — so a presentation module
  scheduling against a playout offset subtracts it from `ts-offset`, or the same
  route plays `latencyMs` later through a mixer than through the bypass. Callers
  that end in an unsynced bus tee (the producer modules) ignore it.
