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
TS module (S0), Phase 1, Phase 2, Phase 3 and Phase 4 are below; Phase 5
appends to this file when it lands
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
  on the AES50 master test box and TECH01). The later sync steps the clock if it is
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
  proven on the AES50 master test box, 2026-10-14). Nothing in the layer, the Device
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
linuxptp steers the box as before. Slave-only boxes were unchanged until
MR-048b (below): one with no master hands its clock to NTP.

**Why.** Nothing disciplined a grandmaster: GATE01 ran 0.2–0.3 s off
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
  `media-router-ptp-owner.service` (`mr-ptp-owner.py`, started with
  `media-router-ptp4l.service` by its `WantedBy=`; since MR-048, Yocto
  6a26b2aa, `Requisite=` and `StopPropagatedFrom=` it in place of
  `BindsTo=`, so it runs only while ptp4l does, stops and restarts with it
  and never starts it; phc2sys is `Requisite=` ptp4l, which `Wants=`
  phc2sys) stops chronyd (`systemctl stop --no-block`)
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
  grandmaster of its discipline; if ptp4l died, `StopPropagatedFrom=` stops
  the watcher. Engineering choice, open to the owner's veto.
- **A slave-only box without a master runs on NTP** (MR-048b, Yocto
  7347a244 and 608ef45c, 2026-11-05; the owner's: "yes it should siwthc to
  ntc, but when the master comes back, go to ptp again"). The hand-over:
  - **To NTP** after 120 s without a usable PTP lock, counted from PTP's
    start (each ptp4l start that restarts the watcher: at boot, or after a
    Device Manager save that changes a PTP setting; a crash restart the
    watcher outlives restarts the count only when that start changed side,
    MR-048c) or, once a master has been lost, from its last lock.
    `mr-ptp-owner` judges a GET TIME_STATUS_NP every 5 s: a usable lock is a
    port that follows a master (SLAVE, or UNCALIBRATED while ptp4l runs
    free), syncs arriving and an offset that moved at most 1 ms since the
    last reading.
  - **Back to PTP** once a master's lock has held steady for 30 s unbroken
    (five of AES67's 6 s announce timeouts); any break starts the 30 s
    again, so a master that comes and goes hands nothing over.
  - **One ptp4l restart and one journal line per hand-over.** The watcher
    writes or removes the marker `/run/media-router-ptp/ntp-fallback`, logs
    `fallback: no PTP master for 120 s (port LISTENING) - chrony (NTP)
    takes the clock` or `return: port SLAVE, offset steady within 1 ms for
    30 s - PTP takes the clock back from chrony`, and restarts ptp4l, whose
    setup script applies it: on the fallback chronyd gets the token while
    linuxptp writes no system clock; at the return chronyd stops before
    ptp4l starts, and an offset under 1 s is slewed. The marker lives in
    `/run`, so a reboot starts on PTP.
  - **The engine re-epochs only on a step over 1 ms** (below): a fallback
    at boot, on an image-date clock, or a return more than 1 s off gives
    one `step`; a fallback after a lost master, or a return within 1 s,
    gives none. Its time source reads `chrony` on the fallback and `ptp`
    after the return, and its time-sync state says why (`ntpFallback`,
    B-215).
- **`status.env` says what was decided; only the setup writes it.** At
  every ptp4l start the setup script decides what applies (the marker
  counts only on a slave-only box; a master-capable one voids it) and
  writes `/run/media-router-ptp/status.env` (0644): the interface, profile,
  domain, priority, `PTP_SLAVE_ONLY=0|1`, the timestamping and PHC and,
  last, `PTP_NTP_FALLBACK=0|1`. `mr-ptp-owner` re-reads it at every ptp4l start:
  a new watcher starts with ptp4l, and one that outlived a restart follows
  that start's file before its next decision (MR-048c). The engine and the
  Device Manager only read it, never write it: the engine once a source
  poll (below), the Device Manager for its PTP page. It stays in `/run`
  when ptp4l stops (ptp4l's runtime directory is kept), so PTP turned off
  leaves the last start's file behind: the Device Manager's page shows its
  fallback lines only while ptp4l is active, and the engine counts the
  fallback only while ptp4l's unit is not inactive (B-215).
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
  restart) there is no wait and no step. ptp4l's `TimeoutStartSec` is 120 s
  (180 s since MR-048, whose setup first waits up to 60 s for the link).
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
  ivan-test-p4 on 2026-10-14: 1,570 journal lines per 10 min, 600 of them
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
- **Rollout** (the owner, 2026-10-14). GATE01 is imaged after the rig
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
  - pinned by four raw `mr-clockstate` captures from the AES50 master test box, a chrony
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
  disciplines the clock ptp4l serves, during the setup script's boot wait,
  or on a slave-only box's NTP fallback (MR-048b). A revoked chronyd reads
  `deactivating`, so the owner is already `ptp` while it stops. On `chrony`
  the poll also reads `chronyc -c
  tracking`, so a grandmaster shows chrony's reference and error. A step's
  poll can overlap the periodic one; an older answer never overwrites a
  newer one. `TimeSyncSource` (`packages/shared-types/src/timeSync.ts`, no
  type change) therefore means: `chrony`, also on a PTP grandmaster and on a
  slave-only box with no master for 2 minutes, until a master's lock has
  held 30 s (MR-048b); `ptp`, linuxptp steers (slave-only boxes following a
  master, and a master-capable box while it follows a better grandmaster);
  `none`, neither daemon runs (the second of a hand-over's restart). The
  engine re-epochs only when E steps (more than 1 ms), so a fallback at boot
  or a return more than 1 s off gives one `step`, a change of source alone
  none. Each (re-)latch names the source known when its sample arrives.
  `mr-clockstate` writes the post-step sample right after the step line,
  before that line's poll answers, so the re-latch of a handover's step can
  still name the previous owner; `/system/timeSync.source` follows within
  the poll's round trip. Each poll also reads `status.env` once
  (`ptpStatus.ts` `readPtpStatusEnv`), the read that gives pmc its domain:
  `TimeSyncState.ntpFallback` is true while it says `PTP_SLAVE_ONLY=1` and
  `PTP_NTP_FALLBACK=1` and ptp4l's unit is not `inactive` (PTP turned off
  leaves the file behind; a restart's `activating` or `deactivating`, and a
  `failed` ptp4l, which leaves the box on internet time, keep the flag),
  false on any other PTP box, and absent on a box without the file (B-215,
  2026-11-06). A missing key reads 0, the setup's default, so a setup older
  than the fallback reads as no fallback. No new poll and no privilege: the
  file is 0644 in `/run`.
- **Where it shows.** `SystemStats.timeSync` (`packages/shared-types/src/timeSync.ts`:
  source, synced, traceable, TAI−UTC, errors, frequency, wait, epoch seq,
  reason and ISO time, E as a string) goes to `/system/timeSync` in the
  router tree and to the manager, and `features` gains `house-clock` so a
  manager tells new engines from old; the engine card and header show a
  clock indicator (green traceable, amber waiting or synced-but-TAI-unset,
  red unsynced) with the detail (source, error, TAI−UTC, chrony reference,
  epoch number, reason and time) in its tooltip
  (`packages/manager-ui/src/utils/engineClock.ts`). For an engine whose
  `ntpFallback` is set the tooltip says "No PTP master: on internet time
  (NTP)", the Device Manager's words, in place of its source; every other
  engine shows its source (B-215). The error is chrony's
  estimate; under PTP it is ptp4l's own offset from its master (`pmc` over
  ptp4l's read-only socket, `packages/engine/src/clock/ptpStatus.ts`,
  `TimeSyncState.ptp`), else none; elsewhere the kernel's esterror, never
  its unset 16 s, which linuxptp leaves as it is (B-198, 2026-11-02). On the
  sidebar card the tooltip is a teleported `MrHelpTip`, because the sidebar
  scrolls (ADR-0022): hover or focus opens it, a click pins it without
  following the row's link.
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
    ZA-SCC-FRA-Master01, not a gate box (`packages/engine/src/audio/fixtures/`); the
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
  chronyd runs only while it owns the clock: as grandmaster or during the
  setup script's boot wait, the card then reading "chrony (NTP), served
  over PTP", or on a slave-only box's NTP fallback, MR-048b), synced,
  estimated and maximum error, frequency, leap state,
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
  by raw captures from the AES50 master test box (`api/src/config/fixtures/PROVENANCE.md`).
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
  GATE01 announces today. It informs only (the owner: the election stays
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
- `mr-ptp-settai.py` with the engine up: no `step` line, then the hold and
  `re-epoch … ΔE=37000.000 ms` above (R-P0-5). The policy holds only an
  untraceable engine on an unsynced kernel, so the hold needs such a start: a
  boot-time run on a chrony box (.50, say) or an engine started before sync.
  On a PTP slave ptp4l keeps the kernel synced, and only the `reason=sync`
  re-epoch shows (DEV1 on .108, 2026-10-22: TAI 37 → 0 → 37, `re-epoch
  reason=sync ΔE=37000.000 ms` at the next sample, no hold; the orchestrator's
  re-specification, for the owner's veto).
- The PipeWire latency row of one audio-input or audio-output against
  `pw-top` QUANT/RATE on .103 or .108; so far checked on ZA-SCC-FRA-Master01 only.
- The grandmaster on chrony, on a rig isolated on PTP domain 10 (plan
  WI-P0-2b, T0–T12), before GATE01 is imaged. Its evidence so far is a
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
  the AES50 master test box, ivan-test-p4 and TECH01 listed each lease's
  servers (the same one for the first two, another for TECH01) from the
  dispatcher's `/run/chrony-dhcp/*.sources` fragments, and
  `chronyc sources` on .50 lists the DHCP-offered server.
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
   keep running (the owner's rule, OQ-1). The frozen paths that imported it
   at runtime (the anchored stamper's Python probe,
   `unixfd-fanout.py --stamp-timeline`, branch alignment and retime) stopped
   in Phases 2 and 3, with the mechanisms they served (plan chapter 3 part
   6.2): since Phase 3 no runtime path imports the Python timing reference;
   the Python runner's `tsProbe` imports `ts_psi`, `ts_video_info` and
   `sps_parse`, which time nothing.
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

**On the Pi 4 (ivan-test-p4, 2026-10-16) every fixture is inside the
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
thread where the ASRC runs (WI-P1-8's budget). That thread now runs SCHED_RR
19, just below PipeWire's data loops (B-111), so on a busy box this share is
taken ahead of every ordinary thread. `tools/runner-cpu-profile.sh`
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
  the mapping survives `lost`. On a scattered delivery the first fit waits
  (plan chapter 15.4 B-100, 2026-10-23): a level that holds under half of the
  buckets closed since it opened (`kScatteredDen` 2: a bursty relay, whose
  1 s minima scatter 90–115 ms) makes its first fit only once the window is
  full, 300 s of house time since the epoch's first sample, on the window's
  densest `step_ns` band, and once a rate is known its fits on no more
  points than the rate in force only pull the rate. On TECH01's relay every
  fresh start of an hour now locks at 306–308 s (89 of 89; four of them waited
  to 334–578 s on a freeze degrade while acquiring until B-101), within 50 ppm
  of the hour's floor trend and with no rate warning after the lock; before,
  56 of 89 locked within 900 s (median 186 s) and 33 never did.
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
  level some `step_hold_ns` run of the last `step_fall_hold_ns` (300 s by
  default, the fit window, kept in the lock's own history of closed
  buckets; the ingest's Smoothing Cooldown, below) stayed
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
- **The hold is each network ingest's Smoothing Cooldown** (the owner,
  2026-10-23; plan chapter 15.4 B-95). `smoothingCooldownMin` on srt-input,
  rist-input and mpegts-ip-input, minutes, 0–60, default 5 (the 300 s),
  live; 0 turns smoothing off: the backlog rule on every line, as before
  B-95. Its help says what the owner asked it to: it adds latency only when
  the stream is bursty. The element's `smoothing-cooldown-ns` takes it into
  every program's PCR, reference and clamp locks from their next close; a
  shorter hold acts on the history the lock keeps, a longer one waits for
  its own span (the run that held the line stays in the history and holds
  it until that run is the new hold old), a hold back from 0 starts afresh.
  Its length counts where the floor lies more than `backlog_ns` under the
  held line for longer than it: on TECH01 every value tried from 1 to
  60 min gives the default's output byte for byte (30 s one move more, where
  its usual delay sagged for a while), and 0 brings the pairs back (byte for
  byte the core before B-95); on +700 ms bursts every 170 s a cooldown under
  170 s cycles again (6 relocks in 1100 s), 180 s and over holds (1 relock).
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
  consecutive pairs 30 ms apart in which the PCR did not advance, B-101:
  `Δσ < Δh / 2` read a bursty relay's stalls as a frozen clock); leap
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
  (`syn-pcr-dense-to-sparse` drops ~0.6 s per PID), at once: on any row but the leap
  row the switch is one timeline with the frozen PCR epoch, and nothing maps back on it
  (B-96). The output PCR is regenerated by
  the conditioner's rule: the reference PID's last written key, pulled down
  by up to 1 s to a video or audio PID with a PES in the last 500 ms, minus
  250 ms, never back among regenerated values. Return needs 30 s of PCR in
  which no row failed: since B-90 an observation restarts that clock only
  where its row fails (its count or its hold reached), so a bursty delivery's
  single frozen pairs no longer hold a program degraded for good; a new PCR
  epoch then opens with a `recovered` event, one timeline with the reference's
  (B-96), and the windowed counts (late crossings, leaps) start afresh (B-86).
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
  fit window still growing. Re-pinned 2026-10-27 over the tree's 60
  expectation traces and the 36 seeds: 6 of 243 pass; the shipped point
  passes every expectation file and fails C4 only on five sparse-PCR or
  tall-burst traces, which the criterion predates (B-95's row).
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
  not at least one 90 kHz tick after its PID's last emitted key (compared in
  house ns, B-96: nearer, two PES could leave with one written PTS) is
  dropped, its packets removed and the PID's later CC renumbered so the
  output stays continuous; a PCR-carrying packet of a dropped PES stays as
  an adaptation-only packet.
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
  more after the one before, flagged 427 of the 433 PCRs of the vMix
  recording, a source that sends one every 2 s (vMix's VBR mux): a
  consumer's output stepped by 1.7–18 ms at each. The trace recorder writes
  a PES's `di` as the source sent it, read before the restamp may set the
  bit on the same packet (B-84).

### The straddle rule (OQ-11, refined 2026-10-14 and 2026-10-23)

Each epoch keeps its source range `[first PCR − 1 s, last PCR + 4 s]`; a
range idle for 10 s is dropped. A PES in one range uses that epoch; in
neither, the newest. The decided tie-break for a PES in two ranges (the
epoch whose lead is closest to the PID's median lead before the re-lock)
applies to real timeline jumps only. An epoch closed by an envelope step,
by a degraded entry on any row but the leap row (whether the reference lock
was warm or cold at the entry) or by a recovery is no candidate, because
the floor or the estimate moved, not the timeline (B-1, B-96); and a range
that maps the PES within `step_ns` of a newer range holding it gives way to
the newer one (one timeline, such as a same-clock PCR PID change). A leap
entry keeps the tie-break: there the timeline did jump. Why: left to the
tie-break, delay jitter flipped PIDs between such epochs, and a +100 ms
delay ramp over 30 s dropped 1.3 s of audio. With this rule, the one-level
rate fit and the PCR mapped outside the lead row, the replays put all 3,551
PES on the new floor after a +150 ms re-route (none before) and drop none
on a +200 ms queue build-up over 20 s (137 before). At a degraded switch
(B-96) the two mappings differ by the reference lock's lead (about 200 ms
on TECH01), and TECH01's jittery delivery with a 1 s PCR freeze flipped
PIDs at the entry (22 gaps, 31 overlaps before B-95) and at the recovery
(14, 31); one timeline leaves one switch each, the entry's overlap per PID
the mapping difference (the held excess on a line B-95 holds: 258 ms on
TECH01); the gate window fixtures drop 9.6 and 9.4 s instead of 11.4 and
12.4 s, and of 87 replay traces only the 7 with a degraded entry change.
The shifted-line variants (the reference line meeting the frozen mapping)
were rejected: they move the mapping the lead row judges. The design's
§5.2 keeps the general rule. The newest is decided by a PCR (B-185, the
release line, 2026-10-28): for 1 s after an outage or a leap, discontinuity
or external relock, a PES in no range waits with its program's packets for
the program's next PCR, at most 300 ms, and past that bound such a PES the
newest line puts more than 4 s ahead of its arrival is unmapped until that
PCR. The old line had put a new timeline's first PES the jump ahead: its PID
lost the jump's length and the input's bus stamps ran as far ahead as long.

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
  lands more than a 90 kHz tick after the end of what the PID last emitted
  (B-96: the guard's tick leaves no sub-tick marker); and on its first PES on
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
  `applyIngestTimingLiveUpdate`, which sets `offset-ns`, `pid-trims` or
  `smoothing-cooldown-ns` on the element named `restamp` with no restart.
  `IngestTimingReporter` turns the element messages into the card,
  throttled to changes of 1 ms or a state flip; each module binds it to its
  own health, badge and sections
  (the binding is repeated in seven modules, a refactor candidate for the
  base class).
- **The settings are injected, not declared.** A manifest declaring
  `"timing": { "role": "ingest", "pidTrims": true|false, "pcrLock":
  true|false }` gets Ingest Offset (`ingestOffsetMs`, ±10,000 ms, live),
  with `pidTrims` Per-PID Trim (`pidTrimsMs`, ±2,000 ms per PID, live, the
  `pidTrim` widget) and with `pcrLock` Smoothing Cooldown
  (`smoothingCooldownMin`, 0–60 min, default 5, live; B-95, the owner's of
  2026-10-23) from `withIngestTimingSettings`, in both the engine's loader
  and the manager's registry: the three network ingests have all three, the
  four captures O only (they keep PES − 1 h, no clock lock to smooth).
- **The box writes on change only** (Enter, blur or a spinner step), never
  per keystroke, because every live write is a gap or a drop on the stream
  (§5.5); Smoothing Cooldown's box alike, since a value typed on the way (a
  cleared box's 0, the 1 of 10) would reach a held clock line. Each box keeps a draft of its uncommitted text, so a re-render of
  the settings form, which any engine's store patch causes, never resets
  what is being typed. Since B-104 (2026-10-23, the owner's) every settings
  box works so, and an entry out of bounds, empty or not a number is
  refused with its reason, never clamped or read as 0.
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
  The card goes as a module's stop begins, not once its runner has stopped
  (B-117), and an SRT input whose link drops reads No PCR at once (B-118).

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
- A known limit, accepted by the owner (2026-10-23, B-100): on a bursty
  relay the rate the lock reads is the floor's over its window, not the
  source's clock. The floor's 5 min trend wanders by ±100 ppm on the gate's
  delivery, and the densest band of a diffuse scatter reads about zero
  whatever the clock (−12…+31 ppm with the clock at ±50 on TECH01's own
  residual), so a source clock genuinely off is not read there and its
  "Source clock off" alarm stays silent: fast by 100 ppm the line climbs
  about 270 ms an hour and is brought down with about 1 s cut every 100 min,
  slow by 100 ppm it re-steps about every 30 min with nothing cut.
  `syn-offset-masked` pins it, so that an estimator that one day reads the
  clock through such a scatter (it would need the envelope's drift over an
  hour or more) fails it on purpose; #847 removes the cause.
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
  video jumps, and hls-player muxes a master's audio renditions inline (a
  playlist without them passes its segments through whole, B-183), so one
  shift for all would put that audio minutes off at every origin encoder
  restart.
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
  `max-size-time`, `max-size-bytes`, `tick` (the gap step of a sparse input
  and of a gapped one toward `mpegtsmux`), `fall-after` (B-82); read-only
  `state` (`waiting`, `present`, `absent`), `lateness`, `pace`,
  `pace-target` (B-80), `silence-limit`, `absences`, `stale-buffers`,
  `stale-time`, `gaps`, `level-time`, `level-bytes`, `full-count`, `passes`
  (the task's runs, B-79), `fades` (B-83), and the plugin's `abi` and
  counters. The `mralignwatch` message carries those with `aligner`,
  `input` and a `reason` (`state`, `interval`, `full`, `late-cue`,
  `pace-fell` with `fell` and `fall-after`), at every state change and every
  second; both runners forward it unsubscribed, as they do `mrlateness` and
  `mrtsdemux`.

| Constant | Value |
|---|---|
| W, the silence limit | clamp(3.0 × p95 of the last 200 gaps between arrivals, 100 ms, 2 s), p95 by nearest rank; 2 s until 10 arrivals; absent at W itself (B-79) |
| A member's lateness | The median over wall time of its last second: each stretch between two arrivals at the lateness halfway through it, a stretch over which the lateness fell left out; stale arrivals and passed GAPs count at their own lateness (B-81), so that rule alone keeps a draining backlog out |
| What counts toward the pace | That lateness, once its stretches span 0.5 s, a third of the window counts and it is not falling (the newer half's median at most 2 ms under the window's) |
| The target | The members' largest peak over the fall window: each member's seed, every lateness that counted and a late cue's raise, kept in three buckets of `fall-after` / 2 on the group's clock (`fall-after` 180 s, 1 s to 1 h), so a value goes 180–270 s after it came; at least 0; samples clamped to ±1 h (B-82) |
| The pace | Before the group runs, the target. Then a rise a member behind the gaps makes (a joiner, a rejoin, a seed into a running group, a late cue) slews at 0.5 (`RISE_DIV` 2: half a ns a ns, B-80), one a present member makes steps; once the target is 10 ms or more under it (`FALL_MIN`) it falls by at most 1 s a skip (`FALL_MAX`), skips 2 s apart (`FALL_SPACING`); a leave falls the same way at once (B-82) |
| Catching up | A member that joins a group that runs is gapped until its data reaches the gaps' end: within its own length while a rise is under way, else within 50 ms (`CATCH_UP_NS`) (B-80) |
| Release | An item at its decode time (DTS, else PTS) + the pace, within 1 ms (`RELEASE_SLACK`, B-79); untimed items and events at once |
| Tick | 20 ms: a sparse input's gap step, and a gapped one's toward `mpegtsmux`; toward an audio aggregator gaps go in pieces as the data would (B-59, B-79) |
| PCM edges | Toward an audio aggregator: the last 5 ms of sound before a gap, a hole, an EOS or a forwarded GAP fade out, the first data after silence fades in over 5 ms (`FADE` 5 ms, a half-Hann window); a hole is 1 ms or more (`HOLE_MIN`); a tail under 1 ms fades nothing (`TAIL_MIN`) (B-83) |
| Report | Every state change, and every second of running time |
| Queue | `max-size-time` 5 s, `max-size-bytes` 0 (none; 40 MB on the muxer's routes), at most 32,768 items; full blocks upstream and counts once per episode, until drained to half of every limit; the time level counts from the release horizon at the earliest (`aw_level_time`), so a GAP over a hole longer than the bound is no queued time (B-134) |

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
     within 1 ms, the release slack (B-59, B-79). The cost: an input that
     rejoins or joins can lose one buffer more.
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
      replace) is gapped from its first tick while it catches up, and goes
      absent at W as before; what it then delivers before the gaps' horizon
      is stale, and its arrivals there give its lateness, which the pace
      slews to at 0.5, so the others' output slows and never stops (B-80;
      the old step stopped the mix for the rise, B-74). A joiner later than
      the pace by Δ loses its first 2Δ + 0.5 s (a seed saves the half
      second); one within 50 ms of the gaps' end is waited for. One that
      joins between the group's first push and its first count catches up
      against a pace of 0, so it loses its content up to that count and the
      pace it sets (the start window; making it a start-time member instead
      would stall the output for its lateness, so it is not). Start-time
      members are waited for up to W. A fresh joiner used to stop a running
      mixer for the 2 s ceiling (B-58).
  11. *Not PLAYING*, items leave at once, as from a queue, so a non-live
      upstream can preroll.
  12. *PCM edges fade* (B-83, the owner's decision on B-43). Toward an audio
      aggregator with interleaved S16, S32, F32 or F64 caps, the last 5 ms
      of sound before an edge the element makes or forwards (a gap, a hole,
      an EOS, a forwarded GAP) play back time-reversed under a 5 ms
      half-Hann window, and the first data after silence fades in over
      5 ms, carried over short buffers; nothing is delayed, the fade leaving
      when the gap would. A fall or a slew of the pace is no edge (the
      content stays continuous), and `mpegtsmux` and sparse inputs are not
      touched.
  13. *One task run a wake* (B-79). The src task releases every item due
      within 1 ms of its running time + pace (the owner's number) and sleeps
      to the earliest of the head's release, the next gap piece, the W
      deadline while silence counts, the tick only while gapped toward
      `mpegtsmux` or sparse, and the next report; a held input arms the
      release of the buffer that continues it, so its task runs once a
      buffer too. An input goes absent at W, not at the next tick. The pace
      is read lock-free from the group's snapshot.
- **The pace falls by itself** (R-P2-5, B-82, the owner's Q4). Each member
  keeps the peak of what entered its window (its seed, each lateness that
  counted, a late cue's): three buckets of `fall-after` / 2 (180 s by
  default) on the group's clock, so a value goes 180–270 s after it came; the
  target is the members' largest peak. A rise a member behind the gaps makes
  (a joiner, a rejoin, a seed into a running group, a late cue) slews at 0.5,
  one a present input makes steps, its data being waited for already (B-80).
  Once every member has been steady 10 ms or more under the pace for
  fall-after, the pace falls to the target in one skip of at most 1 s, skips
  2 s apart; a leave falls the same way at once. A fall is a burst of
  continuous content: nothing is lost or repeated. An absent input's last
  level holds the pace for fall-after, a seeded member that never delivers
  goes the same way, and a chain of n aligners recovers in about
  n × fall-after. "Pace" and "Waiting for" show it (below).
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
- **Found, resolved since.** A pace rise lost content downstream (B-74): the
  mixer's output stopped once for the rise, and an aligner downstream whose
  W was shorter read that as silence; the rise slews now (B-80). The
  aligners' CPU (B-75: about 5.5 ms of CPU per second per element on the
  Pi 5 against 2 for a queue, n1-mixer-302m's matrix aligners 2.2–2.6 cores
  at 16 pairs): fixed by B-79 and a1b's median (B-57), judged per box by V9.
  A pace raised by a late sparse cue was lost when a member left: the cue's
  raise is a peak in its member's window now, and stays while that member
  does (B-82).
- **Found, open.** A module PLAYING more than W before its inputs' first
  data starts its aggregator on a gap's grid (B-73). A live remove of an
  input whose task is blocked in a push waits until the aggregator
  advances: up to W when another input is silent but not yet absent. A
  present input that slows in one step still holds the aggregator by its
  shortfall (the round's flag F3; the overdue rule, A6, is not built).

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
  mix-matrix] ! audioresample` (since Phase 3 `avdec_s302m ! mrasrc …
  bypass-below-ppm=0.5 out-rate=48000 ! audioconvert[ mix-matrix]`, the
  decode ASRC, below). The mixer and live arms end it in
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
  holds (a source's W, which since B-79 ends at W itself, not a tick later;
  a pace rise, which since B-80 slews); it also turns a
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
- **A launch's catch-up, the seed cap and the playout watch** (B-206, the
  release line, 2026-11-03). What a producer sends at once after an outage
  (the Audio Mixer's stall when its mics came back: 4 to 5 s after a PipeWire
  restart on .108, 118 s after a 120 s stop; the OQ-12 markers over its hole
  as GAPs) reached a freshly launched output as its first data: it filled an
  input's 5 s queue, the held arrivals set the pace, every buffer missed the
  sink and the re-anchor raised the route for good (MR-029). A running mix
  discards it as stale against its watch's horizon; a fresh one has none, and
  a stale GAP started its mixer that far back. Now: (1) the native runner's
  `catchUp` {prefix} probes the sink pad of each named element (live adds
  too) and drops the buffers and GAPs that end before the launch's first
  buffer there, until one does not; content arriving about as fast as it
  plays (at most 1.5× over 1 s) is a stream behind the house clock, not a
  backlog, and passes after that second, to be re-anchored, never dropped.
  The output names its bus ingress taps (`lat_busin…`), so the stale TS goes
  in the thread that reads the socket, never decoded. At the watches, where
  it was built first, the decoder thread freed the burst's unixfd memory at
  full speed beside that reader, and the unixfd deadlock of B-206's Limits
  came in 11 of 13 rig runs of a 120 s stop, against 2 of 8 with no
  catch-up; at the taps, 0 of 5, both channels heard 1.6 to 1.9 s after the
  rebuild. One `catch_up` event per launch, one INFO line (none for a
  single TS buffer, which has no span). (2) A start seed is at most the
  output's ts-offset (`seedsWithin`): up to it the sink plays from its whole
  ring, past it every buffer is late, and a seed read during a producer's
  burst is seconds old; at D 60 the ts-offset is 0, so no seed. (3) The
  shed probe's playout watch (`missWatchMs` 1000): every buffer past the
  budget + the re-anchor tolerance for 1 s is `playout_watch` {playing:
  false, lateMs}, 200 ms in budget {playing: true}, on a change only; "Plays
  nothing: every buffer reaches the sink …" takes it at once (it waited on
  the lateness reporter's window over 5 s), and a relaunch keeps it until
  the runner sees the sink in budget. (4) A raise the output asked for is
  its section once its sink plays on time (`notePlayoutOnTime`): no
  warning, and no later PLAYING posts it again; the route head keeps its
  own. Native only: the python runner ignores `catchUp` and `missWatchMs`
  (it never hosts this output).

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
  it as `seed-lateness`. A seed is a peak in its member's fall window: it
  holds the pace for fall-after unless the member shows more, so a
  consumer built during a producer's transient keeps it 180–270 s, not for
  its life (B-71, B-82).
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
  joiner's trim, a flush or a runner respawn is no rejoin), the late cue
  above, and "Pace fell by <ms> ms: every input steady for <fall-after>"
  at each `pace-fell` (B-82).
- **Row rules** (B-93). An input keeps the number it got when first seen
  in a run, and one wired later takes the next, so no other input changes
  number. A watch whose edge left the router's list keeps its row while
  the edge stands in the module's stored graph (`MediaRouter.hasStoredEdge`,
  ADR-0021's oracle): a producer stopped while wired shows State absent,
  with the warning and in Waiting for; gone from the stored graph, the
  operator removed it and the row goes. An input tap that reported this run
  and went stale under watches that report on makes its row absent too
  (the quiet tap: a dark muxer pin, whose routes end at EOS and stay
  present), warned with the tap's 6000 ms. `alignerInputOf` maps the
  muxer's route watches (`demux_<i>_<class>`, a legacy slot's PID) to their
  pin's row (`lat_busin_<i>`) and makes n1's matrix links and
  audio-processing's interleave internal (B-70). Not built: part 10's
  "No matching stream" warning and the demux counters (both runners
  forward `mrtsdemux:<name>`, no engine code reads it yet: a warning kind,
  a map from each demux to its input and two row fields, B-70).

### Conformance (WI-P2-14)

- **Synthetic streams.** Part 7.4's new captures (the gate's and .108's,
  taken after Phase 1) do not exist yet; S0's `cap-302m-bssd.ts`,
  `cap-klv-sparse.ts` and the OCC trims do since the merge. Every scenario
  runs on streams the harness builds: 302M through
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
  22.8 → 22.8 ms, 199–200 stale buffers at the return; since B-83 its
  edges within 1 LSB of the fade model),
  `scn-align-slow-joiner` (since B-80 no output gap over 60 ms, the joiner
  present from 1.8 s after its add, the pace up 500 ms; it was one gap of
  500 ± 25 ms), `scn-align-late-delivering` (1.5 s late: every block mixed,
  no absence), `scn-align-bursty` (W within 3 % of 3 × p95), `scn-align-wrap`
  (the house clock really crosses 2^33, in a time namespace, `unshare -T`,
  a fresh one for each attempt: no step), `scn-mux-klv`,
  `scn-837-ducker-mixer` (the ducker's egress PES
  PTS equal its input's, 2,250 of 2,250; the mix equals the ducker output
  plus the key in every sample) and `scn-split-passthrough`. Lengths are cut
  for CI (16–60 s; the plan's 90 s and 10 min belong to the rigs). The
  module starts 0.7 s before its producers' data, as on a box.
- **Protocol cases in both runners:** L rebuilt on the helper's live branch
  (add, remove, a dead producer's branch, the joiner at `PES − 1 h` from the
  first table its demux receives); L2 (a start-time branch removed); P with
  a third input carrying KLV under `privatePads` (67 of 67 cues at 0 ticks;
  P's flake 0 in 200 legs, against 3 in 200 at the W0 baseline);
  `aligner-absent`; `native-plugins` (the four elements of both plugins in
  one module, their messages forwarded).
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
  estimator it built was replaced in WI-P2-8+11's fix round (B-57), its
  median kept in order since a1b;
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

- WI-P2-16 on the rigs (V1–V12), the part 7.4 captures taken after
  Phase 1 (S0's exist) and the capture-based conformance runs.
- For the owner: a module started more than W before its data (B-73), the
  500 ms matrix floor (B-58), the identity egress findings (B-53), the
  engineering choices of rows B-50 to B-67 and the aligner round's (B-79 to
  B-83: its flags F2, F3 with A6 not built, F7, and `fall-after` 180 s), each
  recorded for the veto. R-P2-5's fall-back (B-76), the pace-rise slew
  (B-74) and the seed latch (B-71) are decided and built (B-80, B-82).
  The ingress queue's first buffer after a silence (B-68) is the owner's
  decision (2026-10-22): a patch to GStreamer's queue in the image, so the
  fix reaches a box with that image.
- The unixfdsink pool gives a stall's copies back 8–9 s after the consumer
  has caught up (B-94): meta-custom's plugins-bad patch 0009, in the image
  from v2.0.0.103 (Phase 4).
- Engine follow-ups: part 10's demux rows (B-70; the `alignerInputOf` of
  the muxer, n1-mixer-302m and audio-processing are built, B-93); the pace
  estimator's third-share threshold, re-derived from real captures with a
  Pi 4 among them (B-57; its median is incremental since a1b); the audio
  gap shape's need for a directly linked aggregator (B-59; the piece's
  floor, an output block, is built, B-79).
- B-20 is unchanged in code: markers carry GAP | DISCONT, every Phase 2
  reader keys on GAP, and dropping DISCONT is still one line. B-23
  (`mrasrc`'s stand-in) is settled by the Phase 1 close, merged before this
  phase.
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

## Phase 3 (built 2026-10-26 to 2026-11-05; DEV-P3a and the short soak ran, DEV-P3b and V13 pending) — the formula demux on every consumer; branch alignment, retime and K recovery deleted

After Phase 3 every bus consumer reads time from the bytes. Each access unit
leaves its demux, `mrtsdemux`, at `ceil(unwrap(PES PTS) − 1 h)` on a segment
from 0, so its running time is its content's house time, and nothing on the
consumer side learns a mapping or corrects a demux's time (P9, §6 item 2):
the runners' branch alignment and per-AU retime, the subtitle K recovery and
the last runtime copy of `ts_timeline` are deleted. Audio is resampled once
where it first becomes PCM, only when its source runs on another clock, and
every audio output follows its device's clock by resampling instead of skew
slaving (§8; OQ-23, C-6, C-7). The burn-in waits for late cues in a pace
group instead of a fixed hold (OQ-24). The 19 build items (WI-P3-1 to
WI-P3-18, with WI-P3-1 and WI-P3-3 in two halves and WI-P3-9 and WI-P3-15 as
one) were built code only, in seven workflows on the dev Pi 5 with GStreamer
1.28.2 (W4 to W6 in three parallel clones, merged after), then p3-16b's
shared bus demux (2026-11-03) and W9's B-148 and B-149 (2026-11-05), with
the release line's fixes up to v2.0.0.101 and c34 (B-212) carried in. On the
boxes: the capture lane (p3cap, the five bus recordings) and the Phase 2
baselines (p3base) in DEV4a (2026-10-27); DEV-P3a on the Pi 4 test box
(2026-11-03: the ASRC bench, V5 to V7, V11), whose V7 faults B-148 fixed;
and DEV-P3s, the owner's 2 h soak across the bus PTS wrap in place of
DEV-P3c's 24 h one (2026-11-03, both test boxes: V10 to V12). DEV-P3b, V13
and V7 again are still to run (Open at the end, below). The plan's register
(chapter 15.4, rows B-120 to B-149, and B-213 for the phase review's fixes)
holds the same records with their work items; B-120 is the build plan and
its 40 corrections of chapter 7 (S1 to S40).

### The formula demux (WI-P3-1, WI-P3-2; plan part 4.1)

- **`mrts::DemuxCore`**
  (`plugins/mpegts-core/native/mrts/demux_core.{h,cpp}`, no GStreamer)
  demuxes one program on the formula timeline; `mrtsdemux` runs it in both
  modes. Its reference, `py/demux_core.py`, was written first (OQ-1, B-121),
  and the C++ ports it rule for rule, held to it by output parity
  (`demux_core_parity_test.py`: the two suites' check lists equal; `mrts_cli
  demux` and the reference line for line on every fixture at 188, 1,000,
  1,316 and 24,576-byte feeds and from its bus sidecar, in select mode and
  three media sets, and on 120 random programs; B-122). Phase 2's
  `SelectDemux` is folded in: select mode is a `DemuxCore` configuration,
  and `ts_select.{h,cpp}` are gone, their select cases now case 12 of both
  `DemuxCore` suites (S1).
- **The formula, on the ceil (S12).** Each PES PTS is unwrapped by an
  `Unwrapper` per PID, seeded once from `ns_to_pts90k(clock − base_time) +
  MUX_CLOCK_BASE_90K` and never folded to 33 bits (B-14), a DTS nearest its
  own PES's PTS. PTS = `pts90k_to_ns_ceil(u − MUX_CLOCK_BASE_90K)` (new in
  `ts_house`), DTS likewise, and DTS = PTS where the PES has none. A floor
  conversion, tsdemux's and Phase 2's, loses a tick through a demux →
  `mpegtsmux` hop wherever t mod 9 ≠ 0, since `mpegtsmux` floors ns to ticks
  (B-69, F1); on the ceil `ns_to_pts90k(PTS) == u − 1 h` for every unit and
  a re-mux gives every tick back, so select mode's PTS off the 9-tick grid
  moved up by 1 ns. A PES without PTS, or before house time 0, leaves
  untimed. The bus stamps are never read for time; without a clock (a file
  source prerolling in a test) the first PES seeds on itself.
- **House time across an outage (B-149).** With a clock, a bus DISCONT
  re-seeds every pad's `Unwrapper` and the PCR's from house now, however long
  the outage, and a pad whose last placed PES sat within 60 s of house now
  (`NOT_HOUSE_NS`) reads each PES nearest house now, the PCR likewise: for
  continuous input and across the 33-bit wrap that is the previous PES's
  reading, and after a silence of half a wrap (13.25 h) or more, a DISCONT or
  none, the right one. On such a pad a PES more than 60 s off house time
  whose offset from house now moves more than 60 s from the previous PES's,
  or that repeats its PTS, is stale: dropped, nothing learned but the
  unwrap, the next unit DISCONT, the jump rule gapping the hole past its
  bound. One that keeps the previous offset plays at its own reading: the
  next PES of a stream that left house time (its first there dropped), a
  source that paused its PTS, a long recording replayed at one clock
  reading. A pad off house time unwraps nearest its previous PES as before.
  Found by the m6 merge's probe (B-149): an input away more than 13.25 h
  came back a wrap (95,443.718 s) behind house time and stayed there, and
  one stale PES 22.14 h old (MR-033's copy) landed 4.37 h ahead behind a
  4.4 h GAP; 33 bits cannot tell those apart, so house time is the
  reference wherever a stream is on it. The cost, open to the owner's veto
  (B-149): the first PES of a stream on house time that moves more than 60
  s off it is dropped, the next PES deciding; on a video pad that is
  usually the IDR after its producer restarted on another clock, so such a
  restart can lose up to a GOP of decodable video, not one PES.
- **Two modes, one element** (`gstmrtsdemux.cpp`). **Demux mode** is the
  default (no `select`): tsdemux 1.28.2's four SOMETIMES templates (`video`,
  `audio`, `private`, `subpicture`) with their caps sets, a pad per stream
  of `media`. **Select mode** (`select=audio/x-smpte-302m`, Phase 2) keeps
  its one ALWAYS `src` pad, in the element only while `select` names a
  stream (`gst_parse` would link a `src` at once and then never link the
  demux pads), and tsdemux's templates are registered before it, so a
  linker's template search never lands on it. Properties: `select`,
  `program-number` (−1, the PAT's first), `media`
  (`video,audio,private,subpicture` by default; the streams of other classes
  are never reassembled; a name that is no class fails the start),
  `sparse-gap-lag` (500 ms), `max-pes-bytes` (32 MiB, R9); `select` and
  `media` change only in NULL or READY. Read-only: `pid` (select mode),
  `generation` (−1 before a plan), `pes`, `gaps`, `markers`,
  `markers-dropped`, `unknown-streams`, `pes-dropped-stale` (p3-21), and the
  plugin's `abi` and counters.
  Chapter 7's `gap-threshold` and `unwrap-reference` were not built (B-122,
  S6), and the strings carry no `latency` or `ignore-pcr`. LATENCY is
  upstream's, SEEKING is answered not seekable, and the pads' flows are
  combined (`GstFlowCombiner`: NOT_LINKED only when every pad is).
- **The caps table** (part 4.2, as built in `classify`). Each caps string is
  tsdemux's, which the element parses; where two rows match one 0x06 loop,
  tsdemux's order decides (an AC-4 extension, 0x6A, 0x7A, 0x56, 0x59, then
  the registration).

| PMT stream type | Pad | Caps | Sparse | Unit |
|---|---|---|---|---|
| 0x01, 0x02 | video | `video/mpeg, mpegversion=(int)1` or `2`, `systemstream=(boolean)false` | no | the PES |
| 0x1B | video | `video/x-h264, stream-format=(string)byte-stream` | no | the PES |
| 0x24; 0x06 + registration `HEVC` | video | `video/x-h265, stream-format=(string)byte-stream` | no | the PES |
| 0x06 + `AV1G` | video | `video/x-av1, stream-format=(string)obu-stream, alignment=(string)frame`, the 0x80 descriptor's av1C fields and `codec_data` added through pbutils | no | the PES |
| 0x03, 0x04 | audio | `audio/mpeg, mpegversion=(int)1` | no | the PES |
| 0x0F | audio | `audio/mpeg, mpegversion=(int)4, stream-format=(string)adts` | no | the PES; `mpegversion` re-read from each PES's ADTS header (2 for MPEG-2 AAC), the caps updated before its segment |
| 0x11 | audio | `audio/mpeg, mpegversion=(int)4, stream-format=(string)loas` | no | the PES |
| 0x81; 0x06 + AC-3 descriptor 0x6A | audio | `audio/x-ac3` (0x81 with an E-AC-3 descriptor 0x7A: `audio/x-eac3`, as tsdemux) | no | the PES |
| 0x87; 0x06 + E-AC-3 descriptor 0x7A | audio | `audio/x-eac3` | no | the PES |
| 0x06 + registration `Opus` + extension descriptor 0x7F | audio | tsdemux's channel-configuration table through `gst_codec_utils_opus_create_caps` | no | its packets, control headers stripped, the trims as `GstAudioClippingMeta`, one buffer list per PES |
| 0x06 + `BSSD` | audio | `audio/x-smpte-302m` | no | the PES, with its AES3 duration |
| 0x06 + teletext 0x56 | private | `application/x-teletext` | yes | the PES |
| 0x06 + DVB subtitling 0x59 | subpicture | `subpicture/x-dvb` | yes | the PES |
| 0x06 + `KLVA`; 0x15 with metadata format `KLVA` | private | `meta/x-klv, parsed=(boolean)true` | yes | the PES; on 0x15 its metadata AU cells with `GstMpegtsPESMetadataMeta`, one buffer list |
| 0x06 + `ID3 `; 0x15 with `ID3 ` | private | `meta/x-id3, parsed=(boolean)false` | yes | the PES; on 0x15 without data alignment, DELTA_UNIT |
| 0x05, 0x0A–0x0D, 0x13, 0x16, 0x86 | — | no pad, no warning (tsdemux's section-only types) | — | — |
| anything else (0x06 with no known descriptor, DTS, AC-4, LPCM …) | — | no pad; `unknown-stream` once when tsdemux's class for it is in `media` (OQ-27) | — | — |

- **Pads and events, in tsdemux's order** (measured against stock tsdemux in
  the same harness, B-123). At each plan: the `GstStreamCollection` message;
  each pad added with STREAM_START (its `GstStream`, upstream's group id,
  SPARSE on a sparse pad, tsdemux's stream id `<upstream>:<program>/<pid
  %08x>`) and CAPS; an old program's pads, drained first by the core, sent
  EOS and removed after the new ones are added (tsdemux's drain, add,
  remove); then, pad by pad in plan order, STREAM_COLLECTION, after a
  `GAP(0, 0)` on a sparse pad; then `no-more-pads` and a `program` message.
  SEGMENT `{TIME, 0, 0, 0}` and a TAG (the language as tsdemux tags it, ISO
  639-1 where one maps, so `nor` is `no` and `mpegtsmux` writes `nor` back;
  the codec) go to each pad at its first buffer or GAP; a flush re-sends the
  segment, never the TAG. Pad names are `%s_%01x_%04x`, the generation's low
  4 bits, the first 0 (S13). The PAT and the PMT are `GstMpegtsSection`
  messages posted on the streaming thread, the PMT before the program's
  first pad-added: the one difference from tsdemux, which posts it after
  `no-more-pads`, kept because the muxer's hooks read the class set from it
  before any pad (S14).
- **Program identity** is tsdemux's `mpegts_base_is_same_program` (S13): the
  PCR PID, the stream count and each (PID, stream type) pair as before. A
  version-only PMT change, a language or a descriptor keeps the pads; a
  moved PMT PID is no change of its own; a PMT without streams is skipped,
  so it plans nothing and raises no `no-stream`, as tsdemux rejects such a
  table, while select mode warns. Found (B-121): tsdemux skips a PMT section
  whose version it has seen without reading its CRC, so a codec change at an
  unchanged version (`syn-mpts-two-programs`) re-plans `mrtsdemux` and not
  tsdemux.
- **Gaps.** A pad's horizon is the end of what it emitted, data or gap. An
  audio PES that starts more than two frames past it is a `jump` GAP over
  the hole, a frame being the upper median of the last eight clean spacings
  of at most 1 s (Phase 2's rule); a video pad learns its frame from its DTS
  in decode order (its PTS deltas read about three frames on IBBP content,
  B-122) and gaps a hole of 1 s or more (B-89); a sparse pad has no jump
  rule (S5). Each gap marker packet on a pad's PID is a GAP `[max(horizon,
  end − length), end)`, after that PID's open PES closes, dropped when
  empty, the pad's next unit DISCONT; markers never enter the walk (select
  mode's rule, B-60, S4). A sparse pad (teletext, DVB subtitles, KLV, ID3)
  gets `[horizon, program time − sparse-gap-lag)` once that span passes the
  lag, program time being the newer of the PCR's formula time and the newest
  non-sparse unit's end (B-86); such a gap sets no DISCONT and is not
  counted. DISCONT also follows a CC loss (the cut PES is dropped) and a bus
  DISCONT, which drops the open PES and the walk's carried bytes, so nothing
  joins across a relock. At EOS a bounded PES shorter than its length is
  dropped (tsdemux pushes it cut).
- **Guards and messages (S3).** One element message structure, `mrtsdemux`,
  with `reason`: `interval` every 1 s of running time (the counters,
  `generation`, `pads`); `program` at each plan (`generation`, `pcr-pid`,
  `pads`); `unknown-stream` once per PID per generation for a stream of
  `media` with no row (`pid`, `stream-type`, `registration`);
  `not-house-time` once per episode in both modes (`pid`, `offset-ms`, and
  `stale` when that PES was dropped; B-149, p3-21): an episode opens at a PES
  more than 60 s from house now that is a pad's first, stale or another
  jump, and closes after 10 s of house time with no PES off it
  (`EPISODE_QUIET_NS`); `no-stream` when a plan has no pad, by select mode's
  2 s rule (E16). Since p3-21 `interval` also carries `pes-dropped-stale`
  and `off-house`, the PIDs whose last placed PES is off house time, which
  the engine's warning follows (below). Both runners forward it
  unsubscribed as `mrtsdemux:<element>`.
- **No stand-in**, as in Phase 2: a start description naming `mrtsdemux` is
  refused without `libgstmrtshouse.so`, with the rule-6 alarm, and since
  Phase 3 that is every bus consumer that demuxes (below). The plugin now
  also links gstreamer-mpegts-1.0, -pbutils-1.0 and -tag-1.0, all on the
  image already. `MRTSHOUSE_ABI` stays 1 (S0 choice 4, S32): DEV deploys
  check every native's sha256 against the tarball instead.
- **`MpegTsProbe` keeps `tsdemux` (OQ-25).** The engine's codec probe of a
  bus edge (`unixfdsrc … ! tsdemux latency=0 ! parsebin ! fakesink` under
  `gst-launch -v`) reads codec caps, never time, so it is the one `tsdemux`
  left on the bus. It prints no caps for a pad it leaves unlinked, so an
  input that lists its video first probes no audio and its consumer gets
  `decodebin` (B-128).

### Parity with stock tsdemux and the recordings (WI-P3-3, WI-P3-4)

- **The parity harness**
  (`packages/engine/src/child-process/gst_mrtsdemux_parity_test.py`, in the
  engine's `test:py`) replays every recorded fixture (`cap-*`, `tp-*`,
  `bus-*`, by name) into `tsdemux latency=0` and into `mrtsdemux` at 188,
  1,000, 1,316 and 24,576-byte feeds, a bus recording also as recorded from
  its sidecar, each feed stamped by its arrival on the recording's PCR, as a
  bus stamps a buffer at its send time. It compares the plan's events in
  order, the section messages and their place, every other message, warning
  and error, each pad's events at their buffer counts, the buffers by size
  and CRC-32 (flags, list index and length, metas) and the GAPs (B-124).
  Since p3-18 it also holds the four `buildTsUdpInput` consumers' strings to
  having nothing that re-frames between their bus source and each demux, and
  each of their demux configurations at 1,000 bytes to its output on whole
  packets (B-144); 183 checks.
- **The allowlist**
  (`plugins/mpegts-core/tests/fixtures/demux_parity_allow.json`) has
  eighteen entries, each one rule of the comparison with its reason in the
  1.28.2 source, and each used by the run (an unused one fails it):
  `timestamps` (the formula against tsdemux's PCR skew: the point of the
  element), `sections-place` (S14), `pmt-same-version` and
  `pmt-continuation` (tsdemux's section filter), `psi-repeat-cc` and
  `psi-repeat-discont` (it re-posts a PAT or PMT after a CC loss or a
  DISCONT input), `cc-warning`, `cc-loss-discont` and `cc-loss-next-pes`
  (continuity: tsdemux warns at each mismatch and loses a PES that starts
  at it, where `mrtsdemux` counts, flags the next unit DISCONT and keeps
  that PES), `jump-gap`, `sparse-gaps` and `marker-gaps`
  (the gap rules above), `truncated-last-pes`, `tag-memory` (`mrtsdemux`'s
  Opus packets are regions of the PES buffer), `own-messages`, and
  `discont-drain`, `discont-flag` and `discont-pending` (tsdemux's flush at
  a DISCONT input: it pushes each open PES cut, which `mrtsdemux` drops; it
  flags every pad, where a marker flags only its PIDs'; and it drops the
  units it holds for a PCR, which `mrtsdemux` delivers). Its `measuredEqual`
  list holds eight behaviours that need no entry (the SEGMENT, tsdemux's
  SDT, EIT and TDT messages, buffers before the first PCR, timestamp-driven
  DISCONTs, a list's pieces, pads outside part 4.2, the re-plan order, and
  a PES whose first packet repeats its PID's last counter on other bytes:
  p3-3b's `cc-repeat` entry until B-203's `CcTracker`, carried in by m6,
  took a repeat for the duplicate ISO 13818-1 allows only on the same bytes,
  so `mrtsdemux` now counts such a repeat a loss and keeps the PES, as
  tsdemux does; m6 ported that rule into the reference and regenerated
  `bus-pmt-change`'s expectations, 496 PES to 508), and the synthetic
  `syn-*` fixtures stay out of it (S28).
- **Bus recordings are raw TS plus a sidecar** `<name>.bus.jsonl` (each bus
  buffer's offset, length, PTS, DTS, duration and flags), not GDP (S25,
  E15): the same information, dumpable as any TS and rebased by the TS rule
  plus one shift. `tools/fixtures/record-bus.sh` records an edge as a second
  `unixfdsrc` client; `mrts_cli rebase --to-ns T [--bus]` moves a recording
  onto another house clock by a whole number of 100 µs (`mrts/ts_rebase`),
  and a test rebases a fixture onto its own clock.
- **The fixtures** (all under `plugins/mpegts-core/tests/fixtures/`, a
  README row each, at most 2 MB): the five bus shapes no recording held,
  recorded by p3cap on the Pi 5 test box and committed rebased onto house
  1000 s (`bus-occ-ingest`, `bus-ingest-relock-gap`, `bus-pmt-change`,
  `bus-mux-av-klv`, `bus-hls-player`; B-132); nine third-party `tp-*`
  fixtures made on the dev Pi by `tools/fixtures/gen-thirdparty.sh`, mostly
  with ffmpeg 5.1, libavformat's muxer, the vMix's (S24); the trims
  `cap-gate-mux-hevc-aac-opus` (HEVC with B-frames, DTS) and
  `cap-mixer-302m-house`; the synthetic kinds `gap-500ms`, `gap-marker`
  (with its sidecar), `video-hole-1s`, `private-novdesc`, `pmt-version-bump`
  and `adts-mpeg2` from `fixture_gen --ts`, and `syn-foreign-clock-aac` from
  `fixture_gen --respace 40` (S28); and a reviewed `.demux.jsonl` beside
  every fixture. `tools/align-check/` holds `pes_diff.sh` (`--by pts` for a
  re-encode), `pcm_align.py` and `pes_formula.sh` for the device rounds.

### ASRC at decode and at outputs (WI-P3-5; plan part 4.4)

- **One element, four modes** (`mrasrc`, S17), one resampler each: capture
  (`bypass-below-ppm` 0 and no `device-sink`: Phase 1's servo, its run
  checksum `432e8439f253974f` at p3-5, with the release line's cycle input
  below), decode (`bypass-below-ppm` above 0, at
  most 1,000), device (`device-sink` set with `bypass-below-ppm` 0: the
  device term alone, no lock of the source) and decode + device (both: one
  ratio, the product of the two terms, OQ-23). `mrasrc-stats` gains `mode`
  (`capture`, `bypass`, `decode`, `device`, `decode+device`), `source-ppb`
  and `device-ppb` (each clock against house time, round(−ε / (1 + ε)),
  positive when it runs fast); `ratio-ppb` is the commanded composite. A
  decode + device element whose source still passes reads `device`. The
  servo's reference, `py/asrc_bypass_ref.py`, came first (OQ-1, S30);
  `mrts::AsrcServo` and `AsrcDeviceLock` port it rule for rule, and
  `asrc_bypass_ref_test.py` replays the same call sequences through it and
  `mrts_cli asrc`, line for line (B-125).
- **Cycle input at a capture** (B-180, B-181: the release line, carried in by
  m1/m2 and m5). With `cycle-input` (a `pipewiresrc` capture: one buffer per
  graph cycle, stamped with the cycle's time) whole cycles missing at a
  steady size, or a rise of the stamps past the lock's step (50 ms, a driver
  restarted after a loss), are a gap of their length: the output jumps those
  frames (DISCONT, `mrasrc-event` `gap` with `reason` `lost-cycle` or
  `lost-time` and `lost-frames`), the lock keeping its line and rate; a fall
  that undoes one at once is reverted (`gap` `reverted`). A cycle-size
  change moves only the stamps (`shift`, `cycle-size`). Neither relocks.
  `mrasrc-stats` counts them (`gaps`, `lost-frames`). Capture mode only;
  AES67 Input sets no `cycle-input`.
- **The decode lock** (`asrc_decode_lock_config`, S16) is the capture lock
  with a 10-bucket first fit, since a demux's PTS carry no arrival jitter.
  The prototype's sweep (1 h each: 48 kHz exact, 44.1 kHz quantised, MP2,
  32 kHz, Opus, a ±1-tick wobble): no count from 3 to 30 buckets engages a
  house-rate stream (|ε| at most 9 ppb once locked); +3 ppm engages at
  18.0 s with 3, 25.0 s with 10, 46.0 s with 30. Ten, not three, because a
  ±0.2 ms PTS wobble lifts |ε| to 0.86 ppm with 3 and to 0.20 ppm with 10,
  and the device lock shares the configuration.
- **The bypass rule (C-7).** Each buffer passes as it came, the same buffer
  and memory, while the source measures within the bound of house time and
  the phase within 1 ms; the element engages once |ε| has stayed past the
  bound for 10 s of lock (+3 ppm: 25.0 s) or the phase passes 1 ms (+40 ppm:
  24.9 s; +0.3 ppm: 55.4 min). The bound is the engine's
  `DECODE_BYPASS_PPM`, 0.5 ppm (`ingestTiming.ts`), on every decode ASRC.
  The engage is seamless: the resampler is reset, fed the last 64 passed
  frames at the commanded rate and as many outputs dropped, so its next
  output is the engaging buffer's first frame, labelled with its PTS, with
  no DISCONT. Where a resampler already runs (a rate conversion, a device
  term) the engage only hands the ratio to the servo: the counter continues
  and the phase, up to 1 ms, is steered out with τ = 10 s.
- **Breaks.** At a GAP event and before a DISCONT buffer the epoch ends: the
  resampler's tail leaves on the old counter, the lock relocks without its
  rate, and the next buffer opens an epoch at its PTS (`relock`). An
  envelope step (the timeline moved, not the content) re-anchors the labels
  on the lock's new floor and keeps the resampler.
- **Unflagged steps are content time (B-148).** Decode modes hold each
  buffer's PTS against the end of the last. Past the bound, max(1 ms, 2000
  ppm of the last buffer's span: an upstream mapping's acquire slew across
  it), and after a buffer that continued its own, a hole is lost time
  (`gap` `lost-time`: the input position moves on by its frames, so the lock
  sees no step; the output jumps it, DISCONT on resampled output, the same
  epoch) and a step back a break (`relock` `jump`). A source off its rate
  past the bound steps on every buffer, so none is judged: the lock's, as
  before. Why: on DEV-P3a a capture's lost PipeWire cycle reached a decoder
  as an unflagged 21.33 ms hole, the transcoder's `opusenc
  perfect-timestamp` restarting its count at the DISCONT and the demux
  flagging only holes past two frames, and the lock read it as a source
  clock (engaged at −65 and −342 ppm on a house-rate stream).
- **The device term** (§8, C-6). At READY→PAUSED the element `device-sink`
  names downstream must be a `GstAudioBaseSink` with `slave-method=custom`
  (3), else an error naming it. Its custom-slaving callback feeds
  `AsrcDeviceLock` (on the decode lock's configuration) and always answers
  `requested_skew` 0, so the sink never drops or inserts a sample. The
  output counter runs on from the first PTS on the device timeline, which a
  `sync=true` sink on a fixed calibration needs until Phase 4: a new epoch
  starts at the last content's label end plus the gap at the device ratio,
  so a relock jumps the content gap (B-148; re-anchored on house PTS, each
  relock had added the device's drift since the last to the playout,
  DEV-P3a's +115, +75 and +325 ms on a card 136 ppm slow). The offset
  restarts when the sink recalibrates (new caps, sync latency, a device
  failure: the callback flags it, the servo takes it at its next push), the
  open epoch keeping its labels. A sink discontinuity relocks the device
  lock, keeping its rate (`device-relock` with its reason), but an
  alignment resync (a moved presentation offset) moves neither clock: it is
  counted (`device-resync`, `device-resyncs`), the lock and its fit window
  kept (B-148). Two rules came from building it: the
  callback reads the house clock again and places each pair there, the
  latest instant the sink's `itime` can have been read, so a pair is never
  early (one 0.48 ms early held the rate 6 ppm off for a minute); and a
  (re)lock's first 100 ms of pairs are left out (the sink's first callback
  after its calibration reads the device up to 0.33 ms early). On the same
  readings either rule left out leaves the rate 11–14 ppm off at 15–30 s;
  with both, within 0.04 ppm.
- **Out of bounds, decode (B-148).** `ratio-out-of-bounds` once the fit has
  stayed past the clamp for 30 s of PTS while locked: a relock's first
  10-bucket fit (DEV-P3a's −1051.6 ppm) and an upstream acquisition slew
  shorter than that raise nothing; a source 1500 ppm fast raises at 45 s,
  one 5000 ppm fast at 52 s. Not on a 30-bucket fit as the fix plan had it:
  a source past the clamp steps the lock's envelope every 50 ms of excess,
  cutting its fit back, so one past about 3500 ppm would never warn.
- **The engage's rate (B-148).** The `engaged` event and `mrasrc-stats`
  carry `rate-known`. A phase engage in the lock's first seconds has none,
  so the engine words it as the timeline ("Source timeline 1.0 ms off its
  sample count: resampling (rate not measured yet)") and its row reads
  `measuring`, not a 0.0 ppm source.
- **Known limits (B-148).** A hole of 1 ms or less stays the lock's (a
  ratio engage of a few ppm half a minute on). PES of half a second or more
  split into AU buffers under an upstream acquisition slew step past 1 ms
  at their boundaries: lost time (the rate read low) or, falling, breaks.
  Decoded PTS jittering past about ±0.5 ms read as holes and breaks (none
  seen: the bus carries content time). The gate's AAC as `cap-mux-align7`
  holds it steps back 14–18 ms unflagged: a `jump` relock each. `opusdec`
  stamps the two buffers after its 6.5 ms pre-skip that much early, so an
  Opus stream's third buffer meets a 6.5 ms hole: one lost-time gap at its
  start (on a device path, one DISCONT the sink places by label). A device
  slip under the 50 ms step is rate for minutes, the rate term returning
  its phase (WI-P4-4). A recalibration mid-run leaves the open epoch's
  labels as they are.
- **Interleaved caps (S15).** `mrasrc` takes S16LE, S32LE and F32LE
  interleaved; `avdec_aac` gives planar F32LE, so the audio decoder's and
  the audio transcoder's branches put `audioconvert` before it, while the
  302M branches (the helper's and aes67-output's) feed `avdec_s302m`'s
  interleaved S16LE or S32LE straight in.
- **Latency.** `mrasrc` answers LATENCY with its filter's lookahead,
  32 frames (0.667 ms at 48 kHz, quality 4), while passing too, where
  `audioresample` at equal rates answered 0 (B-127).
- **The stand-in** stays `audioresample` (B-23), the rewrite dropping the
  new properties. A sink left on custom slaving without `mrasrc`'s callback
  would not be slaved at all; it cannot happen on these paths, because each
  also names `mrtsdemux`, which has no stand-in.
- **The test sink** `mrtestaudiosink` (`mrtshouse/tests/mrtestaudiosink.c`,
  `tests/libgstmrtest.so`, never installed; S18): a device a set ppm off the
  pipeline clock that reports its ring's fill, resyncs and calibration
  changes, and `MrTestClock`, a clock `speed` times real time. Phase 4
  reuses both.

| Constant | Value |
|---|---|
| Decode bound | 0.5 ppm (`DECODE_BYPASS_PPM`; the element takes 0 to 1,000) |
| Phase bound | 1 ms (`bypass_phase_ns`) |
| Hold | 10 s of lock past the bound (`bypass_hold_ns`) |
| Decode lock's first fit | 10 buckets (`rate_buckets_min`; the capture lock's 30) |
| Priming at an engage | the last 64 passed frames |
| Phase steering | τ = 10 s (`phase_tau_ns`) |
| Ratio clamp | ±1,000 ppm (`ratio_max_ppm`); past it `ratio-out-of-bounds` (decode: held 30 s while locked, `OOB_HOLD_NS`) |
| Lost-time bound (decode) | max(1 ms, 2000 ppm of the last buffer's span), judged after a buffer that continued its own (B-148) |
| Device lock | pairs at the house clock read after the callback; the first 100 ms after a (re)lock left out (`SETTLE_NS`) |

### The consumers on the formula (WI-P3-7 to WI-P3-15, WI-P3-18)

Every bus consumer that demuxes now names `mrtsdemux`; no description
carries a timing declaration, and the field is gone (below).

- **302M fan-ins** (the helper in `audio-302m-core`, so audio-mixer,
  n1-mixer-302m, audio-processing and audio-output-302m): each branch `… !
  mrtsdemux … select=audio/x-smpte-302m ! avdec_s302m ! mrasrc
  name=<m>_asrc<i> bypass-below-ppm=0.5 out-rate=48000 ! audioconvert[
  mix-matrix] …`, a live branch's ASRC `liveAsrcName(m, connection)` =
  `<m>_asrc_<hash>`, as its demux. `branchAsrc: false` drops only the direct
  branch's ASRC (one source, not in live-input mode), whose caller then
  carries the decode term; a mixer-arm branch always keeps its own, since
  one resampler after a mix cannot match two sources' clocks.
  `mixInputDemuxes` names each branch's demux and ASRC for the rows (B-127).
- **aes67-output**: `<busSrc> ! <queue 200 ms> ! mrtsdemux name=demux
  select=audio/x-smpte-302m ! avdec_s302m ! mrasrc name=asrc
  bypass-below-ppm=0.5 out-rate=48000 ! audioconvert ! <AES67 caps> !
  <payloader> ! … udpsink`; the sink, the RTP `timestamp-offset` and the
  pacing are unchanged; the udpsink sends 0.667 ms later, the RTP timestamps
  unchanged.
- **audio-output-302m**: `… <m>_out. ! identity name=live_upstream sync=true
  ! mrlateness name=lat_render ! audioconvert ! mrasrc name=outasrc
  [bypass-below-ppm=0.5] device-sink=sink ! volume ! level ! [placement] !
  pulsesink name=sink … slave-method=3 …`. B-62's identity stays (S11); the
  render tap sits before the ASRC, where PTS is still content time. One
  source: its branch has no ASRC and `outasrc` carries both terms; a mixer:
  each branch's decode ASRC, then `outasrc` the device term alone.
- **audio-decoder**: `<busSrc> ! mrtsdemux name=addemux media=audio ! queue
  … ! <decoder> ! audioconvert ! mrlateness name=lat_render ! mrasrc
  name=asrc bypass-below-ppm=0.5 device-sink=sink ! audioconvert ! volume !
  level ! pulsesink name=sink … slave-method=3 …`: one resampler for the
  source's clock and the output's (OQ-23); the Sync Method setting
  (`slaveMethod`) is gone with skew slaving (S31; stored values ignored,
  OQ-33). `media=audio` gives the decoder the program's first audio stream
  (OQ-28): `decodebin`, which the probe's `unknown` selects for an input
  that lists its video first, took the video before (B-128).
- **audio-transcoder**: `<busSrc> ! mrtsdemux name=demux media=audio ! queue
  … ! <decoder> ! audioconvert ! mrasrc name=asrc bypass-below-ppm=0.5 !
  audioconvert[ mix-matrix] ! volume ! level ! tee …`, each rendition's leaf
  unchanged: one decode ASRC for every rendition, with no `out-rate`, so it
  also converts a rate a rendition does not take (a 44.1 kHz source with an
  Opus rendition now negotiates). The encoders keep `perfect-timestamp`, so
  a rendition's PES PTS sit on its sample ladder from its first AU (S40):
  the first AU at the input's first PES PTS, Opus at 0 ticks, AAC within a
  tick of the ladder (one or two AUs in three a tick low, by the first PTS's
  residue mod 9), 302M within a tick of its PCM's stamps (B-129); at an
  input hole the encoders re-sync past their 40 ms tolerance (B-142).
- **Both audio outputs** (Audio Output (302M), Audio Decoder) are on custom
  slaving: `SLAVE_METHOD_CUSTOM = 3` replaces `SLAVE_METHOD_SKEW`, and the
  sink is never asked to skew. `sync=true`, `ts-offset`, `buffer-time`,
  `max-lateness=-1` and the backlog shedder stay until Phase 4, the shedder
  moved to the ASRC's input (`element: 'outasrc'`, `'asrc'`), the last pad
  on content time: after the device term the PTS are device-time labels that
  ramp at the device's rate, so a reading at the sink's pad would raise the
  route's D for a slow DAC (B-127, B-128). FF9 stays on both too (B-184, the
  release line's, carried in by m3 against B-164's "not ported"): each leg
  relaunches its own pipeline once its source timeline settles, armed by
  the shedder's rebase (now read at the ASRC's input) or by the first VU
  reading after a stall of 5 s or more, pushed back by an `implausible`
  report, run after 10 s without either, at most once a minute, until
  Phase 4 deletes it with the shedder (p4-7, p4-8, p4-11). Its cost here:
  one relaunch, 58 ms to 0.5 s of silence, after an outage the device
  timeline now bridges (B-148).
- **video-player**: `… ! tee name=vp_ts ! mrtsdemux name=vpdemux media=video
  ! [capsfilter caps="video/x-h26x" !] queue …` on every rung, `decodebin3`
  included: the video only (Q18), so a source that lists its audio first
  plays from the first start; the explicit rung's capsfilter stays its codec
  guard (B-133).
- **mpegts-muxer**: each input `… ! mrtsdemux name=demux_<i>`, demux mode
  with every media; every access unit, the cues included, leaves at its PES
  time and `mpegtsmux` writes it back at its own PES PTS to the tick; the
  `mux_routing` hooks are unchanged, reading the class set from the PMT
  message before the pads (B-134).
- **Subtitles In** (the player's overlay and the transcoder's burn-in,
  `buildSubtitleInput`): `… ! mrtsdemux name=subdemux media=private`; only
  private streams are reassembled (B-137).
- **teletext-subtitles**: `… ! tee name=in_t ! queue ! mrtsdemux name=demux
  media=private ! capsfilter caps="application/x-teletext" ! tee name=t …`
  (B-138).
- **transcoder**: `… ! mrtsdemux name=demux media=video ! capsfilter
  caps="video/x-h264" ! [mralignwatch … !] h264parse ! avdec_h264 …`: every
  egress PES carries its input PES PTS, 0 ticks (B-139).
- **No `tsparse` before a demux (OQ-26, WI-P3-18).** `buildTsUdpInput` is
  the bus source and its jitter queue, nothing after: the bus carries whole
  188-byte packets (ADR-0011) and the demux's `PacketWalker` carries any
  split packet into the next buffer. Measured before the change, the
  `tsparse set-timestamps=false` it ended in cleared every buffer flag, so
  the transcoder's, the player's, teletext's and the subtitle input's demux
  never met a gap marker or a bus DISCONT, and at a relock it lost a
  teletext subtitle (752 bytes: a one-packet marker and the three-packet PES
  after it) before the demux (B-144). `buildTsRechunk`, the egress re-chunk,
  is unchanged.

### The subtitle path (WI-P3-7, WI-P3-8, WI-P3-13; OQ-24)

- **A cue anchors on its own PES time.** The formula puts each KLV cue's PES
  PTS on its buffer, so the consumer's chunk-stamp join (a Python TS walk
  and stamp model per bus chunk on the demux's sink pad) is gone:
  `subtitle_cues.cue_t0` is the demuxed PTS when it is within
  `FRAME_TIME_TOLERANCE_MS` (10 s) of house now, else the arrival, and the
  bridge's show line reads `t0src=pts` or `t0src=now`, never `chunk` (V11).
  The re-send key `klv_span` and `payload_key` moved into `subtitle_klv.py`
  (B-137).
- **The producer takes the teletext PES's time.** `teletextdec` stamps a
  page with the PTS of the teletext PES that completed it, which the formula
  makes that PES's house time, so the bridge's `PayState.new_cue` takes the
  content time straight off the text. The producer's retime is deleted (the
  `sourceDemux` walk, its native `mrpeshouse` and its Python fallback),
  every page from the first is on its PES time, and the start-up warning
  "content time unavailable yet — tsdemux time used" is gone. A cue's start
  is no longer rounded to whole ms (`subtitle_cues.make_cue`), so a cue's
  PES PTS is its teletext PES's to the tick (B-138).
- **The burn-in waits in a pace group** (OQ-24, B-139). With Subtitles In
  wired the transcoder puts `mralignwatch name=aw_burnv aligner=burnin
  input=video max-size-bytes=40000000` on its compressed video before
  `h264parse` (full, it holds upstream and never drops), and
  `subtitleRenderPlan(…, { aligner: 'burnin' })` makes the bridge read each
  KLV pad through `mralignwatch aligner=burnin input=cues sparse=true` (made
  at pad-added, S36) in place of a queue. Both watches release at their
  running time plus the shared pace, which follows the most lateness either
  showed over `fall-after` (180 s): the cue path's. A frame and its cue for
  time T both leave at T + pace, and the frame then crosses the decoder, the
  raw queue, deinterlace and videorate, so the cue reaches the bridge first
  by the decode latency (136–149 ms in the protocol case). The bridge's show
  line gains `margin=` (house now less the cue's arrival). Found: the first
  cue after a start (or after `fall-after` with no cue) is drawn late,
  ≈ 900 ms in the case, because it reaches its watch before the pace has
  learnt the cue path; every later cue lands on its frame, and a cue later
  than all before it is forwarded at its own PTS with a `late-cue` and
  raises the pace (Phase 2's sparse rule). With burn-in on, the video's
  watch answers LATENCY as non-live, so the stream below it is non-live
  (nothing syncs on it). `subtitleDelayMs` (Subtitle Sync Delay), its
  `subhold` queue and their plumbing are deleted, stored values ignored
  (OQ-33). `TranscoderModule.alignerInputOf` puts the two watches on the TS
  input's and Subtitles In's rows.
- **The bridge stays Python-only** (ADR-0016's 2026-10-09 decision), and its
  descriptions pin `runner: 'python'`; with the K recovery gone it reads no
  bus chunk stamp at all.

### The engine: what a demux and an ASRC show (WI-P3-6)

- **Runners.** Both forward `mrtsdemux` (already in Phase 2), `mrasrc-stats`
  and `mrasrc-event` unsubscribed, as `<structure>:<element>`, so a
  live-added branch reports without a `busReports` entry; the two lists are
  pinned equal (`busRunnerContract.test.ts`, `gst_native_plugins_test.py`).
- **Readers.** `demuxWatches.ts` and `asrcWatches.ts` keep each element's
  state, `LatenessReporter` places it on an input's row, `ModuleTiming` logs
  and syncs, and `GstPluginBase` owns the warnings. A capture ASRC (mode
  `capture`) stays its ingest card's and is not shown here.
- **Rows** (shared types `DemuxCounters`, `ClockCorrection`): per input,
  Demux rate (PES/s over the last 10 s of reports), Demux gaps (holes: a
  jump or a marker), Demux CC lost (packets) and Demux unknown streams (the
  current program's); Clock correction, `none (house rate)`, `+23.4 ppm
  (source)` or `measuring` (engaged before its rate is measured, B-148), on
  the input row of an ASRC placed on one, else on the `timing`
  section; Device clock (`−12.1 ppm`) on the `timing` section. The ASRC's
  terms are read off the description at start (`bypass-below-ppm` > 0 a
  decode term, `device-sink` a device term), since `mode` reads `device` for
  a decode + device ASRC whose source passes; so is a demux's `media`.
- **Which input.** The module's `demuxInputOf(element)` (`{ tap }`, `{
  connection }`, `{ port }`, `{ label }` or `null`), else the engine's rule:
  an element named for a bus connection (`…_<shortHash(connectionId)>`)
  serves that edge, else a demux serves the module's one input and an ASRC
  the module. mpegts-muxer maps `demux_<i>` to its pin; audio-processing and
  audio-output-302m their fan-ins' names through `mixInputDemuxes`; the
  subtitle renderers `subdemux` to Subtitles In (`renderDemuxInput`).
- **Log lines.** A program after the first (generation > 0): `Input <n>:
  program changed (generation g)`; a consumer ASRC's engage: `Input <n>:
  source clock +x ppm: resampling`, or before its rate is measured `Input
  <n>: source timeline 1.0 ms off its sample count: resampling (rate not
  measured yet)` (B-148); `ratio-out-of-bounds` at warn.
- **Warnings**, owned by the module in one health text with the aligners'
  (taken only over ok or its own text, ADR-0010 rule 2, never over a stopped
  or errored module): `demux-unknown-stream` (`Input <n>: PID 0x0123: stream
  type 0x06 with no known descriptor is not demuxed`),
  `input-not-house-time` (`Input <n> is <x> s off house time — its producer
  does not stamp house time`; for a PES dropped as stale, `Input <n>: a PES
  <x> s off house time was dropped as stale`, p3-21), `input-no-stream`
  (`Input <n> carries no audio stream`, the kind from `select` or `media`)
  and `asrc-out-of-bounds` (`… past the ASRC's 1000 ppm — check the source's
  sample rate`). Each clears at the demux's next generation, a module start,
  a respawn or 6 s of quiet; `no-stream` also once a report finds the
  stream; `not-house-time` once a report's `off-house` no longer lists its
  PID (back on house time), a stale drop's after 10 s unless the report
  lists its PID, which then means its stream left house time and takes the
  producer's words (p3-21); out-of-bounds once a stats report has the
  source locked below 900 ppm, the element's own hysteresis. A warning
  drops nothing; the demux drops the stale PES.
- **Protocol.** `plugins/mpegts-core/tests/fixtures/forwarded-messages.json`
  holds one forwarded payload per reason and kind as both runners forward
  them; the engine's tests feed it through the readers, and the protocol
  cases hold every forwarded payload to its entry's fields and types.

### Deleted with their mechanisms (WI-P3-16 to WI-P3-18)

- **Branch alignment and the retime** (WI-P3-16, B-142): the native runner's
  `branch_align.{cpp,h}` and `branch_retime.{cpp,h}` with their glue, the
  Python runner's align block (506 lines) and `branch_retime.py`,
  `PipelineDescription.alignBranchesToStamps` and
  `AlignBranchesToStampsConfig` (`transformProducer`, `privatePads`, and
  with them B-65's and B-67's rules), `gst_branch_align_test.py` and
  `gst_tsdemux_slave_test.py`. `_pid_from_tsdemux_pad_name` is kept as
  `_pid_from_demux_pad_name` (`mrtsdemux` names its pads as tsdemux does).
  Every consumer being on the formula, the correction of tsdemux's zero
  point had nothing left to correct; kept, it would have been a second, dead
  timing path.
- **The subtitle K recovery** (WI-P3-17, B-143):
  `mpegts-core/native/mrpeshouse/` (4,330 lines, so the image no longer
  carries `libgstmrpeshouse.so`), subtitle-core's `subtitle_native.py`,
  `subtitle_stamp_model.py` and `subtitle_ts.py` with their tests;
  `mrts/ts_timeline.{h,cpp}`, whose `timing_pes` moved into `ts_house`
  beside `IdentityStamp`, its only caller (B-51); and the `read_pes_pts`
  forwarder of `ts_psi.h` (S7; `read_pcr` lives in `ts_pcr.h`). The opt-in
  egress trace (`MR_SUBTITLE_EGRESS_TRACE=1`) walks its own packets (S21),
  so no runtime path imports the Python timing reference any more: the
  engine build's copied modules and the runner hooks, every import followed,
  are 24 repository modules, none of them `ts_timeline` (B-143).
- **`tsparse` in the consumer input** (WI-P3-18, B-144), above.

### Tests

- **Protocol cases in both runners** (`native_runner_protocol_test.py`,
  777 checks at p3-21; the subtitle bridge's cases on the Python runner):
  `presentation-formula` (E: every buffer a 302M presentation leg's sink
  syncs on at its PES PTS − 1 h, ceil to the ns), `transform-formula` (M:
  the transcoder's shape on `bus-occ-ingest` and `syn-gap-marker`, 0 ticks
  and the B-frame DTS intact, the markers taken as GAPs; the audio
  transcoder's own string on `bus-occ-ingest` and `bus-ingest-relock-gap`,
  S40 per stretch), `cue-formula` (M2: KLV, teletext and DVB cues at their
  PES PTS), `mux-formula` (P: the muxer's own command, every PES at its
  input PES PTS, the PIDs planned at the PMT), `video-leg-formula`,
  `subtitle-overlay-formula`, `ttx-formula`, `burnin-formula`,
  `transcode-formula`, `mrtsdemux-pmt-change`, `mrtsdemux-messages` and
  `mrasrc-device`. The four rewritten cases (E, M, M2, P) fail on the
  strings before Phase 3 and on a floor conversion (B-142).
- **Element and chain suites**: `gst_mrtsdemux_element_test.py` (every
  fixture's pads, caps, units and gaps against its `.demux.jsonl`, the event
  order against stock tsdemux), `gst_mrasrc_element_test.py`,
  `gst_decode_asrc_chain_test.py` (the real modules' decode strings from the
  snapshot `fixtures/decode-asrc/pipelines.json` into `mrtestaudiosink`),
  the parity harness above; the C++ suites `demux_core_test`
  (`demux_core_test.py`'s cases one for one, the same checks in the same
  order) and `asrc_servo_test`.
- **String snapshots** that the cases replay, the real builders' output,
  rewritten by `vitest -u` when a builder changes (B-72's mechanism; no
  `tests/` directory ships): Phase 2's `fixtures/aligner/pipelines.json`,
  regenerated, and this phase's `fixtures/decode-asrc/pipelines.json`,
  `fixtures/video-leg/pipelines.json`,
  `subtitle-core/tests/render-plan.json`,
  `teletext-subtitles/tests/teletext-plan.json` and
  `transcoder/tests/burnin-plan.json`.

### As-built deviations, by work item

Each item recorded these against its brief for the owner's veto; the
sections above give the reasons, the register rows the details.

- **p3-3a** (WI-P3-3, first half): bus recordings as TS plus a sidecar (S25,
  E15); the third-party set from ffmpeg (S24, E14); the rebase in 100 µs
  steps; `tools/align-check/` built here, with `pes_diff.sh --by pts` for
  V1's re-encodes (B-120).
- **p3-1a** (WI-P3-1, first half): the Python reference first; the ceil;
  tsdemux's program identity, caps and precedence; a marker closing its
  PID's open PES; `.demux.jsonl` beside every fixture (B-121).
- **p3-1b**: `DemuxCore` with `SelectDemux` folded in (E1); one
  `DemuxEvent`; the caps as tsdemux strings; the video frame from DTS; a PMT
  without streams skipped (B-122).
- **p3-2** (WI-P3-2): one message name (E3); no `unwrap-reference` (E4) or
  `gap-threshold`; tsdemux's event order with the PMT section before the
  pads (E7); the 4-bit generation from 0 (E5); `media` and the no-stream
  warning in demux mode (E16) (B-123).
- **p3-4** (WI-P3-4): the allowlist as rules, each used; feeds stamped on
  the recording's PCR; synthetic fixtures out (B-124).
- **p3-3b** (WI-P3-3, second half): the five recordings rebased onto house
  1000 s (they were taken past the 33-bit wrap); seven more entries (B-132).
- **p3-5** (WI-P3-5): the decode lock (E9); the seamless engage; the two
  device-lock rules; `mrtestaudiosink` (S18) (B-125).
- **p3-6** (WI-P3-6): the readers built here (WF-B had left B-70's open);
  `mrasrc-*` forwarded unsubscribed (E10); the terms read off the
  description; the clear rules (B-126).
- **p3-9** (WI-P3-9 + WI-P3-15): no `audioconvert` before a 302M branch's
  ASRC; `branchAsrc`; the shed point at `outasrc`'s input (B-127).
- **p3-10** (WI-P3-10): Sync Method deleted here, not in Phase 4 (S31, E13);
  `media=audio`; the shed at `asrc`'s input (B-128).
- **p3-12** (WI-P3-12): one decode ASRC converting rate and clock; S40's
  ladder criterion (B-129).
- **p3-11** (WI-P3-11): `media=video` on every rung; the video-leg snapshot
  (B-133).
- **p3-14** (WI-P3-14): the hooks unchanged; the aligner's queue level
  counted from its horizon (B-134).
- **p3-7** (WI-P3-7): `media=private` on Subtitles In; `cue_t0`'s two
  sources; the dedupe helpers moved (B-137).
- **p3-8** (WI-P3-8): the cue start kept to the µs (B-138).
- **p3-13** (WI-P3-13): one watch in the string and one the bridge makes
  (S36); the cue path's lateness as the wait (B-139).
- **p3-16** (WI-P3-16): `transform_input_fixture.py` pruned, not deleted
  (S20, E11); the protocol cases rewritten as above (B-142).
- **p3-17** (WI-P3-17): the egress trace's own walk (S21, E12);
  `ts_timeline` and `timing_pes` held by three exact checks instead of the
  grep (S22) (B-143).
- **p3-18** (WI-P3-18): the player's two input arms one string; the parity
  section for the four consumers (B-144).

### What this phase supersedes

- **ADR-0005**: decision 5's skew slaving of the DACs and its open A/B item
  (the house clock stays CLOCK_MONOTONIC); Stage 3a's skew pin; Stage 3c's
  `gst_tsdemux_slave_test.py` probe and the audio legs' shed point; Stage
  3d, per-branch zero points, whole; Stage 3e's reason for keeping bus-fed
  producers off `liveCaptureClock`; the 302M output leg notes' skew pin and
  presentation-leg alignment; the transform-producer retime amendments and
  the transcoder's subtitle hold; decision 2's note on the branch-align
  caps. **ADR-0016**'s 2026-10-09 amendment for timing: the chunk-stamp
  join, the producer's retime and `mrpeshouse`; the KLV carrier, the packed
  pay tail and the Python-only bridge stay. **ADR-0019**'s Stage 2 feature
  entry, multi-branch stamp alignment. Each now points here.
- **Amended**, a few lines each: ADR-0001 and ADR-0002 (no runtime importer
  of the Python timing reference; the native runner links `libmrts.a` for
  its gates alone), ADR-0008 (each 302M branch's decode ASRC in place of
  `audioresample`; the output on custom slaving), ADR-0011 (no consumer
  re-chunks its input), ADR-0014 (the placed 302M output on custom slaving)
  and ADR-0017 (each cue leaves the muxer's demux at its own PES time, no
  retime).
- **This ADR's earlier sections.** S0's `read_pes_pts` forwarder and
  `ts_timeline` suite are gone, and `mrpeshouse` from choice 2's list;
  choice 1's runtime importers have all stopped. Phase 0's render tap on an
  audio output with a device ASRC sits before the ASRC, not at the sink.
  Phase 1's "Phase 1–2 consumers" that ran `tsdemux` in PCR mode are gone,
  so no bus consumer re-bases on its flagged PCRs (only the codec probe
  runs `tsdemux`), and its DISCONT finding (B-20) is closed (below). Phase 2's `mrtsdemux` runs
  `DemuxCore` (`SelectDemux` folded in) on the ceil, its helper branch
  decodes into `mrasrc` in place of `audioresample`, and the muxer's
  `privatePads`, its two retime rules and the tick lost through tsdemux →
  mpegtsmux (B-69) are gone with the retime; its open B-20 is closed (below)
  and B-70's demux rows are built (B-126).

### Deleted in this phase

`branch_align` and `branch_retime` in both runners with their glue,
`alignBranchesToStamps`, `AlignBranchesToStampsConfig` (`transformProducer`,
`privatePads`), `gst_branch_align_test.py`, `gst_tsdemux_slave_test.py` and
`transform_input_fixture.py`'s tsdemux runners; `mrpeshouse` (element, PES
walk, the C++ K model, its vectors), `subtitle_native.py`,
`subtitle_stamp_model.py`, `subtitle_ts.py` (`PesStamper`, `StampIndex`) and
their tests, `subtitle_runtime.chunk_probe`, the consumer's chunk join, the
producer's retime and `sourceDemux`; `mrts/ts_timeline.{h,cpp}` and its
suite (the cases in `ts_house_test`), the `read_pes_pts` forwarder;
`ts_select.{h,cpp}` and their suite (folded into `DemuxCore`); `tsdemux` in
the eight consumer strings (aes67-output, audio-decoder, audio-transcoder,
mpegts-muxer, Subtitles In, teletext-subtitles, transcoder, video-player);
`audioresample` after the 302M decode (the helper, aes67-output,
audio-output-302m); skew slaving (`SLAVE_METHOD_SKEW`) on both audio
outputs; `tsparse` in `buildTsUdpInput`; the settings `slaveMethod` (Sync
Method, audio-decoder) and `subtitleDelayMs` (Subtitle Sync Delay,
transcoder) with the `subhold` queue, their stored values ignored (OQ-33).
`py/ts_timeline.py`, `ts_timeline_test.py` and `py/ts_psi.py` stay as the
reference (OQ-1); nothing at runtime imports `ts_timeline`.

### Open at the end of the build

- **The device rounds** (plan chapter 7 part 11). Ran, on builds before the
  one that ships: **DEV-P3a** on the Pi 4 test box (2026-11-03, build
  c6038d39, W1 to W7 without p3-16b): the ASRC bench PASS (8 engaged stereo
  paths at quality 4: S16LE 7.43 %, S32LE 20.86 %, F32LE 20.02 % of one
  core, under WI-P3-5's 25 %); V5 PASS (the foreign source engaged by the
  phase rule 20.6 s after its stream's probe, 120,000 Opus AUs on their
  ladder at 0 ticks, the house source bypassed throughout; another house-fed
  decoder engaged, B-148's lost-time fault); V6 PARTIAL (the foreign path's
  RTP within a sample of house time for 40 min and the house path's mixer
  ladder at 0 ticks, but one 868-sample (18.1 ms) step of the house path's
  RTP offset, at the second of the mixer's Phase 2 pace fall, "Pace fell by
  36 ms"; the planned rig, an SRT input into the mixer, not run: its port
  takes `audio/302m` only); V7 FAIL (no skew ever asked, but render lateness
  raised to the 2 s ceiling and an implausible device ppm, under a load of 9
  to 13: the faults B-148 fixed on the dev Pi, not re-run on a sound card);
  V11 PASS. **DEV-P3s**, the owner's 2 h soak across the bus PTS wrap in
  place of DEV-P3c's 24 h one (3 Nov: "do a 2 hour soak test?"; the wrap
  about 19:45Z that day, both test boxes, the m6 build c8539135): V10 PASS
  (no PES PTS step, no not-house-time, no gap or relaunch, no timing step
  over 1 ms at the wrap; `pes_diff` across a re-encode PARTIAL by
  construction, the ladder holding), V11 PASS, V12 PASS. **Still to run** on
  the v2.0.0.102 candidate, for the orchestrator and the owner: DEV-P3b (V1
  to V4, V8, V9; V9's muxer half fails until it is built, below), V13 (the
  rollback) and V7 again after B-148; nothing built since m6 (p3-16b, the
  v2.0.0.101 fixes, W9, c34, p3-21) has been on a box. Their criteria as the
  rows correct them: V1's audio transcoder by S40 per stretch of continuous
  input (B-129, B-142), its Opus pads checked by `pes_formula.sh`'s join of
  a packet to its PES by PTS (p3-21), V3 with `mrasrc`'s 0.667 ms added
  (S37), V5's sample count against the offset held from the engage, V8 on
  the Pi 4 player and the Pi 5 transcoder against p3base (B-144), V7's
  device numbers read with the caveat below.
- **The phase review** (2026-11-05): a Fable review of every Phase 3 item
  against chapter 7 and the build plan, adversarially verified, and its
  fixes (p3-21, row B-213), one commit.
- **p3-16b, the shared bus demux helper (B-145), is built** (2026-11-03, on
  the carried line): `buildBusDemux` in busHelpers.ts builds the segment
  `buildBusSrc ! queue ! mrtsdemux …` for nine consumers, every string
  byte-identical; every 302M fan-in arm, the live-input branches included,
  decodes through it (`decode302m`).
- **For the orchestrator** (recorded in their rows): neither `mux_routing`
  form routes a re-planned program's pads, so after a codec switch or a PCR
  PID change an input's new pads are sunk and V9's "muxer re-plans" fails
  until it is built (B-123, B-134: options a hook keyed by the pad's
  generation, a rebuild on a program change, or documenting it); the
  restamp puts no video marker on the bus at a relock (B-132; its
  `CcTracker` half is closed by B-203, carried in by m6: a repeat on other
  bytes is a loss, and the counters `DemuxCore` keeps across a bus DISCONT
  count one CC loss per PID whose counter does not continue, never a lost
  PES); the player's video pad, re-added by a program change that keeps
  the codec, stays unlinked until a rebuild (B-133); `buildTsRechunk`'s
  `tsparse` keeps its DISCONT rule, so ADR-0011's re-slice holds only
  between DISCONTs (B-144); a stopping transcoder clears its egress stamper
  before the EOS drain, so its last frames carry non-house stamps (B-139).
- **For the owner**: the first burnt-in cue after a start drawn late, and
  the option of seeding the cue watch from the Subtitles In producer's
  output lateness, not built (B-139); the stale-PES rule's cost (B-149,
  above: a producer that restarts off house time can lose up to a GOP of
  video); the engineering choices of rows B-120 to B-149 and B-213, each
  recorded for the veto. Phase 4's p4-4a measured this phase's
  `AsrcDeviceLock` 5–20 ppm off on real `pulsesink` clocks, a short fit
  after a DISCONT able to replace a good rate (125–286 ppm off); Phase 4's
  p4-4b replaces it with a timer-read device term, so V7's device numbers
  are judged with that in mind.
- **Producer-side gap signalling for sparse producers** (§11.5 item 10),
  which Phase 2 deferred to this phase's demux, is not built: no chapter 7
  item planned it. `mrtsdemux` gives sparse pads gaps from program time,
  which a sparse `mralignwatch` drops as before; the muxer's cue routes keep
  Phase 2's consumer-side fill to now − pace.
- **B-20 is closed** with no code change: markers carry GAP | DISCONT, and
  no bus consumer runs `tsdemux` (MpegTsProbe's codec probe aside), so
  nothing drains and flushes at a marker's DISCONT; every reader keys on
  GAP.
- **The comments that still named a deleted mechanism** (the parser
  bypass's "tsdemux already emits one whole PES", the runners' parser
  tables and pad-link notes, the "spliced here" and "same seam" comments,
  `tsHelpers.ts`'s and `busHelpers.ts`'s tsdemux, the player's `sync=false`
  "default", the frozen `ts_timeline` reference's pointers, plugins/README's
  pad-link examples on `tsparse ! tsdemux`) were reworded by p3-21.

## Phase 4 (built 2026-10-26 to 2026-11-10; DEV-P4a and DEV-P4b ran, DEV-P4c1, DEV-P4c2 and DEV-P4d pending) — outputs play as soon as they can; D and the shedder deleted

After Phase 4 no output waits for a playout offset. Every presentation sink
runs `sync=false`: Video Player releases each frame through `mrvideopace` on
the content's own cadence, never before it arrives, and Audio Decoder and
Audio Output (302M) push into a 40 ms prefill and a 100 ms card ring while
their `mrasrc` follows the card's clock read on a timer. Nothing in the chain
drops a buffer for being late (P11): the runners switch QoS and late-drop off
on every sink, decoder and transform, the leaky queues behind decoders are
non-leaky, and the one leaky queue left on an output's path is the bus
ingress backstop, which loses content only at capacity and warns. The playout
offset D, the route-head walk, the playout raises, the rebase and the backlog
shedder are deleted in the engine and both runners, with the settings that
served them (OQ-29, OQ-33). What a stall leaves behind is latency, shown on
every output, and p4-18 plays it back down to the smallest buffer that plays
clean (issue #862). The build: WY1 (patches 0008 and 0009, 2026-10-26), the
early track WE1 and WE2 (p4-1, p4-3a, p4-3b, p4-0, p4-4a, 2026-10-26 and 27),
then on P4 main WM1 (p4-4b, p4-8, p4-7, 2026-11-05 and 06), WM2 (p4-3c, p4-6,
p4-5, 2026-11-06), WM3a (p4-11, p4-12, 2026-11-07 to 09), WM3b (p4-13, p4-14,
2026-11-09 and 10) and WM3c (p4-18, 2026-11-10), with Phase 3's head up to
B-216 merged in (n1; n2, at v2.0.0.102's tag, is still to come) and the side
batches picked (C1 to C3), on the dev Pi 5 with GStreamer 1.28.2. On the boxes: DEV-P4a (2026-10-27, the sink clocks, Weston's
presentation clock, kmssink's returns) and DEV-P4b (2026-10-28, 0008 and
`mrvideopace` on both test boxes). The plan's register rows are B-160 to
B-175 and B-179 (chapter 15.4; B-P4-n = B-(159 + n)), and B-176 for this
documentation pass; B-177 and B-178 are held for the phase review's fixes
(p4-17) and the release gate (p4-16). Phase 4 ships alone as v2.0.0.103 and
its rollback is v2.0.0.102 (the refresh's T34, superseding Q3's "Phases 0–4
as v2.0.0.100": v2.0.0.100 and v2.0.0.101 shipped from the release line, and
Phase 3 ships as v2.0.0.102).

### Play on arrival (chapter 8 part 4.1; the owner's Q1 and Q2)

- **The output strings** (as built, each a vitest snapshot):
  - Video Player: `<bus ingress> ! tee name=vp_ts ! mrtsdemux name=vpdemux
    media=video ! queue name=vp_esq leaky=0 (5 s, tsQueueByteCap) ! <decoder>
    ! videoconvert [! videoscale] [! <subtitle overlay>] ! mrvideopace
    name=vp_pace backlog-queue=vp_esq[ refresh-mhz=<mHz>] ! mrlateness
    name=lat_render ! <sink sync=false qos=false>`, waylandsink with
    `present-every-frame=true` (B-169). The jitter queue sized by Buffer, the
    leaky 1 s ES queue, `sync=true max-lateness=1 s` and `ts-offset` are gone.
  - Audio Decoder: `<bus ingress> ! mrtsdemux media=audio ! queue name=ad_esq
    leaky=0 (5 s) ! <decoder> ! audioconvert ! mrlateness name=lat_render !
    mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink ! … ! queue
    name=prefill min-threshold-time=40 ms ! pulsesink name=sink sync=false
    buffer-time=100000` (B-168).
  - Audio Output (302M): the fan-in's continuation `! mrlateness
    name=lat_render ! audioconvert ! mrasrc name=outasrc device-sink=sink ! …
    [! placement] ! queue name=prefill … ! pulsesink sync=false
    buffer-time=100000` (B-167); B-62's `identity name=live_upstream
    sync=true`, `ts-offset`, `max-lateness` and `slave-method` are gone.
  - `lat_render` sits before `mrasrc` on the audio outputs, where PTS is
    still content time (S4). The 40 ms prefill and the 100 ms ring are engine
    constants (`outputSink.ts`, OQ-31, E7), no setting.
- **Q1 (2026-10-26), "Play on arrival".** The picture never waits for a
  subtitle or an offset: a late subtitle on a Video Player shows from when it
  arrives, its overlay's `cueLate` the cue path's lateness, reported and not
  judged (S36). The player's subtitle wait (p4-6s) is not built and its row
  placeholder B-P4-16 stays unused. The burn-in keeps Phase 3's wait (p3-13).
- **Q2 (2026-10-26), "Skip, resume live".** An output whose display or audio
  device stops skips what it could not play and resumes live, each skip
  counted and warned as a device fault, never lateness: 0008's timeout rule
  and `mrvideopace`'s unpaced pass for a display, `mrasrc`'s device-stall rule
  for a card (below). Recorded consequence (review r0's M11): while a device
  is stopped the output drops input, or commits frames no display shows,
  against the owner's "we never should have packets dropping" (2026-10-08);
  the answer covers device stops only.
- **What a stall costs.** Content held up upstream plays late by the stall's
  length when it comes (S10, Q17): at content rate through the drain's 30 s
  warm-up, then back down at most 0.5 % faster (the latency drain, below), or
  at the next gap (the gap rule, below). Nothing is dropped to catch up.
- **The launch catch-up stays** (B-206, E28): a 302M output's runner skips,
  once, what its inputs' ingress queued before the launch played and, since
  B-167, what its mix queued before its render tap first played (a non-live
  mixer waiting out a connected input that sends nothing), with one INFO
  line ("Caught up at the start: skipped 2.0 s of the mix"). It is not D: its
  line is the launch's first buffer. Without it a stale burst would play late
  for good. The decoder keeps no start backlog and arms none (B-168 F4).
- **An input hole's loss is accepted, not fed** (B-167, B-168; DEV-P4a case
  6; engineering choice for the veto): the card plays the hole as silence,
  the sink realigns behind it and what follows plays at once. On the image's
  PipeWire up to about 100–127 ms after a 300 ms hole is lost as well
  (pipewire-pulse's stale read index), and every underflow steps render
  lateness by −10 to +12 ms where the base sink realigns. Keeping the ring fed
  across a hole would avoid that loss, but a feeder on a 100 ms timer over a
  100 ms ring must push silence ahead of content it cannot tell from a
  delivery stall, and after a realign the ring holds about a segment (the
  prefill is a delay line, not margin: B-167 P2), so a feed would collapse
  the ring's margin to the feeder's timing; that is the trade the veto rests
  on. A stall's length stays as lateness with or without a feed.

### `mrvideopace`: video paced to its display (WI-P4-3, B-161, B-162, B-175; OQ-32)

- **One element, two halves.** `mrts::VideoPace` (`video_pace.{h,cpp}`,
  integer ns, no allocation per frame) decides; `mrvideopace`
  (`gstmrvideopace.cpp`) waits on the element clock and proxies caps,
  allocation and scheduling, so dmabuf passes untouched. Its Python
  reference `py/video_pace.py` came first (OQ-1) and the C++ prints it line
  for line (`mrts_cli pace`; 120 seeded random runs, about 4 in 10 through
  the display rate, and the cases' 1.9 M frames; 22 of 22 mutants told
  apart).
- **The cadence.** Δ_k is the frame's own PTS delta while 0 < Δ_k ≤ min(250
  ms, 4 × nominal) and no GAP or DISCONT came, else the nominal duration;
  r_k = max(a_k, r_(k−1) + Δ_k). A frame never leaves before it arrives nor
  faster than the content's own rate. A GAP, a DISCONT, a step back or a step
  past the threshold collapses the cadence (`gaps-collapsed`), so a backlog
  drains into the gap. A repeated PTS (a decoder holding a decreasing
  timestamp, B-160 F7) takes the nominal.
- **The rate match (S11).** Decimation by an accumulator of the display's
  lag in ns, summed from each frame's own delta (a median would lose a
  source's clock, B-161 D1), held within one frame below 0 and at 0 across a
  collapse (D2), a drop at a whole nominal frame, read on content time only,
  never on releases (D3); always on a measured period, on a nominal one past
  0.05 %, never with none. A dropped frame keeps its slot. A display slower
  than its content by 40 ppm drops 7 frames an hour at 50p and keeps
  release lateness flat; a Pi's pixel clock is not the house clock.
- **The display period (S12, B-175).** `DisplayRate`: the period the sink
  achieves while it sets the pace (pushes each leaving at once on the last
  push's return, windows of at least 10 s, 3 of the last 5 within 0.5 % of
  their median, `achieved-ns`); else the refresh, from 0008's presented
  samples (Δt/Δseq over at least 60 s) or kmssink's returns counted in
  `refresh-mhz`, else in their 25th-percentile interval (B-162 F2); else
  `refresh-mhz` as nominal; else none. A measurement always wins over the
  prior; new caps or a 1 % move of the refresh or the prior measure again.
  The engine passes `refresh-mhz` from `resolveOutputRefreshHz` as the prior
  on every sink (S17).
- **What the sink holds is not lateness** (B-175): a frame that entered
  within 2 ms of the previous push's return (`HELD_NS`) is the sink's wait:
  past its slot it leaves at once, the cadence stays, and it is not `late`.
  While decimating, a held frame more than a display period past its slot
  shows the display behind its own pace: the accumulator drops until it is
  back within a period (`display-behind`). That is Q2's skip for a display
  slower than its stated rate (the Pi 5 box's DSI took about 56.6 of 60.038
  frames a second; kmssink shows one frame per two refreshes).
- **A display that presents nothing** (B-162 F3): while the first sink's
  `display-stats` shows frames not presented or a present timeout, frames
  pass unpaced (`display-presenting` false); at the first read without, a new
  pace starts from the next arrival. With the cadence hold alone each outage
  left the output 1 s later.
- **Seen**: the `mrvideopace` message every 2 s (`released`, `late`,
  `rate-drops`, `gaps-collapsed`, `content-fps-x100`, `refresh-ns`,
  `refresh-source`, `achieved-ns`, `display-behind`, `mean-hold-ns`,
  `present-lateness-ns`, `unpaced`, `display-presenting`, and the drain's
  fields), forwarded by both runners (T11).
- **Engineering choices for the owner's veto:**
  - **The cadence hold** (chapter 8 part 4.2; chapter 13.6). §8 says each
    frame waits only for the display's next refresh; the hold r_k = max(a_k,
    r_(k−1) + Δ_k) keeps video in step with audio that suffered the same
    stall, and in steady state it ratchets the release phase to the latest
    arrival. As built it has two exceptions: a frame the sink kept waiting
    never moves the cadence (B-175), and since p4-18 the hold drains back to
    its target once the arrival that raised it has left a 30 s window, a
    periodic late arrival keeping its hold (B-179). Input lateness still
    steps it.
  - B-162 F1 is not fixed (parity with the reference as committed):
    decimation that turns on mid-stream starts a frame in credit, so a
    display slower than its content plays one frame later than it needs to
    (20 ms at 50p); the fix is one line on both sides.
  - `HELD_NS` is 2 ms: a streaming thread that re-enters the chain later than
    that under load reads a held frame as late and steps the cadence (DEV-P4c1
    measures it on kmssink).
  - B-175's limits: kmssink with the prior falls about 0.5 s behind in its
    first second, then skips it; an achieved period read high stays until new
    caps or a mode change (more drops, not lateness); a display that misses
    refreshes keeps up to one of its frames of backlog; behind a sink measured
    by nothing, held frames no longer raise the cadence.
  - B-169 F5: the cadence hold keeps the worst bunching of bus buffers since
    the start or a gap, so a low-bitrate source on the ingests' 128-packet
    buffers starts up to one buffer's span late (about +230 ms at 0.57
    Mbit/s), until the drain takes it back (B-179); Pace hold shows it.

### waylandsink presents every frame: Yocto patch 0008 (WI-P4-2, B-163)

- **`present-every-frame`** (default false, 0007's path unchanged): set, the
  sink waits before it takes `render_lock` until the window's last commit was
  presented (its frame callback), outside every lock, so neither of 0007's two
  field deadlocks returns. A wait that reaches 1 s commits the frame and
  counts `present-timeouts`; until the next frame callback frames go at once,
  counted `not-presented` (S13, Q2): a display switched off neither plays at
  1 fps nor leaves a backlog. A flush returns FLUSHING; a pause waits for
  PLAYING and goes on with the frame.
- **`display-stats`** (`wayland-display-stats`, guint64 fields): `presented`,
  `presented-seq` (the MSC), `discarded`, `replaced`, `present-timeouts`,
  `not-presented`, `refresh-ns` (Δt/Δseq over at least 60 s), the last
  presentation and its running time, `commit-to-present-ns` and
  `clock-monotonic`; present lateness is `last-presented-ns` − (base time +
  `last-running-time`), the runners' base time 0.
- **Bench numbers** (WY1's headless test compositor; DEV-P4a and DEV-P4b on
  the boxes): 10 frames inside one refresh all shown with the property set
  (0007 alone showed 1 or 2: the compositor discarded 6 to 9, which the
  sink's own counts never saw, B-160 F3); Weston's `wp_presentation` is
  CLOCK_MONOTONIC with hardware vsync on both test boxes (Pi 4 1080p50
  commit-to-present 33 ms; Pi 5 DSI 60.038 Hz, 0 missed in 3,601 frames); on
  the Pi 4 box H.264 and HEVC 1080p50 for 30 min each replaced 0 and
  discarded 0, the display −7.30 and −7.80 ppm against house time, 50
  flush/state cycles passed; the Pi 5 box's panel runs +11.4 ppm slow, its
  steady commit-to-present 15.5 ms at 50p and about 24 ms at 60p HEVC; a 1 h
  restart stress ran 1,982 cycles with no failure; Weston's output off 30 s
  left no wedge in 4 of 4, lateness after it not later than before (the
  cadence hold restarting gave 81–91 ms lower in 3 of 4: T31's criterion
  reads "not later than before, within one frame"). p4-1 case 9's
  commit-to-present bound is two refreshes (1.5 failed 2 of 5 on both boxes,
  T30).
- **Engineering calls for the veto:** the pause rule; the refresh re-based
  once per 60 s window and after a change or a 1 s gap; the 1/16 average; the
  feedback and `display-stats` kept with the property off; a window's counters
  living as long as the window; the 1 s timeout a constant.

### `mrasrc` follows its card on a timer (WI-P4-4, B-165, B-166; C-6)

- **The device term on a timer.** Phase 3's custom-slaving callback is gone
  with `sync=true` (S32: both sinks `sync=false` in the commit that deleted
  it, so no commit carries two evidence paths). A thread of `mrasrc`'s waits
  on a 100 ms periodic id of the element clock and reads the card's own time
  (`gst_audio_clock_get_time` of the named `device-sink`'s provided clock, in
  the frame of its write positions), then house time. Reads run only from the
  first buffer the sink renders after it acquired its ring to the ring's
  release (a read during the acquire killed the stream in 14 of 15 starts on
  the Pi 4 box, DEV-P4a); the timer stops at PLAYING to PAUSED and re-arms at
  the next render. The reference `py/asrc_device_ref.py` came first and the
  C++ agrees exactly (`mrts_cli asrc-device`; the ratio 0 ppb apart at every
  read of 464 k lines).
- **The lock** is `mrts::ClockLock` itself (device time against house time):
  a 1000-bucket window and a 1200 s loop (`asrc_device_lock_config`; the
  plan's 300 buckets and 60 s read the clock's interpolation as 5–20 ppm,
  B-165 D1), `slew_track_ppm` 1000, a relock past 50 ms on two fed reads or
  ClockLock's envelope step, the rate kept, then a 15 s settle; a restart
  relocks the same way. A read whose clock moved less than a tenth of house
  time is flat and never fed. Ratio = (1 + ε_in)/(1 + ε_dev) − 1, clamped to
  ±1,000 ppm, no phase term.
- **The traces' noise** (DEV-P4a, four 1 h sink clock traces, the fixtures
  `tests/fixtures/clock/sink-clock-*.jsonl`): pulsesink's clock is
  `pa_stream_get_time`, interpolated, with 4–7 ms corrections about every
  1.5 s, flat for 100–500 ms at a start and 25–42 ms behind within 5 s on the
  null sinks; it runs on through a 300 ms hole and a 1 s underrun; rates KT
  USB −135 ppm, HDMI +9 ppm, null about 0. The chosen lock holds all four
  within 1 ppm of their own slopes from 1000 s; a sub-50 ms slip reads as
  rate (21 and 40 ms slips move it 31 and 60 ppm for about 20 min, B-166 F6).
- **The device-stall rule (Q2).** Read on the render, never the clock (a
  removed PipeWire node blocked the render while the clock ran on, B-165
  D4): `device-stalled` when for 1 s the sink took nothing while more than
  100 ms waited past the prefill; the timer then flushes downstream (FLUSH
  from `mrasrc`'s src pad unblocks the sink) and keeps flushing every 500 ms;
  `device-resumed` once the sink took 200 ms since a flush, with one more
  flush, so live input plays. Counted: `device-stalls` and the frames
  dropped. The prefill makes the rule live (B-166 F5); the 200 ms resume holds
  for the 100 ms ring only (F4).
- **Render lateness** is now less the content time of the sample at the
  card's position, from a map of each buffer's write position to its content
  time (B-165 D5): exact wherever a sample is heard, and a buffer written
  wholly behind the device's position stays out. Its limit is the device's
  own latency behind the server's read index.
- **Deleted**: `AsrcDeviceLock`, the callback, `device-resync` and
  `device-resyncs` (no alignment on a `sync=false` sink); there is no
  underrun count from realigns (a realign is no underrun on the Pi 5). B-148's
  device timeline is kept on the timer lock (A1: every relock recalibrates).
  One Python ClockLock remains (`clock_lock.py`; `asrc_bypass_ref.py` imports
  it, T10).
- **Engineering choices for the veto:** the timer's stop at PLAYING to
  PAUSED rather than PAUSED to READY; new caps at another rate as a new
  device; the settle, the flat rule and the restart relock; 1000 as the fit
  acceptance (the capture lock's 20 ppm let a short fit after a restart
  replace a good rate, 125–286 ppm off).

### The queue table (chapter 8 part 4.4, as built)

| Job | Queue | Size | When full |
|---|---|---|---|
| Capacity: hold a stall's backlog until it drains or a gap | `vp_esq`, `ad_esq` (compressed, after the demux); the aligners' FIFOs (Phase 2) | 5 s, `tsQueueByteCap(5000)` (ADR-0015), `leaky=0` | Blocks upstream; the bus ingress fills next; `queue-full` "… holding <ms> ms at capacity — the input queue loses next" |
| Capacity backstop: keep a stuck consumer from wedging its producer | The bus ingress (`buildBusSrc`) on every consumer; the producer's fan-out branch on every edge (the runners' own, in no module string) | 5 s, 40 MB, `leaky=2` (OQ-30) | Leaks from the head; `queue-full` "Queue <input> full at <ms> ms — content lost at capacity"; a resource fault, not a lateness policy |
| Prefill | `prefill` (both audio outputs) | `min-threshold-time` 40 ms, 1 s | A delay line, not ring margin: it releases only what is above 40 ms (B-167 P2); behind a stall it holds the backlog the decoder's path leaves |
| Device ring | pulsesink `buffer-time` | 100 ms | Back-pressure into the prefill |
| Decode-ahead | the Video Transcoder's raw-frame buffer after its decoder, its decoder-pool queues | Buffer (raw, floored at 100 ms); 4 buffers | Blocks the shared decode: every rendition falls behind with a slow encoder (B-173, E8) |

- **The image's patched queue (B-68)**: a drained queue starts its level
  afresh, so a backstop that drained after a stall does not read its old
  level as fullness, and the prefill holds its 40 ms again after it drains.
  "About 10 s of stall before content is lost" (5 s capacity plus 5 s
  backstop) holds on that queue only (S35); measured as built, the bus
  ingress loses at capacity about 6 s into a stall on the 302M single arm and
  10–11 s on the others (B-179).
- **B-91's pages and B-94's cap**: a stalled consumer pins up to its ingress'
  40 MB of payload on the producer, each copy in whole pages; patch 0009
  (WY1) gives a stall's pool high-water mark back once the consumer drains
  (the producer's fds within steady + 64 and its Pss_Shmem within steady + 2
  MiB about 10 s after the drain, B-170's recovery read).
- The ingest-side queues are exempt by place (SRT and RIST Input's `ingestq`,
  B-182; the Video Encoder's two capture queues; the Audio Encoder's 50 ms
  queue): they sit inside an ingest before its bus tee.

### The runner glue (WI-P4-5, B-170)

- **The no-late-drop hook**, in both runners, always on: on every element of
  every pipeline and every element added later (`deep-element-added`: a
  `decodebin3`'s decoder, autovideosink's child, a live input's branch), a
  `GstBaseSink` gets `qos=false` and `max-lateness=-1`, and a
  `GstVideoDecoder`, `GstAudioDecoder` or `GstBaseTransform` with a writable
  `qos` gets `qos=false`; one log line at start (`no-late-drop: …`) and one
  per later element changed. B-160's F1 is why it reaches the decoders: given
  a QoS event, gst-libav's hurry-up skips non-reference frames whatever the
  decoder's `qos` says, so no QoS event may reach an avdec.
- **The queue watch** (B-182's shed count grown, E29): every GstQueue whose
  `leaky` is not 0, and those named `vp_esq`, `ad_esq` and `prefill`, counts
  its `overrun`s into episodes (1 s quiet ends one; reported once open at
  10 s, at its end and at a stop), one `queue_overrun` an episode naming the
  bus input upstream (the first `unixfdsrc` through sink and ghost pads), its
  highest level kept per episode. GstQueue only, since `queue2` has neither
  `overrun` nor `leaky` (S14).

### The R10 checklist and the no-late-drop lint (WI-P4-13 with WI-P4-10, B-173; OQ-30)

| Late-drop behaviour at the Phase 3 head | Fate |
|---|---|
| Video sink `max-lateness=1 s` | Removed: sinks `sync=false`; the hook sets −1 on every base sink |
| Video sink QoS; decoder, `videoconvert` and `videoscale` QoS | Switched off: `qos=false` in the sink strings and the hook on every sink, decoder and transform |
| waylandsink's staged-slot replace | Removed: 0008's `present-every-frame=true` |
| Audio sink late-sample skipping | Removed: both audio outputs' sinks `sync=false` |
| The backlog shedder | Removed (B-171) |
| The video ES queue (`leaky=2`, 1 s) | Switched off: `vp_esq` `leaky=0`, 5 s, watched |
| The bus ingress queue on every consumer; the producer's fan-out branch | Kept as the capacity backstop, alarmed (`queue-full`; OQ-30) |
| The Video Transcoder's raw-frame buffer (`leaky=2` of Buffer; missed by chapter 8 part 3.6, S16) and its decoder-pool queues | Switched off: `buildBackpressureQueue(bufferMs)` and `leaky=0`; `buildLeakyQueue` deleted |
| The keyframe gate | Exempt: decode safety |
| The ingest-side queues (`ingestq`, the Video Encoder's capture queues, the Audio Encoder's encoder queue) | Exempt: inside an ingest, before its bus tee |
| The diagnostic taps (Video Player's probe and resume taps, Teletext Subtitles' and MPEG-TS IP Input's probe taps) | Exempt: they carry no content to an output |
| AES67 Output's `udpsink sync=true max-lateness=-1 ts-offset=<senderLatencyMs>` | Kept (C-9, WI-P4-10): the payloader's pacing against the house clock, not a playout offset |

- **The lint** (`noLateDrop.test.ts`) builds every module with a launch
  string through its own `buildPipeline` (24 modules in 45 strings, live
  inputs and pad-added branches included) and fails a leaky queue outside the
  whitelist (by shape: a probe or resume tap, `ingestq`, the bus ingress
  backstop, a capture module's queue before its mux), `max-lateness` other
  than −1, `qos=true`, `sync=true` on any sink, a presentation sink without an
  explicit `sync=false`, `ts-offset` on any sink, `drop=true` on an appsink
  that is no tap, and `silent=true` on a watched queue. AES67 Output is the
  only module with an explicit `sync=true` or a `ts-offset`; egress sinks that
  set no `sync=` (RIST Output's `mrristsink`) run GStreamer's default
  `sync=true`, which the lint accepts (no presentation sink) and the hook
  makes harmless (`max-lateness=-1`).
- **Its limit**: the lint builds one configuration per module variant;
  a branch that appears only under other settings (the player's subtitle
  overlay input, a muxer with more inputs, other audio-decoder codecs) is not
  built, so a hand-written leaky queue there would escape until that variant
  is added. Every such branch uses the shared helpers today; a module that
  gains a configuration-only branch adds its variant.
- A drain drop (below) is no late drop: the pace's decimation is a rate
  match before the sink, and `backlog-queue` is no sink property.

### Lateness at the outputs (WI-P4-12, B-172; OQ-34)

- **Render lateness** is the presentation's own reading: `mrvideopace`'s
  `present-lateness-ns` (0008's presented time, else the kept frame plus a
  period), else `mrasrc`'s `render-lateness-ns`, else Phase 0's λ(`lat_render`)
  plus a stand-in. **Device latency** = Render lateness − λ(`lat_render`). The
  Presentation delay row is gone (there is no D).
- **Rows**: Video Player's Rate match ("50.00 fps → 50.00 Hz measured, 0
  drops/min"), Late releases and Pace hold; the audio outputs' Device relocks
  and Device stalls beside Phase 3's Device clock (S9); a Lateness trend on
  every output that renders (the slope over 180 s, "measuring" until 3 min
  ran with no gap), with no alarm and no setting: OQ-34's `capacity` alarm and
  its setting are not built.
- **Warnings, which only warn**: `queue-full` (two texts by `leaky`, S15),
  `display-not-presenting` ("Display not presenting (output off?)", from the
  pace's `display-presenting`, S31) and `device-stalled` ("Audio device
  stalled — nothing plays until it takes audio again, then it plays live"),
  which takes the place of the 302M output's late "Plays nothing" (T24).

### The output conformance harness (WI-P4-14 with WI-P4-9's scenario, B-174)

- The outputs' real strings (`fixtures/output/pipelines.json`, written from
  the modules) on test sinks that model 0008 (`mrtestvideosink`) and a
  clocked card (`mrtestaudiosink`), or the box's own under `MR_GATE=1`, fed at
  real time on the house clock, judged by their elements' own messages in
  both runners (`output_conformance_test.py`): a stall's backlog at content
  rate, recovery at a gap (T8's lone stale PES among them), A/V after a muxer
  (8–11 ms against V-P4-5's 45), video only, 50p on 60 Hz and 60p on 50 Hz
  with B-175's live cap, a slow display (S11), the PES wrap in a time
  namespace, a 302M card 100 ppm fast, capacity, both devices stopped 3 s,
  the stop under backpressure (MR-041, T26) and the burn-in's late cues
  (S29), plus p4-18's two drain scenarios. `gst_output_backlog_test.py`
  replaces the latency ratchet suite. Two self-mutants (`vp_esq` leaky; a
  pace releasing at arrival) each fail.
- **MR-041 on the outputs**: no stop reached the engine's kill (Video Player
  5.4–5.6 s with `vp_esq` full, Audio Decoder 6.0 s, Audio Output (302M)
  3–15 ms, the burn-in 0.4 s); every output's bus ingress is leaky, so its
  source thread is never the one held.
- **Read with care**: `scn-out-rate-drift`'s CI arm (40 ppm over 27 s) pins
  "no drop, refresh measured"; it is not S11's proof, which is V-P4-1's 1 h on
  a box. The `MR_GATE=1` arms pin the player's explicit software decoder, so
  `scn-out-capacity` on the Pi 4 box is a software-decode number only; those
  arms have never run, and DEV-P4c2 calibrates them.
- **Found and open** (B-174 F1, F2, F4–F9; for the bug log and p4-17): the
  decoder's prefill full for good after an input stall, with a "prefill
  holding …" text while `ad_esq` has room; the player's probe tap overrunning
  once after a gap and reading as content lost; B-175's cap set live never
  measured; a 0.2 % slow display's first drop 18 s after the measurement; a
  consumer holding a 5 s backlog silencing its edge's tap; the 302M device
  term engaging 45–50 s in, then one +15 to +22 ms step with a card resync;
  a false "prefill holding 2005 ms" at a content gap.

### The latency drain (WI-P4-18, B-179; issue #862)

- **The owner's requirement and answers (9 Nov 2026).** An output's latency
  may grow while the box cannot keep up, never grows without limit, and comes
  back down to the smallest buffer that plays with quality once it can. Audio
  catches up at 0.5 %, with no larger step (8.6 cents); video skips at most 1
  frame in 200 while catching up, on a display at the content rate, counted
  as drain drops; the buffer may probe below today's.
- **Where.** Only the two device elements hold content at the content rate
  (the card behind `mrasrc`, the display behind `mrvideopace`), so the drain
  is in them, in the one resampler or pacer each already has: no new element,
  setting, flag or alarm. The aligners' pace already falls by itself (B-82);
  transcoders, the audio transcoder and the TS, SRT and RIST outputs are
  unpaced and drain at CPU speed, so #862's field reading on those legs is
  answered by construction, not diagnosed. The HLS Player's pacer stays out
  (a follow-up for #862's inputs).
- **The law** (`mrts::DrainServo`; its reference `py/drain_servo.py` first):
  the slack is content that was ready before it was needed (audio: the frames
  `mrasrc` pushed that the card has not played, lowest just before each push,
  less the prefill's delay; video: a frame's drained slot less its arrival,
  plus the 30 s minimum of `vp_esq`'s level); the trough F is its minimum over
  three 10 s buckets (CoDel's standing-queue test, used to speed up, never to
  drop). E = F − margin; δ = clamp(E / 30 s, 0, 0.5 %), slewed at 0.05 %/s,
  engaged at 20 ms and let go at 5 ms; nothing drains until 30 s were sampled
  after a window clear, nor while an audio starvation runs or for 30 s after.
- **The learned margin.** It starts at its floor (audio 20 ms, video 1
  frame), ceiling 500 ms. An audio starvation (the sink's own underflow, or
  the slack under −30 ms on two ticks) of at most 250 ms raises it whatever
  the drain did; longer is an outage, counted, no raise. A late video release
  raises it only while δ > 0 or within 30 s after; a release under a quarter
  frame late is jitter, one more than 250 ms late an outage. A raise sets L =
  the margin that underran and m = min(500 ms, max(2L, L + 20 ms)); m falls 5
  ms every 10 min without a raise, never under the floor or L + 10 ms, and L
  falls 5 ms an hour to floor − 10 ms: a raise costs about 2 h, and a need
  that stays re-probes about every 2 h.
- **The actuators.** Audio: `mrasrc` consumes (1 + ε_dev)(1 + δ) faster in
  its resampler and house-rate counter, so render lateness stays exact and no
  sample is dropped. Video: `VideoPace` runs its cadence on Δ / (1 + δ); a
  display with headroom loses repeats only (50p on 60 Hz: no drop), one at the
  content rate decimates δ of the frames (19 of 4,000 at 50p on 50 Hz),
  counted as `drain-drops` apart from rate drops by a shadow lag at δ = 0. No
  video drain without a display rate.
- **A/V groups by common origin** (`drainGroups.ts`, the engine every 2 s):
  a running device output's origins are the modules its bus path starts from
  (through transcoders, audio transcoders and 302M mixers; a PipeWire edge
  starts an origin of its own); Video Players sharing an origin form a group,
  each audio output joins the one group its origins touch (a 302M mixer of a
  gate feed and a mic joins the gate's), and one touching two groups joins
  neither, logged once ("in sync with neither … two programmes");
  audio-only components are not grouped; per box. Each member publishes its
  target (render lateness less its excess, never above now), and the group's
  P = the largest goes to every member as `group-target-ns`: a member above
  drains to it, one below plays up to 0.5 % slower to rise to it, clamped
  continuously at 1 s above its own target, so every member ends within 45 ms.
- **Bounds.** While the box cannot keep up nothing is early, nothing drains
  and lateness grows until the path's non-leaky queues fill; the leaky bus
  ingress then loses at capacity with `queue-full` (the queue table above).
- **Seen**: Latency target ("95 ms (measured), now 2.41 s · draining at 0.50 %
  (about 8 min) · in sync with Video Player"), Drained, Buffer underruns,
  Rate match's drain drops, the trend's "— draining to its target"; INFO lines
  at a drain's start and end.
- **Engineering choices for the owner's veto** (E21–E23 and the design's
  owner-level items): any short audio dropout raises the margin, which decays
  5 ms/h (a source with a recurring short dip gets one re-probe dropout about
  every 2 h; 5 ms per 4 h would make it 8 h); a late video frame raises the
  margin only while draining or within 30 s after; grouping by common origin,
  audio-only outputs not grouped; the 1 s rise cap; a member of two programmes
  joins neither; a restarted output rises to its group's latency on purpose
  (a member below the target plays up to 0.5 % slower: audio pitch down by up
  to 8.6 cents, video a repeated refresh); a starvation is the sink's own
  underflow; the audio trough read just before each push; the 30 s after a
  starvation or outage publishing the render lateness.
- **For the owner's veto, the as-built two-origin Video Player rule**: a
  Video Player with two origins (a muxer combining gate A's video with gate
  B's audio) that touches exactly one existing group joins it, its other
  origin left out; the design (its r3 review carry) had it form its own
  group. Neither chains two groups; as built, that player is held to gate A's
  latency. The owner has been asked.

### The gap rule (OQ-32)

At a content gap each output lets its lateness fall by up to the gap's
length on its own (`mrvideopace` collapses its cadence; `mrasrc` opens a new
epoch, B-148's A1), even when only one stream of a muxed programme has the
gap, so A/V can shift by up to min(backlog, gap) (decided 2026-10-12, per
output). Since p4-18 a grouped member's drain then takes the group's common
target again, so such a shift lasts until the group's members drain or rise
to P (at most 0.5 % a second of the difference).

### As-built deviations, by work item

Each item recorded these against its brief for the owner's veto; the
sections above give the reasons, the register rows the details.

- **p4-1** (WI-P4-1): CI cases 1 to 5 and gate cases 6 to 10, with the GAP,
  `overrun`, clock and device-stop pins added (E18); F1, gst-libav's
  hurry-up under `qos=false` (B-160).
- **p4-3a, p4-3b** (WI-P4-3): the accumulator by the frame's own delta,
  floored a frame below 0 (D1, D2, D7); `set_display(ns, source)`; the
  element's unpaced pass for a display not presenting (F3) and the returns'
  25th-percentile base (F2) (B-161, B-162).
- **p4-3c** (E26): the achieved period, the sink's wait, the behind skip
  (B-175).
- **p4-2** (WI-P4-2): the pause rule, the refresh re-basing (B-163).
- **p4-0**: v2.0.0.99's MPEG-2 AAC classifier ported; FF9 not (B-164),
  though it reached this line as the release line's B-184 and p4-7 and p4-8
  deleted it (MR-011 closed).
- **p4-4a, p4-4b** (WI-P4-4): D1 to D6 of B-165; the timer stopping at
  PLAYING to PAUSED; `device-resync` deleted; no underrun count (B-166).
- **p4-8, p4-7** (WI-P4-8, WI-P4-7): the render catch-up (B-167); the hole's
  loss accepted on both outputs (B-167, B-168).
- **p4-6** (WI-P4-6): `autovideosink sync=false` (F1); `renderWatch.pace`
  (F2); the KMS driver named; restarts backed off to 30 s (B-169).
- **p4-5** (WI-P4-5): one watch with B-182's episode rule (B-170).
- **p4-11** (WI-P4-11): the guard test; `contentLatenessMs` gone with the
  decay; the engine's tests type-checked (B-171).
- **p4-12** (WI-P4-12): no alarm and no setting for the trend; Pace hold
  added (B-172).
- **p4-13** (WI-P4-13): the whitelist by shape; the stricter
  presentation-sink rule; the ingests linted too (B-173).
- **p4-14** (WI-P4-14): T8's half-wrap outage left at element level; the
  stale-PES arm waiting on the owner's p3-23 veto (B-174).
- **p4-18** (WI-P4-18): margins from their floors; the starvation as the
  sink's own; the two-origin Video Player rule (B-179).

### What this phase supersedes

- **ADR-0005**: decision 1's `sync=true` presentation against a playout
  budget and its "never drop on lateness" amendment (nothing drops late now,
  and there is no budget to raise); decision 4's mechanism, which Phase 2
  superseded in principle and which is now deleted; Stage 3a whole; the
  AES67 RX's route-head `playoutOffsetMs`; Stage 3c whole (the ratchet, the
  shedder, the raise and the rebase; `gst_latency_ratchet_test.py` replaced
  by `gst_output_backlog_test.py`); the 302M output leg's D, trim and
  shedder; Stage 3f's two guards that ran where the shedder was armed; the
  house-timeline note's "a route through a transcoder needs a playout offset
  that covers decode + encode" (the hop's transit is lateness, shown).
- **ADR-0008**: the 2026-09-03 addendum's contract-paced sink (`sync=true
  ts-offset=D+trim`, the shedder, the live D push, `lipSyncMs`) and Phase 3's
  custom slaving; Phase 2's `identity name=live_upstream`.
- **ADR-0016**: "independent of playout offset D" (there is none); a late
  cue on a Video Player shows from when it arrives (Q1).
- **ADR-0022**: the shared keys are `pcmBitDepth` and `lcpSortOrder`;
  `playoutOffsetMs` is gone from every manifest.
- **ADR-0015**: `buildLeakyQueue` is deleted; `buildBackpressureQueue` alone
  defaults to `maxBytes = 0`.
- **This ADR's earlier sections.** Phase 0's Presentation delay row and
  `renderMs = max(λ, D) + device` are gone; Phase 3's device term on the
  custom-slaving callback runs on a timer, and its `device-resync` is
  deleted; Phase 3's "D, the trim and the shedder stay until Phase 4" is
  done.

### Deleted in this phase

`playoutOffset.ts`, `playoutReanchor.ts`, `playoutReanchorState.ts`,
`playoutReanchorText.ts`, `backlogShed.ts`, `routing/PlayoutRaises.ts`,
`playoutDecay.ts`, `playoutSteps.ts`, `routing/testing/playoutRoute.ts`,
`backlog_shed.py` and `backlog_shed.{cpp,h}` with their tests (23 files,
7,133 lines, B-171); the 302M output's `audio302mTiming.ts` and FF9's
`timelineSettleRestart.ts` in both audio outputs (B-167, B-168);
`MediaRouter`'s head walk and raise surface, the `onRoutePlayout*` and
`onPlayoutLegOffset` hooks, `EngineConfig.playoutOffsetMs` and
`.playoutReanchor`, `MR_PLAYOUT_OFFSET_MS` and `MR_PLAYOUT_REANCHOR`,
`PipelineDescription.backlogShed`, the `playout` status section, the
re-anchor badge and warnings, `LatenessReporter.contentLatenessMs`; in the
runners the shedder (619 lines of Python, 850 of C++), `_reclose_keyframe_gate`
and `gate_kf::reclose`; `shed_watch` (grown into `queue_watch`, B-170);
`AsrcDeviceLock`, the custom-slaving callback, `SLAVE_METHOD_CUSTOM`,
`device-resync`/`device-resyncs` (B-166); B-62's `live_upstream` identity;
`buildLeakyQueue` (B-173); `gst_backlog_shed_test.py`,
`gst_latency_ratchet_test.py`, `backlog_shed_test.py` and the protocol cases
N, PW, RA and `test_shed_refusals`; the settings Playout Offset (SRT Input,
RIST Input, MPEG-TS IP Input, AES67 Input, TS Splitter), Lip-Sync Trim (Video
Player, Audio Output (302M)), Sync Trim, Buffer, Sink Buffer and Low-Latency
Sync (Audio Decoder), Sync and Buffer (Video Player), their stored values
ignored (OQ-29, OQ-33), held absent by `removedTimingSettings.test.ts`.

### Open at the end of the build

- **The device rounds.** Ran: DEV-P4a and DEV-P4b (above). **Still to run**,
  on the pre-release image and the v2.0.0.103 candidate: DEV-P4c1 (V-P4-1 on a
  seamless source, V-P4-2, V-P4-4 on both outputs, V-P4-5 to V-P4-7, V-P4-10,
  MR-029's PipeWire drill, MR-019's quantum check, the mode changes, kmssink
  with Weston stopped through the player's form, `HELD_NS` under load,
  DEV-P4b's leftovers, T31's output-off check); DEV-P4c2 (V-P4-3, V-P4-8,
  V-P4-9, V-P4-12's drain on both boxes, the `MR_GATE=1` harness arms); DEV-P4d
  after p4-17; then the v2.0.0.103 gate (p4-16, B-178), V-P4-11 the rollback
  to v2.0.0.102. Nothing of WM1 to WM3c has been on a box.
- **The phase review and its fixes** (p4-17, B-177): a Fable review of every
  Phase 4 item against chapter 8 and the execution plan.
- **The prefill's 40 ms** (OQ-31: revisited from V-P4-4's data before
  release): a GstQueue's `min-threshold-time` is a delay line, so the 40 ms
  adds latency and no ring margin; DEV-P4c1 measures the sink's fill and the
  underrun rate at a 2048 quantum (MR-019, T27), then the owner decides
  whether the 40 ms stays or the margin is made real at the sink.
- **For the owner**: the engineering choices of rows B-160 to B-175 and
  B-179, each recorded for the veto, and the items marked above (the cadence
  hold, the two-origin Video Player rule, the drain's owner-level items);
  p3-23's stale-PES veto, which p4-14's `scn-out-gap-recovers` inherits.
- **Found, not fixed** (their rows): B-174's harness findings; B-162 F1;
  B-172's leaky queue-full text naming the queue, not the input, on a
  multi-input module whose `unixfdsrc` is auto-named, and a `device-stalled`
  before the first `mrasrc-stats` dropped; a live input whose tail pushes
  straight into a mixer never finishing `bus_input_remove` (B-170, rigs only:
  the modules' branches end in `mralignwatch`); MR-041 on modules other than
  outputs.
