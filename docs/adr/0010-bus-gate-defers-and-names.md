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

## Amendment 2026-09-15 — the gate also covers a connected bus that carries no data

The socket gate answers "the producer has not created its socket yet". A
second dark case slipped past it: a producer whose socket ACCEPTS but that sends
nothing — an encoder disabled by an interlock, a caller whose peer is down.
`unixfdsrc` is not a live source, so a consumer on such a bus sits ASYNC in
PAUSED and the runner's blanket 10 s "reached PLAYING" watchdog read that as a
wedge: `playing_timeout` → restart → identical pipeline → 10 s → again. Measured
on the SCC French master (2026-09-15): 940 rebuilds an hour for two dark inputs,
each one a PipeWire stream torn down and re-created, journald dropping ~145
lines every 30 s — and the churn is the prime suspect for the pulsesrc ring
re-timestamps that grew the translator's headphone latency in 200 ms steps.

Rule 3. **For a `unixfdsrc`-headed pipeline the PLAYING deadline starts at the
first buffer, not at start.** Until then the pipeline waits passively (sink
built and corked, nothing spawned, nothing torn down); after the watchdog
period of silence the runner reports `waiting_for_data` once, which `GstRunner`
forwards on the SAME `busGate` channel as rule 2, so the module shows
"Waiting for upstream module(s): X" and clears only its own warning when
`data_arrived` follows. Once data flows the deadline is the same 10 s as before —
a wedge WITH data is still a wedge and still restarts. Every other head in the
engine is a live source and reaches PLAYING with NO_PREROLL, so the blanket
deadline stands there (`gst-pipeline-runner.py` `_data_wait`,
`gst_playing_watchdog_data_gate_test.py`).

Not changed: an SRT/RIST caller whose peer is down still errors and restarts
on its plugin's own backoff (srt-input caps it at 10 s on purpose — the peer's
return is what the retry is for).

## Amendment 2026-09-15 (2) — udpsrc is not live either; UDP silence is a state

`udpsrc` is not live either (measured on the dev host and on .103), so rule 3
applies to UDP-headed producers as well, and UDP silence is a STATE — the first
`GstUDPSrcTimeout` after start or after data emits `input_silent` (health
warning, Waiting badge), the first packet back emits `input_resumed`; the
pipeline is never rebuilt for a quiet sender. A pure-UDP head reports through
that path only (no `waiting_for_data`), so a silent input warns exactly once. The one legitimate rebuild is a
MULTICAST membership lost across a network blip, so a producer may declare
`udpSilenceRestartMs` (mpegts-ip-input and aes67-input: 60 s, multicast only)
past which the old `udp_timeout` error and restart still apply. And a parked consumer whose
producer restarts under it (socket gone or re-created, polled every 2 s) errors
out as `bus_producer_restarted` — shown as a warning through both the `error`
and the following `stateChange` (the runner tags the latter with the kind) — so
the normal restart reconnects it instead of leaving it on a dead socket for
ever. The deadline waits for EVERY non-live head's first buffer (a mux waits
for all its inputs). All of this lives in `gst_source_gate.py`; the runner only
wires it.

## Amendment 2026-09-18 — a consumer that predates its producer's launch is relaunched

The socket poll above only runs while a consumer waits for its first data. A
consumer that had already flowed, or whose `unixfdsrc` never surfaced the peer
closing, was uncovered: FRA01 "MUL IN" launched one second after a producer
instance that died three seconds later and then sat at 0 kbps for an hour with
no error, while the returning producer streamed into an edge nobody read. Rule
1's re-attach rebuilt the edge; nothing rebuilt the consumer.

Rule 4. **A consumer whose pipeline launched at or before its producer's current
launch cannot hold the live edge, so the producer's PLAYING relaunches it.**
`GstRunner` posts `pipelineLaunched {at}` on every launch and `pipelineStarting`
when a launch is retired; `GstChildProcess` keeps that as `pipelineLaunchedAt`
(cleared on stopped / error / starting and when a relaunch is requested);
`BusFanoutCoordinator.reattachProducer` compares consumer against producer after
attaching each edge and calls `restartPipeline` once per stale consumer. It is a
pipeline relaunch — fresh Python, same description, re-gated on the new edge —
never a module stop/start, so PipeWire objects and downstream links survive and
the cascade `ModuleLifecycle._restart` forbids stays forbidden. A consumer with
no launch time is down or already re-gating and is left alone. Not covered: a
producer without a `GstChildProcess` (hls-player's fan-out sidecar) — its
consumers still rely on the poll. Both timestamps are `Date.now()` in the runner
host; under the forked backend a wall-clock step between two launches can
misjudge one comparison (`BusFanoutCoordinator.test.ts`, `GstChildProcess.test.ts`,
`GstRunner.test.ts`).

