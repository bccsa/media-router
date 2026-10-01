# ADR-0026: Dashboards — generic widgets on tree paths; router dashboards live in the profile

Operator dashboards replace the local control panel (LCP). A dashboard is a
grid of widgets, each tied to one tree path (ADR-0024); users build them in the
manager UI. Decided in the 2026-09-29 design session.

- **Two kinds.** A *router dashboard* uses one router's values only, with
  router-relative paths (`/modules/<mid>/…`, `/info/…`, `/system/…`). It lives
  in that router's **profile** (`dashboards/<id>`), next to the modules it
  shows, so it switches with the profile, rides the normal config push, is
  applied as a difference like the graph (ADR-0025) and gets the profile's
  history and rollback. The router serves it at `:8081/d/<name>` straight from
  its own tree, so it works with the manager down; through the manager the
  same paths get an `/engines/<id>` prefix. A *manager dashboard* can mix
  routers (absolute paths) and lives on the manager only.
- **Widgets are generic** (ADR-0007): each is one folder in
  `packages/manager-ui/src/dashboard/widgets/` declaring the values it takes,
  its options and default size; the editor, picker and viewer only read those
  declarations. Plugins cannot ship widgets — they describe their values
  (`/meta`, from their config schema and status sections) and existing widgets
  show them. A value's range and unit always come from `/meta`, live; values
  `/meta` does not describe (health, levels, router load) have built-in
  descriptors.
- **Editing is manager-only.** A router takes value writes from its own side
  but never structure (ADR-0025), so it serves dashboards for viewing and
  operating only. An edit is a draft published by one `save` call that carries
  the revision it started from; a newer stored revision is a conflict the
  editor offers to overwrite or reload.
- **One UI, two builds.** The dashboard code lives in `manager-ui`; a second,
  viewer-only build (`dist-dashboard`, base `/d/`) is what a router serves. It
  bundles the zod-free `@media-router/shared-types/browser` entry instead of
  the whole package, keeping it the size of the LCP it replaces.
- **Screens pick by name.** device-manager's display content `dashboard` +
  `name` opens `:8081/d/<name>`; a profile switch shows the new profile's
  dashboard of that name, or the list. Each dashboard carries its own view
  settings: grid size, scroll, pinch zoom, locked (no menu), theme.
- **Mixed versions.** A router announces `features: ['dashboards']` in its
  stats identity block (`/engines/<id>/info/features`). Older engines store the
  unknown `dashboards` config key untouched, so their dashboards work from the
  manager and appear on the router's own screen after its upgrade.

## Why

The LCP was one fixed strip layout that plugins extended with their own Vue
components. SCADA-style panels need free composition of controls and status
from any module, on routers and across the fleet, working on site when the
manager link is down.

## Consequences

- A rebooted router without its manager has no dashboards, as it has no
  running modules (ADR-0025: no saved config).
- **The LCP stays for the migration (2026-09-30).** It keeps `:8081/` and its
  own Socket.IO on the router's :8081 server, next to dashboards at `/d/` and
  the router tree; device-manager offers both. Removing it later takes the
  `local-panel` package, the plugins' `lcp*` settings and `lcpType`, and the
  note plugin's strip; stored values then linger unused, and `:8081/`
  becomes the dashboard list (already so on a router without an LCP build).
  A Start/Stop made on the router travels as `lcpEngineCommand`, a wire name
  managers of every version know.
- **Confirmed with the user (2026-10-01).** "Input disabled" is offered on
  every widget that takes input (controls and buttons) — display widgets have
  nothing to disable; a test keeps new input widgets to it. History stays one
  version per 10 minutes, the last 10, as for profiles.
