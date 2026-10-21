# Release notes

Operator-facing notes per release, newest first. What changed on the box,
what to expect, what to do. Engineering detail is in `docs/adr/`.

## Unreleased — house-clock timing, Phases 1–4 (draft: the Phase 1 and 2 items, 2026-10-21)

Phases 1, 2, 3 and 4 ship together as one release. This draft holds the
Phase 1 and Phase 2 items; the Phase 3 and 4 items join it as those phases
land, and the note is finished with Phase 4. One RAUC bundle carries the image and the
app: the new timing elements ship in the image, so do not hot-deploy this
app onto an older image. On a box where they are missing, the GStreamer
modules' cards say "Native TS module not loaded": the inputs and captures
still run, on their source's own time (the audio captures at their device's
nominal rate, unlocked), and the modules under "Needs the image's native
elements" below do not start.

**Time is set once, where a stream enters the box**

- **Network inputs** (SRT Input, RIST Input, MPEG-TS IP Input) put every
  stream on the box's house clock using the source's own clock (its PCR),
  the way a decoder recovers it. All streams of a program move together, a
  source clock that runs fast or slow is followed, and content lands where
  the source scheduled it: its arrival plus the source's own buffering
  lead. A source restart or an outage becomes a gap of that length; the
  timeline never steps back. An SRT caller that queued while the input was
  away (an input or engine restart, a network loss) sends its queue at once
  when it reconnects: the input drops that stale backlog, so the stream
  shows the gap, at most the first 4 s of the backlog, then live content
  again within seconds, instead of running the backlog's length ahead. A
  backlog under 4 s plays, and up to about twice its length of live content
  is skipped once.
- **Captures** (Audio Input 302M, AES67 Input, Audio Encoder, Video Encoder)
  label their content with its capture time.
- **The three audio captures resample once**, locked to the device's
  clock, so the sample count and the timestamps on the bus always agree and
  a device clock that runs a little fast or slow no longer drifts the
  stream. The Audio Encoder now captures from PipeWire directly instead of
  through a PulseAudio ring, whose re-stamping caused occasional ~200 ms
  timing steps.
- **Sources with a sparse clock reference** (vMix's SRT output sends one
  every 2 s) now feed the modules behind the input smoothly. The input marks
  a break in the source's clock only where there is one (an outage, a
  re-lock, an offset change); earlier builds of this release marked every
  one of these sparse references, and a player or transcoder on such an
  input stepped by up to 18 ms every 2 s.

**New settings**

- **Ingest Offset** (ms, default 0, −10,000 to +10,000) on SRT Input, RIST
  Input, MPEG-TS IP Input, Audio Input 302M, AES67 Input, Audio Encoder and
  Video Encoder. Positive lands the input later on the timeline, negative
  earlier. It applies live, when you press Enter or leave the box. A
  positive change leaves a short gap, a negative change drops the content
  it overlaps: on audio a short cut, and on Video Encoder the picture breaks
  up until the next keyframe. Change it at a quiet moment.
- **Per-PID Trim** (ms, −2,000 to +2,000 per stream, default 0, live) on the
  three network inputs: moves one stream of the program against the others,
  on top of Ingest Offset, to correct a source's fixed lip-sync error or to
  match an external path. The rows list the streams from the source's PMT
  with their type ("Waiting for the stream's PMT" until it arrives); a trim
  kept for a stream the source no longer carries shows greyed as "not in
  stream".
- **Audio Encoder, Capture Buffer** is now the capture quantum: 40–85 ms,
  default 60 (was 40–1000 ms, default 200). A stored value above 85 ms is
  reset to the default.

**Reading the lead, and when to set a negative offset**

