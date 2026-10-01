# ADR-0027: Button scripts run on the tree server the page is connected to

A dashboard button (ADR-0026) may do several things: actions and waits, and
where wanted blocks with logic — if/else, repeat, repeat until, wait until,
values read at run time, compare, and/or/not, arithmetic, stop. Decided with
the user on 2026-09-30. One editor offers every block: a plain list is just a
script without logic, so the first cut's Simple/Advanced switch (which could
not switch back once logic was used) was dropped the same day; an older
stored `mode` is ignored.

- **Where it runs.** On the server the dashboard page talks to, not in the
  browser: the router's own page (`:8081/d/`) → the router; a manager page →
  the manager, for manager dashboards and for router dashboards seen through
  it. A closed tab or a dropped tablet link cannot cut a run in half, a press
  is one run, and it works on site with the manager down.
- **Data, not code.** A script is a block tree stored in the widget
  (`script: { steps, timeoutS? }`), never evaluated as code. One
  interpreter in `shared-types` (`runScript`, zod-free) runs it against the
  server's own tree: every write goes through the checks a browser write gets
  (`routerWrites` / `TreeWrites`), every call through `routerCall` /
  `TreeCalls` (restart, reset, reboot only).
- **Limits.** A run stops at its first failed step, at a Stop block, on a
  Stop from any viewer, or after its time limit (60 s by default, set per
  button, up to 3600 s); at most 200 blocks, nested 8 deep, 10 000 executed
  steps, 1000 repeats. One run per button at a time.
- **Visible to everyone.** The state of a button's last run —
  `running` (step N of M) / `done` / `failed` (step and reason) / `stopped` —
  is published at `/runs/<scope>/<dashboard>/<widget>` (scope `_` on a
  router and for manager dashboards; the engine id for a router dashboard
  run by the manager), beside the tree roots like `/meta`. Each run is logged.
- **Reboot without a manager** asks once more, like the single Reboot action:
  `run` fails with the "manager is unreachable" message until called again
  with `confirm: true`. Reset and reboot may sit anywhere in a script.

## Why

The user wants SCADA-style buttons that do a sequence (fade, switch, restart)
and simple logic without writing code. Running in the browser was simpler but
dies with the page; the tree servers already own the checks and the actions.

## Consequences

- A router dashboard's button pressed on the router and on the manager at the
  same moment runs twice, once on each server.
- Older routers (no `dashboards` feature) have no viewer; their dashboards'
  buttons run on the manager, which reaches them through their tree paths.
- Variables are not in v1.
