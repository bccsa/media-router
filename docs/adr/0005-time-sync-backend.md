# Time-sync backend: monotonic house clock, producer-stamped timeline contract, PTP discipline

Every process shares one monotonic house clock; producers — not consumers —
map their source timeline onto it and stamp bus buffer PTS as contractual
media time; presentation is `sync=true` against a configured playout offset;
PTP (linuxptp) disciplines the clock across devices, opening the path to
AES67/ST 2110.

## Context

A/V sync problems kept recurring in the same shape: audio lagging video,
cross-consumer disagreement, and per-restart offset lotteries — all traced to
each consumer's `tsdemux` re-deriving timestamps from its own arrival
(`docs/TodoNotes.md`, 2026-07-19/-23 entries). The video-player's `clockSync`
froze on the first frame because nothing mapped the source PES epoch onto the
shared clock's running time (measured 19.2 h in the future —
`docs/TodoNotes-video-hw-decode.md`, 2026-08-01). And AES67/SMPTE 2110
readiness requires a disciplined common clock, which the current
audio-mastered net-clock daemon (`gst-net-clock.py`) cannot provide.

## Decisions

1. **Determinism first.** Synced routes run `sync=true` against the house
   clock; latency is a configured budget (playout offset), not best-effort.
   Rejected: latency-first free-run default — reproduces today's drift and
   disagreement; two-class routes as a permanent design — free-run survives
   only as a transition state.

2. **Producer-stamped timeline contract.** A producer latches its source's
   PES timeline once (the existing TimelineLatch machinery, moved to the
   producer side) and stamps bus buffer PTS with the mapped house-clock media
   time; on discontinuity the producer re-anchors. Every consumer inherits
   identical timing by construction. Rejected: side-channel published anchors
   with consumer-side pad offsets — N consumers each applying an anchor is
   the same disagreement surface again; per-consumer arrival re-stamping —
   today's model and the root cause above.

3. **Running-time ≡ house-clock time.** Bus-attached synced pipelines pin
   `base_time=0`, `start_time=NONE`, so running-time equals house-clock time
   in every process and stamped PTS schedule correctly everywhere. Rejected:
   per-pipeline base-time with computed ts-offset trims — today's model, the
   direct cause of the first-frame freeze; distributing a session base-time —
   previously rejected as fragile (`gst-net-clock.py` header), stays rejected.

4. **Playout offset D.** One engine-wide default (~300 ms) plus per-route
   override, hot-updatable; `lipSyncMs`/`syncOffsetMs` become deprecated
   aliases onto it. Rejected: per-sink-only config — reproduces today's
   failure mode of independently trimmed sinks; an explicit sync-group
   construct — deferred, may return as the vehicle for auto-measured D.

   **Delivered in Stage 3** (D plumbing in 3a; the drift-slewing anchor that
   keeps D from being eaten by clock drift in 3b, below). The engine-wide default is `EngineConfig.playoutOffsetMs` —
   300 ms, `MR_PLAYOUT_OFFSET_MS` as the env fallback, same precedence shape as
   the contract flag itself. The per-route override lives on the **route head**:
   the producer module both consumer legs take their bus from, as a
   `playoutOffsetMs` config key on its own schema (ts-splitter, srt-input,
   rist-input, mpegts-ip-input so far). Not on the sink, and not per-edge —
   this decision rejects per-sink config, and the route head is the only surface
   where "every leg of a route resolves the same D" is true by construction
   rather than by a conflict rule between independently trimmed sinks. It also
   needs no new GUI: module settings are what the routing editor already
   renders. Resolution is one function (`plugins/playoutOffset.ts`,
   `effectivePlayoutOffsetMs`) that both legs call, so they cannot drift apart
   by re-implementation; an edit is fanned out live to every consumer of the
   head (`MediaRouter.notifyPlayoutOffsetChanged`) rather than waiting for each
   leg to rebuild. `lipSyncMs`/`syncOffsetMs` are honoured but deprecated in the
   schemas: they stack ON TOP of D as per-sink trims, which is what they are
   actually for (residual display- and DAC-chain skew that D cannot know about).
   With the contract off, both collapse to the trim alone and the legacy
   pipeline strings are unchanged.

