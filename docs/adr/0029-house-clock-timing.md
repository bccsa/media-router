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
TS module (S0), Phase 1 and Phase 2 are below; Phases 3–5 append to this file
when they land (`docs/house-clock-timing-implementation-plan.md`).

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
  coalescing. Per buffer (per list: its first buffer) a `house` tap costs one
  `clock_gettime` and a few adds; a running-time tap (at a bus egress or
  before a sink) adds one element-clock read
  (`gst_element_get_current_running_time`: object lock, clock ref, a second
  time read). No allocation on the hot path either way.
- **Placement and the `reference` rule.** Three kinds of point, two
  references:
  - every bus ingress: `buildBusSrc()` names `mrlateness` as `lat_busin…`
    with `reference=house` *before* the ingress queue, so it reads arrival;
    a dynamic `bus_input_add` gets it from the same string;
  - every bus egress: `buildBusSink()` names it `lat_busout_<port>` with
    `reference=running-time` after the `capssetter ! capsfilter` pair and
    before the `busout_*` tee, i.e. after the `mrtsstamp` splice, so it reads
    the stamp every consumer receives, once a consumer has armed it (below);
  - immediately before an output module's final sink:
    `withLatenessTap('lat_render' | 'lat_egress', sink)` with
    `reference=running-time`.

  `house` compares raw buffer PTS with `CLOCK_MONOTONIC`, the bus convention
  (§4.3); `running-time` compares segment running time with the element
  clock, which is what a sink renders against. Corrected 2026-10-16 and
  fixed 2026-10-22 (plan chapter 15.4 B-26): the draft put the egress tap on
  `house` and said it stays correct in `liveCaptureClock` pipelines. It does
  not: the stamper writes running time there (stamp − base time), so
  video-encoder's tap read its base time plus the encode latency. On running
  time the base cancels. Every pipeline with a bus ingress runs base 0, so
  the ingress taps stay `house`. An egress with no consumer is not stamped
  at all (the lazy arm) and carries the mux's own PTS, so both runners
  forward a `lat_busout_<port>` window only while `busout_<port>` is armed,
  and drop the first after each arm, which holds samples from before it: a
  producer shows no output lateness until a consumer is connected, and none
  without the stamper plugin.
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
  all and is dropped rather than shown as lateness, with one warning per tap
  and run in the module's log. Since the runners forward no unstamped egress
  window (B-26), only a fault produces one.

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
   (`mrtsrestamp` becomes `identity`, `mrasrc` `audioresample`, which keeps
   the nominal-rate conversion, unlocked; B-23), and answer a
   `set_property` on a stand-in with a warning. `mrtsdemux` has no
   stand-in: a description naming it is refused with an `error` carrying
   the same text. The engine shows
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
conditioner**; it stays inside the owner's Pi 4 budget for V-P1-10 (<= +0.05
core per 30 Mbit/s ingest, <= +0.035 core per 302M capture; 2026-10-16,
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
  line by line. The vMix capture came with B-85 (2026-10-22):
  `cap-vmix-h264-aac`, the owner's vMix in its VBR mode (a PCR only on each
  IDR, 2 s apart); #820's CBR mode is still to be recorded.
- **Traces.** Each synthetic `.expect.json` names the deterministic
  `fixture_gen --trace` command that regenerates its trace, so no synthetic
  `.stct` is committed (the twelve come to about 6.9 MB). The field traces
  of WI-P1-5 (2026-10-16) are committed, at most 2 MB each: the OCC
  multicast at its recorded arrivals, a CBR source over SRT, paced and
  bursty, an SRT caller restart, a RIST link drop and a sending module's
  restart on a .108 → .103 loop, and two of the OCC gate's real RIST
  outputs; since B-85 also the owner's vMix (`trace-vmix-sparse-pcr`, a
  PCR every 2 s), since B-90 TECH01's relay of the gate (`trace-tech01-relay`,
  a bursty path). Each expectation's note says where the trace was recorded
  and what its dump shows (plan chapter 15.4, B-32 to B-35, B-85, B-90).
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
fan-out). The capture session (WI-P1-5, WI-S0-9) and the constants tuned
by replay (WI-P1-6, below) are done; still to come in this phase are the
gate checks of plan chapter 5 part 11. The plan's register (chapter 15.4,
rows B-1 to B-48) holds the same records with their work items.

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
- **RTP start-up latency.** `rtpjitterbuffer` releases its first ~160 ms in
  one burst; the lock seeded β from that first sample and slewed it out at
  the acquire slew (2,000 ppm), so for ~80 s after each start content landed
  up to ~160 ms later than source-natural. WI-P1-6's start rule (below)
  moves the first epoch onto the floor its first two buckets agree on, so
  such a burst costs one drop of its overlap at 2 s instead; no RTP trace was
  captured, so this case stands on the synthetic `syn-start-burst` and the
  SRT start of `trace-816-clean-cbr`. An SRT listener started while its
  caller was connecting showed the same burst (0.5 s); RIST and raw UDP
  showed none.

### The virtual STC (`mrts::ClockLock`, `VirtualStc`; plan part 4.3)

- **The two stages as planned, at the constants WI-P1-6 chose by replay**
  (`ClockLockConfig`, `PcrValidatorConfig` in `ts_stc.h`; below): bucket
  minima per second, a least-squares rate fit refit once without the points
  more than 2 MAD above the line, a first-order follower (τ 120 s, the
  plan's 60 s doubled; clamped at ±1,000 ppm, warning past 100), and a
  lower-envelope offset over the last 10 buckets with a 2,000 ppm acquire
  slew for 5 s and a 20 ppm track slew. Integer arithmetic, so a replay is
  bit-exact on every machine. A program is `locked` once the rate is known
  and the acquire time has passed, and `lost` after 5 s without a sample;
  the mapping survives `lost`.
- **The first epoch moves onto its floor** (WI-P1-6). In a lock's first
  epoch, the one the pipeline started with, when its first two buckets agree
  within `step_ns` on a floor more than `step_ns` below the line, the line
  moves onto that floor at their close (2 s) instead of slewing to it. What
  already left on the first sample overlaps and the guard drops it, once.
  Why: a transport's start burst seeds the epoch far above the floor, which
  the acquire slew cannot remove (70 ms before the lock) and the track slew
  takes hours for (below). Refined 2026-10-16 (plan chapter 15.4 B-45): while
  the bucket minima keep falling by more than `step_ns` (a caller's backlog
  draining), the first epoch tests again at every close until a pair agrees
  or rises (a dip passed: nothing moves); and in any epoch and phase two
  buckets agreeing on a floor more than `backlog_ns` below the line move it,
  which is how a reconnect into a running keep-listening listener, a relock
  seeded on the backlog's oldest sample, gets its floor. `backlog_ns` is
  490 ms, the owner's choice (B-48, 2026-10-21; 500 ms, as `leap_ns`, in
  B-47; 4 s as first built): `leap_ns` less the 10 ms the acquire slew can
  take from a relock's seed before the backlog's floor shows, so a backlog
  that relocks lies past it, while the largest delivery swing measured (the
  bursty encoder's dips: its line moves at 420 ms, not at 430) stays under
  it. At 4 s a relock backlog of 1–3 s left the egress that early for the
  1.4 days the 20 ppm slew needs, and one of 3.5–3.9 s degraded the
  program; at 500 ms one within those 10 ms past `leap_ns` relocked but
  could stay about 0.5 s above the floor for the 7 h of the slew (30 of 160
  replays at 500–512 ms; none at 490 ms). The other edge lies a few ms
  under 490: at 485 ms a gate PES envelope's dip (a clamped PID's lock,
  100 s after a stall relocked it) moves the line, drops 0.47 s and
  relocks 10 s later. `mrasrc` has the second rule off: its PTS is the
  capture time.
