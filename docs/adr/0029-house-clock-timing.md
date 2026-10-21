# ADR-0029: House-clock timing — the engineer's choices, phase by phase

The house-clock timing design, `docs/house-clock-timing-design.md`
(DES-MR-TIMING, v0.7, owner Ivan Slabbert), is the source of truth for how
time is handled in the engine: one house clock per engine, every stream put
on it once at ingest, TAI applied only at the network boundary, nothing after
ingest dropped for being late. Its §13.1 holds the owner's decisions and is
not reopened here. This ADR is the living record the design calls for: it
records the choices the design left to the engineer (§13.3 and the
implementation plan's open-question register), one section per phase, and
it marks what each phase supersedes in the older ADRs. Phase 0, the shared
TS module (S0) and Phase 1 are below; Phases 2–5 append to this file when
they land (`docs/house-clock-timing-implementation-plan.md`).

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
  (§4.3); `running-time` compares segment running time with the element
  clock, which is what a sink renders against. Corrected 2026-10-16: the
  draft said `house` stays correct in `liveCaptureClock` pipelines. At a bus
  egress it does not: the stamper writes running time (stamp − base time),
  so video-encoder's `lat_busout` tap reads its base time plus the encode
  latency (measured in Phase 1, open there). Ingress taps on base-0
  pipelines are unaffected.
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

## The shared TS module (S0, built 2026-10-13 to 2026-10-15) — TS timing implemented once, natively

S0 is not a phase: it ships with Phase 1, inside the Phases 1–4 release
(plan chapter 3). It is a C++17 core with no GStreamer,
`plugins/mpegts-core/native/mrts` (archive `libmrts.a`), and one GStreamer
plugin, `plugins/mpegts-core/native/mrtshouse/libgstmrtshouse.so`, that both
runners load by path. Everything that reads or writes timing in a transport
stream is implemented there once (§11.5, §13.1): the packet walk, PSI, PES
reassembly on every PID, PCR read and write, the PES header rewrite, the
33-bit unwrap and the 1 h formula. Its users are the ingest restamp
(Phase 1, built), the splitter pass-through (Phase 2), the formula demux
(Phase 3) and the egress writer (Phase 5). The file list is in
`plugins/mpegts-core/README.md`.

### The API (plan chapter 3 part 4.2; the headers are the contract)

- **`ts_house.h`, the timescales.** `PTS_WRAP`, `MUX_CLOCK_BASE_90K` (1 h),
  `PCR_HZ`, `PCR_MODULO`, `PCR_MAX_INTERVAL_NS` (40 ms); the unit
  conversions with floor division, as Python's `//`, exact for TAI-scale
  values; `fold33`, `unwrap_near`; the bus formula `house_from_mux_pts` and
  its inverse `mux_pts_from_house`. `Unwrapper` is the continuous per-stream
  unwrap: seeded once, then each value nearest the previous; a DTS is
  unwrapped nearest its own PES's PTS, never on its own (the a1 wrap fault,
  §6), and a DTS more than 5 s from it is discarded and counted.
  `NetEpoch`, `bus_to_net`, `net_to_bus` and `net_pcr27` hold the network
  boundary for Phase 5.