5. **House clock = CLOCK_MONOTONIC.** A plain `GstSystemClock` in every
   process; `NetTimeProvider`/`NetClientClock` distribution becomes
   unnecessary on-device; DACs slave to it via `slave-method=skew`. Open
   validation item: A/B the audibility of skew-slaving on 302M outputs before
   deleting the DAC-master path. Rejected: DAC-master standalone plus
   OS-clock PTP as a dual regime — two clock domains to reconcile forever;
   CLOCK_REALTIME/TAI as house clock — NTP/PTP steps mid-stream are
   unacceptable.

6. **PTP: build now.** linuxptp (`ptp4l` + `phc2sys`) disciplines the system
   clock *frequency*; first step is HW-timestamp validation on Pi 5 and Intel
   NICs (`ethtool -T`). AES67 Media Profile by default, ST 2059-2 preset
   selectable, domain configurable; devices are GM-capable with conservative
   `priority1` (~200) so BMCA yields to real grandmasters. Rejected:
   `GstPtpClock` — slave-only, in-process, cannot discipline the OS clock;
   slave-only policy — a closed network of our devices would have no common
   clock at all.

   Note 2026-08-13: **"build now" is the SHAPE, not the schedule.** Delivery is
   sequenced AFTER the contract's burn-in gate — decision 11 puts PTP behind the
   sync contract, decision 10 keeps release-to-fleet gated on the soak, and the
   2026-08-13 feature freeze holds new tracks until that gate is passed. Nothing
   PTP exists in the tree (no `ptp4l`, `phc2sys` or linuxptp anywhere), and that
   is correct rather than outstanding; this note exists so the ADR stops reading
   as an instruction to start. What decision 6 fixes NOW is what will be built
   when it is unblocked: linuxptp over `GstPtpClock`, GM-capable with
   conservative `priority1`, AES67 Media Profile by default.

7. **AES67 scope.** First deliverable: RX plugin (`udpsrc` →
   `rtpjitterbuffer` RFC 7273 sync → L24 depay → bus), TX plugin (PTP-epoch
   RTP stamping, conformant packet pacing), SAP announce/discovery. Rejected
   for the first cut: ST 2022-7 seamless protection and NMOS IS-04/05 —
   explicitly deferred, with the seams noted (redundant-leg merge sits at the
   jitterbuffer; NMOS wraps the same SDP the SAP path produces).

