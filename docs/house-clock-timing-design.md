# House-Clock Timing — Conceptual Design

| Field        | Value |
|--------------|-------|
| Document     | DES-MR-TIMING |
| Version      | 0.7 — for implementation planning |
| Date         | 2026-10-12 |
| Organisation | BCC South Africa |
| Design owner | Ivan Slabbert. Decided the questions in §13.2. |
| Related      | ADR-0005 (architecture decision record: time-sync backend), ADR-0008, ADR-0011, ADR-0016, ADR-0017, ADR-0018 |
| Status       | The concept is decided (§13.1) and handed to engineering for implementation planning. Every question is decided (§13.1), including the ones the implementation plan raised on 2026-10-12 (§13.1, last rows; the plan's chapter 15). An ADR records the design and supersedes ADR-0005 decisions 2 and 4 (with their amendments) and ADR-0018. |
| Baseline     | Verified against the code at `2bbd57e7` (v2.0) and the GStreamer 1.28 transport-stream demuxer and muxer sources (`tsdemux`, `mpegtsmux`) |

> **New to MPEG-TS?** Appendix A has a one-minute primer on how timing works
> in a transport stream, and a glossary. Abbreviations are also spelled out in
> brackets where they first appear.

> **For the implementing engineer.**
> - §13.1 lists what the design owner has decided. Don't reopen these without
>   the owner.
> - §13.2 keeps the questions that were put to the design owner, each with
>   its decision and date. None is open.
> - §13.3 lists the choices left to the engineer. Record them in the ADR.
> - Risks are in §12. The text cites them (R1–R22) where they arise.
> - §15 records two follow-ups that are not part of this version: catch-up and
>   paced egress.

---

## 1. Summary

Each engine has one clock, the **house clock**. Every stream is put on that
clock exactly once, by the ingest that brings it into the engine:

1. **Ingest.** The ingest rewrites the timestamps inside the TS (MPEG transport
   stream) bytes to house time. These are the PTS (presentation time stamp) and
   the DTS (decoding time stamp) in every PES (packetized elementary stream)
   header. The source's PCR (program clock reference: the sender's clock,
   sampled into the stream) is used only to measure the source clock against
   the house clock.
2. **Processing.** From then on PTS is never re-derived. Muxers, mixers,
   transcoders and splitters keep it. A node that combines streams waits for its
   slowest input instead of moving anyone's timeline.
3. **Egress.** Egress keeps PTS and writes a new PCR from the house clock.
4. **Between engines.** On the network, PTS is an absolute time on the TAI
   (International Atomic Time) timescale.
   - By default, every stream is restamped where it lands, including one from
     another engine.
   - An operator can set a receiving ingest to trust the PTS as received, which
     keeps the origin's timeline. For that, the stream must declare house time
     and the two house clocks must be disciplined to a common reference.

The ingest offset, with its per-PID trim, is the only adjustment of content
time anywhere in the system.

After ingest there are no deadlines. Content leaves each node as soon as
processing and alignment allow, and nothing is discarded for being late. Every
module shows the latency it adds, and how late its output is against the house
clock, in ms (§9.5).

This replaces the current model. Today the TS bytes carry the source's
timeline, and house time travels beside them on the buffers of the engine's
internal bus (the transport between modules). Every hop re-estimates the
relation between the two (§2).

**Assessment.** The concept holds against the code. Every bus module fits one of
four roles (§11), and most of the per-hop timing machinery becomes unnecessary.
Verification found six refinements, and they are part of this design:

1. **House time on the network is absolute.** It is the TAI timescale, derived
   from the monotonic house clock by an epoch offset latched at start and
   re-latched only after a clock step (§10.3). The clock that schedules
   pipelines does not change (§4).
2. **One clock lock per program at ingest.** An ingest locks one "virtual STC"
   (system time clock: a decoder's running copy of the sender's clock) per
   program to the source PCR. Sources whose PCR cannot be trusted fall back
   explicitly, and the fallback raises an alarm (§5).
3. **Audio is rate-matched once, where it first becomes PCM,** and again only
   at the output device. Restamping fixes the labels, not the sample counts
   (§5, §8).
4. **Latency is measured, not enforced.** An aligner waits for its slowest
   delivering input, a physical output plays as soon as it can, and a network
   egress's delay D_e (§4.6) follows measured lateness. None of them is a
   deadline (§9).
5. **Trust between engines is an operator choice, and it is verified.** It is
   never automatic, because a trusted remote stream makes every local aligner
   wait for its transit. A Trust selection is checked against the stream's
   in-band declaration and its PCR (§10).
6. **Every consumer demuxes by formula.** PES PTS maps to running time by a
   fixed function, never by estimation (§6).

The main risks are:
- the native demux's coverage of stream types and PES edge cases;
- the fleet's time-sync baseline, which cannot support trust today;
- the size of the change, made while the current model still needs field
  fixes;
- sources whose clocks are bad;
- the rate-matching work;
- higher latency on some routes, and today's timing settings, which are
  removed rather than migrated.

They are covered in §12. Every question has the design owner's decision;
§13.2 lists them with their answers.

## 2. Why the current model keeps producing new faults

How the current model (ADR-0005 and its amendments) works:

- **House clock.** It is `CLOCK_MONOTONIC` (Linux's steadily counting clock,
  which starts at boot) with `base_time = 0` in every pipeline. GStreamer's
  running time (the pipeline time that schedules playback) is therefore the
  box's uptime. It is local to each device and has no meaning on another device.
- **Anchored producers** (network ingests, captures, encoders, and the 302M
  mixers; 302M is SMPTE ST 302M, uncompressed audio carried in a TS):
  - The producer stamps the bus buffer, a side-band GstBuffer (GStreamer data
    buffer) PTS/DTS, with house time. The TS bytes keep the source's timeline.
  - The stamp is anchored on *arrival*: the house time of the first PES, then
    `anchor + (PES − first PES)`.
  - Seven mechanisms defend that anchor: a latch-repair window, a discontinuity
    watch, a staleness net, late and early re-anchor tiers, a drift-slew servo, a
    wire conditioner that rewrites steps out of the PES, and PCR regeneration at
    `PTS − 250 ms`.
- **Transform producers** (transcoder, audio-transcoder, mpegts-muxer, teletext)
  stamp by identity, `PES − 1 h`. Their `mpegtsmux` (GStreamer's TS
  multiplexer) already writes house time.
- **Consumers:**
  - Presentation legs and transform producers demux with `tsdemux` (GStreamer's
    TS demultiplexer), whose timestamps come from the in-band PCR and its own
    skew model. They then correct those timestamps against the side-band stamps,
    by branch alignment or by retiming each access unit (one coded frame) joined
    on its payload tail.
  - The 302M mixer branches latch `tsdemux ignore-pcr` on their first PES and
    correct nothing.
  - The splitter discards the upstream stamp and re-anchors on its own arrival.
- **Presentation** happens at `stamp + D` (D: the playout offset). D is resolved
  from a "route head", the nearest producer upstream that declares one. A late
  leg raises D at runtime, and a leg rebases once its lateness passes 10 s.
- **Network egress** forwards the bus bytes unchanged and unpaced. House stamps
  never reach the wire: the PCR a receiver sees is whatever the producer wrote,
  and every receiving engine re-anchors the stream as if it were foreign.

Eight root causes recur:

1. **Two timelines travel together, and every hop must re-join them.** The bytes
   carry source time and the buffer carries house time. Consumers reconcile them
   by estimation: tsdemux skew, branch alignment, payload-tail joins, and the
   subtitle `StampModel` learning K (the offset between a producer's stamps and
   its PES timestamps) from "rises". That is three estimators of the producer's
   mapping, six implementations counting both languages, and each one is a place
   to be wrong. Evidence:
   - #819 (the two language implementations diverge);
   - the 80–125 ms demux zero-point errors (ADR-0005 Stage 3d);
   - seven field rounds for subtitle cue timing.
