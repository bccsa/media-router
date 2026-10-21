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
| `alignedMixer(opts)` | The `audiomixer latency=0 start-time-selection=first ! capsfilter` aligner, every 302M mixer (the fan-ins and n1-mixer-302m's output mixers). Not live, no timeout: every pad comes through `mralignwatch`, which paces it and gaps it when silent. |
| `buildAudioMixInput(opts)` | N × 302M edges → one continuation point. Each branch `mrtsdemux select=audio/x-smpte-302m` (content time). Mixer arm for ≥ 2 (and 0) sources and live-input mode, each input through `mralignwatch`; direct branch for exactly 1. Returns `{ fragment, continuationName }` — chain only from `continuationName`. A source's `seedLatenessMs` (the router's, from its producer's output lateness) becomes its watchdog's `seed-lateness`. |
| `build302mMixBranch(source, opts)` | One source's branch into a mixer you build: the decode on content time, the mix caps, its `mralignwatch` (the element whose src pad links into the aggregator). |
| `liveMixInputBranch(mixer, source, opts?)`, `liveInputBranchFor(mixer, connectionId, source?, opts?)`, `mixInputBranchName`, `liveDemuxName` | A live input branch for `getLiveInputBranch`, the same text `buildAudioMixInput({ liveInputs: true })` renders at start, and the bin and demux names a later live remove finds. |
| `build302mEncodeBranch(opts?)` | PCM → 302M-in-TS encode tail; the caller appends `buildBusSink(...)`. |
| `mixMatrixClause(map, src, dst)` | A `ChannelMapEntry[]` rendered as an `audioconvert mix-matrix` (fan-out, downmix, channel picking, per-channel gain). |
| `positionedChannelsClause(n)` | `audioconvert <identity matrix> ! audio/x-raw,channels=n,channel-mask=<default layout>` — gives an unpositioned n-wide stream (whole-device capture, decoded wide 302M) the layout `avenc_s302m` insists on. `POSITIONED_302M_MASK` is the table. |
| `channelRange(first, last)` | `"5"` for one channel, `"5–12"` for a range — the device-channel span in a 302M module's health messages (input capture, output placement). |

The fan-in rules — chaining only from `continuationName` and the single-source
bypass — are locked in [ADR-0008](../../docs/adr/0008-302m-fan-in-contract.md);
its force-live mixer, pacer and `ignore-pcr` gave way to the aligned mixer in
house-clock Phase 2 (plan chapter 6, OQ-21). Read both before changing
anything in `audio302mHelpers.ts`.

`mrtsdemux` and `mralignwatch` are elements of mpegts-core's
`libgstmrtshouse.so`, which both runners load by path. `mrtsdemux` has no
stand-in, so a module whose fan-in this builds is refused with the "Native TS
module not loaded" alarm on a box without the plugin. The element rules
(every pad through `mralignwatch`, `hold-on-eos`, seeds, floors) are in
`plugins/README.md`, "Aligners"; the choices behind them in ADR-0029, Phase 2.

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