- **`ts_packet.h`, the packet walk.** `PacketView`, `parse_packet`,
  `PacketWalker` (carries a packet split across feeds, resyncs by
  `ts_split`'s rule and counts the bytes skipped; a packet joined across
  feeds is handed out of the walker's own buffer), and `CcTracker`
  (ISO 13818-1 2.4.3.3: adaptation-only packets never advance CC, one
  duplicate is legal, `discontinuity_indicator` resets).
- **`ts_pes.h`, PES headers and reassembly.** `parse_pes_header` (lenient, as
  the three readers it replaced; stream ids without an optional header give a
  6-byte header), `write_pes_ts_field`, `rewrite_pes_timestamps`;
  `PesHeaderSpan` for rewriters, which holds one PUSI packet per PID whose
  header spills into that PID's next payload packet, rewrites both and
  releases them in order, other PIDs never delayed; `PesAssembler`, every
  selected PID, bounded and unbounded PES, a 32 MB cap per open unit
  (counted, R9), a CC loss drops the open unit, `keep_payload = false` gives
  the header index without a copy.
- **`ts_pcr.h`.** `read_pcr`, `write_pcr`, `set_discontinuity_indicator`,
  `build_pcr_packet` (with a discontinuity flag) and `PcrScheduler`, which is
  due before the first PCR too, so a Phase 5 egress gives a PCR-less source
  one.
- **`ts_psi.h`, generalised.** The descriptor walk, `registration_format`,
  `has_descriptor`, `Pmt::version` and `program_info`, multi-packet sections
  (`build_pmt_section`, `packetise_section`), and on `PsiDiscovery`
  `select_program`, `generation` (bumps on every PMT change) and
  `unsupported_sections` (sections other than 0 are counted, not parsed;
  R1, now visible). Two latent bugs found on the way are fixed: on a PMT PID
  the PAT maps to several programs, a PMT counts only for its own
  `program_number`; and only section 0 of a table is parsed.
  `read_pes_pts` stays in `ts_psi.h` as an inline forwarder until its last
  caller goes in Phase 3.

### Choices (plan chapter 3 part 4.5, as built)

1. **No Python twin at runtime.** `mrtsrestamp` and `mrasrc` have no Python
   fallback, and nothing new is twinned. New timing code is prototyped in
   Python and ported once it is right; the Python under
   `plugins/mpegts-core/py` stays as the reference and its `test:py` suites
   keep running (the owner's rule, OQ-1). The frozen paths that still import
   it at runtime (the anchored stamper's Python probe,
   `unixfd-fanout.py --stamp-timeline`, branch alignment and retime) stop in
   Phases 2 and 3, with the mechanisms they serve (plan chapter 3 part 6.2).
   Test harnesses that drive a native element over appsrc/appsink are
   allowed. **This amends ADR-0001's consequence** "the python is the
   executable specification" to: the Python is the reference; only the C++
   runs.
2. **One PIC archive, one link form.** `libmrts.a` is built with
   `override CXXFLAGS += -fPIC`, so a command-line `CXXFLAGS`
   (`build-native-dev.sh`) cannot make it non-PIC. Every user links it:
   `mrtsstamp`, `mrpeshouse`, `mrlateness`, `mrtshouse`, `mr-gst-runner`,
   `mr-tssplit` and `mr-bus-fanout`, each through a `libmrts.a: FORCE` rule
   that lets the mrts Makefile decide whether the archive is stale. No tool
   compiles `mrts/*.cpp` into itself any more, so ADR-0002's exception 3 and
   ADR-0019's "sources compiled in" now read "links `libmrts.a`"; the
   dependency and its condition (no TS arithmetic in the runner) are
   unchanged.
3. **One plugin, many elements.** `libgstmrtshouse.so` registers each
   house-clock element from one table, `kFactories` in `gstmrtshouse.cpp`,
   at rank NONE, because the runners place them by name: `mrtsrestamp` and
   `mrasrc` in Phase 1. Every element carries the plugin's common properties:
   a read-only `abi`, and chapter 3 part 10's eight counters (`desync-bytes`,
   `cc-lost`, `pes-oversize`, `pes-dropped-cc`, `header-spans`,
   `psi-unsupported-sections`, `pes-no-pts`, `dts-discarded`), each a running
   total since the element started, 0 where the element keeps no such count.
4. **A version-checked load.** `mrtshouse_abi.h` sets `MRTSHOUSE_ABI` 1 and
   `MRTSHOUSE_VERSION` "1.0.0". Each runner has `MRTSHOUSE_MIN_ABI` 1
   (`native_plugins.h`, `gst_native_plugins.py`; a test pins the two, the
   alarm sentence and the element tables equal) and reads the loaded
   plugin's ABI from an element's `abi` property. A plugin below the minimum
   is refused and removed from the GStreamer registry, and no later
   candidate is tried, because its types would collide in the process: a
   stale copy under `/opt` masks a good one in libexec, and the alarm names
   its path. No plugin of ABI 1 has shipped, so `mrtsrestamp` and `mrasrc`
   joined it without a bump; from the release on, a change a runner or the
   engine relies on bumps it together with both runners' minimum.
5. **Behaviour-preserving moves.** The pure functions moved out of
   `ts_timeline` and `ts_psi` unchanged in behaviour: differential runs
   (`read_pes_pts` over 1,163,520 packets; the conditioner's rewrite) found no
   difference. The conditioner's split-header quirk (PTS rewritten, DTS not,
   when a PUSI packet carries 14–18 payload bytes) is kept byte for byte,
   because the frozen model still runs it (Q2).
6. **A missing or stale plugin starts the module and alarms** (the owner's
   decision on C-1). Both runners load the plugin once per process, before
   the first parse, and log `native plugin mrtshouse <version> abi <n> from
   <path>`. On a miss or a stale ABI they emit a `warning` of kind
   `timing_plugin` (`detail`: the tried paths, or `abi N < MIN: <path>`),
   rewrite the start description with a gst-launch tokenizer so each
   element of the table becomes its stand-in with only its `name=` kept
   (`mrtsrestamp` becomes `identity`), and answer a `set_property` on a
   stand-in with a warning. `mrtsdemux` has no stand-in: a description naming
   it is refused with an `error` carrying the same text. The engine shows
   "Native TS module not loaded: this stream carries no house time on the
   bus; consumers will mis-time it until the deploy is fixed." with the
   detail (`timingPluginAlarm.ts`) and keeps it until a start whose
   `started` event reports the plugin loaded (`timingPlugin`). Only the
   start description is rewritten: a `bus_input_add` or pad-link fragment
   naming a timing element fails to parse (Phase 2 decides what that does to
   a fan-in). As built, the alarm shows on every GStreamer module whose
   runner cannot use the plugin, not only on modules naming a timing
   element; narrowing it is a small change if the owner wants it.

### Budget (WI-S0-11)

On a Pi 4, one core, `-O2`: the walk, header index and in-place rewrite at
most 1.0 µs per packet, full reassembly with copy at most 2.0 µs per packet
(0.7 % and 1.3 % of a core at 10 Mbit/s). `tests/mrts_bench` times the three
passes over a capture; `--wrap-at <s>` moves its timestamps so a 33-bit
wrap lands that far in (R19). On the dev Pi 5 (aarch64, GCC 12) it read
17.6, 41.1 and 58.8 ns per packet on `v1/output.ts`, and 36.4, 54.0 and
96.3 ns on 300,000 packets of the OCC capture: about a twentieth of the
Pi 4 budget.

**On the Pi 4 (10.9.16.108, 2026-10-16) every fixture is inside the
budget**: the rewrite pass at most 153 ns per packet (15 % of its budget),
the reassembly at most 268 ns (13 %), over every fixture of plan chapter 3
part 7.2 that exists (the vMix capture does not, OQ-3), `v1/output.ts` and
300,000 packets of the OCC capture, at 188, 1,316 and 24,064-byte chunks.
At 10 Mbit/s that is 0.10 % and 0.18 % of a core, at 30 Mbit/s 0.31 % and
0.53 %. The box ran a Cortex-A72 at a fixed 1.5 GHz with the Phase 1
development build beside the bench at 6–14 % per core. The binary was built
on the dev box from 263bdcd7 with the Makefile's `-O2 -fPIC` (generic
armv8-a) and pinned to one core. Each figure below is the median of three
runs at 1,316-byte chunks, each run the median of at least five passes; the
last column is the worst run at any of the three chunk sizes. The same
binary on the dev Pi 5 today reads 10.6, 29.8 and 51.5 ns on
`v1/output.ts` and 25.2, 32.0 and 59.2 ns on the OCC capture: the Pi 4
takes 1.9 to 3.3 times as long, and 4.3 times for the copy-bound reassembly
of the 28.6 Mbit/s OCC feed. `--wrap-at` on the box (8 s into the OCC
capture, 0.3 s into its fixture): every PID that crossed the wrap kept a
continuous unwrapped PTS, its largest step 360 ms, the stream's own spacing.

