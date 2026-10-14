# ADR-0029: House-clock timing — the engineer's choices, phase by phase

The house-clock timing design, `docs/house-clock-timing-design.md`
(DES-MR-TIMING, v0.7, owner Ivan Slabbert), is the source of truth for how
time is handled in the engine: one house clock per engine, every stream put
on it once at ingest, TAI applied only at the network boundary, nothing after
ingest dropped for being late. Its §13.1 holds the owner's decisions and is
not reopened here. This ADR is the living record the design calls for: it
records the choices the design left to the engineer (§13.3 and the
implementation plan's open-question register), one section per phase, and
it marks what each phase supersedes in the older ADRs. Phase 0 is below;
Phases 1–5 append to this file when they land
(`docs/house-clock-timing-implementation-plan.md`).

Every phase is a cut-over (§13.1): the mechanism a phase replaces is deleted
in the same release, with no engine flag, no legacy arm and no in-app
rollback. Rollback is a previous release from the Device Manager.

## Phase 0 (2026-10-13) — time sync, epoch E, lateness on every module

Nothing in the stream timing changed in this phase: bus PTS, the stamper,
the conditioner and the playout offset D are as ADR-0005 left them (the
current model is frozen, §13.1 Q2). Phase 0 built the measuring instrument.

### Time daemons in the image

- **chrony is the only NTP daemon.** `build/conf/local.conf` installs
  `chrony chronyc tzdata-core` and removes systemd's `timesyncd`
  `PACKAGECONFIG`; the htpdate recipe is deleted
  (`meta-layers/meta-custom/recipes-support/htpdate/`, gone). Why: a box
  needs continuous frequency *and* phase discipline for lateness to mean
  anything between engines, and blocked outbound NTP is no longer a concern
  at any site (§13.1, was Q3).
- **Configuration** (`recipes-support/chrony/files/media-router-chrony.conf`,
  installed as `/etc/chrony.conf`): `makestep 1.0 3` (a step at start only,
  §10.2), `maxslewrate 100` (ppm, matching the PTP presets'
  `max_frequency 100000`; OQ-5),
  `leapseclist /usr/share/zoneinfo/leap-seconds.list` with
  `leapsecmode system` (the kernel TAI offset comes from tzdata's list, and
  the kernel inserts a leap so `CLOCK_TAI` never steps),
  `driftfile /data/chrony/drift` (the rootfs is read-only), `rtcsync` (on
  Linux chronyd clears `STA_UNSYNC` only with it; the engine gates on that
  flag and the Time page shows it, so it stays although the Pis have no
  RTC), and `chronyc` bound to localhost only.
- **No server line in the image.** Servers come from two `sourcedir`
  fragments (OQ-6, the owner: a server list on the Time page, default the
  public pool, DHCP-offered servers accepted too):
  `/data/chrony/sources.d/*.sources`, written by the Device Manager, and
  `/run/chrony-dhcp/<iface>.sources`, written by the NetworkManager
  dispatcher `20-media-router-chrony-dhcp` from `DHCP4_NTP_SERVERS` (option
  42, addresses only) on `up`/`dhcp4-change`, removed on `down`, each
  followed by `chronyc reload sources`. The default fragment
  `pool pool.ntp.org iburst maxsources 4` ships in
  `/usr/share/media-router/chrony/default.sources` and the chronyd drop-in
  copies it into `sources.d/` when that directory is empty, so a fresh
  `/data` syncs to the pool without a setting.
- **chronyd is off where PTP owns the clock** by a *negated condition* in
  its drop-in (`10-media-router.conf`: `ConditionPathExists=!/data/ptp/ptp.env`,
  `RequiresMountsFor=/data`), never by `Conflicts=` on the ptp4l unit:
  systemd applies `Conflicts=` when the job is queued, before conditions,
  which on PTP-off boxes stopped the time daemon and then skipped ptp4l
  (recorded in `media-router-ptp4l.service`). The drop-in's `ExecStartPre`
  lines run with `+` because chrony's stock sandbox makes `/data` read-only.
- **`time-sync.target` still means "the clock is set."** Our own
  `media-router-chrony-wait.service` (`chronyc waitsync 30 0 0 1`,
  `TimeoutStartSec=40`, `Before=time-sync.target`, same condition as
  chronyd) replaces htpdate's ordering. It is `Wants=`, so an offline boot
  completes after the bounded wait; on PTP boxes phc2sys orders the target
  as before. The engine is a *user* unit and cannot order on the target,
  which is why it waits for sync itself (below).
- **PTP writes the kernel TAI offset.** A linuxptp grandmaster announces no
  traceable UTC offset, and ptp4l/phc2sys set the kernel offset only from
  one, so nothing under PTP did (every box measured on 2026-10-12 had
  `tai = 0`, §10.1). The setup script's `ExecStartPre` now runs
  `mr-ptp-settai.py` (ctypes `adjtimex` with `ADJ_TAI`) before it stops
  chronyd: the value is `PTP_TAI_UTC_OFFSET` from `ptp.env` if hand-set
  (no UI; OQ-10), else the last entry of the image's `leap-seconds.list`,
  else 37. It logs `TAI offset set to N (was M)` and always exits 0, like the
  tick check: a missing offset must never keep PTP from running.
- **The displacement record is gone.** The setup script stops chronyd when
  it is active and records nothing; chronyd's condition keeps it off at
  boot and the Device Manager starts it on disable. ADR-0005's notes of
  2026-08-18 (displace and restore) and 2026-08-19 (restore htpdate by
  default) are marked superseded by this section.

### E and the engine (`HouseClock`, `mr-clockstate`)

- **E lives in the engine process, as one latched value.** §4.5 needs every
  network egress of an engine to apply an identical
  `E = CLOCK_TAI − CLOCK_MONOTONIC`. One latch in one process cannot split
  across epochs; a latch per runner could, whenever a step fell between two
  module starts.
  The pipelines never see E — the scheduling clock is still a plain
  monotonic clock with `base_time = 0` (§4.1).
- **A native sidecar measures, the engine decides.** Node cannot read
  `CLOCK_TAI`, call `adjtimex(2)` or arm a `timerfd`; a Node addon would tie
  the dist tarball to the image's Node ABI, while a supervised sidecar is
  the pattern the engine already uses for `mr-tssplit` and `mr-bus-fanout`.
  `packages/engine/native/mr-clockstate` (installed to
  `/usr/libexec/media-router/engine/mr-clockstate`) is stateless: one
  `sample` JSON line per second — E from the tightest of five
  `MONO → TAI → MONO` sandwiches, plus the kernel's `adjtimex` state
  (`STA_UNSYNC`, `tai`, `esterror`, `maxerror`, `freq`, leap state) — and a
  `step` line the moment a `CLOCK_REALTIME` `timerfd` armed with
  `TFD_TIMER_CANCEL_ON_SET` is cancelled. Nanosecond fields are decimal
  strings because E (~1.8e18) is past a JS number's 2^53; the engine keeps
  them as `bigint`. `--once` serves the Device Manager and tests, so the
  page and the engine read the kernel through one implementation. A
  sidecar restart (auto-restart, 1 s to 30 s backoff) never re-epochs: the
  latch is the engine's.
- **The kernel's state stands in for the daemon's** (OQ-7, confirmed by the
  owner). `qualifies(sample) = isSynced(sample) && taiOffsetS >= 10`:
  `isSynced` is `STA_UNSYNC` clear *and* `maxerror` under 1 s
  (`houseClockPolicy.ts`), and 10 s, not 37, shows the TAI offset was set
  without failing at a future leap second (the bound `aes67_clock.py`
  used). Why the `maxerror` bound: linuxptp's `sysclk_set_leap(0)` at each
  ptp4l/phc2sys start clears `STA_UNSYNC` for under a second while
  `maxerror` still sits at the kernel's 16 s limit (measured on .103 and
  .108); on .108 the flag alone latched `reason=start` on a clock 214 days
  wrong. A working daemon stays far below 1 s: ptp4l/phc2sys reset
  `maxerror` to 0–500 µs every second, chrony to a few ms at each update
  (on .50 it peaked at 221 ms before chrony reset it to about 4 ms).
  `isSynced()` is the one test for the gate, the logs and
  `/system/timeSync.synced`. It is daemon-neutral, so chrony and PTP are
  gated alike; chrony's own estimate (`chronyc -c tracking`: reference,
  stratum, `|offset| + root dispersion + root delay / 2`) is *shown* in
  `SystemStats.timeSync.chrony`, never gated on. Consequence, for the
  owner's veto: the kernel grows `maxerror` by 500 ppm between updates, so
  a box that loses its NTP uplink turns untraceable 16–33 min after the
  last one (it took 8.9 h to reach the 16 s limit), and a chrony source
  with a root distance above about 0.47 s would flip `traceable` off and on
  at every poll at the default `maxpoll 10` (1024 s).
