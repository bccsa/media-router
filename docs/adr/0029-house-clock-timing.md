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
  `driftfile /data/chrony/drift` and `rtcsync` (the rootfs is read-only),
  and `chronyc` bound to localhost only.
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
  page and the engine judge sync by one implementation. A sidecar restart
  (auto-restart, 1 s to 30 s backoff) never re-epochs: the latch is the
  engine's.
- **The kernel's state stands in for the daemon's** (OQ-7, confirmed by the
  owner). `qualifies(sample) = synced && taiOffsetS >= 10`: `STA_UNSYNC`
  clear and a TAI offset that was evidently set (10 s, not 37, so a future
  leap second does not fail the check — the bound `aes67_clock.py` used).
  It is daemon-neutral, so chrony and PTP are gated alike; chrony's own
  estimate (`chronyc -c tracking`: reference, stratum,
  `|offset| + root dispersion + root delay / 2`) is *shown* in
  `SystemStats.timeSync.chrony`, never gated on.
- **The start wait.** `Engine.start()` starts `HouseClock` before the
  plugins load, and `ModuleRunController.start()` awaits `ready()`:
  resolved on the first qualifying sample (`latch(start)`) or 30 s after
  engine start with a warning,
  `no time sync after 30 s … — starting untraceable` (`latch(timeout)`).
  The timer runs from engine start, so a later module start is not delayed. The manager link, the local API, the
  LCP and the router tree come up at once and show
  `waitingForSync`/`waitRemainingS`. On a box without the sidecar (a dev
  host without `make native`, or the Phase 0 app on an older image —
  R-P0-7) the clock logs one error, `ready()` resolves at once with no
  epoch, `sidecar: false`, and modules are never held.
- **Re-epoch policy** (`houseClockPolicy.ts`, a pure decision table):
  - divergence tolerance **1 ms**: E is constant under slew, sandwich noise
    is a few µs, and 1 ms is far below a frame; above it the next sample
    re-latches (`relatch(step)` when the sidecar reported a step,
    `relatch(divergence)` otherwise), each with `seq + 1` and an `epoch`
    event;
  - a REALTIME step that leaves E within tolerance (a kernel leap insert:
    REALTIME repeats, TAI does not) is logged `realtime step, E unchanged`
    and does not re-epoch;
  - sync arriving after an untraceable start re-latches only if E moved
    (`relatch(sync)`, e.g. the TAI offset set late moves E by 37 s);
    otherwise it only flips `traceable`;
  - loss of sync after a latch flips `traceable` false and keeps E.
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
  red unsynced) with the detail in its tooltip
  (`packages/manager-ui/src/utils/engineClock.ts`).
- **`aes67-output` is the only reader of E in Phase 0.** Its RTP
  `timestamp-offset` is `rtpTimestampOffset(eNs)` (`aes67Helpers.ts`, the
  same integer arithmetic the deleted `aes67_clock.py` ran); it claims the
  PTP epoch only while `traceable`, free-runs with the reason shown
  otherwise (`aes67Epoch.ts`), and restarts on the `epoch` event so a
  re-epoch is one discontinuity. That retires the stale claim in the
  design's §11.6: the engine's E does detect a step.

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
  coalescing. One `clock_gettime` and a few adds per buffer (per list: its
  first buffer); no allocation on the hot path.
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
  plugins compute, UI renders): a `timing` section with Output lateness
  (mean, min–max; several egress taps merged count-weighted), Added
  latency (output mean − the slowest input's mean), Slowest input (with two
  or more inputs — the Phase 0 stand-in for "which input it waits for"),
  and for outputs Decode (`λ(render) − λ(slowest input)`), Presentation
  delay (the sink's live `ts-offset`, re-read every 10 s), Device latency
  (`buffer-time` on audio base sinks; one 60 Hz refresh for video) and
  Render lateness `= max(λ(render), D) + device` while sinks still wait
  for D (it becomes `λ + device` in Phase 4); one `timing-in-<n>` section
  per input; a grey `lateness` face badge with the mean in ms. Every row
  carries its label and unit. PipeWire-graph modules (audio-input,
  audio-output, n1-mixer, audio-dynamics) carry no PTS and show the worst
  `PipeWire latency` of their nodes (`pw-dump`: one graph cycle plus the
  node's `Latency` param, polled every 10 s).
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
  `ptp.env`. DHCP-offered servers are listed read-only beneath it.
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
- linuxptp clears `STA_UNSYNC` and leaves a hand-set TAI offset alone
  (R-P0-3). Fallbacks: the tick-check timer re-asserts TAI;
  `qualifies()` treats `source=ptp` with a running ptp4l as synced.
- Whether an `ADJ_TAI` change cancels the `timerfd` (R-P0-5). Either way
  the 1 ms divergence poll catches it within 1 s; the path that fired on
  the gate goes here.
- The dispatcher variable name `DHCP4_NTP_SERVERS` on a lease carrying
  option 42.