| Input | Packets | Walk | Rewrite | Reassembly | Worst rewrite / reassembly |
|---|---:|---:|---:|---:|---:|
| `cap-occ-1080i-h264-aac-ttx` | 10,638 | 51.6 | 64.4 | 201.7 | 70.2 / 209.3 |
| `cap-mux-unbounded-video` | 10,638 | 54.1 | 65.7 | 204.7 | 69.9 / 216.6 |
| `cap-mux-align7-aac-opus` | 3,191 | 38.7 | 120.2 | 206.4 | 128.1 / 222.5 |
| `cap-cc-loss` | 3,185 | 40.2 | 121.2 | 206.8 | 127.3 / 219.3 |
| `cap-302m-bssd` | 10,638 | 53.7 | 70.8 | 112.4 | 76.0 / 128.0 |
| `cap-klv-sparse` | 1,729 | 24.7 | 141.2 | 147.0 | 153.1 / 163.7 |
| `cap-srt-ingest-1316` | 10,633 | 53.0 | 71.6 | 188.3 | 77.0 / 202.9 |
| `syn-mpts-two-programs` | 7,203 | 73.1 | 93.6 | 168.0 | 120.9 / 213.1 |
| `syn-wrap-33bit` | 5,330 | 55.3 | 102.3 | 237.5 | 110.1 / 264.8 |
| `syn-pes-header-split` | 687 | 26.5 | 117.3 | 240.1 | 126.2 / 261.0 |
| `syn-pes-no-pts` | 204 | 23.9 | 119.4 | 214.5 | 125.8 / 225.9 |
| `syn-source-restart` | 2,894 | 35.6 | 92.2 | 231.0 | 100.9 / 241.4 |
| `v1/output.ts` | 2,734 | 34.6 | 79.8 | 142.7 | 93.1 / 156.0 |
| OCC capture, first 300,000 packets | 300,000 | 46.9 | 61.2 | 255.5 | 68.2 / 267.7 |

ns per packet; budget 1,000 for the rewrite, 2,000 for the reassembly.

**In the pipeline the restamp costs more than today's stamper and
conditioner**, so V-P1-10's criterion is not met as measured (2026-10-16,
.108). One srt-input with one consumer, an mpegts-ip-output to a local
port, so the egress stamper is armed, fed by a paced SRT caller on the dev
box: the OCC capture (28.6 Mbit/s: 1080i H.264 at 20 Mbit/s, 21 AAC PIDs,
teletext) and a libx264 CBR stream (10 Mbit/s, 720p50 with B-frames, AAC).
`tools/runner-cpu-profile.sh -t 60`, three windows once the clock had
locked. Today's side is the run-3 app tree on the same box and module (the
hot deploy reverted, measured and re-deployed); its stamper ran anchored,
the conditioner absorbing the OCC feed's ±0.32 s steps throughout.

| Input | Today: anchored `mrtsstamp` + conditioner | Phase 1: `mrtsrestamp` + identity `mrtsstamp` | Source thread | Stamper thread |
|---|---:|---:|---:|---:|
| OCC, 28.6 Mbit/s | 0.852 core | 0.927; 0.909 after a restart | 1,045 → 1,309; 1,288 | 823 → 839; 840 |
| CBR, 10 Mbit/s | 0.379 core | 0.406 | 448 → 543 | 332 → 331 |

