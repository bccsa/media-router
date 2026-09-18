# ADR-0021: A discovered port is retired only by a live source that no longer carries it, and never while a stored connection references it

A plugin that materialises ports from source discovery (the ts-splitter's
per-PID outputs, persisted as `discoveredStreams`) reconciles that set on
every discovery event — the source's whole current PMT. A persisted entry
absent from the event is:

- **dropped** when no connection references its port, or
- **kept and flagged `stale`** (config entry, `DynamicPort.stale` hint, label
  suffix, a State column in the per-stream status rows, and the splitter's
  stream badge turning amber with a `+N` stale count; the UI draws the pin
  as a hollow amber dashed dot) while one does — whether or not that
  connection is applied right now.

"References" is answered by `MediaRouter.hasStoredConnection(moduleId,
portId)`, which reads the PERSISTED graph the engine received from the
manager. The live connection map is not an acceptable oracle: `ModuleLifecycle`
removes a consumer's edges from it while the consumer is disabled, stopped or
mid-restart, so a live check would prune a port whose stored connection then
dangles ("Source port not found" on re-enable).

A dark source emits no discovery and therefore prunes nothing — ports and
connections survive an outage exactly as before (the D5 invariant of the
dynamic-streams plan). Pruning is immediate on the first omitting PMT: the
port id is PID-derived, so a returning stream recreates the identical port
and its sticky bus channel.

## Consequences

- The pruned PID stays declared in the running native child and keeps its
  bus channel until the module stops. There is no `remove_output` verb, and
  `add_output` is idempotent on the tee NAME, so releasing the port number and
  re-using it for a different PID would be silently ignored. Both are
  reclaimed at the next stop; the cost is one idle pool port per pruned PID
  per run.
- The plugin calls `hasStoredConnection` optionally and falls back to the live
  count on an engine without it, so the plugin dist loads on older engines
  (where it still never prunes a port with a running consumer).
- Supersedes the "never auto-remove" wording in plugins/README.md and the
  Phase-3 note of docs/mpegts-dynamic-streams-plan.md; D5's refined form is
  what this records.
