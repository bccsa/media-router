# audio-302m-core

Library plugin (no `mediaRouter` manifest — `PluginLoader` skips it, so it
never appears in Add Module) holding the SMPTE-302M domain code every 302M
module shares.

SMPTE-302M is PCM packed in MPEG-TS: the timeline-preserving audio transport
between modules. Because it is media-domain logic rather than engine
orchestration, it lives here and not in `packages/engine`
([ADR-0001](../../docs/adr/0001-plugin-owned-native-and-python-code.md)), and
the dependency runs one way — this plugin imports `@media-router/engine`, and
nothing in `packages/engine` imports it back
([ADR-0002](../../docs/adr/0002-engine-core-stays-in-packages-engine.md)).

## Surface

| Export | Purpose |
|---|---|
| `probe302mSupport()` | Runtime gate: `avenc_s302m` present AND `mpegtsmux` accepting `audio/x-smpte-302m` (gst ≥ 1.26). Call once from `static initManifest`, cache the flag. |
| `pacedMixer(opts)` | The `audiomixer force-live=true ! <caps> ! identity sync=true` shape. The trailing `identity` is the OOM fix, not a style. |
| `buildAudioMixInput(opts)` | N × 302M edges → one continuation point. Mixer arm for ≥ 2 (and 0) sources, direct branch for exactly 1. Returns `{ fragment, continuationName }` — chain only from `continuationName`. |
| `build302mEncodeBranch(opts?)` | PCM → 302M-in-TS encode tail; the caller appends `buildBusSink(...)`. |
| `mixMatrixClause(map, src, dst)` | A `ChannelMapEntry[]` rendered as an `audioconvert mix-matrix` (fan-out, downmix, channel picking, per-channel gain). |

All three fan-in rules — pacing, chaining only from `continuationName`, and
the single-source bypass — are locked in
[ADR-0008](../../docs/adr/0008-302m-fan-in-contract.md). Read it before
changing anything in `audio302mHelpers.ts`.

## Using it

```json
"dependencies": {
    "@media-router/engine": "workspace:*",
    "@media-router/plugin-audio-302m-core": "workspace:*"
}
```

```typescript
import { buildAudioMixInput, build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
```

Import the package name, never a deep path into `dist/`.

Consumers today: `audio-mixer`, `audio-processing`, `audio-output-302m`,
`audio-input-302m`, `audio-transcoder`, `n1-mixer-302m`, `aes67-input`.
