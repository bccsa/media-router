# Release notes

Operator-facing notes per release, newest first. What changed on the box,
what to expect, what to do. Engineering detail is in `docs/adr/`.

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
