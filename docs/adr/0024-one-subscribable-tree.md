# ADR-0024: Browsers talk to one subscribable tree — sub, unsub, write, call

Every browser-facing server exposes ONE address space and four verbs over one
Socket.IO connection. The manager (:8080) serves the fleet: `/engines/<id>/…`,
`/profiles/<id>/…`, `/groups/…`, `/settings`, `/plugins/…`. A router serves its
own subtree rooted at `/` — exactly what the manager holds under
`/engines/<id>` — on :8081 under the Socket.IO path `/tree`.

- **Paths** are JSON-Pointer segments (`~0` = `~`, `~1` = `/`). Router-level
  values live under `info/` and `system/`; a module node merges its profile
  config, manifest overlay and runtime state under today's field names
  (`settings`, `statusData`, `vu`, `health`, …).
- **`sub` / `unsub`** take patterns. A pattern matches its node AND everything
  below it; `+` matches one segment; a trailing `#` is ignored. A subscription
  is answered with a snapshot (as `add` ops), then deltas.
- **Deltas** are JSON Patch ops with absolute paths, sent in `tree` frames: one
  frame per socket per flush tick, latest-wins per path while the transport is
  busy (ops for different paths ship in order), and an ancestor write is
  pruned to the socket's own patterns. An engine rename re-keys matching
  subscriptions and tells those sockets with `tree:renamed { from, to }`.
- **`write`** takes a batch of add/replace/remove ops at tree paths and is
  acked with the ops that were rejected. Every accepted or rejected op comes
  back to its writer in a `tree` frame tagged with the write id, carrying the
  stored value, so concurrent writers converge and a rejected control snaps
  back.
- **`call`** runs a method on a node and is acked with a result: actions
  (reset, reboot, module restart, profile rollback), anything carrying a
  secret (engine create, password) or binary (plugin uploads), and bulky
  on-demand lookups (profile config, history).
- **`/meta` + path** is the value's descriptor from the shared `describe()`:
  `access` read|write, `apply` live|restart, type, range (`x-maxFrom`
  resolved), step, unit, enum, label, widget. Amended 2026-09-29: it mirrors the value paths
  (`/meta/engines/<id>/modules/<mid>/settings/<key>`, `…/statusData/<section>/<key>`,
  `/meta/engines/<id>/info/running`; a router serves `/meta/modules/…` and
  `/meta/info`) and is live: a descriptor is republished when its inputs
  change (a referenced setting, the schema, the engine's live params). It is
  not part of `/` — only a subscription that names `/meta` receives it.
- **Checks**: every browser write is validated per op against its descriptor
  — read-only, runtime, undeclared key, wrong type, out of range or enum all
  reject. Writes a router originates are trusted. A router accepts only value
  writes (`settings`, `enabled`, `info/running`) and the calls module
  restart and device reboot; reboot needs `confirm` while its manager link is
  down.
- **Versioning**: the handshake's `auth.proto` must equal the server's
  protocol version or the connection is refused; the server's `hello` carries
  protocol and UI build, and a client reloads itself (once per version) when
  either differs from what it loaded with.

## Why

Per-router watch rooms were all-or-nothing. Measured on the fleet manager
(2026-09-28, 42 engines): `engine:list` was 1.95 MB per browser connect, 58 %
of it `configSchema` repeated per module; the GATE01 routing view carried
66–72 kB/s of whole-module states in which ~1.1–1.4 of ~140–170 values
changed — 3.5 kB/s as leaf ops. Dashboards need any value from any router,
with read/write semantics. A real MQTT broker was rejected: per-leaf retained
topics (~12k for GATE01), a second protocol in the UI, and the N-1 patch
semantics and #677 backpressure would have had to be rebuilt in it.

## Consequences

- Switched once: old UI clients are refused, and `engine:list`,
  `watch:engine`, `patch` and every per-event request/reply name are gone from
  the manager.
- The browser drops data nobody subscribes to; re-entering a routing view
  re-snapshots it.
- Status section ids, status keys and the schema flags `x-readOnly` / `x-live`
  are public API once dashboards bind to them.
- Everything reaches the tree through one dispatcher — the place an auth check
  goes later; there is none yet.
- The LCP keeps its own Socket.IO on :8081 until dashboards replace it.
- Supersedes FDS §8.2.
