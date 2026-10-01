# ADR-0028: Interlocks are kept on the router

An interlock (exclusive mute: at most one member's `audioEnabled` true) is
enforced by the router that runs the modules, for every write from any
source — the manager (routing view, settings, dashboards through it), the
router tree (its own dashboards, button scripts), the LCP and plugin
auto-writes — and the router reports the result to every listener. Decided
with the user on 2026-10-01.

- **In the same apply.** An unmute's mutes go before it in one batch
  (`withInterlockMutes`, shared-types `interlockMutes.ts`), so there is never a
  moment with two members live, however slow the manager link is.
- **Always one at most.** After every apply, and on every config the manager
  pushes (before it runs), any group still with several live members keeps
  the first in its `members` order (`interlockRepairs`): a batch unmuting two,
  a group created or its members changed, a config saved before the group.
- **Reported.** Router tree viewers and the LCP get the mutes at once. The
  manager gets every member of each touched group as it now stands
  (`groupStates`), so whatever crosses on a slow link, the router's last
  report wins. During a manager outage this goes in the outage journal
  (ADR-0025) like any local change.
- **Older routers.** A router announces `interlocks` in `features` (system
  stats, every sample). For one that doesn't, or before its first stats, the
  manager still applies the same rules itself (`patchRules.ts`, the repair on
  connect); both together reach the same result.

## Why

The manager used to do it: an unmute crossed to the manager and back before
the other members muted. On a router with a poor link to its manager that
took long — and with the manager unreachable it did not happen at all — while
the router is where the audio is.