8. **Bus unchanged.** MPEG-TS over unixfd stays the sole backbone and the
   wire protocol (`busproto.h`) is frozen; what changes is semantics —
   buffer PTS upgrades from accidental send-time to contractual media time
   (regression-test that `tsdemux` skew-correction doesn't quietly undo it).
   Raw-caps lanes over the same transport remain a per-path future option.
   Rejected: raw-GstBuffer primary bus — discards the TS backbone for no
   timing gain once PTS is contractual.

9. **PipeWire: committed removal, sequenced.** Finish the 302M ports → fleet
   audit of device-sharing configs (any sharing migrates to explicit 302M
   mixers) → ALSA-exclusive cutover with udev/ALSA enumeration → drop
   pipewire/wireplumber from the image. Rejected: keep-as-device-layer — its
   graph clock and restore behaviour are standing sync hazards ([[0006]]);
   aggressive parallel removal — breaks shared-device configs before the
   audit finds them.

10. **Rollout.** The contract ships behind one engine-level flag that
    supersedes per-module `clockSync`; burn-in on the test fleet; the default
    flips next minor after soak; a per-channel legacy escape hatch survives
    one release cycle. Rejected: keeping per-module opt-ins — timing is a
    system property, not a module property; flipping the default immediately
    — unsoaked timing changes have bitten every time.

    Amended 2026-08-12: the flag now defaults **on**, at the branch
    (pre-release) stage rather than "next minor after soak". The field results
    moved the risk: legacy `clockSync` is proven frozen on-device, and the
    contract proven exact (wire PTS ≡ anchor + PES) on two devices — so a
    default-off branch would have soaked the path we don't intend to keep.
    `MR_TIME_SYNC_CONTRACT=0` is the escape hatch (`'1'` still pins it on).
    Release-to-fleet stays gated on the burn-in soak.

    Amended 2026-08-12 (same decision): the **per-channel escape hatch is
    superseded** by that engine-wide kill-switch. It only made sense while the
    default was off and a channel could stay behind; with the default on, timing
    is a system property (the same reason per-module opt-ins were rejected
    above) and a single channel on the legacy path would put a producer back on
    a per-start base-time for every consumer downstream of it. Rolling back is
    therefore whole-engine: `MR_TIME_SYNC_CONTRACT=0` and restart.

11. **Delivery order.** Sync contract (including the video-player epoch fix)
    → PTP mode → AES67; the 302M/audit/ALSA track runs in parallel. Rejected:
    AES67-first — would stamp RTP off an undisciplined, un-contracted
    timeline; serializing the PipeWire track behind the sync work — the
    tracks don't share a critical path.

## Consequences

- `gst-net-clock.py` and the NetClientClock plumbing retire once decision 5's
  validation item passes; until then the DAC-master path stays.
- `lipSyncMs`/`syncOffsetMs` are read but deprecated; new configs use the
  playout offset. Under the contract the audio-decoder's sink presents
  `sync=true max-lateness=-1` unconditionally — a `sync=false` sink ignores
  timing outright, which would make D a no-op on that leg while the video leg
  paced off the house clock.
- The bus contract gains a regression test: producer-stamped PTS must survive
  the consumer's `tsdemux` unmodified.

## Implementation notes (Stage 2)

Corrections to the above, found while building the producer side:

- The wire was **already** clock-translated for gst producers — `unixfdsink`
  transmits running-time + base_time in the MONOTONIC domain, never buffer PTS
  verbatim. So decision 8's "PTS upgrades from send-time" holds only for the
  sidecars; for gst producers the stamp has to live in **buffer PTS upstream of
  the sink, with `base_time=0` and an identity segment**. Nothing in unixfd
  changes.
- The `TimelineLatch` moves to the producer verbatim, but its **application does
  not**: `GstPad.set_offset` (decision 2's implied mechanism) is a constant
  shift and cannot remove arrival jitter, so the stamper **rewrites buffer
  PTS/DTS** in a probe on each `busout_*` tee sink pad instead.
- **DTS is the named regression vector.** `tsdemux` takes its PCR skew basis
  from `GST_BUFFER_DTS_OR_PTS` — DTS *first* — so stamping PTS while passing a
  stale DTS through is silently a no-op. The stamper writes both.
- Consumers **no longer re-anchor via `tsparse`**: no live chain used
  `set-timestamps=true`, which survived only as a helper default and is now
  false. The remaining consumer-side re-derivation is tsdemux's skew model,
  which the stamp feeds rather than fights.
- Decision 3 as landed in Stage 1 pinned `clockSync` **consumers only**, leaving
  every producer on a per-start base-time — the contract was a no-op end to end.
  Under the engine flag it now applies to every pipeline.
- Discontinuity handling diverges from `preserveSourceTimeline`: the egress
  stamper **re-anchors in place** (one PTS step, no restart), and the re-anchor
  must drop the monotone floor with the anchor, or a late-detected forward jump
  pins the timeline ahead and freezes it.
- The **non-GStreamer producers stamp too**, behind `--stamp-timeline`
  (engine-gated on `services.timeSyncContract`, flag off ⇒ argv and wire bytes
  unchanged): `unixfd-fanout.py`, `mr-bus-fanout` and `mr-tssplit`. All three
  run the same arithmetic as the runner's probe — one `TimelineStamper`, kept
  in `plugins/mpegts-core` (`py/ts_timeline.py`, ported to
  `native/mrts/ts_timeline.*`) so the contract has one definition per language,
  cross-checked buffer-for-buffer by the fan-out conformance suite.

  Placement note ([[0002]]): the gst-side python of this subsystem lives in
  `packages/engine/src/child-process/`, not in a plugin, and ADR-0002's recorded
  exception list now says so. It is per-buffer-adjacent code only the runner can
  host — it installs pad probes on the runner's own pipeline — and it delegates
  ALL arithmetic to `mpegts-core`, so [[0001]]'s plugin-owned-maths rule is kept
  rather than bent.
- The gst probe is armed **lazily, per tee, on that tee's first consumer edge**
  (and disarmed on its last) rather than on every `busout_*` tee at start.
  Measured on the Pi 400 at 10.9.1.42 (2026-08-12): the eager version cost
  +2984 cgroup ticks/min, of which +2471 was ONE producer whose egress tee had
  no edges at all — an enabled-but-unrouted rist-input, stamping buffers nobody
  read. Lazy arming takes that term to zero (−18 / −10 / −19 ticks/min across
  three contract↔legacy pairs) and the whole contract to +526 ticks/min. A
  re-attach after a full detach anchors afresh, which is correct: an anchor only
  means anything to the consumers that held it.
- The probe makes **one parse pass** over each buffer (`ts_timeline.iter_pes`
  over a `memoryview`, then three walks over its 1-3 entry result) instead of
  re-scanning the bytes for the watch, the latch and the stamp. Order and
  arithmetic are unchanged. Worth 2.06x on the parse in isolation, but only
  ~16% of the measured per-producer field cost (+382 → +323 ticks/min on the
  routed producer): what remains is fixed per-buffer probe overhead — PyGObject
  callback dispatch, `map`/`unmap`, and the whole-buffer `bytes` copy pygobject
  makes on every `MapInfo.data` read — not TS parsing. Driving that term down
  further means moving the stamp off the python probe, not optimising it.
- The gst stamp moved **off the python probe and into a native element**,
  `mrtsstamp` (`plugins/mpegts-core/native/mrtsstamp`), which is the previous
  note's conclusion carried out: a `GstBaseTransform` in in-place mode wrapping
  `mrts::TimelineStamper` — the same object the sidecars run, so the contract
  still has one definition per language and not three. The runner loads it by
  explicit path (the scoped `resolveNativeBinary` layout, never
  `GST_PLUGIN_PATH`) and splices one in front of each `busout_*` tee with the
  element API, leaving the `buildBusSink` STRING untouched so flag-off stays
  byte-identical. `active` is the lazy arm, toggled from the same
  bus_attach/detach paths; inactive is basetransform passthrough with
  `transform_ip_on_passthrough` off, so a disarmed egress never sees the buffer
  at all. **The python probe stays** as the reference implementation and the
  fallback — a box without the plugin logs a warning and runs exactly as before.
- Measured on the same Pi 400 (10.9.1.42, 2026-08-12), 7 paired arms, 120 s
  settle + 60 s restart-free window each, on the routed producer (srt-input →
  mr-tssplit). Delta is against the mean of the two neighbouring legacy arms,
  then corrected by the same delta on the *unrouted* rist-input, which the lazy
  arm never stamps and which therefore measures the box's own drift: **python
  probe +327 ticks/min, native element +28 / +34**. Reproducing the probe's cost
  in the same session by hiding the `.so` is what makes that a control and not a
  hopeful before/after — the box's run-to-run variance is ±10%, larger than the
  element's entire cost. The stamp is now cheaper than the measurement floor.
- The element goes **before** the tee, not on its branches, and that is a
  writability decision, not tidiness: upstream of the tee the buffer is
  singly-owned, so basetransform stamps it in place with zero copies (pinned:
  `copy-count` reads 0 over a 60-buffer filesrc run, and 10/10 when a probe
  deliberately holds a reference). On a tee branch every branch would see a
  shared buffer and pay its own `gst_buffer_make_writable` — shallow, but per
  buffer per consumer.
- The stamp is **segment-correct**, not identity-only. What reaches the wire is
  `gst_segment_to_running_time(segment, pts) + base_time`, so the house stamp is
  computed in running time and mapped back to a buffer position through the
  segment's own inverse (`position_from_running_time`) — identical arithmetic on
  the probe and in `mrtsstamp`. Warning on a non-identity segment was not enough:
  it ships silently shifted timing, and a segment reaching a `busout_*` tee with
  a non-zero base is exactly what an upstream `GstPad.set_offset` produces. The
  residue that has NO mapping (no segment, a non-TIME format, a stamp outside
  the segment) is now an engine-visible `warning` event, once per armed egress,
  rather than a line on the runner's stderr.
- `preserveSourceTimeline` is **dropped when the contract is on**
  (`GstPluginBase.applyTimeSync`), so the mechanism decision 2 rejected is not
  left running alongside the one that replaced it. It cannot change what a
  consumer sees — every module that asks for it emits through a `busout_*` tee,
  and a constant pad offset cancels in the stamper's `anchor + (PES − firstPES)`
  — but it answers a source discontinuity by erroring the pipeline out to
  re-latch, which pre-empts the in-place re-anchor two notes above and rebuilds
  a transcoder's encoders over an event the contract absorbs for free. What is
  given up is the absolute PES/PCR values in the transcoded TS; no consumer
  under the contract reads those as a timeline. With the kill-switch on
  (decision 10) the legacy behaviour is bit-for-bit what it was.
- One `TimelineStamper` per language, enforced rather than asserted: the runner's
  probe used to re-implement the arithmetic as closures over a state dict while
  importing `ts_timeline` — the module that defines it. The runner subsystem now
  lives in `packages/engine/src/child-process/gst_bus_stamper.py` and holds only
  the GStreamer parts (probe install, lazy arm, native splice, event
  translation); breaking the maths in `ts_timeline.py` fails the probe suite and
  the module's own suite together. The native sidecars likewise share one JSON
  event builder (`mrts::anchor_event_json` / `reanchor_event_json`) — their
  private copies had already dropped `lastPts90k` and `deltaTicks` from the
  re-anchor, so the same event meant different things depending on which
  implementation sent it (now pinned python↔C++ in the fan-out conformance
  suite).
- `mr-tssplit` **re-latches per output PID** rather than forwarding the input's
  wire pts through `bus_client`. The input pts is one number for a MUXED
  stream, so forwarding would hand every branch the interleave's leading PID's
  time — and, under a legacy upstream, its arrival jitter. The branches share
  ONE anchor + epoch reference (only the monotone floor is per-branch), which
  is what keeps the split mutually aligned.
- The runner's stamping subsystem is **four modules, one import**:
  `gst_bus_stamper` (lifecycle — the contract flag, which egresses are armed on
  which backend, the drift timer, and all the mutable state) plus
  `gst_stamp_probe` (the python probe and its segment mapping), `gst_stamp_native`
  (loading `mrtsstamp` and splicing it in) and `gst_stamp_events` (one builder
  per engine event, both backends). They change for unrelated reasons — a
  GStreamer probe detail, a plugin-resolution path, an event field — and 657
  lines in one file hid that. The runner and both suites still address
  `gst_bus_stamper` only, so the public surface is unmoved. **Deploy note:** the
  engine's build copies `*.py` into `dist/child-process/` by an explicit list,
  so an on-device drop must ship all four files, not just the renamed one.
- **File size, where splitting is rejected** and why it is not an oversight:
  `plugins/mpegts-core/py/ts_timeline.py`, `native/mrts/ts_timeline.cpp` and
  `native/mrtsstamp/gstmrtsstamp.cpp` each exceed the repo's ~250-line guideline
  deliberately. Each is one cohesive timeline-math domain, and the first two are
  maintained in LINE-FOR-LINE cross-language parity — the property one fixture
  exploits to assert the same integers out of both languages. Splitting one side
  forces the same split on the other, so the cost is paid twice and the parity
  surface that guards against timeline bugs multiplies. Each file states this in
  its own header.

## Implementation notes (Stage 3a — playout offset D)

Corrections and findings from building the presentation side. The drift-slewing
anchor is *not* here; it is Stage 3b, below.

- The override surface is the **route head**, which is neither of the two places
  the shape of the config suggested. A per-edge value would have needed
  shared-types, manager patch rules and new edge UI (the routing editor renders
  only the bespoke channel-map modal on an edge, not a generic field), and it
  would still be per-leg — two legs of one route could hold two numbers, which
  is the failure this decision rejects. A value on the consuming module is the
  same problem more directly. On the head, both legs read one number with no
  conflict rule and no sync-group registry (which this decision deferred), and
  the routing editor already renders module settings.
- The route-head field ships with **no schema `default`**. `add /modules/<id>`
  materialises every schema default into the stored config, so a `"default": 300`
  would write an explicit per-route override onto every new srt-input — and the
  engine-wide default (and `MR_PLAYOUT_OFFSET_MS` with it) would then be dead for
  every route those modules head. Absent means inherit; the UI renders an empty
  number field, which reads as "not set".
- `Number('')` is `0`, so parsing had to reject empty strings explicitly:
  `MR_PLAYOUT_OFFSET_MS=` (set but empty, which is what an unset systemd
  `Environment=` line leaves) would otherwise have pinned every route to 0 ms.
  Out-of-range values are **rejected, not clamped** — clamping runs a mistyped
  value as if it had been chosen, where rejecting falls through to a real default.
- The audio leg needed more than a `ts-offset`: its sink was `sync=false` in the
  default configuration, and a non-syncing sink ignores `ts-offset` outright. So
  under the contract the pulsesink presents `sync=true max-lateness=-1`
  (`provide-clock=false`, paced ring floor) unconditionally, which is decision 1
  applied to the leg that had never been on it. `max-lateness=-1` is what
  disarms the mid-stream-join silence trap the old `sync=false` comment
  documents — a late timeline drains instead of being dropped.
- `name=sink` on that pulsesink is added **only** under the contract. It is what
  the live offset push addresses, and adding it unconditionally would change the
  legacy pipeline string that `MR_TIME_SYNC_CONTRACT=0` has to reproduce byte for
  byte.
- `slave-method=skew` (decision 5) is pinned by the CONTRACT PATH, not read from
  the module's stored `slaveMethod` — the audio-decoder's sink took the stored
  value on every path, and the stored value is materialised from the schema
  default (`add /modules/<id>`), so the fleet carries explicit `0`s (resample)
  that nobody chose. Resample answers a DAC/house rate difference by rewriting
  samples, i.e. by drifting off the time it was told to present at, which makes D
  approximate on the audio leg alone. Legacy paths still honour the stored value
  exactly. Decision 5's own validation item — A/B the AUDIBILITY of skew-slaving
  on 302M outputs — **remains open** (2026-08-13); the 302M output sink does not
  take D yet, so it is untouched by this.
- A head's `playoutOffsetMs` is treated as live in `ModuleInstance` regardless of
  what the plugin's `liveUpdatableParams` says: nothing in the producer's own
  pipeline reads it, so it can never need a restart there. It reaches the
  consumers through `MediaRouter.notifyPlayoutOffsetChanged`, which walks the
  head's bus edges and calls each consumer once (a consumer holding two edges off
  the same head is notified once, not twice).

## Implementation notes (Stage 3b — the drift-slewing anchor)

The third mechanism in `TimelineStamper`, after the discontinuity watch and the
bounded-staleness net, and the only continuous one. Both language definitions
carry it (`ts_timeline.py`, `mrts::ts_timeline`), pinned to each other by the
same fixture asserting the same integers.

- **What it answers is a RATE, not an event.** The stamp is `anchor + (PES −
  ref)`: media time from the SOURCE's crystal pinned to ours once. Two crystals
  are never the same — 10-50 ppm apart is ordinary, 1-4 s/day — so on a 24/7
  route the arrival-vs-stamp margin walks: source fast ⇒ buffers arrive further
  and further ahead of their own stamps and the consumer's queue grows; source
  slow ⇒ further behind, and a `sync=true` sink drops them. Neither the watch
  (a step detector) nor the net (a 5 s backstop) can see it: every PES delta is
  legal every buffer.

- **It has NO SETPOINT, and that is the whole design.** The first cut was a
  position loop: it captured a baseline margin shortly after the anchor and drove
  the margin back to it. That shipped and regressed the same day. A producer's
  margin is not ours to choose — an HLS player builds a ~2 s delivery lead over
  its first minutes and rebuilds it after every re-anchor — and a position loop
  reads that healthy buildup as an error. Measured on .202 (2026-08-13): a
  2.25 s video lead losing 125 ms in 17 minutes, the servo pinned at its ±200 ppm
  clamp, still falling, the sink dropping late frames and the picture visibly
  stuttering. Reproduced in simulation afterwards: on a **zero-drift** HLS
  producer the position loop destroys 820 ms of a 2.77 s lead in four hours and
  keeps going. The corrected servo cancels the TREND only — whatever level the
  margin settles at is the producer's business, and a level change (buffer
  buildup, a rebuffer, a route change) passes through untouched by construction
  rather than by tuning.

