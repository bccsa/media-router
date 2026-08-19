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

   Note 2026-08-13 (later, operator decision): the freeze was lifted for the
   PTP and AES67 *build* tracks and both were implemented (linuxptp via
   meta-oe + `media-router-ptp` recipe, config-gated OFF by default; AES67
   RX/TX/SAP plugins). Live two-box validation passed the glass-level fps gate
   (v3d 50.00→49.98→50.00 IRQ/s, monotonic never stepped; `.42` SLAVE at
   6.5 µs rms on software timestamping). Caveats recorded: Pi 5 `macb`
   hardware timestamping advertises support but attaches no RX timestamp to
   DELAY_REQ — unusable as GM until investigated (`PTP_TIMESTAMPING` override
   added); PTP left OFF pending the burn-in soak, which remains the
   merge/release gate for the branch.

   Note 2026-08-14 (scope bookkeeping against this decision):
   - HW-timestamp validation is HALF DONE — the Pi 5 half is answered (macb
     unusable as GM, see above); the **Intel NIC half is still open**, no
     `ethtool -T` validation has been run on x86 hardware.
   - Shipped BEYOND what this decision asked for, as operator tooling: a live
     PTP status surface in the Device Manager (port state, offset/rms, path
     delay, grandmaster identity + MAC, timestamping mode) and a per-device
     `slaveOnly` knob. The knob is a per-device escape hatch, not a policy
     change — its default stays GM-capable, so the slave-only FLEET policy this
     decision rejected remains rejected.

   Note 2026-08-18 (scope bookkeeping, continued). Four more things sit beyond
   the letter of this decision. All four are DELIBERATE; they are recorded here
   so a review does not read them as scope creep and re-open them:
   - **`ptp_minor_version 0` is pinned in both profile presets**, so we emit
     classic v2.0 frames (version byte 0x02) instead of linuxptp 4.4's default
     v2.1 (0x12). The minor nibble is reserved-zero in 1588-2008, the edition
     both AES67 and ST 2059-2 build on, so v2.0 stays interoperable with every
     v2 peer — and it is what makes hardware timestamping work at all on a Pi 5,
     whose RP1 GEM RX classifier recognises only v2.0 as a PTP event frame.
     Bench-proven on the soak pair 2026-08-14 ~09:50Z: `.202` as GM ran on
     HARDWARE timestamps with zero "received DELAY_REQ without timestamp" after
     09:49:54 (152 in the operator's immediately preceding auto-mode window — a
     clean on-demand A/B), `.42` went UNCALIBRATED -> SLAVE at ~5–7.5 µs rms and
     path delay fell 43 µs -> 10.8 µs, glass verified after. That result NARROWS
     the 2026-08-13 "macb unusable as GM" caveat above: the fault was the
     version byte, not the driver, and a Pi 5 GM runs on hardware stamps with
     the pin in place. The `PTP_TIMESTAMPING` override stays, because a
     third-party v2.1 talker can still reproduce the original symptom.
   - **Turning PTP on displaces the running time source and turning it off
     restores exactly that set** (htpdate / systemd-timesyncd, whichever was
     actually stopped, recorded on the device). Not asked for here, but the two
     alternatives are worse: a device left with NO time source after PTP is
     switched off, or two daemons slew-fighting one clock after it is switched
     on.
   - **`PTP_HWTS_FILTER` is an unexposed escape hatch.** It is the second half
     of the Pi 5 hardware-timestamping workaround (`hwts_filter full` takes the
     version-sensitive classifier out of the path entirely, covering the case
     `ptp_minor_version` cannot: a third-party node sending US v2.1 DELAY_REQs).
     It stays out of the UI and empty by default because it is reported working
     upstream but is NOT yet A/B-tested on our bench — exposing an unproven
     hardware knob is how a working device gets broken by a settings page.
   - **The interface override and the full settings page are operator tooling**,
     alongside the status surface and `slaveOnly` noted above: profile, domain,
     priority, timestamping and interface are per-device escape hatches with
     GM-capable defaults, not a change to the fleet policy this decision fixed.

   Note 2026-08-19 (hardening after the 2026-08-17/18 clock incident). A latched
   servo wound a kernel clock +1.9% via ADJ_TICK over a weekend — linuxptp's
   default `max_frequency` is the clock's own advertised maximum (±90%!). Three
   mechanisms added to the `media-router-ptp` recipe in response, plus one
   default, recorded here so a review reads them as incident response rather
   than scope creep:
   - **`max_frequency 100000` is clamped in both profile presets.** 100 ppm
     covers any sane XO while making tick-level wind-up impossible; the
     unclamped default is what let the incident happen at all.
   - **The PHC is seeded from the system clock before the daemons start.** A
     PHC left >1 day stale (a cold spare, a long power-off) otherwise hands the
     servo a huge initial error and an enable becomes a step/slew episode.
   - **A tick watchdog (`mr-ptp-tickcheck` timer + service)** alarms
     independently, within seconds, if the kernel tick leaves 10000 — during
     hardening it caught a deliberately re-provoked wind-up in 9 s. Two
     diagnosis gotchas from the incident, one line each: ptp4l's logged freq
     value is the servo OUTPUT, sign-inverted against intuition; and a box
     measuring glass rates with its own wound clock reads a fast ruler — use
     CLOCK_MONOTONIC_RAW.
   - **The disable path's default, when no displaced-services record exists, is
     restore htpdate only** — the fleet's baseline time source — rather than
     guess at what PTP might have stopped.

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