2. **Time is anchored on arrival, not on the source clock.** Arrival is the clock
   plus delivery noise. Encoder buffering and sender restart bursts therefore read
   as clock events. The source PCR is never used for clock or rate. Field results:
   - re-anchors every ~10 s on a clean CBR (constant bit rate) feed (#816);
   - ±12 s audio swings (#825);
   - a program split by 8 s at the conditioner (#836);
   - a slow source that never keeps its anchor (#812).
3. **Every producer hop re-estimates.** Each anchored producer, splitter and relay
   runs its own stamper and conditioner, so errors cascade. In ADR-0018, one step
   passes through three conditioners in series, each holding it for 30 s.
4. **Corrections are timeline steps, and steps propagate.** A re-anchor is a PTS
   step on every downstream edge:
   - decoders re-arm on DISCONT (GStreamer's discontinuity flag) (#816);
   - a mux writes PAT/PMT (program association and program map tables: the
     stream's table of contents) before every packet after a backward jump (#824);
   - sinks must rebase.
5. **Presentation delay is coupled to the graph.** D comes from the nearest
   producer upstream that declares one. A stale value two hops up re-timed a
   player and dropped a Pi 5 to 2 fps (frames per second) (#830).
6. **Sample clocks are never reconciled.** Stamps are mapped to house time, but
   samples keep the ADC's (analog-to-digital converter's) rate. Every element
   that counts samples absorbs the mismatch on its own schedule (#814).
7. **The house clock has no meaning between devices.** Engine-to-engine streams
   are re-anchored like any external feed. Inter-engine lipsync is a chain of
   per-hop estimates, not a property of the system.
8. **Late content is discarded.** Outputs shed what misses the playout contract
   (the backlog shedder, seen on the 302M audio outputs), leaky queues drop what
   they cannot hold, and GStreamer sinks and decoders drop late buffers by
   default. A passing delay therefore becomes lost content.

**What it costs.** The app holds about 12,000 lines of timing-specific source
and 11,600 lines of tests. That is about a third of each pipeline runner: roughly
1,600 of the Python runner's 4,741 lines and 2,400 of the native runner's 6,665.
ADR-0005 alone has grown to 1,400 lines. Almost all of it exists to estimate,
defend or repair the relation between the two timelines.

## 3. The concept as principles

Principles P1–P6 and P11 state the design owner's concept. P7–P10 are
refinements this design adds so that the concept holds in practice.

| # | Principle |
|---|-----------|
| P1 | **One clock per engine.** Every timestamp inside an engine is a reading of its house clock. |
| P2 | **Stamp once, at ingest, in the bytes.** An ingest rewrites each PES PTS/DTS (and the PCR) to house time. The source PCR serves only to measure the source clock against the house clock. Nothing downstream re-estimates. |
| P3 | **Processing never moves PTS.** Aligners (mux, mixer, compositor) align by PTS and wait for the slowest input. Time spent shows as lateness, never as a change of timeline. |
| P4 | **Content time is adjusted only at ingest.** The ingest offset and its per-PID trim, positive or negative, are the only content-time controls in the system. |
| P5 | **Egress keeps PTS and writes a new PCR from the house clock.** |
| P6 | **An ingest trusts another engine's PTS only when the operator selects it and the stream qualifies.** Qualifying means both ends run continuous time discipline, the stream's PMT carries the house-time descriptor, and its transit stays within the input's tolerance (§7, §10.4). By default, and whenever a stream does not qualify, the ingest restamps. |
| P7 | **Audio is rate-matched once, where it first becomes PCM:** at capture, or at the first decode of a foreign-clocked stream, and never again on an internal hop. On the bus, sample count and PTS agree. A physical output matches the device clock on the way out (§8). |
| P8 | **Latency is measured, never enforced.** An aligner waits for its slowest delivering input; a physical output plays as soon as it can; a network egress's delay D_e follows the measured lateness of what passes through, and grows when it grows. None of them is a deadline, and none is inherited through the graph. |
| P9 | **Demux by formula.** A consumer's running time is a fixed function of the in-band PES PTS. |
| P10 | **House time on the network is TAI.** It is derived from the monotonic house clock by an epoch offset latched at start and re-latched only after a clock step (§10.3). |
| P11 | **Nothing is discarded for being late.** After ingest there is no deadline: content leaves each node as soon as processing and alignment allow. Every module measures and shows the latency it adds, and how late its output is against the house clock, in ms. |

## 4. Time bases

### 4.1 Scheduling clock — unchanged

The house clock stays what ADR-0005 decisions 3 and 5 made it:
- a `CLOCK_MONOTONIC` `GstSystemClock` in every process;
- `base_time = 0`;
- running time equal to monotonic nanoseconds.

It never steps (jumps). Its rate follows whatever disciplines the system clock.
NTP (Network Time Protocol) and PTP (Precision Time Protocol, IEEE 1588) slew
the clock, i.e. correct it gradually by adjusting its rate. Slewing moves
`CLOCK_MONOTONIC` together with `CLOCK_REALTIME` (wall-clock time); only
`CLOCK_MONOTONIC_RAW` (the undisciplined hardware count) is exempt.

### 4.2 House timescale

House time on the network is `H = MONO + E`, where:
- MONO is a `CLOCK_MONOTONIC` reading;
- `E = CLOCK_TAI − CLOCK_MONOTONIC`, measured when the engine starts and
  re-measured only after a clock step (§10.3). `CLOCK_TAI` is Linux's TAI clock.

Slewing moves MONO and TAI together, so E stays correct while the time daemon
slews. Only a clock *step* invalidates E. A step is a discrete event, and the
engine can detect it.

This is the same measurement `aes67-output` already makes for its RTP
(Real-time Transport Protocol) `timestamp-offset` (`aes67-core/py/aes67_clock.py`),
raised from one module to the whole engine.

**Decided (§13.1).** TAI is the network timescale, and E is applied only at the
network boundary (§4.5). §4.3 sets out what that makes identical between
engines.

### 4.3 Representations

| Where | PTS / DTS (90 kHz, 33 bit) | PCR (27 MHz) | GstBuffer PTS/DTS |
|---|---|---|---|
| **Bus** (inside one engine) | `(MONO + 1 h) mod 2^33`. This is exactly what `mpegtsmux` writes from running time with `base_time = 0` (`TS_MUX_CLOCK_BASE`); the ingest writes the same. | House-locked. `mpegtsmux` writes its PCR stream's DTS − 125 ms; the ingest maps the source PCR. | House time. Used only for lateness. |
| **Network** (between engines and to third parties) | `H mod 2^33`, i.e. `TAI × 90 kHz mod 2^33` | `H(emission) − D_e` | — |

The two representations differ by a constant 33-bit addition, `E − 1 h`. It is
applied at network egress and at a trusted network ingest, and nowhere else.

**What is identical between engines.**
- **On the network, PTS are identical.** E is in effect the TAI time at which
  the engine booted, so `MONO + E` cancels each engine's boot time. Two engines
  write the same PTS for content that lands at the same instant, to within the
  clock error between them: microseconds with PTP, milliseconds with NTP.
- **On the bus, PTS differ between engines.** They count from each engine's
  boot. If engine A booted 2 h ago and engine B 9 h ago, one instant is 3 h on
  A's bus and 10 h on B's. This is never visible, because bus PTS never leave
  an engine unconverted. Content from A lands on B's bus at B's own time for
  that instant, where B's local content for the same instant sits.

Network PTS are identical only while all of these hold:
- Both engines latched E while synchronised, and no clock step has happened
  since (§10.3).
- Both kernels have the TAI−UTC offset set (37 s in 2026). Without it,
  `CLOCK_TAI` equals UTC and that engine's PTS are 37 s off. The engine checks
  the offset before it latches E, as `aes67_clock.py` already does.
- The content landed at the same instant. With Restamp, content lands at its
  arrival plus the source's lead, so one source reaching two engines over
  different delays gets different PTS. Only Trust keeps the origin's PTS.
- The egress writer (Phase 5) is in place. Until then, network egress forwards
  the bus bytes unchanged, so the wire carries boot-based PTS. That is
  harmless, because receivers restamp them.

### 4.4 The 33-bit wrap

`2^33 / 90 000 = 95 443.7 s`, which is 26 h 30 min 43.7 s.

- **On the network**, the wrap happens at the same TAI instant on every
  synchronised device. A receiver unwraps to the 2^33 period nearest its own
  clock, which is valid while |lateness| < 13 h.
- **On the bus**, the wrap follows local uptime, as it does today; this is
  `house_from_mux_pts`.

### 4.5 Why the epoch stays at the network boundary

The alternative is to calibrate every pipeline clock so that running time *is*
TAI. That puts one timeline everywhere, but it has four costs:

1. Every process must apply an identical E.
2. Running times grow to ~1.8 × 10^18 ns, beyond JavaScript's exact-integer range
   (9 × 10^15) for engine code that handles nanoseconds.
3. Elements that assume running time near zero get worse. `audiomixer
   start-time-selection=zero` already failed on uptime-sized values (ADR-0005
   Stage 3g). A local probe during this review suggested that `videorate
   drop-only` stops decimating at PTS ≈ 10^5 s.
4. A re-latch of E would move every pipeline at once.

At the boundary, E touches two places only: network egress and trusted network
ingest.

### 4.6 Terms

| Term | Meaning |
|---|---|
| content time | A PTS on the house timescale: when the content "happened" as far as the engine is concerned. |
| lateness λ | House time when data reaches a point, minus its PTS. Because PTS is house time, it can be measured directly at any node. Negative means early. |
| added latency | The lateness a module adds: lateness at its output minus lateness at its input. For an aligner it includes the wait for its slowest input. |
| ingest offset O | The per-ingest shift of content time (P4). |
| per-PID trim | A signed constant, within ±2 s, on one elementary stream of an ingest, on top of O (§5.5). |
| W | Silence limit of an aligner (mux, mixer or compositor): how long an input may deliver nothing at all, neither data nor a gap, before the aligner continues without it. A few hundred ms, set from the input's normal arrival rhythm. It measures silence, not lateness, so a late input that is still delivering is waited for. |
| D_e | Egress delay. It sets `PTS − PCR` for third-party receivers and follows the lateness at the egress. The egress itself sends everything as it arrives. |
| E | The engine's epoch offset, TAI − MONOTONIC. |
| H | House time on the network timescale, `MONO + E`. |
| h | A reading of the house clock on the bus timescale, `CLOCK_MONOTONIC` in nanoseconds: the independent variable of the ingest model (§5.1). It differs from H by the constant E. |
| S(h) | The virtual STC: the ingest's estimate of the source's 27 MHz System Time Clock at house time h, `S(h) = a·h + b`, locked to the PCR arrivals (§5.1). Inverting it maps each source PTS, DTS and PCR onto house time. |
| a, b | The virtual STC's rate and offset. `a` is the source clock's rate against the house clock, from a slow loop. `b` follows the lower envelope of the PCR arrivals, i.e. the minimum delay. |

## 5. Ingest — where time is decided

### 5.1 TS with a usable PCR: the virtual STC

The ingest recovers the source clock the way a decoder does, but it records
instead of presenting. It keeps a *virtual STC*: an estimate of the source's
27 MHz clock as a function of house time, `S(h) = a·h + b`, locked to the PCR
arrivals.

- **Offset b** follows the lower envelope of the arrivals, i.e. the minimum
  delay. Delivery delay is one-sided noise, the min-filter argument ADR-0005
  Stage 3b already makes.
- **Rate a** follows a slow loop. Its tuning is risk R4; its constants are the
  engineer's choice (§13.3).
- **Arrival** is the house clock read by the restamp element itself, which
  sits directly after the transport element (`udpsrc`, `srtsrc`, `mrristsrc`,
  the RTP depayloader) and before any module queue: the instant the transport
  hands the packet over, after its recovery buffer. A source element's own
  buffer timestamp is not used; `srtsrc`'s is the send time in GStreamer 1.28.
  It is *not* the time the buffer reaches a stamping element after the
  module's queues, which is what today's stamper reads (corrected 2026-10-12,
  implementation plan OQ-19).

For every PES of the program:

```
house PTS = the h at which S(h) = source PTS      (+ O)
house DTS = the h at which S(h) = source DTS      (+ O)
house PCR = the source PCR mapped the same way
```

The PES header and the PCR field are rewritten in place. That is the byte
rewrite the conditioner already performs, with a different function. The TS
that leaves the ingest is self-consistent in house time.

Properties:

- **One mapping per program.** Every PID (packet identifier: the number that
  tags one stream's packets) of a program moves together, so a split like #836
  cannot occur.
- **Only the source clock and the minimum network delay enter the mapping.**
  Encoder buffer fullness (the PTS−PCR lead) does not, so the lead wander behind
  #816 has no effect.
- **Drift is tracked from the PCR.** The spec sends a PCR at least every 100 ms, so
  drift is tracked in seconds, not tens of minutes (#812); a source with a steady
  sparser PCR (one per GOP, every 2 s on the owner's vMix) is tracked on its own
  cadence, in about a minute (§5.3).
- **Content lands on the source's own presentation schedule, as seen here:**
  arrival plus the source's PTS−PCR lead. A compliant source therefore never
  delivers an AU (access unit: one coded frame) after its house PTS, except for
  network jitter above the minimum delay. This *source-natural* landing is the
  default (decided 2026-10-12, §13.1). Arrival landing is not a mode; an
  operator who wants the lead back sets a negative O (§5.5). See also §9.4.

### 5.2 Source discontinuities

A source restart, PCR discontinuity or rewind re-locks the virtual STC. House
time does not jump, so downstream sees a *gap*: no content for the length of the
outage.

- **The gap is signalled.** The ingest sends a gap (a GStreamer gap event) for
  the missing time as soon as it knows of it, so aligners downstream don't wait
  for content that will not come (§6).
- **Overlap.** If new content would land before content already emitted, the
  ingest drops the overlap, so PTS stays monotonic per elementary stream.
- **A PES that straddles a re-lock** is mapped by whichever mapping's STC range
  contains it.
- **The tie-break.** Each epoch's range is first PCR − 1 s to last PCR + 4 s. A
  PES in one range uses that epoch; in neither, the newest; in both, the epoch
  whose lead for that PES is closest to the PID's median lead before the
  re-lock (decided 2026-10-12; implementation plan OQ-11).
- **No timeline step ever leaves an ingest.**
- **A sending engine on this design causes no re-lock when it restarts.** Its PCR
  is house time, which continues across the restart; only the delivery has a gap.

### 5.3 Sources whose PCR cannot be used

The ingest validates the PCR continuously:
- its rate against arrival stays within a bound;
- it does not freeze or leap without a discontinuity flag;
- the PTS−PCR lead stays within a sane range;
- PCRs keep their own steady cadence: late is twice that cadence, never under 500 ms
  nor over 4 s. A steady sparse PCR, such as vMix's one per 2 s GOP, is a usable
  PCR and locks (decided by the owner 2026-10-22, implementation plan B-86; the
  draft asked for at least 10 per second).

A PCR that fails, like the vMix PCR that stops and lags (#820), drops the ingest
to a degraded mode:
- the virtual STC locks to the reference PID's PTS against arrival, i.e. the
  lower envelope of `arrival − PTS`;
- the ingest raises a **degraded clock** warning;
- a lead larger than the downstream queues can hold (#820 measured 12.6 s) is
  clamped by the same fallback.

This keeps a small version of today's estimator, confined to ingest and to bad
sources (S5). The validation bounds are the engineer's choice, set from field
captures (§13.3, R4).

### 5.4 Other ingest kinds

| Ingest kind | Clock evidence | Content time | Rate handling |
|---|---|---|---|
| TS over RIST (Reliable Internet Stream Transport) / SRT (Secure Reliable Transport) / UDP (User Datagram Protocol) with PCR | PCR against arrival | Virtual STC (§5.1) | Compressed audio carries the source rate in its PTS deltas; the first PCM (pulse-code modulation: uncompressed audio) decode rate-matches it (P7). |
| TS without a usable PCR | Reference-PID PTS against arrival | Virtual STC on PTS (degraded, alarmed) | As above. |
| PCM capture (PipeWire / ALSA, the Advanced Linux Sound Architecture) | Device timing: sample position against `CLOCK_MONOTONIC` (`pw_time`, ALSA htstamp) | Capture time | ASRC (asynchronous sample-rate conversion) to house rate at the ingest (#814). |
| Video capture (V4L2, Video4Linux2) | Kernel capture timestamp (`CLOCK_MONOTONIC`) | Capture time | Frame cadence follows the source. |
| AES67 (Audio Engineering Society standard for audio over IP) / RTP | PTP media clock, or RTP timestamp against arrival | With `ptpSync` selected (opt-in, as today) and PTP-locked in the same domain: RTP time → TAI → bus (Trust). Otherwise a virtual STC on RTP time (Restamp). | ASRC at the ingest. |
| HLS (HTTP Live Streaming), files, test and silence generators | None usable (bursty or none) | House time at playout start plus media offset | Nominal rate, paced by the house clock. Long-term drift is corrected by rare discrete skips or repeats. |
| Another engine on this design, ingest set to Trust (§10.4) | Absolute PTS plus in-band declaration | As received, `− E + 1 h` into the bus representation | As received. |

### 5.5 Ingest offset

One offset O per ingest, applied to its whole program, default 0. A per-PID
trim on top of it, bounded to ±2 s and default 0, shifts one elementary stream
against the others (decided 2026-10-12, §13.1): the ingest lists the PIDs from
the PMT with their type, a positive trim lands that PID later and a negative
one earlier, and a PID's effective shift is O plus its trim. It corrects a
source's fixed internal A/V (audio/video) error, or delays one stream to match
an external path such as ClarioCast. The live-edit rule below applies per PID.
No other node has an offset.

- **Positive O** lands content later. Aligners hold this stream until the others
  catch up, and its latency grows by O.
- **Negative O** lands content earlier, so it arrives |O| *late* against its own
  PTS. Every aligner it meets holds its other inputs by |O|.
- **Live edits never move PTS backwards on the bus.** A positive change inserts a
  gap; a negative change drops the content it overlaps.
- **It is content time, not a playout delay.** Outputs have no playout delay
  (§8), and the legacy per-module `playoutOffsetMs` goes (#830). Today's timing
  settings are removed at cut-over, none migrated (§13.1).
- **The ingest reports its measured lead** (minimum, median and maximum of
  PTS − arrival). A negative O no larger than the minimum lead recovers latency
  without making any AU late. It also shows the trim in force on each PID.
- **No ingest has this control today.** The closest were the mpegts-muxer's
  per-input offset (removed 2026-09-28, ADR-0017) and the per-sink `lipSyncMs`
  trims.

**Talent feedback loops.** An interpreter or commentator speaks in reaction to
what they hear on their monitor, which plays content `λ_monitor` late (its
lateness at render). Their microphone is captured in house time, so the voice
lands `λ_monitor + reaction` after the content it answers.

- With `O = −λ_monitor` on the microphone ingest, the voice lands one reaction
  time after the content. The aligner holds the programme by `λ_monitor` to
  wait for it.
- This is how a translation mix keeps the interpretation lag at the
  interpreter's own reaction time, rather than adding the monitor delay to it.
- The offset follows the monitor's lateness by hand: the operator reads the
  monitor output's lateness from its display (§9.5) and sets O on the
  microphone ingest, applying the change at a pause in the talent's speech,
  where a dropped or inserted slice is silence. There is no automatic tie
  (decided 2026-10-12, §13.1).

## 6. Processing — where time is kept

1. **PTS in = PTS out.** A node may add latency but never moves content time. The
   only exceptions are new timestamps derived deterministically from input PTS:
   - deinterlaced field times;
   - frame-rate conversion onto a house-time grid;
   - an aggregator's output grid.
2. **Demux by formula (P9).** Running time is `unwrap(PES PTS) − 1 h`, and DTS
   likewise. There is no PCR skew estimation, no payload join and no learned K.
   - **A native demux element writes the formula** (decided 2026-10-12,
     §13.1). It parses the PES headers itself and sets each buffer's running
     time from the PES PTS and DTS, as above. It is one user of the shared TS
     module (§11.5): one native implementation of the TS walk, used by the
     ingest restamp (§5.1), this demux, the egress writer (§7) and the splitter
     pass-through, loaded by both runners. The bus stamp is not read for time.
     Consumers move from `tsdemux` to it in Phase 3 (§14); there is no bridge.
   - **Stock `tsdemux` was considered and rejected,** in both configurations
     (1.28.2 source):
     - *(a1) `ignore-pcr=true`* anchors once, for the consumer's lifetime, on
       the side-band stamp of the bus buffer that carries the first PES header,
       and on undocumented internals: the first-header rule, DTS read before
       PTS, a 2 s segment shift, a 5 s fake-PCR advance, and the segment
       rebuild on a PMT change. Upstream changed this code in 2020, 2024 and
       2025. Measured on 1.28.2: at the 33-bit wrap, a stream whose DTS lags
       its PTS, as with B-frames, takes a permanent 26.5 h offset. The
       side-band stamp would stay load-bearing, which P9 sets out to end.
     - *(a2) PCR mode, fed exact PCR stamps,* has failure modes no stamping
       convention removes: a bus buffer delayed 1.5 s by a bus stall trips the
       1 s resync threshold and steps the timeline on an internal hop, which
       item 7 forbids; several PCRs in one buffer bias the minimum filter by up
       to the buffer's duration; a PES more than 15 s from the last PCR is
       dropped or pushed without a timestamp.
   - **Conformance fixtures for the native demux:** B-frames (DTS against PTS),
     several PIDs in one buffer, the 33-bit wrap, gaps (§5.2), a PMT change, a
     PES without PTS, sparse private streams. Each is replayed through both
     runners.
3. **Codecs keep frame PTS.** Audio encoders that derive timestamps from sample
   counts (`perfect-timestamp`) are correct only on house-rate PCM (P7).
4. **Aligners** (`mpegtsmux`, `audiomixer`, a future compositor) hold every input
   until the slowest has delivered data, or a gap, up to time T, then emit T.
   - **A late input is waited for, never dropped (P11).** The aligner emits as
     soon as every input has caught up, so in normal operation its added latency
     is the wait for its slowest input.
   - **Absence is signalled where it can be.** An ingest that has lost its
     source sends a gap (§5.2), and a module that stops ends its stream. A
     sparse input, such as subtitles, signals gaps between its cues, so it is
     never mistaken for a silent one. The mixer fills a gap with silence; the
     mux leaves it out.
   - **A silent input is not waited for** (decided, §13.1). An input that
     delivers nothing at all, neither data nor a gap, for longer than the
     silence limit W is treated as absent, with an alarm, and the aligner
     continues with its other inputs. W is a few hundred ms, set from the
     input's normal arrival rhythm, for example three times its usual gap
     between arrivals and at least 100 ms. W measures silence, not lateness: a
     late input that is still delivering is waited for. W is short because
     every millisecond an aligner waits for a dead input becomes latency at
     every output downstream (S10).
   - **The aligner's pace** is the lateness at which it emits: that of its
     slowest input. Four rules govern it (decided, §13.1):
     - **It goes up when a slower input joins,** or when a connected input
       gets slower, for example a transcoder under load. The aligner holds its
       output for the difference while that input catches up, then continues
       with every input aligned. Downstream this is one brief gap (silence, a
       held frame, a flagged PCR jump on network outputs), after which
       everything runs that much later. No content is lost, and no restart is
       needed; a restart would give the same result with a longer gap.
     - **It holds while an input is absent,** counting that input at its last
       measured lateness. It does not speed up to the remaining inputs: if it
       did, an input slower than the rest could never rejoin, because its
       frames would always be behind the aligner's position. Holding costs
       nothing, because the outputs downstream already run at this lateness.
     - **It comes down only when an operator removes the slow input from the
       route.** The outputs downstream follow at their next gap (§8).
     - **It starts at the pace its configured inputs will need,** where their
       upstream modules' output lateness is already known (§9.5), so a slow
       input that joins after start-up needs no step.
   - **A returning input rejoins at the current position.** Its frames for time
     the aligner has already emitted are stale and are discarded; mixing or
     muxing resumes with its current frames. This loss falls only on an input
     that failed and is coming back (R21).
   - **In GStreamer,** the aggregator times out by lateness, not by silence, so
     the silence limit is a watchdog beside it that fills an absent input with
     gaps (§13.3).
   - Nothing is placed by arrival. The elements that still do are listed in
     §11.3 (R10).
5. **Mux.** `mpegtsmux` writes `PES PTS = running time + 1 h`, which is the bus
   convention, so a mux output needs no stamp. Its PCR is house-locked by
   construction: the PCR stream's DTS − 125 ms, every 40 ms by default.
6. **Splitter.** PES bytes pass through untouched. Each output carries the
   program's PCR, which mr-tssplit already re-injects.
7. **Nothing on an internal hop corrects time.** No conditioner, re-anchor, latch
   repair, drift servo or branch alignment runs between ingest and egress. An
   internal stream cannot have a clock step, because the house clock does not
   step.

## 7. Egress — where time leaves

- **PTS/DTS** are translated to the network timescale with a constant `+ E − 1 h`.
  Content time does not change.
- **The PCR is new: `PCR = H(emission) − D_e`.** The design owner has decided
  this (§13.1).
  - It sits on the program's PCR PID, at most 40 ms apart. Where the PCR PID is
    sparse, PCR-only packets are inserted, which carry the PCR in their
    adaptation field (an optional extension of the packet header).
  - D_e covers the stream's lateness at the egress plus the receiver's minimum
    buffer, which keeps `PTS − PCR` positive for third-party decoders. It
    follows that lateness from a starting margin (decided, §13.1).
  - Changing D_e is a PCR discontinuity, flagged with `discontinuity_indicator`
    (the TS flag that tells receivers the PCR jumped).
  - The PCR's frequency is exactly the house clock's.
- **Nothing is dropped for lateness (P11).** The egress sends everything as it
  arrives. When the lateness at the egress grows past D_e, D_e is raised. Each
  raise is a flagged PCR discontinuity, so D_e starts with a margin. D_e
  comes back down only at a gap: receivers follow our PCR, which MPEG limits to
  ±30 ppm off nominal, so slewing away 1 s would take about 9 hours.
- **Why the mux PCR is not kept.** It is house-locked, but it rides on the mux's
  output timing:
  - a third-party decoder would slave to our lateness jitter and get only 125 ms
    of buffer;
  - a relay (ingest → egress) would forward a mapped source PCR.

  A PCR taken from the emission clock gives every receiver a clean house-rate
  clock and a known buffer. Computing the PCR once upstream (mapped at ingest,
  or written by the mux) and only translating it at egress was considered and
  rejected. The cost is a TS rewrite at every network egress (R11).
- **The drift assumption holds.** PTS and PCR come from the same house clock.
  Between ingest and egress, the only drift is the house clock's own frequency
  change during the transit. With the PTP servo clamped to ±100 ppm (parts per
  million), that is below 100 µs for a 0.5 s transit, and far less in practice.
- **Declaration.** A registration descriptor in the PMT states that PTS is house
  time on the TAI timescale. It also carries the following, which a
  Trust-selected ingest checks (§10.4):
  - the sender's sync source and its traceability;
  - the PTP domain and grandmaster identity, when there is one;
  - the estimated clock error;
  - D_e.

  The exact format is the engineer's choice (§13.3). Third-party receivers
  ignore the descriptor. If the 33-bit PTS ever proves
  ambiguous, there is a standards-based way to carry a full PTP time per AU: the
  TEMI (Timeline and External Media Information) timeline descriptor. It is
  defined in ISO/IEC 13818-1, the MPEG-2 Systems standard, and travels in the
  adaptation field.
- **Pacing.** TS egress sends on arrival today (`sync=false`). PCR jitter
  therefore equals the egress's write jitter, which IP receivers absorb (R17).
  Paced egress for hardware receivers is not in this version (decided
  2026-10-12, §13.1); §15 records it as a follow-up.
- **AES67.** Under PTP discipline, RTP time is already TAI × rate. Under this
  design the AES67 egress takes its PCM from the formula demux, which replaces
  its unaligned `tsdemux`.

## 8. Presentation — where time is spent

Decided on 2026-10-12 (§13.1): physical outputs play as soon as they can.

- **When an output renders.** On arrival. An audio or video output decodes
  content and plays it as soon as it can, with no presentation delay and no
  scheduling by PTS. Its lateness at render (`now − PTS`) is measured and
  shown, not set (§9.5).
- **Alignment between outputs is done upstream.** Streams that must be seen and
  heard together pass through a muxer (§6) before playout. The muxer emits them
  interleaved by PTS, so they reach the outputs together. There are no
  presentation groups.
- **What remains is the decode difference.** After a muxer, a video player and
  an audio output fed by it differ only by their decode and render times, tens
  of milliseconds, below the 45 ms at which audio leading video becomes
  noticeable (ITU-R BT.1359, the broadcast recommendation on relative
  audio/video timing). This is accepted as not noticeable, and there is no trim
  for it (decided 2026-10-12, §13.1). Today's `lipSyncMs` and `syncOffsetMs`
  have no successor.
- **Straight from an ingest, streams are not aligned.** An ingest keeps each
  stream's own lead (§5.1), and encoders often send video up to about 1 s
  earlier than the audio for the same moment. A route from an ingest straight to
  a player is out of lipsync by that difference unless it passes through a
  muxer. A player never aligns them itself: the video player renders video only
  and drops any audio PID, so it plays as fast as it can, and lipsync for a
  program is made upstream by a muxer (decided 2026-10-12, §13.1); risk R22.
- **Nothing is dropped for lateness (P11).** Video sinks' `max-lateness`, QoS
  (quality-of-service) frame skipping in decoders, audio sinks' skipping of late
  samples, a Wayland sink's dropping of frames while a redraw is pending, and
  leaky queues are switched off or replaced (§11.3, R10). Content delayed by a
  stall is played late. An output's latency comes back down only at a gap in
  the content, or when the output restarts, at the cost of what it held (S10).
  There is no catch-up in this version; §15 records one as a follow-up.
- **An output that cannot keep up,** such as a decoder slower than real time,
  falls behind steadily. Its lateness display shows the trend rising; the
  alarm on it is deferred with the other lateness alarms (§9.5, §13.1) and,
  when it comes, is a capacity fault, not a lateness policy. A full queue is
  a resource fault and is alarmed as one.
- **Leaving the house clock.**
  - Audio leaves through ASRC to the device clock (P7), after a small prefill
    that rides out arrival jitter. The ASRC follows the measured ratio between
    the device clock and the house clock, not its buffer fill; following the
    fill would make it a catch-up. ASRC replaces skew slaving, which drops or
    inserts samples at the drift tolerance (R5).
  - Video is paced to the display: each frame waits for the display's next
    refresh, and none is dropped for lateness, so after a stall video stays in
    step with audio. Frames are repeated or dropped only to match the display's
    rate, or locked by genlock (locking the output's timing to an external
    reference) where the hardware has it. This is rate matching between clocks,
    not a lateness policy.

## 9. Lipsync and latency

### 9.1 Inside a program

An ingest runs one virtual STC per program. The A/V relationship is therefore
the one the source sent, and P3 preserves it through every hop. No per-hop or
per-branch correction exists to go wrong. At a physical output, that
relationship holds only if the streams pass through a muxer first; a player
never aligns them itself (§8, §13.1).

### 9.2 Between sources on one engine

Landing times differ by each source's encoder and transport delay. The engine
does not discover them. The operator sets O per ingest once, which is delay
matching, as a frame sync does. From then on the alignment is permanent: there
is no anchor lottery on restart and no drift.

### 9.3 Between engines

PTS is absolute. When every ingest along the way is set to Trust (§10.4),
content ingested at engine G keeps G's ingest timeline on every engine it passes
through. Any aligner that combines it with other content of the same origin is
then exact, whatever route each stream took.

The clock error ε between engines affects only two things:
- content *captured* at different engines is offset by ε;
- lateness readings at the receiver are off by ε, so W and D_e must include
  |ε|.

| Use | Clock agreement needed | Discipline |
|---|---|---|
| One engine, or inter-engine streams restamped | None (rate discipline recommended) | Any |
| Trusted WAN (wide-area network) contribution and return; A/V of one origin | Rate locked; ε well inside the latency margins (tens of ms) | Continuous NTP (chrony, an NTP daemon); SNTP (Simple NTP) with the transit check |
| Several devices capturing one scene, mixed sample-aligned; low-latency LAN (local network) | ε ≤ ~10 µs | PTP |
| One-shot step at boot (htpdate, which sets the clock from web servers' HTTP date headers) | ±0.5 s, no ongoing discipline | Not sufficient for trust |

**Worked example.** Engine A processes audio that engine B then muxes with
video it transcodes itself.

1. Engine G ingests a programme. Its video and audio land at content time T.
2. G sends the audio to A. A processes it (say 40 ms) and forwards it to B.
3. G sends the video to B, which transcodes it (say 400 ms).
4. B's mux receives the audio at `T + λ_a` and the video at `T + λ_v`. It holds
   the earlier one until both have reached T, then emits at `T + max(λ_a, λ_v) +
   margin`.

The A/V offset of the output is 0 by construction. It does not depend on λ_a,
λ_v, A's processing or the route. Clock error between G, A and B changes only
B's lateness readings, and with them W.

**Choosing Trust or Restamp.** Trust buys origin alignment, and every aligner
downstream pays for it with the link's transit (§9.4). Restamp lands the stream
where it arrives and costs nothing.
- **Trust** when the streams being combined share an origin and took different
  paths. Examples: the worked example above; a programme's processed return
  audio muxed back with its own video; several devices capturing one scene.
- **Restamp** when a remote feed is combined live with local content, such as a
  contribution from another site, or when the link's clocks cannot be
  disciplined.

### 9.4 Where latency accrues

Lateness is measured, not inferred. It grows through four contributions:
- the ingest's landing choice;
- transit;
- processing;
- every aligner's wait.

Each follows what it measures:
- **Aligner silence limit W:** a few hundred ms, from each input's arrival
  rhythm. It fires only on an input that has stopped delivering (§6).
- **Physical outputs** set no delay: they play as soon as they can (§8).
- **Egress delay D_e:** the lateness at the egress, plus the receiver's buffer.

D_e is raised automatically when lateness grows past it; nothing is dropped
instead (P11). Lateness is shown per module; its alarms are deferred (§9.5);
risk R9.

Two consequences need stating:
- **Source-natural landing (§5.1) costs nothing at an output.** An output plays
  on arrival, so content landed ahead of its PTS simply shows as early
  (negative lateness). The lead matters only where an aligner combines sources
  with different leads: the source with the larger lead is held by the
  difference, which a negative O trades back (§5.5).
- **Aligning with a remote stream costs its transit.** A local route that aligns
  with a trusted remote stream inherits that transit, which can be seconds over a
  WAN. Alignment cannot avoid this, which is why Trust is opt-in (§10.4).

### 9.5 Lateness on every module

Lateness is measured, not enforced, so it has to be visible. Every module shows,
in ms:

- **Output lateness:** how late its output is against the house clock
  (`now − PTS` as content leaves). An ingest shows a negative value: its content
  is early by the source's lead.
- **Added latency:** output lateness minus input lateness, for each input. An
  aligner also shows which input it is waiting for. An output also shows its
  decode and device latency, so its lateness at render says when the content is
  actually seen or heard.
- **Alarms** at thresholds the operator sets are deferred to a later release
  (the owner's decision of 2026-10-12, §13.1): this version ships the lateness
  display with a label and no alarm. When alarms come they warn; they never
  drop content.

Modules in the PipeWire graph carry no PTS; they show the latency PipeWire
reports for them.

## 10. Clock discipline and trust

### 10.1 The fleet today

- **htpdate** is enabled: `-t -s`, Type=oneshot. It steps REALTIME once at boot,
  to about ±0.5 s, and exits. It reads the time from web servers over HTTP, so
  it works where outbound NTP is blocked. It was chosen because some sites once
  blocked outbound NTP. That is no longer the case at any site (decided
  2026-10-12, §13.1).
- **systemd-timesyncd** is enabled and runs SNTP. It slews, and steps any offset
  above 0.4 s.
  - The house clock's rate is therefore disciplined only when timesyncd reaches
    an NTP server.
  - Nothing checks whether it does.
- **PTP** (linuxptp, `media-router-ptp`) is opt-in per device and off by default.
  - Nothing disciplines a grandmaster. Read on 2026-10-14 without changing
    anything: GATE01, the domain's grandmaster, had not been disciplined
    since boot (kernel state `TIME_ERROR`, frequency 0 ppm) and ran 0.2–0.3 s
    off UTC after 9.7 days of uptime. Every box following it carries that
    error.
- **The kernel TAI offset is 0** on every box measured on 2026-10-12, so
  `CLOCK_TAI` reads the same as `CLOCK_REALTIME`. Nothing deployed sets it:
  not htpdate, not timesyncd, and not PTP as deployed (§10.2).
- **The engine has no view of sync state.** Apart from the Device Manager's PTP
  status page, nothing reports whether the clock is synchronised, or how well.

### 10.2 Required for trusted streams

- **Continuous discipline, frequency and phase, on both ends** (SNTP, chrony or
  PTP). Both must trace to a common reference: UTC (Coordinated Universal Time)
  or TAI through GNSS-backed (satellite-navigation, e.g. GPS) NTP or PTP, or
  the same PTP domain and grandmaster.
  - A PTP grandmaster is disciplined too. A box that may become grandmaster is
    kept on NTP time by chrony while its port is neither UNCALIBRATED nor
    SLAVE, and linuxptp steers it while it follows a better grandmaster; the
    two never steer the clock at once (2026-10-14).
- **Slew after the boot-time sync.** A step is the exception, and each one is
  one engine re-epoch.
  - chrony: `makestep 1.0 -1`, a step whenever the offset exceeds 1 s (e.g.
    back from a long offline spell), each settled as one engine re-epoch; slew
    below that (2026-10-14, an engineering decision open to the owner's veto;
    ADR-0029).
  - ptp4l / phc2sys: a step on first lock only.
- **A grandmaster serves a stepped clock.** At boot a box that may become
  grandmaster starts chrony before ptp4l, waits for its sync (30 s at most) and
  steps once, so the sub-second offset an RTC leaves at boot is never served to
  the domain or slewed into it. Without NTP it serves after the 30 s wait and
  announces itself not traceable.
- **A bounded slew rate.** A slew changes the house clock's frequency, and every
  output has to follow it. ptp4l is already clamped to 100 ppm.
- **A correct kernel TAI offset.** Otherwise engines started on opposite sides
  of a leap second sit 1 s apart. None is scheduled, but one remains possible
  until 2035. Under chrony it comes from `leapsectz` (which needs the
  `right/UTC` zone file in the image) or the newer `leapseclist`. Under PTP a
  grandmaster announces `timeTraceable`, `currentUtcOffsetValid` and
  `timeSource` NTP only while chrony keeps it synchronised, by the engine's
  own test (kernel synchronised, error bound under 1 s), and slaves set their
  kernel TAI offset from that announcement. The PTP setup still seeds the
  offset from the same `leap-seconds.list` before ptp4l starts, for a box
  that boots offline.
- **The engine reads the daemon's state:** synchronised or not, and the estimated
  error.

The image's time source is decided: chrony. So is the minimum discipline for a
Trust selection: any continuous discipline, with the transit check of §10.4 as
the gate (§13.1). The PTP election stays on priority alone (decided by the
owner, 2026-10-14): a grandmaster's sync state is announced, and never changes
which clock wins.

### 10.3 Epoch policy

- **Latching.** E is latched at engine start, once the daemon reports sync and
  the kernel TAI offset is set (§10.2). The wait is bounded at 30 s. When it
  expires, the engine logs a warning, latches E anyway and starts. Its network
  egress declares itself *not traceable* until E is re-latched.
- **E stays constant while the engine runs.** The engine watches `TAI − (MONO +
  E)` for steps. A `timerfd` armed with `TFD_TIMER_CANCEL_ON_SET` reports a
  REALTIME step at once.
- **Divergence above tolerance** is treated as a step: the engine re-latches
  (next bullet) and raises an event.
- **Re-latching** is automatic. When sync arrives after an untraceable start,
  or when a step is detected, the engine re-latches E at once and raises an
  event. Because E is used only at the network boundary, a re-epoch steps
  nothing but the network egress PTS, as one flagged discontinuity.
  Trust-selected receivers see it through the transit check (§10.4) and fall
  back and return automatically. No operator action is needed.

Decided on 2026-10-12 (§13.1): a 30 s wait, then a warning and start; re-epoch
is automatic. Risk R6.

### 10.4 Trust or Restamp at a network ingest

Trust is an operator choice per network ingest; it is never automatic (decided,
§13.1). Each network ingest has one of two timing modes.

**Restamp** (the default). The stream is treated like any external source: a
virtual STC on its PCR, landing where it arrives (§5.1).
- A stream from another engine lands at arrival plus the sender's `D_e −
  λ_egress`, which is the receiver buffer the sender chose.
- The ingest reports that lead, and a negative O trims it (§5.5).
- Local aligners never wait for this link's transit.

**Trust.** PTS is kept as received, so content keeps its origin timeline. Every
local aligner that combines the stream with others waits for its transit (§9.4).
Neither the ingest offset nor the per-PID trim applies to a trusted stream:
trust means untouched (decided 2026-10-12, §13.1). The controls stay visible
but disabled, with the reason shown beside them: the ingest is in Trust mode;
switch it to Restamp to set an offset.

Why Trust is never the default: a remote stream arrives late by the network
delay plus its transport latency (the RIST buffer, the SRT latency). Trusted, it
holds every local stream it is muxed or mixed with by that much. That is right
when origin alignment matters (§9.3), and wrong for most live feeds from other
sites. `aes67-input`'s `ptpSync` is already this kind of opt-in.

**Verification.** A Trust selection is verified continuously. The stream
qualifies only while all three of these hold:
1. The PMT carries the house-time descriptor.
2. Both ends declare continuous time discipline (SNTP, chrony or PTP; §10.2).
3. The transit check passes. The sender's PCR is `H(emission) − D_e` (§7), so
   `PCR + D_e` is the emission time and `transit = arrival − (PCR + D_e)`.
   Trust holds while the transit is non-negative and no more than `L + τ`: L is
   the input's configured transport latency (the SRT latency, the RIST buffer)
   and τ is a tolerance. τ defaults to 0.2 s and is a per-input-module setting
   for links that need more. With an SRT latency of 2 s the bound is 2.2 s. A
   negative transit beyond jitter also fails, because content cannot arrive
   before it was emitted.

The bound catches any clock disagreement of size, including an unset kernel TAI
offset on one end (§10.2, 37 s) or a leap-second split (1 s), without needing
to check traceability.

If a Trust-selected stream does not qualify, the ingest restamps it and raises
an alarm that names the failed condition (decided, §13.1). It returns to Trust
by itself once the stream qualifies again, one gap or dropped overlap each way,
with an event (decided 2026-10-12, §13.1). Risk R8.

**Switching modes.** A switch between trust and restamp moves content time by
the transit. Going to restamp leaves a gap; going to trust drops the overlap.
- A fallback to Restamp is taken at once when the transit check fails: the
  switch is itself the gap.
- A return to Trust, and an operator's mode change, wait up to 30 s for a
  natural gap (a re-lock, an outage, a stream (re)start) and are then taken at
  once.
- Every switch raises an event (decided 2026-10-12, §13.1).

## 11. Verification against the engine

**Method.** The verification was done on code and source only; no device was
used:
- For every module class, the code at `2bbd57e7` was traced: pipeline strings,
  stamper options, demux and aggregator properties, and sink settings.
- The GStreamer 1.28 `tsdemux` and `mpegtsmux` sources were read for the
  timestamp paths this design depends on.

### 11.1 Every bus module fits a role

| Module | Role | Today | Under this design |
|---|---|---|---|
| rist-input, srt-input, mpegts-ip-input | Ingest (TS) | Source PES kept. Stamp anchored on arrival at the egress head. The conditioner rewrites steps and replaces every PCR with `PTS − 250 ms`. The source PCR is never used for clock or rate. | Virtual STC on the source PCR. PES, DTS and PCR rewritten to house time. Ingest offset. |
| hls-player | Ingest (bursty) | Paced writer with a ~2 s delivery lead. The sidecar stamps on arrival without repair, and the module switches repair off for everything downstream. | Nominal-rate playout on the house clock, content time assigned at playout. The delivery-lead special case disappears. |
| aes67-input | Ingest (RTP) | Muxes itself, so its PES already carry house + 1 h. Still anchored and conditioned at egress. The PTP epoch is lost at the bus. | With `ptpSync` (opt-in, as today) and PTP lock: RTP time → TAI → bus (Trust). Otherwise a virtual STC on RTP time. Identity egress; ASRC. |
| audio-input-302m | Ingest (PCM) | Muxes itself; PES = capture running time + 1 h (house). Anchored and conditioned at egress. | Capture time; ASRC to house rate; identity egress. |
| audio-encoder | Ingest (PipeWire PCM) | `pulsesrc` re-timestamps by whole rings (+190 ms steps), absorbed by a 100 ms conditioner threshold. | Capture time from device timing; ASRC; identity egress. |
| video-encoder | Ingest (V4L2) | `liveCaptureClock`: PES = running time since PLAYING + 1 h, which is not house time. | Capture time on the house timescale, by a constant base-time correction or by fixing the aggregator mis-schedule ADR-0005 Stage 3e works around. |
| ts-splitter | Processing | Discards the upstream wire PTS (`BusClient` hands over bytes only), conditions, and re-anchors on its own arrival: a second ingest. | Pass-through: PES untouched, the program PCR copied, no stamper. |
| transcoder, audio-transcoder | Processing | Identity egress. Inputs retimed per access unit (payload-tail join, K per epoch). | Formula demux; identity egress unchanged; ASRC where foreign-clocked audio is decoded. |
| mpegts-muxer | Processing (aligner) | Identity egress. Every input retimed. Window fixed at 2.4 s. KLV (key-length-value metadata, which carries subtitle cues here) and subtitle PIDs restamped to arrival. | Formula demux on every PID, private ones included; W sized from measured lateness. |
| audio-mixer, n1-mixer-302m | Processing (aligner) | Branches latch `tsdemux ignore-pcr` on their first PES. Anchored egress bakes transit and mix latency into the timeline. Clock pacer. | Formula demux, identity egress, W from lateness. #837 did this and was reverted on 2026-10-10; Phase 2 takes what was good in it (§13.1, R15). |
| audio-processing | Processing | As the mixers. Programme and key (the side-chain signal that triggers ducking) are joined by arrival (`interleave`). The ducker loop runs in the engine on `Date.now()`. | Key aligned to the programme by PTS; ducking applied in the pipeline, on content time. |
| teletext-subtitles | Processing | Identity egress. K learned from stamp rises (`mrpeshouse`, `StampModel`). | Formula demux; no learning. |
| rist-output, srt-output, mpegts-ip-output | Egress | Byte pass-through, unpaced (`sync=false`). The wire PCR is whatever the producer wrote. | PTS translated to TAI; new PCR `H − D_e`; descriptor. |
| aes67-output | Egress | Remuxes to RTP. RTP time = TAI when `ptpSync`, with the offset measured per module at start. Its `tsdemux` is unaligned. | Formula demux; engine-wide E. |
| video-player, audio-decoder, audio-output-302m | Presentation | `sync=true` at stamp + D (route-head walk, runtime raise, rebase). One-shot branch alignment. Audio skew-slaved. Late data shed (backlog shedder) or dropped by the sink. | Plays as soon as it can: decoded and rendered on arrival, with no presentation delay. Nothing dropped for lateness. Formula demux, for lateness; ASRC to the device at the measured clock ratio; video paced to the display. The video player renders video only; any audio PID is dropped at its demux. |

**Outside the bus.** audio-input, audio-output, n1-mixer and audio-dynamics live
in the PipeWire graph and carry no PTS. They are deprecated or VU-only (VU: a
level meter). Here PipeWire is a clock domain, like a DAC (digital-to-analog
converter), entered and left through ASRC (P7). That is consistent with ADR-0005
decision 9 (PipeWire removal).

### 11.2 What already fits

- **The scheduling clock**, MONOTONIC with `base_time = 0`, is P1's clock.
- **Identity egress** ("house-timeline" mode) is P3 at a producer's output. Four
  modules already use it.
- **The capture producers that mux** (audio-input-302m, aes67-input,
  audio-encoder) already write house time into their PES. Only their egress
  stamp re-anchors them.
- **The conditioner** already rewrites PES PTS/DTS and the PCR in place. That is
  the byte machinery an ingest restamp needs.
- **mr-tssplit** already re-injects the program PCR on every output.
- **AES67** already maps MONO to TAI for RTP, and its receiver can read a PTP
  media clock.
- **PTP** (linuxptp) is packaged, hardened after the 2026-08 clock incident, and
  validated on a two-box bench.

### 11.3 What stands between today's code and this design

1. **The splitter is a second ingest.** It discards the wire PTS and re-anchors
   on its own arrival.
2. **The mixers and audio processing bake their transit into the timeline.** They
   use anchored egress, and each branch is latched on its first PES.
3. **Per-access-unit time is not in the bytes.** Every consumer recovers it,
   through retime, alignment or K learning.
4. **Elements align by arrival or by sample count, not by PTS:**
   - `interleave` in audio processing (collect-pads, which joins by arrival);
   - the ducker loop (engine-side `Date.now()`, applied by property set);
   - KLV and subtitle PIDs in the muxer (restamped to arrival);
   - AAC (Advanced Audio Coding) and Opus encoders with `perfect-timestamp`
     (they snap after 40 ms of drift);
   - `audiomixer`'s 40 ms alignment threshold and 1 s discont-wait (continuity
     by sample count);
   - limiter lookahead and steep EQ (equaliser) filters, which add latency that
     nothing reports.
5. **Budgets are fixed:**

   | Where | Fixed budget |
   |---|---|
   | Mux window | 2.4 s |
   | 302M mixers | 20 ms or 200 ms |
   | Player ES (elementary stream) queue | 1 s |

6. **video-encoder's PES are not house time.** They carry running time since
   PLAYING.
7. **Late data is discarded (P11):**
   - the backlog shedder and rebase on presentation legs, seen on the 302M audio
     outputs;
   - leaky queues (the 1 s player ES queue, the 5 s edge queues);
   - sink and decoder defaults that drop late buffers (`max-lateness`, QoS);
   - aggregators that time out on a slow input and then drop its late data.

### 11.4 Mechanisms and their fate

| Mechanism | Where | Source lines (approx.) | Fate |
|---|---|---|---|
| Anchored stamping: latch, latch repair, watch, staleness net, late and early tiers, drift servo | `ts_timeline.{py,cpp,h}`, `gstmrtsstamp.cpp`, runner glue in both runners | 5,300 (shared with identity mode) | Removed from every hop. An ingest uses a virtual STC; every other egress uses identity. |
| Wire conditioner: step absorption, program-wide steps (ADR-0018), PCR at `PTS − 250 ms` | Same files | (included above) | Removed. A source discontinuity becomes an ingest re-lock. |
| Branch alignment and per-AU retime | `gst-pipeline-runner.py`, `branch_retime.{py,cpp}`, `branch_align.cpp` | 2,100 | Replaced by formula demux. |
| Subtitle K recovery | `mrpeshouse`, `subtitle_stamp_model.py`, `subtitle_native.py` | 700 | Replaced by formula demux. |
| Lateness handling: shedder, raise, rebase | `backlog_shed.{py,cpp}`, runners, `backlogShed.ts`, `playoutReanchor*.ts`, `PlayoutRaises.ts` | 2,600 | Removed: outputs play as soon as they can, and nothing is discarded for lateness. What remains is `now − PTS`, shown on every module. |
| Route-head D, latch-repair resolution | `playoutOffset.ts`, `latchRepair.ts`, `MediaRouter` head walk | 300 | Removed: outputs have no presentation delay. |
| Render keep-up | `render_lag.py`, runners, `renderLag.ts` | 570 | Kept (diagnostic). |
| Scheduling clock | Both runners | — | Kept. |
| Identity egress | Stamper | — | Kept. It becomes the only stamp mode on internal hops. |
| TAI−MONOTONIC offset | `aes67_clock.py` | 120 | Generalised to the engine-wide E. |

### 11.5 New work this design needs

**One shared TS module** (decided 2026-10-12, §13.1). Items 1, 2 and 3, and the
splitter pass-through (§14, Phase 2), are built on one native module in
mpegts-core: packet walk, PSI, PES reassembly for every PID, PCR read and write,
PES header rewrite, 33-bit unwrap and the 1 h formula. It is implemented once,
loaded by both runners, and has no Python twin. The pieces that exist today,
`ts_psi`, `ts_timeline`'s `house_from_mux_pts`, `ts_split` and the PES walker in
`mrpeshouse`, fold into it.

1. **Ingest restamp:**
   - the virtual STC, with PCR validation and the degraded fallback;
   - a per-ES monotonic guard;
   - the ingest offset.

   It is a user of the shared module above, which ends the twin-parity burden
   (#819).
2. **Native formula demux** for every consumer (§6), on the shared TS module.
3. **An egress writer:** TAI translation, PCR generation and insertion, and the
   descriptor, on the shared TS module.
4. **ASRC**, once per audio path (P7): at PCM capture, or at the first decode of
   foreign-clocked audio; and at outputs to the device clock (#814). Nothing on
   the bus resamples twice.
5. **Engine clock state:**
   - the engine epoch E, time-sync status and step detection;
   - chrony in the image, replacing htpdate and systemd-timesyncd; PTP where a
     site runs it. Whichever owns the clock also sets the kernel TAI offset
     (§10.2).
6. **Lateness on every module** (§9.5): output lateness and added latency in ms,
   with D_e following it.
7. **Ducking in the pipeline,** on a PTS-aligned key, and a PTS-aligned
   interleave.
8. **Manager work:** settings for the ingest offset, the per-PID trim at the
   ingest (±2 s, default 0), the timing mode (Trust or Restamp), the Trust
   tolerance per network input (default 0.2 s above the transport latency,
   §10.4); lateness alarms are deferred to a later release (§9.5). Every
   module's lateness and added latency (§9.5), and the measured lead, transit
   and sync state, are shown beside them (R14). On a Trust-selected ingest the offset and trim controls are
   disabled, with the reason shown (§10.4).
9. **Removal of today's timing settings** with the mechanisms they belong to;
   nothing is migrated (Q9, R13).
10. **No late drops:** remove the shedder and rebase; switch off late-drop
    settings in sinks, decoders and queues; signal gaps from ingests and sparse
    producers; a silence watchdog on every aligner input (§6).
11. **Outputs that play as soon as they can** (§8): unsynchronised sinks, ASRC at
    the measured clock ratio, video paced to the display without dropping.

### 11.6 Stale statements found during verification

These don't change the design, but they can mislead whoever works on the timing
code. They are not corrected now: the current model is frozen during the migration
(§13.1), and the ADRs that carry them are superseded phase by phase (§14).

| Where | It says | The code |
|---|---|---|
| ADR-0005, Stage 3f | A plain capture producer's bytes are never touched. | audio-encoder's egress conditions them (`conditionStepMs: 100`). |
| ADR-0008, amendment of 2026-10-05 | `mpegtsmux` writes PES PTS ~250 ms ahead of the PCR. | For audio (PTS = DTS), GStreamer 1.28 writes the PCR at DTS − 125 ms (`TSMUX_PCR_OFFSET`), so the lead is 125 ms. |
| ADR-0018 | `mr-bus-fanout` runs the conditioner. | `mr-bus-fanout` only stamps; it never calls `condition()`. |
| `Aes67OutputModule.ts`, `aes67_clock.py` | The TAI offset is re-measured after a clock step. | It is measured once, when the module starts. Nothing detects a step. |

## 12. Shortcomings and risks

Levels: H = high, M = medium, L = low. Rows are in level order. Numbers stay
stable between versions, so a later addition can sit out of sequence.

### 12.1 Shortcomings — limits of the concept itself

| # | Level | Shortcoming | Consequence and handling |
|---|---|---|---|
| S1 | H | **Restamping fixes labels, not samples.** | Without ASRC (P7), every element that counts samples still drifts against PTS, and #814 stays. ASRC is a precondition of the concept, not an add-on. |
| S2 | H | **Trust depends on infrastructure outside the engine.** | Without continuous, traceable time sync on both ends, a Trust-selected ingest falls back to restamp. That is today's per-hop independence, though at least deterministic per hop. The fleet's default today cannot support trust (§10.1). |
| S3 | M | **Aligning independent sources is manual.** | The design keeps an alignment once it is set; it does not discover encoder or transport delays. An operator sets O per source, and sets it again if the source's encoding changes. |
| S4 | M | **Latency follows the slowest aligned input.** | Source-natural landing adds the source's PTS−PCR lead. Aligning with a remote stream adds its transit. Content cannot be aligned without waiting for it. |
| S5 | M | **Bad source clocks still need estimation.** | A broken PCR, no PCR, or bursty delivery (vMix CBR, some software encoders, HLS) cannot be locked. The degraded fallback is a smaller arrival-based estimator, confined to ingest. |
| S6 | M | **Trust is a per-link operator decision.** | Trust where it isn't needed adds the link's transit to every local route that aligns with it. Restamp where origin alignment is needed loses that alignment. The module should show the link's measured transit and whether the stream qualifies, so the choice is informed. |
| S10 | M | **Latency comes down only at gaps.** | Because nothing is discarded for being late, content delayed by a stall or a pace step is still played: an output keeps the backlog in its buffers, and an egress keeps D_e raised, until a gap in the content or a restart of the output. The output stays that much later meanwhile, and its lateness display shows it. A catch-up is a follow-up (§15). |
| S7 | L | **Talent feedback loops tie an ingest offset to an output's lateness.** | An interpreter microphone's O must follow its monitor's lateness, by hand (§5.5). A rise in that lateness without a matching O shifts the interpretation. |
| S8 | L | **Changing content time at ingest is lossy.** | A live offset edit, a re-lock or a trust-mode switch produces a gap, or drops the overlap. Content cannot move without a discontinuity. |
| S9 | L | **The absolute PTS wraps at the same instant fleet-wide.** | It happens every 26.5 h. Any consumer with a wrap bug fails everywhere at once, not at random per device as today. |

### 12.2 Risks — what can go wrong building or running it

The last column named the question whose answer shaped the mitigation; every
one is decided (§13.1).

| # | Level | Risk | Mitigation | Owner input |
|---|---|---|---|---|
| R1 | M | **Native demux coverage.** A stream type, descriptor or PES edge case the native demux does not handle is a silent loss on that route. | Conformance fixtures from field captures (§6); a caps table that covers every stream type the consumers decode today (§11.1); an alarm on an unknown stream type instead of silent loss. | — |
| R2 | H | **The time-sync baseline.** Today it is htpdate plus SNTP, with no engine visibility and PTP off. WAN paths with asymmetric delay put NTP off by half the asymmetry, which on satellite-class links means tens of ms or more. | Ship chrony as the baseline, replacing htpdate and systemd-timesyncd; report sync state to the engine; verify every Trust selection against the declared state and the transit check (§10.4). Restamp stays the default. | — |
| R3 | H | **Scope.** The change touches every module class, both runners and the sidecars. Today's machinery (~12,000 lines) must keep working until cut-over. | Phased releases, each a cut-over proven by conformance fixtures per class built from field captures (§14). Rollback is a previous release installed from the Device Manager. | — |
| R4 | M | **PCR lock quality.** Loop tuning trades jitter rejection against tracking. A source whose own clock is NTP-slewed changes frequency by up to 500 ppm. A path whose minimum delay moves (re-route) shifts the envelope. | A two-stage estimator (min-filter, then a slow rate loop). Telemetry for offset, ppm and residual. Replay the #816, #820, #825 and #836 captures before release. | — |
| R5 | M | **ASRC cost and quality.** CPU on Pi 4/5; no ready fractional-ratio element in GStreamer (`audioresample` takes integer rates); the PipeWire capture constraints listed in #814. | One resampler per audio path (P7, decided 2026-10-12): at capture for PCM ingests, at the first decode for compressed streams, at the device for outputs, never on an internal hop. Implementation: `GstAudioResampler` with scaled rates, or speexdsp/libsamplerate. Measure per channel count on Pi 4. | — |
| R6 | M | **Clock steps after start.** Late boot sync, a chrony `makestep` at start, a manual change or a leap second leaves E stale, and trust is degraded until a re-latch. | Wait up to 30 s for sync at start; slew-only policy; step detection; automatic re-epoch (§10.3). | — |
| R7 | M | **House-clock frequency excursions.** A daemon correcting an offset by slewing changes MONOTONIC's rate, by up to the kernel's 500 ppm slew limit; at that rate, a 50 ms correction lasts 100 s. Every output and every ingest loop must follow. | Bound the slew rate: chrony `maxslewrate`; PTP is already clamped to 100 ppm. | — |
| R8 | M | **Trusting a wrong upstream.** A buggy or misconfigured engine's PTS propagates with no local correction. | Trust is opt-in per ingest. The declaration and the transit check (§10.4) run continuously and drop a stream that leaves its tolerance to restamp, with an alarm. A fallback switches at once; a return or an operator's change waits up to 30 s for a gap (§10.4). | — |
| R9 | M | **Queue memory.** Backlogs from stalls and pace steps stay in output buffers until a gap (S10), and an output that decodes slower than real time falls behind without limit. Queues must hold the largest backlog seen (5 s edge queues, ADR-0015 byte caps, Pi memory). | Queue limits with alarms; a full queue is reported as a resource fault; an output whose lateness keeps rising raises a capacity alarm. | — |
| R10 | M | **Hidden arrival, sample-count and late-drop behaviour in elements.** Examples: `interleave`, the wall-clock ducker, encoder `perfect-timestamp` tolerance, `audiomixer` thresholds, `videorate`'s grid from segment start, sinks' `max-lateness`, decoder QoS, leaky queues, aggregator timeouts. | The §11.3 list becomes an audit checklist, each item replaced or pinned by a fixture. | — |
| R11 | M | **Egress processing cost.** Every network egress now parses the TS, rewrites each PES header and inserts PCR packets, where today it forwards the bytes unchanged. That is new CPU per packet, on every egress of a Pi. | Native code that rewrites headers in place. Measure on a Pi 4 at the largest egress count and bitrate expected, in Phase 5. The per-egress PCR is decided (§13.1), so the cost stays at the egress. | — |
| R12 | M | **Behaviour change at cut-over.** Outputs that play on arrival will usually be earlier than today, where D and `playoutOffsetMs` added delay. Routes from an ingest straight to a player lose the A/V alignment D gave them, unless they pass through a muxer (R22). Operators and talent will notice both. | Each output shows its lateness (§9.5). Release notes explain which routes need a muxer. | — |
| R13 | M | **Today's timing settings are removed, not migrated.** `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs` and `subtitleDelayMs` have no equivalent. A site that relied on a manual compensation loses it at cut-over. | Accepted (decided 2026-10-12, §13.1). Each setting goes with the mechanism that used it; the new settings start at their defaults; release notes list the removed settings and the new ones (ingest offset O, its per-PID trim, Trust tolerance). | — |
| R14 | M | **More settings for operators.** The ingest offset, the per-PID trim, Trust or Restamp, the Trust tolerance, and lateness alarms are new. Wrong values give misaligned or needlessly delayed content. | Defaults that need no setting on a single engine. Lateness, lead and transit shown beside each setting (§9.5). | — |
| R15 | M | **The reason #837 was reverted is not recorded.** Phase 2 repeats its approach for the mixers and audio processing, and could repeat its problem. | Phase 2 reuses #837's result, not its mechanisms, and replays #837's verification scenario as a conformance fixture before release (decided 2026-10-12, §13.1). | — |
| R16 | M | **The current model still needs field fixes during the migration.** Each fix to a mechanism this design removes is effort spent twice. | Decided (2026-10-12, §13.1): none are made. The current model is frozen during the migration; open timing PRs and fixes are parked and triaged after it for what is still valid. | — |
| R21 | M | **The silence limit misfires.** A W too short for a bursty input declares it absent during a normal pause in its arrivals, and its frames are then discarded as stale. A W too long freezes the aligner for W when an input dies, and every output downstream gets that much later (S10). | W from each input's measured arrival rhythm, with a floor; an alarm and a counter for every absence; ingests and sparse producers signal gaps, so they are never mistaken for silent; fixtures with bursty and low-bitrate inputs. | — |
| R22 | M | **A/V offset between outputs.** Outputs play as soon as they can, so a video player and an audio output fed by one muxer differ by their decode and render times. Straight from an ingest, video can lead its audio by up to about 1 s (§8), and a video sink that drops frames to keep up leaves audio behind after a stall. | Streams that must stay in sync pass through a muxer before playout; video sinks pace to the display and never drop for lateness; the ASRC follows the clock ratio, not its buffer fill; the decode difference is accepted as not noticeable, with no trim (§8). | — |
| R17 | L | **Third-party receivers.** `PCR = H − D_e` needs D_e ≥ lateness. A large D_e can overflow a hardware decoder's buffer (bitrate × D_e). Unpaced egress makes PCR jitter visible to strict TR 101 290 checks (the ETSI guideline monitoring probes use to check transport streams). | Bound D_e per egress; optional paced egress for hardware IRDs (integrated receiver-decoders: hardware broadcast decoders). | — |
| R18 | L | **Monotonicity at ingest.** A re-lock or offset edit that emits a backward PTS would revive #824-class faults. | A per-ES monotonic guard at ingest, with fixtures. | — |
| R19 | L | **Wrap handling bugs** in our own unwrap code or in third-party consumers (S9). | Wrap fixtures; a test mode that places a wrap minutes after start. | — |
| R20 | L | **A mixed-version fleet.** | Safe by construction. Old engines' streams carry no descriptor, so new engines restamp them; new engines' streams reach old engines and are re-anchored as today. A release switches a whole box, never one module. | — |

## 13. Decisions

### 13.1 Decided by the design owner

| Date | Decision |
|---|---|
| 2026-10-11 | **The concept, P1–P6.** Each ingest restamps PTS/DTS from the house clock, locked to the source PCR. Processing keeps PTS, and aligners wait for their slowest input. Egress keeps PTS and writes a new PCR from the house clock. PTS between engines is absolute. The ingest offset is the only content-time control. |
| 2026-10-11 | **Trust is an operator selection per network ingest.** Restamp is the default, and there is no automatic mode. A trusted remote stream makes every local aligner wait for its transit, which is wrong for most live feeds from other sites. |
| 2026-10-12 | **Each network egress writes its own PCR from the emission clock,** `PCR = H(emission) − D_e` (§7). Computing the PCR once upstream and only translating it at egress was considered and rejected. |
| 2026-10-12 | **The network timescale is TAI, applied only at the network boundary** (was Q4). On the network, PTS = `H mod 2^33` with `H = MONO + E`, identical between engines for content that lands at the same instant (§4.3). Inside an engine, the bus keeps boot-based PTS (`MONO + 1 h`), so bus PTS differ between engines; a network egress and a Trust ingest convert. Running every pipeline on TAI was considered and rejected (§4.5). |
| 2026-10-12 | **Nothing after ingest is discarded for being late (P11).** There is no deadline after ingest: content leaves each node as soon as processing and alignment allow. D_e follows measured lateness. Every module measures and shows the latency it adds, and how late its output is against the house clock, in ms (§9.5). The backlog shedder, rebase and late-drop settings go. |
| 2026-10-12 | **The consumer demux is a native element that writes the formula** (§6). Stock `tsdemux` was considered and rejected in both configurations, `ignore-pcr=true` (a1) and PCR mode fed exact PCR stamps (a2); §6 gives the reasons. There is no bridge: consumers switch from `tsdemux` to the native demux in Phase 3 (§14). |
| 2026-10-12 | **Every phase is a cut-over.** No engine-wide flag, no legacy arm, no in-app rollback. Each phase deletes the mechanism it replaces in the same release. Rollback is installing a previous release from the Device Manager. The former Phase 6 (delete the anchored stamper and conditioner; supersede ADR-0005 decisions 2 and 4 and ADR-0018) is folded into Phases 2–4: each deletion goes with the phase after which nothing uses the mechanism (§14). |
| 2026-10-12 | **The image's time source is chrony (NTP)** (was Q3). It replaces htpdate and systemd-timesyncd and disciplines the clock continuously. htpdate is not kept for a boot step, because blocked outbound NTP is no longer a concern at any site. PTP stays where a site runs it (§10). |
| 2026-10-12 | **Trust is gated by a transit check, not by the kind of time discipline** (was Q12). Any continuous discipline qualifies: SNTP, chrony (NTP) or PTP. The ingest falls back to Restamp with an alarm when `arrival − (PCR + D_e)` exceeds the input's configured transport latency (the SRT latency, the RIST buffer) by more than a tolerance, 0.2 s by default and settable per input module. With an SRT latency of 2 s the bound is 2.2 s (§10.4). |
| 2026-10-12 | **One shared native TS module** (§11.5). The ingest restamp, the native demux, the egress writer and the splitter pass-through are thin users of one mpegts-core module that walks the TS, reassembles PES, reads and writes PCR and PES headers, and applies the 1 h formula with 33-bit unwrap. It is implemented once, loaded by both runners, with no Python twin. |
| 2026-10-12 | **The engine waits up to 30 s for sync at start, then starts with a warning; re-epoch is automatic** (was Q15). E is latched once the daemon reports sync and the kernel TAI offset is set; after 30 s the engine logs a warning, latches anyway and declares its egress not traceable. When sync arrives later, or a step is detected, the engine re-latches E by itself and raises an event: one flagged discontinuity on every network egress, which Trust receivers handle through the transit check (§10.3, §10.4). No operator action. |
| 2026-10-12 | **Audio is resampled once, where it first becomes PCM** (R5). At ingest for PCM captures (302M input, audio-encoder, AES67); at the first decode in the engine for a compressed stream; never again on the bus. Outputs keep the resampler to the device clock (§8). One resampler per audio path is the cost bound. |
| 2026-10-12 | **Today's timing settings fall away** (was Q9, R13). `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs` and `subtitleDelayMs` are removed with the mechanisms that used them. Nothing is migrated: the ingest offset O, its per-PID trim and the Trust tolerance start at their defaults. A site that relied on a manual compensation re-enters it as a new setting. |
| 2026-10-12 | **Phase 2 takes what was good from #837** (was Q7). #837 put the Audio Mixer and Audio Processing on the content timeline and verified it on a Pi 4: a ducker feeding a mixer beside its own sidechain, no silence-fill, the programme sample-exact. Phase 2 keeps that result: identity egress, inputs on content time, the mixer waiting for its slowest input. It does not keep #837's mechanisms, the per-demux retime, the pacer slack and the `max(mixLatencyMs, D)` budget, which this design replaces with formula demux and W. The revert's reason stays unrecorded; #837's verification scenario becomes a Phase 2 conformance fixture (R15). |
| 2026-10-12 | **The current model is frozen during the migration** (was Q2). No field fix is made to a mechanism this design removes. Open timing PRs and fixes, #830 and #836 among them, are parked and triaged after the migration for what is still valid. The stale statements in §11.6 are left until then. |
| 2026-10-12 | **Phases ship in order, 0 to 5, each a cut-over** (was Q1). Each phase deletes what it replaces (§14). Phase 5 ships once a route needs origin alignment and Phase 0's time sync is deployed in the field. The release grouping was revised the same day: the last rows of this table. |
| 2026-10-12 | **PCR-locked sources land source-natural** (was Q5). Content time is the source's own schedule mapped through the virtual STC (§5.1), so it is the same on every engine and the encoder's lead never enters the timeline. Arrival landing is not a mode. O defaults to 0; the ingest always shows its measured lead, and a negative O no larger than the minimum lead recovers latency on aligned routes (§5.5). Direct routes are unaffected, because outputs play on arrival (§8). |
| 2026-10-12 | **A per-PID trim at the ingest, bounded to ±2 s** (was Q6). The ingest lists the PIDs it detects from the PMT, with their type; each can carry a signed trim, default 0, on top of the program-wide O, so a PID's effective shift is O plus its trim. It lives at the ingest only. It corrects a source's fixed A/V error, and it is wide enough to delay a programme's audio to match an external path whose latency varies, such as ClarioCast. The same live-edit rule as O applies per PID (§5.5). |
| 2026-10-12 | **The video player renders video only** (was Q18). It drops any audio PID of the program at its demux and plays as fast as it can; it never aligns audio and video itself. Lipsync for a program is made upstream by a muxer (§8). Modules stay as simple as possible. |
| 2026-10-12 | **No offset on a trusted stream** (was Q13). Neither the ingest offset nor the per-PID trim applies while an ingest is Trust-selected: trust means untouched. The controls stay visible but disabled, with the reason shown beside them, so an operator knows to switch the ingest to Restamp rather than suspect a fault (§10.4). |
| 2026-10-12 | **Return to Trust is automatic** (was Q14). After a fallback to Restamp, the ingest returns to Trust by itself once the stream qualifies again, one gap or dropped overlap each way, with an event. No operator action (§10.4). |
| 2026-10-12 | **Paced egress is deferred** (was Q16). TS egress stays unpaced in this version. Paced egress is added per egress when a hardware IRD or a strict TR 101 290 probe is a real receiver (§7, §15). |
| 2026-10-12 | **Talent loops are operator-set** (was Q11). The microphone ingest's O is set by hand from the monitor output's displayed lateness (§5.5, §9.5); there is no automatic tie of an ingest offset to an output. A change is applied at a pause in the talent's speech. |
| 2026-10-12 | **No output-side A/V trim.** The decode and render difference between a video player and an audio output fed by one muxer is tens of milliseconds, not noticeable by eye, and is accepted. There is no per-leg or per-output trim, and outputs show lateness, not an A/V offset (§8, §9.5). |
| 2026-10-12 | **No catch-up (was Q17).** An output's backlog and D_e come down only at a gap in the content, where nothing is lost. A catch-up is a follow-up (§15). |
| 2026-10-12 | **Silent inputs, the aligner's pace, and D_e (was Q8).** An aligner does not wait for an input that has gone silent: after a short silence limit W (a few hundred ms, not 5 s), it continues with its other inputs. When the input returns, its frames for time already emitted are discarded, and it rejoins at the current position. A late input that is still delivering is still waited for (P11). The aligner's pace goes up when a slower input joins (one brief gap, no restart), holds while an input is absent, comes down only when an operator removes the slow input, and starts at what its configured inputs will need. §6 sets out how. D_e follows the lateness at the egress from a starting margin; each raise is a flagged PCR discontinuity, with an alarm above a threshold. |
| 2026-10-12 | **Physical outputs play as soon as they can (was Q10).** Audio and video outputs decode and play content on arrival, with no presentation delay and no presentation groups. Streams that must be seen and heard together are aligned upstream, by passing them through a muxer. The remaining A/V offset, between a video player and an audio output, is the difference in decode and render time, accepted as not noticeable, with no trim (§8). |
| 2026-10-12 | **Phases 1–4 ship as one release** (revises Q1; the implementation plan's OQ-13). Phase 0 ships alone first; Phases 1, 2, 3 and 4 are developed in that order and ship together, each still deleting what it replaces inside that release; Phase 5 ships after. There is therefore no interim release in which outputs present at `stamp + D` on source-natural stamps (§14). |
| 2026-10-12 | **Lateness alarms are deferred.** Every module shows its lateness and added latency with a label; alarms at operator-set thresholds, the per-module lateness alarm and the output capacity alarm among them, come in a later release once the numbers are known (§9.5, §8). |
| 2026-10-12 | **Trust switches: a fallback at once, a return or an operator's change at a gap.** A fallback to Restamp is taken as soon as the transit check fails, the switch being itself the gap; a return to Trust and an operator's mode change wait up to 30 s for a natural gap and are then taken at once; every switch raises an event (§10.4). |
| 2026-10-12 | **The implementation plan's remaining questions were delegated to the orchestrator.** The owner answered the plan's OQ-1 to OQ-10 and OQ-13 and overruled its C-1; the rest (OQ-11, OQ-12, OQ-14 to OQ-40 and the demux stand-in gap) were decided by the orchestrator under that delegation and are recorded in the plan's register (`docs/house-clock-timing-implementation-plan.md`, chapter 15). Two of them corrected this document's text: the arrival definition (§5.1) and the straddle tie-break (§5.2). |

### 13.2 Questions put to the design owner

Ordered by when the migration (§14) needed the answer. Every question is
decided; each row keeps the question and records the decision with its date,
and §13.1 carries the decisions themselves.

| # | Question | Recommendation | Needed before |
|---|---|---|---|
| Q1 | Release scope and order: which phases ship in which release? | **Decided on 2026-10-12:** Phases 0–5 in that development order, each a cut-over that deletes what it replaces. Phase 0 ships alone; Phases 1–4 ship as one release; Phase 5 after, once a route needs origin alignment and Phase 0's time sync is deployed (§13.1, §14). | — |
| Q2 | What is still fixed in the current model while the migration runs? Open examples: #830, #836, and the stale statements in §11.6. | **Decided on 2026-10-12:** nothing. The current model is frozen during the migration; open PRs and fixes, #830 and #836 among them, are parked and revisited afterwards for what is still valid; the §11.6 statements are left until then (§13.1). | — |
| Q3 | The image's time source. Why was htpdate chosen? | **Decided on 2026-10-12:** chrony replaces htpdate and systemd-timesyncd; blocked outbound NTP is no longer a concern, so htpdate goes (§13.1). | — |
| Q4 | The network timescale, and where E applies | **Decided on 2026-10-12** as recommended: TAI, with E applied only at the network boundary (§13.1). | — |
| Q5 | The default landing for PCR-locked sources | **Decided on 2026-10-12** as recommended: source-natural (§5.1). Arrival landing is not a mode. O defaults to 0 and the measured lead is always shown, so an operator can set a negative O no larger than the minimum lead (§13.1). | — |
| Q6 | A per-PID trim at ingest | **Decided on 2026-10-12:** offered, per PID at the ingest, bounded to ±2 s rather than ±500 ms, default 0, on top of O. The wider bound covers delaying audio to match an external path such as ClarioCast (§13.1). | — |
| Q7 | Why was #837 reverted? | **Decided on 2026-10-12:** Phase 2 takes what was good from #837, its result and its verification scenario, not its mechanisms (§13.1). | — |
| Q8 | How W and D_e are set, given that neither may drop content | **Decided on 2026-10-12**: W is a short silence limit, not 5 s; a silent input is left out and rejoins at the current position, its stale frames discarded. D_e as recommended (§13.1). | — |
| Q9 | What becomes of today's timing settings | **Decided on 2026-10-12:** all of today's timing settings fall away with their mechanisms: `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs`, `subtitleDelayMs`. Nothing is migrated; the new settings start at their defaults (§13.1). | — |
| Q10 | How physical outputs time their playout | **Decided on 2026-10-12**: they play as soon as they can, with no presentation delay or groups; streams that must be aligned pass through a muxer first (§13.1). | — |
| Q11 | Talent loops (§5.5) | **Decided on 2026-10-12:** operator-set only. The operator reads the monitor output's lateness from the display and sets O on the microphone ingest by hand; there is no automatic tie to an output (§13.1). | — |
| Q17 | Bringing latency back down after a stall (S10) | **Decided on 2026-10-12**: no catch-up; an output's backlog comes down only at gaps. A catch-up is a follow-up (§15). | — |
| Q18 | Should a player that renders both audio and video of one program align them itself? | **Decided on 2026-10-12:** no. The video player renders video only and drops any audio PID, so it plays as fast as it can. A program that must stay in lipsync passes through a muxer first (§13.1). | — |
| Q12 | The minimum time discipline for Trust | **Decided on 2026-10-12:** SNTP, chrony or PTP. The transit check of §10.4, with a per-input tolerance of 0.2 s above the transport latency by default, is the gate (§13.1). | — |
| Q13 | An ingest offset on a trusted stream | **Decided on 2026-10-12:** not allowed; trust means untouched. The controls stay visible but disabled, and the reason is shown next to them so it reads as a rule, not a fault: switch the ingest to Restamp to set an offset (§13.1). | — |
| Q14 | Returning to Trust after a fallback to Restamp | **Decided on 2026-10-12** as recommended: the ingest returns to Trust by itself once the stream qualifies again, one gap or dropped overlap each way (§13.1). | — |
| Q15 | The start-up wait for sync, and re-epoch (§10.3) | **Decided on 2026-10-12:** wait up to 30 s, then log a warning and start; re-epoch is automatic (§13.1). | — |
| Q16 | Paced egress for hardware receivers (§7) | **Decided on 2026-10-12** as recommended: not in this version. Add it per egress when a hardware IRD or a strict TR 101 290 probe is a real receiver (§13.1, §15). | — |

### 13.3 Left to the engineer

These are engineering choices within the design. Record each in the ADR, and
raise with the design owner any that would change what an operator sees.

| Choice | Guidance | Needed before |
|---|---|---|
| Native demux caps table and fixture set (§6) | Cover every stream type the consumers decode today (§11.1); fixtures as listed in §6 (R1). | Phase 3 |
| Silence watchdog (§6) | Per aligner input: learn the arrival rhythm, declare the input absent after W, and fill it with gaps so the aggregator moves on, keeping the aligner's pace. | Phase 2 |
| Virtual STC loop constants and PCR validation bounds (§5.1, §5.3) | Set from replayed field captures (R4). | Phase 1 |
| ASRC implementation (P7) | `GstAudioResampler` with scaled rates, or speexdsp/libsamplerate. Measure on a Pi 4 (R5). | Phase 1 |
| Shared TS module (§11.5) | One native module in mpegts-core; both runners load it; no Python twin. The ingest restamp is its first user, the demux its second (Phase 3), the egress writer its third (Phase 5). | Phase 1 |
| Descriptor format (§7) | A registration descriptor in the PMT carrying the fields §7 lists. | Phase 5 |
| Conformance fixtures per module class (§14) | Built from field captures, including the cases today's code handles specially. | Each phase |

## 14. Migration outline

Every phase is a cut-over: it replaces a mechanism and deletes it in the same
release. There is no engine flag, no legacy arm and no in-app rollback.
Rollback is installing a previous release from the Device Manager. Each phase
is proven by replaying field captures through both runners before release.

Phases are developed in order, 0 to 5, and ship as three releases (decided,
§13.1): Phase 0 alone; Phases 1, 2, 3 and 4 together, each still deleting what
it replaces inside that release; Phase 5 after. Nothing in the current model
is fixed meanwhile (§13.1). The last column listed the questions a phase
needed answered before it started; all are decided.

| Phase | Delivers | Makes possible | Owner input first |
|---|---|---|---|
| 0 | Time-sync status in the engine; chrony in the image, htpdate and systemd-timesyncd removed, kernel TAI offset set (§10.2); epoch E with step detection; lateness and added latency shown on every module (§9.5) | Measuring everything that follows | — |
| 1 | Ingest restamp (virtual STC) writing house time into the bytes; ingests signal gaps; capture producers on identity egress; video-encoder on house time; ASRC at captures | Every bus edge carries house time in-band. Existing consumers keep working, because their K becomes constant. | — |
| 2 | Splitter pass-through; mixers and audio processing on identity egress (as #837); aligners wait for data or a gap and never drop; muxer keeps sparse-PID PTS; ducking in the pipeline; the anchored stamper, the conditioner and their twins deleted | P3 on every internal hop; ADR-0005 decisions 2 and 4 and ADR-0018 superseded | — |
| 3 | Native formula demux on every consumer, and `tsdemux` leaves the bus path; ASRC at decode and at outputs; retime, branch alignment and K learning deleted | P9 on every consumer: nothing downstream re-estimates time | — |
| 4 | Outputs that play as soon as they can: unsynchronised sinks, ASRC at the measured clock ratio, video paced to the display without dropping; late-drop settings off in sinks, decoders and queues; the route-head walk, shedder and rebase deleted | P11: nothing is discarded for lateness | — |
| 5 | Egress writer (TAI translation, PCR, descriptor); operator-selected Trust at network ingests, verified by the descriptor and the transit check | Inter-engine lipsync by construction, where Trust is selected | — |

## 15. Follow-ups: catch-up and paced egress

Not part of this version. The design owner decided on 2026-10-12 that an
output's backlog comes down only at a gap (§13.1). This section records how a
catch-up would work, so it can be added later without redesign. It needs ASRC
at the outputs (Phase 3), outputs that play as soon as they can (Phase 4) and
the lateness display (§9.5).

A catch-up drains an output's backlog while content keeps playing. A real-time
output can lose time in only two ways: skip content (a step) or play slightly
fast (a slew), the same choice a time daemon makes for a clock. Only the slew
avoids discarding audio, so only the slew fits P11.

- **Slew: play slightly fast.** Where enabled per output, the output plays at
  most about 0.5–1% fast until its backlog is back on target; 1 s of excess
  clears in 200 s at 0.5%.
  - Audio speeds up through the output's ASRC (P7), which raises its pitch by
    8.6 cents (hundredths of a semitone) at 0.5%. Music can use a time-stretch
    instead, such as GStreamer's `scaletempo`, to keep the pitch.
  - Video drops one extra frame every few seconds: every 4 s at 0.5% and
    50 fps.
  - An output's audio and video catch up together, and so must separate
    outputs fed from one muxer, so lipsync holds.
- **Pause shortening,** for speech-only outputs such as interpretation
  channels. A level or voice detector trims long pauses, for example halving
  every pause over 300 ms. It catches up in seconds and removes only silence.
- **Skip,** only when an operator starts it. It is instant but discards
  content, so it reports how much.

**Control loop.** The target is the output's normal lateness: its recent
lowest, plus a margin for jitter. A catch-up starts only after the backlog has
stayed above the target for a while (e.g. 60 s), so a recurring stall doesn't
make it pump, and it stops as soon as lateness rises again. The output shows
its progress, for example "catching up: 1200 → 300 ms, 3 min left". This is
the one case where the output's ASRC follows its buffer fill rather than only
the clock ratio (§8).

**Where it cannot work.**
- **Network egress.** D_e comes down only at a gap (§7): receivers follow our
  PCR, which MPEG limits to ±30 ppm off nominal.
- **Talent loops.** A monitor output whose lateness an operator used to set a
  microphone ingest's O (§5.5) is not slewed, because slewing would shift the
  interpretation against the programme.

**Risks.** Playing fast raises pitch; a time-stretch can colour music; pause
shortening can clip quiet speech; video drops a frame every few seconds while
it catches up. Mitigations: opt-in per output, a rate cap, time-stretch for
music, a conservative pause detector, fixtures and listening tests.

**Paced egress for hardware receivers.** Not in this version (decided
2026-10-12, §13.1). A paced egress writes each packet at the time its PCR
implies, so the PCR jitter a receiver sees is the pacer's, not the egress's
write jitter (R17). It is added per egress, on demand, when a hardware IRD or a
strict TR 101 290 probe is a real receiver.

## Appendix A — Primer and glossary

### A.1 Timing in an MPEG transport stream, briefly

- **Packets and streams.** A TS (transport stream) is a sequence of 188-byte
  packets. Each packet carries a PID (packet identifier) that names the stream it
  belongs to: a video, an audio, subtitles or a table. Two tables list a
  program's streams and their PIDs: the PAT (program association table) and the
  PMT (program map table).
- **Frames and their timestamps.** Each coded frame, called an AU (access unit),
  travels in a PES (packetized elementary stream) packet. Its header carries up to
  two timestamps, counted on a 90 kHz clock:
  - the DTS (decoding time stamp): when the decoder should decode the frame;
  - the PTS (presentation time stamp): when the frame should be shown or heard.

  The two differ only for B-frames, which are sent ahead of frames they are
  displayed after.
- **The clock that gives timestamps meaning.** Timestamps alone don't tell a
  receiver what time it is now. So the sender also writes PCR (program clock
  reference) values into the stream, at least every 100 ms: samples of its 27 MHz
  system clock. A decoder locks its STC (system time clock) to those PCRs. It
  decodes each frame when the STC reaches its DTS, and shows it when the STC
  reaches its PTS.
- **The PTS−PCR lead.** How far a frame's PTS is ahead of the PCR when the frame
  arrives is how long the decoder holds it. The encoder chooses this lead,
  typically 0.1–1.5 s.
- **The wrap.** The timestamp counters are 33 bits wide, so they roll over to
  zero every 26.5 hours.

This design keeps that model. What changes is that each stream is restamped once,
at ingest, onto the engine's house clock, so every node inside the engine reads
the same time (§1).

### A.2 Abbreviations

| Abbreviation | Meaning |
|---|---|
| A/V | Audio/video |
| AAC | Advanced Audio Coding, a compressed audio format |
| ADC / DAC | Analog-to-digital / digital-to-analog converter: a sound device's input and output. Each runs on its own crystal clock. |
| ADR | Architecture decision record, in `docs/adr/` |
| AES67 | An Audio Engineering Society standard for professional audio over IP networks, timed by PTP |
| ALSA | Advanced Linux Sound Architecture, the Linux audio driver layer |
| ASRC | Asynchronous sample-rate conversion: resampling by a continuously adjusted ratio, so that audio from one clock can be played or mixed on another without clicks |
| AU | Access unit: one coded video frame or audio frame |
| CBR | Constant bit rate |
| CPU | Central processing unit |
| DISCONT | GStreamer's buffer flag meaning "data is missing before this buffer" |
| DTS | Decoding time stamp (A.1) |
| DVB | Digital Video Broadcasting, the European broadcast standards family |
| EQ | Equaliser |
| ES | Elementary stream: one audio, video or data stream inside a TS |
| fps | Frames per second |
| GNSS | Global navigation satellite system (GPS, Galileo and others), a source of accurate time |
| GPS | Global Positioning System |
| HLS | HTTP Live Streaming, which delivers media as a series of downloaded segments |
| HTTP | Hypertext Transfer Protocol, the protocol of the web |
| IEEE 1588 | The standard that defines PTP |
| IP | Internet Protocol |
| IRD | Integrated receiver-decoder: a hardware broadcast decoder |
| ISO/IEC 13818-1 | The MPEG-2 Systems standard, which defines the TS |
| ITU-R BT.1359 | The International Telecommunication Union's broadcast recommendation on relative audio/video timing: audio leading video is noticeable from about 45 ms |
| KLV | Key-length-value, a metadata encoding; here it carries subtitle cues |
| LAN / WAN | Local-area / wide-area network |
| MONO | Short for a `CLOCK_MONOTONIC` reading |
| MPEG, MPEG-TS | Moving Picture Experts Group; MPEG transport stream (A.1) |
| NTP / SNTP | Network Time Protocol / Simple NTP: clock synchronisation over a network, typically to within milliseconds |
| PAT / PMT | Program association table / program map table: the tables that list a TS's programs and their streams (A.1) |
| PCM | Pulse-code modulation: uncompressed audio samples |
| PCR | Program clock reference (A.1) |
| PES | Packetized elementary stream (A.1) |
| PID | Packet identifier (A.1) |
| ppm / ppb | Parts per million / per billion. A clock 1 ppm fast gains 86 ms a day. |
| PTP | Precision Time Protocol (IEEE 1588): clock synchronisation on a LAN, to within microseconds |
| PTS | Presentation time stamp (A.1) |
| QoS | Quality of service: here, GStreamer's feedback from sinks that makes decoders skip frames when output runs late |
| RIST | Reliable Internet Stream Transport: carries a TS over the internet, with retransmission of lost packets |
| RTP | Real-time Transport Protocol |
| SMPTE ST 302M ("302M") | A Society of Motion Picture and Television Engineers standard for carrying uncompressed PCM audio in a TS; the engine's internal PCM bus format |
| SRT | Secure Reliable Transport: carries a TS over the internet, with retransmission of lost packets |
| STC | System time clock: a decoder's running copy of the sender's clock (A.1) |
| TAI | International Atomic Time (Temps Atomique International): a continuous timescale with no leap seconds, and the one PTP uses |
| TEMI | Timeline and External Media Information: an MPEG-TS extension that can carry full PTP or NTP timestamps |
| TR 101 290 | The ETSI (European Telecommunications Standards Institute) measurement guideline for DVB transport streams, used by monitoring probes |
| UDP | User Datagram Protocol |
| UTC | Coordinated Universal Time: civil time, which is TAI minus the leap seconds (37 s in 2026) |
| V4L2 | Video4Linux2, the Linux video-capture interface |
| VU | Volume unit: a level meter |
| P1–P11, S1–S10, R1–R22, Q1–Q18 | This document's principles (§3), shortcomings (§12.1), risks (§12.2) and questions for the design owner (§13.2) |
| #NNN | An issue or pull request in the media-router GitHub repository |

### A.3 Terms

| Term | Meaning |
|---|---|
| aggregator | A GStreamer element that combines several inputs on one timeline (mux, mixer, compositor) and waits a set latency for late inputs |
| bus | The engine's internal transport between modules: TS carried over Unix sockets (`unixfdsink` / `unixfdsrc`) |
| catch-up | Draining an output's backlog without waiting for a gap, by playing slightly fast or by skipping content. Not in this version; §15 records it as a follow-up. |
| content time, lateness, added latency, O, W, D_e, E, H | See §4.6 |
| demux / mux | Demultiplexer / multiplexer: splits a TS into its streams, or combines streams into one TS |
| descriptor | A small tagged record inside a TS table such as the PMT. Receivers skip tags they don't know. |
| ducker | Audio processing that lowers one signal (the programme) while another (the key, e.g. an interpreter) is active |
| egress | A module that sends a stream out of the engine (RIST, SRT, UDP or AES67 output) |
| epoch | The zero point of a timescale |
| gap | A stretch of time with no content. An ingest or a sparse producer signals it with a GStreamer gap event, so elements waiting for that stream can move on. |
| genlock | Locking a video output's timing to an external reference |
| house clock, house time | The engine's single clock, and readings of it (§4) |
| ingest | A module that brings a stream into the engine: a network input, a capture, a file or an HLS player |
| lipsync | Audio and video staying in step |
| lower envelope, min-filter | Tracking only the earliest arrivals. Network delay can only add time, so the earliest arrivals show the true clock. |
| pipeline, element, sink | GStreamer terms: a chain of processing elements; one stage in it; a stage that consumes data, e.g. plays it |
| PipeWire | The Linux audio server between the engine and the sound hardware |
| restamp | Replace a stream's timestamps with house time at ingest (§5) |
| running time | GStreamer's pipeline time, which schedules playback; here it equals the house clock |
| slew, step | Correcting a clock gradually by adjusting its rate; correcting it by jumping it |
| trust | Keep another engine's timestamps as received (§10.4) |
| ts-offset | A GStreamer sink setting that delays rendering by a fixed time |
| virtual STC | The ingest's estimate of a source's clock, locked to its PCR (§5.1) |
| vMix | A commercial software production mixer and encoder |
| wrap | A 33-bit timestamp counter rolling over to zero, every 26.5 h |