- **The start wait.** `Engine.start()` starts `HouseClock` before the
  plugins load, and `ModuleRunController.start()` awaits `ready()`:
  resolved on the first qualifying sample (`latch(start)`) or 30 s after
  engine start with a warning,
  `no time sync after 30 s … — starting untraceable` (`latch(timeout)`).
  The timer runs from engine start, so a later module start is not
  delayed. The manager link, the local API, the LCP and the router tree
  come up at once and show
  `waitingForSync`/`waitRemainingS`. On a box without the sidecar (a dev
  host without `make native`, or the Phase 0 app on an older image —
  R-P0-7) the clock logs one error, `ready()` resolves at once with no
  epoch, `sidecar: false`, and modules are never held.
- **Re-epoch policy** (`houseClockPolicy.ts`, a pure decision table):
  - divergence tolerance **1 ms**: E is constant under slew, sandwich noise
    is a few µs, and 1 ms is far below a frame; above it a traceable epoch
    re-latches on the next sample (`relatch(step)` when the sidecar reported
    a step, `relatch(divergence)` otherwise), each with `seq + 1` and an
    `epoch` event;
  - **one re-epoch per boot step**: while the epoch is untraceable, a move
    of E whose sample does not qualify is held (`settle`) and latches once,
    when the state qualifies or after 10 s (`SETTLE_MAX_MS`): as `step` if a
    step line came since the move, else as `sync` or, at the cap,
    `divergence`. Why: on .50 chrony's boot step, its TAI write (E +37 s)
    and the sync came within 3 s and gave two re-epochs, two flagged
    discontinuities where Q15 describes one; 10 s is three times that and
    bounds how long a stale E stays when no sync follows (a date or TAI
    offset set by hand, no daemon). Consequence: a step on an untraceable
    epoch waits up to 10 s, where §10.3 says "at once". Phase 0's only
    reader of E, aes67-output, free-runs on an untraceable epoch, so the
    wire does not change;
  - a REALTIME step that leaves E within tolerance (a kernel leap insert:
    REALTIME repeats, TAI does not) is logged `realtime step, E unchanged`
    and does not re-epoch;
  - sync arriving after an untraceable start re-latches only if E moved
    (`relatch(sync)`, or `relatch(step)` when a step came first, as with
    .108's PTP step at 66 s); otherwise it only flips `traceable`;
  - loss of sync after a latch flips `traceable` false and keeps E;
  - **a TAI-offset change is a divergence, never a step** (R-P0-5,
    settled): `ADJ_TAI` sets only the kernel's TAI offset, and
    `timerfd_clock_was_set` cancels a `TFD_TIMER_CANCEL_ON_SET` timer only
    when REALTIME − MONOTONIC changed, so `mr-ptp-settai.py` yields no
    `step` line and E moves by the TAI step on the next 1 Hz sample
    (captured on .50, `clockstate-tai-late.jsonl`). That replaces WI-P0-3's
    acceptance "settai also yields a step line". On an untraceable,
    unsynced engine the log reads `E moved 37000.000 ms while untraceable —
    holding the epoch up to 10 s for sync`, then `re-epoch … reason=sync`
    if sync lands within the 10 s, else
    `reason=divergence ΔE=37000.000 ms`; with the kernel already synced,
    `reason=sync` comes at once;
  - pinned by four raw `mr-clockstate` captures from 10.9.16.50, a chrony
    box rather than the plan's gate boxes
    (`packages/engine/src/clock/fixtures/`, provenance in `PROVENANCE.md`),
    each fed through the sidecar's stdout path in `HouseClock.test.ts`:
    synced (one `start` latch, E within 10 µs), date-step
    (`relatch(step)`, ΔE 2 s), tai-late (`relatch(divergence)` at the cap,
    ΔE 37 s) and offline-boot (the `timeout` latch, then one
    `relatch(step)`).
- **Who owns the clock** is polled every 10 s, unprivileged:
  `systemctl is-active chronyd.service media-router-ptp4l.service` →
  `ptp` (ptp4l active wins, since the setup stops chronyd), `chrony` or
  `none`. Each (re-)latch names its source.
- **Where it shows.** `SystemStats.timeSync` (`packages/shared-types/src/timeSync.ts`:
  source, synced, traceable, TAI−UTC, errors, frequency, wait, epoch seq,
  reason and ISO time, E as a string) goes to `/system/timeSync` in the
  router tree and to the manager, and `features` gains `house-clock` so a
  manager tells new engines from old; the engine card and header show a
  clock indicator (green traceable, amber waiting or synced-but-TAI-unset,
  red unsynced) with the detail (source, error, TAI−UTC, chrony reference,
  epoch number, reason and time) in its tooltip
  (`packages/manager-ui/src/utils/engineClock.ts`). On the sidebar card the
  tooltip is a teleported `MrHelpTip`, because the sidebar scrolls
  (ADR-0022): hover or focus opens it, a click pins it without following the
  row's link.
- **`aes67-output` is the only reader of E in Phase 0.** Its RTP
  `timestamp-offset` is `rtpTimestampOffset(eNs)` (`aes67Helpers.ts`, the
  same integer arithmetic the deleted `aes67_clock.py` ran); it claims the
  PTP epoch only while `traceable`, free-runs with the reason shown
  otherwise (`aes67Epoch.ts`; the reason follows the clock, not the last
  start), and restarts on the `epoch` event so a re-epoch is one
  discontinuity. That retires the stale claim in the design's §11.6: the
  engine's E does detect a step. The restart is one stop and one start,
  with no queue: the clock listeners are off from the stop's first line to
  the end of the start, and the start reads E afresh, so a move during the
  restart lands in it (on the default in-process runner no event-loop turn
  passes between that read and the listeners coming back). The self-restart
  token is consumed on entry to `onStop`, as in `audio-transcoder`, so an
  engine stop that lands mid-restart is not revived.

### Lateness on every module (`mrts::LatenessWindow`, `mrlateness`)

- **One accumulator, native only.** `plugins/mpegts-core/native/mrts/lateness.*`
  (`LatenessWindow`: `add`, `add_untimed`, `due`, `take` → count, untimed,
  min, max, mean, last) is compiled into the `mrlateness` element,
  `mr-tssplit` and `mr-bus-fanout`, so a window means the same thing
  everywhere. There is no Python twin: a per-buffer python probe cost
  0.5–0.7 of a core per producer on a Pi 4 (`gstmrtsstamp.cpp` header).
- **The window is 2 s**, the module stats cadence, and the reporter ticks
  at the same 2 s. A tap that has not reported for three windows is dropped
  from the display (an input removed, or dark).
- **The tap is a plain `GstElement`, not a `GstBaseTransform`**, with a
  `chain` and a `chain_list`: basetransform would dismantle the per-AU
  buffer lists `mpegtsmux alignment=7` emits and regress the ADR-0011
  coalescing. Per buffer (per list: its first buffer) a bus tap costs one
  `clock_gettime` and a few adds; a running-time tap before a sink adds one
  element-clock read (`gst_element_get_current_running_time`: object lock,
  clock ref, a second time read). No allocation on the hot path either way.
- **Placement and the `reference` rule.** Three kinds of point, two
  references:
  - every bus ingress: `buildBusSrc()` names `mrlateness` as `lat_busin…`
    with `reference=house` *before* the ingress queue, so it reads arrival;
    a dynamic `bus_input_add` gets it from the same string;
  - every bus egress: `buildBusSink()` names it `lat_busout_<port>` with
    `reference=house` after the `capssetter ! capsfilter` pair and before
    the `busout_*` tee, i.e. after the `mrtsstamp` splice, so it reads the
    stamped PTS every consumer receives;
  - immediately before an output module's final sink:
    `withLatenessTap('lat_render' | 'lat_egress', sink)` with
    `reference=running-time`.

  `house` compares raw buffer PTS with `CLOCK_MONOTONIC`, the bus convention
  (§4.3), and stays correct in `liveCaptureClock` pipelines whose running
  time is not house time; `running-time` compares segment running time with
  the element clock, which is what a sink renders against.
- **Transport.** The element posts an `mrlateness` element message per
  window (`count`, `untimed`, `min-ns`, `mean-ns`, `max-ns`, `last-ns`,
  `interval-ns`, `reference`) from the streaming thread, only when the
  window had buffers. Both runners load `libgstmrlateness.so` by path at
  start (`/usr/libexec/media-router/mpegts-core/`, never `GST_PLUGIN_PATH`)
  and forward the message as the plugin event `mrlateness:<element name>`
  with no `busReports` subscription, so inputs added at runtime report. The
  sidecars put `"lateness": {count, untimed, min, mean, max}` (ms) in their
  stats line, one window per output tee in `mr-tssplit`.
- **Missing instrument.** `latenessTapAvailable()` checks for the `.so`
  once per process; when it is absent the fragments omit the element, so no
  pipeline fails to parse, and the module's `timing` section reads
  `lateness instrument missing`. Pipeline-string tests pin it present
  (`vitest.setup.ts`).
- **What is shown** (`LatenessReporter`, `timingSections.ts`; ADR-0007:
  plugins compute, UI renders); every row carries its label and unit:
  - a `timing` section with Output lateness (mean, min–max; several egress
    taps merged count-weighted), Added latency (output mean − the slowest
    input's mean), Slowest input (with two or more inputs — the Phase 0
    stand-in for "which input it waits for"), and for outputs Decode
    (`λ(render) − λ(slowest input)`), Presentation delay (the sink's live
    `ts-offset`, re-read every 10 s), Device latency and Render lateness
    `= max(λ(render), D) + device` while sinks still wait for D (it becomes
    `λ + device` in Phase 4);
  - Device latency is `buffer-time` on audio base sinks and one refresh of
    the mode a video output is driven at (`TimingSink.refreshHz`, which
    video-player resolves from weston.ini's `mode=` — `WxH@rr` or a
    modeline — else the EDID preferred timing, and from the EDID alone under
    kmssink). With no mode known it is 60 Hz and the row reads
    `Device latency (60 Hz assumed)`. Why: the fleet's 50 Hz modes read
    3.3 ms low at a fixed 60 Hz, and device-manager writes `mode=preferred`
    by default, so weston.ini alone rarely names a rate;
  - one `timing-in-<n>` section per input, labelled by the module feeding
    it, `<source module> (<sink port>)`. `n` is the input's fixed place
    among the module's inputs: bus inputs by sink port (numeric-aware), then
    connection id, or the module's own `timingInputs` where its taps are
    named per branch (mpegts-muxer: the pin number). Why: dashboards bind
    by section id (ADR-0026), so a widget on `timing-in-2` must never switch
    input. Consequence: a dark input's section goes and leaves a gap; a
    stopped producer keeps its place until this module restarts, which
    re-derives the numbers; an input added while it runs sorts into place
    and can move later numbers;
  - one `timing-out-<n>` section per output tee (Lateness, min–max) on
    modules with two or more bus outputs (ts-splitter, a multi-rendition
    transcoder), beside the `timing` section's count-weighted merge. Why:
    each consumer's input lateness is its own output's, which the merge
    hides, so the added latencies along a route could not sum (V10). `n` is
    the output's place among the outputs reporting, by tap name, so unlike
    an input a dark output moves the numbers after it;
  - a grey `lateness` face badge: render lateness on outputs, PipeWire
    latency on PipeWire-graph modules, the output lateness mean otherwise.
    Why: render lateness says when the content is seen or heard (§9.5), and
    a PipeWire-graph module has no PTS lateness to show;
  - PipeWire-graph modules (audio-input, audio-output, n1-mixer,
    audio-dynamics) carry no PTS and show the worst `PipeWire latency` of
    their nodes (`pw-dump`, polled every 10 s): one cycle of the node's
    driver group (its smallest `node.latency` request, else
    `clock.quantum`, clamped and rounded per pipewire.conf(5); a forced
    quantum wins) plus the node's own `Latency` param. Why the group: an
    `MR_PW` null sink requests nothing, so its own request read the graph
    default (21.3 ms) while its group ran at 512 samples. The test fixture
    and the `pw-top` check (both drivers at 512/48000) come from fleet box
    10.9.16.22, not a gate box (`packages/engine/src/audio/fixtures/`); the
    gate comparison is open (below).
- **Display only.** No threshold, no warning, no setting (OQ-8, the owner:
  a feel for the numbers first). The option recorded for later is a
  relative alarm — output lateness more than 500 ms above the module's
  settled value for 10 s — plus an optional absolute cap; it would warn
  and never drop (§9.5).
- **Two guards.** State is emitted only when a displayed value moves by
  ≥ 1 ms or a row comes or goes, bounding manager traffic with 30 modules
  (R-P0-6). A window whose |mean| is ≥ 1 h is not on the house timeline at
  all (a producer egress reads raw mux PTS until its first consumer arms
  the stamper) and is dropped rather than shown as lateness.

### Device Manager

- The PTP page is the **Time** page (`/time`; `/ptp` redirects; OQ-9). A
  Clock card shows the owner (`ptp` when `ptp.env` exists and ptp4l is
  active, else `chrony` when chronyd is, else `none`), synced, estimated
  and maximum error, frequency, leap state, the kernel TAI−UTC in red with
  "kernel TAI offset not set — CLOCK_TAI equals UTC" when 0, chrony's
  tracking and sources, and the **NTP servers** list. The kernel view is
  `mr-clockstate --once`; the chrony view is `chronyc -c tracking` and
  `chronyc -c sources`, parsed from CSV.
- **The server list** (`TimeConfig.ts`): 1 to 8 entries, each a host name
  or an IP literal; a name renders `pool <name> iburst maxsources 4`, an
  address `server <addr> iburst`, into
  `/data/chrony/sources.d/media-router.sources`, written atomically, then
  `chronyc reload sources`; a no-change save touches nothing. The file on
  `/data` is authoritative and `config.json` carries no copy, as with
  `ptp.env`. DHCP-offered servers are listed read-only beneath it, read
  from the dispatcher's `/run/chrony-dhcp/*.sources` fragments: `chronyc`
  has no provenance column and answers nothing under PTP.
- **PTP on/off is a two-daemon switch.** Enable stops chronyd before
  restarting ptp4l; disable stops the PTP units, removes `ptp.env` and
  starts chronyd. The stale `/data/ptp/displaced-time-services` of older
  builds is removed once on load.

### Deleted in this phase (OQ-4: the kill switch goes in Phase 0)

`MR_TIME_SYNC_CONTRACT` and `EngineConfig.timeSyncContract`;
`ClockAuthority.ts` and `gst-net-clock.py` (the legacy shared net clock);
`PipelineDescription.clockSync`, `clock`, `ClockConfig` and
`timeSyncContract`; the runners' net-clock branches and the native
runner's `clock` ineligibility; the audio-decoder `clockSync` setting (its
stored value is ignored, Q9); `aes67_clock.py` and its test; htpdate and
systemd-timesyncd; the PTP displacement block, record and restore logic.
Why now: Phase 0's lateness and E assume `base_time = 0` on a monotonic
clock in every pipeline (§4.1); with the switch off, `now − PTS` measured
nothing. ADR-0005 decision 10's flag text is thereby historical; it is left
as written (Q2) and this section is its correction.

