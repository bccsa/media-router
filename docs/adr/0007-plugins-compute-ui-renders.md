# ADR-0007: Plugins compute, the UI renders — widget vocabulary stays generic

`packages/` contains only generic systems. A manager-ui widget may know
presentation (a slider knows min/max/step; the `graph` widget knows axes,
series and markers) but never a specific module's config keys, value mappings,
element semantics, or domain maths. Anything domain-specific is computed by the
plugin that owns the domain and travels to the UI as **data** — for graphs, a
`StatusGraph` published with `setStatusGraph()` on the existing status channel
and pointed at by a schema prop's `x-graph`.

Plugins still ship no UI code beyond the two documented Vue faces
(`ui/NodeFace.vue`, `ui/LcpStrip.vue`); everything else is manifest plus data.

## Why

The audio-processing module wanted mixer-style graphs: a dynamics transfer
curve and an EQ frequency response. Two shapes were rejected before this one.

1. **Domain maths in manager-ui.** The UI would have read `mode`, `gateDepth`,
   `eqBand3Type` and LSP's filter-type names — one module's vocabulary compiled
   into the shared frontend, with the curve maths in a different package from
   the DSP it describes. Every new graph would then need a manager-ui release.
2. **Manifest-parameterised domain widgets.** Generic "dynamics" and "EQ"
   widgets, bound to config keys by the manifest. Better, but the UI still
   carried the models (compressor/gate/expander/ducker, RBJ biquads), and the
   binding grew a second schema language that only one plugin spoke.

Both put knowledge on the wrong side of the boundary ADR-0002 draws. Publishing
plot data instead keeps every domain decision — units, axis ranges, which
series exist, what the annotations say — in the plugin that already owns the
DSP, and leaves the UI with one plotter that any future plugin gets for free.

## Consequences

- A new graph anywhere in the fleet costs plugin code plus one schema prop. No
  manager-ui change, so no coupling between a plugin release and a UI release.
- The curve is computed engine-side and arrives over the status channel, so it
  reflects what the module actually has, not what the browser guessed. The cost
  is a round trip: a live slider drag patches the engine, which republishes.
  Every knob those graphs draw is already `x-live`, so the loop closes in one
  patch interval.
- Graph payloads ride the module's runtime state, which is rebroadcast on every
  status change. Publishers keep point counts modest (~60–75 samples) and round
  their coordinates. A graph that needs a faster or larger channel than status
  is a signal to revisit this, not to add a parallel transport.
- `statusData` values are no longer strictly primitive (`StatusValue`). The
  stats popup renders only manifest-declared fields, so a graph section that is
  not declared in `statusSections` stays invisible there.
- Applies to every widget, not just graphs: if a widget needs to know what a
  value MEANS, the meaning belongs in the plugin.

## Amendment (2026-08-26) — the three mechanics the first draft left implicit

Nothing above changes. These are the parts of the contract that were only
visible in code, and each is easy to get wrong from the ADR alone.

**1. A display-only schema prop is virtual — it holds no value.** Pointing the
UI at published data needs somewhere to *place* the widget, so a plugin declares
an ordinary `configSchema` property for it. That property is not a setting: no
`default`, never patched live, never written back into the module's saved
settings. `packages/manager-ui/src/utils/displayWidgets.ts` owns the list
(`DISPLAY_WIDGETS`, today just `graph`) and `stripDisplayFields()` removes those
keys — on hydration as well as before an Apply, because a settings blob stored
under an older schema rev can still carry one and a one-sided strip would let it
round-trip back in. `lspConfig.test.ts`'s DEFAULTS-mirror check excludes them for
the same reason: a virtual prop with a default would be a contradiction.

**2. `x-widget: "graph"` is required alongside `x-graph`.** They are not
interchangeable. `x-widget` selects the renderer and is what marks the prop
virtual; `x-graph` only says where the data lives (`{ section, key, height? }`).
`x-graph` without `x-widget` renders a text input over a stale saved value —
a real settings field that happens to name a status key.

**3. `setStatusGraph` MERGES per key; `setStatusData` REPLACES the section.**
`setStatusGraph(section, key, graph)` writes one key and *deletes* it on `null`
— publishing null is how a graph the previous mode owned gets cleared, so
publishers emit every key on every update, nulls included. `setStatusData` swaps
the whole section object. Mixing the two in one section therefore means the next
meter poll wipes the curves. **Give graphs a section of their own** (the
audio-processing plugin uses `graphs`), and leave it out of `statusSections` so
it stays invisible in the stats popup — it exists for the `x-graph` widgets alone.
