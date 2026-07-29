# Architecture Decision Records (ADRs)

This folder locks the architecture. Every record captures a decision that is
hard to reverse, would surprise a future reader, and was a real trade-off —
so nobody "fixes" something that was deliberate, and nobody re-litigates a
settled question without seeing why it was settled.

**Read this folder before changing the architecture** (moving code across
package/plugin boundaries, changing build contracts, changing how components
communicate). If your change conflicts with an ADR, either follow the ADR or
supersede it with a new one — don't silently diverge.

## Format

Sequential files: `NNNN-short-slug.md`. Keep them short — 1-3 sentences of
decision + why is a valid ADR. Optional sections only when they earn their
place: `Considered Options`, `Consequences`, `Status` (when superseded, mark
the old one `superseded by ADR-NNNN`). Number = highest existing + 1.

## Index

| ADR | Decision |
|---|---|
| [0001](0001-plugin-owned-native-and-python-code.md) | Plugins own their C++/python; shared base code lives in `<domain>-core` library plugins; plain-make contract, zero-registration discovery |
| [0002](0002-engine-core-stays-in-packages-engine.md) | Engine orchestration core stays in `packages/engine`; plugins depend on the engine, never the reverse (one recorded name/path-only exception) |
| [0003](0003-scoped-native-resolution-and-namespaced-install.md) | Native/python resolution is scoped to the requesting plugin; installs are namespaced under `/usr/libexec/media-router/<plugin>/`; ambiguity fails loud |
| [0004](0004-out-of-repo-plugins-injected-at-image-build.md) | Product-specific plugins may live in the consuming product's repo (under `media-router-plugin/`) and be injected into `plugins/` at image build |