- **Estimator: lower envelope → sub-window median → slope.** The per-buffer
  margin is the clock offset PLUS that buffer's delivery delay, and delivery
  delay is one-sided noise: late, never early. So the MINIMUM over a 2 s bucket
  tracks the offset rather than the jitter (the min-filter of RTP/NTP skew
  estimation); a 2-minute sub-window reduces those minima to one MEDIAN level
  (robust the other way — one anomalously early bucket moves a
  minimum-of-minimums permanently and a median not at all); ten of those levels
  are the 20-minute trend window, whose slope is the median of the newest three
  minus the median of the oldest three over the time between them. The
  instantaneous margin is unusable and the fixture says so out loud: under
  segment delivery it sweeps 800 ms every six seconds while the level holds to
  single-digit ms.

- **Servo: a rate lock, not a position lock.** `rate_ppm` is an *integrator on
  the residual slope* — each sub-window it moves by a tenth of whatever slope is
  left — so it converges on the source's own offset and then holds it with the
  measured slope at zero. Setting the rate to the slope instead would un-correct
  itself the moment it worked; gain ½ (tried first) hunts, because a 20-minute
  window updated every 2 minutes is five updates of lag inside one window's
  memory. Measured over four simulated hours: ±50 ppm sources converge to
  ∓52/+49 ppm and hold their last-hour level change to −7 ms and −4 ms against
  the 180 ms/hour they walk uncorrected, while a 0 ppm producer gets *literally
  zero* correction applied.

