# How dashboards work

A dashboard is a grid of widgets, each tied to one value of a router's tree
(or, for a button, to actions). They are built in the manager UI and shown in
the manager UI, on a router's own port (`http://<router>:8081/d/`) and on a
router's screen. They will replace the local control panel (LCP); until the
fleet has moved both run.

Decisions: [ADR-0026](adr/0026-dashboards.md) (dashboards),
[ADR-0027](adr/0027-button-scripts.md) (button scripts),
[ADR-0024](adr/0024-one-subscribable-tree.md) (the tree they read and write).
For operators and builders: the [user manual](manuals/dashboards.md).
Behaviour: [FDS §6.4](FDS-v2.0.md#64-dashboards-adr-0026); requirements:
URS §5.4.1 (UR-DSH); paths and calls: [tree API](tree-api.md).

## Two kinds

| | Router dashboard | Manager dashboard |
|---|---|---|
| Shows | one router | values of several routers |
| Stored | in the router's profile, key `dashboards` (pushed with the profile, profile history) | manager database, table `manager_dashboards` (own history) |
| Served by | the router: `:8081/d/<name>`, from its own tree; works with the manager down | the manager only |
| In the manager tree | `/engines/<id>/dashboards/<did>` | `/dashboards/<did>` |
| Paths inside | router-relative (`/modules/m1/settings/volume`) | absolute (`/engines/e1/modules/m1/…`) |

## How the pieces fit

```
 manager UI (editor, viewer)                 router screen (mr-kiosk)
        │  tree over Socket.IO :8080                 │ http://localhost:8081/d/<name>
        ▼                                            ▼
 manager ── /dashboards (manager)            engine LocalServer :8081
        │   /engines/<id>/dashboards ──push──▶   /d/  viewer build (manager-ui/dist-dashboard)
        │   (router dashboards: profile)         /d/dashboards.json  [{ id, name }]
        │                                        /tree  router tree (Socket.IO): /dashboards, /runs, /meta …
        │                                        /     LCP while it is kept (else → /d/)
        ▼
 device-manager Displays: content "Dashboard" + name
        GET /api/dashboards → engine /d/dashboards.json (the picker's list)
        weston-client-spawn.sh opens ROUTER_URL/d/<name>
```

- **Schema**: `packages/shared-types/src/dashboard.ts` (`DashboardSchema`;
  every save is checked; stored ones are checked when read and an invalid
  one is logged and left out). Button scripts: `script.ts`, run by
  `scriptRun.ts` / `scriptRuns.ts` on whichever server the page talks to; a
  run's state is at `/runs/<scope>/<dashboard>/<widget>` (ADR-0027).
- **Widgets**: `packages/manager-ui/src/dashboard/widgets/<kind>/` — an
  `index.ts` exporting a `WidgetDef` and its component. `registry.ts` finds
  them by glob; `widgets/shared/` holds parts kinds share and is not a kind.
- **Values**: a widget shows what the value's `/meta` descriptor says (type,
  range, unit, choices, writable). Plugins describe their values in their
  manifest (settings schema, status field `type`, `x-unit`, `enum` +
  `x-enumLabels`); they never ship widgets. Values `/meta` doesn't describe
  (health, router CPU…) have built-in descriptors in `entries.ts`; a module
  that carries audio has `vu` (levels) in its `/meta`.
- **Viewer**: `vite.dashboard.config.ts` builds `manager-ui/viewer/` into
  `dist-dashboard/` with only the zod-free `@media-router/shared-types/browser`
  entry, so the router serves a small page. `pnpm --filter
  @media-router/manager-ui build` builds both the manager UI and the viewer. The engine finds that build next
  to itself (`LocalServer.ts`).
- **Older routers**: a router announces `features: ['dashboards']` in its
  system stats (`SystemStatsCollector.ts`); the manager shows it as
  `/engines/<id>/info/features`. Without it, the router's Dashboards tab says
  its dashboards work from the manager and reach its screen after an upgrade.

## Adding a widget

1. Make `widgets/<kind>/index.ts` with `export default { type, label, icon,
   order, size, binds, accepts, options, component } satisfies WidgetDef` —
   the registry globs the default export. The folder name is the `type` stored
   in dashboards (lower case, never renamed); the component is PascalCase
   beside it.
2. Make the component; it gets `WidgetProps` (`value`, `desc` — the value's
   descriptor —, `options`, `label`, `interactive`) and emits `write` with a
   new value (controls) or `action` (buttons). Read ranges and units from the descriptor, never from a
   module's own config keys (ADR-0007).
3. Add a test beside it. Nothing else changes: the palette, picker and
   inspector read the definition (a new kind of `binds` also needs WidgetHost).

## Checking a router

| Check | Expect |
|---|---|
| `curl http://<ip>:8081/d/dashboards.json` | `[{ "id": …, "name": … }]` for the active profile |
| `http://<ip>:8081/d/` is a 404 "Dashboard viewer not built" | `manager-ui/dist-dashboard` is missing from the install |
| `http://<ip>:8081/` | the LCP; on a router without the LCP build, a redirect to `/d/` |
| device-manager Displays says "Couldn't load this router's dashboard list" | `/api/dashboards` got no answer from the engine (502): the engine is down or old; type the dashboard's name instead |
| A widget says *Missing* | its module is not in the active profile (deleted, or another profile is active) |
| Widgets say *Stale*, the dot is red | the page lost its connection or the router is offline |
| The dot is amber | on the router's screen: its manager is unreachable (changes are kept and sent later); on a manager dashboard: some of its routers are offline |
