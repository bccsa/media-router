# Release notes

Operator-facing notes per release, newest first. What changed on the box,
what to expect, what to do. Engineering detail is in `docs/adr/`.

## Unreleased — house-clock timing, Phases 1–4 (draft: the Phase 1 and 2 items, 2026-10-22)

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
- **Smoothing Cooldown** (min, default 5, 0 to 60, live) on SRT Input, RIST
  Input and MPEG-TS IP Input. It adds latency only when the input's stream
  is bursty (packets arriving in bursts, as through some relays): the input
  then runs at its bursts' height and comes back down no sooner than this
  long after the last burst, instead of skipping and re-syncing after every
  burst. A steady stream gets no added latency. Set it longer than the time
  between bursts; 0 turns smoothing off. It applies live, when you press
  Enter or leave the box.
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
  minute); **PCR comes irregularly: gaps up to n, normally every n** (one or
  two late clock references in a minute; three degrade); **Transport errors**
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
  for <n> ms — continuing without it", and goes on without that input; the
  timing popup keeps listing it, State absent. When the input comes back it
  joins at the current position; what it sends from before that moment is
  discarded, and the popup counts it as **Discarded on rejoin**. A queue
  that fills (5 s) holds the input back and warns
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

**Fixed**

- **A stop no longer ends with the engine failed.** Stopping, restarting,
  rebooting or updating a box whose engine has a wired TS Splitter output,
  or an HLS Player with a consumer, ended with the engine failed (exit
  code 1) and skipped the rest of its stop. Likewise, a TS Splitter or HLS
  Player helper that died while the engine was sending it a command took
  the whole engine down, every route on the box with it, until the engine
  restarted. Fixed: the stop completes, and such a helper is restarted by
  its module without the engine going down.
- **Output lateness of the Video Encoder, and of modules with nothing
  connected.** The Video Encoder's output lateness showed how long the box
  had been up when the encoder started (minutes, on a box up less than an
  hour) and nothing at all on a box up longer. A module whose output had no
  consumer showed a similar number, about how long the box had been up when
  the module started. Fixed: the Video Encoder shows its encode latency, and
  a module's output lateness appears a few seconds after a consumer is
  connected to it.
- **A dropped video frame is no longer reported as a gap.** Under load the
  Video Encoder drops capture frames by design (on a busy Pi 4, about one in
  five). Each one went out as a gap in its stream: a line in the engine log
  every time, thousands an hour, enough to push the rest of a Pi 4's log out
  within hours, and a resynchronisation at each one in every module that
  unpacks the stream (Video Player, the transcoders, the MPEG-TS Muxer).
  Fixed: on video only a hole of a second or more counts as a gap; a dropped
  frame leaves the previous picture up a moment longer, as before.
- **A network input on a bursty link no longer sticks on Degraded clock.**
  An SRT or RIST input whose sender delivers in bursts (a relay of the
  production gate, for one) showed "Degraded clock: lead out of range" a
  minute or two after every start and never left it. The check read the
  late bursts as a fault in the source's clock. Fixed: that check now reads
  the stream's own timestamps, so such an input stays on its clock; and an
  input degraded for a real reason returns once 30 s pass with no check
  failing, which a bursty link's small hiccups used to prevent for good.
  While an input is degraded, its "unstable" and "off by n ppm" warnings
  now name the PID its timing follows, not the source clock.
