# ADR-0018: The timeline conditioner absorbs a clock step once per program

The time-sync conditioner (`mrts::TimelineStamper::condition()` in
`plugins/mpegts-core/native/mrts/ts_timeline.cpp` and its python twin
`ts_timeline.py`; run by `mrtsstamp`, `mr-tssplit`, `mr-bus-fanout`) rewrites
PES PTS/DTS and regenerates PCR so a source clock step never reaches a consumer
as a discontinuity (ADR-0005). Until 2026-09-17 it held an **offset per PID**,
each PID detecting its own steps.

**Decision.** One program has one clock, so one step gets one correction:

- The **reference PID** (the PCR carrier's PES; the first PES PID until it is
  seen) is the only PID whose steps move the **program correction**
  (`cond_prog_offset_`). The regenerated PCR follows it, as before.
- Every other PID **adopts** the pending program correction the moment its own
  PTS jumps by the same amount — judged on the jump beyond the time that
  passed, so a PID idle across a source restart adopts it late but whole — and
  a PID first seen after the step adopts it at once. **Private-data PIDs**
  (0xBD: KLV cues, teletext, DVB) adopt too: they are on the program's
  timeline even though they never define it (ADR-0016's `timing_pes` gate
  stays for anchoring, latch, watch, servo and step *detection*).
- A PID that steps **alone** keeps a private correction (`own`) so the vMix
  pacer reset (audio −1.42 s, video −1.19 s a second later, both back within
  seconds, #737) still leaves the wire continuous — but that private part is
  **released after 30 s** (`COND_OWN_HOLD_NS`) if it never reverts: a lone
  permanent move is where the stream now sits, not a clock step.

**Why.** Per-PID offsets left the PIDs of one program disagreeing for the life
of the process. 2026-09-17: the .108 splitter absorbed a muxer restart (+7.32 s)
on the PCR PID alone — PTS and regenerated PCR shifted, the rendition and KLV
PIDs did not — so the player's leg sat 8.5 s off its PCR, branch alignment
refused, and the decoder re-armed every 6–9 s. The same day the .103 muxer's
egress absorbed branch alignment's legitimate −930 ms pull of one input as a
"clock step" and undid it, leaving the rendition 0.94 s out of lipsync. A pure
program-wide correction (reference only) was tried first and broke the vMix
fixture, hence the adopt-on-matching-jump rule plus the held private part.

**Consequences.** Cascaded conditioners (mux egress → SRT input → splitter)
each hold a released lone step 30 s longer, so a one-PID alignment takes about
a minute to settle at the far end of a two-box chain, and consumers see that
PID step once when it is released. A PID first seen while the reference is
mid-way through a lone excursion (vMix) inherits that excursion until the
reference reverts — accepted. Tests pin both behaviours in
`tests/ts_timeline_test.cpp` and `ts_timeline_test.py` ("program step …",
"lone step …") beside the unchanged vMix fixture.
