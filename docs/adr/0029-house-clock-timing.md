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
  installed as `/etc/chrony.conf`): `makestep 1.0 -1` (a step whenever the
  offset exceeds 1 s, at any time; below 1 s chrony slews), `maxslewrate 100`
  (ppm, matching the PTP presets' `max_frequency 100000`; OQ-5),
  `leapseclist /usr/share/zoneinfo/leap-seconds.list` with
  `leapsecmode system` (the kernel TAI offset comes from tzdata's list, and
  the kernel inserts a leap so `CLOCK_TAI` never steps),
  `driftfile /data/chrony/drift` (the rootfs is read-only), `rtcsync` (on
  Linux it is also what makes chronyd clear `STA_UNSYNC`; `mr-clockstate`,
  `HouseClock` and the Time page gate on that flag, so it stays on boxes
  without an RTC too; review F2), and `chronyc` bound to localhost only.
  Why `-1` and not a step at start only (`makestep 1.0 3`, §10.2 as first
  written): a box that was synced and later ends up more than 1 s off — a
  long offline spell, a manual clock change — would slew at ≤ 100 ppm, 2.8 h
  per second of offset, with its house time off against its peers all the
  while. The owner expects a time jump on reconnection, and one step is one
  engine re-epoch. Engineering decision of 2026-10-14, open to the owner's
  veto; §10.2 now reads the same.
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
  `/data` syncs to the pool without a setting. The dispatcher also runs
  `chronyc onoffline` (failures ignored) on `up`, `down`,
  `connectivity-change`, `dhcp4-change` and `dhcp6-change`, ahead of its
  interface check, because NetworkManager passes no interface for
  `connectivity-change`. chronyd starts before the network: without the hook
  a name that failed to resolve at boot was retried only after chrony's
  backoff (~28 s), just past the 30 s wait, and an offline boot re-resolved
  up to ~1 h after the uplink returned (review F1). It mirrors upstream
  `examples/chrony.nm-dispatcher.onoffline`. `After=network-online.target`
  was rejected: it delays chronyd and the wait unit by NM-wait-online's
  timeout on offline boots.
- **chronyd runs where PTP is off, and on a PTP box only while it holds the
  grant token.** Its drop-in (`10-media-router.conf`) has two triggering
  conditions, `ConditionPathExists=|!/data/ptp/ptp.env` and
  `ConditionPathExists=|/run/media-router-ptp/chrony.grant`, plus
  `RequiresMountsFor=/data`; who writes the token is in the PTP section
  below. They are conditions, never `Conflicts=` on the ptp4l unit: systemd
  applies `Conflicts=` when the job is queued, before conditions, which on
  PTP-off boxes stopped the time daemon and then skipped ptp4l (recorded in
  `media-router-ptp4l.service`). `mr-ptp-owner_test.py` checks all four file
  states with `systemd-analyze condition`. The drop-in's `ExecStartPre`
  lines run with `+` because chrony's stock sandbox makes `/data` read-only.
- **`time-sync.target` still means "the clock is set."** Our own
  `media-router-chrony-wait.service` replaces htpdate's ordering:
  `/bin/sh -c 'chronyc -h 127.0.0.1 waitsync 30 0 0 1 >/dev/null 2>&1 || echo "<4>…"'`,
  `TimeoutStartSec=90`, `Before=time-sync.target`, skipped on every PTP box
  (`ConditionPathExists=!/data/ptp/ptp.env`). It never fails (the owner,
  2026-10-14: "Should continue after a timeout with a warning. When chronyd
  updates time after eventual internet reconnection, a time jump is
  expected"): after 30 tries 1 s apart it logs one warning-priority line,
  `no NTP sync after 30 s - continuing unsynchronised; the clock will step
  when NTP is reachable`, exits 0, and `time-sync.target` is reached, so a
  cold boot whose first sync takes over 30 s is no longer "degraded" (seen
  on 10.9.16.50 and 10.9.1.211). The later sync steps the clock if it is
  more than 1 s off (`makestep 1.0 -1`), and the engine re-epochs once. On PTP boxes with
  hardware timestamping phc2sys orders the target as before, and a
  master-capable box waits for chrony in its PTP setup (below). The engine is
  a *user* unit and cannot order on the target, which is why it waits for
  sync itself (below).
- **journald owns `/dev/log`.** `meta-custom/conf/distro/media-router-distro.conf`
  sets `VIRTUAL-RUNTIME_base-utils-syslog = ""`, so `packagegroup-core-boot`
  no longer RRECOMMENDS `busybox-syslog`, which also carried
  `busybox-klogd.service`. BusyBox syslogd follows the `/dev/log` →
  `/run/systemd/journal/dev-log` symlink, unlinks journald's socket and
  binds its own there, so every syslog(3) line (chronyd, phc2sys, sshd,
  `logger`) went to `/var/log/messages` and never to the journal (root cause
  proven on 10.9.16.50, 2026-10-14). Nothing in the layer, the Device
  Manager or the app reads `/var/log/messages`, calls `logread` or orders on
  `syslog.service`. chronyd keeps logging through syslog (no `-d`).
  Engineering decision of 2026-10-14, open to the owner's veto.
- **The displacement record is gone.** On a slave-only box the setup script
  stops chronyd when it is active and records nothing; chronyd's conditions
  keep it off at boot and the Device Manager starts it on disable.
  ADR-0005's notes of 2026-08-18 (displace and restore) and 2026-08-19
  (restore htpdate by default) are marked superseded by this section.

### PTP: a grandmaster on chrony (2026-10-14)

**Decision.** On a master-capable box (`PTP_SLAVE_ONLY=0`) chronyd owns
`CLOCK_REALTIME` whenever the ptp4l port is not UNCALIBRATED or SLAVE, the
only states in which linuxptp writes it, and the box announces traceable NTP
time only while chrony is synchronised. While a better grandmaster wins,
linuxptp steers the box as before. Slave-only boxes are unchanged.

**Why.** Nothing disciplined a grandmaster: 10.9.16.46 ran 0.2–0.3 s off
UTC after 9.7 days, undisciplined since boot (design §10.1), and the domain
followed it. Of the three designs weighed, this one fixes only that, inside
the master-capable model: the slave path (ptp4l's servo, phc2sys `-a -r -r`
switching direction by port state) is the Phase 0 image's apart from
phc2sys's hardened flags (below), `ptp.env` gains no key, and a box left
master-capable gains NTP discipline only while it actually is the
grandmaster. From the other two it takes the bounded boot wait (chrony
before ptp4l) and a management path that carries the PTP domain (`pmc -d`,
`phc2sys -n`).

- **One writer, from linuxptp's source.** In software mode `port.c`
  `process_sync`/`process_follow_up` return early unless the port is
  UNCALIBRATED or SLAVE, so `clock_synchronize` runs only there; its first
  write is the servo's second sample (`pi.c` `pi_sample`), at least ~130 ms
  after UNCALIBRATED. In hardware mode phc2sys writes REALTIME only in SLAVE
  (`phc2sys.c` `reconfigure_domain` returns −1 on UNCALIBRATED and leaves
  REALTIME alone); in the other states REALTIME is its source and the PHC
  its sink. Outside SLAVE linuxptp's only kernel-status write is
  `sysclk_set_leap(0)` at a software ptp4l's start (`clock.c:1327`), a no-op
  while chrony is synced. chrony cannot release the clock at runtime (`-x`
  is a start-up option; `chronyc offline` only stops polling), so yielding
  is stopping chronyd and taking is starting it; its exit writes its base
  frequency once (`sys_generic.c` `SYS_Generic_Finalise`) and never zeroes
  TAI. The table, per state and mode, is the plan's WI-P0-2b.
- **`mr-ptp-owner` hands the clock over by port state.**
  `media-router-ptp-owner.service` (`mr-ptp-owner.py`, WantedBy and BindsTo
  `media-router-ptp4l.service`) stops chronyd (`systemctl stop --no-block`)
  the moment a pushed PORT_DATA_SET says UNCALIBRATED or SLAVE, and starts
  it again once the port has been in another state for max(2 s,
  (announceReceiptTimeout + 1) · 2^logAnnounceInterval): 8 s for AES67, 2 s
  for ST 2059-2. That hold doubles for each grant that ends within 60 s
  (revoked, or chronyd did not stay up), is capped at 16× and is forgotten
  after 10 min. The grant token `/run/media-router-ptp/chrony.grant` is
  chronyd's start condition: written before every start, removed before
  every stop. The unit's `ExecStopPost` also removes it but leaves chronyd
  running; the next instance adopts or revokes from a fresh GET. A
  slave-only box never gets the token, and the watcher stops chronyd if it
  finds it running. It reads ptp4l through one interactive
  `pmc -u -b 0 -d <domain>` (port-state pushes, a GET every 5 s), reports in
  `/run/media-router-ptp/owner.env`, and idles at 12.8 MB RSS and ~0.05 %
  CPU on a slave-only box, pmc 1 MB more; the polling detail is in the
  plan's WI-P0-2b.
- **An unanswered port state keeps the last decision.** No PORT_DATA_SET
  for 12 s logs a warning and changes nothing: ptp4l is single-threaded, so
  one that answers nothing steers nothing, and revoking would strip a
  grandmaster of its discipline; if ptp4l died, BindsTo stops the watcher.
  Engineering choice, open to the owner's veto.
- **A grandmaster's boot: chrony first, one step, then ptp4l.** The setup
  script (ptp4l's `ExecStartPre`) removes the token and stops chronyd on a
  slave-only box. On a master-capable box it writes the token; if chronyd
  is not running it starts it, waits `chronyc waitsync 30 0 0 1` and runs
  `chronyc makestep` once (as root, over the Unix socket), so the RTC's
  sub-second boot offset, which `makestep 1.0 -1` would slew into every
  slave at 100 ppm for up to 2.8 h, is stepped before anything is served.
  Without NTP it logs `WARNING: no NTP sync after 30 s — ptp4l starts
  anyway; the grandmaster announces not traceable until chrony syncs` and
  ptp4l starts. When chronyd already runs (a Device Manager save, a ptp4l
  restart) there is no wait and no step. ptp4l's `TimeoutStartSec` is 120 s.
  Engineering decision, open to the owner's veto.
- **What a grandmaster announces.** `GRANDMASTER_SETTINGS_NP` is SET only
  when it differs from ptp4l's GET, with all 11 values in `pmc_common.c`'s
  order (pmc refuses fewer); never while the port is UNCALIBRATED or SLAVE,
  where ptp4l's `utc_offset`
  feeds its own servo (`clock.c` `clock_utc_correct`), and never on a
  slave-only box. clockClass, clockAccuracy, offsetScaledLogVariance and
  ptpTimescale are echoed, so BMCA and the timescale stay ptp4l's; a
  software grandmaster keeps ARB, ptpTimescale 0. `timeTraceable`,
  `frequencyTraceable` and `currentUtcOffsetValid` are 1 and `timeSource`
  is 0x50 (NTP) only when all of these hold: the token exists; chronyd is
  active; `STA_UNSYNC` is clear; `maxerror` is under 1 s
  (`MAX_SYNCED_ERROR_US`, mirroring `houseClockPolicy.ts`: change both
  together, a test checks they match); 10 ≤ `tai` ≤ 999; and, with hardware
  timestamping, phc2sys is active and `phc_ctl -q <phc> cmp`
  (REALTIME − PHC) is within 1 ms of −`tai`. Otherwise they are 0/0/0 and
  0xa0 (internal oscillator) and `currentUtcOffset` stays as ptp4l has it;
  when traceable it is the kernel's `tai`. So the flags flip at the instant
  the grandmaster's engine flips `traceable`. Known flap: two consecutive
  lost NTP polls at `maxpoll 10` push `maxerror` past 1 s for one poll; if
  the fleet shows it, `MAX_SYNCED_ERROR_US` and the watcher's mirror go to
  8 s together (follow-up). ptp4l logs `assuming the grand master role` once
  per SET. The 1 s mirror is an engineering choice, open to the owner's
  veto.
- **Leap bits from 12:00 UTC only.** leap61 and leap59 come from the kernel
  status word (`STA_INS`/`STA_DEL`), not `adjtimex`'s return value, which
  reads `TIME_ERROR` while unsynced. They are announced only from 12:00 UTC,
  because `util.c` `leap_second_status` takes a flag first seen before
  06:00 as already past and would apply it at once, and never once
  `adjtimex` returns `TIME_OOP` or `TIME_WAIT`: during the inserted second
  the kernel already reports `tai` 38, and announcing 38 with leap61 still
  set would make ptp4l add the second again. Engineering choice, open to
  the owner's veto.
- **The election stays on Priority alone** (the owner, 2026-10-14: "Keep
  ptp priority only"). Sync state never changes the announced clockClass,
  so BMCA picks the grandmaster as before; the traceability flags and the
  Device Manager's Time source row only inform. Consequence: a third-party
  master with a wrong clock that wins the election still drags the domain,
  and every Device Manager shows its grandmaster not traceable.
- **The kernel TAI offset under PTP.** Until this phase nothing under PTP
  set it (every box measured on 2026-10-12 had `tai = 0`, §10.1): a linuxptp
  grandmaster announced no traceable UTC offset, and ptp4l/phc2sys set the
  kernel offset only from one. Now a slave takes it from a traceable
  grandmaster's announcement (`clock.c` `clock_utc_correct`, `phc2sys.c`
  `clock_handle_leap`), and a chrony grandmaster's kernel gets it from
  chrony's leapseclist. `mr-ptp-settai.py` (ctypes `adjtimex` with
  `ADJ_TAI`) still seeds it before ptp4l starts, which matters for an
  offline boot: chrony writes `MOD_TAI` only after its first sync
  (`reference.c` `update_leap_status`). The value is the last entry of the
  image's `leap-seconds.list`, the file chrony reads, else 37. On a
  slave-only box a hand-set `PTP_TAI_UTC_OFFSET` in `ptp.env` still wins
  (no UI; OQ-10); on a master-capable box settai runs with `--no-override`
  and logs `chrony's leapseclist owns the TAI offset on a master-capable
  box; ignoring PTP_TAI_UTC_OFFSET=N`. It logs `TAI offset set to N (was M)`
  and always exits 0, like the tick check: a missing offset must never keep
  PTP from running.
- **phc2sys runs `-a -r -r -n <domain> -S 1.0 --max_frequency=100000 -u 16`.**
  `-n`: `port.c` `port_ignore` drops management messages from another
  domain, the Unix socket included; on linuxptp 4.4 a GET on domain 0 to a
  ptp4l on domain 127 gets no answer at all, so `-a` never worked on
  ST 2059-2's domain 127. `-S 1.0`: the default `step_threshold` 0.0 never
  steps after start, so a grandmaster's chrony step would be slewed into
  the PHC and into the slaves' REALTIME. `--max_frequency=100000`: the
  presets' 100 ppm cap; `servo.c` takes the smaller of it and the clock's
  own limit. The first update after a phc2sys start still steps anything
  over 20 µs (`first_step_threshold`), which is what corrects a
  grandmaster's PHC after the boot step. Engineering choice, open to the
  owner's veto.
- **The tick check alarms on the total only.** `mr-ptp-tickcheck` alarms
  when |tick + freq| exceeds 100 ppm; a moved tick is reported in the
  summary (`tick=10001 (nominal 10000, +100,000 ppb)`) and no longer alarms.
  linuxptp's `clockadj_set_freq` sets tick = round(ppb / 1e3 / USER_HZ) +
  nominal, so it moves the tick from 50 ppm, not ~500 ppm; chrony's
  `set_frequency` keeps an adjacent tick and moves it only from ~150 ppm.
  Slaves tracking a grandmaster's chrony slew, or a box with a 50 ppm
  crystal, moved the tick legitimately and raised "house clock
  compromised". Engineering choice, open to the owner's veto.
- **PTP logs one summary per 16 s.** The setup script's runtime `[global]`
  block emits `summary_interval 4` (both presets) and phc2sys runs with
  `-u 16` (one rms summary per 16 updates instead of a line per update; it
  logs through syslog, which now reaches the journal). Measured on
  10.9.16.108 on 2026-10-14: 1,570 journal lines per 10 min, 600 of them
  ptp4l's 1 s summary, in a volatile 32 MB journal that lost boot logs
  within ~2 h. The Time page's PTP status reads only the newest summary
  (`parsePtp4lLog`, newest wins), so rms and path delay are at most 16 s
  old; nothing else parses per-second ptp4l or per-update phc2sys lines.
- **No `maxslewrate` override on a grandmaster.** The grant token is an
  empty file, not a confdir fragment: a fragment applies only when chronyd
  starts (an adopted chronyd would miss it), and OQ-5's 100 ppm stands.
- **Accepted, and measured on the rig rather than assumed away:**
  - software mode: ptp4l's first REALTIME write comes at least ~130 ms after
    UNCALIBRATED, while the watcher reacts to the push within ms and
    chronyd exits in tens of ms. An overlap is bounded to one frequency
    write, which chrony logs as `System clock interference detected` and
    ptp4l corrects at its next sample (rig T3). Hardware mode has none;
  - each regain restarts chronyd, whose start sets `STA_UNSYNC`: the
    grandmaster's engine reads `sync lost` for the 2–8 s until chrony's
    first iburst update, then `sync arrived, E unchanged` (rig T4);
  - the first MASTER → SLAVE handover after a phc2sys start steps REALTIME
    by the NTP-versus-domain difference (phc2sys's 20 µs first step), one
    re-epoch when that passes 1 ms: rare and logged. `phc2sys -F` keeps its
    default, because a larger first-step threshold slows every hardware
    slave's boot.
- **Recorded for the owner, not changed:**
  - a ptp4l restart on a master-capable box that is following a better
    master (a settings save, or ptp4l's `Restart=`) starts chronyd, waits
    for NTP and steps to NTP time before ptp4l runs. The port then goes
    UNCALIBRATED, chronyd is revoked and linuxptp steers the box back,
    stepping if more than 1 s off. If NTP and the domain differ by more than
    1 ms, that box's engine re-epochs once, or twice if linuxptp steps back.
    This is inherent to the boot rule;
  - on a chrony grandmaster the tick check can alarm while chrony slews a
    large offset: `maxslewrate 100` plus the crystal's own error passes the
    100 ppm guard, for example when NTP comes back 0.5 s off after an
    offline boot (~1.4 h of slew). The alarm is literally true then, since
    MONOTONIC really runs that far off.
- **Rollout** (the owner, 2026-10-14). 10.9.16.46 is imaged after the rig
  tests (plan WI-P0-2b, T0–T12). Its boot steps it to NTP time before it
  serves, moving the domain by its present 0.2–0.3 s; ptp4l is restarted on
  .103, .108, .111 and .22 within a minute so each steps once on first lock
  instead of slewing for up to an hour. The owner accepted the one re-epoch
  per engine this costs on the PTP boxes; the window is still to be set.
- **Rejected:**
  - chrony as the one writer everywhere, through a SOCK refclock: it
    rewires every slave's servo for a grandmaster-only fault, parks software
    slaves in UNCALIBRATED for good, ties ptp4l restarts to chronyd's and
    hand-rolls a leap window. Parked as a possible "slaves fall back to NTP"
    item;
  - a `free_running` designated grandmaster: under `free_running`
    `clock_no_adjust` returns `SERVO_UNLOCKED`, so an outranked box never
    reaches SLAVE and never follows a better clock; `phc2sys -w` blocks at
    boot; and it flips the `ptp.env` default, forcing a fleet audit;
  - a `maxslewrate 50` fragment (above);
  - revoking chronyd on an unanswered PORT_DATA_SET (above);
  - `WatchdogSec` and `sd_notify` in the watcher: `Restart=always` and 10 s
    subprocess timeouts cover a hang with less machinery;
  - `chronyc offline`/`online` as a soft handover: chrony keeps the kernel
    frequency and its clock model goes stale under ptp4l, and deriving the
    owner from "chronyd active" would break;
  - `chronyd -r` with a dump directory to shorten the restart blip: the
    reloaded samples predate ptp4l's steering, so the first update is wrong
    and `makestep` could step; `chronyd -x`: a start-up option, not a
    runtime release of the clock;
  - `Conflicts=` between chronyd and ptp4l (above); `serverOnly` on
    master-capable boxes: it removes BMCA and allows two masters on one
    segment;
  - an unconditional TAI-exact PHC seed: needed only without `-r -r`, which
    stays, so the forward-only seed and its reason stay;
  - raising `MAX_SYNCED_ERROR_US` or adding a chrony `maxpoll` now: a
    follow-up, with the lost-poll flap as its trigger;
  - `phc2sys -F 0.01` against the one-time step at the first handover (above);
  - `pmc -f /run/media-router-ptp/ptp4l.conf` instead of `-d`: that file sets
    no `uds_address`, so `-d` from `status.env` gives the same answer without
    pmc parsing the whole ptp4l configuration.

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
  page and the engine read the kernel through one implementation and judge
  it by one predicate (`isSynced`, mirrored in the Device Manager's
  `TimeStatus.ts`). A sidecar restart (auto-restart, 1 s to 30 s backoff)
  never re-epochs: the latch is the engine's. The engine does not log the
  samples (`logStdout: false`): they are a data channel, and `HouseClock`
  logs every decision they drive. The sidecar's stderr is still logged at
  warn, and a stdout line that does not parse is logged at warn at most once
  a minute on the monotonic clock (so a REALTIME step back cannot silence
  it), with its first 120 characters:
  `clock: ignored an unreadable mr-clockstate line: <excerpt>`.
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
  at every poll at the default `maxpoll 10` (1024 s). The Device Manager's
  Time page applies the same `isSynced` (`TimeStatus.ts`,
  `MAX_SYNCED_ERROR_US` mirrored, change both together). Until 2026-10-14 it
  showed the raw flag and could read synchronised inside linuxptp's
  start-up window while the engine read unsynced.
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
    reader of E, aes67-output, free-runs on an epoch that was untraceable at
    its start, so its wire does not change; a sender whose epoch lost sync
    afterwards keeps its claim, and a step there is corrected up to 10 s
    late;
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
- **Who owns the clock** is polled every 10 s, unprivileged, and once more
  on each `step` line, since a PTP handover can step the clock:
  `systemctl is-active chronyd.service media-router-ptp4l.service` →
  `chrony` when chronyd is active, else `ptp` when ptp4l is, else `none`
  (`clockSource.ts`). chronyd wins because on a PTP box it runs only while
  it owns the clock: on a master-capable box as grandmaster, where chronyd
  disciplines the clock ptp4l serves, or during the setup script's boot
  wait. A revoked chronyd reads `deactivating`, so the owner is already
  `ptp` while it stops. On `chrony` the poll also reads `chronyc -c
  tracking`, so a grandmaster shows chrony's reference and error. A step's
  poll can overlap the periodic one; an older answer never overwrites a
  newer one. `TimeSyncSource` (`packages/shared-types/src/timeSync.ts`, no
  type change) therefore means: `chrony`, also on a PTP grandmaster;
  `ptp`, linuxptp steers (slave-only boxes, and a master-capable box while
  it follows a better grandmaster); `none`, neither daemon runs. Each
  (re-)latch names the source known when its sample arrives.
  `mr-clockstate` writes the post-step sample right after the step line,
  before that line's poll answers, so the re-latch of a handover's step can
  still name the previous owner; `/system/timeSync.source` follows within
  the poll's round trip.
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
  PTP epoch only when it (re)starts on a `traceable` one and keeps the claim
  if sync is lost later (E is still right), free-runs with the reason shown
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
  - a grey `lateness` face badge: render lateness on the outputs that
    render (`lat_render`: video-player, audio-decoder, audio-output-302m),
    PipeWire latency on PipeWire-graph modules, the output lateness mean
    otherwise, network outputs (`lat_egress`) included.
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
  Clock card shows the owner (`chrony` when chronyd is active, else `ptp`
  when `ptp.env` exists and ptp4l is active, else `none`; on a PTP box
  chronyd runs only while it owns the clock, as grandmaster or during the
  setup script's boot wait, and the card then reads "chrony (NTP), served
  over PTP"), synced, estimated and maximum error, frequency, leap state,
  the kernel TAI−UTC in red with "kernel TAI offset not set — CLOCK_TAI
  equals UTC" when 0, chrony's tracking and sources, and the **NTP
  servers** list. The kernel view is `mr-clockstate --once`; synced is
  `isSynced(kernel)` in `TimeStatus.ts`, the engine's predicate
  (`STA_UNSYNC` clear and `maxerror` under 1 s; `MAX_SYNCED_ERROR_US`
  mirrored from `houseClockPolicy.ts`, change both together), sent as
  `TimeStatus.synced` beside the raw kernel flag, so the page reads
  linuxptp's start-up window (flag clear, `maxerror` 16 s) as
  unsynchronised, as the engine does. The chrony view is
  `chronyc -c tracking` and `chronyc -c sources`, parsed from CSV and pinned
  by raw captures from 10.9.16.50 (`api/src/config/fixtures/PROVENANCE.md`).
  chrony's system-time offset is worded as chronyc 4.8 words it, "x
  slow/fast of NTP time": slow only for a positive `current_correction`
  (the system clock behind NTP time), so zero reads fast. That wording is
  an engineering decision, open to the owner's veto.
- **The PTP card asks pmc on the box's own domain and shows the
  grandmaster's time source.** `pmc -u -b 0 -d <PTP_DOMAIN from status.env,
  else 0>`: ptp4l drops management messages from another domain, its Unix
  socket included (`port.c` `port_ignore`), so until 2026-10-14 a
  domain-127 (ST 2059-2) box answered nothing and its port state and
  grandmaster read "—". A fourth request, `GET TIME_PROPERTIES_DATA_SET`,
  returns what the elected grandmaster announces (a slave reports its
  grandmaster's, the grandmaster its own), parsed into
  `PtpStatus.timeProperties` (null unless all six fields are present). The
  **Time source** row names `timeSource` (0x20 GNSS, 0x40 PTP, 0x50 NTP,
  0xa0 Internal oscillator; any other code in pmc's `0x%02hhx`) and adds
  `timeTraceable`: "NTP · traceable" for a chrony-disciplined grandmaster,
  "Internal oscillator · not traceable" for linuxptp's defaults, which
  10.9.16.46 announces today. It informs only (the owner: the election stays
  on Priority alone): no control, no colour.
- **The server list** (`TimeConfig.ts`): 1 to 8 entries, each a host name
  or an IP literal; a name renders `pool <name> iburst maxsources 4`, an
  address `server <addr> iburst`, into
  `/data/chrony/sources.d/media-router.sources`, written atomically, then
  `chronyc reload sources`; a no-change save touches nothing. The file on
  `/data` is authoritative and `config.json` carries no copy, as with
  `ptp.env`. DHCP-offered servers are listed read-only beneath it, read
  from the dispatcher's `/run/chrony-dhcp/*.sources` fragments: `chronyc`
  has no provenance column and answers nothing under PTP.
- **A PTP save stops chronyd only on a slave-only box.** A save with "Never
  become grandmaster" set stops chronyd before restarting ptp4l; a
  master-capable save never names chronyd, which the setup script starts or
  adopts and `mr-ptp-owner` hands over by port state. The ptp4l restart runs
  with a 60 s timeout (`PTP4L_RESTART_TIMEOUT_MS`) because the setup script
  may wait up to 30 s for NTP on a master-capable box whose chronyd is
  stopped. Disable stops the PTP units (`mr-ptp-owner` stops with ptp4l),
  removes `ptp.env` and starts chronyd, a no-op where it already runs. The
  stale `/data/ptp/displaced-time-services` of older builds is removed once
  on load.

### Deleted in this phase (OQ-4: the kill switch goes in Phase 0)

`MR_TIME_SYNC_CONTRACT` and `EngineConfig.timeSyncContract`;
`ClockAuthority.ts` and `gst-net-clock.py` (the legacy shared net clock);
`PipelineDescription.clockSync`, `clock`, `ClockConfig` and
`timeSyncContract`; the runners' net-clock branches and the native
runner's `clock` ineligibility; the audio-decoder `clockSync` setting (its
stored value is ignored, Q9); `aes67_clock.py` and its test; htpdate and
systemd-timesyncd; the PTP displacement block, record and restore logic;
BusyBox syslogd (`busybox-syslog`, with `klogd`), so journald keeps
`/dev/log` (2026-10-14, above). Why now: Phase 0's lateness and E assume
`base_time = 0` on a monotonic clock in every pipeline (§4.1); with the
switch off, `now − PTS` measured nothing. ADR-0005 decision 10's flag text
is thereby historical; it is left as written (Q2) and this section is its
correction.

### Open until the fleet check (plan chapter 4 part 11)

Recorded here so the gate run (WI-P0-14) knows what to confirm; none was
verifiable on a development host:

- On a cold online boot chrony syncs inside the 30 s wait and the wait
  unit succeeds (not failed), and sync follows a restored uplink within
  about 10 s. V1 on .50 and .211 (2026-10-14) saw the wait run out first:
  the dispatcher ran no `chronyc onoffline` then, so chrony retried its
  first failed resolve only after 28 s. Since then the hook is in and the
  wait unit warns and succeeds either way.
- On the image: `/dev/log` is journald's (no `busybox-syslog`), a `logger`
  line and chronyd's own lines reach the journal, and ptp4l (with phc2sys on
  hardware-timestamping boxes) logs one summary per 16 s.
- `mr-ptp-settai.py` with the engine up on .103 or .108: no `step` line,
  then the hold and `re-epoch … ΔE=37000.000 ms` above (R-P0-5).
- The PipeWire latency row of one audio-input or audio-output against
  `pw-top` QUANT/RATE on .103 or .108; so far checked on 10.9.16.22 only.
- The grandmaster on chrony, on a rig isolated on PTP domain 10 (plan
  WI-P0-2b, T0–T12), before 10.9.16.46 is imaged. Its evidence so far is a
  namespace rig on the development host (linuxptp 4.4 built from the release
  tarball, fake `systemctl`/chronyd, free-running clocks): hardware
  timestamping, a real chronyd and real systemd have not run it. The rig's
  `pmc 'GET TIME_PROPERTIES_DATA_SET'` captures (T0/T1) replace the two
  fixtures `PtpStatus.spec.ts` prints from pmc 4.4's format string.

Settled, 2026-10-14 (on the fleet unless marked):

- linuxptp clears `STA_UNSYNC` and leaves the hand-set TAI offset alone
  (R-P0-3): V8 on .103 and .108 (ptp4l up 1.4 h and 4.4 h) read synced
  with `maxerror` 0–500 µs, TAI−UTC 37 and the engine traceable with
  `source=ptp`. Neither fallback is needed; linuxptp's start-up window is
  what the `maxerror` bound covers.
- An `ADJ_TAI` change does not cancel the `timerfd` (R-P0-5): the
  divergence path, above.
- `DHCP4_NTP_SERVERS` is the dispatcher's variable for option 42: V14 on
  10.9.16.50, 10.9.16.108 and 10.9.1.211 listed each lease's servers
  (10.9.12.1, 10.9.12.1, 10.9.50.1) from the dispatcher's
  `/run/chrony-dhcp/*.sources` fragments, and `chronyc sources` on .50
  lists the DHCP-offered server.
- `leapseclist` with an expired `leap-seconds.list` (R-P0-2), from chrony
  4.8's source, not on a box: `leapdb.c:172` logs `Leap second list … needs
  update` and still applies the list, so the TAI offset stays set. The
  `leapsectz right/UTC` fallback is not needed.
