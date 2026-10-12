# House-Clock Timing — Conceptual Design

| Field        | Value |
|--------------|-------|
| Document     | DES-MR-TIMING |
| Version      | 0.3 — for implementation planning |
| Date         | 2026-10-12 |
| Organisation | BCC South Africa |
| Design owner | Ivan Slabbert. Decides the open questions in §13.2. |
| Related      | ADR-0005 (architecture decision record: time-sync backend), ADR-0008, ADR-0011, ADR-0016, ADR-0017, ADR-0018 |
| Status       | The concept is decided (§13.1) and handed to engineering for implementation planning. Sixteen questions are still open (§13.2). Once they are settled, an ADR records the design and supersedes ADR-0005 decisions 2 and 4 (with their amendments) and ADR-0018. |
| Baseline     | Verified against the code at `2bbd57e7` (v2.0) and the GStreamer 1.28 transport-stream demuxer and muxer sources (`tsdemux`, `mpegtsmux`) |

> **New to MPEG-TS?** Appendix A has a one-minute primer on how timing works
> in a transport stream, and a glossary. Abbreviations are also spelled out in
> brackets where they first appear.

> **For the implementing engineer.**
> - §13.1 lists what the design owner has decided. Don't reopen these without
>   the owner.
> - **Needs owner input (Qn)** marks a point the design owner still has to
>   decide. §13.2 lists all sixteen questions, each with a recommendation and
>   the migration phase it blocks. Work that doesn't depend on an open
>   question can go ahead.
> - §13.3 lists the choices left to the engineer. Record them in the ADR.
> - Risks are in §12. The text cites them (R1–R20) where they arise.

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

The ingest offset is the only adjustment of content time anywhere in the system.

This replaces the current model. Today the TS bytes carry the source's
timeline, and house time travels beside them on the buffers of the engine's
internal bus (the transport between modules). Every hop re-estimates the
relation between the two (§2).

**Assessment.** The concept holds against the code. Every bus module fits one of
four roles (§11), and most of the per-hop timing machinery becomes unnecessary.
Verification found six refinements, and they are part of this design:

1. **House time on the network is absolute.** It is the TAI timescale, derived
   from the monotonic house clock by an epoch offset latched once. The clock that
   schedules pipelines does not change (§4).
2. **One clock lock per program at ingest.** An ingest locks one "virtual STC"
   (system time clock: a decoder's running copy of the sender's clock) per
   program to the source PCR. Sources whose PCR cannot be trusted fall back
   explicitly, and the fallback raises an alarm (§5).
3. **Audio is rate-matched at every clock boundary.** Restamping fixes the
   labels, not the sample counts (§5, §8).
4. **Every latency has an owner.** An aligner owns its window W, an output owns
   its presentation delay D, and a network egress owns its egress delay D_e
   (all defined in §4.6). Lateness is measured everywhere (§9).
5. **Trust between engines is an operator choice, and it is verified.** It is
   never automatic, because a trusted remote stream makes every local aligner
   wait for its transit. A Trust selection is checked against the stream's
   in-band declaration and its PCR (§10).
6. **Every consumer demuxes by formula.** PES PTS maps to running time by a
   fixed function, never by estimation (§6).

The main risks are:
- whether GStreamer's demuxer can be made to behave deterministically;
- the fleet's time-sync baseline, which cannot support trust today;
- the size of the change, made while the current model still needs field
  fixes;
- sources whose clocks are bad;
- the rate-matching work;
- higher latency on some routes, and today's timing settings, which don't
  carry over one-to-one.

They are covered in §12. Sixteen questions still need the design owner's
decision. §13.2 lists them in the order the migration phases need them.

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

Seven root causes recur:

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

**What it costs.** The app holds about 12,000 lines of timing-specific source
and 11,600 lines of tests. That is about a third of each pipeline runner: roughly
1,600 of the Python runner's 4,741 lines and 2,400 of the native runner's 6,665.
ADR-0005 alone has grown to 1,400 lines. Almost all of it exists to estimate,
defend or repair the relation between the two timelines.

## 3. The concept as principles

Principles P1–P6 state the concept. P7–P10 are refinements this design adds so
that P1–P6 hold in practice.

| # | Principle |
|---|-----------|
| P1 | **One clock per engine.** Every timestamp inside an engine is a reading of its house clock. |
| P2 | **Stamp once, at ingest, in the bytes.** An ingest rewrites each PES PTS/DTS (and the PCR) to house time. The source PCR serves only to measure the source clock against the house clock. Nothing downstream re-estimates. |
| P3 | **Processing never moves PTS.** Aligners (mux, mixer, compositor) align by PTS and wait for the slowest input. Time spent shows as lateness, never as a change of timeline. |
| P4 | **Content time is adjusted only at ingest.** The ingest offset, positive or negative, is the only content-time control in the system. |
| P5 | **Egress keeps PTS and writes a new PCR from the house clock.** |
| P6 | **An ingest trusts another engine's PTS only when the operator selects it and the stream qualifies.** Qualifying means both house clocks are disciplined to one reference, and a descriptor in the stream's PMT declares house time and the sender's sync state (§7, §10.4). By default, and whenever a stream does not qualify, the ingest restamps. |
| P7 | **Audio is rate-matched at every clock-domain boundary:** at capture, at the first decode of a foreign-clocked stream, and at the output device. On the bus, sample count and PTS agree. |
| P8 | **Latency has owners.** An aligner owns its window W, an output its presentation delay D, a network egress its egress delay D_e. Each is sized from measured lateness, never inherited through the graph. |
| P9 | **Demux by formula.** A consumer's running time is a fixed function of the in-band PES PTS. |
| P10 | **House time on the network is TAI.** It is derived from the monotonic house clock by an epoch offset latched once. |

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
- `E = CLOCK_TAI − CLOCK_MONOTONIC`, measured once when the engine starts
  (§10.3). `CLOCK_TAI` is Linux's TAI clock.