- **A caller's backlog is stale** (B-39, B-45). While the live line lies
  more than `lead_max_ns` above the floor its open and last closed bucket
  show, or more than `backlog_ns` above it (a backlog's: the floor rule
  moves it at the next agreeing pair) and would put the PES more than
  `lead_max_ns` ahead by its own doing (its lead less that floor gap within
  `lead_max_ns`, B-47, B-48), what it maps is stale: the PES is dropped and
  counted as overlap (its run's event says `backlog`), its lead stays out of
  the lead row, so a drain, however slow, never degrades the program (B-48:
  before, only a line past `lead_max_ns` kept it out, and drains of 10–30 s
  with a PID 2–2.5 s ahead degraded it, one 137 s off its source lead
  after), and the written PCR follows arrival less 250 ms, never back,
  flagged at both switches (a frozen PCR would read as a freeze one hop
  on). The first PES of a PID that shows a hole after the run carries a
  gap marker, reason `backlog`. So a reconnect plays at most 4 s of the
  backlog (3.5–3.8 s on the traces) and loses 2–3 s of the live content
  (the two buckets the line waits for after the drain), where the build
  before it degraded on the lead row and then dropped up to the whole
  backlog of live content (30 s on .103, 86 s on .111). The floor gap
  judges the line, not a PID's lead, and the second
  clause takes only a lead the floor gap explains, past `backlog_ns`, so a
  source far ahead, or one just past 4 s under a line that jitter or a
  slewed fall keeps a little above its floor, reaches the lead row and the
  clamp below (before B-47 the clamp came 3–28 s late there, its drop and
  gap named `backlog`; before B-48 a PID 4.0–4.15 s ahead on the gate's
  delivery lost 16–76 s as a backlog's and was never clamped). A backlog
  under 4 s is not stale, but for what the seed would put past 4 s: the
  line moves, after a relock too, and up to about twice its length of live
  content goes, the guard's drop as at a start burst and, after a relock,
  the drain's tail the straddle rule maps onto the old epoch, whose hole
  carries a gap marker (B-48); the written PCR's step back there carries
  `discontinuity_indicator`, as every PCR step back does (B-47).
- **A step-seeded line comes down by the window rule** (B-95, the owner's
  choice of 2026-10-22 over `step_hold_ns` 20 s). On a line an envelope
  step's sample seeded (the PCR lock's, the reference lock's or a clamp
  lock's, whether or not the step opened an epoch) the backlog rule gives
  way to the window rule: the line moves down only onto L*, the highest
  level some `step_hold_ns` run of the last `step_fall_hold_ns` (300 s, the
  fit window, kept in the lock's own history of closed buckets) stayed
  above, once that lies more than `backlog_ns` under it, so the last run
  that could have stepped ended 300 s before. The stale rule's second
  clause marking a PES on that line brings the backlog rule back at the
  next close, for the whole line (B-48 (1): a stale run never outlasts a
  move). Every other line keeps the backlog rule; the leap row is
  unchanged. Why: TECH01's relay (B-90) delivers 400–600 ms late for 12 s
  every 150 s, then runs under its usual level for 6–7 s; the burst's
  envelope step seeded its epoch on a late sample, the dip lay more than
  `backlog_ns` under that seed, the line moved onto it (560–620 ms dropped
  per PID) and the usual level stepped again 20 s on: relocks in pairs, 12
  of them and 6.0 s dropped in 930 s, now 2 relocks and 0.08 s (the start
  burst's), the lead median 80 → 392 ms; of 87 replay traces only TECH01's
  pair changes. The owner's trade: such an input's delay settles at the
  bursts' full height plus the step's own sample (+0.3–0.6 s on TECH01, out
  of the 4 s lead headroom; growing bursts ratchet it to the tallest for
  300 s), re-stepped every 12.5–22.5 min with no drop as the slew lets the
  burst tops over the line; one PID within the held excess of the 4 s bound
  brings the pairs back for every PID of its program (the yield); a drained
  queue's excess above the bursts stays while under 490 ms and is shed
  5 min later when more; every relock that is not a step (a leap or
  discontinuity, a degraded entry, an external relock) re-seeds the line at
  the usual level and drops the held excess once per PID (about 0.36 s on
  TECH01's shape at a restart or a jump, 0.26 s at a PCR fault). The limit:
  at a 1–2 s PCR a burst whose tail falls, or whose onset rises, by more
  than `leap_ns` between two PCRs is a leap and keeps the pairs (TECH01's
  PCR comes every 60 ms; vMix's 2 s PCR does not burst). The relay's bursts
  themselves are #847 (the 150 s cycle is already in NO-OCC-Gate01's RIST
  output). `step_hold_ns` 20 s, measured as the alternative, avoids the
  steps but also lengthens the rate fit's level hold (18 of 87 traces
  change, 7 of 38 expectations fail).
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

- **The checks, one row each** (`PcrValidator`): cadence (the PCR against
  its own cadence, the longest of its last 8 self-timed intervals: late past
  twice it, never under 500 ms nor over 4 s; one or two late intervals in
  60 s raise the warning, three fail, the first fails a program with none yet;
  counted only while packets keep arriving, so an outage is not a PCR fault;
  recovery clears the windowed counts. B-86, the owner's: a steady 2 s PCR
  locks); rate (the raw fit past 1,000 ppm for 30 s); freeze (three
  consecutive PCRs with `Δσ < Δh / 2` and `Δh ≥ 30 ms`); leap
  (`|Δσ − Δh| > 500 ms` without `discontinuity_indicator` re-locks; three in
  60 s fail; the plan's 250 ms read the gate egress's delivery stalls as
  leaps, WI-P1-6 below); lead (a PID's 1 s median stream lead (its PTS, DTS
  for video, less the program's last PCR) below −200 ms, or its 1 s median
  lead against arrival above +4 s, for 5 s). The lower bound read the lead
  against arrival until B-90, where a bursty delivery (TECH01's relay of the
  gate) degraded the program at every start; a mux that writes its PTS behind
  its own PCR still degrades.
  The first failing row is the stats `reason`; a re-lock's reason is
  `discontinuity`, `leap`, `envelope-step`, `external` (the PMT's PCR PID
  changed) or `ref-change`.
- **Degraded mode** feeds a warm second `ClockLock` with the reference PID's
  PTS (DTS for video) against the arrival of its PES headers: the PCR PID if
  it carries PES, else the first video PID, else the first audio. Its lower
  envelope lands the reference PID at its earliest arrival (lead 0), which
  removes #820's 12.6 s lead. Entering it moves the program onto that floor, so the guard
  drops about the source's lead on every PID at the switch
  (`syn-pcr-dense-to-sparse` drops ~0.6 s per PID). The output PCR is regenerated by
  the conditioner's rule: the reference PID's last written key, pulled down
  by up to 1 s to a video or audio PID with a PES in the last 500 ms, minus
  250 ms, never back among regenerated values. Return needs 30 s of PCR in
  which no row failed: since B-90 an observation restarts that clock only
  where its row fails (its count or its hold reached), so a bursty delivery's
  single frozen pairs no longer hold a program degraded for good; a new PCR
  epoch then opens with a `recovered` event, and the windowed counts (late
  crossings, leaps) start afresh (B-86).
- **The per-PID lead clamp** (plan part 4.3; B-8, built 2026-10-16, B-45).
  Degraded, a PID other than the reference whose lead under the reference
  mapping passes `lead_clamp_ns` (4 s, under the 5 s bus ingress queue)
  leaves on a `ClockLock` of its own: its earliest arrival, lead 0. Its
  leaps and envelope steps relock it as the reference lock's do, and it has
  an epoch id of its own, so the guard and the gap see the switch. What it
  had left ahead before the program degraded overlaps and goes as one run.
  `lead-clamp` (`pid`, `value-ns` its lead) is posted at once and every
  30 s while the clamp holds, so the card's 60 s "Source lead above 4 s on
  PID 0x… — clamped" warning lasts as long as it; the clamp holds until the
  program recovers.

### The constants, tuned by replay (WI-P1-6, 2026-10-16)

- **The sweep.** `mrts_cli restamp-replay --sweep` over plan part 4.3's
  grid, committed as `plugins/mpegts-core/tests/fixtures/restamp/sweep-grid.json`:
  `bucket_ns` 0.5, 1, 2 s × `offset_buckets` 5, 10, 30 × `rate_tau_ns` 30,
  60, 120 s × `slew_track_ppm` 10, 20, 50 × `step_ns` 10, 20, 50 ms, 243
  points, on 57 traces: the eight field traces of WI-P1-5, the thirteen
  synthetic expectation traces (`trace-812-slow-source` and
  `syn-start-burst` included) and 36 drift traces (±50 and ±500 ppm, nine
  seeds each, 610 s). Each sweep line carries
  the program's summary, ε at 60, 120, 300 and 600 s included. A second
  sweep at 1 s buckets, a 20 ppm track slew and a 20 ms step covered
  `rate_buckets_min` 20, 30 × the three M × the three τ × `leap_ns` 250,
  350, 500 ms.
- **The criteria** (part 4.3, with WI-P1-1's lock time): **C0** locked within
  the trace's bound (40 s; the bursty encoder 250 s); **C1** re-locks as the
  trace's expectation (none on the clean ones); **C2** residual min ≥ −1 ms
  once locked, on the traces whose floor never falls by design; **C3** on the
  drift traces |ε error| ≤ 0.5 ppm at 300 s on the median seed and at 600 s
  on the worst; **C4** the mapping never faster than 20 ppm while locked
  (plus one bucket's travel in the 30 s measuring window). The gate's two
  traces, today's sender, are judged by what they drop.
- **What the grid says.** 36 of 243 points pass, all at 1 s buckets. 2 s
  buckets lock at 65–68 s (C0: the first fit needs 30 of them); 0.5 s
  buckets miss C3 (0.81–1.32 ppm at 600 s on the worst seed: a 150 s fit
  window) and C2 on a drift seed; a 50 ppm track slew fails C4 (the
  re-route trace slews its fall at it); a 50 ms step fails C1 (the
  re-route's +30 ms rise is no step). M and τ pass at every value. τ sets
  the worst seed at 600 s: 0.33–0.41 ppm at 30 s, 0.27–0.34 at 60 s,
  0.16–0.25 at 120 s; the median at 300 s is 0.17–0.24 ppm at every τ, the
  fit window still growing.
- **The set shipped:** 1 s buckets, `offset_buckets` 10, **`rate_tau_ns`
  120 s** (was 60 s), a 20 ppm track slew, a 20 ms step,
  `rate_buckets_min` 30, the start rule above, and **`leap_ns` 500 ms**
  (was 250 ms). Not the longest M: on the jittery field sources a 30-bucket
  envelope holds the deepest dip longer, so content lands earlier than most
  of its arrivals; the bursty encoder's relock gap grows from 206 to 407 ms
  and gate 20010 degrades on the lead row (1.9 s dropped, against 0.63 s at
  M 10). On every clean trace M changes nothing. The track slew stays at
  20 ppm (10 ppm passes too and recovers from a floor fall half as fast),
  the step at 20 ms. A 2 s bucket with a 15-bucket first fit also passes
  C0–C4 (C3 at 600 s 0.11–0.18 ppm), but widens the bursty encoder's relock
  gap to 315 ms and moves every unit test's timing; 1 s meets C3 with twice
  the margin. `rate_buckets_min` 20 locks about 10 s sooner and adds a
  relock on each gate trace; no criterion asks for it (B-7).
- **The start rule, measured.** No constant of the grid removes a start
  burst: on `trace-816-clean-cbr` (an SRT listener started while its caller
  was connecting: 0.5 s of content in 3.4 ms) every one of the 243 points
  left the residual at −386 to −476 ms at the lock and the mapping at the
  track-slew cap for all 905 s. With the rule: −0.07 ms, the mapping at most
  3.9 ppm, and one drop at 2.5 s, 479 ms of video and 511 ms of audio. Only
  the first epoch: applied at every relock it raised the drops on the gate's
  wandering delivery from 17.6 to 24.2 s (20010), and a relock happens on a
  running transport, whose backlog is no start burst. Two buckets, not one:
  the bursty encoder's first bucket holds a 360 ms dip its second does not
  confirm, and moving onto it dropped 741 ms and left a 366 ms gap. Keeping
  the acquire slew until the floor instead left 2,000 ppm on the PTS for
  four minutes and added three relocks on the bursty encoder. mrasrc's lock
  takes the same rule at its own 50 ms step (a 40 ms start burst is slewed,
  80 ms moves), and its servo slews the phase change out at the ratio clamp:
  with a first buffer labelled 85 ms late (a 4,096-frame quantum) the labels
  are within 1 ms of capture time by about 100 s, where the slewed lock left
  them 12 ms late after 3 min. B-25's one-quantum start (under 50 ms) is
  unchanged.
- **A delivery stall is no leap: `leap_ns` 500 ms.** On the gate's RIST
  outputs the PCR advances 60 ms per PCR while arrivals come 0–384 ms apart:
  stalls, then catch-up bursts. Under 250 ms the 13 stalls longer than
  310 ms in 520 s read as timeline leaps; each relocked, three in 60 s
  degraded the program for good, and the straddle and overlap rules dropped
  3.4–5.1 % of the content (B-34). At 350 and at 500 ms the same traces
  relock 0–1 times, never degrade, and drop 0.63 s (20010's start rule) and
  nothing (20046); 500 ms keeps a margin over the largest stall seen on the
  three ports (a 353 ms miss). The cost: a timeline jump or re-route between
  250 and 500 ms now waits the envelope step's 10 s hold (a rise) or is
  slewed (a fall) instead of relocking at once; `ts_restamp_test`'s +300 ms
  re-route became an envelope-step case and the leap case is +600 ms. A
  leap check that confirms a jump from the PCRs after it would remove the
  trade; it is not built.
- **Per trace, with the shipped set** (`restamp_replay_test` passes every
  expectation file with it):

  | Trace | Relocks | Locked | Residual min | Mapping max | ε locked (ppm) | Dropped |
  |---|---|---|---|---|---|---|
  | `trace-occ-1080i` | 0 | 38 s | −0.002 ms | 0.10 ppm | −0.13…−0.05 | 0 |
  | `trace-816-clean-cbr` | 0 | 36 s | −0.067 ms | 3.94 ppm | −6.75…−0.46 | 990 ms at 2.5 s (start burst) |
  | `trace-srt-restart` | 1 (leap) | 38 s | −0.129 ms | 4.04 ppm | −5.88…−1.12 | 0 |
  | `trace-rist-reconnect` | 0 | 38 s | −0.119 ms | 5.85 ppm | +17.5…+23.2 | 0 |
  | `trace-836-program-split` | 0 | 38 s | −0.218 ms | 11.9 ppm | +19.6…+30.1 | 0 |
  | `trace-srt-bursty-encoder` | 1 (step) | 246 s | −464 ms | 20.3 ppm | −16.6…+16.1 | 0 |
  | `trace-gate01-rist-20010` | 1 (step) | 178 s | −389 ms | 20.2 ppm | +14.9…+71.0 | 625 ms at 2.4 s (the start rule) |
  | `trace-gate01-rist-20046` | 0 | never | — | — | — | 0 |
  | `trace-812-slow-source` (−300 ppm) | 0 | 36 s | −0.248 ms | 12.9 ppm | +284.4…+300.4 | 0 |
  | `syn-start-burst` | 0 | 36 s | −0.099 ms | 6.37 ppm | −5.0…+5.0 | 1,472 ms at 2.5 s (3 PIDs) |
  | `syn-reroute-30ms` | 1 (step) | 38 s | −29.9 ms (its fall) | 20.0 ppm | −5.1…+23.9 | 0 |
  | `syn-rewind-1s` | 1 (leap) | 38 s | −22.4 ms | 20.0 ppm | −5.2…+4.1 | 288 ms (its straddlers) |
  | `syn-pcr-discont`, `syn-straddle-audio` | 1 each | 36–38 s | ≥ −0.17 ms | ≤ 6.2 ppm | — | 0 |
  | `syn-outage-continuous-pcr`, `syn-wrap-33bit` | 0 | 36 s | ≥ −0.22 ms | ≤ 12.3 ppm | — | 0 |
  | `syn-pcr-sparse` | 0 | 36 s | −0.37 ms | 20.2 ppm | −17.2…+18.1 | 0 (one late interval at the cadence change: the warning, not degraded; B-86) |
  | `trace-vmix-sparse-pcr` (a PCR every 2 s) | 0 | 74 s | −0.99 ms | 21.3 ppm | +5.9…+24.0 | 0 |
  | drift ±50, ±500 ppm, 40 traces | 0 | ≤ 38 s | ≥ −0.24 ms | ≤ 10.0 ppm | off by ≤ 0.24 at 300 s (median), ≤ 0.25 at 600 s (worst) | 0 |

  The bursty encoder and the gate's outputs are no clock floor, so their
  residual is the delivery's own spread. On the gate's lower envelope a
  PES's house PTS lies up to 554 ms before its arrival after the worst stall
  (median +137 to +147 ms on 20010, −34 to −53 ms on 20046): a Phase 1–4
  receiver of that sender needs that much latency at its outputs (plan
  R-P1-14). ε on `trace-816-clean-cbr` is the floor's own slope
  (two chrony-disciplined boxes, −2.2 to −0.35 ppm per 2 min), so V-P1-1's
  ±0.1 ppm needs a source with a stable clock (the OCC encoder: within
  0.1 ppm).
- **mrasrc** keeps its 50 ms two-sided step: no capture of a 20–50 ms
  latency change exists (B-16). It inherits τ 120 s; over 100 seeds × 1 h
  its lock (35.0–36.0 s) and frame counts (≤ 0.70 frames at 0 and ±50 ppm,
  ≤ 1.19 at ±500 ppm, median 0.50) are those of τ 60 s to 0.01 frames, and
  the +30 ms latency rise leaves labels 1.7 ms off at 300 s (2.2 ms). The
  ±500 ppm excess over ±1 frame does not come from these constants: a 2 s
  bucket gives 1.26–1.29 frames over 30 seeds.
- **Determinism checksums moved** with τ and the start rule's test: `ts_stc`
  85f5a95a7a801a1f → d0ec660233eef7cd, `asrc_servo` 65ba266b108a634c →
  432e8439f253974f (the degraded scenario 6efe69276bb82fa9 → d20527d208b11b30;
  the straddle scenario unchanged). The backlog rules and the clamp (B-45)
  leave every one of those scenarios bit-identical (`ts_stc` still
  d0ec660233eef7cd without the new cases); with the backlog and clamp cases
  folded in, `ts_stc` cf41dd134b4fbac4; `asrc_servo` unchanged.
- **The backlog traces** (B-45, with the shipped set): `syn-reconnect-backlog-30s`
  (30 s queued, drained in 1 s): never degraded, one overlap run per PID at
  3.5–3.7 s, no PES more than 4 s ahead; `-90s` (5 s drain): the line moves
  at 7 s, a gap marker of 3.2–3.4 s per PID, then live; `-relock` (the
  queue after 60 s live): one relock (leap), a gap of the outage per PID,
  then as the 30 s case; `-3s` (2 s drain): the first epoch moves at 4 s
  and the guard drops about 3 s per PID once. `syn-lead-clamp` (the AAC PID
  12.6 s ahead): degraded (lead) at 5 s, `lead-clamp` on it at once and
  every 30 s. `trace-srt-reconnect-backlog` (a real 85.5 s backlog on .111,
  drained in 0.59 s): one overlap (backlog), never degraded, locked at
  38 s. The grid re-run on the 63 traces with these six: the same 36 of 243
  points pass C0–C4 as before, and the shipped point passes every
  expectation file. On .103 and .111 a queuing caller's reconnect (the
  listener away 30 s and 90 s, or the network 30 s) played at most 3.3 s of
  its backlog and was back at the source lead within 4–6 s.

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
- **The PCR is flagged for Phase 1–2 consumers, only where its timeline
  breaks** (B-84). `discontinuity_indicator` is set on the first written PCR
  after an outage or a PES gap of 1 s or more, after a relock, when the PCR
  is written on another epoch's line or with another shift, when it changes
  between mapped and regenerated, and when it steps back: those consumers
  still run `tsdemux` in PCR mode and would otherwise read a PCR jump as an
  error. A source's own PCR spacing is no break. `tsdemux` re-bases at
  every flagged PCR, and the build before, which also flagged any PCR 1 s or
  more after the one before, flagged every PCR of a source that sends one
  every 2 s (vMix's VBR mux): a consumer's output stepped by 1.7–18 ms at
  each. The trace recorder writes a PES's `di` as the source sent it, read
  before the restamp may set the bit on the same packet (B-84).

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
  a live edit (`edit`), after an outage (`outage`), after a backlog's stale
  run (`backlog`), or in fixed mode a jump (`jump`, below), when the PES
  lands after the end of what the PID last emitted; and on its first PES on
  another epoch than its previous PES's, kept or dropped, that leaves a
  hole of a PES or more (`epoch`: a straddler back from a run dropped on the
  old epoch, a clamped PID back on the program's; B-48, before which such
  holes of 0.3–2 s after a relock backlog went unsignalled). The event is
  timed by that PES's arrival, as an overlap is. During an outage the
  element's own `GstTask` (`arrival=clock`, in PLAYING) pushes one buffer
  with a packet per PID whose gap has started, at 1 s without packets and
  every 250 ms after (OQ-17; measured 1000.5 ms, then 250.2–250.6 ms
  apart); the resume marker comes from the stream.
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
  PES length: those two are false. On a video PID the hole, the step less
  the PID's last spacing, must also be 1 s or more (`GAP_FLAG_NS`, the
  restamp's outage and PCR-flag bound; B-89): one dropped frame is a
  spacing of two frame lengths ± capture jitter, so the 2× rule alone
  marked about half of a loaded capture's drops (7,655 in 66.7 min of
  .108's ATEM capture at 19.6 fps), each a `tsdemux` flush downstream and
  a log line, where a decoder only holds the last frame. A video marker is
  never shorter than its PES length.
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
- **Measured against the plan; WI-P1-6 kept the ASRC's constants.** The
  lock takes 35.01–36.01 s (plan 30 s: the STC's 30-bucket first fit plus
  the 5 s acquire). Over 1 h the frame count is within 0.70 frames at 0
  and ±50 ppm and 1.19 frames at ±500 ppm (plan ±1), the same with the
  tuned τ (above) and with a 2 s bucket (1.29), so the excess is not the
  bucket minima's. A device past the ratio clamp now relocks on falls as
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
  rate past 100 ppm or ASRC ratio past 200 ppm for 60 s, a PCR that comes
  irregularly (B-86; a steady sparse one shows its cadence in the State row
  instead: "Locked (PCR every 2.0 s)"), and
  transport errors (`cc-lost` or `desync-bytes` rising for 10 s, read as
  running totals from every program's stats message). None drops content.

### Open at the end of the build

- The Pi 4 bench of WI-P1-8 and the part 11 gate checks, on the rigs.
- The restamp's runner CPU stays above today's stamper and conditioner on
  the same wiring (S0 Budget above, on a Pi 4: +0.040–0.044 core per
  28.6 Mbit/s ingest, +0.033 core per 302M capture). The owner set V-P1-10
  to a Pi 4 budget on 2026-10-16/17, at most +0.05 core per 30 Mbit/s
  ingest and +0.035 core per 302M capture, which these figures pass.
- A reconnect backlog under 4 s is not stale: once the line moves onto the
  floor, after a relock too since B-47, the guard drops that much of the
  live content once (B-45, as at a start burst, B-37), and a keep-listening
  reconnect loses up to about 2 s more where the straddle rule maps the
  drain's tail on the old epoch (signalled since B-48).
- `backlog_ns` 490 ms (B-48, the owner's, 2026-10-21) clears both of its
  edges on today's traces by 0–5 ms: a relock backlog within 10 ms past
  `leap_ns`, which 500 ms left about 0.5 s early for hours, and a gate PES
  envelope's dip, onto which 485 ms and under moves the line. Should a
  field trace land in that window, the fallback is the rule only in an
  epoch a leap opened (4 s elsewhere), with the stale rule's second clause
  scoped alike and in the first epoch, so that a stale run never outlasts
  a move.
- Since B-90 a degraded program recovers once no row failed for 30 s, which
  trades the latch for flapping on a source within its delivery's jitter of
  a bound: the gate window fixtures recover and degrade again, each switch
  moving the PID past 4 s by its lead (about 5.5 s more dropped).
- In `stc` mode a source's own PTS step under the leap row passes with no
  marker (fixed mode's jump check is not applied): the gate's own 215–220 ms
  step on every PID at 421 s of `trace-gate01-rist-20010` and at 345 s of
  `-20046`. For Phase 2's aligners (R-P1-5).
- `trace-820-vmix-pcr` (OQ-3) still has to show the clamp on a real vMix
  feed, which takes the owner's vMix SRT output switched to CBR for one
  recording: in its VBR mode (`trace-vmix-sparse-pcr`, B-85) the PCR is
  sparse but steady, with no lead to clamp. `syn-lead-clamp` and
  `syn-lead-clamp-floor-fall` stand in.
- Decided 2026-10-22 (B-86): a steady sparse PCR locks; the vMix shows
  Locked with "PCR every 2.0 s".
- A floor step under `step_ns` inside the first fit window bends ε: the
  SRT receiver's +2.85 ms time-base correction 35 s after a reconnect read
  as 43–71 ppm (186 ppm on .111's own run), decaying with τ (plan chapter
  15.4 B-46). A fit that tolerates one level shift would remove it.
- The DISCONT flag on markers (above). The RTP start-up burst is the start
  rule's case, but no RTP trace confirms it yet.
- The leap row cannot tell a delivery stall from a timeline jump: 500 ms
  clears today's gate egress (its largest stall misses by 353 ms), and a
  250–500 ms jump now waits the envelope step's hold. A leap confirmed by
  the PCRs after it would remove the trade (WI-P1-6).
- A sender whose delivery swings by ±300 ms (today's gate egress) lands on
  its lower envelope, so its PES reach a receiver up to 554 ms after their
  house PTS: a Phase 4 output's latency, or the ingest offset, must cover it.
- Closed 2026-10-22 (plan chapter 15.4 B-26): the bus-egress lateness tap of
  a `liveCaptureClock` pipeline read the base time, so video-encoder's card
  showed minutes on a box up less than an hour and no output lateness after.
  The egress taps now read running time, exact under any base time (Phase 0,
  above).

## Phase 2 (built 2026-10-16 to 2026-10-18, gate pending) — identity only, the splitter passes through, aligners wait

After Phase 2 every bus egress stamps by identity, `PES − 1 h`, and nothing
between ingest and egress estimates, conditions or re-anchors time (§6
item 7). The anchored stamper, latch repair, the drift servo and the wire
conditioner are deleted with their runner and engine glue. The ts-splitter
passes PES and the program PCR through; the HLS fan-out puts hls-player's TS
on house time once; and every aggregation point (the 302M mixers, the
audio-processing interleave, the mpegts-muxer) takes its inputs on content
time through `mralignwatch`, waits for data or a gap on each and drops
nothing late. The ducker runs in the pipeline, on content time. WI-P2-0 to
WI-P2-15 were built code only, on the dev Pi 5 with GStreamer 1.28.2; the
gate checks (WI-P2-16, plan chapter 6 part 11), the field captures of part
7.4 and the capture-based conformance runs are still to do. The plan's
register (chapter 15.4, rows B-49 to B-78) holds the same records with their
work items.

### Identity is the only stamp mode (WI-P2-2, WI-P2-3)

- **`mrts::IdentityStamp`** (`ts_house.{h,cpp}`) holds the rule
  `stamp_house` held, with its state per stream: a stream's timing PID is
  its first PCR carrier; its first timing PES (`timing_pes`: a video or
  audio stream_id, or any PES on the timing PID) gives
  `house_from_mux_pts(PTS, house_now)`; a buffer whose PES are none timing
  is stamped at arrival; a PES-less buffer repeats the stream's last stamp
  (arrival when it is the stream's first). Stamps never fall within a
  stream, and the floor starts at 0, because libmrbus reads a negative stamp
  as "stamp at send". API: `stamp(data, len, house_now, stream)`,
  `first(stream, &pid, &stamp, &pts)` (the stamp before the floor, the old
  anchor event's value) and `reset()`. The draft had one timing PID per
  instance; `mr-tssplit` stamps every output through one instance with
  stream = PID, and a shared timing PID would have stamped a KLV output at
  arrival.
- **Pinned by vectors** recorded from the old house-timeline mode before it
  was deleted: its two ladder cases and a corpus of 300 scenarios (38,708
  buffers of one to three streams, with steps, 33-bit wraps, late PCRs and
  garbage), checksum `0x047423b83c74b0a7`. The Python reference
  (`TimelineStamper(house_timeline=True)`, one instance per stream) gives the
  same stamps. The one intended difference is several streams through one
  instance.
- **`ts_timeline` keeps `timing_pes` only**, 30 lines: the stamper, latch,
  watch, staleness net, late/early tiers, drift servo, conditioner and their
  event JSON went (−3,184 lines with tests), and every binary that linked
  them is about 70 KB smaller. `IdentityStamp` calls `timing_pes`, so Phase 3
  moves that rule into `ts_house` instead of deleting it. `py/ts_timeline.py`
  stays as the reference (OQ-1); its docstrings still describe the C++ port
  that is gone.
- **`mrtsstamp` 3.0.0** stamps by identity only. Properties `active`,
  `copy-count`, `bytes-total`, `coalesce`, `coalesced-lists`; messages
  `mrtsstamp-identity` (pid, stamp, pts; once per arm), `-segment-warning`,
  `-map-failed`. The identity path is Phase 1's: the clock time is
  `house_now`, a stamp maps to running time `max(stamp − base_time, 0)` and
  back through the segment, PTS = DTS; a gap marker leaves with its PTS,
  duration and flags and no DTS; a buffer list holding a marker is chained
  member by member and any other list is coalesced (ADR-0011). Every change
  of `active` forgets the stream.
- **One log line per arm, the same words in both runners** after their
  prefix: `busStamp <tee>: identity egress: first PES pid=0x<hex>
  stamp=<ns> pts=<90 kHz>`, after `busStamp: identity egress armed on <tee>
  (PES - 1 h, native mrtsstamp)`. No engine event.
- **No Python probe.** Without `libgstmrtsstamp.so` a producer's egress runs
  unstamped and the module carries the rule-6 alarm in both runners: a
  `warning` of kind `timing_plugin`, detail `libgstmrtsstamp.so not loaded,
  tried <paths>`, with `started.timingPlugin` null so the engine does not
  clear it. The plugin is loaded only for a pipeline with a `busout_*` tee,
  so a consumer never tries or misses it. `gst_stamp_probe.py` is deleted,
  and both loaders' `alarm()` is public so the stamper raises the loader's
  own event.
- **Gone with it:** the description fields `latchRepair`,
  `houseTimelineEgress` (eleven modules declared it; the plan named four)
  and `preserveSourceTimeline` (with its type, the Python runner's code and
  the transcoder's and audio-transcoder's x-advanced setting; stored values
  are ignored, OQ-33); `isDeliveryLeadProducer`, `latchRepair.ts`,
  `MR_LATCH_REPAIR`, `MediaRouter.getUpstreamBusProducers`; the runner drift
  timer and the `timeline_*` events. The playout rebase warning names
  "identity unwrap" as its cause.
- **subtitle-core** stamps its three suites with a local identity helper,
  equal to the reference on 10,832 stamps; `subtitle_stamp_dump.py` is
  retired and `stamp_model_vectors.txt` frozen. The engine test's −600 s
  jump went: on an identity bus content only moves forward, since the
  restamp turns a source jump into a gap.
- **Open (B-53).** An egress armed mid-stream whose first buffer carries no
  timing PES (a 302M or Opus PES before the first PCR, or no PES) is stamped
  at arrival, and the floor holds what follows until its content passes
  that arrival: +100, +79, +58 and +36 ms on the first four buffers at
  100 ms of content lag. With identity the only mode, every 302M and Opus
  egress meets this at each arm, a mixer's by its pace. The same happens
  mid-stream to a buffer of private PES alone (a KLV or teletext cue at a
  muxer's egress): it is stamped at arrival, and the A/V buffers after it
  are held at that stamp until their content passes it, for at most the
  egress's content lag. Neither loader checks `mrtsstamp`'s version either,
  so a stale 2.x copy would load and stamp anchored, without an alarm.

### The splitter passes the stream through (WI-P2-4)

- **`mr-tssplit`** keeps `SplitterCore` (the PSI carousel; the program PCR
  copied onto non-PCR outputs at least 10 ms apart) and stamps each output
  buffer `identity_.stamp(data, len, mono_ns(), pid)`. The stamper, the
  conditioner, the `timeline` stats object, `--stamp-timeline` and
  `--no-latch-repair` are gone; either flag is now `unknown arg`, exit 2.
  Phase 0's lateness window per output stays.
- **Gap markers cross the splitter** (R-P1-5). unixfdsink and unixfdsrc copy
  GstBufferFlags over the wire, and libmrbus gained additive overloads that
  carry them: `BusClient` with `OnBufferEx(data, len, pts_ns, flags)`,
  `FanoutServer::broadcast(…, flags)` and `BUFFER_FLAG_GAP`. A GAP-flagged
  input buffer bypasses the core. Each of its packets that
  `read_gap_length` reads as a marker on an output's PID first flushes that
  output's pending data, then leaves alone, with the input buffer's PTS and
  flags, unstamped (its PTS is already house time) and counted in the
  output's lateness window. Other packets of a GAP buffer are not
  forwarded. Flags pass as they come, so a GAP-only marker (B-20) would
  cross the same way.
- **Tested on a field capture**: the OCC recording's first 2 MB
  (`cap-occ-1080i-h264-21aac-ttx.ts`, drafted as `-mp2-ttx` and renamed for
  what it holds (B-85): H.264 1080i on the PCR PID, 21 AAC PIDs, teletext, a
  514-byte PMT ahead of each PAT),
  rebased onto house time. Each output's PES are byte-identical to the
  input PID's (sha-256, and `mrts_cli dump` crc32 per PES); every injected
  PCR is an input PCR, at least 10 ms apart; every stamp follows
  `IdentityStamp`'s rule; there is no timeline event; a marker leaves alone
  with its PTS and flags. The parity vitest and `mrts_cli`'s splitter mode
  are deleted.
- **What the rule means on a splitter.** A video buffer whose first PES is a
  B-frame below the last stamp is held at the floor (9 of 76 here), and a
  private output is stamped at arrival until discovery injects a PCR on it
  (about 0.23 s of this capture, whose PMT comes before its PAT). Noted,
  pre-existing: `SplitOutput::last_cc` starts at 0, so a PCR injected into
  an output's first batch shows one CC discontinuity.

### The HLS fan-out puts hls-player on house time (WI-P2-5, OQ-18)

- **Where.** hls-pipe passes the origin's PTS through, so an identity stamp
  alone would put origin time on the bus. The plan placed the fix in
  hls-player's TS writer, which would be a second TS-timing writer, in
  TypeScript and in another repository (bccsa/hls-pipe; §11.5, §13.1). The
  orchestrator moved it into the sidecar: `mrfanout::HouseRebase` in
  `mr-bus-fanout`, plugin-owned, no GStreamer, on the mrts walker, PSI, PES
  and PCR primitives. `packages/hls-pipe` is unchanged. `unixfd-fanout.py` is
  deleted (C-4), and `resolveFanout()` resolves the native binary only.
- **The rule.** PSI and stuffing pass untouched and feed discovery. The first
  timing PES (a video or audio stream_id, or the PCR PID's) sets the shift
  so it lands at house now, `ns_to_pts90k(now) + 1 h − PTS`: house time at
  playout start with a media offset of 0. Every later PES PTS/DTS is moved by
  its PID's mapping, unwrapped by an `Unwrapper` per PID (a DTS more than 5 s
  from its PTS is written at the PTS), split headers held by `PesHeaderSpan`;
  every PCR moves with its own PID's mapping. Each output buffer is then
  stamped by `IdentityStamp` and broadcast with flags 0, since the raw-TS
  ingest carries none. Before the anchor only what carries no time passes
  (the rest is counted `dropped`), and garbage is skipped, no longer
  forwarded. The stats line carries `"rebase": {shiftMs, reanchors, kept,
  dropped, desyncBytes}` in place of `timeline`.
- **The re-anchor.** Only the reference PID re-anchors: the timing PID of
  highest rank (the PCR PID, then video, then audio); a reference with no
  timing PES for 2 s gives way. A jump is a decode key more than 1 s
  (`JUMP_90K`) from the PID's last key plus one spacing, the spacing being
  the upper median of its last three steps of at most 1 s (B-21's rule). The
  jumped PES lands at `max(last on the bus + one spacing, house now − (PTS −
  key))` (D3): continuous while content runs ahead of house time (the paced
  sink's 2 s prefill), at house now after a pause, never back. The PCR PID's
  first PCR written on a new mapping carries `discontinuity_indicator`; no
  DISCONT is set (B-20).
- **A PID that did not jump keeps its place** (D5, revised in the fix round).
  At a re-anchor every other timing PID absorbs the change in its own delta.
  At its next timing PES, one that still continues its own timeline is
  `kept`; one that jumped too takes the mapping of the reference that
  re-anchored, so an offset kept across a discontinuity ends at a runner
  respawn; and a PID never re-anchors the program at the PES where it joins.
  Why: hls-pipe's inline audio continues across EXT-X-DISCONTINUITY while its
  video jumps, and hls-player always muxes inline AV, so one shift for all
  would put that audio minutes off at every origin encoder restart.
- **Known edges, the owner's call.** The PES of a non-reference PID's new
  timeline that come before the reference's first leave on the old mapping
  (a frame or two at a runner respawn under 2 s); a stall without a source
  jump does not re-anchor, so the output stays late by it; quick restarts
  can add up to the prefill as early lead; a step under 1 s stays a gap or
  an overlap; an interleaved splice judges the audio kept. Upstream,
  hls-pipe resets its inline-audio anchor only in `seek()`, not at
  EXT-X-DISCONTINUITY, which also bunches up to a segment of audio at a
  discontinuity: worth an hls-pipe issue (B-55).

### The aligner model (WI-P2-1, WI-P2-6; plan part 4.3)

- **WI-P2-1's outcome: the non-live model holds** (R-P2-1). With every input
  answering LATENCY `live=FALSE, min 0, max NONE`, `audiomixer`,
  `audiointerleave` and `mpegtsmux` at `latency=0` wait for an input 3 s
  late and lose nothing: non-live, `gst_aggregator_wait_and_check` waits with
  no clock (gstaggregator.c:918–945). `start-time-selection=first` starts at
  the first buffer on 600 h timestamps, and when every input is EOS the
  aggregator sends EOS with no free-run. The live fallback (latency 5 s) is
  not built. The test (`gst_aligner_behaviour_test.py`, 105 checks) also
  passed against a build of gst-plugins-base 1.28.2's own `audiomixer`.
  Four findings shaped the element: a GAP is consumed at its start, and only
  a zero-length GAP at its end carries an aggregator through it (F2); the
  audio aggregators drop or clip stale data only after DISCONT, a segment or
  a jump past discont-wait (1 s), and otherwise place it by sample count
  (F3); one input answering live turns the aggregator live (F4);
  `mpegtsmux` writes only while every pad holds an item (F5). It writes a
  late cue at its own PTS (F6). `mpegtsmux` has no `force-live` property:
  it is non-live because its inputs answer so.
- **`mralignwatch`** (in `libgstmrtshouse.so`; its core `mrts::ArrivalRhythm`,
  `PaceGroup`, `PaceRegistry` and `GapPlanner` in `align_watch.{h,cpp}`) is a
  plain `GstElement` that takes the place of an aggregator input's queue: a
  FIFO released by its own task, with LATENCY answered non-live on its src
  pad and not forwarded. Properties: `aligner` (the pace group, keyed with
  the topmost bin), `input` (the label), `sparse`, `hold-on-eos`,
  `seed-lateness`, `silence-factor`, `silence-floor`, `silence-ceiling`,
  `max-size-time`, `max-size-bytes`, `tick`; read-only `state` (`waiting`,
  `present`, `absent`), `lateness`, `pace`, `silence-limit`, `absences`,
  `stale-buffers`, `stale-time`, `gaps`, `level-time`, `level-bytes`,
  `full-count`, and the plugin's `abi` and counters. The `mralignwatch`
  message carries those with `aligner`, `input` and a `reason` (`state`,
  `interval`, `full`, `late-cue`), at every state change and every second;
  both runners forward it unsubscribed, as they do `mrlateness` and
  `mrtsdemux`.

| Constant | Value |
|---|---|
| W, the silence limit | clamp(3.0 × p95 of the last 200 gaps between arrivals, 100 ms, 2 s), p95 by nearest rank; 2 s until 10 arrivals |
| A member's lateness | The median over wall time of its last second: each stretch between two arrivals at the lateness halfway through it, a stretch over which the lateness fell left out; kept data only |
| What counts toward the pace | That lateness, once its stretches span 0.5 s, a third of the window counts and it is not falling (the newer half's median at most 2 ms under the window's) |
| The pace | max(0, its last value, every counted lateness, every seed); on a member's leave, max(0, the remaining members' seeds and last counted lateness); samples clamped to ±1 h |
| Release | An item at its decode time (DTS, else PTS) + the pace; untimed items and events at once |
| Tick | 20 ms |
| Report | Every state change, and every second of running time |
| Queue | `max-size-time` 5 s, `max-size-bytes` 0 (none; 40 MB on the muxer's routes), at most 32,768 items; full blocks upstream and counts once per episode, until drained to half of every limit |

- **Choices, for the owner's veto:**
  1. *Decode time, not PTS.* On the PTS a B-frame after its P-frame would end
     before the horizon and be discarded, so lateness, release, horizon and
     the stale test read DTS, else PTS; for B-frame video an aligner's
     lateness reads higher than `mrlateness` by the reorder delay. An
     upstream GAP is metered at its end, when a demux announces it.
  2. *No start hold.* A non-live aggregator takes the earliest first buffer
     of all its pads until each has one, so a late start-time input's
     earlier content is kept.
  3. *DISCONT* on the first data out after a discard, a gap or a rejoin, so
     the audio aggregators place it by PTS (F3).
  4. *Gap shapes.* Toward an audio aggregator (a `GstAudioAggregator` found
     downstream through ghost pads once linked) an absent, held-EOS or
     joining input is gapped one input buffer length at a time, each piece
     pushed at its start + pace, as its data would have come, with no fence.
     A gap forwarded from upstream goes in pieces of at most the
     aggregator's output block, or, past 1 s, as one GAP and a fence. Toward
     `mpegtsmux`, and for a sparse input, each tick's GAP reaches now − pace
     and is followed by a zero-length GAP (F2's fence). The first shape had
     the mix 21 ms later while an input was absent; the pieces hold it
     within 0.1 ms (B-59). The cost: an input that rejoins or joins can lose
     one buffer more.
  5. *Silence* counts only while the task is not in a push and the sink
     thread is not held in the element (a full queue, a serialized query):
     held upstream is not silent.
  6. *An input that never delivers* is absent at the 2 s ceiling. Before its
     first gap the element pushes STREAM_START, caps when they can be known
     and a TIME segment. The caps are upstream's when its caps query is
     fixed, whatever the media; raw audio otherwise fixated, and above two
     channels given `channel-mask` 0 unless upstream fixes a mask
     (audioaggregator refuses a wide pad without one; a dark 8-channel input
     killed the mixer before the fix round); anything else none. The first
     upstream CAPS equal to the primed ones is not sent again (mpegtsmux
     would resend its PAT and PMT).
  7. *EOS* is forwarded, or with `hold-on-eos` makes the input absent once it
     reaches the head; data after a held EOS is a rejoin.
  8. *The pace estimator* is the table's wall-time median (B-57). WI-P2-6's
     first build took the mean of a second's arrivals, and an upstream
     aligner's start backlog then latched every pace downstream at
     802–866 ms. Now a backlog, its drain and a stall shorter than W weigh
     nothing, and a lasting slowdown is taken in about half a second.
  9. *A pace floor of 0*: an early input is not released before its running
     time.
  10. *A member that joins a running group* (a group runs once any member
      has pushed something timed; a live add, a relink, a channel-map
      replace) is gapped at the pace from its first tick while it waits, and
      goes absent at W as before; what it then delivers before the gaps'
      horizon is stale. Start-time members are waited for up to W. A fresh
      joiner used to stop a running mixer for the 2 s ceiling (B-58). A
      joiner later than the pace by Δ loses its first Δ, which a seed saves.
  11. *Not PLAYING*, items leave at once, as from a queue, so a non-live
      upstream can preroll.
- **The pace never falls by itself** (R-P2-5, §6 item 4). It rises when an
  input slows or a slower one joins, and comes down only when a member
  leaves (its pad released). So after a transient the module's added latency
  stays until the slow input is removed or the module restarts; "Pace" and
  "Waiting for" show it (below). An automatic fall-back after a steady
  spell is with the owner (B-76) and not built.
- **A rejoin.** When data returns after an absence, buffers ending before
  the emitted horizon are discarded and counted (`stale-buffers`,
  `stale-time`): the only discard after ingest (R21).
- **B-17, a live add.** A `bus_input_add` whose branch fails to parse and
  names an element of a plugin the loader could not use is answered with a
  `command_error` carrying the rule-6 alarm (`kind: timing_plugin`, the
  load detail). Nothing is stood in. The engine answers a failed add with a
  module restart. A 302M fan-in's start description names `mrtsdemux`,
  which has no stand-in, so that restart is refused with the same alarm;
  elsewhere `mralignwatch` would get the `identity` stand-in both loader
  tables carry.
- **Found, open.** A pace rise loses content downstream (B-74): the mixer's
  output stops once for the rise, and an aligner downstream whose W is
  shorter reads that as silence and discards as much at its return; a
  slewed rise is the recommended follow-up. The aligners' CPU (B-75): about
  5.5 ms of CPU per second per element on the Pi 5, against 2 for a queue, so
  n1-mixer-302m's N × (N − 1) matrix aligners cost 0.17 cores at 4 pairs and
  2.2–2.6 at 16; V9 decides. A module PLAYING more than W before its inputs'
  first data starts its aggregator on a gap's grid (B-73). A pace raised by
  a late sparse cue is lost when a member leaves, since the recompute reads
  seeds and counted lateness only, and the next late cue raises it again. A
  live remove of an input whose task is blocked in a push waits until the
  aggregator advances: up to W when another input is silent but not yet
  absent.

### 302M fan-ins on content time (WI-P2-7, -8, -9, -11; OQ-20)

- **`mrtsdemux` in select mode** (in `libgstmrtshouse.so`; its core
  `mrts::SelectDemux` in `ts_select.{h,cpp}`) is the formula demux for one
  stream. `select` is a caps string, `audio/x-smpte-302m` the one mode it
  knows (stream type 0x06 whose first registration descriptor is `BSSD`),
  and `program-number` −1 means the first; both apply at start. One ALWAYS
  src pad gets the caps and one TIME segment {start 0, base 0} when the PMT
  shows the stream. Per PES on the selected PID, `Unwrapper::feed(pts,
  ns_to_pts90k(clock − base_time) + MUX_CLOCK_BASE_90K)`, the seed never
  folded to 33 bits (B-14), and PTS = DTS = `pts90k_to_ns(u −
  MUX_CLOCK_BASE_90K)`: running time is `PES − 1 h`. The bus stamps are not
  read. Read-only `pid`, `pes`, `gaps`, `markers`, `markers-dropped`, and the
  plugin's counters; each output buffer carries its AES3 duration. On the
  runners' contract clock at 662.8 h of house time (the PES field wrapped 25
  times) every output landed on its capture PTS less the 90 kHz quantum.
- **Gaps.** Each OQ-12 marker packet on the selected PID becomes a GAP event
  `[end − length, end)`, `end` being the marker buffer's PTS through
  upstream's segment, trimmed to the pad's horizon (the end of the last PES
  or GAP it emitted) and dropped when nothing remains. So B-21's two false
  markers after a cadence rise vanish, and an outage's 250 ms markers tile
  instead of overlapping. A PES that starts more than two frames after the
  horizon is a `jump` gap, a frame being the upper median of the last eight
  clean PES spacings of at most 1 s; a PES's end comes from its AES3 header,
  so a quantum change is no jump. DISCONT follows a gap, a CC loss (which
  drops the PES it cut) and a bus DISCONT (which drops the open PES).
  Markers on other PIDs, the PCR PID's included, are ignored: every marker
  producer marks each ES PID itself.
- **No stream within 2 s** of an episode's first PMT: one `mrtsdemux` message
  with `reason=no-stream` (`stream=missing`), and the pad stays silent, so
  the input's aligner reports it absent and wrong content fails soft. The
  1 s report is the same structure with `reason=interval` and the counters.
  The plan named it `mrtsdemux-no-stream`; both runners forward only the
  name `mrtsdemux`.
- **No stand-in.** A module whose pipeline names `mrtsdemux` is refused
  without the plugin, with the rule-6 alarm. Every 302M fan-in names it, so
  audio-mixer, n1-mixer-302m, audio-processing and audio-output-302m do not
  start without `libgstmrtshouse.so`.
- **The helper** (`audio-302m-core`). Every branch is `<busSrc> ! mrtsdemux
  name=<m>_demux… select=audio/x-smpte-302m ! avdec_s302m ! audioconvert[
  mix-matrix] ! audioresample`. The mixer and live arms end it in
  `! audio/x-raw,rate=48000,channels=N ! mralignwatch name=<m>_aw_<hash>
  aligner=<m> input="<connection id>" hold-on-eos=true[ seed-lateness=<ns>]`
  into `alignedMixer`, `audiomixer name=<m> latency=0
  start-time-selection=first ! capsfilter name=<m>_out`; the single-source
  arm keeps ADR-0008's bypass and its queue (OQ-21). `continuationName` is
  `<m>_out` in every arm. Removed: `pacedMixer`, `latencyMs`, `ignorePcr`,
  `mixerLatencyNs`, `demuxes`, the 20–2,000 ms clamp and
  `MixInputBranchOpts.branchQueueMs`; new: `AudioMixSource.seedLatenessMs`
  and `MixInputBranchOpts.mixerName`. The branch caps stay `rate,channels`:
  a pad dark at start primes F64LE, so the mix runs in F64 when every input
  is dark at start (CPU only, left to V9). audio-output-302m and
  audio-processing return `eosDrain: false`, because the held EOS made every
  stop wait out the 6 s drain.
- **n1-mixer-302m.** Its output mixers are `alignedMixer`s, and each matrix
  link is `in<i>t. ! mralignwatch name=omix<o>_aw<i> aligner=omix<o>
  input=in<i> silence-floor=500000000 ! omix<o>.`, in place of the 500 ms
  queues and the 20 ms budget. The 500 ms floor covers `inmix<i>`'s own
  holds (a source's W plus a tick, a pace rise); it also turns a
  single-source relink into a 0.5 s stop at every aligned consumer
  downstream, a trade-off for the owner (B-58). `mixLatencyMs` is gone from
  all four modules.
- **Removing a start-time branch.** Both runners found a live branch's src
  pad by the name `src`, which only a live-added bin has; a start-time bin's
  ghost pad is `ghost<N>`, so its request pad stayed on the mixer, and the
  non-live mixer waited on it for ever. Both now take the bin's src pad
  whatever its name (protocol case L2).
- **audio-output-302m** (WI-P2-11) drops `alignBranchesToStamps` (the demux
  gives content time), and `audio302mTsOffsetNs` loses the mixer term:
  `max(0, D + trim − 100 ms)`. Both arms put `identity name=live_upstream
  sync=true` after the continuation: behind the non-live mixer the sink saw
  no live upstream and added no ring latency, so the mixer arm played 90 ms
  early at D = 300 and nothing at D = 60. The identity marks the upstream
  live for the sink; it is not ADR-0008's pacer, since nothing free-runs, and
  it never waits. The mixer arm presents about 10 ms after the single-source
  arm (the mixer's output block, reported as latency), as it did before, so
  V7 is unaffected.

### Audio processing: the aligned interleave and the ducker (WI-P2-10; OQ-22)

- **The join.** Programme and key meet in `audiointerleave name=il latency=0
  start-time-selection=first`, each of the four channels through
  `mralignwatch name=il_aw_<prog0|prog1|key0|key1> aligner=il` behind a fixed
  F32 mono 48 kHz capsfilter, so a watchdog that gaps before `deinterleave`
  has a pad primes the real caps. A channel whose pin has two or more
  sources takes `silence-floor` 500 ms, because an aligned mixer's stops are
  not silence. In ducker mode the limiter sits before the interleave, in
  keyed-gate mode after the gate, as before.
- **`mrducker`** (`plugins/audio-processing/native/mrducker`,
  `libgstmrducker.so`, plugin-owned per ADR-0001) is `DuckerEnvelope` in
  C++, 4 channels in (programme 0/1, key 2/3) and 2 out. It reads the key's
  level per 15 ms window of content time (720 frames at 48 kHz, counted from
  the stream's first frame; the louder key channel's mean square in dB,
  silence −120 dB) and advances the envelope by that window's content time.
  The TS's step clamp and gain epsilon are kept, its 1 ms floor under
  `Date.now()` deltas is dropped. The reading at a window's end sets a
  geometric ramp across the next window, causal and without lookahead, so
  the duck starts 0–15 ms after the key's content time. Threshold, depth,
  attack, release and hold are live properties with the manifest's ranges.
  It posts `mrducker` (`running-time`, `gain-db`, `key-db`, `phase`) at
  10 Hz of content through `busReports`, and `DuckLiveThrottle` publishes at
  most 4 Hz. The TS test cases became vectors held to 0.01 dB (the largest
  difference is 3.3e-7 dB) before `duckerEnvelope.ts` was deleted; the
  `sclevel` branch, `volume name=duckvol` and its PLAYING reseed went with
  it. Measured: a key from 1,003.00 ms ducks the programme from
  1,005.10 ms, the same frame with the key 300 ms late.
- **`mrptskeep`** (the same plugin). The LADSPA `sc-gate-stereo` is 4 in and
  2 out, not in place, and allocates its output without metadata, so the
  keyed gate's output and its egress PES carried no PTS at all since the
  module was built (2026-08-25). `mrptskeep target=dyn`, right after the
  gate, puts each call's input PTS, DTS, duration, offsets and flags (GAP
  cleared) on the buffer the gate made for it; frames in ≠ frames out, a
  record from another thread or no record is an element error. After the
  fix every buffer and PES is timed, and the gate opens at the key's content
  time plus the limiter's 5 ms lookahead in both runs.
- **No stand-in.** The loader row `audio-processing/mrducker/libgstmrducker.so`
  (elements `mrducker` and `mrptskeep`, `MRDUCKER_MIN_ABI` 1) is not
  required. A box without it logs one line, raises no load alarm and
  refuses only a description naming one of its elements, in both runners,
  with "Native plugin not loaded: this module needs it and cannot run until
  the deploy is fixed." (kind `native_plugin`, detail `<tried paths>;
  <element> has no stand-in`). Ducker and keyed-gate modes need it; a ducker
  with nothing on its sidechain builds neither element. The two loader
  tables are pinned equal row for row.
- **OQ-22.** The chain's reported LSP latency (AGC, EQ, dynamics, and the
  limiter's lookahead: 5 ms by default, up to 20) is the timing section's
  "Processing latency" row, read with the meters each second; nothing is
  corrected. In ducker mode the programme is that much later than the key
  inside the interleave, so the duck lands that much early on it (inside
  ±15 ms at the defaults). The keyed gate's limiter comes after the gate.
- **EOS is absence** for the interleave: a single programme source that ends
  no longer ends the module, which runs on with a silent programme while
  the key flows and ends when every input has.

### The muxer as an aligner (WI-P2-12; C-2, C-3)

- **The mux** is `mpegtsmux name=mux latency=0` with `prog-map` as before; no
  `min-upstream-latency`, and no `force-live` (1.28.2 has none). Each route's
  branch is `[parser !] mralignwatch name=aw_<tag> aligner=mux input=<tag>
  max-size-bytes=40000000[ sparse=true][ seed-lateness=<ns>] [! taginject
  …]`, where `<tag>` is the route's `taginject` tag (`demux_<i>_<class>`, or
  the slot PID on a legacy port). The klv and subtitle routes are sparse. No
  route holds EOS, so an input's EOS reaches the mux. The per-pad queues,
  `MUX_INPUT_QUEUE_MS`, `queueLeaky` and `queueDepthMs` are gone (C-2;
  stored values ignored).
- **Sparse PTS kept.** Both hook twins lost the sparse restamp and its GAP
  keepalive (`_sparse_position`, `_arm_sparse_pad`, `SPARSE_GAP_*`); a cue
  route's aligner fills between cues. The cue pads are retimed under a new
  flag, `AlignBranchesToStampsConfig.privatePads`, a `transformProducer`
  modifier that only the muxer sets and both retime twins honour: admitting
  `private_` and `subpicture_` everywhere, as part 4.6 put it, would have
  retimed the transcoders' subtitle pads as well. Under identity K is −1 h,
  so a cue leaves the demux at `PES − 1 h` and mpegtsmux writes it at its
  own PES PTS.
- **The stall watch is gone** end to end (`inputStallWatch`,
  `INPUT_STALL_TIMEOUT_MS`, the native runner's `stall` namespace,
  `gst_input_stall_watch.py`, `busStallWatch`). A dark input is gapped by its
  aligners and rejoins, and the module no longer restarts. The bus source's
  own `watchdog` (`bus_stall`, video-player) stays.
- **Two retime rules** (both twins, fix rounds 1 and 2). A PES that is not
  `timing_pes` and arrives more than 5 s after its PID's last is a pause, not
  a cut: it rejoins the newest epoch, starting from its own, that has a
  timing PID within 5 s, at that epoch's K. With none near and no coherent
  later epoch, it opens a fresh epoch on the old epoch's K, not on its
  cadence. Before, a cue PID quiet for over 5 s carried a growing error
  (−8 s, then −16 s) and the sparse aligner raised the mux pace for good
  (240 → 7,490 ms), and a dark input that came back with a cue alone raised
  it to 6,530 ms. The rules reach every `transformProducer` retime, AC-3 and
  Opus on 0xBD included. The hook's prog-map and PCR edits now run under the
  hook lock: the race aborted up to 18 of 100 eight-input starts natively.
- **B-17 for the muxer.** Its aligners sit in hook-built branches, which the
  rule-6 rewrite of the start description does not reach, so without
  `libgstmrtshouse.so` every route fails to parse and the muxer fails to
  start (and `restartOnError` loops), with the alarm already shown, instead
  of starting with a warning. The orchestrator accepted it: release images
  carry the plugin, and the 302M mixers cannot run without it anyway.
- **Found.** One 90 kHz tick is lost through any tsdemux → mpegtsmux hop
  (both conversions floor, so a PTS with t mod 9 ≠ 0 comes out t − 1), and
  tsdemux's own time for a cue is its PCR estimate, ±20 ms, which
  `privatePads` replaces with the cue's PES. The bus ingress `queue
  leaky=2 max-size-time=5 s` dropped the first buffer back after a silence
  of more than 5 s when a second buffer arrived before the queue's thread
  took it, about half the time (B-68): a stock queue measures its level
  from the last buffer out even once drained. The owner's decision
  (2026-10-22) fixes it in GStreamer, not in the app: meta-custom's
  gstreamer1.0 patch 0001 starts a drained queue's time level afresh, the
  bus queues stay stock `queue` with their bounds, and protocol case M4
  sends its dark input's split back to back. Open: mpegtsmux reads
  `prog-map` under its own lock when it creates a pad's stream, so a hook
  edit after data reached the mux can still race (R1; listing every spill
  PID up front would close it).

### The sparse rule (C-3)

A sparse input (`sparse=true`) is never declared absent. It drops upstream
GAP events (tsdemux's are not on content time), and between cues it is
gapped to now − pace on every tick, with the fence (F5: a pad without an
item would stall the mux). A cue that ends before the emitted horizon raises
the group's pace to its lateness and is forwarded at its own PTS, so
`mpegtsmux` writes it late (F6), with a `late-cue` message (`cue-start`,
`cue-lateness`, `cue-behind`); the engine logs "Input <label>: cue after its
time, forwarded late, pace raised by <ms> ms". Nothing after ingest is
discarded for being late (P11). Producer-side gap signalling for sparse
producers (§11.5 item 10) waits for Phase 3's demux, because `tsdemux` would
not forward it. Measured (`scn-mux-klv`): every KLV and teletext cue at its
input PES PTS (0 ticks), two equal cues in FIFO order, no stall between cues
and no pace rise after a 7 s pause.

### The engine: start seeds and the aligner display (WI-P2-13)

- **Seeds.** `PluginModule.getTimingSummary?()` (implemented by
  `GstPluginBase`, delegated by `ModuleInstance`) is a module's last
  published timing. `MediaRouter.getModuleBusSources` adds `seedLatenessMs`
  while the producer runs: the mean of its own output when it lists one per
  bus port, else its merged output mean. The 302M helper and the muxer render
  it as `seed-lateness`. A seed is a floor of the pace for the member's life,
  so a consumer built during a producer's transient keeps it (B-71).
- **Rows.** The engine consumes `mralignwatch:<element>` before
  `onPluginEvent`, as it does `mrlateness`. Per input (`timing-in-<n>`):
  State (waiting, present or absent), Silence limit (ms), Absences and
  Discarded on rejoin (ms; the watch's `stale-time`, which also counts a late
  joiner's trim); a dark input keeps its row without a lateness. In
  `timing`: Pace (ms), the largest added latency of any aligner over its
  fastest present member, and Waiting for, every absent input or else the
  slowest present member of the aligner that adds the most. When Waiting for
  is shown, Phase 0's Slowest input is not. A watch whose `input` is a bus
  connection id joins that edge's tap row; `GstPluginBase.alignerInputOf()`
  is the hook for any other label.
- **Warnings** (`OwnedWarning`, taken only over `ok` or their own text,
  ADR-0010 rule 2): `input-absent`, "Input <label> silent for <W> ms —
  continuing without it", one text for every absent input, cleared when all
  are back; and `aligner-full`, "Input <label> queue full — upstream held",
  until the queue has drained to half of where the episode began. Both are
  re-asserted at PLAYING and after a description refresh. Lateness itself
  stays display only (OQ-8): these warn of an absent input and a full
  queue, never of lateness. Log events: "Input <label> back after <ms> ms
  absent[; <ms> ms discarded as stale]" (only absent → present: a late
  joiner's trim, a flush or a runner respawn is no rejoin) and the late cue
  above.
- **Not built yet.** The muxer's route watches, n1's matrix links and
  audio-processing's interleave carry internal labels, so they show as rows
  of their own, and one dark muxer input is named once per route (`Input
  demux_1_video silent …`); an `alignerInputOf` of about 8 lines per module
  is the follow-up (B-70). Part 10's "No matching stream" warning and the
  demux counters: both runners forward `mrtsdemux:<name>`, and no engine
  code reads it yet.

### Conformance (WI-P2-14)

- **Synthetic streams.** None of part 7.4's field captures exist yet, so
  every scenario runs on streams the harness builds: 302M through
  `avenc_s302m ! mpegtsmux alignment=7` with each input's content keyed to
  its absolute sample index, so it is found in a mix to the sample, on the
  10 ms grid where ticks, ns and samples convert exactly; KLV and teletext
  from `cue_egress`; GStreamer-made H.264, AAC and Opus; the OCC trim. The
  runner commands are the real modules' builder output, kept as a vitest
  file snapshot (`plugins/mpegts-core/tests/fixtures/aligner/pipelines.json`),
  so a builder change fails vitest until the snapshot is rewritten; the
  expectations sit beside it.
- **Eight scenarios in both runners** (`aligner_conformance_test.py`, 157
  checks): `scn-align-absent-rejoin` (absent about 101 ms after its last
  data left its watchdog at W = 100 ms, output lateness while absent
  22.8 → 22.8 ms, 199–200 stale buffers at the return),
  `scn-align-slow-joiner` (one output gap of 500 ± 25 ms, the pace up
  500 ms), `scn-align-late-delivering` (1.5 s late: every block mixed, no
  absence), `scn-align-bursty` (W within 3 % of 3 × p95), `scn-align-wrap`
  (the house clock really crosses 2^33, in a time namespace, `unshare -T`:
  no step), `scn-mux-klv`, `scn-837-ducker-mixer` (the ducker's egress PES
  PTS equal its input's, 2,250 of 2,250; the mix equals the ducker output
  plus the key in every sample) and `scn-split-passthrough`. Lengths are cut
  for CI (16–60 s; the plan's 90 s and 10 min belong to the rigs). The
  module starts 0.7 s before its producers' data, as on a box.
- **Protocol cases in both runners:** L rebuilt on the helper's live branch
  (add, remove, a dead producer's branch, the joiner at `PES − 1 h` from its
  first kept buffer); L2 (a start-time branch removed); P with a third input
  carrying KLV under `privatePads` (67 of 67 cues at 0 ticks; P's flake 0 in
  200 legs, against 3 in 200 at the W0 baseline); `aligner-absent`;
  `native-plugins` (the four elements of both plugins in one module, their
  messages forwarded).
- **For WI-P2-16:** the capture list of part 7.4, now recorded on .103,
  .111, .22 or .50 (.108 is in production); a PES PTS maps to the sample
  `ceil(ticks × 48000 / 90000)`.

### As-built deviations, by work item

Each item recorded these against its brief for the owner's veto; the
sections above give the reasons, the register rows the work item.

- **WI-P2-0**: setup only; git 2.39 gave the linked worktree its own module
  store, so hls-pipe was cloned over the network (B-49).
- **WI-P2-1**: as planned; the plan text its findings correct is listed in
  B-50 (no `force-live` on `mpegtsmux`; the GAP fence; DISCONT before a
  clip).
- **WI-P2-2a**: `first()` takes the stream, reports the stamp before the
  floor and accepts null out-pointers; no Python twin (B-51).
- **WI-P2-2b**: the acceptance grep scoped (B-51); `busRunnerContract.test.ts`'s
  two `TimelineStamper` guards merged into one; a fourth comment edit
  (`PacedTsSink.test.ts`); README rows beyond the two named; `ts_timeline.h`
  no longer includes `ts_house.h`; the cut test is new direct `timing_pes`
  cases, since no old case called it.
- **WI-P2-3**: the stamper loaded only for a pipeline with a bus egress;
  `started.timingPlugin` null while it is missing; `alarm()` public in both
  loaders; `MR_LATCH_REPAIR` gone with `latchRepair.ts`; "identity unwrap"
  in the operator text; the subtitle engine test's −600 s jump dropped;
  protocol case B2's wire check from the first PCR-carrying buffer (B-52,
  B-53).
- **WI-P2-4**: markers checked per packet, and counted in the output's
  lateness window; two test-server options (`--insert`, `--pace-us`) and a
  `build-host.sh` comment outside the ownership list; the expectation named
  `.expect.jsonl`; the fixture a true head, starting mid-PES with its PMT
  before its PAT (B-54).
- **WI-P2-5**: D1 to D12 (B-55): the rebase in the sidecar; the 1 s jump on
  the reference PID only; the landing `max(continuous, house now)`; the
  reference rank; kept PIDs; the spacing as an upper median of three;
  nothing timed before the anchor; garbage not forwarded; flags 0 and no
  DISCONT; no Python prototype (since the owner's 2026-10-21 decision a
  Python reference with C++ output parity, B-55); the missing-binary error
  text kept; DI on the PCR PID's first PCR on a new mapping.
- **WI-P2-6**: choices 1 to 11 of the aligner section (B-56), among them an
  upstream GAP metered at its end (recorded by its verify); the pace
  estimator it built was replaced in WI-P2-8+11's fix round (B-57);
  `busRunnerContract.test.ts`, the mpegts-core README and a `.gitignore`
  line edited outside its ownership.
- **WI-P2-7**: no PCR-PID fallback for markers; the no-stream warning as
  `reason=no-stream`; the trim baseline and the jump hole measured from the
  pad's horizon; a PES's end from its AES3 header; a data DISCONT resets the
  walker; a PES without PTS, or before 0, leaves untimed; with no clock the
  seed is the PES; five extra read-only properties; the const `feed` a
  constrained template (B-60).
- **WI-P2-8+11**: audio-output-302m's `identity sync=true` (B-62);
  `MixInputBranchOpts.branchQueueMs` removed and `mixerName` added; `<m>_caps`
  gone; no pinned format; comments made true in the call-site modules; in
  its fix round `eosDrain: false` in two modules (B-61) and the pace
  estimator in WI-P2-6's files (B-57).
- **WI-P2-9**: `outName` `omix<o>_out`; no `hold-on-eos` on matrix links;
  the removed setting tested without naming it; in its fix round the
  late-join rule in WI-P2-6's element, the matrix floor and the runners'
  start-time remove fix (B-58).
- **WI-P2-10**: the window, the content-time dt, the causal ramp, the
  10 Hz cadence; no stand-in, refused with a sentence of its own (fix
  round); the interleave's caps and floors; the Processing latency row
  through an engine hook outside the plugin; `duckerStage.ts`; GAP in, gap
  out; the `duckvol` reseed gone; `mrptskeep` and the keyed gate's need for
  the plugin (fix round); EOS as absence (B-63, B-64).
- **WI-P2-12**: `privatePads` instead of a global admission (B-65);
  `taginject` after the aligner; no `hold-on-eos`; the seed passed through;
  `MuxRoute.sparse` gone; `eosDrainContract.test.ts` re-pinned; B-17 for the
  muxer (B-66); in its fix rounds the two retime rules and the hook lock
  (B-67).
- **WI-P2-13**: `ModuleInstance.ts` touched outside the ownership list;
  `ModuleTimingInput.lateness` optional; Waiting for and Pace per aligner;
  the seed per bus port; two log events beyond the brief; the
  `alignerInputOf` hook (B-70).
- **WI-P2-14**: the runner commands a committed vitest snapshot; the module
  started 0.7 s before its data; late-delivering modelled as an input that
  has run late for a while; the absence bound from the data leaving its
  watchdog; a stalled link for the absence scenarios; the wrap in a time
  namespace; `scn-mux-klv` on Python-built video; 837's no-fill check as a
  residual; case L rebuilt in place; case P's KLV as a third input; CI
  lengths (B-72); in its fix round the gap pieces in WI-P2-6's element
  (B-59).

### What this phase supersedes

- **ADR-0005**: decision 2 (the producer latch and its re-anchor) with its
  2026-09-05 latch-repair note, Stage 3b's drift servo, Stage 3f's
  conditioner and the 2026-10-08 house-timeline egress note; decision 4
  (playout offset D), whose mechanism still runs and goes in Phase 4.
  **ADR-0018** whole (the conditioner's program-wide steps). **ADR-0008** in
  part (OQ-21): rule 1 (force-live mixers paced by `identity sync=true`),
  the 2026-09-03 addendum's `mixerLatencyNs`, the 2026-10-02 addendum's
  drain and cost sentences and the 2026-10-05 amendment (`ignore-pcr`, the
  20 ms floor); rule 2 (chain only from `continuationName`) and rule 3 (the
  single-source bypass) stand. Each now points here.
- **Amended**, a few lines each: ADR-0001 (the Python probe and
  `unixfd-fanout.py` are gone), ADR-0002 (`alignedMixer`; exception 2
  without the probe), ADR-0015 (no stall watch: a full aligner blocks and
  warns), ADR-0016 (identity, not the anchored stamper, applies
  `timing_pes`), ADR-0017 (sparse routes: no restamp, no GAP timer), ADR-0019
  (no stall watch, no `preserveSourceTimeline`; neither runner has a Python
  stamping fallback) and ADR-0022 (`mixLatencyMs` left the shared keys).
- **This ADR's earlier sections.** Phase 0's display-only lateness gains the
  aligners' two warnings. Its fixed `timing-in-<n>` numbers hold on aligner
  modules, but a dark aligner input keeps its section (State absent) instead
  of leaving a gap, and an input of its own (the muxer's route watches until
  B-70) is numbered after the module's inputs. S0 choice 1's runtime
  importers of the Python reference are gone except branch alignment and
  retime (Phase 3). S0 choice 6's open live-add case is B-17 above, and the
  muxer does not start without the plugin. In Phase 1, "`mr-tssplit` and
  `mr-bus-fanout` still write `flags = 0`" no longer holds for the splitter,
  which forwards markers; the fan-out's raw-TS ingest has no flags to
  forward. Phase 1's identity egress section names anchored egresses and a
  Python probe, both deleted here.

### Deleted in this phase

`TimelineLatch` and `TimelineStamper` (anchor, latch repair, watch,
staleness net, late/early tiers, drift servo, conditioner) with their event
JSON and `drift_stats_json` (C++; the Python reference stays, OQ-1);
`gst_stamp_probe.py`; mrtsstamp's anchored properties and messages; the
runner drift timer; `latchRepair`, `houseTimelineEgress`,
`preserveSourceTimeline`, `isDeliveryLeadProducer`, `latchRepair.ts`,
`MR_LATCH_REPAIR`, `getUpstreamBusProducers` and
`gst_preserve_timeline_test.py`; `subtitle_stamp_dump.py`; the splitter's
stamper, conditioner and flags, with the parity vitest and `mrts_cli`'s
splitter mode; `unixfd-fanout.py` and `--stamp-timeline`; `pacedMixer`,
`ignorePcr`, `mixerLatencyNs`, `OUTPUT_MIX_LATENCY_NS` and the 500 ms matrix
queues; `duckerEnvelope.ts`, the `sclevel` branch and `duckvol`; the mux's
2.4 s window and pad queues, the sparse restamp and GAP timers in both hook
twins, and the input stall watch end to end; the settings `mixLatencyMs`
(audio-mixer, n1-mixer-302m, audio-processing, audio-output-302m),
`queueLeaky` and `queueDepthMs` (mpegts-muxer) and `preserveSourceTimeline`
(transcoder, audio-transcoder), their stored values ignored (OQ-33).

### Open at the end of the build

- WI-P2-16 on the rigs (V1–V12), the part 7.4 captures and the
  capture-based conformance runs.
- For the owner: R-P2-5's fall-back (B-76), the pace-rise slew (B-74), a
  module started more than W before its data (B-73), the seed latch (B-71),
  the 500 ms matrix floor (B-58), the identity egress findings (B-53), and
  the engineering choices of rows B-50 to B-67, each recorded for the veto.
  The ingress queue's first buffer after a silence (B-68) is the owner's
  decision (2026-10-22): a patch to GStreamer's queue in the image, so the
  fix reaches a box with that image.
- The unixfdsink pool that keeps a stall's high-water mark for the life of
  the edge (B-94): open for Phase 4, in meta-custom's unixfdsink patch.
- Engine follow-ups: the muxer's, n1-mixer-302m's and audio-processing's
  `alignerInputOf`, and part 10's demux rows (B-70); the pace estimator's
  third-share threshold, re-derived from real captures with a Pi 4 among
  them, and an incremental median in place of a sort per arrival (B-57); a
  floor for the gap piece's length, which a short last buffer before an
  absence can bring to 1,000 GAP events a second, and the audio gap shape's
  need for a directly linked aggregator (B-59).
- B-20 is unchanged in code: markers carry GAP | DISCONT, every Phase 2
  reader keys on GAP, and dropping DISCONT is still one line. B-23
  (`mrasrc`'s stand-in) belongs to the Phase 1 close.
- Comments that still name a deleted mechanism wait for a code change:
  `PluginModule.ts` (the `eosDrain` comment blames a force-live aggregator,
  which drained in 0.01–0.03 s on the dev box's 1.28.2; the `hold-on-eos`
  aligners are what never drain), `GstPluginBase.ts` ("House clock and
  stamper policy"), `shared-types/src/moduleTiming.ts` ("display only, no
  alarm"), `queueBounds.ts` ("the mpegts-muxer per-pad queues"),
  `branch_retime.cpp` ("a drop (latch repair)"), `ingest_restamp_fixture.py` and
  `gst_ingest_restamp_test.py` (`ts_timeline.cpp`'s `stamp_house`),
  `ts_pes_test.cpp` ("until WI-S0-6 folds them in"), the `py/ts_timeline.py`
  and `py/ts_split.py` docstrings (a C++ port and a parity suite that are
  gone), `hls-pipe-runner.ts` ("unixfd-fanout sidecar"), and hls-player's
  missing-binary error, which still suggests `pnpm build`.