The thread columns are ticks per window (60 s; 55 s for the CBR stream).
The runner is 6–9 % above today's. Most of the difference sits on the
source thread, where the restamp runs: 0.040–0.044 core at 28.6 Mbit/s and
0.017 at 10 Mbit/s, 2.1–2.6 µs per packet or 15–18 µs per 1,316-byte
buffer; the SRT and bus threads differ by −2 to +8 % each, inside what a
restart moves (a runner by up to 0.035 core). The stamper thread is
unchanged: the identity stamper saves nothing measurable against the
anchored one with its conditioner. The runners this change does not touch
read the same under both trees. In isolation (gst-launch on the same box,
the OCC feed paced to real time, the process's CPU, two runs each) the
restamp adds 0.023 core, the identity stamper 0.016 and the anchored
stamper with its conditioner 0.020, so the Phase 1 pair, at 0.037, costs
0.017 core more than today's element. `RestampCore` itself is 132 ns per
packet on the Pi 4, 0.003 core at this rate; the other 7.5 µs per buffer is
the element's per-buffer work at the feed's 2,700 buffers a second. The
whole element takes about 0.9 µs per buffer in a hot loop on the dev Pi 5,
which points at cache misses on every buffer's wakeup rather than at the
arithmetic; the per-packet budget above does not see this cost. On .111's
field profile (Pi 4: three SRT audio ingests, two 302M captures, six
transcoders, a mixer, two SRT outputs) Phase 0 against Phase 1 reads 0.977
and 1.059 core over all runners (1.099 in a second Phase 1 run, in which
every runner, touched or not, read 1–5 % higher): 0.003–0.004 more per SRT
ingest, and 0.033 more per 302M capture, almost all of it on the capture
thread where the ASRC runs (WI-P1-8's budget). `tools/runner-cpu-profile.sh`
saw no native runner until it matched `mr-gst-runner` (it looked only for
`gst-pipeline-runner.py`) and read module names from the engine's journal.

### Tests and fixtures

- **C++ suites**, one per `mrts` module (14: `ts_house`, `ts_packet`,
  `ts_pes`, `ts_pcr`, `ts_psi`, `ts_split`, `ts_timeline`, `ts_video_info`,
  `lateness`, `ts_stc`, `ts_trace`, `ts_restamp`, `asrc_servo`, `ts_gap`),
  and `ts_conformance`, run by `make -C plugins/mpegts-core/native/mrts test`
  and the root `make native-test`, then `tests/trace_cli_test.sh`, which
  replays every expectation file under `plugins/mpegts-core/tests/fixtures/restamp/`.
- **Conformance fixtures** (WI-S0-9, 2026-10-16), in
  `plugins/mpegts-core/tests/fixtures/`: five synthetic `.ts` from
  `fixture_gen --ts` (whose `parity` kind is `py/native_parity_fixture.py`
  byte for byte, so none needs Python) and seven field captures of at most
  2 MB (the OCC 1080i feed, our mux egress of AAC + Opus and of 1080i H.264,
  302M, KLV subtitles, an SRT ingest of a third-party mux, and `cap-cc-loss`
  derived from the AAC + Opus capture), each with its `mrts_cli dump`;
  `ts_conformance_test` replays them at 188, 1316 and 24 576-byte chunks,
  line by line. A vMix capture is missing (OQ-3).
- **Traces.** Each synthetic `.expect.json` names the deterministic
  `fixture_gen --trace` command that regenerates its trace, so no synthetic
  `.stct` is committed (the twelve come to about 6.9 MB). The field traces
  of WI-P1-5 (2026-10-16) are committed, at most 2 MB each: the OCC
  multicast at its recorded arrivals, a CBR source over SRT, paced and
  bursty, an SRT caller restart, a RIST link drop and a sending module's
  restart on a .108 → .103 loop, and two of the OCC gate's real RIST
  outputs. Each expectation's note says where the trace was recorded and
  what its dump shows (plan chapter 15.4, B-32 to B-35).
- **A second opinion.** `tests/hlsPipeReference.test.ts` (WI-S0-10) runs
  `mrts_cli dump` and hls-pipe's TypeScript demuxer over the same captures
  and compares them PES for PES (pid, PTS, DTS, length, payload CRC-32).
  hls-pipe's known limits are an allowlist of six, each with its reason and
  a test of the evidence (`clamps-pts-dts`, `ignores-cc`,
  `single-section-psi`, `one-pid-per-kind`, `ignores-pes-length`,
  `no-resync`); any other difference fails. It found that hls-pipe cannot
  read a PMT spanning packets (the OCC feed's 514-byte, 23-stream PMT).
- **Element and protocol tests** drive the native elements over
  appsrc/appsink in the Python runner's interpreter
  (`gst_mrtshouse_element_test.py`, `gst_mrtsrestamp_element_test.py`,
  `gst_mrasrc_element_test.py`, `gst_native_plugins_test.py`,
  `gst_ingest_restamp_test.py`) and black-box through the native runner
  (`native_runner_protocol_test.py`); both runners must post the same
  events.
- **Fixtures stay off the device** (OQ-2, WI-S0-13). They are committed in
  the repository, and no `tests/` directory ships: the image's
  `media-router.bb` prunes every `tests/` directory from its copy into
  `/opt/media-router`, and the dist tarball packs none. The tests run from a
  checkout, never from `/opt`.

## Phase 1 (built 2026-10-13 to 2026-10-15, gate pending) — ingest restamp, captures on house time, ASRC at captures

Every producer that brings content into the engine now writes house time
into its bytes and leaves on identity egress: the three network ingests
(srt-input, rist-input, mpegts-ip-input) through a virtual STC, the four
capture producers (audio-input-302m, aes67-input, audio-encoder,
video-encoder) on their capture time, the three PCM captures through one
house-rate ASRC. Every one sets `houseTimelineEgress`, so its egress stamps
`PES − 1 h` and never conditions; the anchored stamper and the conditioner
remain for the Phase 2 set (mixers, audio-processing, the splitter, the HLS
fan-out). Still to come in this phase: the capture session (WI-P1-5,
WI-S0-9), the constants tuned by replay (WI-P1-6, which adds its sweep
here), and the gate checks of plan chapter 5 part 11. The plan's register
(chapter 15.4, rows B-1 to B-31) holds the same records with their work
items.

### Where the restamp sits and what it reads as arrival (OQ-19)

- **Right after the transport element, before any queue:** `srtsrc`,
  `mrristsrc`, `udpsrc`, or `rtpjitterbuffer ! rtpmp2tdepay` for RTP. The
  element (`mrtsrestamp`, `arrival=clock`) reads `clock − base_time` at chain
  entry, on the source's streaming thread: the instant the transport hands
  the packets over, after its recovery buffer. That is what §10.4's transit
  check assumes. A source element's own timestamp is not used: srtsrc's is
  the sender's send time in gst-plugins-bad 1.28.2. (A dev box with 1.22.0
  stamps receipt there; `arrival=clock` is right under both.)
- **The output keeps its input timestamps**, so the time-bounded leaky queue
  after it still measures arrival spacing; the bus stamp is written later,
  at the tee, by `mrtsstamp`.
- **Nothing it cannot place leaves it.** A PES before its program has a
  mapping is dropped (`unmapped-pes`), and packets on a PID that no PMT
  lists are removed (`unknown-pid-packets`); null packets and the SI PIDs
  below 0x20 pass. Every program of the PAT gets its own discovery and
  clock.
- **Found, not decided: RTP start-up latency.** `rtpjitterbuffer` releases its
  first ~160 ms in one burst; the lock seeds β from that first sample and
  slews it out at the acquire slew (2,000 ppm), so for ~80 s after each
  start content lands up to ~160 ms later than source-natural. Added latency
  only: nothing is late or dropped. Options: seed β from the first bucket's
  minimum, step down once before the first fit, a faster acquire slew, or
  `rtpjitterbuffer faststart-min-packets`. SRT, RIST and raw UDP show no
  such burst.

### The virtual STC (`mrts::ClockLock`, `VirtualStc`; plan part 4.3)

- **The two stages as planned, at the plan's initial constants**
  (`ClockLockConfig`, `PcrValidatorConfig` in `ts_stc.h`): bucket minima per
  second, a least-squares rate fit refit once without the points more than
  2 MAD above the line, a first-order follower (τ 60 s, clamped at
  ±1,000 ppm, warning past 100), and a lower-envelope offset over the last
  10 buckets with a 2,000 ppm acquire slew for 5 s and a 20 ppm track slew.
  Integer arithmetic, so a replay is bit-exact on every machine. A program
  is `locked` once the rate is known and the acquire time has passed, and
  `lost` after 5 s without a sample; the mapping survives `lost`. WI-P1-6
  tunes the constants by replay.
- **The rate fit runs on one floor level.** A bucket more than `step_ns` off
  the fit's level opens a candidate level; a candidate held for
  `step_hold_ns` replaces it and the fit restarts there; one that ends
  sooner (a burst or a dip) stays out. The rule has no constant of its
  own. A level adoption clears the fit until the new level has
  `rate_buckets_min` buckets (about 30 s), so neither the validator's rate
  row nor `mrasrc` reads a fit of the old level. Why: a delay step inside
  the window bent ε; a −100 ms fall degraded the program on the rate row
  for good, and a +150 ms rise left ε near 1,000 ppm.
- **The envelope step is one-sided at a TS ingest.** The minimum delay
  rising past `step_ns` (20 ms) for `step_hold_ns` (10 s) re-locks; a fall
  is slewed at the track slew. Why: a rise makes content late, while a
  fall only leaves content earlier than needed, and stepping onto it would
  drop the overlap with what already left. The direction is a per-lock
  constant, `ClockLockConfig::step_falls`: false here, true for `mrasrc`
  (below). The plan's draft wrote the step as `|β* − β_applied|`.
- **Convergence.** The draft's acceptance, ±0.5 ppm within 60 s, cannot be
  met under its own delay model (exponential, mean 5 ms, cut at 50 ms) by
  any estimator tried, a maximum-likelihood envelope estimator included.
  The built fit has a median error of 1.8 ppm at 60 s and reaches
  ±0.5 ppm by 300 s at the median and by 600 s at worst. That is now
  WI-P1-1's acceptance and WI-P1-6's sweep criterion.
- **The residual's sign.** `r = arrival − house(σ)`. A negative r is a
  mapping later than the arrival: added latency, not lateness. A PES
  arrives after its house PTS only when r exceeds its source lead.
- **The PCR is written on the mux's base**, house + 1 h as mpegtsmux writes
  it, so `PTS − PCR` on the bus is the source's own lead. It is mapped as a
  PES is (one mapping per program, the straddle rule included) but outside
  the validator's lead row, where its lag would read as a lead.

### PCR validation and degraded mode (§5.3)

- **The checks, one row each** (`PcrValidator`): cadence (p99 PCR interval
  over 10 s past 150 ms raises the cadence warning; three intervals past
  500 ms in 60 s while packets keep arriving fail, so an outage is not a
  PCR fault); rate (the raw fit past 1,000 ppm for 30 s); freeze (three
  consecutive PCRs with `Δσ < Δh / 2` and `Δh ≥ 30 ms`); leap
  (`|Δσ − Δh| > 250 ms` without `discontinuity_indicator` re-locks; three in
  60 s fail); lead (a PID's 1 s median lead outside [−200 ms, +4 s] for 5 s).
  The first failing row is the stats `reason`; a re-lock's reason is
  `discontinuity`, `leap`, `envelope-step`, `external` (the PMT's PCR PID
  changed) or `ref-change`.
- **Degraded mode** feeds a warm second `ClockLock` with the reference PID's
  PTS (DTS for video) against the arrival of its PES headers: the PCR PID if
  it carries PES, else the first video PID, else the first audio. Its lower
  envelope lands the reference PID at its earliest arrival (lead 0), which
  removes #820's 12.6 s lead. Entering it moves the program onto that floor, so the guard
  drops about the source's lead on every PID at the switch (a synthetic
  sparse-PCR trace drops ~0.6 s per PID). The output PCR is regenerated by
  the conditioner's rule: the reference PID's last written key, pulled down
  by up to 1 s to a video or audio PID with a PES in the last 500 ms, minus
  250 ms, never back among regenerated values. Return needs 30 s of PCR that
  passes every row; a new PCR epoch then opens with a `recovered` event.
- **Not built: the per-PID lead clamp** of plan part 4.3 (a PID past 4 s
  under the degraded mapping gets its own envelope and a `lead-clamp`
  event). Until `RestampCore` has it, the card's "Source lead above 4 s"
  warning cannot fire (B-8).

### Discontinuities, overlap and live edits (plan part 4.4)

- **Re-lock triggers:** a flagged PCR discontinuity, a leap, a PCR PID
  change in the PMT, an envelope step. An outage (no packets for ≥ 1 s)
  alone is not one: the first PCR after it passes the leap check against the
  mapping in force, the epoch is kept and only the gap is marked, so a
  sending engine on this design causes no re-lock when it restarts (§5.2).
  A re-lock keeps ε as the starting guess and re-acquires β with the acquire
  slew. House time never jumps.
- **Overlap (R18).** A PES whose house key (DTS for video, PTS otherwise) is
  not after its PID's last emitted key is dropped, its packets removed and
  the PID's later CC renumbered so the output stays continuous; a
  PCR-carrying packet of a dropped PES stays as an adaptation-only packet.
  Video is mapped by its DTS too, so an epoch switch never takes a P frame
  onto the new mapping ahead of its B frames. A dropped run is counted at
  the PID's learned PES spacing, or before it has one at each dropped PES's
  own source spacing (an O edit of −300 ms counted 280, 288, 300 and 280 ms
  on video, two audio PIDs and teletext). A duplicate of a held split-header
  packet is dropped alone; the original still joins its continuation.
- **Live edits of O and the trims** apply per PID from its next PUSI. A
  positive change leaves a gap, a negative one drops the overlap. The PCR
  follows `min(0, smallest shift in the program)`, so `PTS − PCR` never
  shrinks below the source's lead, and a change of that value flags the
  next PCR. O is clamped to ±10 s (OQ-14) and a trim to ±2 s (§5.5).
- **The PCR is flagged for Phase 1–2 consumers.** `discontinuity_indicator`
  is set on the next written PCR after a gap of 1 s or more, after the
  written PCR steps by 1 s or more (as after an outage), and when it changes
  between mapped and regenerated: those consumers still run `tsdemux` in
  PCR mode and would otherwise read a PCR jump as an error.

### The straddle rule (OQ-11, refined 2026-10-14)

Each epoch keeps its source range `[first PCR − 1 s, last PCR + 4 s]`; a
range idle for 10 s is dropped. A PES in one range uses that epoch; in
neither, the newest. The decided tie-break for a PES in two ranges (the
epoch whose lead is closest to the PID's median lead before the re-lock)
applies to real timeline jumps only. An epoch closed by an envelope step is
no candidate, because the floor moved, not the timeline; and a range that
maps the PES within `step_ns` of a newer range holding it gives way to the
newer one (one timeline, such as a same-clock PCR PID change). Why: left to
the tie-break, delay jitter flipped PIDs between such epochs, and a
+100 ms delay ramp over 30 s dropped 1.3 s of audio. With this rule, the
one-level rate fit and the PCR mapped outside the lead row, the replays
put all 3,551 PES on the new floor after a +150 ms re-route (none before)
and drop none on a +200 ms queue build-up over 20 s (137 before). The
design's §5.2 keeps the general rule.

### Gaps on the bus (OQ-12) and the queues they cross

- **The marker.** A GStreamer GAP event cannot cross `unixfdsink`, which
  carries buffers, caps and EOS only. A gap is a buffer flagged
  `GAP | DISCONT`, holding one adaptation-only packet per PID the gap is on:
  AF length 183, only `transport_private_data_flag` set, 8 bytes of private
  data with the gap's length in ns (unsigned big-endian), 0xFF stuffing, the
  PID's last payload CC repeated, so it moves no demux and no CC
  (`mrts::build_gap_packet`, `read_gap_length`; later readers use the
  latter). Its PTS is the gap's **end** on the bus convention (house minus
  the element's base, mapped through the segment as `mrtsstamp` maps a
  stamp), and it has no duration.
- **Its DTS, in two places.** Out of the restamp, the marker's DTS is the
  input's own DTS-or-PTS, so the time-level queue right after it (srt-input's
  100 ms `queue leaky=2`) never moves on it: `GstQueue` reads DTS before
  PTS. At an identity egress `mrtsstamp` and the Python probe
  clear it, so the bus carries **no DTS** on a marker: an input-timeline DTS
  next to house-time data made the 5 s edge queue and the 5 s consumer
  ingress queue read their level as house minus arrival and leak the buffer
  behind the marker. A duration was rejected for the same reason: `GstQueue`
  adds it to its level.
- **One list per revealing buffer.** A marker goes right before the PES that
  shows its gap, so the input buffer is split around it, and the pieces and
  markers of one input buffer leave as one buffer list, which a leaky queue
  takes or drops together. Pushed one by one, a 3 s outage behind
  srt-input's queue lost a marker or data in 10 of 10 runs (the input's own
  PTS jump reads as a full queue); as a list, 0 of 10.
