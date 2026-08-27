# ADR-0010: The unixfd bus gate defers work instead of dropping it, and names who it is waiting for

The runner waits **indefinitely** for its producers' bus edge sockets before it
launches a pipeline (the input socket gate). Two rules bind everything that
happens inside that window:

1. **A `bus_attach` that arrives while the pipeline does not exist yet is
   QUEUED, not dropped**, and flushed in arrival order once the gate opens and
   the pipeline is launched.
2. **The gate's health warning names the upstream MODULE**, and gate-open clears
   only the warning the gate itself set.

## Why

**Rule 1.** The gate window is unbounded, and both layers used to treat "no
pipeline yet" as "no pipeline ever": `GstRunner` sent the attach through
`this.python?.sendCommand` (optional-chained into nothing) and the Python side's
`_try_bus_attach` returned `True` — "handled" — which *popped the attach off*
`_pending_bus_attaches`. The intent was destroyed silently in both places.

That is unrecoverable rather than merely late, because a dropped attach is never
re-issued on its own: the only path that attaches an edge a SECOND time is the
producer's PLAYING transition (`BusFanoutCoordinator.reattachProducer`) — and
being gated is precisely why the producer has not reached PLAYING. So a producer
that gates for minutes, or never reaches PLAYING at all (exactly the failure
being diagnosed), left every one of its consumers waiting forever on a socket
file nobody was going to create. Queueing costs one `Map` entry and makes the
attach as durable as the gate is long.

**Rule 2.** The wait was reported as `Waiting for producer bus socket(s):
/tmp/mr-bus-41000-97b1b3.sock`. `busEdgeSocketPath` derives that from (channel
port, hashed connection id), so it identifies an *edge* — and identifies it in a
form no operator can map back to anything: they learned something was missing but
not which upstream module to go fix. The routing layer already knows —
`getModuleBusSources` maps the same paths back to `sourceModuleId` — so the
warning names the module.

The clearing half is a separate bug with the same root: the old handler flipped
health to `ok` whenever the gate opened *if* health happened to be `warning`,
without checking whose warning it was. A crashed helper or a missing device that
warned during the gate window had its health erased by an unrelated gate opening.

## Consequences

- The queue is keyed by socket path, so a duplicate attach collapses (Python is
  idempotent per socket anyway) while insertion order survives the flush.
- A `busDetach` for a still-queued edge cancels the queued entry: flushing it
  later would rebuild a branch the coordinator has already torn down.
- The queue is dropped on `stopPipeline` and on any superseding start epoch
  (including the restart loop's replay) — those attaches describe a topology
  that no longer exists, and the parent re-attaches on the next PLAYING edge.
- `GstChildProcess.sendBusAttach` before the fork (or after destroy) still
  drops — there is no runner to queue in — but it now logs, because that silent
  `return` is what made the runner-side twin so hard to find.
- Python's pipeline-`None` case returns `False` = *stays pending*, so it is owned
  by the same 250 ms retry as the tee-not-created-yet case. `handle_stop` calls
  `_clear_pending_bus_attaches()`, so a pending attach cannot outlive the
  pipeline it is waiting for. The retry's warning distinguishes the two
  ("pipeline not up yet" vs "tee `<name>` not up yet") instead of sending the
  reader hunting for a tee no pipeline could contain.
- Naming by module depends on both ends deriving the same path from
  (channel port, connection id). A pending path with no matching connection (a
  stale gate report mid-reconnect) falls back to the raw path rather than being
  dropped — an unexplained wait is worse than an ugly one.
- `GstPluginBase.setHealth` clears the gate-warning flag for every caller, so
  the flag can only ever mark a warning the gate itself wrote.

## References

- `packages/engine/src/child-process/GstRunner.ts` — the queue (`queueBusAttach`
  / `flushQueuedBusAttaches` / `clearQueuedBusAttaches`).
- `packages/engine/src/child-process/gst-pipeline-runner.py` —
  `_try_bus_attach`'s pipeline-`None` branch and `_retry_pending_bus_attaches`.
- `packages/engine/src/plugins/GstPluginBase.ts` — `handleBusGate`,
  `describePendingProducers`, `gateWarningActive`.
- [[0009]] — the sibling self-heal decision from the same change-set: a degraded
  pipeline recovers itself rather than waiting for a human. Same principle, other
  end of the pipeline lifecycle.