### Open until the fleet check (plan chapter 4 part 11)

Recorded here so the gate run (WI-P0-14) knows what to confirm; none was
verifiable on a development host:

- `leapseclist` with an expired `leap-seconds.list` (R-P0-2): if chrony
  ignores it the TAI offset stays 0 and the box never becomes traceable.
  Fallback: `leapsectz right/UTC` with only `zoneinfo/right/UTC` installed.
- The dispatcher variable name `DHCP4_NTP_SERVERS` on a lease carrying
  option 42.
- On a cold online boot chrony syncs inside the 30 s wait, and sync
  follows a restored uplink within about 10 s. V1 on .50 and .211
  (2026-10-14) saw the wait run out first: the dispatcher ran no
  `chronyc onoffline` then, so chrony retried its first failed resolve
  only after 28 s.
- `mr-ptp-settai.py` with the engine up on .103 or .108: no `step` line,
  then the hold and `re-epoch … ΔE=37000.000 ms` above (R-P0-5).
- The PipeWire latency row of one audio-input or audio-output against
  `pw-top` QUANT/RATE on .103 or .108; so far checked on 10.9.16.22 only.

Settled on the fleet, 2026-10-14:

- linuxptp clears `STA_UNSYNC` and leaves the hand-set TAI offset alone
  (R-P0-3): V8 on .103 and .108 (ptp4l up 1.4 h and 4.4 h) read synced
  with `maxerror` 0–500 µs, TAI−UTC 37 and the engine traceable with
  `source=ptp`. Neither fallback is needed; linuxptp's start-up window is
  what the `maxerror` bound covers.
- An `ADJ_TAI` change does not cancel the `timerfd` (R-P0-5): the
  divergence path, above.