- **When.** On a PID's first PES under a newer epoch (reason `epoch`), after
  a live edit (`edit`), after an outage (`outage`), or in fixed mode a jump
  (`jump`, below), when the PES lands after the end of what the PID last
  emitted. During an outage the element's own `GstTask` (`arrival=clock`,
  in PLAYING) pushes one buffer with a packet per PID whose gap has started,
  at 1 s without packets and every 250 ms after (OQ-17; measured 1000.5 ms,
  then 250.2–250.6 ms apart); the resume marker comes from the stream.
- **Through an identity egress** a marker leaves with its PTS, duration,
  flags and bytes, and a buffer list holding one is chained member by
  member, not coalesced: an exception to ADR-0011, because merging would
  hand the marker's flags and PTS to the whole access unit, or bury the
  marker in a data buffer. `mr-tssplit` and `mr-bus-fanout` still write
  `flags = 0`, so a marker does not cross a splitter until Phase 2 forwards
  it (R-P1-5); no Phase 1 component consumes markers.
- **Found, not decided: DISCONT and `tsdemux`.** The DISCONT flag makes every
  Phase 1–2 `tsdemux` consumer drain and flush at each marker
  (gst-plugins-bad 1.28.2 `mpegtsbase.c:1539–1557`, `tsdemux.c:2314–2356`).
  Measured on an 8 s stream with three markers: one audio PES lost and two
  extra DISCONT outputs per stream, against none without the flag. It
  affects development and gate checks only, since Phase 3 replaces
  `tsdemux`. If vetoed, the marker keeps GAP alone (one line in
  `restamp_marker`); Phase 2's readers key on GAP.

