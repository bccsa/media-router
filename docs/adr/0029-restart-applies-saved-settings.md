# ADR-0029: A restart applies every saved setting — onInit re-runs while a change is pending

A module start while `pendingRestart` is set re-runs the plugin's `onInit`
first, whatever triggered the start: Restart, Enable, or a connection bounce.
That start clears the flag only if no further non-live change was saved while
it was in flight, so the restart pill never clears over a change the start may
not have applied. Plugins derive settings-dependent state in `onStart`, not in
`onInit`, and `onInit` must be idempotent.

## Why

Field, 2026-10-04, BCC Mulanje 10.37.7.24, two identical Shure MVX2U
interfaces: Headphone 2 (legacy audio-output) was moved to the second one
(`…c7555f27…`, card 3) and restarted, but its remap-sink was rebuilt on the
first one — Headphone1's (`…efece7ff…`, card 2) — and the restart pill
cleared. `ModuleInstance.start` ran `onInit` once per plugin instance and stop
never reset that, so Restart and Disable→Enable reused the device the plugin
had cached in `onInit`, while every successful start cleared the flag. Only an
engine Stop→Start, a Reset or a service restart (fresh instances) applied it.

## Considered Options

- **Read settings in `onStart` in the affected plugins only.** Needed, and done
  for the four device plugins. On its own it leaves the restart pill clearing
  over changes that were never applied, for any plugin (in-tree or injected,
  ADR-0004) that caches state in `onInit`.
- **Re-run `onInit` on every start.** Rejected: every connection bounce and
  cascade would pay for it (repeated logs, graph republishes) for no gain.
- **Restart and Enable re-create the plugin instance.** Rejected: heavier, it
  drops per-instance state and the state/VU dedup, and routing bounces would
  still clear the flag unapplied.

## Consequences

- `onInit` must be idempotent. This was checked for every in-tree plugin and
  for the out-of-repo webrtc-client: no listener growth, and `configUpdated`
  fires only when a value changes. Injected plugins (ADR-0004) are tested in
  neither repo's CI, so their owners have to keep to this rule themselves.
  `GstPluginBase` creates its per-instance logger once, because each logger
  pipes a stream into stderr that is never released.
- The device plugins read the device at every start: audio-output,
  audio-input, audio-output-302m and audio-input-302m. The legacy two also
  re-detect and persist its channels and rate there. The 302M pair build every
  pipeline (a replug or a refreshed description) on the device that start runs
  and watches. A device saved but not yet restarted therefore stays pending
  and cannot split the watchdog from the sink.
- A connection bounce with a change pending applies it. Build-time settings
  were already applied this way, which is a deviation from UR-MGR-006c that
  predates this ADR. Holding changes strictly until an explicit Restart would
  need a per-start config snapshot in every plugin.
- A Save sends every field of the panel, so a non-live field marks the module
  pending even when its value did not change. The cost is one extra `onInit`
  on the next start.
