# Out-of-repo plugins may be injected at image build time

A plugin whose sole purpose is to serve another product can live in that
product's repo instead of this one, and be copied into `plugins/` by the
image build (Yocto `media-router.bb`) before `pnpm install` / `pnpm build`.
`PluginLoader` discovers it like any in-repo plugin; this repo needs no code
change, no registration, and its committed `pnpm-lock.yaml` stays free of the
foreign package (the recipe runs a second, non-frozen install to link it).

The owning repo exposes its plugins under a top-level `media-router-plugin/`
directory — one subfolder per plugin — which the image build copies verbatim
into `plugins/`. Moving a plugin out is warranted when its config schema and
its consumers live in the other repo: they then version together.

Consequences: injected plugins may depend only on `@media-router/engine`
(`workspace:*`); registry dependencies would drift from the committed
lockfile — the recipe enforces this and fails the build on any other
dependency, as it does on a name collision with an in-repo plugin. Dev
checkouts of this repo don't have injected plugins; that is intended, not a
missing file.

Known gap: an injected plugin's tests run in NEITHER repo's CI — this repo
never sees the code, and the owning repo can't build it standalone (its
tsconfig resolves only after injection). The owning repo is nominally
responsible, but until it has an injection-and-test harness, treat injected
plugins as untested (`docs/TodoNotes.md`).