Slewing moves MONO and TAI together, so E stays correct while the time daemon
slews. Only a clock *step* invalidates E. A step is a discrete event, and the
engine can detect it.

This is the same measurement `aes67-output` already makes for its RTP
(Real-time Transport Protocol) `timestamp-offset` (`aes67-core/py/aes67_clock.py`),
raised from one module to the whole engine.

**Needs owner input (Q4).** TAI as the network timescale, with E applied only at
the network boundary (§4.5), is the recommendation until the design owner
confirms it.

### 4.3 Representations

| Where | PTS / DTS (90 kHz, 33 bit) | PCR (27 MHz) | GstBuffer PTS/DTS |
|---|---|---|---|
| **Bus** (inside one engine) | `(MONO + 1 h) mod 2^33`. This is exactly what `mpegtsmux` writes from running time with `base_time = 0` (`TS_MUX_CLOCK_BASE`); the ingest writes the same. | House-locked. `mpegtsmux` writes its PCR stream's DTS − 125 ms; the ingest maps the source PCR. | House time. Used only for lateness, and as the reference for the consumer demux if §6 mechanism (a) is chosen; that mechanism fixes its exact definition. |
| **Network** (between engines and to third parties) | `H mod 2^33`, i.e. `TAI × 90 kHz mod 2^33` | `H(emission) − D_e` | — |