### The captures: fixed mode (plan parts 4.2 and 4.6)

- **`clock-mode=fixed`** skips the STC: a PES's house time is `PES − 1 h` as
  the local mux wrote it, plus the base time under `add-base-time`, plus the
  shift. PTS and DTS move by that constant and keep the mux's exact spacing;
  the PCR moves by the base and `min(0, shift)`, as at a network ingest, so
  `PTS − PCR` never shrinks below the mux's. It is how the four capture
  producers get O, the live edits and gap markers without a second
  implementation. A capture has one PID, so it has O and no per-PID trim
  (OQ-15).
- **The jump rule.** In fixed mode a PES is also a gap (`jump`) when its
  spacing from the PID's last PES exceeds twice the PID's PES length, the
  length being the upper median of its last three clean spacings (the
  longer of two while only two are known; no test before that), with a
  jump's own spacing joining the three. So one short PES never sets the
  length (an ASRC's first output, a relock's remainder), a second jump two
  PES later still marks, and a lasting cadence rise is learned: a PipeWire
  quantum rising from 512 to 2,048 samples gives two markers and then none,
  where "twice the longer of the last two non-jump spacings" gave 299.
  Phase 2's aligners should not lower on a marker shorter than the PID's
  PES length: those two are false.
- **video-encoder keeps `liveCaptureClock`** (its natural base time avoids
  the measured aggregator mis-schedule) and adds the base back:
  `mpegtsmux name=mux latency=0 alignment=0 ! mrtsrestamp clock-mode=fixed
  add-base-time=true ! buildBusSink`, the base taken at the first buffer of
  a start. PES − 1 h is then the capture time on the house timescale
  (§11.3 item 6). Fixing the aggregator schedule instead, which would let
  `liveCaptureClock` go, is the recorded alternative and was not attempted.
  A negative O edit there drops whole frames, so the picture is damaged
  until the next keyframe; a positive one is a clean time jump.