- Each network input shows, per stream, **Lead min / median / max**: how far
  ahead of its own presentation time the source delivers that stream (the
  source encoder's buffering, typically 0.3–1 s). Content is presented
  that long after it arrives, and the input's lateness reads negative by it.
- To win that latency back, set Ingest Offset to minus the smallest **lead
  min** across the streams (for example −380 ms when the smallest lead min
  is 380 ms). Never go further: content would then arrive after its own
  time and play late.
- **Interpreter or commentator microphones** (talent loops): set the
  microphone input's Ingest Offset to minus the lateness of the output the
  talent monitors (shown on that output's timing display), at a pause in
  their speech. Their voice then lands one reaction time after the content
  it answers instead of a monitor delay later.

**Clock status on the cards**

- Network inputs carry a **clock** badge: Locked (green), Acquiring (grey),
  Degraded or No PCR (amber), and a **Clock** section: state, source rate
  (ppm), residual p99, re-locks and the last event, plus one section per
  stream (lead, trim, total shift, PES dropped in the last 10 min). The
  audio captures show the ASRC ratio (ppm), phase error and re-locks; every
  capture shows its Ingest Offset.
- Warnings, none of which drops content: **Degraded clock** (the source's
  PCR is unusable, as on some vMix feeds: timing then follows one stream's
  own timestamps against arrival); **Source lead above 4 s on PID … —
  clamped** (while degraded, a stream more than 4 s ahead of the stream the
  timing follows is timed by its own arrival instead); **Source clock unstable** (more than 3
  re-locks in 10 min); **Source clock off by n ppm** (past 100 ppm for a
  minute); **PCR every n ms (spec ≤ 100 ms)**; **Transport errors**
  (continuity errors or lost sync on the input); on audio captures **Device
  clock off by n ppm — check the device's sample rate** (past 200 ppm for a
  minute).

**Behaviour changes**

- **Capture latency becomes visible.** Captured content is stamped when it
  was captured, so it reaches an output later than before by its capture
  and encode latency, and the lateness displays show it.
- **Mixed versions.** A box on the previous release that receives a stream
  from a box on this release (through SRT, RIST or MPEG-TS IP Output)
  re-anchors it once and then holds.
- **Rollback** is the previous release, installed from the Device Manager;
  there is no in-app switch.

**Mixers, Audio Processing and the MPEG-TS Muxer wait for every input
(Phase 2)**

- **Nothing is dropped for arriving late.** Audio Mixer, N-1 Audio Mixer
  (302M), Audio Processing, Audio Output (302M) with two or more sources and
  the MPEG-TS Muxer line their inputs up by their content time and wait for
  the slowest one. Before, a mixer gave up on a late input after its Mix
  Latency (20 ms by default, 200 ms on Audio Processing), filled the gap with
  silence and dropped what came later, and the muxer stopped waiting after
  2.4 s and muxed what came later out of order. Now the module adds the
  latency of its slowest input instead, and shows it.
- **The added latency does not come down by itself.** Once a slower input
  has raised it, it stays until that input is removed or the module is
  restarted. The module's timing popup shows it as **Pace**, and **Waiting
  for** names the input it waits on.
- **An input that goes silent is left out, not waited for.** After its
  silence limit (three times the input's usual gap between arrivals, 100 ms
  to 2 s; 2 s at start) the module carries a warning, "Input <name> silent
  for <n> ms — continuing without it", and goes on without that input. When
  the input comes back it joins at the current position; what it sends from
  before that moment is discarded, and the popup counts it as **Discarded
  on rejoin**. A queue that fills (5 s) holds the input back and warns
  "Input <name> queue full — upstream held"; nothing is dropped.
- **The MPEG-TS Muxer no longer restarts on a dark input.** It continues
  with the other inputs and warns. An input that is connected but stuck is
  therefore no longer restarted automatically: the warning names it for the
  operator to restart.
- **Subtitles and KLV keep their own timing through the muxer.** Each cue
  leaves at its own time instead of being re-timed to the mux position. A
  cue that arrives after its time is played late, never dropped, and the
  muxer raises its latency by that much.
- **Audio Processing ducks on content time.** The ducker now runs inside
  the pipeline and follows the key's content time, so a key that arrives
  late (through a transcoder, say) no longer ducks late. Its settings and
  graph are unchanged. Keyed-gate mode's output now carries timestamps; it
  had none, which left its stream untimed on the bus. The limiter's
  lookahead shows as **Processing latency**. When its programme source
  ends, the module keeps running, with silence, while the key flows.
- **HLS Player's stream is on the house clock**, like every other input:
  its first content lands at the time playback starts, and an origin's
  timeline jump of more than a second moves it once, without a step back.
- **TS Splitter passes its streams through untouched**: every output
  carries the input's PES bytes and the program's clock unchanged.

**Removed settings (Phase 2), nothing migrated**

- **Mix Latency** on Audio Mixer, N-1 Audio Mixer (302M), Audio Processing
  and Audio Output (302M).
- **Leaky Input Queues** and **Queue Depth** on the MPEG-TS Muxer.
- **Preserve Source Timeline** on Video Transcoder and Audio Transcoder.
- Stored values are ignored; a rollback restores them. The OCC gate's
  mixers ran Mix Latency 300 and a hot-patched alignment threshold; both are
  superseded, because the mixers have no latency budget any more and their
  inputs arrive on content time. Do not run the hot patch's revert script
  after installing this release: it would put back the old file.

**Needs the image's native elements (Phase 2)**

- Without the timing elements of this image, Audio Mixer, N-1 Audio Mixer
  (302M), Audio Processing and Audio Output (302M), whose 302M inputs now go
  through the image's new demux, refuse to start with "Native TS module not
  loaded", and the MPEG-TS Muxer does not start. Audio Processing's ducker and keyed-gate modes also need
  their own native plugin and otherwise show "Native plugin not loaded".

## Unreleased — house-clock timing, Phase 0 (2026-10-13)

One RAUC bundle carrying the image and the app. The app's time-sync wait,
the lateness display and the Device Manager's clock status all depend on
this image: do not hot-deploy this app onto a box running an older image
(it would find no `mr-clockstate` and no chrony, start every module at once
and show no lateness).

**Time**

- **chrony is the only NTP daemon.** htpdate and systemd-timesyncd are
  removed from the image. chrony steps the clock once at start-up and then
  slews it continuously, at most 100 ppm, so the house clock stays
  disciplined for as long as the box can reach an NTP server. It also sets
  the kernel TAI−UTC offset (37 s) from the image's leap-second list; until
  now every box ran with that offset at 0.
- **NTP servers are set on the Device Manager's Time page** (the PTP page,
  renamed; `/ptp` still gets you there). Default: `pool.ntp.org`. Up to 8
  host names or addresses; servers offered by the DHCP lease are used as
  well and listed read-only beneath. The Clock card shows which daemon owns
  the clock, whether it is synchronised, the estimated error, the kernel
  TAI−UTC offset (red when 0), frequency and chrony's sources.
