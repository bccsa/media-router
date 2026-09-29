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