- **The PCM captures** run `audioconvert ! mrasrc` where `audioresample` was
  (`build302mEncodeBranch({ asrc: true, restamp })` for audio-input-302m and
  aes67-input; audio-encoder builds its own), then the encoder and
  `mpegtsmux`, then `mrtsrestamp clock-mode=fixed`. Without `asrc` and
  `restamp` the branch string is byte-identical to before (the mixers until
  Phase 2).
- **audio-encoder captures with `pipewiresrc`** on its null-sink monitor
  (`stream.capture.sink=true`, `node.latency` from `srcBufferMs`, now
  40–85 ms, default 60; OQ-16) in place of `pulsesrc`, with the capture caps
  pinned to F32LE, the channel count and, from two channels up, GStreamer's
  fallback channel mask: an open format hung PipeWire 1.2.7's negotiation.
  On the dev Pi 5 (PipeWire 1.2.7, 600 s, 14,064 buffers) its PTS landed
  exactly on the driver cycle, with no ring-sized steps, so the `pw_time`
  fallback was not needed; the fleet's PipeWire 1.6.3 is a gate check.

### ASRC at PCM captures (`mrts::AsrcServo`, `mrasrc`; plan part 4.5)

- **The resampler: `GstAudioResampler` with scaled integer rates** (§13.3).
  `in_rate = round(fs_in·1000 / (1 + ε_cmd))` against `out_rate =
  fs_out·1000` gives a ratio resolution of 0.02 ppm at 48 kHz, and
  `gst_audio_resampler_update` takes new rates without a reset, keeping the
  filter phase. Kaiser at `quality` 4 (the GStreamer default), cubic
  interpolation, `MAX_PHASE_ERROR` 0.05, `VARIABLE_RATE`; the settings live
  in `mrasrc_resampler.h`, which `tests/asrc_bench.c` shares. The
  interpolated filter table is **forced**: AUTO picks the full table when
  the scaled rates reduce small (44.1 → 48 kHz reduces to 147/160) and asked
  for 15.7 GB. It is in `gstreamer-audio-1.0`, already a dependency, so no
  recipe change. Measured at a 1.0002 ratio with 1 ms of PTS jitter
  (AES17-style, ±50 Hz notch): THD+N −110.4 dBFS for F32LE and S32LE,
  −94.4 dBFS for S16LE (its own floor). CPU on the dev Pi 5: 1.04–1.24 % of a
  core per stereo stream and 4.18–5.21 % for 8 channels at quality 4.
  speexdsp is the measured alternative if the Pi 4 bench misses its budget
  (3 % stereo, 10 % for 8 channels): first quality 2, then the speexdsp
  backend behind the same element, with `speexdsp` in the recipe.
- **The element.** A `GstBaseTransform`, not in place. Per buffer the servo
  locks the input frame count to the buffer PTS (the capture time on
  `CLOCK_MONOTONIC`) and commands the ratio, `ε_cmd = ε + phase_err / 10 s`
  clamped to ±1,000 ppm; the resampler is updated before the output is
  sized, whenever the commanded rate moves by at least 1 (about 47 times a
  second at 1,024-frame buffers). The output is a house-rate sample counter,
  `PTS_out(m) = T0 + m / out_rate`, so sample count and PTS agree exactly on
  the bus (P7). `out-rate` 0 means the input's rate or the rate the caps
  downstream ask for, so one element also converts the nominal rate (a
  44.1 kHz device onto a 48 kHz bus) and nothing resamples twice (§13.1).
  Formats S16LE, S32LE and F32LE interleaved; the latency query adds the
  filter's lookahead; at EOS it drains that lookahead on the same counter.
  It posts `mrasrc-stats` every 2 s of output labels and `mrasrc-event`
  (`relock` with `reason`, `jump-ns` and `dropped-ns`;
  `ratio-out-of-bounds` with `fit-ppb`).
- **A two-sided 50 ms step.** `asrc_lock_config()` is the STC's constants
  with `step_ns` = 50 ms and `step_falls` = true. A capture labelled on
  its floor is late by any fall of its latency (a PipeWire quantum change)
  and early by any rise; under the one-sided rule a −60 ms fall left
  labels 54 ms late for about 50 min.
- **A relock lands on the measured floor.** On an envelope step the lock
  moves onto the floor of the step's own buckets
  (`ClockLock::step_to_floor`) and stays locked. Re-acquiring from one
  jittered PTS misses the one-frame target under 1 ms of jitter.