- **chrony is off where PTP is on.** Enabling PTP stops chrony; disabling
  PTP starts it. Exactly one daemon steers the clock. The PTP setup now
  writes the kernel TAI offset before ptp4l starts.
- **The engine waits up to 30 s for time sync at start.** Modules start as
  soon as the clock is synchronised and the TAI offset is set; on a box
  that boots offline they start after 30 s with a warning in the log, and
  the engine is marked *untraceable* until sync arrives, at which point it
  re-latches its epoch by itself. The manager, the local API and the panel
  are reachable during the wait and show it. The engine card and header
  carry a clock indicator: green traceable, amber waiting (or synced with
  the TAI offset unset), red not synchronised.
- **AES67 output** takes its PTP epoch from the engine's clock and restarts
  once when the epoch moves (a clock step); it free-runs, and says why,
  while the clock is untraceable.

**Lateness on every module**

- Every module shows, in its stats popup, how late its output is against
  the house clock and how much latency it adds per input, in ms, with a
  grey lateness badge on the module face. Outputs also show decode latency,
  presentation delay, device latency and render lateness. Modules in the
  PipeWire graph (Audio Input, Audio Output, N-1 Audio Mixer, Audio
  Dynamics) show PipeWire's latency instead.
- These are **labelled numbers with no alarm**: no threshold, no warning,
  no setting. Alarms come in a later release once the fleet's numbers are
  known.
- How to read them in this release: inputs read near 0 ms (stamps are
  still anchored at arrival) and outputs are dominated by the playout
  offset D. The numbers become source-natural in Phase 1 and D-free in
  Phase 4.
- Dashboards and the LCP get the same values with no change
  (`timing` and `timing-in-<n>` sections, `lateness` badge).

**Removed**

- The `MR_TIME_SYNC_CONTRACT` environment switch. Every pipeline runs on the
  house clock; a drop-in setting it has no effect.
- The Audio Decoder's `clockSync` setting. A stored value is ignored.
- The PTP "displaced time services" record on `/data`; it is deleted once
  on first start.

**Rollback** is a previous release installed from the Device Manager; there
is no in-app switch.