The two representations differ by a constant 33-bit addition, `E − 1 h`. It is
applied at network egress and at a trusted network ingest, and nowhere else.

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
| ingest offset O | The per-ingest shift of content time (P4). |
| W | Alignment window: the aggregator `latency` of a mux, mixer or compositor. |
| D | Presentation delay. An output renders at `PTS + D`. |
| D_e | Egress delay. It sets `PTS − PCR` for third-party receivers. |
| E | The engine's epoch offset, TAI − MONOTONIC. |
| H | House time on the network timescale, `MONO + E`. |

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
- **Arrival** is the timestamp the network source element assigns on receipt
  (`udpsrc`, `srtsrc`, `mrristsrc` with `do-timestamp`). It is *not* the time the
  buffer reaches the stamping element after the module's queues, which is what
  today's stamper reads.

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
- **Drift is tracked from the PCR.** PCRs arrive at least ten times a second, so
  drift is tracked in seconds, not tens of minutes (#812).
- **Content lands on the source's own presentation schedule, as seen here:**
  arrival plus the source's PTS−PCR lead. A compliant source therefore never
  delivers an AU (access unit: one coded frame) after its house PTS, except for
  network jitter above the minimum delay. This *source-natural* landing is the
  recommended default; it **needs owner input (Q5)**. See also R12.

### 5.2 Source discontinuities

A source restart, PCR discontinuity or rewind re-locks the virtual STC. House
time does not jump, so downstream sees a *gap*: no content for the length of the
outage.

- **Overlap.** If new content would land before content already emitted, the
  ingest drops the overlap, so PTS stays monotonic per elementary stream.
- **A PES that straddles a re-lock** is mapped by whichever mapping's STC range
  contains it.
- **No timeline step ever leaves an ingest.**
- **A sending engine on this design causes no re-lock when it restarts.** Its PCR
  is house time, which continues across the restart; only the delivery has a gap.

### 5.3 Sources whose PCR cannot be used

The ingest validates the PCR continuously:
- its rate against arrival stays within a bound;
- it does not freeze or leap without a discontinuity flag;
- the PTS−PCR lead stays within a sane range;
- PCRs arrive at least every 100 ms.

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

One offset O per ingest, applied to its whole program. An optional per-PID trim
covers sources with a fixed internal A/V (audio/video) error; whether to offer it
**needs owner input (Q6)**. No other node has an offset.

- **Positive O** lands content later. Aligners hold this stream until the others
  catch up, and its latency grows by O.
- **Negative O** lands content earlier, so it arrives |O| *late* against its own
  PTS. Every aligner it meets holds its other inputs by |O|, and every output
  that presents it needs `D ≥ |O|`.
- **Live edits never move PTS backwards on the bus.** A positive change inserts a
  gap; a negative change drops the content it overlaps.
- **It is content time, not presentation delay.** O replaces neither D nor the
  legacy per-module `playoutOffsetMs` (#830 removes that). What becomes of
  today's timing settings at cut-over **needs owner input (Q9)**.
- **The ingest reports its measured lead** (minimum, median and maximum of
  PTS − arrival). A negative O no larger than the minimum lead recovers latency
  without making any AU late.
- **No ingest has this control today.** The closest were the mpegts-muxer's
  per-input offset (removed 2026-09-28, ADR-0017) and the per-sink `lipSyncMs`
  trims.

**Talent feedback loops.** An interpreter or commentator speaks in reaction to
what they hear at `PTS + D_monitor`. Their microphone is captured in house time,
so the voice lands `D_monitor + reaction` after the content it answers.

- With `O = −D_monitor` on the microphone ingest, the voice lands one reaction
  time after the content. The aligner holds the programme by `D_monitor` to wait
  for it.
- This is how a translation mix keeps the interpretation lag at the
  interpreter's own reaction time, rather than adding the monitor delay to it.
- The offset has to follow the monitor's D. How it does so **needs owner input
  (Q11)**.

## 6. Processing — where time is kept

1. **PTS in = PTS out.** A node may add latency but never moves content time. The
   only exceptions are new timestamps derived deterministically from input PTS:
   - deinterlaced field times;
   - frame-rate conversion onto a house-time grid;
   - an aggregator's output grid.
2. **Demux by formula (P9).** Running time is `unwrap(PES PTS) − 1 h`, and DTS
   likewise. There is no PCR skew estimation, no payload join and no learned K.
   - **Candidate (a), stock `tsdemux`, in one of two configurations:**
     - *(a1) `ignore-pcr=true`.* In 1.28 this maps every PES as `base + (PTS −
       first PTS)`, where `base` is the input buffer's DTS-or-PTS when the first
       PES was parsed (`mpegtspacketizer.c`, `pts_to_ts` with `pcr_pid =
       0x1fff`). tsdemux already switches itself to this path after 500 ms
       without a PCR.
     - *(a2) PCR mode, with every bus buffer that carries a PCR stamped with that
       PCR's house time.* tsdemux's skew observations are then exact, and its
       mapping should reduce to identity.

     Both depend on internal details that fixtures must pin before anything
     relies on either:
     - which PES counts as "first" in a buffer that carries several PIDs;
     - PTS against DTS for B-frames (frames sent ahead of frames they are
       displayed after);
     - the 2 s segment shift;
     - the 5 s fake-PCR advance;
     - several PCRs in one access-unit buffer.
   - **Candidate (b): a native PES demux that writes the formula.** The
     mpegts-core parsers it needs already exist. Adopt it if (a) cannot be made
     exact.
   - **Choosing.** The engineer chooses, against the fixtures, before Phase 3
     (§13.3). This is the design's largest technical risk (R1).
3. **Codecs keep frame PTS.** Audio encoders that derive timestamps from sample
   counts (`perfect-timestamp`) are correct only on house-rate PCM (P7).
4. **Aligners** (`mpegtsmux`, `audiomixer`, a future compositor) hold every input
   until the slowest has delivered data up to time T, then emit T.
   - In GStreamer terms the aggregator's latency is W. W is at least the largest
     input lateness plus a margin. How W is sized **needs owner input (Q8)**;
     risk R9.
   - A dark input becomes silence (mixer) or is left out (mux) once W expires.
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
    buffer, which keeps `PTS − PCR` positive for third-party decoders. How D_e
    is sized **needs owner input (Q8)**.
  - Changing D_e is a PCR discontinuity, flagged with `discontinuity_indicator`
    (the TS flag that tells receivers the PCR jumped).
  - The PCR's frequency is exactly the house clock's.
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
  Whether to offer paced egress for hardware receivers **needs owner input
  (Q16)**.
- **AES67.** Under PTP discipline, RTP time is already TAI × rate. Under this
  design the AES67 egress takes its PCM from the formula demux, which replaces
  its unaligned `tsdemux`.

## 8. Presentation — where time is spent

- **When an output renders.** At `PTS + D`. The sink's `ts-offset` (its fixed
  render delay) is D, minus the pipeline latency the sink adds, plus a device
  trim.
- **Who owns D.** The output, or a *presentation group*: the video and audio legs
  seen and heard together share one D. There is one engine-wide default. D is
  never resolved through the graph. How groups are formed **needs owner input
  (Q10)**.
- **Queues.** A leg's queues must hold what the leg is told to hold: the largest
  earliness plus D plus bursts. Queue sizing follows D (#830, R9).
- **Late content.** Lateness beyond D is measured directly (`now − PTS`) and
  alarmed. The policy is per output or group: drop late content, or raise the
  group's D (today's "never drop" requirement). D is lowered only by an explicit,
  controlled catch-up. The late policy **needs owner input (Q10)**.
- **Leaving the house clock.**
  - Audio leaves through ASRC to the device clock. ASRC replaces skew slaving,
    which drops or inserts samples at the drift tolerance (R5).
  - Video leaves through frame repeat or drop, or through genlock (locking the
    output's timing to an external reference) where the hardware has it.

## 9. Lipsync and latency

### 9.1 Inside a program

An ingest runs one virtual STC per program. The A/V relationship is therefore
the one the source sent, and P3 preserves it through every hop. No per-hop or
per-branch correction exists to go wrong.

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
- lateness readings at the receiver are off by ε, so W, D and D_e must include
  |ε|.

| Use | Clock agreement needed | Discipline |
|---|---|---|
| One engine, or inter-engine streams restamped | None (rate discipline recommended) | Any |
| Trusted WAN (wide-area network) contribution and return; A/V of one origin | Rate locked; ε well inside the latency margins (tens of ms) | Continuous NTP (chrony, an NTP daemon); SNTP (Simple NTP) with monitoring |
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

Each owner sizes from what it measures:
- **Aligner window W:** at least the spread between its latest and earliest
  input, plus a margin.
- **Presentation delay D:** at least the lateness at the output, plus device
  latency, plus a margin.
- **Egress delay D_e:** at least the lateness at the egress, plus the receiver's
  buffer.

Each may be configured with an alarm, or raised automatically within limits.
Which, and the limits, **need owner input (Q8, Q10)**; risk R9.

Two consequences need stating:
- **Source-natural landing (§5.1) costs the source's own PTS−PCR lead.** That is
  about 1 s on a broadcast contribution encoder. Today's arrival anchor hides the
  lead and pays for it in late access units and re-anchors (#816). A negative O
  trades the lead back (§5.5). See Q5 and R12.
- **Aligning with a remote stream costs its transit.** A local route that aligns
  with a trusted remote stream inherits that transit, which can be seconds over a
  WAN. Alignment cannot avoid this, which is why Trust is opt-in (§10.4).

## 10. Clock discipline and trust

### 10.1 The fleet today

- **htpdate** is enabled: `-t -s`, Type=oneshot. It steps REALTIME once at boot,
  to about ±0.5 s, and exits. It reads the time from web servers over HTTP, so
  it works where outbound NTP is blocked. Whether that is why it was chosen
  **needs owner input (Q3)**.
- **systemd-timesyncd** is enabled and runs SNTP. It slews, and steps any offset
  above 0.4 s.
  - The house clock's rate is therefore disciplined only when timesyncd reaches
    an NTP server.
  - Nothing checks whether it does.
- **PTP** (linuxptp, `media-router-ptp`) is opt-in per device and off by default.
- **The engine has no view of sync state.** Apart from the Device Manager's PTP
  status page, nothing reports whether the clock is synchronised, or how well.

### 10.2 Required for trusted streams

- **Continuous discipline, frequency and phase, on both ends** (chrony or PTP).
  Both must trace to a common reference: UTC (Coordinated Universal Time) or TAI
  through GNSS-backed (satellite-navigation, e.g. GPS) NTP or PTP, or the same
  PTP domain and grandmaster.
- **Slew only, after the boot-time sync.**
  - chrony: `makestep` limited to start-up.
  - ptp4l / phc2sys: a step on first lock only.
- **A bounded slew rate.** A slew changes the house clock's frequency, and every
  output has to follow it. ptp4l is already clamped to 100 ppm.
- **A correct kernel TAI offset**, from chrony `leapsectz` or the PTP UTC offset,
  with a configured TAI−UTC fallback. Otherwise engines started on opposite sides
  of a leap second sit 1 s apart. None is scheduled, but one remains possible
  until 2035.
- **The engine reads the daemon's state:** synchronised or not, and the estimated
  error.

**Needs owner input (Q3, Q12).** The image's time source, and the minimum
discipline a Trust selection requires.

### 10.3 Epoch policy

- **Latching.** E is latched at engine start, once the daemon reports sync. The
  wait is bounded. When it expires, E is latched anyway and egress declares
  itself *not traceable*.
- **E stays constant while the engine runs.** The engine watches `TAI − (MONO +
  E)` for steps. A `timerfd` armed with `TFD_TIMER_CANCEL_ON_SET` reports a
  REALTIME step at once.
- **Divergence above tolerance** raises an alarm and makes egress declare itself
  not traceable, so Trust-selected receivers fall back to restamp.
- **Re-latching** happens through an engine restart, or an explicit re-epoch.
  Because E is used only at the network boundary, a re-epoch steps nothing but
  the network egress PTS, as one flagged discontinuity.

**Needs owner input (Q15).** How long an engine waits for sync at start, and
whether a re-epoch is automatic or an operator action. Risk R6.

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
Whether an ingest offset may apply to a trusted stream **needs owner input
(Q13)**.

Why Trust is never the default: a remote stream arrives late by the network
delay plus its transport latency (the RIST buffer, the SRT latency). Trusted, it
holds every local stream it is muxed or mixed with by that much. That is right
when origin alignment matters (§9.3), and wrong for most live feeds from other
sites. `aes67-input`'s `ptpSync` is already this kind of opt-in.

**Verification.** A Trust selection is verified continuously. The stream
qualifies only while all three of these hold:
1. The PMT carries the house-time descriptor.
2. Both ends declare traceable sync: the same reference, or the same PTP domain
   and grandmaster.
3. The PCR check passes: `arrival − (PCR + D_e)` is the transit, non-negative and
   stable within the declared error.

If a Trust-selected stream does not qualify, the ingest restamps it and raises
an alarm that names the failed condition. It returns to trust once the stream
qualifies again. This fallback is the recommendation; it **needs owner input
(Q14)**. Risk R8.

**Switching modes.** A switch between trust and restamp moves content time by
the transit. Going to restamp leaves a gap; going to trust drops the overlap.
- An automatic switch is taken only at a gap or a stream (re)start, and raises
  an event.
- An operator's mode change is applied the same way.

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
| audio-mixer, n1-mixer-302m | Processing (aligner) | Branches latch `tsdemux ignore-pcr` on their first PES. Anchored egress bakes transit and mix latency into the timeline. Clock pacer. | Formula demux, identity egress, W from lateness. #837 did this and was reverted on 2026-10-10; the reason is not recorded (Q7, R15). |
| audio-processing | Processing | As the mixers. Programme and key (the side-chain signal that triggers ducking) are joined by arrival (`interleave`). The ducker loop runs in the engine on `Date.now()`. | Key aligned to the programme by PTS; ducking applied in the pipeline, on content time. |
| teletext-subtitles | Processing | Identity egress. K learned from stamp rises (`mrpeshouse`, `StampModel`). | Formula demux; no learning. |
| rist-output, srt-output, mpegts-ip-output | Egress | Byte pass-through, unpaced (`sync=false`). The wire PCR is whatever the producer wrote. | PTS translated to TAI; new PCR `H − D_e`; descriptor. |
| aes67-output | Egress | Remuxes to RTP. RTP time = TAI when `ptpSync`, with the offset measured per module at start. Its `tsdemux` is unaligned. | Formula demux; engine-wide E. |
| video-player, audio-decoder, audio-output-302m | Presentation | `sync=true` at stamp + D (route-head walk, runtime raise, rebase). One-shot branch alignment. Audio skew-slaved. | `PTS + D`, owned by the output or its group. Formula demux; queues sized from D; ASRC to the device. |

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

### 11.3 What stands between today's code and P3

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

### 11.4 Mechanisms and their fate

| Mechanism | Where | Source lines (approx.) | Fate |
|---|---|---|---|
| Anchored stamping: latch, latch repair, watch, staleness net, late and early tiers, drift servo | `ts_timeline.{py,cpp,h}`, `gstmrtsstamp.cpp`, runner glue in both runners | 5,300 (shared with identity mode) | Removed from every hop. An ingest uses a virtual STC; every other egress uses identity. |
| Wire conditioner: step absorption, program-wide steps (ADR-0018), PCR at `PTS − 250 ms` | Same files | (included above) | Removed. A source discontinuity becomes an ingest re-lock. |
| Branch alignment and per-AU retime | `gst-pipeline-runner.py`, `branch_retime.{py,cpp}`, `branch_align.cpp` | 2,100 | Replaced by formula demux. |
| Subtitle K recovery | `mrpeshouse`, `subtitle_stamp_model.py`, `subtitle_native.py` | 700 | Replaced by formula demux. |
| Lateness handling: shedder, raise, rebase | `backlog_shed.{py,cpp}`, runners, `backlogShed.ts`, `playoutReanchor*.ts`, `PlayoutRaises.ts` | 2,600 | Reduced to `now − PTS` against an output-owned D, with an optional raise of the group's D. |
| Route-head D, latch-repair resolution | `playoutOffset.ts`, `latchRepair.ts`, `MediaRouter` head walk | 300 | Replaced by output-owned D. |
| Render keep-up | `render_lag.py`, runners, `renderLag.ts` | 570 | Kept (diagnostic). |
| Scheduling clock | Both runners | — | Kept. |
| Identity egress | Stamper | — | Kept. It becomes the only stamp mode on internal hops. |
| TAI−MONOTONIC offset | `aes67_clock.py` | 120 | Generalised to the engine-wide E. |

### 11.5 New work this design needs

1. **Ingest restamp:**
   - the virtual STC, with PCR validation and the degraded fallback;
   - a per-ES monotonic guard;
   - the ingest offset.

   It should be native and implemented once, which also ends the twin-parity
   burden (#819).
2. **Formula demux** for every consumer (§6).
3. **An egress writer:** TAI translation, PCR generation and insertion, and the
   descriptor.
4. **ASRC** at PCM capture, at the first decode of foreign-clocked audio, and at
   outputs (#814).
5. **Engine clock state:**
   - the engine epoch E, time-sync status and step detection;
   - a continuous time source in the image: chrony, or PTP where available.
6. **Lateness telemetry** on every bus input, with W, D and D_e sized from it.
7. **Ducking in the pipeline,** on a PTS-aligned key, and a PTS-aligned
   interleave.
8. **Manager work:** settings for the ingest offset, the timing mode (Trust or
   Restamp), D and presentation groups, and D_e. The measured lead, transit,
   lateness and sync state are shown beside them, with their alarms (R14).
9. **Migration of today's timing settings** to the new ones (Q9, R13).

### 11.6 Stale statements found during verification

These don't change the design, but they can mislead whoever works on the timing
code. Whether to correct them now is part of Q2.

| Where | It says | The code |
|---|---|---|
| ADR-0005, Stage 3f | A plain capture producer's bytes are never touched. | audio-encoder's egress conditions them (`conditionStepMs: 100`). |
| ADR-0008, amendment of 2026-10-05 | `mpegtsmux` writes PES PTS ~250 ms ahead of the PCR. | For audio (PTS = DTS), GStreamer 1.28 writes the PCR at DTS − 125 ms (`TSMUX_PCR_OFFSET`), so the lead is 125 ms. |
| ADR-0018 | `mr-bus-fanout` runs the conditioner. | `mr-bus-fanout` only stamps; it never calls `condition()`. |
| `Aes67OutputModule.ts`, `aes67_clock.py` | The TAI offset is re-measured after a clock step. | It is measured once, when the module starts. Nothing detects a step. |

## 12. Shortcomings and risks

### 12.1 Shortcomings — limits of the concept itself

Levels: H = high, M = medium, L = low.

| # | Level | Shortcoming | Consequence and handling |
|---|---|---|---|
| S1 | H | **Restamping fixes labels, not samples.** | Without ASRC (P7), every element that counts samples still drifts against PTS, and #814 stays. ASRC is a precondition of the concept, not an add-on. |
| S2 | H | **Trust depends on infrastructure outside the engine.** | Without continuous, traceable time sync on both ends, a Trust-selected ingest falls back to restamp. That is today's per-hop independence, though at least deterministic per hop. The fleet's default today cannot support trust (§10.1). |
| S3 | M | **Aligning independent sources is manual.** | The design keeps an alignment once it is set; it does not discover encoder or transport delays. An operator sets O per source, and sets it again if the source's encoding changes. |
| S4 | M | **Latency follows the slowest aligned input.** | Source-natural landing adds the source's PTS−PCR lead. Aligning with a remote stream adds its transit. Content cannot be aligned without waiting for it. |
| S5 | M | **Bad source clocks still need estimation.** | A broken PCR, no PCR, or bursty delivery (vMix CBR, some software encoders, HLS) cannot be locked. The degraded fallback is a smaller arrival-based estimator, confined to ingest. |
| S6 | M | **Trust is a per-link operator decision.** | Trust where it isn't needed adds the link's transit to every local route that aligns with it. Restamp where origin alignment is needed loses that alignment. The module should show the link's measured transit and whether the stream qualifies, so the choice is informed. |
| S7 | L | **Talent feedback loops tie an ingest offset to an output's D.** | An interpreter microphone's O must follow its monitor's D. A D raise without a matching O shifts the interpretation. |
| S8 | L | **Changing content time at ingest is lossy.** | A live offset edit, a re-lock or a trust-mode switch produces a gap, or drops the overlap. Content cannot move without a discontinuity. |
| S9 | L | **The absolute PTS wraps at the same instant fleet-wide.** | It happens every 26.5 h. Any consumer with a wrap bug fails everywhere at once, not at random per device as today. |

### 12.2 Risks — what can go wrong building or running it

The last column names the questions in §13.2 whose answers shape the
mitigation.

| # | Level | Risk | Mitigation | Owner input |
|---|---|---|---|---|
| R1 | H | **GStreamer demux determinism.** Formula demux through stock `tsdemux` (§6, a1/a2) depends on internals that can differ between versions or edge cases. | Fixtures that pin exact output: B-frames, multi-PID and multi-PCR buffers, wrap, restarts. Fall back to a native PES demux. | — |
| R2 | H | **The time-sync baseline.** Today it is htpdate plus SNTP, with no engine visibility and PTP off. WAN paths with asymmetric delay put NTP off by half the asymmetry, which on satellite-class links means tens of ms or more. Replacing htpdate can lose sync at a site that blocks outbound NTP. | Ship chrony as the baseline, keeping htpdate for the boot step where NTP is blocked; report sync state to the engine; verify every Trust selection against the declared state and the PCR check. Restamp stays the default. | Q3, Q12 |
| R3 | H | **Scope.** The change touches every module class, both runners and the sidecars. Today's machinery (~12,000 lines) must keep working until cut-over. | A phased migration behind an engine flag, with conformance fixtures per class built from field captures (§14). | Q1 |
| R4 | M | **PCR lock quality.** Loop tuning trades jitter rejection against tracking. A source whose own clock is NTP-slewed changes frequency by up to 500 ppm. A path whose minimum delay moves (re-route) shifts the envelope. | A two-stage estimator (min-filter, then a slow rate loop). Telemetry for offset, ppm and residual. Replay the #816, #820, #825 and #836 captures before release. | — |
| R5 | M | **ASRC cost and quality.** CPU on Pi 4/5; no ready fractional-ratio element in GStreamer (`audioresample` takes integer rates); the PipeWire capture constraints listed in #814. | `GstAudioResampler` with scaled rates, or speexdsp/libsamplerate. Measure per channel count on Pi 4. | — |
| R6 | M | **Clock steps after start.** Late boot sync, a timesyncd step above 0.4 s, a manual change or a leap second leaves E stale, and trust is degraded until a re-latch. | Wait for sync at start; slew-only policy; step detection; explicit re-epoch (§10.3). | Q15 |
| R7 | M | **House-clock frequency excursions.** A daemon correcting an offset by slewing changes MONOTONIC's rate, by up to the kernel's 500 ppm slew limit; at that rate, a 50 ms correction lasts 100 s. Every output and every ingest loop must follow. | Bound the slew rate: chrony `maxslewrate`; PTP is already clamped to 100 ppm. | Q3 |
| R8 | M | **Trusting a wrong upstream.** A buggy or misconfigured engine's PTS propagates with no local correction. | Trust is opt-in per ingest. The declaration and PCR checks run continuously and drop a stream that stops qualifying to restamp, with an alarm. Mode switches happen only at gaps. | Q14 |
| R9 | M | **Budget sizing.** W, D or D_e too small means late or dropped content; too large means latency and queue memory (5 s edge queues, ADR-0015 byte caps, Pi memory). Automatic raises interact with queue sizing (#830). | Size from measured lateness; queues follow D; ceilings with alarms. | Q8, Q10 |
| R10 | M | **Hidden arrival and sample-count behaviour in elements.** Examples: `interleave`, the wall-clock ducker, encoder `perfect-timestamp` tolerance, `audiomixer` thresholds, `videorate`'s grid from segment start. | The §11.3 list becomes an audit checklist, each item replaced or pinned by a fixture. | — |
| R11 | M | **Egress processing cost.** Every network egress now parses the TS, rewrites each PES header and inserts PCR packets, where today it forwards the bytes unchanged. That is new CPU per packet, on every egress of a Pi. | Native code that rewrites headers in place. Measure on a Pi 4 at the largest egress count and bitrate expected, in Phase 5. The per-egress PCR is decided (§13.1), so the cost stays at the egress. | — |
| R12 | M | **Latency change at cut-over.** With source-natural landing, routes fed by contribution encoders get later than today by the encoder's PTS−PCR lead, about 1 s. Operators and talent will notice. | The ingest shows its measured lead, and a negative O recovers it (§5.5). Release notes explain the change. | Q5 |
| R13 | M | **Today's timing settings don't map one-to-one.** `playoutOffsetMs`, `lipSyncMs`, `syncOffsetMs`, `mixLatencyMs` and `subtitleDelayMs` have no direct equivalent. A blind migration can count a delay twice, or drop a compensation a site relies on. | An explicit mapping per setting, applied in Phases 2 and 4, with an alarm that names any removed value that was not the default. | Q9 |
| R14 | M | **More settings for operators.** The ingest offset, Trust or Restamp, D per output or group, and D_e are new. Wrong values give late, dropped or needlessly delayed content. | Defaults that need no setting on a single engine. The measured lead, transit and lateness shown beside each setting (§11.5). Alarms. | Q5, Q10 |
| R15 | M | **The reason #837 was reverted is not recorded.** Phase 2 repeats its approach for the mixers and audio processing, and could repeat its problem. | The design owner states the reason before Phase 2 starts. | Q7 |
| R16 | M | **The current model still needs field fixes during the migration.** Each fix to a mechanism this design removes is effort spent twice, and both models run side by side behind the flag for several releases. | Fix in the current model only what can't wait for the phase that replaces it. | Q2 |
| R17 | L | **Third-party receivers.** `PCR = H − D_e` needs D_e ≥ lateness. A large D_e can overflow a hardware decoder's buffer (bitrate × D_e). Unpaced egress makes PCR jitter visible to strict TR 101 290 checks (the ETSI guideline monitoring probes use to check transport streams). | Bound D_e per egress; optional paced egress for hardware IRDs (integrated receiver-decoders: hardware broadcast decoders). | Q16 |
| R18 | L | **Monotonicity at ingest.** A re-lock or offset edit that emits a backward PTS would revive #824-class faults. | A per-ES monotonic guard at ingest, with fixtures. | — |
| R19 | L | **Wrap handling bugs** in our own unwrap code or in third-party consumers (S9). | Wrap fixtures; a test mode that places a wrap minutes after start. | — |
| R20 | L | **A mixed-version fleet.** | Safe by construction. Old engines' streams carry no descriptor, so new engines restamp them; new engines' streams reach old engines and are re-anchored as today. The engine flag switches a whole box, never one module. | — |

## 13. Decisions

### 13.1 Decided by the design owner

| Date | Decision |
|---|---|
| 2026-10-11 | **The concept, P1–P6.** Each ingest restamps PTS/DTS from the house clock, locked to the source PCR. Processing keeps PTS, and aligners wait for their slowest input. Egress keeps PTS and writes a new PCR from the house clock. PTS between engines is absolute. The ingest offset is the only content-time control. |
| 2026-10-11 | **Trust is an operator selection per network ingest.** Restamp is the default, and there is no automatic mode. A trusted remote stream makes every local aligner wait for its transit, which is wrong for most live feeds from other sites. |
| 2026-10-12 | **Each network egress writes its own PCR from the emission clock,** `PCR = H(emission) − D_e` (§7). Computing the PCR once upstream and only translating it at egress was considered and rejected. |

### 13.2 Needs the design owner's input

Ordered by when the migration (§14) needs the answer. Each recommendation is
this document's proposal, not a decision. The text that depends on a question
is marked **Needs owner input (Qn)**.

| # | Question | Recommendation | Needed before |
|---|---|---|---|
| Q1 | Release scope and order: which phases ship in which release? | Phases 0–4 in order: they remove the in-engine faults. Phase 5 once a route needs origin alignment and Phase 0's time sync is deployed. Phase 6 after phases 0–5 have run for a release cycle in the field. | Planning |
| Q2 | What is still fixed in the current model while the migration runs? Open examples: #830, #836, and the stale statements in §11.6. | Only faults that are on air now and can't wait for the phase that removes the mechanism. Correct the stale statements now; they cost little. | Now |
| Q3 | The image's time source. Why was htpdate chosen? | chrony replaces systemd-timesyncd and disciplines the clock continuously. htpdate stays for the boot step if some sites block outbound NTP. PTP where the site supports it. | Phase 0 |
| Q4 | The network timescale, and where E applies | TAI, with E applied only at the network boundary (§4.2, §4.5). | Phase 0 |
| Q5 | The default landing for PCR-locked sources | Source-natural (§5.1), which is deterministic. Show the measured lead, so an operator can set a negative O no larger than the minimum lead (R12). | Phase 1 |
| Q6 | A per-PID trim at ingest | Allow it, bounded (e.g. ±500 ms), for sources with a fixed internal A/V error. | Phase 1 |
| Q7 | Why was #837 reverted? | None: only the owner knows. Phase 2 repeats #837's approach for the mixers and audio processing, so the reason must be known first (R15). | Phase 2 |
| Q8 | How W and D_e are sized | Automatically from measured lateness, between a floor and a ceiling per module, with an alarm at the ceiling. The mux ceiling starts at today's 2.4 s window. D_e's ceiling is bounded by receivers' buffers (R17). | Phase 2 (W), Phase 5 (D_e) |
| Q9 | What becomes of today's timing settings | `lipSyncMs` and `syncOffsetMs` become the output's device trim. `mixLatencyMs` and `subtitleDelayMs` become the floor of that module's W. `playoutOffsetMs` is removed, as #830 intends, because D becomes the output's. An alarm names any removed value that was not the default (R13). | Phase 2 (W), Phase 4 (D) |
| Q10 | D ownership, presentation groups and the late policy | Groups are set in the manager; an output outside a group uses the engine default D on its own. Late policy per group: raise D up to a ceiling, which keeps today's "never drop". Queues sized from D. | Phase 4 |
| Q11 | Talent loops (§5.5) | A per-ingest option that ties O to a named output's D. | Phase 4 |
| Q12 | The minimum time discipline for Trust | chrony or PTP. SNTP only if it reports an error estimate within the route's tolerance. | Phase 5 |
| Q13 | An ingest offset on a trusted stream | Not allowed: trust means untouched. Switch the ingest to Restamp if compensation is needed. | Phase 5 |
| Q14 | A Trust-selected stream that stops qualifying | Restamp it with an alarm, and return to trust once it qualifies again (one gap or dropped overlap each way). Keeping trust with only an alarm would carry a bad clock into every aligner. | Phase 5 |
| Q15 | The start-up wait for sync, and re-epoch (§10.3) | Wait up to e.g. 30 s at start, then start as not traceable. Re-epoch only at an engine restart or by operator action, with an alarm until then, because a re-epoch is a discontinuity on every network egress. | Phase 5 |
| Q16 | Paced egress for hardware receivers (§7) | Not in the first release. Add it per egress when a hardware IRD or a strict TR 101 290 probe is a real receiver. | Phase 5 |

### 13.3 Left to the engineer

These are engineering choices within the design. Record each in the ADR, and
raise with the design owner any that would change what an operator sees.

| Choice | Guidance | Needed before |
|---|---|---|
| Consumer demux mechanism (§6) | Prototype stock `tsdemux` (a1, a2) against fixtures; use a native PES demux if neither is exact (R1). | Phase 3 |
| Virtual STC loop constants and PCR validation bounds (§5.1, §5.3) | Set from replayed field captures (R4). | Phase 1 |
| ASRC implementation (P7) | `GstAudioResampler` with scaled rates, or speexdsp/libsamplerate. Measure on a Pi 4 (R5). | Phase 1 |
| Ingest restamp implementation (§11.5) | Native, implemented once for both runners. | Phase 1 |
| Descriptor format (§7) | A registration descriptor in the PMT carrying the fields §7 lists. | Phase 5 |
| Conformance fixtures per module class (§14) | Built from field captures, including the cases today's code handles specially. | Each phase |

## 14. Migration outline

Each phase sits behind an engine-wide flag (the same shape as
`MR_TIME_SYNC_CONTRACT`). Each is proven by replaying field captures through
both runners before release.

Which phases go into which release **needs owner input (Q1)**, and so does what
is still fixed in the current model meanwhile (Q2). The last column lists the
questions a phase needs answered before it starts.

| Phase | Delivers | Makes possible | Owner input first |
|---|---|---|---|
| 0 | Time-sync status in the engine; chrony in the image; epoch E with step detection; lateness telemetry on every bus input | Measuring everything that follows | Q3, Q4 |
| 1 | Ingest restamp (virtual STC) writing house time into the bytes; capture producers on identity egress; video-encoder on house time; ASRC at captures | Every bus edge carries house time in-band. Existing consumers keep working, because their K becomes constant. | Q5, Q6 |
| 2 | Splitter pass-through; mixers and audio processing on identity egress (as #837); muxer keeps sparse-PID PTS; ducking in the pipeline | P3 on every internal hop | Q7, Q8, Q9 |
| 3 | Formula demux on every consumer; ASRC at decode and at outputs | Removal of retime, branch alignment and K learning | — |
| 4 | Output-owned D, presentation groups, queue sizing from D | Removal of the route-head walk, shedder and rebase | Q9, Q10, Q11 |
| 5 | Egress writer (TAI translation, PCR, descriptor); operator-selected Trust at network ingests, verified by the descriptor and the PCR check | Inter-engine lipsync by construction, where Trust is selected | Q8, Q12–Q16 |
| 6 | Delete the anchored stamper, conditioner and their twins; supersede ADR-0005 decisions 2 and 4 and ADR-0018 | Complexity paid down | — |

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
| P1–P10, S1–S9, R1–R20, Q1–Q16 | This document's principles (§3), shortcomings (§12.1), risks (§12.2) and questions for the design owner (§13.2) |
| #NNN | An issue or pull request in the media-router GitHub repository |

### A.3 Terms

| Term | Meaning |
|---|---|
| aggregator | A GStreamer element that combines several inputs on one timeline (mux, mixer, compositor) and waits a set latency for late inputs |
| bus | The engine's internal transport between modules: TS carried over Unix sockets (`unixfdsink` / `unixfdsrc`) |
| content time, lateness, O, W, D, D_e, E, H | See §4.6 |
| demux / mux | Demultiplexer / multiplexer: splits a TS into its streams, or combines streams into one TS |
| descriptor | A small tagged record inside a TS table such as the PMT. Receivers skip tags they don't know. |
| ducker | Audio processing that lowers one signal (the programme) while another (the key, e.g. an interpreter) is active |
| egress | A module that sends a stream out of the engine (RIST, SRT, UDP or AES67 output) |
| epoch | The zero point of a timescale |
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