- **T0 never goes back, so a fall drops its overlap.** The new T0 is never
  before the end of the last output. A rise leaves a forward PTS jump (a
  gap downstream). A fall, or a DISCONT whose PTS steps back, drops the
  input captured before that end (`Command::skip`, at most `DROP_MAX_NS`
  = 1 s; the rest is slewed), so labels stay the capture time. Steering
  moves only the ratio; the drop is a relock action, like the ingest's
  overlap rule (R18). Why: inside the ±1,000 ppm ratio clamp a slew takes
  about 2 min for 60 ms and 5 min for 200 ms, with late labels throughout.
  Measured: −60 and −200 ms falls give one relock 9–10 s after the step,
  no PTS jump, 59.935 and 199.928 ms dropped, and labels within one frame
  from the relock; the element on the real resampler reproduces the
  servo's model to about 1 µs. The rule covers every relock; limiting the
  drop to envelope steps is a one-line change.
- **Measured against the plan, constants unchanged until WI-P1-6.** The
  lock takes 35.01–36.01 s (plan 30 s: the STC's 30-bucket first fit plus
  the 5 s acquire). Over 1 h the frame count is within 0.70 frames at 0
  and ±50 ppm and 1.19 frames at ±500 ppm (plan ±1; the jitter of the
  bucket minima). A device past the ratio clamp now relocks on falls as
  well.
- **Found, minor.** The phase detector counts whole input frames, which
  steps the ratio by about ±1 ppm per buffer: FM about 87 dB below the tone,
  inaudible. After a DISCONT whose PTS steps back, labels run up to 1⅛
  frames late for about 2.5 s (the drop rounds down to whole frames). At
  audio-encoder's start the first `pipewiresrc` buffer is labelled one
  quantum late, and the servo slews that out at the ratio clamp for about
  30 s, labels sitting up to ~40 ms after the capture time meanwhile; the
  "Device clock off" warning (past 200 ppm for 60 s) does not fire. Each is
  a small servo change if wanted.

### Identity egress (`mrtsstamp` and the Python probe; plan parts 4.6–4.7)

- **Base-aware identity.** `house_now` is the clock time and a stamp maps
  to running time `max(stamp − base_time, 0)`, so wire = PES − 1 h under
  any base time (video-encoder's natural one). Base-0 pipelines are
  unchanged.
- **Gap markers pass**, with their DTS cleared (above). Anchored egresses
  are frozen (Q2) and get no markers in Phase 1.
- **The per-egress conditioner threshold is gone** (WI-P1-15):
  `PipelineDescription.conditionStepMs`, its runner plumbing, the
  `condition-step-ms` property, `TimelineStamper::set_condition_step_ns` and
  the twin's keyword. The conditioner the Phase 2 set still runs uses the
  fixed 300 ms everywhere. `MRTSSTAMP_VERSION` is 2.7.0. ADR-0005's text on
  `conditionStepMs` and on `liveCaptureClock` is left as written (§11.6);
  this is its correction.

### The engine side and what the operator gets

- **One TypeScript home**, `packages/engine/src/plugins/ingestTiming.ts`:
  `buildRestamp`, `buildAsrc`, the bus reports, and
  `applyIngestTimingLiveUpdate`, which sets `offset-ns` or `pid-trims` on
  the element named `restamp` with no restart. `IngestTimingReporter` turns
  the element messages into the card, throttled to changes of 1 ms or a
  state flip; each module binds it to its own health, badge and sections
  (the binding is repeated in seven modules, a refactor candidate for the
  base class).
- **The settings are injected, not declared.** A manifest declaring
  `"timing": { "role": "ingest", "pidTrims": true|false }` gets Ingest
  Offset (`ingestOffsetMs`, ±10,000 ms, live) and, with `pidTrims`, Per-PID
  Trim (`pidTrimsMs`, ±2,000 ms per PID, live, the `pidTrim` widget) from
  `withIngestTimingSettings`, in both the engine's loader and the manager's
  registry: the three network ingests have both, the four captures O only.
- **The box writes on change only** (Enter, blur or a spinner step), never
  per keystroke, because every live write is a gap or a drop on the stream
  (§5.5). Each box keeps a draft of its uncommitted text, so a re-render of
  the settings form, which any engine's store patch causes, never resets
  what is being typed.
- **The card.** Network ingests: a `clock` badge (Locked, Acquiring,
  Degraded, No PCR), a Clock section (state, source rate in ppm, residual
  p99, re-locks, last event) and one section per PID (lead min, median and
  max, trim, shift, PES dropped in 10 min). Captures: a Clock section with
  the ASRC ratio, phase error and re-locks on the PCM ones, and the ingest
  offset. Warnings: degraded clock, more than 3 re-locks in 10 min, source
  rate past 100 ppm or ASRC ratio past 200 ppm for 60 s, PCR cadence, and
  transport errors (`cc-lost` or `desync-bytes` rising for 10 s, read as
  running totals from every program's stats message). None drops content.

### Open at the end of the build

- The capture session (WI-P1-5, WI-S0-9), the tuning sweep (WI-P1-6), the
  Pi 4 bench of WI-P1-8 and the part 11 gate checks, all on the
  rigs.
- The restamp's runner CPU is above today's stamper and conditioner on the
  same wiring (S0 Budget above: +0.04 core per 28.6 Mbit/s ingest on a
  Pi 4), so V-P1-10 fails as written until the per-buffer cost is cut or
  the criterion is changed.
- The degraded-mode lead clamp and its `lead-clamp` event (B-8).
- `mrasrc` has no row in either runner's stand-in table, so without the
  plugin the three PCM captures fail to parse instead of starting with the
  rule-6 alarm. Recommended stand-in: `audioresample`, which keeps the
  nominal-rate conversion.
- The RTP start-up latency and the DISCONT flag on markers (both above).
- The bus-egress lateness tap of a `liveCaptureClock` pipeline reads the base
  time (Phase 0, corrected above): video-encoder's card shows no output
  lateness, because the reporter hides a window of 1 h or more. Proposed
  fix: that tap with `reference=running-time`, exact under any base time.