- **Guards, each answering a way this can hurt a live route.** 5 minutes of
  settling per epoch before anything is even measured (the producer's opening
  transient is not drift, and a re-anchor restarts it); a 10 ppm floor under the
  slope (0.9 s/day, and the same order as the envelope's own noise); two
  consecutive same-signed slopes before the rate moves at all, so a level STEP
  can never read as a trend; the ±200 ppm clamp (~5× the worst crystal pair,
  720 ms/hour of authority, 200 µs per second — orders below lipsync); and the
  **give-back watchdog**, which is the direct descendant of the field failure: if
  the scheduling margin ever falls 200 ms below what it was when the servo
  engaged, the servo drops its rate and re-settles. Correcting a real drift never
  does that (holding the slope at zero holds the level too), so the only things
  it can catch are a wrong-signed correction and a drift past our authority — and
  in both cases doing nothing is better than what we were doing. It would have
  caught the field incident within minutes.

- **The monotone floor needed no change**, and the reason is quantitative: one
  slew step is `rate × dt`, nanoseconds per buffer (8 µs at the clamp for a 40 ms
  buffer), while the floor only clamps a stamp that would go BACKWARDS and
  consecutive stamps differ by a real media step orders of magnitude larger.

- **PES-less buffers are not observed.** They repeat the previous stamp, so their
  "margin" is that stamp's age — feeding them in would read as a source falling
  behind.

- The two legs of one route pick up a **fixed sub-µs residue**, not a drift: the
  audio leg's buffer arrives some milliseconds of house time after the video's
  and collects that much more of the correction (nanoseconds), constant once the
  servo has locked.

- **Observability rides the existing periodic surfaces**, because a rate has no
  moment to report at. The sidecars publish `timeline: {ppm, slewNs, marginNs,
  engageNs, samples, window}` in their 2 s stats line (one builder per language,
  and absent entirely with the contract off, so the line stays what it was); the
  gst path polls — `mrtsstamp` exposes the same field set as a read-only `drift`
  property and the python probe as `drift_stats()`, which `gst_bus_stamper` turns
  into one `timeline_drift` engine event (and one runner log line, so it is
  readable on the device) per armed egress every 30 s. `samples` below `window`
  means "not measuring yet", which an event saying `0 ppm` would not.

- Ride-along, same bug family: the runner's legacy `preserveSourceTimeline` watch
  carried its own copy of the OLD, defective discontinuity rule (reference
  advanced across the anomaly, cross-PID count the only confirmation). It is
  dropped under the contract but live for the legacy transcoder paths, where a
  missed discontinuity still costs a re-rolled lipsync. It now calls
  `TimelineStamper._coherent` / `._delta` rather than restating them. The
  mutation is instructive: restoring the old rule both MISSES a single-PID
  rewind and FALSE-FIRES on a single corrupt PTS (the advanced reference makes
  an outlier two consecutive anomalies).
