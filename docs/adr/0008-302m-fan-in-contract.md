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
latency 50 / 200 / 500 ms — and nothing per buffer after that. (The 2× was the forced `min-upstream-latency`; see the 2026-10-05 amendment.) Sink-agnostic by
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

## Addendum (2026-10-02): live inputs give up rule 3's bypass — and the drain

#787: every edge added to, removed from or re-mapped on a 302M mixer's input
stop/started the module, and the restart rippled hop by hop through every
consumer (the mixer's bus sockets vanish; consumers EOS or error and relaunch
with an escalating backoff; each relaunch relaunches ITS consumers under
ADR-0010 rule 4). A remove was worse: a force-live `audiomixer` never
completes the pipeline-level EOS drain, so the stop stalled the full 6 s
timeout and the EOS reached every consumer first — measured on .103: 8.6 s
mixer outage, 10–11 s per hop, two restarts each.

The fix is engine-generic — `PluginModule.getLiveInputBranch` and the
tracked `bus_input_add` / `bus_input_remove` runner verbs add or remove ONE
named branch bin on the running pipeline (plugins/README.md, "Live Input
Branches") — with two consequences for this contract:

- **Rule 3 does not apply to a live-input module.** `buildAudioMixInput({
  liveInputs: true })` builds the mixer arm for ONE source as well (a hot
  add needs the aggregator to exist), each source as `( name=<mixer>_in_<hash>
  … ) ! <mixer>.sink_<i>` on an explicit request pad, demuxers keyed by the
  connection, all rendered through `liveMixInputBranch` so the start-time
  branch and a hot-added one are the same text under the same name. The
  audio-mixer and the n1-mixer-302m's input fan-ins opt in; the
  audio-output-302m and audio-transcoder keep the bypass (their strings are
  byte-identical, `liveInputs` defaults off). The cost rule 3 avoided comes
  back for those two: a lone input pays `mixLatencyMs` (200 ms default) and
  the pacer's start-up offset. Rules 1 and 2 are untouched.
- **Audio-only bus producers opt out of the EOS drain** (`PipelineDescription.
  eosDrain: false`): nothing to drain, and the force-live mix would only
  stall. The drain default stays — it exists for the Pi's stateless HEVC
  decoder (eosDrainContract.test.ts).

A dead producer costs its own input, not the mix (same day, after the first
field test: a hop that idled took its consumer down — the consumer errored
on the dead socket, relaunched, and gated forever on it). The runner
contains an error inside a live input branch (`liveInputBranches`,
filled by GstPluginBase from the hook): the branch is dropped and
`input_branch_lost` reported, the aggregator silence-fills, the module warns
by producer. When that producer reaches PLAYING, the fan-out coordinator
re-links just that branch (`relinkLiveInput`) instead of ADR-0010 rule 4's
whole-pipeline relaunch, so an upstream flap never restarts a live-input
aggregator or anything below it. The audio-output-302m is a leaf (nothing
downstream to ripple) and its branches are stamp-aligned at launch, so it
keeps the classic restart for now.

## Amendment (2026-10-05): the pacer hold is `latency`, not a PTS lead plus 2× latency

Measured on .103 with bus edge-socket taps (same socket, mute steps, five
replica shapes): the mixer arm as built held audio for **~350 ms at
`mixLatencyMs` 50** (a real 620 ms through a live-input `audio-mixer` hop,
1270 ms at 500). Two causes, both removed:

1. **PTS lead.** `mpegtsmux` writes PES PTS ~250 ms ahead of the PCR, and
   `tsdemux` bases running time on the PCR, so every buffer reaches the
   pacer ~250 ms "early" and `identity sync=true` holds it. The branches now
   run `tsdemux ignore-pcr=true` (running time from the first PTS; lead ≈ 0).
   Stamp-aligned callers (`audio-output-302m`, `alignBranchesToStamps`) opt
   out with `ignorePcr: false` and keep PCR timing.
2. **`min-upstream-latency`.** The branches report no latency; forcing it to
   `latency` doubled the reported pipeline latency and so the hold. Dropped.

Result (replica, mix latency 50 ms): +46 ms; at 20 ms: +17 ms; the deployed
`audio-mixer` hop measured 0–30 ms on the wire at 50. The hop now costs at
most the configured budget, so the budget is the latency knob:
its floor is 20 ms (was 50). The aggregator alone adds ~9 ms; the pacer is
still required for the post-EOS free-run (rule 1 stands).
