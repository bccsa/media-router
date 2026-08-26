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
| [0002](0002-engine-core-stays-in-packages-engine.md) | Engine orchestration core stays in `packages/engine`; plugins depend on the engine, never the reverse (two recorded exceptions: name/path-only plugin lookups, and the runner's per-buffer-adjacent stamper python) |
| [0003](0003-scoped-native-resolution-and-namespaced-install.md) | Native/python resolution is scoped to the requesting plugin; installs are namespaced under `/usr/libexec/media-router/<plugin>/`; ambiguity fails loud |
| [0004](0004-out-of-repo-plugins-injected-at-image-build.md) | Product-specific plugins may live in the consuming product's repo (under `media-router-plugin/`) and be injected into `plugins/` at image build |
| [0005](0005-time-sync-backend.md) | Monotonic house clock in every process; producers stamp bus PTS as contractual media time; `base_time=0`, playout offset D; linuxptp discipline for AES67/ST 2110 |
| [0006](0006-hardware-sinks-held-at-unity-gain.md) | Hardware PipeWire sinks are forced to unity gain on detection; all attenuation happens in software (`MR_PW_*` nodes / GStreamer) |
| [0007](0007-plugins-compute-ui-renders.md) | `packages/` holds only generic systems; UI widget vocabulary is generic and never module-specific; domain computation lives plugin-side and travels as data (`StatusGraph` → `x-widget: "graph"`) |
| [0008](0008-302m-fan-in-contract.md) | Every 302M fan-in: force-live mixers are clock-paced (`identity sync=true`), callers chain only from the returned `continuationName`, and one source bypasses the mixer — trading silence-fill for a restart |
