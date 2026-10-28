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
  re-lock, an offset change); earlier builds of this release marked nearly
  every one of these sparse references, and a player or transcoder on such
  an input stepped by up to 18 ms every 2 s.

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
- **A typed setting is checked and written when you press Enter or leave
  the box.** While you type into a setting (a number or text, one that
  applies live or one that needs a module restart) nothing is written and
  no error shows; when you press Enter or move to another field the value
  is checked and written once, and an unchanged value writes nothing. A
  value the setting cannot take (out of its range, not a number, not a
  whole number where one is needed, an empty number box) is not written
  and is no longer changed to the nearest limit: the box keeps what you
  typed and says why underneath, and the setting keeps its value. The same
  holds for the box beside a slider (also in a module's right-click menu),
  list items, Per-PID Trim (type 0 to remove a trim), a dashboard's number
  box, Settings → Engine Comms and the dashboard editor's number fields. A
  setting that needs a module restart is still written by Save. Escape
  closes the settings panel; what was typed is not written.
- **Device Manager: a typed setting is checked and kept when you press Enter
  or leave the box.** While you type in the Device Manager (log sizes, PTP,
  NTP servers, network addresses and the hostname, firewall rules, manager
  profiles, displays) nothing is checked and no error shows. When you press
  Enter or move to another field the value is checked: a value the setting
  cannot take stays in the box with the reason underneath, and the setting
  keeps its value. Save works in one click straight after typing: it saves,
  or tells you why not, and it waits while any box holds a value it cannot
  take. Spaces typed before or after an address, host name, port or server
  are dropped. A blank PTP Domain now means the profile's default, as the
  page says (it used to be saved as domain 0). The password pages say "At
  least 8 characters." or "Passwords don't match." once you leave the box,
  not while you type.
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
- **The added latency comes down by itself.** Once every input has been
  steady under it for about three minutes, the module drops it in one step
  (at most a second at a time); nothing is lost or repeated. It also drops
  when the slow input is removed. The timing popup shows it as **Pace**, and
  **Waiting for** names the input it waits on.
- **A slower input that joins no longer stops the mix.** The module eases its
  latency up to the newcomer over about twice the difference; the newcomer is
  heard from then on (what it sent before is discarded and counted under
  **Discarded on rejoin**). A newcomer less than about 50 ms later is simply
  waited for.
- **An input that goes silent is left out, not waited for.** After its
  silence limit (three times the input's usual gap between arrivals, 100 ms
  to 2 s; 2 s at start) the module carries a warning, "Input <name> silent
  for <n> ms — continuing without it", and goes on without that input; the
  timing popup keeps listing it, State absent. When the input comes back it
  joins at the current position; what it sends from before that moment is
  discarded, and the popup counts it as **Discarded on rejoin**. A queue
  that fills (5 s) holds the input back and warns
  "Input <name> queue full — upstream held"; nothing is dropped.
- **Dropouts on a mixer input are faded, not cut.** When an input goes
  silent, comes back, ends, or has a hole in its stream, the mix fades its
  sound out over 5 ms and back in over 5 ms, so a loss is heard as a short
  dip rather than a click. The MPEG-TS Muxer's inputs are not touched.
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
- **An input on a link that delivers in bursts now locks its clock 5 minutes
  after every start, keeps its clock rate across the re-locks that follow,
  and no longer trips "Degraded clock: PCR frozen" on the bursts.** On such a
  link (TECH01's relay of the production gate; the gate's own RIST output)
  the input locked only when its first second of delivery happened to land on
  the link's usual level: 3 minutes on a lucky start, 20 minutes or never on
  the others (on the test box, 1 start of 6), showing Acquiring meanwhile;
  and now and then (three times in the recorded hour) a stall in the delivery
  read as a frozen clock, a short glitch each time, which while the input was
  still acquiring held it on Degraded clock for hours. Fixed: on such a link
  the clock now waits the full 5 minutes of its rate window and reads the
  rate over the whole window (within 100 ppm of the link's trend over the
  hour on every replayed start, and no "Source clock off by n ppm" warning on
  any; before, a lucky start could read 100 to 300 ppm off, and a later
  re-lock could take the rate 100 to 200 ppm off for the rest of the run);
  and a clock reference counts as frozen only when its value stops
  advancing, not when the link delivers it slowly. Costs: the lock takes 5
  minutes on such links (clean links still lock in 35 s), and 5 minutes again
  after a reconnect or a fault inside those first 5 minutes. A known limit: a
  source whose clock is genuinely off reads as about zero on such a link and
  raises no warning; the input's delay then creeps (about 0.27 s an hour when
  the source runs 100 ppm fast, taken back with about 1 s cut every 100
  minutes; when it runs slow, a short re-step about every 30 minutes, nothing
  cut). The burst cycle itself is the gate's (#847).
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
  5 s, or as soon as an SRT input's link drops, then "Degraded clock: PCR
  missing", within 12 s on a 2 s reference and 1.5 s on a dense one), jumps,
  or comes irregularly ("PCR comes irregularly: gaps up to n, normally every
  n"). That warning replaces "PCR every n ms (spec ≤ 100 ms)", which a bursty
  link raised on sources whose clock was fine.
- **Audio captures no longer drop sound on a busy box.** On a box working
  near its limit (a Pi 4 showing video on HDMI while it encodes, for one),
  Audio Input (302M) and Audio Encoder could lose 50 to 200 ms of sound now
  and then, up to about a hundred times an hour: each a short gap in the
  stream, counted under Re-locks on the Clock card. The capture ran at
  ordinary priority, competing with everything else on the box. Fixed: it
  now runs at real-time priority, as PipeWire's own audio does.
- **Audio captures keep their timing on a heavily loaded box.** Even with the
  fix above, on a box busy nearly all the time (a Pi 4 showing video on HDMI
  while it encodes and takes two captures, for one), Audio Input (302M) lost a
  short piece of sound about 50 times an hour, each counted under Re-locks on
  the Clock card: the capture's own processing, from the device to the stream
  it sends, ran at ordinary priority and waited for the processor a quarter of
  the time. Fixed: that processing now runs at real-time priority too, just
  below PipeWire's own audio, in Audio Input (302M) and Audio Encoder alike.
  Should the box refuse it, the engine's log says so once and the capture runs
  as before. On an older system image, a box with more than four of these
  modules can run out of real-time grants, and its later captures then lose
  the fix above as well; this release's image has room for many more.
- **Audio captures keep their timing when the box is briefly too busy, and two
  captures of the same input line up exactly.** On a box busy nearly all the
  time, Audio Input (302M) still lost a 43 ms piece of sound a few times an
  hour, and each time its timing went wrong by that much: for 10 seconds, until
  a jump counted under Re-locks set it right, or for some four minutes while
  the Clock card said the device clock was off by about 230 ppm. Two captures
  of the same input also carried the same sound up to 12 ms apart, an amount
  set by how quickly each one started. Fixed: a lost piece is now a gap of
  exactly its length where it was lost, and the timing does not move; fewer
  pieces are lost, as the capture keeps more room for a moment's delay; and
  every capture of an input takes the input's own time, so two of them line
  up to the sample. Audio Encoder captures the same way.
- **An audio capture's timing no longer jumps by 2 s about a minute after it
  starts.** When the audio device behind Audio Input (302M) lost about 2
  seconds of sound and started over (seen on a Pi 4 under test while an engine
  restart brought up video on HDMI), the sound that followed was timed 2
  seconds early for about a minute, until a 2-second jump counted under
  Re-locks set it right (on a capture that was already running, 10 seconds).
  Fixed: the lost time is now a gap of its length where the sound was lost,
  and the timing does not move. Audio Encoder captures the same way. The lost
  sound itself cannot come back.
- **An SRT Input no longer drops pieces of a high-bitrate feed.** At about
  28 Mbit/s an SRT Input lost a small piece of the stream about twice a
  second, on every stream in it, while SRT itself reported no loss: about one
  video frame in ten arrived damaged, more on a busy box. The input's buffer
  held only about 75 ms at that rate, so it overflowed whenever the box was a
  moment late passing the stream on, and a pause by the sender could make it
  overflow at once. Fixed: the buffer holds 4 MB (800 ms at 40 Mbit/s), so the
  stream passes whole through such a delay; only a box that stops passing the
  stream on for longer than that drops data there, and each such stretch is
  logged as a warning in the engine log saying how much. RIST Input, which
  already had that room, now warns the same way.
- **An HLS Player plays a stream that has no master playlist.** Given a
  plain media playlist (one list of segments that carry both the video and
  the audio, as ffmpeg and many encoders write it), an HLS Player never
  played: its card showed "hls-pipe crashed — restarting (attempt …)" over
  and over, and the engine log "inlineAudioLanguages requires a master
  playlist with audio renditions". A master playlist whose video carries its own audio, with no
  separate audio tracks, did the same. Fixed: such a stream plays, its video
  and its audio passed on as they arrive. A master playlist with separate
  audio tracks plays as before, with the Audio Languages picked. On a stream
  without separate audio tracks, Audio Languages has no effect and Subtitle
  Languages are not added: adding subtitles there would drop the stream's
  audio.
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
  as quick as before. A check that still runs out of time, or is stopped by
  the system (when the box runs out of memory, for one), says so, instead of
  reporting GStreamer as missing; a check that crashes still reads as
  GStreamer missing, as before, and the engine's log names the crash. A
  module whose check of the encoders, decoders or 302M support on the box did
  not finish checks again when it starts, instead of going without them until
  the engine restarts.
- **An audio volume above 150 % set with a wider Volume Range now survives an
  engine restart.** On Audio Input (302M) and Audio Output (302M), and on the
  deprecated Audio Input, Audio Output, Audio Encoder and Audio Decoder, a
  volume above 150 % (which a Volume Range of 200, 300 or 500 allows) went back
  to 100 % at every engine restart, while the manager kept showing the value
  set: on a test box an ATEM's audio input set to 500 % ran at 100 % after a
  restart. Fixed: the engine checks a volume against the module's Volume Range
  at a restart, as the manager does when it is set, so the module starts at
  the value set. Lowering Volume Range in a module's settings now brings a
  volume above it down to the new range, saved with it. A volume left above
  its range all the same (in a profile saved before this release, for one)
  starts at the top of the range, and a number setting stored past its
  minimum or maximum, and otherwise valid, starts at that limit instead of
  its default: an Audio Encoder bitrate above 320 kbps with AAC starts at
  320 kbps, as before. A number inside a list (an Audio Transcoder
  rendition's bitrate) is left to its module, as before.
- **A setting changed in the panel but not saved yet is no longer lost when
  another setting of the same module changes.** A setting that applies at
  the module's restart waits in a module's settings panel for Save (typed and
  confirmed, picked from a list or switched). It went back to its saved value,
  without a word, whenever another setting of the same module changed: a live
  setting moved in the same panel (a volume slider), in the module's
  right-click menu or on a dashboard, or a change by someone else. Fixed: what
  you changed stays until you save or close the panel, the other settings
  follow the changes made elsewhere, and Save writes what you changed. A
  setting changed by you and by someone else before you save keeps yours.
  Opening another module in the panel still drops unsaved changes, as before.
- **Device Manager: a change you have not saved yet is kept when the device
  sends its settings again.** The Device Manager page receives the device's
  settings again whenever the connection comes back, when another browser
  saves, and when the Device Manager service restarts. Each time, it used to
  throw away any change you had made but not saved yet. Now your change
  stays, and every setting you did not touch shows the device's value, so
  Save sends your change together with the others. Text you are still typing
  stays in its box, and a new manager profile you have not saved stays too.
  "Settings saved successfully" appears only in the browser that saved. The
  firewall dialog's Close no longer puts back rules that another browser has
  since saved, and one click closes it after a port it refused. On the Logs
  and PTP pages, a box no longer jumps when a message appears under it.
- **A change made on one module's settings is no longer written to another
  module when the panel switches quickly.** A slider in a module's settings
  panel writes as it moves, and some settings (an encoder's bitrate, Audio
  Processing's and Audio Dynamics' controls, a stream URL) wait until you
  stop: the last change went out up to 0.8 s later, to whichever module the
  panel showed by then. Opening another module in that moment wrote your
  change into that module's setting of the same name, or wrote its own value
  again and lost yours. The same could happen with a slider in a module's
  right-click menu, with a fader or slider on a dashboard when the dashboard
  changed under it mid-drag, and with an image still uploading when another
  module was opened. Fixed: a change goes to the module it was made on, at
  once when you move on. An image that finishes uploading after you moved on
  is set on neither module: upload it again on its own.
- **Lowering a Volume Range from a dashboard brings the volume down with
  it, and a setting the manager refuses is shown.** A Volume Range lowered
  under the volume from a dashboard (a dropdown, a button), a script or the
  router's own screen left the volume above the new range, and every Save in
  that module's settings then failed on it without a word: the slider jumped
  back and nothing said why. Fixed: whoever lowers a Volume Range, or picks a
  codec with a lower bitrate limit (AAC on Audio Encoder), the manager brings
  the setting down to the new limit in the same change, as the settings panel
  already did; Save sends only the settings you changed; and a change the
  manager still refuses says which setting and why, at the foot of the
  manager's screen, over a dashboard control, or under a dashboard button.
- **A context-menu or slider change is written once, not twice.** A value
  set in a module's right-click menu (Input Volume, by its slider or typed
  into its box) was sent to the router twice, the same value a tenth of a
  second apart. A slider in a module's settings panel, in its right-click
  menu or on a dashboard did the same when moved and moved back within that
  moment, and a slow drag of a dashboard fader or slider that moves in steps
  sent each value several times. Fixed: each change is sent once.
- **Stream secrets and passphrases no longer appear in the logs.** Each start
  of a RIST input or output wrote its passphrase into the box's log in plain
  text, and an SRT input's or output's passphrase went there the same way, so
  anyone who could read the log, download it from the Device Manager's Logs
  page or open a saved copy could read the stream's secret. Fixed: the box's
  log, the manager's log list and a module's error text show `<redacted>` in
  its place, and the stream still uses the real value. The same holds for a
  password in a URL (`user:password@`), a signed URL's token or signature, a
  stream key in an RTMP URL and an access token. Lines written before the
  update keep what they held until the log rotates. A module's settings still
  show its passphrase to whoever can open them, as before.
- **A listener in Engine Comms can be moved to one address without an
  'address in use' error.** Moving a listener's port from all interfaces to
  one address, or back, was refused with "Could not bind listeners: bind
  EADDRINUSE …" and nothing changed; so was swapping ports or addresses
  between two listeners. Fixed: such a change applies. As with any change
  there, every router reconnects to the manager within about a second:
  meanwhile the manager shows it offline and its modules stopped, though they
  keep running, and its log list in the manager starts afresh. A router that
  reached the manager on that port through another of the manager's
  addresses loses that path until the port moves back (one with another path
  stays connected through it). Applying the listeners unchanged changes
  nothing, and no router reconnects.
- **An SRT passphrase may contain any character.** SRT Input and SRT Output
  handed the passphrase and the Stream ID to the stream as typed, and some
  characters were lost on the way without a word: a `#` or an `&` cut the
  passphrase short (a `#` also lost the Key Length set after it), a `\` was
  dropped, a `%` followed by two of the digits 0-9 and letters A-F became
  another character, a `%` not followed by them left no passphrase at all, and
  a `"` followed by a space stopped the module from starting. Two routers given
  the same passphrase cut it alike and could still connect, while equipment of
  another make refused it as the wrong passphrase; a Stream ID was cut the same
  way. A RIST passphrase was cut at an `&` the same way, and a RIST link's CNAME
  with a space or a comma in it stopped the module from starting (one with an
  `&` was cut).
  Fixed: the passphrase, the Stream ID and the CNAME arrive exactly as typed,
  whatever characters they hold. When you update: a link between two routers
  whose SRT passphrase holds a `#`, an `&`, a `\` or a `%`, or whose RIST
  passphrase holds an `&`, ran on the shortened passphrase until now; update
  both routers together, or the link stops until the second one runs this
  release.
- **Each input keeps one row in the timing popup, and its number.** The
  MPEG-TS Muxer listed a row per stream as well as one per input ("Input 4
  timing: demux_0_video"), numbered afresh at every restart, and an input
  whose source had stopped stayed "present"; N-1 Audio Mixer (302M) and
  Audio Processing listed their internal stages as inputs; and an input
  whose source module was stopped while still connected vanished from a
  mixer's popup with no warning. Now every input has one row, numbered like
  its pin or its place and named by the module feeding it; an input whose
  source stops shows State absent, with the "silent" warning and under
  **Waiting for**; and an input connected while the module runs takes the
  next number, so no other input changes number.
- **The engine's local API answers only the box itself.** The engine's local
  API (port 3001), which the Device Manager's Manager Profile page uses, now
  listens on the box's own loopback addresses (127.0.0.1 and ::1) and nowhere
  else, and refuses any request that does not come from the box itself. It no
  longer sends CORS headers, as no web page calls it. The Device Manager works
  as before. A script that called the API from another computer must now run
  on the box, for example over SSH.

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