- **An input on a link that delivers in bursts no longer re-locks every 2.5
  minutes.** An SRT input on a relay of the production gate (TECH01), whose
  delivery runs up to half a second late for 12 s every 150 s and then a
  little early for a few seconds, re-locked its clock twice in each cycle: a
  short gap in picture and sound at each re-lock and about half a second
  dropped in between. Fixed: after the first late burst the input's delay
  settles at the bursts' full height, plus the one late packet that set it
  (0.3 to 0.6 s more on that input, out of the 4 s an input may run ahead;
  taller bursts hold more, and bursts that keep growing raise it to the
  tallest), and the clock re-steps every 12.5 to 22.5 minutes without dropping
  anything. How long the input holds that height after the last burst is the
  new Smoothing Cooldown setting of the three network inputs (5 minutes by
  default, live; see New settings): it adds latency only on such a bursty
  input, and 0 turns it off, which brings back the re-locks in pairs. On
  TECH01's relay every value tried from 1 to 60 minutes gives the same result;
  under a minute it can come down between bursts (at 30 s, one more cut of
  half a second and two more re-locks in 15 minutes). Taller bursts need a
  cooldown longer than the time between them. On such an input a source
  restart or a jump in the source's timeline, a clock fault (Degraded clock)
  or a change of the PCR PID drops that extra delay once (about 0.36 s at a
  restart or jump, about 0.26 s at a clock fault); it builds again at the next
  burst. A queue that drains afterwards is shed one Smoothing Cooldown later
  (5 minutes by default) when it is more than 0.5 s above the bursts' height;
  a smaller excess stays, held by the bursts. Limits:
  when one stream of the input is stamped so far ahead that the extra delay
  takes it near the 4 s limit (3.4 to 3.9 s ahead on TECH01), the whole
  input re-locks in pairs as before; and a source whose clock reference
  comes only every 1 to 2 s (vMix's cadence; TECH01's comes every 60 ms) and
  whose bursts rise or fall by more than 0.5 s between two references still
  re-locks in pairs. Why the relay delivers in bursts is investigated apart
  (#847; the 150 s cycle is already in NO-OCC-Gate01's output).
- **Fewer glitches when an input's clock fails and when it recovers.** When
  an input's clock reference froze, went missing or failed a check, the
  input changed over to timing from its own streams ("Degraded clock") and
  changed back once the reference had been sound for 30 s. On a link that
  delivers unevenly (a relay of the production gate, for one) each change-over
  cut picture and sound dozens of times in the seconds after it, a few
  hundredths of a second each. Fixed: each change-over is one cut per stream
  (on TECH01's relay about 0.26 s at the change to Degraded clock, the extra
  delay the fix above holds, and under 0.1 s at the return). A real jump in
  the source's timeline is handled as before.
- **An input whose source sends its clock reference only every few seconds
  now locks on it.** Such an input (vMix's SRT output sends one per 2 s
  picture group) showed "Degraded clock" for good. It now shows a green
  Clock badge with the state "Locked (PCR every 2.0 s)", after a minute or
  so of "Acquiring". Amber stays for a reference that stops ("No PCR" after
  5 s, then "Degraded clock: PCR missing", within 12 s on a 2 s reference
  and 1.5 s on a dense one), jumps, or comes irregularly ("PCR comes
  irregularly: gaps up to n, normally every n"). That warning replaces "PCR
  every n ms (spec ≤ 100 ms)", which a bursty link raised on sources whose
  clock was fine.
- **Audio captures no longer drop sound on a busy box.** On a box working
  near its limit (a Pi 4 showing video on HDMI while it encodes, for one),
  Audio Input (302M) and Audio Encoder could lose 50 to 200 ms of sound now
  and then, up to about a hundred times an hour: each a short gap in the
  stream, counted under Re-locks on the Clock card. The capture ran at
  ordinary priority, competing with everything else on the box. Fixed: it
  now runs at real-time priority, as PipeWire's own audio does.
- **A stream that pauses for more than 5 s no longer loses its first packet
  when it resumes.** When a stream between two modules went quiet for more
  than 5 seconds and then came back in a burst (a subtitle or data stream
  between cues, a module whose own input was out), the receiving module
  lost the first packet back about half the time and resynchronised on the
  next one: a missed subtitle cue, or a short glitch. Fixed in the
  GStreamer of this release's system image, so it needs the image that
  carries the patch; this app on an older image still loses that packet.
- **The engine starts when GStreamer has to rebuild its plugin list.**
  GStreamer keeps a list of its plugins in the box's home directory. When
  that list was missing or out of date (a freshly flashed or reset box, an
  update that changes most of GStreamer), the engine could fail to start
  and restart over and over with "GStreamer unixfdsrc not available" until
  someone rebuilt the list by hand: on a Pi 4 under test, 8 restarts and 77 s
  without the engine. Rebuilding the list takes 2 to 3 s on a busy Pi 4, and
  the engine gave up after 2 s, before the list was saved. Fixed: the engine
  waits up to 30 s, so its first start rebuilds the list and later starts are
  as quick as before. A check that still runs out of time says so, instead of
  reporting GStreamer as missing; and a module whose check of the encoders,
  decoders or 302M support on the box ran out of time checks again when it
  starts, instead of going without them until the engine restarts.

## Unreleased — house-clock timing, Phase 0 (2026-10-13)

One RAUC bundle carrying the image and the app. The app's time-sync wait,
the lateness display and the Device Manager's clock status all depend on
this image: do not hot-deploy this app onto a box running an older image
(it would find no `mr-clockstate` and no chrony, start every module at once
and show no lateness).

**Time**

- **chrony is the only NTP daemon.** htpdate and systemd-timesyncd are
  removed from the image. chrony slews the clock continuously, at most
  100 ppm, so the house clock stays disciplined for as long as the box can
  reach an NTP server; it steps the clock only when it is more than 1 s off
  (at start-up, or back from a long time offline), and each such step makes
  the engine re-latch its epoch once. It also sets the kernel TAI−UTC offset
  (37 s) from the image's leap-second list; until now every box ran with
  that offset at 0.
- **A box that boots offline is not marked degraded.** The boot-time wait
  for NTP gives up after 30 s with one warning in the journal (`no NTP sync
  after 30 s - continuing unsynchronised; the clock will step when NTP is
  reachable`). When the uplink comes back, chrony retries its servers at
  once and steps the clock if it is more than 1 s off.
- **NTP servers are set on the Device Manager's Time page** (the PTP page,
  renamed; `/ptp` still gets you there). Default: `pool.ntp.org`. Up to 8
  host names or addresses; servers offered by the DHCP lease are used as
  well and listed read-only beneath. The Clock card shows which daemon owns
  the clock, whether it is synchronised, the estimated error, how far the
  system time is fast or slow of NTP time, the kernel TAI−UTC offset (red
  when 0), frequency and chrony's sources.
- **"Synchronised" on the Time page uses the engine's own test** (error
  bound under 1 s), so it no longer reads synchronised for a moment when
  PTP starts on an unset clock.
