# ADR-0009: Probe-driven pipeline shape re-probes on a timer and self-restarts ONLY from the fallback

A module whose pipeline shape is chosen from a probe of an upstream property
(codec, channel count, resolution) must not depend on that probe succeeding at
start time. Two rules:

1. **Re-probe on a low-rate timer** (10 s) whenever the start-time probe failed
   to identify the property, re-asserting the degraded health warning on every
   tick, until the source identifies itself.
2. **Self-restart ONLY from the degraded/fallback state.** A restart out of a
   healthy, correctly-shaped pipeline stays forbidden.

## Why

The start-time probe races the engine's own startup. `audio-transcoder` probes
its input codec once in `onStart`; on a cold boot the upstream `ts-splitter` is
usually not producing yet, so the probe returned `unknown` and the module built
the generic `decodebin` fallback. Field failure (Pi, 2026-08): that fallback
never produced the module's output socket, so the entire downstream chain stayed
wedged until a human restarted the transcoder. "Restart the module to re-probe"
is not a recovery strategy for an unattended broadcast box — the module has
everything it needs to recover itself.

Rule 2 is the constraint that makes rule 1 safe. A transcoder restart drops its
output socket and rebuilds its encoders, interrupting **every** downstream
consumer; [[0005]] rejects `preserveSourceTimeline`'s error-out-and-re-latch for
exactly that cost ("rebuilds a transcoder's encoders over an event the contract
absorbs for free"). Restarting out of the fallback trades one interruption for a
chain that works; restarting a healthy pipeline is pure interruption. So the
guard is a precondition on the restart itself, re-checked on entry to every
cycle — not merely a property of the caller.

## Consequences

- The degraded health warning names the cadence, not a manual action
  (`… re-probing every 10s until the source identifies`), because
  `GstPluginBase` sets health to `ok` on every PLAYING transition — the tick's
  re-assertion is what keeps the warning visible, and it must stay truthful.
- Restart cycles are coalesced (in-progress latch + ONE queued follow-up — the
  `VideoPlayerModule.restartPipeline` pattern, extracted here as
  `coalescedRestart.ts`), and the queued cycle re-checks the fallback
  precondition — so a trigger arriving just as the codec lands cannot bounce the
  pipeline that trigger just fixed.
- **A stopped module is never started by the self-heal**, across the whole cycle
  and not merely the probe: ticks never overlap, a stop landing mid-probe
  abandons that tick's answer, and an EXTERNAL stop — any `onStop` the cycle did
  not make itself — latches. The latch is re-checked immediately before the
  cycle's `onStart`, which aborts instead of reviving a module the engine just
  stopped (the window between the fallback guard and the start is real: the
  cycle's own teardown is `await`ed). It clears on the next external start, so an
  ordinary stop→start behaves exactly like a first start.
- The wait is unbounded by design, **including across failures**: a cycle that
  throws re-arms the loop whenever the module is still degraded and still
  running, so the next tick retries. Otherwise one failed teardown ends the
  self-heal and leaves the module permanently degraded — the original field
  failure with extra steps. A source that never appears costs one short
  `gst-launch` probe every 10 s and keeps a `warning`, which is the honest state.

## References

- `plugins/audio-transcoder/engine/reprobeLoop.ts` — the loop;
  `AudioTranscoderModule.restartCycle` holds the rule-2 guard and the
  external-stop latch, and `coalescedRestart.ts` holds the reusable
  latch-and-follow-up machinery.
- [[0005]] — the restart cost this trades against.
- [[0010]] — the sibling decision from the same change-set: the bus gate defers
  work instead of dropping it, and its warning names the module.