## Implementation notes (Stage AES67 — RX/TX plugins and SAP)

Decision 7's first deliverable: `aes67-input`, `aes67-output` and the SAP
announce/discovery sidecar, plus the `aes67-core` library plugin that owns the
domain's python ([[0001]]). Repo-side and locally verified only — the two-box
live test needs PTP on the devices and is a later phase.

- **Ordering, stated honestly.** Decision 11 sequences AES67 *after* PTP mode,
  and PTP does not exist in the tree (decision 6's 2026-08-13 note). What lands
  here is the whole non-PTP half — receive, transmit, discovery, packet
  pacing — plus the plumbing for the PTP half behind a `ptpSync` config that is
  OFF by default and REFUSES to engage when the box cannot back it. Nothing
  here anticipates PTP by faking it; the sections below say exactly which lines
  change state the day `ptp4l`/`phc2sys` land.

- **The sender's epoch is one integer, and no TAI pipeline clock is needed.**
  This is the note's main finding, and it is the opposite of what was expected
  when the stage was scoped (a `GST_CLOCK_TYPE_TAI` clock on the egress
  pipeline, i.e. a documented exception to decision 5). Measured on gst 1.28:
  `rtpbasepayload` computes `rtptime = timestamp-offset + running_time x
  clock_rate / 1e9` from the buffer's ABSOLUTE running time, not from a
  first-buffer anchor — shifting running time by 5 s shifts the RTP timestamp
  by exactly 240000 samples. Under decision 3 running-time IS CLOCK_MONOTONIC,
  so `timestamp-offset = ((CLOCK_TAI − CLOCK_MONOTONIC) x rate / 1e9) mod 2^32`
  makes the wire timestamps PTP-epoch media time with the pipeline still on the
  house clock. **The exception was not taken**: no second clock domain, no
  runner change, no `PipelineDescription` field — the whole thing is a number
  the plugin computes at start. (A TAI clock would also have needed the bus's
  house-time PTS translated into it on every buffer, which is the same
  measurement done per-buffer instead of once.)

- **Measuring once is correct, and here is why it is not a shortcut.**
  CLOCK_MONOTONIC on Linux "is affected by the incremental adjustments
  performed by adjtime(3) and NTP" (`man 2 clock_gettime`; CLOCK_MONOTONIC_RAW
  is the variant that is not), so it carries the same frequency discipline
  `phc2sys` applies to CLOCK_REALTIME. TAI−MONOTONIC is therefore constant
  under discipline and moves only on a STEP — a discrete event to re-measure
  for, not a drift to track. This is also why decision 5's rejection of
  CLOCK_REALTIME as the house clock costs nothing here: we read the realtime
  family exactly once, for an offset, never for scheduling.

