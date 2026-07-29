# Plugin-owned native and python code

All C++ and python data-path code lives inside plugin folders, never in a
top-level tree or inside `packages/engine`: single-plugin code sits in that
plugin's `native/<tool>/` or `py/`, and multi-plugin/domain base code sits in
a **library plugin** — a `plugins/<domain>-core/` folder whose package.json
has no `mediaRouter` manifest, so the loader skips it and it never appears in
the GUI while fully participating in build and resolution. Native code
follows the plain-make contract (`all/test/clean/install`, honouring
`DESTDIR`/`PREFIX`/`CXX`) and is auto-discovered by the repo-root
`make native*` targets, so adding native code to a plugin requires zero
registration.

## Considered Options

- **Top-level `native/` tree** (status quo before this ADR) — rejected:
  plugin-serving code lived outside the plugins it served, with hand-listed
  paths in the Yocto recipe and hard-coded repo-relative fallbacks.
- **npm-style per-plugin build scripts** for native code — rejected: the
  Yocto build needs the toolchain-respecting make contract, and `pnpm build`
  must stay a pure TypeScript build.
- **One generic `plugins/shared` folder** — rejected in favour of per-domain
  `-core` library plugins (`unixfdbus-core`, `mpegts-core`, `rist-core`): a generic
  shared folder becomes a junk drawer and hides ownership.

## Consequences

- Dependent plugins declare their library plugins in `dependencies`
  (`"@media-router/plugin-unixfdbus-core": "workspace:*"`) — greppable and
  existence-guaranteed by pnpm; no runtime effect.
- The MPEG-TS python reference modules and their C++ port live side by side
  in `mpegts-core` (the python is the executable specification; the parity
  suite in `mpegts-core/tests/` enforces byte-identical outputs).