- **chrony and PTP never steer the clock together.** On a box set to "Never
  become grandmaster", enabling PTP stops chrony and disabling PTP starts
  it. A box that may become grandmaster keeps chrony while it is the
  grandmaster: chrony keeps its time from NTP, PTP serves that time to the
  others, and the box announces its time as traceable only while chrony is
  synchronised. The moment a better grandmaster appears, PTP steers the box;
  once that grandmaster has gone, chrony takes it back after a short hold.
  At boot such a box waits up to 30 s for NTP and steps its clock once
  before it serves PTP. Which box becomes grandmaster is still decided by
  its PTP Priority alone. The PTP setup now writes the kernel TAI offset
  before ptp4l starts.
- **The Time page shows who keeps a grandmaster's time.** On a grandmaster
  it names the owner "chrony (NTP), served over PTP", and the PTP card's new
  **Time source** row shows what the elected grandmaster announces, e.g.
  "NTP · traceable", or "Internal oscillator · not traceable" for a
  grandmaster without NTP. The PTP card now also reads boxes on ST 2059-2's
  domain 127, where port state and grandmaster showed "—".
- **The engine waits up to 30 s for time sync at start.** Modules start as
  soon as the clock is synchronised (the kernel's error bound under 1 s)
  and the TAI offset is set; on a box that boots offline they start after
  30 s with a warning in the log, and the engine is marked *untraceable*
  until sync arrives, at which point it re-latches its epoch by itself,
  once: a clock step at boot, the TAI offset and the sync that follow count
  as one move. The manager, the local API and the panel are reachable
  during the wait and show it. The engine card and header carry a clock
  indicator: green traceable, amber waiting (or synced with the TAI offset
  unset), red not synchronised; hover it for the source, error, TAI−UTC
  offset and epoch. On a PTP grandmaster the source reads chrony, with
  chrony's reference and error, because chrony disciplines the time the box
  serves; a clock step re-reads the source at once instead of at the next
  10 s poll.
- **A box that loses its NTP server turns untraceable after 16 to 33
  minutes**, when the kernel's error bound passes 1 s, and green again at
  the next sync. Its epoch is kept, so nothing restarts. A PTP grandmaster
  announces itself not traceable at the same moment.
- **AES67 output** takes its PTP epoch from the engine's clock and restarts
  once when the epoch moves (a clock step); it free-runs, and says why,
  while the clock is untraceable.

**Lateness on every module**

- Every module shows, in its stats popup, how late its output is against
  the house clock and how much latency it adds per input, in ms, each
  input named by the module feeding it. Outputs also show decode latency,
  presentation delay, device latency (one refresh of the display mode on
  video outputs, marked "60 Hz assumed" when the mode is unknown) and
  render lateness. A module with two or more outputs, such as the TS
  Splitter, also shows each output's lateness. Modules in the PipeWire
  graph (Audio Input, Audio Output, N-1 Audio Mixer, Audio Dynamics) show
  PipeWire's latency instead.
- The grey badge on the module face shows the render lateness on the
  outputs that render (Video Player, Audio Decoder, Audio Output (302M)),
  PipeWire's latency on PipeWire-graph modules and the output lateness on
  everything else, network outputs included.
- These are **labelled numbers with no alarm**: no threshold, no warning,
  no setting. Alarms come in a later release once the fleet's numbers are
  known.
- How to read them in this release: inputs read near 0 ms (stamps are
  still anchored at arrival) and outputs are dominated by the playout
  offset D. The numbers become source-natural in Phase 1 and D-free in
  Phase 4.
- Dashboards and the LCP get the same values with no change: the `timing`
  section, one `timing-in-<n>` per input, one `timing-out-<n>` per output
  on modules with two or more bus outputs, and the `lateness` badge. An
  input keeps its number while it is dark, so a widget bound to
  `timing-in-2` does not switch to another input; it shows *Missing* until
  its input reports again. Adding an input can renumber the inputs after
  it. Output numbers count only the outputs reporting and can shift.

**Logs**

- System log lines (chrony, phc2sys, sshd, `logger`) now reach the journal:
  BusyBox's syslog daemon is removed from the image, so read them with
  `journalctl`; `/var/log/messages` is no longer written.
- PTP logs one servo summary every 16 s instead of every second.
- The engine no longer logs the clock sidecar's once-a-second samples. At
  debug level they made up about two thirds of the engine's journal lines
  and pushed boot logs out of the 32 MB journal within about 2 hours. Every
  clock decision is still logged, and a sidecar line the engine cannot read
  is logged at most once a minute.

**Removed**

- The `MR_TIME_SYNC_CONTRACT` environment switch. Every pipeline runs on the
  house clock; a drop-in setting it has no effect.
- The Audio Decoder's `clockSync` setting. A stored value is ignored.
- The PTP "displaced time services" record on `/data`; it is deleted once
  on first start.

**Rollback** is a previous release installed from the Device Manager; there
is no in-app switch.