- **The refusal is the feature.** The kernel's TAI offset is 0 until an NTP/PTP
  daemon sets it (37 s today), so `aes67_clock.py` reports `disciplined: false`
  and `rtpTimestampOffset: null` — not 0, which is a legal offset and would be
  silently wrong. The sender then keeps the payloader's random RFC 3550 offset,
  drops `a=ts-refclk`/`a=mediaclk` from its SDP, and says so on the module face.
  A receiver cannot detect a sender that announces a PTP media clock it does not
  have; that failure mode is the one thing a first cut must not ship.

- **RX RFC 7273 works today and does NOT contradict decision 6.**
  `rtpjitterbuffer rfc7273-sync=true` reads `a-ts-refclk`/`a-mediaclk` from the
  receive caps (GStreamer's `a-` prefixed spelling of the SDP attributes) and
  instantiates a `GstPtpClock` for the announced domain — the slave-only,
  in-process clock decision 6 rejected. No conflict: it is rejected as the
  mechanism that DISCIPLINES the house clock, and used here only to interpret a
  sender's RTP timestamps. It is gated on an operator-supplied grandmaster id
  because a jitterbuffer told to sync to a clock that is not there stops
  producing audio — silence being the worst available failure.

- **What RX sync does NOT buy, yet.** An `aes67-input` is a bus producer, so its
  output is re-anchored onto local house time by the egress stamper
  (`anchor + (PES − ref)`). Epoch-exactness therefore survives *inside* the RX
  pipeline but not *through the bus*: two devices receiving one AES67 stream
  still align to their own anchors, not to the sender's epoch. Closing that
  needs the stamper to accept an externally supplied anchor (a
  reference-timestamp meta is already available on the buffers —
  `add-reference-timestamp-meta=true`), which is a contract change and belongs
  in its own stage, not smuggled into a plugin.

- **The AES67 egress does not take playout offset D.** Decision 4's budget is
  for PRESENTATION; an RTP egress carries its alignment in the timestamps, so
  delaying transmission by D would only spend the receiver's link-offset budget
  (typ. 1-20 ms against a 300 ms D) while changing nothing about alignment.
  What the sink does need is a *pacing* margin — the payloader emits one buffer
  per 1 ms packet and without a syncing sink they leave in decode-sized bursts —
  so it presents `sync=true max-lateness=-1 ts-offset=senderLatencyMs` (20 ms
  default) under the contract, and `sync=false` with the contract off, where
  there is no house timeline to pace against. The RX side, being a route head,
  carries `playoutOffsetMs` normally.

- **SAP is python, and both ends share it.** `aes67-core/py/aes67_sap.py` builds
  and parses the SDP and the RFC 2974 packet; `mr-sap.py` is I/O and lifecycle
  only. TypeScript has no copy of the format — the TX module passes session
  parameters as argv, the RX module consumes parsed snapshots as JSON. Two
  deliberate omissions: SAP authentication (its PGP/CMS signatures are unused in
  AES67 practice, and an unverified auth block is worse than none — the header
  is skipped, not trusted) and compressed/IPv6 announcements, which are rejected
  rather than mis-read. Announcements are re-sent every 30 s (RFC 2974's own
  300 s floor is unusable in an operator workflow, and 30 s is what
  Ravenna/Dante do), aged out at 10x that, and DELETED on shutdown so a stopped
  stream leaves other devices' pickers immediately.

- **Discovery is owned by the running modules, not by the engine.** Each
  `aes67-input` spawns its own listener and publishes whole snapshots into a
  shared table that the `aes67-stream` device provider lists. A box with no
  AES67 input therefore joins no multicast group and runs no daemon; the cost is
  that the picker only fills once at least one input module exists, which is
  when anyone needs it. Snapshots rather than deltas mean a sidecar restart
  re-syncs the GUI instead of leaving a phantom stream in every picker.

- **The 302M bus is the stereo ceiling.** `avenc_s302m` advertises `channels:
  [1, 2]` on gst 1.28 (re-verified for this stage), so a >2-channel AES67 stream
  is downmixed on the way to the bus and the module says so in its health text.
  The RTP side still receives and describes all 8 channels — the limit is the
  bus encoding, not the receiver, and it moves the day 302M multichannel does.

- **Escaped quotes in the receive caps are load-bearing.** `a-ts-refclk`'s value
  contains `=`, so it must be quoted inside the structure, and the structure
  lives inside a `caps="…"` launch clause — the inner quotes must therefore
  reach `gst_parse_launch` escaped. Both alternatives fail the property set
  outright (`\=` escaping and single quotes, both measured), and the failure
  mode is a pipeline that never starts, so the caps string is parsed back by a
  real `gst_parse_launch` in the suite rather than only string-matched.

- **Local verification, and its limits.** The suite runs real elements on the
  dev box: RTP timestamp mapping (the epoch claim above), the caps round-trip,
  and a 400-packet L24 hop over 127.0.0.1 whose PCM is compared byte-for-byte
  against the same source rendered locally — at 997 Hz, not 1 kHz, because a
  1 kHz sine at 48 kHz repeats every 48 samples and would match anywhere. The
  SAP sidecar is tested end-to-end as two processes over 127.0.0.1 (`lo` has no
  MULTICAST flag, so the group itself cannot be exercised locally). What remains
  unverified until the two-box phase: the multicast join and IGMP behaviour on
  real NICs, DSCP marking surviving the switch, interop with a third-party AES67
  device, and every `ptpSync` path — none of which any amount of local testing
  can stand in for.

## Implementation notes (Stage 3c — the latency ratchet and the backlog shedder)

A fault the contract CREATED, found in the field on a Pi 400 (10.9.1.42) ~16 h
after Stage 3a shipped: 50 fps decoded (codec IRQ ~100/s), 2.5 fps on the glass
(`vc4 crtc` IRQ 2.2/s). The picture had decayed over hours with every module
reporting healthy.

- **Decision 1 (`sync=true` everywhere) made backlog ONE-WAY.** A clock-paced
  sink drains at exactly media rate, so whatever the leg's leaky queues absorb
  during a downstream hiccup — a decode stall, a compositor hitch, a CMA
  allocation — is never handed back. The legacy `sync=false` sink presented on
  arrival and therefore gulped any backlog at max speed, which is exactly the
  assumption the video leg's queue sizing was written against
  (`pipelines.ts`: *"latency is unaffected in steady state — a leaky queue only
  holds data while downstream is stalled"*). That sentence is now marked
  falsified where it lives. Nothing in Stage 3a's own instrumentation could see
  it: producer margins were flat, the servo was correctly cancelling a real
  −18 ppm source drift, and `tsdemux` was verified to RE-SLAVE to the house
  stamps rather than free-run on the PES clock (that probe is now
  `gst_tsdemux_slave_test.py`), so the error was neither producer-side nor
  timeline drift. It was retained SCHEDULE on the consumer.

- **The diagnostic that settled it was a live `ts-offset` bump.** +1 s restored
  60 fps instantly and reverting put the box straight back to 2.5 fps, which no
  throughput fault can do. It is also why a bigger D is NOT the fix: it is
  unbounded (the ratchet keeps climbing), and it desyncs the other leg of the
  same route unless both move — decision 4's whole point.

- **The guard belongs at the CONTRACT layer, not in a plugin.** Every
  `sync=true` bus consumer the contract creates has this exposure, so
  `plugins/backlogShed.ts` owns the policy numbers and the
  `services.timeSyncContract` gate for all of them, exactly as
  `playoutOffset.ts` owns D for both legs of a route. A leg supplies only the
  two element names that are genuinely its own.

- **It is an ACTIVE shedder, not a resize.** Retention past `D + 250 ms`, held
  for 5 s (a FLOOR rule — one sample back inside tolerance resets the streak, so
  an absorbed IDR burst can never trip it), makes the runner drop the OLDEST
  queued data until the leg is back inside D, once per 60 s per leg at most. The
  queues are untouched: their depth is field-measured IDR-burst absorption and
  shrinking them puts the picture back at ~10 fps.

- **Where it measures is where it sheds, and that is NOT the sink.** Lateness is
  computed on the shed point's own pad (`now_running_time − (buffer_running_time
  + ts-offset)`, so the number is the excess over D directly), because once a
  shed starts nothing reaches the sink and a sink-pad measurement would freeze
  mid-episode. The video leg sheds at its DECODER: the backlog is upstream of it,
  compressed AUs drop at I/O speed where decoded frames would drain no faster
  than the decoder runs, and `h26xparse` has already flagged every access unit.

- **A video shed can only END on an IRAP.** Resuming mid-GOP would hand a
  stateless V4L2 decoder references that were dropped — the wedge the keyframe
  gate exists for, and the one `VP_FAULT_DROP_DELTAS` reproduces on purpose. So
  the runner keeps dropping until the stream offers a keyframe and says so
  (`outcome: awaiting_keyframe`) if that wait runs long. The audio leg is
  whole-buffer and gap-tolerant instead: no sample is ever cut, and the timestamp
  gap is what `GstAudioBaseSink` resyncs its ring on (`alignment-threshold`,
  40 ms).

- **The sanity ceiling is load-bearing.** A reading past 10 s
  (`MAX_PLAYOUT_OFFSET_MS`) is reported and never acted on: a real backlog is
  bounded by the leg's queues, so tens of seconds means the buffer timeline and
  the pipeline clock are not the same timeline — and shedding toward a target on
  a timeline the leg is not on would drop the entire stream for ever.

- **renderWatch could not name this failure, and now can.** With the leg a
  second behind, the `sync=true` sink's own back-pressure throttles ARRIVALS at
  its pad down to the rate it presents, and the frames that never make it are
  QoS-dropped in `videoconvert` — upstream of the sink, so its `dropped` counter
  stays 0. The payload is then `achieved ≈ arrivals ≈ 1 fps, dropped 0`, which
  the attribution read as "the source is under-delivering" while the source
  delivered a clean 50 fps (logged verbatim for hours on .42). Retained latency
  against the route's budget now rides on the same event and outranks every
  other rule, so the ratchet names itself (`presentation-backlog`).

- **Verification.** `gst_latency_ratchet_test.py` runs four arms of one chain in
  compressed time: legacy keeps its whole budget; a paced sink hands the budget
  over and never takes it back; on a chain with no spare rate (which is what a
  compositor-paced sink is) the floor climbs past the shed threshold and stays;
  with the shedder armed it returns to D within seconds, bounded to one episode
  per cooldown. Falsified by pointing the suite at a runner copy whose policy
  never arms (`MR_SHED_RUNNER`): 4 ratchet assertions and 9 shedder assertions
  fail.

## Implementation notes (Stage 3d — per-branch zero points at a multi-input mux)

The contract's stamps are the shared truth, and a multi-input mux was quietly
throwing them away one branch at a time. Measured on the .202 X-Chain rig
(2026-08-14): two legs of ONE producer, 0.001 ms apart at the mux INPUT, left
the mux 100–121 ms apart — a fresh value on every mux incarnation (120.4 /
104.0 / 100.1 ms over three), so not a calibratable path offset.

- **Each branch zeroes its own timeline.** `buildInputBranch` gives every input
  its own `tsdemux`, and a `tsdemux` slaves the PES timeline it emits to the
  timestamp of the ONE bus buffer it locked on (that it re-slaves rather than
  free-running is Stage 3c's finding, `gst_tsdemux_slave_test.py`). Under the
  contract that timestamp is a house-clock stamp, so the branch is exactly right
  whenever that one stamp was — and wrong by however much it was not, for the
  whole incarnation.

- **The stamp is not exact on a REORDERED stream, and that is the field
  mechanism.** `TimelineStamper` stamps `anchor + (firstPES − ref)` under a
  monotone floor, and a B-frame stream's per-buffer FIRST PES walks BACKWARDS
  (live video leg, consecutive buffers: 310127573 then 310116773), so those
  buffers' stamps are clamped UP to the previous one. Measured on the same
  producer's two legs: **120.009 ms of K spread on the video leg against
  0.316 ms on the audio leg**, where `K = stamp − ns(firstPES)` is the mapping
  itself and must be a constant. The skew the mux showed is inside that spread,
  which is what a per-restart re-draw looks like: whichever buffer the branch
  locked on, it inherited that buffer's clamp.

- **The fix anchors each branch EXPLICITLY, and to house time rather than to its
  sibling.** `alignBranchesToStamps` (runner: `_install_branch_stamp_align`)
  measures, per branch, the producer's mapping `K` — as the MINIMUM of
  `stamp − ns(firstPES)` over the buffers seen, because the floor can only push
  a stamp UP so the lower end of that distribution is the unclamped truth — and
  then the branch's own error, `K + ns(thisAU) − thisBuffer.pts`, on its demuxer's
  output. One `GstPad.set_offset()` of the median of those readings puts the
  branch's running time ON that media's house time. Absolute, not relative:
  branches align across producers as well as across each other, and a restart
  re-derives the SAME timeline instead of re-rolling the skew. A reading past
  500 ms is rejected and logged — that is no longer the zero-point error this
  removes.

- **Two things the rig had to teach, both by refuting a cheaper design.**
  *WHICH access unit* a branch emitted cannot be predicted from stream
  structure: "the first usable PES after the PAT+PMT lock" sat five frames early
  on the live video branch (applied −200 ms, residual skew −80 ms), and "the
  first PES of the bus buffer whose STAMP came back on the first output buffer"
  — which the stamp arithmetic matches to the nanosecond — computed 0 ms on a
  branch measured 107.5 ms late the same round. The access unit is identified by
  CONTENT instead, joined on the TAIL of its payload (a head join landed whole
  frames out: H.264 access units open with identical AUD/SEI bytes). And *WHEN*
  matters as much: a tsdemux re-slaves for the first seconds of a stream, so the
  reading is taken after a 3 s settle, not on the first buffer — three
  first-buffer corrections measured residuals of −25.9 / −186.6 / +46.7 ms
  because each read a transient. The correction therefore lands as one timeline
  step a few seconds in, while the mux is still filling its latency budget.

- **Two knobs, two pads, no interaction.** The operator's per-input `offsetMs`
  rides on the mux's REQUEST pad and stays exactly the manual lipsync trim it
  always was; this correction rides on the demuxer's SRC pad, upstream of it.

- **Contract-only, decided in one place.** `GstPluginBase.applyTimeSync` drops
  the config when the contract is off (the mirror of it dropping
  `preserveSourceTimeline` when the contract is on): legacy bus buffers carry
  arrival times, so there is no house mapping to anchor to and `K` would be
  noise. That also corrects a claim in that method's own comment — a constant
  pad offset cancels in the egress stamper's delta only for a SINGLE-branch
  consumer; across branches it is precisely what does not cancel, which is why
  this stage exists.

- **Verification.** `gst_branch_align_test.py` drives two stamped single-PID
  legs with different branch zero points through the real chain
  (`tsdemux ! aacparse ! queue ! mpegtsmux`) and reads the skew off the OUTPUT
  PES: 106.667 ms without the alignment, 0.000 ms with it, and the same pair
  again on a different draw (42.667 → 0.000) — the re-roll, dead. The
  measurement half is pinned separately against a clamped-stamp ladder, and the
  fixture's access units carry their identity in the TAIL only (heads identical,
  as a real frame's are) so a head join cannot pass it. Falsified two ways with
  `MR_STAMPER_RUNNER`: dropping the `set_offset` fails the four alignment
  assertions with the injected skews, and taking `K` as the latest reading
  instead of the minimum fails the clamp assertion.

- **NOT yet verified in the field.** The settled-window design is proven in the
  suite and on the bench, not on the rig: the .202 X-Chain source (an HLS VOD on
  a signed URL) expired at 13:17:05Z mid-exercise — CloudFront policy
  `AWS:EpochTime 1786713425`, first 403 four seconds later — and the chain has
  had no media since. The three refuted designs above each have a measured
  before/after on the rig; this one does not. `.202` is back on the pre-fix build
  (md5-verified restore from `/data/consolidated-deploy-bak-branchalign*`), and
  the build to re-deploy is staged there as `/data/ba6.tgz` + `/data/ba6.md5`.
  Re-run once the source is re-signed: deploy, restart the mux module, read the
  `branchAlign:` lines, then `/data/xchain-test-20260814/xchain-round2.sh`.
