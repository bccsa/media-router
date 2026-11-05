# ADR-0025: Router ↔ manager sync — negotiated state patches; an outage merges, never reverts

- **State patches.** A router sends its module runtime state as leaf JSON
  Patch ops (`statePatch { seq, ops }`) instead of whole module states, but
  only after the manager's `hello { features: ['statePatch'] }`. A gap in
  `seq` makes the manager ask for a resync; a full `state` snapshot still goes
  out every 60 s as a backstop. The manager accepts both for as long as any
  router sends `state`, diffing whole states itself.
- **Tagged config pushes.** A config push carries `_push.reason`
  (`connect` | `activate`). On `connect` the router applies only the
  difference to its running modules through its patch router: live values at
  once, modules and connections added or removed live, non-live changes
  flagged `pendingRestart` — never restarted automatically.
- **Outage journal.** While its manager link is down, a router records in
  memory every change it makes to its own config — operator writes and plugin
  auto-writes — plus run-state changes. On reconnect it lays the journal over
  the pushed config (the on-site value wins), applies the difference, then
  replays the journal to the manager as a guaranteed patch; its
  `engineRunningState` carries `localChange` so the manager adopts a local
  Start/Stop instead of reverting it. The manager's structure wins: entries
  for modules that no longer exist, or from before a profile switch, are
  dropped and logged.
- **Delivery.** Local writes and plugin auto-writes reach the manager with
  guaranteed delivery. System stats and device polling run whether or not the
  manager is connected.
- **No saved config.** A rebooted router waits for the manager, as before.
- **Details fixed in implementation (2026-09-28).** The journal also covers
  the window between reconnect and the connect push being merged, so a write
  in that window is not reverted by the older push. A journal without a known
  profile (nothing pushed since boot) is dropped. A plugin auto-write also
  updates the router's own config, LCP and tree, not only the manager's.
- **Rollback applies the difference (amended 2026-09-29).** Rolling back the
  active profile sends the router only the difference, through the manager's
  `PatchRouter` like any edit, never a rebuild, so restart-required settings
  stay pending (UR-MGR-006c). Old routers apply it too: they already take
  manager patches. `diffConfig` lives in shared-types for both ends.
- **A link back on the session the manager kept (amended 2026-11-04, #857).**
  A router gives its link up after about 5 s of silence, the manager only
  after about 8 s (the client-first keepalive asymmetry, ADR-0023), so a
  shorter drop, or one in the manager-to-router direction only, ends on the
  session the manager kept: it sees no new connection, and no `hello` and no
  connect push follow. The router knows it from dgram-comms (`connected { resumed }`:
  every path was down and the server re-acked the session it held). It then
  sends its journal up at once and goes live, and keeps `statePatch`; a
  session that dropped before its own push was merged still waits for it.
  Before this the router waited for a push that never came and journaled
  every on-site change until the next real reconnect, and the manager's
  dashboards and routing editor stayed on the old values. A change the
  manager had not acked when the link dropped goes back into the journal
  (guaranteed sends take an ack callback), so one made in the seconds before
  the router noticed the drop is not lost. A replay the manager already had
  is harmless: on-site ops are leaf values and id-path removes. Engine only;
  no manager or protocol change, so deploy order does not matter.
- **The difference is taken as the modules start (amended 2026-11-05,
  MR-035).** A module's start fills each setting the manager never stored
  with its schema default in the router's own config, and the manager never
  hears of it. A connect push compares both configs as their modules start
  (the start's check on a copy of each), so such a default is no difference:
  no remove, no 'restart pending', no live re-apply. Engine only.

## Why

GATE01's uplink carried ~70 kB/s of whole-module states (2026-09-28). Before
this, local edits made during an outage were dropped, and a reconnect swapped
the router's in-memory config without touching running modules — the audio
kept the local value while the display and stored config reverted. Engine
dashboards must keep working while the manager link is down. A saved config
copy on the router was rejected: stale configs on rebooted or moved boxes.

## Consequences

- The journal is memory-only: an outage that includes a reboot loses the
  on-site edits.
- Deploy order does not matter: a new router keeps sending `state` to an old
  manager, and an old manager ignores `_push` and `localChange`.
