# Media Router — Plugin Development Guide

Plugins extend Media Router with new media processing capabilities. Each plugin is a self-contained directory in `plugins/` with a manifest, engine module, and optional UI components.

## How Plugins Work — the Big Picture

The architecture behind everything in this guide is locked by the ADRs in
[`docs/adr/`](../docs/adr/README.md) — read those first when you plan to
change *how* plugins work rather than add one.

**Two kinds of plugin folder** (ADR-0001):

- **Module plugins** — `package.json` has a `mediaRouter` manifest → they
  appear in the Manager UI's Add Module panel and can be placed on the
  routing canvas (`srt-input`, `ts-splitter`, …).
- **Library plugins** — `package.json` has NO `mediaRouter` manifest → the
  loader skips them, the GUI never shows them, but their code (C++, python,
  shared assets) fully participates in build and runtime resolution. Named
  `<domain>-core`: `unixfdbus-core` (GstUnixFd bus transport), `mpegts-core`
  (MPEG-TS packet core + its python reference spec), `rist-core` (librist
  bindings), `aes67-core` (SAP/SDP + the TAI clock), `audio-302m-core` (the
  shared SMPTE-302M TypeScript helpers).

Not every plugin lives in this repo: product-specific plugins may be owned by
the consuming product's repo (under its `media-router-plugin/` folder) and
injected into `plugins/` by the Yocto image build (ADR-0004). If a deployed
image shows a plugin you can't find here, check the owning product's repo.

**Discovery & lifecycle.** At engine startup `PluginLoader` scans every
`plugins/*/package.json`: validates the manifest, filters by architecture,
and dynamically imports the class named by `manifest.engine` (a
`GstPluginBase` subclass). Loaded manifests are sent to the manager, which
renders the Add Module panel from them. When a user adds a module, the
engine's `ModuleManager` instantiates the class; `buildPipeline(config)`
returns a GStreamer pipeline string executed by the python gst runner — or
`null` for modules that instead spawn their own native child or CLI tool.
Plugins depend on `@media-router/engine`; the engine never imports plugin
code (ADR-0002).

**What builds what:**

| Code | Where | Built by |
|---|---|---|
| TypeScript engine module | `<plugin>/engine/` | `pnpm build` (per-plugin `tsc`) |
| Vue UI components | `<plugin>/ui/` | manager-ui build |
| C++ tools | `<plugin>/native/<tool>/` | root `make native` (auto-discovered, zero registration) |
| Python sidecars/modules | `<plugin>/py/` | nothing — shipped as source |
| Cross-language tests | `<plugin>/tests/` | `pnpm test` (vitest) |

At runtime, native binaries and python scripts resolve scoped to the
requesting plugin, and installed images keep the same per-plugin namespacing
under `/usr/libexec/media-router/<plugin>/` (ADR-0003). Details in
"Native & Python code in plugins" below.

## Directory Structure

```
plugins/
└── my-plugin/
    ├── package.json          # Manifest + dependencies
    ├── tsconfig.json         # TypeScript config
    ├── engine/
    │   └── MyPluginModule.ts # Engine-side GStreamer pipeline logic
    ├── native/               # optional: C++ tools (see "Native & Python code in plugins")
    ├── py/                   # optional: python sidecars / runner-importable modules
    └── tests/                # optional: cross-language test suites
```

## Quick Start

### 1. Create the plugin directory

```bash
mkdir -p plugins/my-plugin/engine
```

### 2. Create `package.json` with manifest

```json
{
    "name": "@media-router/plugin-my-plugin",
    "version": "2.0.0",
    "private": true,
    "description": "Short description of what this plugin does",
    "mediaRouter": {
        "pluginId": "my-plugin",
        "displayName": "My Plugin",
        "description": "Longer description shown in the Add Module panel",
        "category": "protocol",
        "color": "#3b82f6",
        "icon": "radio",
        "architectures": ["arm64", "x86_64"],
        "ports": [],
        "configSchema": {},
        "engine": "./engine/MyPluginModule.ts"
    },
    "dependencies": {
        "@media-router/engine": "workspace:*"
    },
    "scripts": {
        "build": "tsc",
        "typecheck": "tsc --noEmit"
    }
}
```

### 3. Create `tsconfig.json`

```json
{
    "extends": "../tsconfig.plugin.json",
    "compilerOptions": {
        "outDir": "./dist",
        "rootDir": "./engine"
    },
    "include": ["engine"]
}
```

### 4. Create the engine module

```typescript
import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

export class MyPluginModule extends GstPluginBase {
    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        // Return null if the module should be idle (e.g. no connection yet)
        const pipeline = 'audiotestsrc ! fakesink';
        return { pipeline };
    }
}
```

### 5. Install and run

```bash
cd v2
pnpm install    # Creates workspace symlinks
pnpm build      # Compiles everything
```

The plugin will automatically appear in the Manager UI's "Add Module" panel.

---

## Picking a Starting Point

Don't start from a blank file — copy an existing plugin whose architecture matches what you're building, then change the parts you need. Each row below points to a plugin that's already wired to the right base patterns:

| Building... | Start from | Why |
|---|---|---|
| A GStreamer pipeline that consumes/produces audio | `audio-decoder` or `audio-encoder` | Simple `buildPipeline` + UDP I/O + stats polling |
| A network ingress/egress plugin | `srt-input` / `srt-output` | Bus-channel allocation, per-caller stats, badges |
| Plain MPEG-TS over IP (UDP/RTP) to/from a real NIC | `mpegts-ip-input` / `mpegts-ip-output` | `buildNetUdpSrc`/`buildNetUdpSink` (interface + TTL, full 224.–239. multicast), raw/RTP encapsulation, `tee` fan-out, `trackThroughput` bitrate |
| A plugin that owns a hardware device (audio source/sink, V4L2, DRM) | `audio-input` / `audio-output` | `static registerServices` for device provider, watchdog hooks |
| A CLI-tool wrapper (returns `null` from `buildPipeline`) | `rist-input` / `rist-output` | `ProcessManager` lifecycle, stderr parsing |
| A Node-library wrapper that emits MPEG-TS + auto-detects config from the source | `hls-player` | Spawns a Node child running an ESM library (hls-pipe) via dynamic `import()`, publishes paced MPEG-TS on the bus via the fan-out sidecar, probes the source and reports `fieldOptions` |
| A PipeWire-only plugin (no GStreamer) | `n1-mixer` | Per-port PipeWire nodes via `getPipeWireNodeForPort` |
| A multi-port plugin with variable port count | `ts-splitter` (1→N) / `mpegts-muxer` (N→1) / `n1-mixer` | `getDynamicPorts(config)` |
| A bus-native N→1 audio processing plugin (302M in/out, per-connection channel maps) | `audio-mixer` | `buildAudioMixInput` fan-in + `build302mEncodeBranch`, `probe302mSupport()` gating, shared `applyVolumeLiveUpdate` fader, `ThroughputPoller` badge |
| A DSP chain plugin (LADSPA stages, live parameter control, a sidechain input) | `audio-processing` | Optional stages assembled into one chain, `findLadspaElement` per enabled stage, live writes guarded by which stages actually exist, native `level`→`volume` control loop for ducking |
| A plugin that probes hardware at load time to populate its manifest | `video-encoder` (HW encoders) / `audio-encoder` (codec capability) | `static initManifest(manifest)` |

The Quick Start example above is a minimal skeleton — for anything non-trivial, copying a real plugin will save more time than reading docs.

---

## Manifest Reference (`package.json` → `mediaRouter`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pluginId` | `string` | Yes | Unique identifier (e.g. `"srt-input"`) |
| `displayName` | `string` | Yes | UI display name |
| `description` | `string` | Yes | Description for the Add Module panel |
| `category` | `string` | Yes | Palette group. Shipped today: `"input"`, `"output"`, `"protocol"`, `"codec"`, `"processing"`, `"utility"`, `"deprecated"`. See "Categories and palette order" |
| `color` | `string` | No | Hex color for module accent (left border + icon tint). E.g. `"#3b82f6"` |
| `icon` | `string` | No | Lucide icon name in kebab-case. E.g. `"mic"`, `"volume-2"`, `"radio"` |
| `architectures` | `string[]` | Yes | Supported platforms: `["arm64", "x86_64"]` |
| `ports` | `Port[]` | Yes | Input/output port declarations |
| `configSchema` | `object` | Yes | JSON Schema for module settings |
| `statusSections` | `Section[]` | No | Status data sections (stats popup) |
| `faceWidgets` | `FaceWidget[]` | No | Declarative widgets rendered on the module card (see "Module Face — Declarative Widgets") |
| `interlock` | `boolean` | No | Eligible for interlock (exclusive-mute) groups. Requires a live-updatable boolean `audioEnabled` in configSchema |
| `resizable` | `boolean \| ResizableBounds` | No | User can resize the module card on the routing view. See "Resizable Modules" |
| `lcpType` | `string` | No | Makes the module visible on the Local Control Panel. Any truthy value works — the presence is what matters, not the value. Only needed for plugins that want LCP visibility *without* shipping a `ui/LcpStrip.vue`; plugins with a strip component are auto-detected and don't need this field. See "Plugin UI Components → LCP visibility". |
| `engine` | `string` | Yes | Path to engine module `.ts` file |

### Categories and palette order

`category` is only a grouping key for the Add Module panel. `AddModulePanel.vue`
renders the known ones in a fixed order — **Input, Output, Protocol, Codec,
Processing, Utility** — and then sweeps up everything else into trailing groups
of its own, so a category the panel has never heard of appears at the bottom
rather than silently vanishing (that regression is why the sweep exists: see the
2026-07-18 entry in `docs/TodoNotes.md`, where `input`/`output` were missing from
the list and the 302M plugins were unreachable, search included).

`"deprecated"` is deliberately NOT in the ordered list — it rides the trailing
sweep, which is what puts the **Deprecated** group last, below everything an
operator should be reaching for. It has a label of its own so it doesn't render
as a bare id. Use it for a plugin that is superseded but still loadable for
existing profiles — today `audio-decoder`, `audio-dynamics`, `audio-encoder`,
`audio-input`, `audio-output`, `n1-mixer`.

An empty group is not rendered, so shipping no plugins in a category costs
nothing. `PluginManifest.category` in `packages/shared-types` carries the same
list as a union, but nothing narrows on it — the trailing sweep is what actually
keeps a new category safe, so the union going stale is a documentation gap
rather than a runtime failure. Update both when you add one.

### Color and Icon

Each module on the routing canvas shows a colored accent bar and icon in the header.

- **`color`**: Any CSS hex color. Used for the left border accent and icon tint.
- **`icon`**: Any icon name from [Lucide Icons](https://lucide.dev/icons/) in kebab-case.

Common icon examples:
| Icon name | Description |
|-----------|-------------|
| `mic` | Microphone (audio input) |
| `volume-2` | Speaker (audio output) |
| `upload` | Upload/encode |
| `download` | Download/decode |
| `radio` | Radio/broadcast |
| `wifi` | Wireless/streaming |
| `cast` | Cast/multicast |
| `tv` | TV/display |
| `film` | Video |
| `music` | Music/audio |
| `activity` | Waveform/monitoring |
| `gauge` | Meter/levels |
| `shuffle` | Mixer/routing |
| `git-merge` | Muxer |
| `git-branch` | Demuxer/splitter |

---

## Ports

Ports define what a module can connect to. Each port has a direction, stream type, and connection limits.

```json
"ports": [
    {
        "id": "audio-in",
        "direction": "input",
        "streamType": "audio/pcm",
        "label": "Audio In",
        "maxConnections": 1
    },
    {
        "id": "mpegts-out",
        "direction": "output",
        "streamType": "muxed/mpegts",
        "label": "MPEG-TS Out",
        "maxConnections": -1
    }
]
```

### Port Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique within module (e.g. `"audio-in"`) |
| `direction` | `"input"` or `"output"` | Yes | Data flow direction |
| `streamType` | `string` | Yes | Stream type — determines valid connections |
| `label` | `string` | Yes | Display label on the module node |
| `maxConnections` | `number` | No | Max connections: `-1` = unlimited (default), `0` = disabled/hidden, `1+` = fixed limit |
| `userConfigurable` | `boolean` | No | If true, user can change `maxConnections` at runtime (e.g. N-1 mixer) |
| `acceptsAnyTs` | `boolean` | No | Display hint for inputs that meaningfully consume EITHER TS family (muxed TS or 302M — e.g. the audio-transcoder's decode input): the UI renders the dot half muxed-orange / half 302M-cyan. Don't set it on plain TS transport pins |
| `acceptsStreamTypes` | `string[]` | No | Exact-match accept list for an input — opts out of TS-family leniency where family-compatible wiring is a dead end (e.g. ts-splitter: `["muxed/mpegts"]` — a 302M stream is valid TS but has nothing to split). Enforced by the engine, mirrored with a toast reason in the UI. Don't set it on TS transport pins (SRT/RIST/IP outputs must keep accepting 302M) |

### Stream Types

| Type | Routing | Description |
|------|---------|-------------|
| `audio/pcm` | PipeWire loopback | Raw audio between PipeWire nodes |
| `audio/302m` | Bus (unixfd) | SMPTE-302M PCM-in-MPEG-TS — timeline-preserving audio (valid TS on the wire) |
| `audio/opus` | Reserved | Encoded Opus audio |
| `audio/aac` | Reserved | Encoded AAC audio |
| `muxed/mpegts` | Bus (unixfd) | MPEG-TS container (audio, video, subs) |
| `video/raw` | Reserved | Raw video frames |
| `video/h264` | Reserved | Encoded H.264 video |
| `video/h265` | Reserved | Encoded H.265/HEVC video |
| `text/subtitle` | Reserved | Subtitle streams |
| `data/generic` | Reserved | Generic data/metadata |

### Connection Rules

- Only `output` → `input` connections are allowed (but users can drag from either side)
- Stream types must match (`audio/pcm` ↔ `audio/pcm`, `muxed/mpegts` ↔ `muxed/mpegts`) —
  the shared rule is `streamTypesCompatible()` in `@media-router/shared-types`
- Exception — the **TS family**: `audio/302m` ↔ `muxed/mpegts` wire in both directions
  (302M is valid MPEG-TS, so it rides SRT/RIST/UDP transports). Ports that want
  stricter intake declare `acceptsStreamTypes` — the 302M mixing/output pins take only
  `audio/302m`-declared sources (route a muxed TS through an Audio Transcoder first)
- Cross-type connections are otherwise blocked (use encoder/decoder to bridge)
- `maxConnections` is enforced on both source and target ports — it is the PLUGIN's
  declaration of what its input can consume (`1` on every muxed/mpegts input: two TS
  streams on one pin are never meaningful; `-1` only where the pipeline actually sums
  its sources). The router core stays policy-free — declarations describe transport,
  not content (an SRT input's `muxed/mpegts` output may well carry 302M from a remote
  device), so only the plugin can know what's mixable
- Rejected connections surface a reason via toast in the routing editor
  (`validateConnection` in `useGraphSync`) — any new wiring rule must return a
  human-readable reason, not silently `false`
- An INPUT port with `maxConnections: -1` and `streamType: audio/302m` can receive N
  sources — consume them with `getModuleBusSources(id).filter(s => s.sinkPortId === ...)`
  and feed `buildAudioMixInput()` (see "Shared 302M audio helpers" — it ships in the
  `audio-302m-core` library plugin) for implicit timeline-true mixing
- Per-connection **channel maps** work on `audio/302m` edges like on `audio/pcm` ones
  (same `ChannelMapEntry[]`, same context menu): the map renders as an
  `audioconvert mix-matrix` on that connection's decode branch — mono→stereo,
  stereo→mono, channel picking, and per-channel gain (which pw-links never honoured).
  A map edit re-executes the edge (consumer restart)

### UI Indicators

| `maxConnections` | Handle | Indicator |
|------------------|--------|-----------|
| `0` | Hidden | Port not shown |
| `1` | Single dot | No indicator |
| `2+` | Single dot | Number shown |
| `-1` (unlimited) | Single dot | ∞ symbol |

---

## Config Schema

Uses JSON Schema to define user-configurable settings. The Manager UI auto-generates a settings form.

```json
"configSchema": {
    "type": "object",
    "properties": {
        "device": {
            "type": "string",
            "default": "",
            "description": "Select audio source device",
            "x-deviceType": "source"
        },
        "codec": {
            "type": "string",
            "enum": ["opus", "aac"],
            "default": "opus",
            "description": "Audio codec"
        },
        "bitrate": {
            "type": "number",
            "default": 128,
            "description": "Bitrate in kbps",
            "x-liveUpdatable": true,
            "x-enumBy": {
                "field": "codec",
                "map": {
                    "opus": [32, 64, 96, 128, 192, 256, 320, 510],
                    "aac": [32, 64, 96, 128, 160, 192, 256, 320]
                }
            }
        },
        "frameSize": {
            "type": "number",
            "enum": [2.5, 5, 10, 20, 40, 60],
            "default": 20,
            "description": "Opus frame size in ms",
            "x-showWhen": "codec=opus"
        },
        "volumeMax": {
            "type": "number",
            "enum": [100, 150, 200, 300, 500],
            "default": 150,
            "description": "Maximum volume slider range (%)"
        },
        "volume": {
            "type": "number",
            "minimum": 0,
            "maximum": 150,
            "default": 100,
            "description": "Volume (%)",
            "x-widget": "slider",
            "x-step": 1,
            "x-live": true,
            "x-maxFrom": "volumeMax"
        }
    }
}
```

### Custom Schema Extensions

| Extension | Type | Description |
|-----------|------|-------------|
| `x-deviceType` | `string` | Device type to populate dropdown from (e.g. `"audio-source"`, `"audio-sink"`, `"video"`, `"drm-connector"`). Plugin must register a matching `DeviceProvider` via `registerServices`. |
| `x-optionsFrom` | `string` | Renders the field as a **multi-select** whose options come from the module's pushed `fieldOptions[<key>]` (set at runtime via `this.setFieldOptions(key, options)`). Use for options discovered from the configured source rather than a fixed enum — e.g. `hls-player` probes the playlist and reports detected audio / subtitle languages. The stored value is a string array. |
| `x-widget` | `"slider"` \| `"imageUpload"` \| `"graph"` | `"slider"` renders a range slider instead of a number input. `"imageUpload"` (string-valued field) renders a file picker that uploads via the `plugin:upload` RPC and stores the resulting absolute path; preview thumbnail loaded back through `plugin:upload-get`. `"graph"` renders plot data the module publishes — see [Graph status fields](#graph-status-fields-x-widget-graph). |
| `x-graph` | `{ section, key, height? }` | **(`x-widget: "graph"` only)** Which status field carries the plot — `statusData[section][key]`, published with `setStatusGraph()`. `height` is the plot height in SVG units (default 150). |
| `x-step` | `number` | Step value for slider |
| `x-live` | `boolean` | Send value changes immediately (no Apply button needed) |
| `x-liveUpdatable` | `boolean` | Mark as live-updatable (same as `x-live`) |
| `x-debounceMs` | `number` | Live-update strategy for slow underlying APIs: only fire after the value has been idle for N ms (default is a 50 ms throttle that fires the first change immediately). Use for sliders where each change is expensive — e.g. `"x-debounceMs": 300` on video bitrate so the encoder isn't reconfigured on every pixel of slider drag. |
| `x-maxFrom` | `string` | Key of another setting that controls slider maximum |
| `x-enumBy` | `{ field, map }` | Field-dependent dropdown options (e.g. `{ "field": "codec", "map": { "opus": [...], "aac": [...] } }`) |
| `x-maxBy` | `{ field, map }` | Field-dependent max for number inputs (e.g. `{ "field": "codec", "map": { "opus": 8, "aac": 6 } }`) |
| `x-showWhen` | `string` | Only show field when condition matches (e.g. `"codec=opus"`) |
| `x-advanced` | `boolean` | **(array-item fields only)** Collapse this property into a per-item **Advanced** section in `MrArrayField`, and treat it as an optional _override_: it is NOT seeded with a default on Add, an absent value means "inherit", and the control offers an explicit way back to inherit ("Inherit (global)" for enums, a ↺ reset button for numbers). Used by the transcoder for per-rendition encoder overrides. |
| `x-contextMenu` | `boolean` | Show this setting in the module's right-click context menu |
| `x-unit` | `string` | Unit label displayed next to the value (e.g. `"%"`, `"kbps"`, `"ms"`) |
| `x-readOnly` | `boolean` | Display as read-only (greyed out, not editable) |

**Array-of-object fields** (`{ "type": "array", "items": { "type": "object", "properties": {...} } }`) render through `MrArrayField`. Inside item schemas, `x-enumLabels`, `x-advanced`, and item-relative `x-showWhen` are honoured — `x-showWhen` is evaluated against the item's own value, falling back to the module-global config when that field is inherited on the item (e.g. show a per-rendition `h264Profile` only when the rendition's codec — its override or the inherited global — is `h264`).

#### Graph status fields (`x-widget: "graph"`)

**The rule: `packages/` contains only generic systems.** A widget in
manager-ui may encode generic presentation (a slider knows min/max/step, the
graph widget knows axes and series) but never a specific module's config keys,
value mappings, or element semantics — those stay in the plugin. **Plugins
compute, the UI renders** (ADR-0007).

So a plugin that wants a curve computes the curve and publishes it as data:

```ts
// engine-side, on config apply and on every live update
this.setStatusGraph('graphs', 'dynamics', {
    axes: {
        x: { label: 'Input', unit: 'dB', min: -60, max: 0, gridStep: 10, labels: [-60, -40, -20, 0] },
        y: { label: 'Output', unit: 'dB', min: -60, max: 0, gridStep: 10, labels: [-60, -40, -20, 0] },
    },
    series: [
        { id: 'unity', points: [[-60, -60], [0, 0]], role: 'muted', stroke: 'dotted' },
        { id: 'transfer', points: curve, role: 'primary' },
    ],
    markers: [{ axis: 'x', value: -20, label: 'Thr -20 dB', role: 'warning', stroke: 'dashed' }],
    live: { x: -12.4, y: -18.1, span: [-18.1, -14.6] },
    notes: ['4:1', 'Attack 5 ms', 'Release 200 ms'],
});
```

```json
"transferCurve": {
    "type": "string",
    "description": "Static transfer curve for the stage below.",
    "x-widget": "graph",
    "x-graph": { "section": "graphs", "key": "dynamics", "height": 150 },
    "x-showWhen": "mode=compressor,gate,expander"
}
```

**The `StatusGraph` contract** (typed in `@media-router/shared-types`, re-exported
from `@media-router/engine`):

| Field | Shape | Notes |
|---|---|---|
| `axes.x` / `axes.y` | `{ label?, unit?, min, max, scale?, gridStep?, labels? }` | `scale: "log"` spaces decades evenly and grids 1-2-5 per decade; `gridStep` grids a linear axis; `labels` are the values that get a printed tick (defaults to the gridlines). The UI never interprets `unit` — it only prints it. |
| `series[]` | `{ id, points: [x, y][], role?, stroke? }` | Points are in axis units, ordered by x, and clamped to the axis when out of range. Draw order is array order. |
| `markers[]` | `{ axis, value, label?, role?, stroke? }` | Reference line across the plot (a threshold, a ceiling, a corner frequency). |
| `live` | `{ x, y, span?, role? }` | Current operating point. `span: [from, to]` shades a band at the same x (e.g. gain reduction). Omit it when there is no telemetry — the dot disappears rather than freezing. |
| `notes[]` | `string[]` | Short annotations under the plot: timings, ratios, "bypassed". Anything the curve deliberately can't show. |
| `role` | `primary` \| `secondary` \| `warning` \| `error` \| `muted` | Theme slot. A publisher names intent, never a colour. |
| `stroke` | `solid` \| `dashed` \| `dotted` | |

Rules of the road:

- **Give graphs their own status section.** `setStatusData` REPLACES a section
  wholesale, so a graph sharing a section with meter fields is wiped on the next
  poll. `setStatusGraph` merges, so several graphs can share one section.
- **Don't declare that section in `statusSections`** unless you want it in the
  stats popup — a graph field is skipped there, and an undeclared section is
  simply not rendered.
- **Republish on every change that moves the curve**: config apply, live
  updates, and (if the graph has a `live` point) the stat poll that produces it.
  Publishing from `onInit` too means a stopped module still draws its curve.
- **Keep it small.** The graph rides the module's runtime state, which is
  rebroadcast on every status change. Sample 60–80 points and round the
  coordinates (`Number(v.toFixed(2))`); nothing plotted at 230 px wide needs
  more.
- **The prop carries no value.** It exists for placement (`x-showWhen` works as
  usual) and never reaches saved settings or the engine config, so give it no
  `default`.

Worked example: `plugins/audio-processing` — `dynamicsCurve.ts` /
`dynamicsGraph.ts` (transfer curve), `eqBiquad.ts` / `eqGraph.ts` (RBJ
magnitude response), `duckEnvelopeGraph.ts` (the ducker's time-domain gain
envelope, on a deliberately non-linear x axis), published through
`graphPublisher.ts`. `duckLive.ts` shows the other half of a live graph: a
telemetry source that ticks far faster than status wants, throttled down to
on-change-only at 4 Hz and silent while there is nothing to say.

#### Context Menu Settings

Add `"x-contextMenu": true` to any numeric/slider setting to display it directly in the module's right-click context menu. This is useful for frequently adjusted settings like volume — users can change them without opening the full settings panel.

```json
"volume": {
    "type": "number",
    "minimum": 0,
    "maximum": 150,
    "default": 100,
    "description": "Volume (%)",
    "x-widget": "slider",
    "x-step": 1,
    "x-live": true,
    "x-maxFrom": "volumeMax",
    "x-contextMenu": true,
    "x-unit": "%"
}
```

The slider appears at the top of the context menu with a live value display. Changes are sent immediately via throttled `module:config` events (50ms throttle) — same as the settings panel's live update mechanism.

#### Array Fields (Dynamic Lists)

Use `type: "array"` with an `items` schema for settings that need add/remove lists (e.g. RIST bonding links, mixer inputs):

```json
"links": {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "address": { "type": "string", "default": "0.0.0.0", "description": "Host / IP" },
            "port": { "type": "number", "default": 5004, "description": "Port" },
            "weight": { "type": "number", "default": 50, "description": "Weight (0-100)" },
            "cname": { "type": "string", "default": "", "description": "CNAME" }
        }
    },
    "default": [{ "address": "0.0.0.0", "port": 5004, "weight": 50, "cname": "link1" }],
    "description": "Connection links"
}
```

The settings panel renders an add/remove list with nested form fields per item. Each item shows all properties defined in `items.properties`.

---

## Status Badges (Module Face)

Plugins can show small icon+text indicators on the module card face using `setBadge()`:

```typescript
// Show a badge (updates live, appears on the module card)
this.setBadge('callers', { icon: 'users', text: '2', color: '#10b981' });
this.setBadge('encrypted', { icon: 'lock', text: 'AES', color: '#8b5cf6' });

// Remove a badge
this.clearBadge('callers');
```

Parameters:
- `id` — unique badge identifier (replaces if same ID)
- `icon` — Lucide icon name in kebab-case (e.g. `'users'`, `'lock'`, `'radio'`, `'wifi'`)
- `text` — short text (1-4 chars works best)
- `color` — CSS color string (defaults to `var(--text-muted)`)

Badges auto-clear when the module stops. Use them for:
- Connection status (SRT caller count, RIST link status)
- Encryption indicators
- Stream health warnings
- Any quick-glance module state

---

## Module Face — Declarative Widgets (`faceWidgets`)

For simple cases where you don't need a full Vue component, declare one or more widgets in the manifest:

```json
"mediaRouter": {
    "faceWidgets": [
        { "id": "stream-info", "type": "status-line", "section": "stream", "template": "{bitrate} kbps · {fps} fps" },
        { "id": "buffer", "type": "meter", "section": "stats", "key": "bufferFill", "color": "#10b981" },
        { "id": "note-text", "type": "setting-text", "setting": "note", "placeholder": "(empty)" }
    ]
}
```

Widgets render inside the module card, between the header and the port labels. Three types are supported:

| Type | Reads from | Fields | Notes |
|---|---|---|---|
| `status-line` | `statusData` | `section`, `template`, `color?` | `{key}` placeholders in `template` are replaced with values from `statusData[section]`. Truncates with ellipsis if too long. |
| `meter` | `statusData` | `section`, `key`, `color?` | Horizontal progress bar. Value from `statusData[section][key]` clamped to 0–100. |
| `setting-text` | `settings` | `setting`, `placeholder?` | Reads a string setting and renders it multi-line, wrapping. Useful for annotations and labels that the user edits directly. |

Declarative widgets are the first choice — they're portable, have no build-time dependencies, and work without touching the manager-ui or local-panel code.

---

## Resizable Modules (`resizable`)

By default every module card on the routing view is a fixed 200px wide and auto-heights to fit its ports. A plugin can opt into user-resizing by adding `resizable` to its manifest:

```json
"mediaRouter": {
    "resizable": true
}
```

Or with explicit bounds (pixels):

```json
"mediaRouter": {
    "resizable": {
        "minWidth": 160,
        "minHeight": 100,
        "maxWidth": 600,
        "maxHeight": 600
    }
}
```

When enabled, a small grip appears in the bottom-right corner of the card. Users drag it to resize; the per-instance size is persisted at `config.modules.<instanceId>.size = { width, height }` and broadcast to every connected browser via the N-1 patch router — so resizes from any tab sync everywhere.

The face component (declarative widgets or `ui/NodeFace.vue`) is given the new container size automatically — use `width: 100%` and let flex/grid handle internal layout. For text-heavy content, consider pairing with a ResizeObserver-based fit (see `plugins/note/ui/useAutoFitText.ts` for a reusable example).

Non-resizable plugins stay fixed — no grip, no size in config, no behaviour change from before.

---

## Plugin UI Components (Vue)

When a declarative widget isn't enough, a plugin can ship its own Vue components. Drop them under the plugin's `ui/` directory:

```
plugins/my-plugin/
├── ui/
│   ├── NodeFace.vue       # Rendered inside the module card on the routing view
│   └── LcpStrip.vue       # Rendered instead of MixerStrip on the LCP
├── engine/
└── package.json
```

Both `manager-ui` and `local-panel` scan `plugins/*/ui/*.vue` at build time via `import.meta.glob`. No manifest entry needed — the directory name is the plugin id; the file name picks the slot.

### `NodeFace.vue`

Rendered inside the node card on the routing view, between the header and port labels. Prop:

```typescript
defineProps<{ module: ModuleState }>(); // from '@/stores/engines'
```

Fits within a ~200px-wide card. Use for custom meters, mini-graphs, annotations — anything that needs real Vue reactivity rather than the declarative widget set above.

### `LcpStrip.vue`

Renders instead of the default `MixerStrip` on the LCP when a plugin provides one. Prop:

```typescript
defineProps<{ module: LcpModuleState }>(); // from '@/stores/modules'
```

Layout target is a ~120px-wide mixer-row cell. `volume` / `mute` emits from `MixerStrip` are optional — the dispatcher wires them up but plugins can ignore them if they don't apply.

### LCP visibility

A module shows up on the LCP when **either** is true:

- the plugin ships a `ui/LcpStrip.vue` (preferred — the strip component itself is the opt-in signal), **or**
- the manifest has an `lcpType` field (any truthy string — the classic path for plugins that use the default `MixerStrip`).

The user can still hide an individual instance at runtime by setting `lcpVisible: false` in its settings. Sort order on the LCP is controlled by the `lcpSortOrder` setting (lower = further left).

### When to use which

- **Declarative widget (`faceWidgets`)** — static text, progress bars, status lines. No plugin UI code to maintain.
- **`NodeFace.vue` / `LcpStrip.vue`** — when you need reactive behaviour, custom layout, input handlers, or dynamic styling that isn't expressible in the JSON widget spec.

Both mechanisms can coexist on the same plugin; widgets render alongside the custom component.

---

## Status Sections (Stats Popup)

Declare sections that appear in a stats popup on the module node. The stats icon only appears when sections are declared AND the engine sends data.

```json
"statusSections": [
    {
        "id": "srt",
        "label": "SRT Connection",
        "fields": [
            { "key": "bitrate", "label": "Bitrate", "unit": "kbps" },
            { "key": "rtt", "label": "RTT", "unit": "ms" },
            { "key": "clients", "label": "Clients" },
            { "key": "loss", "label": "Packet Loss", "unit": "%" }
        ]
    },
    {
        "id": "rist",
        "label": "RIST Output",
        "fields": [
            { "key": "bitrate", "label": "Bitrate", "unit": "kbps" },
            { "key": "quality", "label": "Quality" }
        ]
    }
]
```

---

## Engine Module

Your module class extends `GstPluginBase` which handles GStreamer child process management, VU metering, and lifecycle.

### Lifecycle

```
onInit(config, services) → onStart() → [running] → onStop() → onDestroy()
```

### Plugin Architecture Variants

Not every plugin runs a GStreamer pipeline. `GstPluginBase` supports three architectural patterns. Pick the one that fits, then copy the matching starter (see "Picking a Starting Point" above).

| Variant | `buildPipeline` returns | Process model | Examples |
|---|---|---|---|
| **GStreamer pipeline** | a `PipelineDescription` | Python `gst-pipeline-runner.py` child process spawned by `GstChildProcess` | `audio-decoder`, `audio-encoder`, `srt-input`, `srt-output`, `ts-splitter`, `mpegts-muxer`, `video-encoder`, `video-player`, `audio-input`, `audio-output` |
| **External CLI tool** | `null` | A long-running CLI managed by `services.processManager` (auto-killed on stop) | `rist-input` (`ristreceiver`), `rist-output` (`ristsender`) |
| **PipeWire-only** | `null` | No subprocess — pure PipeWire null-sinks/loopbacks via `services.pipeWire` | `n1-mixer` |

For the two "no-pipeline" variants:

- `super.onStart()` is still safe to call — it skips the child-process setup and returns. You still get health/badge/status-data plumbing and (if the subclass implements `getWatchedDeviceName`) the device watchdog.
- `setElementProperty` / `getElementProperty` / `getElementStats` are no-ops — there's no GStreamer pipeline to read from. Use `processManager` events or PipeWire queries instead.
- `vuData` won't be populated by the base. If you want VU, drive it yourself by reading PipeWire monitor levels.

### Required: `buildPipeline(config)`

Returns a GStreamer pipeline string, or `null` if the module should be idle (e.g. decoder with no encoder connected, or a no-pipeline plugin per the variants table above).

```typescript
buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
    const pipeline = 'pulsesrc ! audioconvert ! opusenc ! mpegtsmux ! udpsink host=239.255.0.1 port=5000';
    return { pipeline };
}
```

### PipelineDescription

```typescript
interface PipelineDescription {
    /** GStreamer pipeline string (gst-launch format). */
    pipeline: string;
    /** When true, stdin/stdout carry binary data (MPEG-TS), not bus messages. */
    useStdioForData?: boolean;
    /** Auto-restart on bus error / EOS. */
    restartOnError?: boolean;
    /**
     * Inner gst-runner restart backoff window. Defaults to 1s → 5s, which
     * pegs CPU when the failure is durable (e.g. SRT caller against an
     * unreachable remote re-spawns Python every few seconds). Tune for the
     * failure mode — SRT plugins ship 5s → 10s.
     */
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
    /**
     * Time-sync contract WITHOUT the base-time pinning (ADR-0005, Stage 3e):
     * for a pipeline whose head is a real live capture feeding an aggregator
     * mux (`v4l2src ! … ! mpegtsmux`). Pinned base-time makes mpegtsmux
     * mis-schedule and burst whole GOPs. Producer-only, measured-need-only —
     * bus-fed producers must NOT set it.
     */
    liveCaptureClock?: boolean;
    /** Dynamic-pad linking rules (tsdemux, decodebin, …). See below. */
    linkOnPadAdded?: PadLinkRule[];
    /** In-runner librist (RIST without the CLI relay) — see rist-input/-output. */
    rist?: RistRunnerConfig;
    /**
     * Report-only TS video-info probe (ts_video_info.py): the runner watches
     * the named appsink (tap the module's egress tee through a LEAKY queue —
     * `busout_<port>. ! queue leaky=downstream max-size-buffers=64 ! appsink
     * name=tsprobe`), discovers the first video ES of the first program and
     * emits `tsprobe:videoinfo` plugin events `{pid, codec, width, height,
     * interlaced, fps, scrambled, display}` — `display` pre-formatted
     * ("1920×1080i50"), geometry null until the SPS parses (H.264/H.265;
     * MPEG-1/2 report codec only). Full scan until the first SPS, then 1-in-64
     * buffer sampling. Any TS-carrying module can adopt it — see
     * `mpegts-ip-input` (input) and `video-player` (which keys its decoder
     * selection off the reported codec). (The ts-splitter gets the same info
     * per routed video PID on `tssplit:videoinfo`, no extra config.)
     */
    tsProbe?: TsProbeRunnerConfig;
    /**
     * Report-only render keep-up watch (render_lag.py): the runner reads the
     * named sink's GstBaseSink `stats` (rendered/dropped counters) per 2 s
     * window and compares the PRESENTED rate against the framerate the
     * negotiated caps declare. Judging pad arrivals instead is a proven blind
     * spot — a sink can receive the full source rate and still discard a
     * third of it internally (waylandsink under a compositor that misses
     * vblanks; observed on Pi 4, 2026-08-01). Pad arrivals gate the
     * judgement (no arrivals = stall watchdog's condition, not lag), and
     * sinks without `stats` fall back to arrival counting. When the chain
     * demonstrably can't sustain the source rate it emits `renderwatch:lag`
     * `{achievedFps, expectedFps, droppedFps}`; on sustained recovery,
     * `renderwatch:recovered`. Hysteresis runner-side (0.85 trip / 0.95
     * recover, 3 consecutive windows). The sink must be NAMED in the
     * pipeline string — see `video-player` (warns the operator to lower the
     * stream or display resolution).
     */
    renderWatch?: RenderWatchRunnerConfig;
    /**
     * Carry the SOURCE PES timeline through the named tsdemux. tsdemux erases
     * the source timeline (buffer PTS rebased ~0 per incarnation), so a
     * transcoding pipeline's output mux stamps a fresh timeline every
     * (re)start and downstream muxers anchor its A/V branches by ARRIVAL —
     * restarts re-roll lipsync. With this set, the runner latches the first
     * PES PTS per PID on the demux sink pad and shifts each media src pad
     * onto the source timeline (`GstPad.set_offset`), so output PES PTS/PCR
     * carry source values and restarts re-derive the SAME timeline. Used by
     * `transcoder` and `audio-transcoder` (default on, per-module toggle).
     * Per-incarnation only: mid-stream source discontinuities and the 26.5 h
     * 33-bit PTS wrap are not followed.
     */
    preserveSourceTimeline?: { demux: string };
}
```

Return `null` to run the module without a GStreamer pipeline (idle state). The module's null-sink stays active but no audio processing runs. Useful for decoders waiting for an encoder connection.

#### Dynamic pad linking (`linkOnPadAdded`)

`gst_parse_launch` does not link sometimes-pads from elements like `tsdemux` or `decodebin` when there is more than one downstream branch per media type. To fan out N outputs, return a `linkOnPadAdded` rule per media type. Each rule lists one parse_launch fragment per matched pad, in pad-added order:

```typescript
return {
    pipeline: 'udpsrc ! tsparse ! tsdemux name=demux',
    linkOnPadAdded: [
        {
            from: 'demux',
            media: 'video',
            branches: [
                'queue ! mpegtsmux ! udpsink port=41001',
                'queue ! mpegtsmux ! udpsink port=41002',
            ],
        },
        {
            from: 'demux',
            media: 'audio',
            branches: ['queue ! mpegtsmux ! udpsink port=41003'],
        },
    ],
};
```

Each branch's first element's sink pad is auto-ghosted, so the rule only needs the downstream elements. Pads beyond the supplied list are ignored.

**Matching pads by PID (`matchPids`).** The default contract is positional — the Nth matching pad links to `branches[N]`, which is fragile when the source can reorder streams or carries extra unrouted PIDs. For MPEG-TS demuxing where each branch belongs to a known PID, set `matchPids: [pid0, pid1, …]` (parsed from the demux pad name `<media>_<prog>_<pidhex>`): `branches[N]` then links to the pad whose PID equals `matchPids[N]`, regardless of pad-added order, and a pad whose PID isn't listed is ignored rather than misrouted. A PID may appear more than once (e.g. a stable PID-based port plus a legacy positional port that maps to the same stream) — the runner fans that pad out through a `tee`, feeding every branch for that PID. `matchPids` and `linkTo` are mutually exclusive (the demuxer branches are self-contained `queue ! mpegtsmux ! udpsink`). This was the (retired) mpegts-demuxer's PID-based port routing (plan Phase 3); the mpegts-muxer's per-PID inputs still use `matchPids`; without it the positional contract is unchanged.

**Pinning an outer muxer's request-pad name (`requestedPadNames`).** With `linkTo`, the runner asks the target for an implicit `sink_%d` pad by default. Pass `requestedPadNames: ['sink_256', …]` to request an exact pad per branch index — the mpegts-muxer uses `sink_<pid>` to pin each stream's PID (plan D3). Indices past the list end fall back to `sink_%d`.

**Bridging branches into an outer named muxer (`linkTo`).** When several dynamic branches need to fan into one shared muxer at the top of the pipeline, the branch can't reference that outer element by name (parse_bin scope is local to the branch). Add `linkTo: '<outer element name>'` and the runner will request a fresh sink pad on that element and link the branch's auto-ghosted src pad to it:

```typescript
return {
    pipeline: 'mpegtsmux name=mux ! udpsink ... udpsrc ! tsdemux name=demux_0 udpsrc ! tsdemux name=demux_1',
    linkOnPadAdded: [
        { from: 'demux_0', media: 'video', branches: ['queue ! h264parse config-interval=1'], linkTo: 'mux' },
        { from: 'demux_0', media: 'audio', branches: ['queue'], linkTo: 'mux' },
        { from: 'demux_1', media: 'video', branches: ['queue ! h264parse config-interval=1'], linkTo: 'mux' },
        { from: 'demux_1', media: 'audio', branches: ['queue'], linkTo: 'mux' },
    ],
};
```

#### In-band metadata carousel (`appsrc` + `setKlvPayload` / `readKlvNames`)

Generic runner mechanism for riding a low-rate metadata buffer alongside a TS,
built for the MPEG-TS muxer/demuxer in-band name channel but not tied to it.
Two halves, both fire-and-forget and report-only — neither can affect routing
or pipeline health:

- **Sender.** Put an `appsrc` (e.g. `appsrc name=klvsrc caps=meta/x-klv,parsed=true format=time is-live=true do-timestamp=true`)
  in the pipeline and call `this.setKlvPayload('klvsrc', payloadString)`. The
  runner stores the payload and re-pushes it onto that appsrc on a ~1 s
  carousel, so late-joining receivers and live edits both converge. Re-call to
  swap the payload (a live config edit), or with an empty string to stop.
  `do-timestamp=true` lets the muxer schedule the packets without you computing
  PTS; never push a zero-length buffer (it aborts). Push once from a
  `stateChange → playing` handler so the first payload appears immediately.
- **Reader.** Set `readKlvNames: true` on the `PipelineDescription`. The runner
  attaches a `queue ! appsink` (the queue is mandatory — an appsink straight on
  a tsdemux pad stalls the whole TS) to every `meta/x-klv` pad and reports the
  raw payload string plus a `malformed` hint on the `stream:names` plugin-event
  channel — handle it in `onPluginEvent` (the demuxer also receives every
  discovered pad on `stream:discovered`). Parsing must be total — a malformed
  payload can never throw out of the handler (warn once, ignore).

The MPEG-TS muxer (`setKlvPayload`) and demuxer (`readKlvNames`) are the
reference consumers; the payload format itself is plugin-defined.

**PCR warning (hard requirement).** A live `do-timestamp` appsrc feeding an
`mpegtsmux` WILL be picked as the mux's PCR stream unless you pin PCR to a
media pad — the receiver's clock then rides your carousel timer instead of the
media and audio drops sporadically (this is what got the muxer's carousel
retired for a while). Always pair the appsrc with a `prog-map` that pins
`PCR_1` to a media `sink_<pid>` (works inline in the launch string:
`mpegtsmux prog-map="program_map,sink_256=(int)1,sink_496=(int)1,PCR_1=sink_256"`),
and always keep a payload pushed once the pipeline is PLAYING — a silent live
pad makes the aggregator wait out its full latency budget.

**Layering rule for in-band stream metadata.** MPEG-TS natively signals codecs
(stream_type + AAC/AC-3/Opus registration/302M-BSSD descriptors) and language
(ISO 639 descriptor, fed by a `taginject tags=language-code=<code>` upstream of
the mux pad — mpegtsmux converts to 639-2B). Put into the KLV channel ONLY what
the standard cannot express: freeform names, and codec identity for private
payloads with no TS mapping (e.g. WebVTT). Use `capsStreamInfo(caps)` from the
engine to classify — its `nativeTs` flag says whether the codec is already on
the wire. Reference: the muxer's `klvPayload.ts` + `MpegTsMuxerModule.pushStreamInfo`.

### Health Status

Plugins can set their health status at any time using `setHealth()`:

```typescript
// Set warning (e.g. no source connected)
this.setHealth('warning', 'No encoder connected');

// Set error
this.setHealth('error', 'Pipeline failed to start');

// Clear (set back to ok)
this.setHealth('ok');
```

Health values: `'ok'` (green dot), `'warning'` (amber dot), `'error'` (red dot), `'stopped'` (grey dot).

The pipeline automatically sets health to `'ok'` when playing and `'stopped'` when null. Plugins override this for custom status (e.g. decoder with no connection → warning).

### Clean Self-Stop (`requestSelfStop`)

A module whose media ran to a **natural end** (e.g. hls-player finishing a VOD
window) should stop cleanly rather than sit in a warning state or respawn-loop
the asset:

```typescript
this.requestSelfStop('Stream ended (playlist complete)');
```

The engine routes this through the same path as a user disable: pipeline down,
connections removed, `enabled=false` — persisted to the manager (patch channel)
so the stop survives config re-pushes and shows in the UI. The stop runs
asynchronously after the current tick, so it is safe to call from process-exit
callbacks. Do **not** use it for faults — crashes should exit non-zero and let
the restart policy handle recovery.

### Static Hooks (Class-Level, Not Instance-Level)

Two optional **static** methods on the module class run **once per plugin class** during engine startup — before any module instances exist. They let a plugin probe the host for capabilities and contribute engine-wide services.

#### `static initManifest(manifest)` — Probe host capabilities

Use when the manifest depends on what the host machine actually supports. The method is called once after the manifest is parsed; mutate `manifest` in place to surface detected capabilities (codec lists, encoder enums, hardware presence flags).

The narrowed `configSchema` you produce here is **per-engine**: the engine advertises it to the manager on connect, so the settings panel shows *that* engine's real capabilities even when the manager runs on different hardware (e.g. an Intel engine's HW encoders appear under an ARM manager). The manager only falls back to its own host probe for engines that don't report (older engine versions). You don't need to do anything to opt in — just narrow the manifest as usual.

```typescript
import { GstPluginBase, probeGstElement, type PluginManifest } from '@media-router/engine';

export class VideoEncoderModule extends GstPluginBase {
    static async initManifest(manifest: PluginManifest): Promise<void> {
        const encoders: string[] = [];
        if (await probeGstElement('v4l2h264enc')) encoders.push('v4l2h264enc');
        if (await probeGstElement('x264enc')) encoders.push('x264enc');
        // Reflect detected encoders into the manifest's configSchema so the
        // settings panel shows only the ones available on this host.
        const schema = manifest.configSchema as { properties?: Record<string, unknown> };
        if (schema.properties?.encoder) {
            (schema.properties.encoder as { enum?: string[] }).enum = encoders;
        }
    }

    // ...rest of the class
}
```

Real examples: [`video-encoder`](video-encoder/engine/VideoEncoderModule.ts) (HW encoder probing), [`audio-encoder`](audio-encoder/engine/AudioEncoderModule.ts) (codec capability), [`video-player`](video-player/engine/VideoPlayerModule.ts) (sink probing).

##### LADSPA-wrapped elements

`findLadspaElement(suffix)` (from `@media-router/engine`) resolves a GStreamer `ladspa` wrapper element by name suffix — e.g. `findLadspaElement('sc-compressor-stereo')`. LADSPA element names embed the plugin's .so filename *including its version* (`ladspa-lsp-plugins-ladspa-1-2-5-so-…`), so never hardcode them; resolve at start and fail with a clear error when null (plugin library not installed). Real example: [`audio-processing`](audio-processing/engine/AudioProcessingModule.ts) (its predecessor [`audio-dynamics`](audio-dynamics/engine/AudioDynamicsModule.ts) is deprecated). Note the wrapper exposes a multi-audio-input plugin as **one interleaved sink pad** (all audio ports in declaration order) — merge streams with `deinterleave`/`interleave` and force `channel-mask=(bitmask)0x0` on the merged caps. Prefer the SELF-keyed LSP variant of a processor (`compressor-stereo`, not `sc-compressor-stereo`) whenever the DSP doesn't need an external key: it takes plain stereo, so the whole interleave dance disappears.

Two more LADSPA facts that cost time to rediscover: control ports carry **no enum nicks and no units**, so anything enum-like (LSP's `filter-type-N`, `filter-mode-N`, `filter-slope-N`) arrives as a bare `gint` and the label↔index map has to live in the plugin (re-check it on any library version bump), and `(G)`-suffixed ports are **linear gain factors, not dB** — convert in the plugin and clamp to the port range from `gst-inspect-1.0` (an out-of-range write is a GObject warning per keystroke). See `audio-processing/engine/lspProcessing.ts`.

##### Shared video-encoder helpers

Codec plugins that emit H.264/H.265/AV1 (video-encoder, transcoder) share the encoder-element knowledge from `@media-router/engine` rather than forking it — don't copy an encoder branch builder into a new plugin, reuse these:

- `ENCODER_ELEMENTS` — the `{codec × impl}` → GStreamer element-name table (`impl` is `v4l2` \| `va` \| `software`).
- `ProbedEncoders` — what the host can encode with. `await ProbedEncoders.probe(ENCODER_ELEMENTS, { probeHwScalers? })` from `initManifest` (gst-inspect results are cached per process); `.applyToManifest(manifest)` narrows the `codec` enum to installed codecs and builds the `encoderImpl` `x-enumBy` map; `.resolve(codec, choice)` turns the operator's `auto`/explicit choice into an installed impl (`auto` prefers `v4l2`, then `software`) or `null`; `.hwScalers` says whether `vapostproc`/`v4l2convert` exist. Start a module's static field from `ProbedEncoders.unprobed()` (no encoder at all — a build before probing fails cleanly). `forTest(availability, hwScalers?)` is the test double.
- `buildEncodeLeaf(opts)` — the shared `queue ! [scale] ! encode ! h26xparse ! mpegtsmux ! sink` tail used by both plugins: `{ encoder: EncoderBranchOptions, inputQueue: 'decoder-pool' | 'none', muxName, sink, scaleStage? }`.
- `buildEncoderBranch(opts)` — one encoder fragment ending at the parsed elementary stream. Options: `{ codec, impl, bitrateKbps, kif, name, rateControl?, speedPreset?, h264Profile?, sceneCut?, cpbSeconds?, interlacedOutput? }` (defaults: CBR for software/VA, `ultrafast`, `auto` profile, scenecut 40). **The `v4l2` (Pi bcm2835) branch ignores `rateControl` and pins VBR** — its CBR mode throttles live encoding to ~10 fps (measured 2026-09-02; see `buildV4l2ExtraControls`). Hide CBR/VBR-only fields on that impl with `"x-showWhen": "encoderImpl=software,va,auto"`, as the video-encoder manifest does. The v4l2 H.264 branch declares level 4.2 (kernel 6.12 validates level vs resolution × fps at STREAMON; 4 rejects 1080p50).
- `buildScaleStage({ width, height, impl, hwScalers, threads? })` — the scale/convert fragment: `vapostproc` (VA memory, must touch the encoder) or `v4l2convert` (Pi 4 ISP) when the impl's own scaler is installed, else software `videoscale ! caps ! videoconvert` (threaded when `threads` is given). Both the transcoder leaf and the video-encoder capture tail use it; probe scalers with `ProbedEncoders.probe(…, { probeHwScalers: true })`.
- `buildV4l2ExtraControls(codec, bitrateBps, kif)` — the `extra-controls` struct for `v4l2h26xenc`, also what a live bitrate update must re-send in full (the driver keeps only the last write). Always `video_bitrate_mode=0` plus `repeat_sequence_header=1` and both GOP controls.
- `parseResolution('1280x720')` — the `resolution` config field parser (defaults to 1080p on garbage). Shared so no plugin re-implements it.

```typescript
static probed: ProbedEncoders = ProbedEncoders.unprobed();

static async initManifest(manifest: Record<string, any>): Promise<void> {
    MyModule.probed = await ProbedEncoders.probe(ENCODER_ELEMENTS);
    MyModule.probed.applyToManifest(manifest);
}
```

Latency-sensitive knobs (SRT `latency`, the player's `bufferMs`, the video-encoder's `cpbSeconds`) are deliberately per-instance settings, not code defaults: SRT latency is a per-link number (10 ms on this LAN, 500–2000 ms on WAN links) and a code default of one of them would be wrong for the other.

##### Rendering to the box's compositor

`ensureWaylandEnv()` (from `@media-router/engine`) seeds `XDG_RUNTIME_DIR` / `WAYLAND_DISPLAY` from the live compositor socket when the engine was launched without a session env (systemd-user). Call it before building any `waylandsink` pipeline; the video-player and mjpeg-monitor share it — never copy the function into a plugin.

##### Shared 302M audio helpers

SMPTE-302M (PCM-in-MPEG-TS) is the timeline-preserving audio transport between modules
— use these instead of hand-rolling pipelines. They live in the **`audio-302m-core`
library plugin**, not in the engine (shared media-domain code belongs to a
`<domain>-core` plugin per [ADR-0001](../docs/adr/0001-plugin-owned-native-and-python-code.md)),
so import them from `@media-router/plugin-audio-302m-core` and declare the dependency:

```json
"dependencies": {
    "@media-router/engine": "workspace:*",
    "@media-router/plugin-audio-302m-core": "workspace:*"
}
```

- `buildAudioMixInput({ sources, channels?, latencyMs?, mixerName?, branchQueueMs? })` —
  N × 302M inputs into one force-live `audiomixer` (running-time/content-aligned mixing;
  a dark input silence-fills instead of stalling the mix), or a direct branch with no
  aggregator at all when there is exactly one source. Returns
  `{ fragment, continuationName }`; continue the chain from `${continuationName}. ! …` —
  that element is a `capsfilter`, an `identity` or a mixer depending on the arm, so never
  hard-code the name. Feed it `getModuleBusSources(id)` entries filtered by your input
  port. PTS-preserving by contract — never add `pulsesrc`, `do-timestamp`, or
  `tsparse set-timestamps` around it.
  `mixerName` is a name PREFIX for the fan-in's elements, not the name of an
  `audiomixer` — the continuation point is always `<mixerName>_out`, and in the
  single-source arm there is no mixer for it to name, only the terminal capsfilter.
  Give it a distinct value per input pin when a module builds more than one fan-in.
- `pacedMixer({ name, latencyNs, caps, pacerName, capsName? })` — the
  `audiomixer force-live=true ! <caps> ! identity sync=true` shape every 302M aggregation
  point uses. The trailing `identity` is load-bearing, not style: a force-live aggregator
  keeps emitting silence after every sink pad has gone EOS, and with no synced element
  downstream it free-runs at CPU speed (11.64 s CPU / 10 s wall on a fleet box, vs 0.07 s
  paced). Build every new mixer through this rather than assembling the string by hand.
  All three fan-in rules — pacing, chaining only from `continuationName`, and the
  single-source bypass — are locked in [ADR-0008](../docs/adr/0008-302m-fan-in-contract.md).
- `build302mEncodeBranch({ format? })` — PCM → 302M-in-TS encode tail
  (`S32LE`/48 kHz/stereo, `avenc_s302m strict=experimental` — ffmpeg gates the encoder;
  the bitstream is standard). Caller appends `buildBusSink(...)`.
- `probe302mSupport()` — the one-call runtime gate for 302M features: probes
  `avenc_s302m` AND `mpegtsmux` accepting `audio/x-smpte-302m` (**gst ≥ 1.26**). Call it
  once from `static initManifest` and cache the flag (real examples:
  [`audio-transcoder`](audio-transcoder/engine/AudioTranscoderModule.ts),
  [`audio-mixer`](audio-mixer/engine/AudioMixerModule.ts)). The underlying
  `gstElementSupportsCaps(element, mediaType)` stays in `@media-router/engine` and is
  available for other caps probes.
- `mixMatrixClause(channelMap, srcChannels, dstChannels)` — a `ChannelMapEntry[]`
  rendered as an `audioconvert mix-matrix` (mono→stereo fan-out, downmix, channel
  picking, per-channel gain). `buildAudioMixInput` applies it per branch; single-source
  modules like `audio-transcoder` inline it on the trunk.
- `applyVolumeLiveUpdate(changes)` (protected on `GstPluginBase`) — the shared
  `volume`/`audioEnabled` live-update for any pipeline with the standard
  `volume name=vol` fader: merges config + drives the element (gst only, no pactl).
  Call it from `onLiveConfigUpdate`; handle extra live params after it.
- `capsStreamInfo(capsString)` — codec id + `nativeTs` flag + channels/rate/language from
  a serialized caps string (e.g. the `caps` field of `stream:discovered` events).
  `nativeTs` drives the in-band metadata layering rule (see the carousel section above):
  natively-signalled codecs never go into KLV. Real example:
  [`mpegts-muxer`](mpegts-muxer/engine/MpegTsMuxerModule.ts).

Burst warning: decoders release audio in ~150 ms PES-batch bursts (source muxers batch
audio PES). A small **leaky** queue downstream of a decoder sheds most of every burst —
severe stutter (measured). Encode-path queues on decoded audio must be NON-leaky; only
real-time capture paths (pulsesrc trickle) tolerate small leaky queues. Real examples:
[`audio-transcoder`](audio-transcoder/engine/audioTranscoderPipeline.ts),
[`audio-output-302m`](audio-output-302m/engine/AudioOutput302mModule.ts),
[`audio-input-302m`](audio-input-302m/engine/AudioInput302mModule.ts),
[`n1-mixer-302m`](n1-mixer-302m/engine/n1Mixer302mPipeline.ts) (N-1 mix-minus matrix
built from these helpers — decode each input once, `tee`, one output mixer per pair).

#### `static registerServices(services)` — Contribute engine-wide services

Use when the plugin **owns** a device type that the manager-UI dropdown should populate from. The method is called once with the full `EngineServices` bundle; register a `DeviceProvider` so any other plugin can target devices of that type via `x-deviceType` in its config schema.

For PipeWire source/sink devices the engine ships a one-line helper:

```typescript
import {
    GstPluginBase,
    registerPipeWireDeviceProvider,
    type EngineServices,
} from '@media-router/engine';

export class AudioInputModule extends GstPluginBase {
    static registerServices(services: EngineServices): void {
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
    }
}
```

A `direction: 'sink'` provider also drives **hardware sink volume normalisation**: on
every poll the engine resets any non-`MR_PW_*` sink that isn't at unity gain back to
100% on all channels. Gain staging is a software concern — attenuate on your own
`MR_PW_*` node or in GStreamer, never by turning a hardware sink down, or your
attenuation will stack on top of whatever WirePlumber restored (commonly 40%). See
[ADR-0006](../docs/adr/0006-hardware-sinks-held-at-unity-gain.md).

For non-PipeWire devices (V4L2, DRM, custom hardware), register a raw provider:

```typescript
static registerServices(services: EngineServices): void {
    services.deviceProviders.register({
        type: 'drm-connector',
        pollMs: 0, // disable polling — DRM connectors don't hot-plug
        list: () => listDrmConnectors(),
    });
}
```

If enumerating the devices is **expensive**, make it demand-driven rather than
paying for it on every poll. V4L2 is the worked example: `v4l2-ctl` runs once for
the listing plus twice per `/dev/video*` node, which on a Pi (a dozen-plus ISP and
codec sub-devices) measured 12.4% of a core burnt continuously — on hosts with no
video module at all. `registerV4l2DeviceProvider` therefore serves a cached list
while nothing needs it, refreshing once per `V4L2_IDLE_ENUMERATE_MS` so hot-plug
still lands, and returns to the full 2 s cadence while at least one instance holds
a claim:

```typescript
export class VideoEncoderModule extends GstPluginBase {
    static registerServices(services: EngineServices): void {
        registerV4l2DeviceProvider(services);
    }

    constructor() {
        super();
        acquireV4l2Demand(); // instantiated, not started: a stopped module still shows a picker
    }

    async onDestroy(): Promise<void> {
        releaseV4l2Demand();
        await super.onDestroy();
    }
}
```

A module that is about to START a V4L2 capture pipeline calls `suspendV4l2Enumeration(ms)` first (from `onStart`, only when a device is configured — see the video-encoder): opening ANY `/dev/video*` node while a pipeline that uses the bcm2835 codec blocks is setting up wedges it or fails `v4l2src`'s buffer allocation, and every `v4l2-ctl` the provider spawns opens every node. The blackout is a window (10 s covers probe + spawn + reach-PLAYING), not a lock, and the cached list is served meanwhile. Don't call it from `buildPipeline`: that also runs for unconfigured modules (it would freeze the picker the operator is browsing) and from `refreshPipelineDescription`, which never re-enters V4L2 setup.

Gate inside `list()`, not on the poll timer: the registry's timer is not the only
caller — the manager heartbeat re-sends every device snapshot through
`getDevices()`, which calls `list()` directly.

Any plugin's config schema can then point at the registered type:

```json
"configSchema": {
    "properties": {
        "display": { "type": "string", "x-deviceType": "drm-connector" }
    }
}
```

Real examples: [`audio-input`](audio-input/engine/AudioInputModule.ts) / [`audio-output`](audio-output/engine/AudioOutputModule.ts) (audio-source/sink), [`video-encoder`](video-encoder/engine/VideoEncoderModule.ts) (V4L2), [`video-player`](video-player/engine/VideoPlayerModule.ts) (DRM connectors).

### Dynamic Ports (`getDynamicPorts`)

When a plugin's port count depends on its config (e.g. an N→M mixer where the user controls N and M), override `getDynamicPorts()` on the instance. The engine calls it every time the module's ports are queried — leave the manifest's `ports` field empty, and `getDynamicPorts` becomes the source of truth.

```typescript
getDynamicPorts(): Array<{
    id: string;
    direction: 'input' | 'output';
    streamType: string;
    label: string;
    maxConnections?: number;
}> {
    const pairCount = (this.config.pairCount as number) ?? 4;
    const ports: ReturnType<typeof this.getDynamicPorts> = [];
    for (let i = 0; i < pairCount; i++) {
        ports.push({ id: `in-${i}`, direction: 'input', streamType: 'audio/pcm', label: `In ${i + 1}` });
        ports.push({ id: `out-${i}`, direction: 'output', streamType: 'audio/pcm', label: `Out ${i + 1}` });
    }
    return ports;
}
```

Triggering regeneration: changing a config field that affects port count (e.g. `pairCount`) is enough — the `patchRules` cascade re-emits the dynamic ports and prunes any connections to ports that no longer exist.

**Plugin-driven port changes (`emitConfigUpdate` → live refresh).** A plugin can write its own config to persist runtime discoveries (ts-splitter writing the streams it discovers into a `discoveredStreams` array) via `this.emitConfigUpdate({ key: value })` — this persists to SQLite and broadcasts to the UI. When the changed key affects the port set, the engine re-resolves `getDynamicPorts` off the back of that update and pushes a `/modules/<id>/ports` patch, so the new ports appear on the open Vue Flow node **without a reload**. Debounce these writes (only `emitConfigUpdate` when the discovered set actually changed) so a steady detection loop doesn't spam SQLite. Discovery should populate config, never replace it: don't auto-remove an entry when its stream disappears — keep it and render the port stale, so downstream connections survive a source going dark.

For plugins where each port maps to a distinct PipeWire node (rather than one shared null-sink for the whole module), also implement `getPipeWireNodeForPort(portId)`:

```typescript
getPipeWireNodeForPort(portId: string): { source?: string; sink?: string } {
    // e.g. each output port has its own remap-sink named MR_PW_<instanceId>_<portId>
    return { sink: `${this.pwNodeName}_${portId}` };
}
```

Real examples: [`n1-mixer`](n1-mixer/engine/N1MixerModule.ts) (per-port PipeWire nodes), [`ts-splitter`](ts-splitter/engine/TsSplitterModule.ts) and [`mpegts-muxer`](mpegts-muxer/engine/MpegTsMuxerModule.ts) (dynamic outputs/inputs based on stream counts).

### Live Input Swap (`getLiveInputSwap`)

By default, adding or removing a `muxed/mpegts` connection **restarts the sink
module** (its `buildPipeline` must re-run). For a SINGLE-INPUT module whose
pipeline shape does not depend on which source feeds it, that restart is pure
damage: the module's own producer sockets close and every downstream consumer
restarts too (the head-end switch cascade). Opt out by declaring the input
`unixfdsrc` swappable:

```typescript
getLiveInputSwap(sinkPortId: string): { element: string } | null {
    return sinkPortId === INPUT_PORT_ID ? { element: INPUT_SRC_NAME } : null;
}
```

The engine then handles a source re-wire make-before-break: the removed edge
stays attached for a 15 s window (module health shows a warning); a matching
add re-points the input at the new edge socket via a tracked `bus_reinput`
RPC — outputs and downstream consumers never notice. Window expiry (a plain
disconnect) runs the classic teardown. Only declare this for ports where a
source swap changes NOTHING in the module's shape besides the input socket;
modules whose branch set depends on the source (mpegts-muxer) must keep the
restart.

The RPC target defaults to the gst child process (the runner re-points the
named `unixfdsrc`). A NATIVE sink (no GStreamer pipeline) overrides
`getLiveSwapTarget()` with a `NativeSinkController` — the engine then sends
its child a `{"cmd":"reinput","socket":…}` stdin verb and awaits
`reinput_done`. Real example: [`ts-splitter`](ts-splitter/engine/TsSplitterModule.ts),
whose data path is the native `mr-tssplit` child (the plugin's own
`native/mr-tssplit/`, resolved at runtime with
`resolveNativeBinary('mr-tssplit', 'ts-splitter')` — see "Native & Python
code in plugins" for the resolution order).

`NativeSinkController` also exposes `addOutput(pid, tee)` for a producer whose
output set is fixed at spawn: a port discovered mid-run is declared on the
RUNNING child (`{"cmd":"add_output",…}` → `output_added`) instead of forcing
the `materializeProducerPort` restart. The module allocates the bus channel at
discovery time, so the engine finds the port already assigned and never has to
bounce the producer. A rejected/timed-out verb simply leaves the port
undeclared — the restart path still materialises it.

### Device Watchdog (Hardware Hot-Plug)

Plugins bound to a specific hardware device (USB mic, HDMI display, V4L2 camera) can opt into a hot-plug watchdog that polls PipeWire every 2 s and calls subclass hooks on disconnect/reconnect. Override `getWatchedDeviceName()` to enable; the base class handles the polling.

```typescript
export class AudioInputModule extends GstPluginBase {
    private deviceName = '';

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';
    }

    // Return the PipeWire device name to watch (or null to disable).
    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    // Called when the device disappears — teardown PipeWire nodes etc.
    protected async onDeviceDisconnected(): Promise<void> {
        if (this.remapModuleId !== null) {
            await this.services!.pipeWire.unloadModule(this.remapModuleId);
            this.remapModuleId = null;
        }
    }

    // Called when the device reappears — rebuild whatever onDeviceDisconnected tore down.
    protected async onDeviceReconnected(): Promise<void> {
        this.remapModuleId = await this.services!.pipeWire.loadRemapSource(/* ... */);
    }

    async onStart(): Promise<void> {
        await super.onStart();
        this.startDeviceWatchdog(/* initiallyConnected */ true);
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
        await super.onStop();
    }
}
```

The base class flips `health` to `'error'` on disconnect and back to `'ok'` once `onDeviceReconnected` resolves. If reconnection throws (e.g. the device returned but format probing failed), the watchdog stays in "disconnected" mode so the next tick retries.

Real examples: [`audio-input`](audio-input/engine/AudioInputModule.ts), [`audio-output`](audio-output/engine/AudioOutputModule.ts), [`video-encoder`](video-encoder/engine/VideoEncoderModule.ts).

### Live-Updatable Settings: `liveUpdatableParams` vs `x-liveUpdatable`

Two paths exist for marking a setting as live-updatable (changeable without restarting the pipeline). Use **both** for clarity, or prefer the manifest flag.

- **Manifest flag** — `"x-liveUpdatable": true` (or `"x-live": true`) on the field in `configSchema`. This is the declarative default; the manager-UI uses it to skip the Apply button and the engine uses it to route the change to `onLiveConfigUpdate` rather than restarting.
- **Code property** — `protected liveUpdatableParams: string[] = ['volume', 'bitrate']` on the module class. This is the runtime override path. `GstPluginBase.getLiveUpdatableParams()` returns this array; subclasses can override the method to compute it dynamically (e.g. `video-encoder` only marks `bitrate` live when the current codec supports it).

When the two disagree, the runtime `getLiveUpdatableParams()` result wins for behaviour, but the manifest flag still controls UI affordances. Keep them aligned unless you have a runtime reason to diverge.

### Playout Offset D (`playoutOffsetMs`)

Under the engine-wide time-sync contract, producers stamp bus buffer PTS with house-clock media time and every **presentation sink schedules at `stamped-time + D`**, where D is the *playout offset* — a configured latency budget, not a best-effort. See ADR-0005 decision 4.

Two knobs, and neither of them lives on the sink:

- **Engine-wide default** — `EngineConfig.playoutOffsetMs` (300 ms; `MR_PLAYOUT_OFFSET_MS` is the env fallback). Reaches every module as `services.playoutOffsetMs`.
- **Per-route override** — a `playoutOffsetMs` property on the **route head**: the producer module the consumers take their bus from. Declare it in that plugin's `configSchema` (no `default` — an absent value means "inherit the engine default") and list it in `liveUpdatableParams`. The producer itself never reads it; the engine resolves it for the consumers and fans a change out to all of them live.

**Consuming it.** A presentation plugin never does this arithmetic itself:

```ts
import { effectivePlayoutOffsetNs } from '@media-router/engine';

// In buildPipeline: `trimMs` is the module's own per-sink trim, if it has one.
const tsOffsetNs = effectivePlayoutOffsetNs(this.services, { trimMs: lipSyncMs });
// → contract OFF: just the trim (legacy behaviour, unchanged)
// → contract ON:  route override ?? engine default ?? 300, plus the trim
```

Then name the sink and re-push on the hot-update path:

```ts
async onRoutePlayoutOffsetChanged(): Promise<void> {
    await this.setElementProperty('sink', 'ts-offset', effectivePlayoutOffsetNs(this.services));
}
```

Two rules make this work:

1. **One resolver.** Both legs of a route (e.g. a video-player and an audio-decoder split off one ts-splitter) call `effectivePlayoutOffsetMs` against the same route, so they get the same D by construction. Re-implementing the arithmetic in a plugin is the bug this exists to prevent.
2. **Trims stack, they don't replace.** `lipSyncMs` / `syncOffsetMs` are deprecated as sync controls and survive as per-sink trims added on top of D — for skew a specific display or DAC chain adds, which D cannot know about.

### Interacting with the GStreamer Pipeline

Media Router uses a **Python GStreamer runner** (`gst-pipeline-runner.py`) instead of `gst-launch`. This gives plugins programmatic access to the running pipeline via `GstPluginBase` methods.

#### Architecture

```
Plugin (TypeScript)
    │ this.setElementProperty('enc', 'bitrate', 256000)
    ▼
GstChildProcess (Node.js)
    │ IPC request → gst-runner.ts
    ▼
gst-runner.ts (forked child)
    │ JSON command → stdin/fd3
    ▼
gst-pipeline-runner.py (Python)
    │ pipeline.get_by_name('enc').set_property('bitrate', 256000)
    ▼
GStreamer C library (live property change on running pipeline)
```

#### Element Naming

GStreamer auto-names elements as `elementtype0`, `elementtype1`, etc. To target a specific element, use the `name=` property in your pipeline string:

```typescript
// In buildPipeline():
const pipeline = 'pulsesrc ! opusenc name=enc bitrate=128000 ! mpegtsmux ! udpsink name=usink ...';
```

Now you can reference `enc` and `usink` by name.

#### Set Element Property (Live, No Restart)

Change a GStreamer element property on a running pipeline:

```typescript
// Change encoder bitrate without restarting
await this.setElementProperty('enc', 'bitrate', 256000);

// Change volume on a GStreamer volume element
await this.setElementProperty('vol', 'volume', 0.5);
```

Live values are **sticky across restarts**: the engine records the last value
set per element property and replays them on every PLAYING transition. A
crash-restart rebuilds the pipeline from the original string (start-time values
only), so without the replay live changes would silently revert. Calling
`setElementProperty` while the pipeline is down or mid-restart is also safe —
the value is recorded and applied on the next PLAYING. If your module drives an
element from its own control loop and assumes a fresh element state after a
restart (e.g. the audio-dynamics ducker's `volume`), re-seed explicitly in
`onPipelinePlaying()` — the replayed value wins otherwise.

#### Get Element Property

Read a property value from a running element:

```typescript
const bitrate = await this.getElementProperty('enc', 'bitrate');
// Returns: 256000

const bytesServed = await this.getElementProperty('usink', 'bytes-served');
// Returns: 1234567 (for udpsink)
```

#### Getting data back from the pipeline (generic `pluginEvent` channel)

When a plugin needs the runner to stream data *back* — not just answer a one-shot `getElementProperty` — use the generic pipeline→plugin data channel instead of adding a bespoke event type through every layer. The runner emits `{channel, payload}`; the base class forwards it verbatim to your `onPluginEvent(channel, payload)` hook. A new kind of data needs an emitter in the runner and a `case` in your handler — **no changes to GstRunner / GstChildProcess / GstPluginBase**.

The built-in producer is **bus-message subscriptions**: for each `{element, structure}` in `PipelineDescription.busReports`, the runner forwards that element's matching ELEMENT bus messages on channel `<structure>:<element>` (payload = the GstStructure as an object). This is fully generic — `level`, `spectrum`, QoS, element stats messages all work with no runner change; a subscribed `level` element is forwarded instead of folding into the aggregate VU meter. Build any control loop on top — metering, gating, AGC, or ducking:

```typescript
buildPipeline() {
    return {
        pipeline: `pulsesrc device=${sc}.monitor ! audioconvert ! ` +
            `level name=sclevel post-messages=true interval=15000000 ! fakesink sync=false ...`,
        busReports: [{ element: 'sclevel', structure: 'level' }],   // stream this element's level back
    };
}

protected onPluginEvent(channel: string, payload: unknown): void {
    if (channel !== 'level:sclevel') return;
    const keyDb = Math.max(...(payload as { rms: number[] }).rms);
    // …drive your own envelope / control loop, e.g. this.setElementProperty('vol','volume', g)
}
```

Real example: [`audio-dynamics`](audio-dynamics/engine/AudioDynamicsModule.ts) (ducker mode) keys its gain envelope off `level:sclevel` and rides a `volume` element — an exact-floor sidechain ducker built from stock `level`/`volume`, no LADSPA. If your control loop must survive a runner crash-restart (which rebuilds the pipeline from the original string), re-seed it in `onPipelinePlaying()` — it fires on every PLAYING transition, including restarts.

#### Get Element Stats (GstStructure)

Some GStreamer elements expose a `stats` property as a GstStructure (e.g. `srtsrc`, `pulsesink`). This method reads it and converts to a JavaScript object:

```typescript
const stats = await this.getElementStats('srtsrc0');
// Returns: { 'packets-sent': 1234, 'rtt-ms': 5.2, 'pkt-loss-total': 0, ... }

const sinkStats = await this.getElementStats('pulsesink0');
// Returns: { 'rendered': 5000, 'dropped': 0, 'average-rate': -1.0 }
```

#### Live Config Updates

Override `onLiveConfigUpdate` to handle settings changes without pipeline restart. Declare which params are live-updatable:

```typescript
protected liveUpdatableParams = ['volume', 'bitrate'];

async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
    // Volume: set on PipeWire null-sink (not GStreamer)
    if ('volume' in changes && this.services?.pipeWire) {
        await this.services.pipeWire.setSinkVolume(this.pwNodeName, changes.volume as number);
    }
    // Bitrate: set directly on the GStreamer encoder element
    if ('bitrate' in changes) {
        await this.setElementProperty('enc', 'bitrate', (changes.bitrate as number) * 1000);
    }
    Object.assign(this.config, changes);
}
```

#### Status Data (Stats Popup)

Plugins can send live data to the stats popup on the module node. First, declare `statusSections` in the manifest (see above). Then call `setStatusData()` to push values:

```typescript
// Set static config info
this.setStatusData('encoder', {
    codec: 'opus',
    bitrate: 128,
    sampleRate: 48000,
});

// Set UDP endpoint info
this.setStatusData('udp', {
    host: '239.255.0.1',
    port: 40000,
});
```

Values are coerced to primitives. For structured PLOT data — a transfer curve,
a frequency response — use `setStatusGraph(section, key, graph)` instead: same
channel and same store, but the value keeps its shape so a `x-widget: "graph"`
settings prop can render it. See
[Graph status fields](#graph-status-fields-x-widget-graph). Note that
`setStatusData` replaces a section wholesale while `setStatusGraph` merges into
one, so graphs want a section of their own.

#### Polling Live Stats — `ThroughputPoller`

For output-bitrate stats, use the shared `ThroughputPoller` (from `@media-router/engine`) instead of hand-rolling a `setInterval` + `lastBytes`/`lastPollTime` bookkeeping. Construct it with a `getBytes` reader and a `publish` callback, then `start()` in `onStart` and `stop()` in `onStop`:

```typescript
import { GstPluginBase, ThroughputPoller, type ThroughputSample } from '@media-router/engine';

export class MyEncoderModule extends GstPluginBase {
    private readonly throughput = new ThroughputPoller({
        // Return the cumulative byte counter, or undefined when idle/unavailable.
        getBytes: async () => {
            const served = await this.getElementProperty('usink', 'bytes-served');
            return typeof served === 'number' ? served : undefined;
        },
        publish: (s: ThroughputSample) =>
            this.setStatusData('throughput', {
                'Output Bitrate': `${s.bitrateKbps} kbps`,
                'Total Bytes': `${(s.totalBytes / 1024 / 1024).toFixed(1)} MB`,
            }),
        // intervalMs defaults to 2000
    });

    async onStart(): Promise<void> { await super.onStart(); this.throughput.start(); }
    async onStop(): Promise<void> { this.throughput.stop(); await super.onStop(); }
}
```

The poller owns the timing so every plugin gets the same correct behaviour:

- **Idle skip** — when `getBytes` returns `undefined` (pipeline not playing yet), the tick is skipped and nothing is published, so an idle module stops emitting spurious "0 kbps" updates.
- **Where the bytes are counted.** For a producer's `busout_*` tee under the time-sync contract, the runner reads the native `mrtsstamp` element's `bytes-total` property (it is spliced in front of every egress tee and counts in C, armed or in passthrough). Everything else — including every producer when the time-sync contract is OFF (no element spliced) — falls back to a pad probe that is buffer-LIST aware, which does not help on that tee: the lists are already dismantled there, so the per-buffer cost returns whenever the contract is off. Never add a per-buffer python probe on an egress path: `capssetter`/`capsfilter` dismantle the mux's buffer lists into ~1170 single buffers/s at 12 Mbps, and the old BUFFER-only probe there cost 0.5–0.7 of a core PER PRODUCER (a Pi 4 at 60 % busy fell to 26 % without it, 2026-09-02).
- **Counter-reset guard** — if a byte counter drops below its previous sample (the child was re-spawned via `restartOnError` and `udpsink` reset `bytes-served` to 0), that counter's delta clamps to 0 instead of reporting a negative rate. Guarded per counter.
- **Multiple counters** — `getBytes` may return a `Record<name, bytes>` instead of one number (one entry per sink); `publish` then receives `(total, counters)` with a per-counter `ThroughputSample` breakdown alongside the aggregate. Read the counters with `Promise.all` and return `undefined` if *any* is unavailable (a partial read would misreport rates). Real example: the transcoder publishes one bitrate row per rendition plus a Total from a single poller.

**Important:** The `key` in `setStatusData` must match the `key` field in the manifest's `statusSections.fields[]`. Mismatched keys will show "—" in the UI.

#### SRT Stats Example (Future)

When building an SRT plugin, the `srtsrc`/`srtsink` elements expose rich stats:

```typescript
// Poll SRT stats every 1s
this.statsTimer = setInterval(async () => {
    const stats = await this.getElementStats('srtsrc0');
    this.setStatusData('srt', {
        'RTT': `${stats['rtt-ms'] ?? 0} ms`,
        'Packet Loss': stats['pkt-loss-total'] ?? 0,
        'Bandwidth': `${((stats['mbps-bandwidth'] as number) ?? 0).toFixed(1)} Mbps`,
        'Clients': stats['callers-count'] ?? 0,
    });
}, 1000);
```

### Stream Probing

For modules that receive external streams (e.g. SRT input), probe the stream to detect the codec before building the pipeline:

```typescript
import { probeMpegTsStream, type ProbeResult } from '@media-router/engine';

private probeResult: ProbeResult | null = null;

async onStart(): Promise<void> {
    // Probe the stream
    this.probeResult = await probeMpegTsStream('239.255.0.1', 40000, 3000);
    // probeResult = { codec: 'opus' | 'aac' | 'mp2' | 'ac3' | 'unknown', sampleRate, channels, rawCaps }

    // Use the result in buildPipeline
    await super.onStart();
}

buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
    let decoder: string;
    switch (this.probeResult?.codec) {
        case 'opus': decoder = 'opusdec'; break;
        case 'aac': decoder = 'avdec_aac'; break;
        case 'mp2': decoder = 'mpegaudioparse ! mpg123audiodec'; break;
        default: decoder = 'decodebin'; break;
    }
    // ...
}
```

Always probe the stream — this detects both codec and channel count regardless of source (local encoder, SRT, RIST, external):

```typescript
const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);
if (udpSource) {
    this.probeResult = await probeMpegTsStream(udpSource.host, udpSource.port, 3000);
    // probeResult.codec: 'opus' | 'aac' | 'mp2' | 'ac3' | 'unknown'
    // probeResult.channels: number | undefined (opus includes it, AAC doesn't)
    // probeResult.sampleRate: number | undefined
}
// For channels not in probe caps (e.g. AAC), fall back to encoder config:
const channels = probeResult?.channels ?? udpSource?.channels ?? this.config.channels ?? 2;
```

---

## PipeWire Integration (Audio Modules)

Audio modules create a named PipeWire null-sink for routing:

```typescript
export class MyAudioPlugin extends GstPluginBase {
    async onStart(): Promise<void> {
        if (this.services?.pipeWire) {
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId, 2, 48000  // name, channels, rate
            );
        }
        await super.onStart();
    }

    async onStop(): Promise<void> {
        await super.onStop();
        if (this.paModuleId !== null && this.services?.pipeWire) {
            await this.services.pipeWire.unloadModule(this.paModuleId);
            this.paModuleId = null;
        }
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        return { source: `${this.pwNodeName}.monitor` };
    }
}
```

### PipeWire Node Naming

- Null-sink name: `MR_PW_{instanceId}` (e.g. `MR_PW_audio-input-abc123`)
- Monitor source: `MR_PW_{instanceId}.monitor`
- Access via `this.pwNodeName` (computed from `this.services.instanceId`)

### Volume Control

Set volume on PipeWire devices or null-sinks:

```typescript
// Set source volume (e.g. microphone)
await this.services.pipeWire.setSourceVolume('alsa_input.usb-...', 120);

// Set sink volume (e.g. null-sink for encoder/decoder)
await this.services.pipeWire.setSinkVolume(this.pwNodeName, 100);
```

Volume is in percentage (0-500+).

---

## The Inter-Module Bus (Generic Plugin Infrastructure)

Inter-module routing of `muxed/mpegts` (and `audio/302m`) streams uses GStreamer unixfd IPC: a producer ends in a fan-out `tee` (`buildBusSink`), the engine attaches one `queue leaky=2 ! unixfdsink` branch per consumer edge at runtime, and each consumer reads its own edge socket (`buildBusSrc`). `MediaRouter` allocates a **bus channel** (a port number that keys every socket path and the tee name — it never binds a socket) from a generic pool used by **any** plugin that produces or consumes a bus stream — encoders, demuxers, muxers, SRT in/out, RIST in/out. The API is plugin-agnostic; nothing about it is encoder-specific.

| Method on `services.mediaRouter` | Purpose |
|---|---|
| `assignBusChannel(instanceId, portId?)` | Acquire a channel for this module (or a specific output port for multi-port plugins). Returns `{ port }` or `null` if the pool is exhausted. |
| `getBusChannel(instanceId, portId?)` | Re-read a previously-assigned channel (e.g. when the same plugin builds the pipeline a second time). |
| `releaseBusChannel(instanceId, portId?)` | Release one specific slot. |
| `releaseAllBusChannelsFor(instanceId)` | Release the bare slot **and** every per-port sub-slot. Called automatically on module stop. |
| `getModuleBusSource(sinkModuleId, sinkPortId?)` | From the *consumer* side: find the upstream producer's channel + this consumer's edge `socketPath` for a given input port. Returns `undefined` if no connection. |

### Producer pattern (encoder, muxer, SRT-in re-broadcasting…)

```typescript
import { buildBusSink } from '@media-router/engine';

buildPipeline(config: Record<string, unknown>): PipelineDescription {
    const instanceId = this.services?.instanceId ?? '';
    const endpoint = this.services?.mediaRouter?.assignBusChannel(instanceId);
    const busSink = endpoint ? buildBusSink(endpoint.port) : 'fakesink sync=false';

    return { pipeline: `... ! mpegtsmux latency=0 alignment=7 ! ${busSink}` };
}
```

For per-output-port allocation (e.g. MPEG-TS demuxer with N outputs), pass a `portId`:

```typescript
const ep = router.assignBusChannel(instanceId, 'audio-0');
```

### Producer pattern from Node (no GStreamer): paced sink + the unixfd fan-out sidecar

When the MPEG-TS bytes originate in Node (not in a GStreamer pipeline — e.g. hls-player's hls-pipe runner), the module publishes through the fan-out sidecar's ingest socket. **The data path** is `PacedUnixStreamTsSink` from `@media-router/engine` (`PacedTsSink` pacing core: ~60 s read-ahead with back-pressuring `write`, 2 s pre-fill, stall re-anchor — so whole-segment bursts never overrun the sidecar's per-consumer queues):

```typescript
import { PacedUnixStreamTsSink, busIngestSocketPath } from '@media-router/engine';

const sink = new PacedUnixStreamTsSink(busIngestSocketPath(endpoint.port));
await sink.write(tsBytes, segmentDurationSec); // blocks only when the read-ahead buffer is full
await sink.end(); // flush whole packets at media rate, then close
```

Use the `port` from `assignBusChannel` / `getBusChannel` — never hardcode socket paths. Chunks are queued zero-copy: hand over ownership and don't mutate the buffer after `write`.

**The unixfd fan-out** stands in for the gst producer's `tee ! queue leaky=2 ! unixfdsink` branches: it ingests the paced TS stream and serves each consumer edge socket with the GstUnixFd protocol (memfd + SCM_RIGHTS, CAPS-first, per-client 500 ms leaky queues). Two interchangeable implementations exist, both shipped by the `unixfdbus-core` library plugin — the native `mr-bus-fanout` (`unixfdbus-core/native/`, preferred) and the pure-stdlib `unixfd-fanout.py` (`unixfdbus-core/py/`, used when the binary is absent). They share a CLI, control verbs and events, and the conformance suite runs both against the same protocol clients, so `resolveNativeBinary('mr-bus-fanout', '<your-plugin-id>')` picking either is invisible to the module. The module wires it up with `UnixFdFanoutController` and hands the controller to the engine via `getBusAttachTarget()` — the `BusFanoutCoordinator` then drives `bus_attach`/`bus_detach` exactly as it does for gst producers:

```typescript
getBusAttachTarget(): BusAttachTarget | null {
    return this.fanoutController;
}

// onStart: spawn the sidecar and bridge its stdio to the controller
this.fanoutController = new UnixFdFanoutController(
    () => this.fanout,
    () => this.services?.mediaRouter?.onProducerPlaying(this.services.instanceId), // reattach on every sidecar ready
);
this.fanout = this.spawnRunnerProcess({
    label: 'unixfd-fanout',
    command: 'python3',
    args: [script, '--ingest', busIngestSocketPath(port), '--caps', TS_CAPS],
    autoRestart: true,
    stdin: true, // controller sends bus_attach/bus_detach as JSON lines
    onStdout: (line) => this.fanoutController?.handleLine(line),
});
```

The controller keeps the desired edge set and replays it on every sidecar `ready`, so sidecar crashes/restarts heal without engine involvement. Because the sidecar (not the data child) owns the edge sockets, consumers survive data-child relaunches (e.g. hls URL changes) with only a stream gap. See `plugins/hls-player/engine/HlsPlayerModule.ts` for the full reference implementation.

### Consumer pattern (decoder, muxer input, SRT-out…)

Consumers return `null` from `buildPipeline` when no upstream is connected. The router restarts them when a connection is made.

```typescript
buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
    const source = this.services?.mediaRouter?.getModuleBusSource(instanceId);
    if (!source) {
        this.setHealth('warning', 'No encoder connected');
        return null;
    }
    const busSrc = buildBusSrc({ port: source.port, socketPath: source.socketPath });
    return { pipeline: `${busSrc} ! tsdemux latency=0 ! opusdec ! ...` };
}
```

### The time-sync contract (producer-stamped bus timing)

Everything on the bus rides the engine-wide time-sync contract: every process
shares one monotonic house clock, pipelines pin `base_time=0` so running-time
≡ house-clock time, and **producers — not consumers — stamp bus buffer
PTS/DTS with house-clock media time**. Every consumer therefore inherits
identical timing by construction, and presentation sinks schedule at
`stamped-time + D` (see "Playout Offset D (`playoutOffsetMs`)" above). Full
design and the rejected alternatives:
[`docs/adr/0005`](../docs/adr/0005-time-sync-backend.md).

**On by default; one whole-engine kill-switch.** `MR_TIME_SYNC_CONTRACT=0`
turns the contract off (`'1'` pins it on); flag-off reproduces the legacy
pipeline strings byte for byte. There is deliberately no per-module opt-out —
timing is a system property, and one legacy channel would put a producer back
on a per-start base-time for every consumer downstream of it.

**What a gst producer gets for free.** If your `buildPipeline` ends in
`buildBusSink(...)`, stamping needs zero plugin work: the runner splices the
native `mrtsstamp` element (`mpegts-core/native/mrtsstamp`, wrapping the same
`TimelineStamper` the sidecars run) in front of each `busout_*` tee, falling
back to a python pad probe — same arithmetic, a logged warning — on a box
where the `.so` isn't built. Arming is **lazy**: an egress starts stamping on
its first consumer edge and stops on its last, so an enabled-but-unrouted
output costs nothing (and while debugging, expect no stamper activity until a
consumer attaches; a re-attach after a full detach anchors afresh). Rules for
plugin authors:

- **Don't re-stamp.** No `tsparse set-timestamps=true`, no
  `do-timestamp=true`, no arrival-based re-timing between your mux and the
  bus sink — the contract's whole point is that the producer's stamp survives
  to the consumer (a regression test pins that it survives `tsdemux`).
- `preserveSourceTimeline` is dropped from the description while the contract
  is on (the stamper's in-place re-anchor replaces its error-out-and-relatch).
  Keep declaring it — it is the legacy behaviour under the kill-switch.

**Sidecar/native producers stamp too (`--stamp-timeline`).** A module that
publishes through its own child instead of a gst pipeline passes
`--stamp-timeline`, gated on `services.timeSyncContract` — flag off means
argv and wire bytes are unchanged. `unixfd-fanout.py`, `mr-bus-fanout` and
`mr-tssplit` implement it already, all through the one shared
`TimelineStamper` (`mpegts-core/py/ts_timeline.py` ↔ `native/mrts/`, pinned
against each other by the conformance suite). Pattern, from hls-player:

```typescript
args: [..., ...(this.services?.timeSyncContract ? ['--stamp-timeline'] : [])],
```

**Playout offset D on producers.** The per-route override for D lives on the
**route head** — the producer module the consumers take their bus from — as a
`playoutOffsetMs` config key (declared so far by `srt-input`, `rist-input`,
`mpegts-ip-input`, `ts-splitter`, `aes67-input`). Declare it with **no schema `default`**
(absent means "inherit the engine default": `EngineConfig.playoutOffsetMs`,
300 ms, `MR_PLAYOUT_OFFSET_MS` env fallback) and list it in
`liveUpdatableParams`; your producer never reads it — the engine resolves it
for the consumer legs and fans a change out to them live. The consuming side
is covered in "Playout Offset D (`playoutOffsetMs`)" above.

**Where stamper events come from (debugging).** Anchor / re-anchor /
segment-warning events and the periodic `timeline_drift` report (per armed
egress, every 30 s) originate in the runner's stamping subsystem —
`packages/engine/src/child-process/gst_bus_stamper.py` (lifecycle: contract
flag, lazy arming, drift timer) plus its `gst_stamp_probe.py` /
`gst_stamp_native.py` / `gst_stamp_events.py` split; the sidecars publish the
same `timeline` block in their 2 s stats line. If wire timing looks wrong,
read those runner log lines before suspecting your own pipeline.

---

## Native & Python code in plugins

Plugins can ship compiled C++ tools and python sidecars/modules inside their
own folder — no registration anywhere. Architecture decisions behind this:
`docs/adr/0001` (plugin-owned code + library plugins), `docs/adr/0003`
(scoped resolution + namespaced install).

### Add C++ to your plugin

1. Create a tool folder and drop your sources in:

   ```bash
   mkdir -p plugins/my-plugin/native/my-tool
   # add my-tool.cpp (any number of .cpp files)
   ```

2. Copy this template `Makefile` into the tool folder — all `.cpp` files are
   compiled into one binary named after the folder:

   ```make
   CXX        ?= c++
   CXXFLAGS   ?= -O2
   CXXFLAGS   += -std=c++17 -Wall -Wextra
   PREFIX     ?= /usr/local
   LIBEXECDIR ?= $(PREFIX)/libexec
   MR_PLUGIN  ?= my-plugin

   TOOL := $(notdir $(CURDIR))

   all: $(TOOL)

   $(TOOL): $(wildcard *.cpp) $(wildcard *.h)
   	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(wildcard *.cpp) -o $@

   test:
   	@# add test commands, or leave as no-op

   clean:
   	rm -f $(TOOL)

   install: $(TOOL)
   	install -D -m 755 $(TOOL) $(DESTDIR)$(LIBEXECDIR)/media-router/$(MR_PLUGIN)/$(TOOL)

   .PHONY: all test clean install
   ```

   Rules: C++17, **libc/libstdc++ only** — no third-party dependencies (the
   Yocto build has no network access). Linux-only tools should self-guard
   with `ifeq ($(shell uname -s),Linux)` (see `unixfdbus-core/native/*/Makefile`).
   Add a `native/.gitignore` for the build outputs.

3. Build. The repo-root Makefile auto-discovers every
   `plugins/*/native/*/Makefile` at invocation time — it never needs editing:

   ```bash
   make native            # build everything, host arch
   make native-test       # + run C++ test suites
   make CXX=aarch64-linux-gnu-g++ native    # cross-compile (what Yocto does)
   ./build-native-dev.sh arm64              # cross via Docker, no toolchain needed
   ```

   The Yocto recipe runs the same targets; `make native-install` places
   binaries at `/usr/libexec/media-router/<plugin>/<tool>` on the image.

4. Run it from your engine module:

   ```typescript
   import { resolveNativeBinary } from '@media-router/engine';

   const binary = resolveNativeBinary('my-tool', 'my-plugin');
   if (!binary) { this.setHealth('error', 'my-tool not found — run `make native`'); return; }
   this.proc = this.spawnRunnerProcess({ label: 'my-tool', command: binary, args: [...] });
   ```

   Resolution order: `MR_NATIVE_BIN_DIR` (authoritative dev override) → your
   plugin's own `native/<tool>/<tool>` / installed
   `/usr/libexec/media-router/<plugin>/<tool>` → cross-plugin scan. Because
   your own folder wins, another plugin shipping a tool with the same name
   never conflicts; an ambiguous cross-plugin lookup fails loud (error log +
   `null`). Worked examples: `ts-splitter` (spawns its own `mr-tssplit`),
   `hls-player` (resolves `mr-bus-fanout` from the `unixfdbus-core` library plugin).

### Link against a library plugin's C++

Static archives from library plugins are linked via `MR_PLUGINS_DIR`
(defaults to `../../..` from a tool folder) — declare them as prerequisites
so `make` builds them first, and add their parent to the include path:

```make
MR_PLUGINS_DIR ?= ../../..
MRBUS = $(MR_PLUGINS_DIR)/unixfdbus-core/native/libmrbus
CPPFLAGS += -I$(MR_PLUGINS_DIR)/unixfdbus-core/native

$(MRBUS)/libmrbus.a:
	$(MAKE) -C $(MRBUS)

my-tool: $(wildcard *.cpp) $(MRBUS)/libmrbus.a
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(wildcard *.cpp) $(MRBUS)/libmrbus.a -o $@
```

Sources then `#include "libmrbus/busproto.h"` (relative to the `-I` path).
Full example: `ts-splitter/native/mr-tssplit/Makefile`.

### Python in plugins

Put python in `plugins/<plugin>/py/`. Two ways it gets used:

- **Spawn a sidecar**: `resolvePythonScript('my-sidecar.py', 'my-plugin')`
  (same scoping rules as binaries), then spawn `python3 <path>`. Example:
  `hls-player`'s fan-out fallback.
- **Import from pipeline code**: every `plugins/*/py` dir is automatically on
  the gst pipeline runner's `PYTHONPATH`, so runner-loaded code can plainly
  `import my_module`. Examples: `librist` (rist-core), `ts_timeline`
  (mpegts-core). Module FILENAMES must be unique across all plugins (python
  has one flat import namespace) — the engine logs an error at startup if two
  plugins ship the same module name.

The plugins tree ships verbatim to `/opt/media-router`, so the same paths
work on dev checkouts and installed systems. Note: `.py` files and `tests/`
dirs are outside the plugin `tsc` rootDir — they ship as source, nothing to
build.

### Library plugins (shared base code, no GUI)

A folder under `plugins/` whose `package.json` has **no `mediaRouter` field**
is a *library plugin*: `PluginLoader` skips it, so it never appears in the
Add Module panel, but its `native/`, `py/` and `engine/` fully participate in
build and resolution. Convention: name them `<domain>-core` (`unixfdbus-core`,
`mpegts-core`, `rist-core`, `aes67-core`, `audio-302m-core`) — one folder per
domain, not a generic "shared" junk drawer. Single-plugin code stays in that
plugin's folder; promote to a library plugin when a domain's code serves
several plugins.

Dependents declare library plugins in `dependencies` — for a native/python
core that is visibility plus an existence guarantee (no runtime effect); for a
**TypeScript** core it is the real import edge, and pnpm uses it to build the
core before its consumers:

```json
"dependencies": {
    "@media-router/engine": "workspace:*",
    "@media-router/plugin-unixfdbus-core": "workspace:*"
}
```

A TypeScript library plugin (`audio-302m-core` is the reference) keeps sources
in `engine/`, builds with the same `tsconfig.json` as a module plugin
(`extends ../tsconfig.plugin.json`, `rootDir: ./engine`, `outDir: ./dist`), and
adds `main` / `types` / `exports` pointing at `dist/index.js` so consumers
import the package name, never a deep path. Its `*.test.ts` sit beside the
sources and are picked up by vitest's `plugins/*/engine/**/*.test.ts`. The
dependency direction is one-way (ADR-0002): a core plugin may import
`@media-router/engine`; `packages/engine` never imports a plugin.

Cross-language test suites live in the owning plugin's `tests/` dir
(vitest picks up `plugins/*/tests/**/*.test.ts`): the bus protocol
conformance suite in `unixfdbus-core/tests/`, the mrts golden-parity suite in
`mpegts-core/tests/`, the mr-tssplit end-to-end suite in
`ts-splitter/tests/`.

`pnpm test` needs `python3` on PATH: these suites run the real python
sidecars, and without it they `skipIf` themselves out — a green run that
proved nothing about the cross-language contract.

## Available Services (`this.services`)

| Property | Type | Description |
|----------|------|-------------|
| `pipeWire` | `PipeWireManager` | Create null-sinks, set volume, load loopbacks, list source/sink devices |
| `mediaRouter` | `MediaRouter` | Assign/release bus channels (`assignBusChannel` / `releaseBusChannel`), look up upstream bus sources (`getModuleBusSource`) |
| `processManager` | `ProcessManager` | Spawn and manage external CLI tools (auto-killed on module stop — see below) |
| `deviceProviders` | `DeviceProviderRegistry` | Register custom device types via `services.deviceProviders.register(...)`; prefer `registerPipeWireDeviceProvider` for PipeWire source/sink helpers |
| `instanceId` | `string` | Unique module instance ID |

### ProcessManager — Spawning External Processes

Plugins can spawn arbitrary external processes (CLI tools like `ristreceiver`, `srt-live-transmit`, `ffmpeg`, etc.) via the `ProcessManager` service. Processes are automatically killed when the module stops — no manual cleanup needed.

**Preferred: `this.spawnRunnerProcess(opts)`** (on `GstPluginBase`). Wraps `processManager.spawn` with the standardized health wiring every process-backed producer needs — written once so plugins can't forget the failure modes:

- spawn failure or restart attempts exhausted → health `error`
- crash-backoff restart pending or unexpected clean exit → health `warning`
- `clearBadges: [...]` — badge IDs removed whenever the process goes down, so a stale stats badge never shows green on a dead stream

The plugin restores `ok` itself once the runner proves live — on the process `started` event (CLI tools where spawn ≈ live), or on the next parsed stats line (runners that can crash-loop after spawning, like hls-player).

```typescript
export class RistReceiverModule extends GstPluginBase {
    private receiver?: ManagedProcess;

    async onStart(): Promise<void> {
        this.receiver = this.spawnRunnerProcess({
            label: 'ristreceiver',
            command: 'ristreceiver',
            args: ['-p', '2088:2089', '-o', 'udp://127.0.0.1:5000'],
            autoRestart: true,    // auto-restart on crash
            clearBadges: ['quality', 'connections'],
            onStdout: (line) => this.log.info(line),
            onStderr: (line) => this.parseRistStats(line),
        });
        this.receiver.on('started', () => this.setHealth('ok'));

        await super.onStart();
    }

    // No need to override onStop() — ProcessManager auto-kills on module stop
}
```

For processes that aren't the module's health-defining producer (auxiliary tools), `this.services.processManager.spawn(instanceId, opts)` is still available directly — same options, no health wiring.

**ManagedProcessOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `label` | `string` | required | Name for logs (e.g. `'ristreceiver'`) |
| `command` | `string` | required | Executable path or command |
| `args` | `string[]` | `[]` | Arguments |
| `env` | `Record<string, string>` | inherited | Extra environment variables |
| `cwd` | `string` | inherited | Working directory |
| `autoRestart` | `boolean` | `true` | Restart on non-zero exit |
| `onStdout` | `(line: string) => void` | — | Called per stdout line |
| `onStderr` | `(line: string) => void` | — | Called per stderr line |

**ManagedProcess handle:**

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `pid` | `number \| undefined` | OS process ID |
| `isRunning` | `boolean` | Whether process is alive |
| `uptime` | `number` | Milliseconds since start |
| `exitCode` | `number \| null` | Last exit code |
| `stop()` | `Promise<void>` | Graceful SIGTERM → SIGKILL |
| `destroy()` | `Promise<void>` | Stop + prevent restarts |

**Events:** `'started'`, `'stopped'`, `'error'`, `'restarting'`

**Cleanup:** All processes are automatically killed when:
- The module stops (disable, delete, engine stop)
- The engine shuts down
- No plugin code needed for cleanup

## Base Class Properties and Methods

| Property/Method | Type | Description |
|-----------------|------|-------------|
| `this.config` | `Record<string, unknown>` | Current module configuration |
| `this.services` | `ModuleServices \| null` | Injected engine services |
| `this.childProcess` | `GstChildProcess \| null` | Running GStreamer child process |
| `this.paModuleId` | `number \| null` | PulseAudio module ID for null-sink cleanup |
| `this.pwNodeName` | `string` | PipeWire node name (`MR_PW_{instanceId}`) |
| `this.running` | `boolean` | Whether the pipeline is running |
| `this.health` | `ModuleHealth` | Current health status |
| `setHealth(health, error?)` | method | Set module health + optional error message |
| `spawnRunnerProcess(opts)` | method | Spawn an external runner with standardized health wiring (see ProcessManager section) |
| `setElementProperty(el, prop, val)` | method | Set GStreamer element property (live) |
| `getElementProperty(el, prop)` | method | Get GStreamer element property |
| `getElementStats(el)` | method | Read element `stats` GstStructure as dict |
| `setKlvPayload(el, payload)` | method | Push a metadata payload to a named `appsrc`; runner carousels it (~1 s). Fire-and-forget, report-only (see In-band metadata carousel) |

---

## Network Ports Reference

| Port | Service |
|------|---------|
| 3000 | dgram-comms (engine ↔ manager UDP) |
| 3001 | Engine Local API (Fastify) |
| 8080 | Manager HTTP + Socket.IO |
| 8081 | Local Control Panel (Socket.IO) |
| 8082 | Profile Manager |
| 40000-50000 | Bus channel ids (name unixfd socket paths — no sockets bound) |

---

## Example Plugins

Complete working plugins to copy from. Each one demonstrates a distinct subset of the contract:

| Plugin | Path | Patterns demonstrated |
|--------|------|----------------------|
| Audio Input | `plugins/audio-input/` | Device picker, `registerPipeWireDeviceProvider`, device watchdog, native `module-remap-source`, VU process |
| Audio Output | `plugins/audio-output/` | Symmetric to audio-input but for sinks; `registerPipeWireDeviceProvider` with `direction: 'sink'` |
| Audio Encoder | `plugins/audio-encoder/` | `static initManifest` for codec capability probing, live bitrate via `setElementProperty`, UDP-port allocation |
| Audio Decoder | `plugins/audio-decoder/` | Stream probing (`probeMpegTsStream`), idle when no upstream connected (`null` from `buildPipeline`). **Requires `ts-splitter` to be installed** — that plugin's `static registerServices` provides the opus/aac/mp2/ac3 codec classifiers `probeMpegTsStream` consults. Without it, `probeResult.codec` always reports `'unknown'` and the decoder silently falls back to `decodebin`. |
| SRT Input / Output | `plugins/srt-input/`, `plugins/srt-output/` | Per-caller stat polling, dynamic `statusSections` for multi-peer state, badges, `restartBackoffMs` tuning |
| RIST Input / Output | `plugins/rist-input/`, `plugins/rist-output/` | **No GStreamer pipeline** — `ProcessManager` driving `ristreceiver` / `ristsender`, stderr-JSON stat parsing |
| MPEG-TS Demuxer | `plugins/mpegts-demuxer/` | `getDynamicPorts(config)`, per-output `assignBusChannel(instanceId, portId)`, `linkOnPadAdded` rules |
| MPEG-TS Muxer | `plugins/mpegts-muxer/` | Symmetric to demuxer — dynamic *inputs*, fanning into one muxed/mpegts output |
| N-1 Mixer | `plugins/n1-mixer/` | **PipeWire-only** (no GStreamer), `getPipeWireNodeForPort` for per-port routing, dynamic port pairs |
| N-1 Mixer (302M) | `plugins/n1-mixer-302m/` | Mix-minus on the 302M bus — decode-once + `tee` per input, one force-live `audiomixer` per output (i ≠ o matrix), `buildAudioMixInput`/`build302mEncodeBranch`, per-output `assignBusChannel` only for outputs with contributors |
| Audio Processing | `plugins/audio-processing/` | HPF → EQ → dynamics → limiter → ducker on the 302M bus (supersedes the PipeWire `audio-dynamics`). Program + sidechain are both `buildAudioMixInput` fan-ins; LSP LADSPA stages resolved per enabled stage; dB→linear + range clamping isolated in `lspProcessing.ts`; the `sc-*` 4-channel packing survives only for a sidechain-keyed gate |
| Video Encoder | `plugins/video-encoder/` | `static initManifest` for HW encoder probing (V4L2 vs software), per-codec `getLiveUpdatableParams` override, DRM/V4L2 device providers |
| Video Player | `plugins/video-player/` | Multi-sink selection (Wayland → KMS direct → KMS auto → fallback), text-overlay live updates, **codec-aware decoder selection** (see below) |
| Transcoder | `plugins/transcoder/` | Config-driven dynamic *outputs* (one per rendition); one static pipeline that decodes once → `tee` → N scale/encode/mux branches, per-output `assignBusChannel(instanceId, portId)`; own `encoderBranch.ts` (CBR element selection, sibling to Video Encoder's) |
| AES67 In / Out | `plugins/aes67-input/`, `plugins/aes67-output/` | Network audio in both directions off the 302M bus; a python sidecar per module for SAP discovery/announce, a device provider fed by what that sidecar sees, and PTP-epoch RTP stamping that refuses to fake itself (see below) |

### AES67 — SAP discovery and PTP-epoch RTP stamping

Two plugins plus the `aes67-core` library plugin (SAP/SDP and the TAI clock
arithmetic, in python, one definition shared by both ends). ADR-0005 decision 7
and its "Stage AES67" implementation notes carry the full design; the parts
worth copying:

- **A picker fed by a sidecar.** `aes67-input` spawns `mr-sap.py --listen`
  (`spawnRunnerProcess`, so it dies with the module) and publishes each
  SNAPSHOT it emits into a module-level table; a `x-deviceType: "aes67-stream"`
  device provider lists that table, so the operator picks "Studio A" instead of
  typing a group, port, encoding, channel count and payload type. Snapshots —
  not add/remove deltas — mean a sidecar restart re-syncs the GUI instead of
  leaving a phantom entry. Discovery is owned by the RUNNING modules, so a box
  with no AES67 input joins no multicast group and runs no extra process.
- **A route head like any other.** `aes67-input` ends in `buildBusSink`, so the
  engine's stamper anchors it onto the house clock with no plugin work, and it
  declares `playoutOffsetMs` (no schema `default`) for the players it feeds.
- **The epoch is one integer, and it is measured, not assumed.** GStreamer's
  payloader computes `rtptime = timestamp-offset + running_time x rate / 1e9`
  from ABSOLUTE running time (pinned against real elements in
  `aes67-core/tests/aes67Gst.test.ts`), and under the time-sync contract
  running time IS CLOCK_MONOTONIC — so setting `timestamp-offset` to
  `(CLOCK_TAI - CLOCK_MONOTONIC) x rate / 1e9 mod 2^32` makes the wire
  timestamps PTP-epoch media time. No TAI pipeline clock, no change to the
  contract. `aes67_clock.py` measures it and REFUSES on a box whose kernel TAI
  offset is unset (no ptp4l/phc2sys): the payloader then keeps its random
  RFC 3550 offset and the SDP carries no `ts-refclk`/`mediaclk`, because
  announcing a PTP media clock you do not have is undetectable at the receiver.
- **Pacing is not playout offset D.** The AES67 egress sink syncs against the
  house clock with a small `senderLatencyMs` (default 20 ms) so 1 ms packets
  leave evenly instead of in decode-sized bursts. D is deliberately NOT applied
  there: RTP timestamps carry the alignment, so delaying the egress by 300 ms
  would only spend the receiver's link-offset budget.

### Video Player — codec-aware decoder selection

The live pipeline starts on `decodebin3` and upgrades itself once it knows the codec. Worth copying if your plugin decodes an unknown-codec stream.

- **Detection.** The live pipeline tees its ingress into `appsink name=tsprobe` and sets `tsProbe: { appsink: 'tsprobe' }`, so the runner's report-only probe emits `tsprobe:videoinfo` to `onPluginEvent`. The tap is the last thing before `tsdemux` (the probe wants the *muxed* TS — it does its own PSI discovery) and therefore downstream of the stall watchdog, so it can't disturb `bus_stall`. It needs 188-aligned buffers — `ts_psi.iter_packets` strides a fixed 188 and never resyncs on `0x47` — and gets them from the bus itself, not from `tsparse`: `unixfd` carries producer buffer boundaries across the socket untouched and every bus producer emits whole-packet buffers. That is what makes one tap correct on both the default (tsparse-free) and the clock-paced chain.
- **Ladder** (`engine/helpers/decoderSelection.ts`, pure — availability and demotions are passed in, no I/O): h265 → `h265parse ! v4l2slh265dec` → `h265parse ! avdec_h265` → `decodebin3`; h264 → `h264parse ! v4l2h264dec` → `h264parse ! avdec_h264` → `decodebin3`; any other codec (mpeg2, unknown, none detected yet) stays on `decodebin3`. Element availability is probed once per engine process in `initManifest` via `probeGstElement`. `cpuDecodeThreading` (`'auto'`, the default, or `'single'`) inlines `thread-type=frame max-threads=3` on the `avdec_*` rungs — a bare `avdec_*` decodes on one core however idle the box is, which lagged a 1080p50 H.264 feed on a Pi 5 (no H.264 hardware decoder) at 62% idle. `'single'` is the opt-out back to one core. Hardware rungs stay bare (those are ffmpeg properties). The same value maps onto the runner's `decoderThreadType` for the `decodebin3` rung, where GStreamer plugs the decoder itself — note the vocabularies differ: the setting's `'auto'` means multi-core, the runner's means "don't force a thread-type", so `resolveDecoderThreadType` maps everything but `'single'` to `'frame'`.
- **Rebuild, never replug.** An explicit chain adds `capsfilter caps="video/x-h26x"` *directly* on `tsdemux` (the leaky queue's sink pad is ANY and would happily take the audio pad). A codec change rebuilds the whole pipeline — `decodebin3`'s in-place decoder switch is what wedged an h265→h264 feed on hardware. Debounced: no rebuild unless the codec differs from the one the running pipeline was built for and resolves to a different rung.
- **Keyframe gate on the explicit chains.** Every explicit rung names its decoder (`v4l2slh265dec name=vpdec` — the name is stable across rungs and codecs) and sets `keyframeGate: { decoder: 'vpdec' }`, which makes the runner probe that element's sink pad and DROP every buffer flagged `GST_BUFFER_FLAG_DELTA_UNIT` until the first one without it; that keyframe passes and the probe removes itself, so steady state costs nothing. Why: a live RIST/TS join always lands mid-GOP, and handing those leading delta units to a stateless V4L2 decoder (`v4l2slh265dec`/rpivid on Pi 4, `hevc_dec` on Pi 5, kernel 6.12.87) leaves the driver holding a decode request that never completes — the next teardown then blocks forever in the kernel (`hevc_d_h265_stop` in D state with the videodev mutex held), V4L2 is dead box-wide and only a reboot clears it. The EOS drain fixes teardown *ordering* and cannot save a decoder that is already stuck. The `decodebin3` rung **cannot** be gated — the bin plugs its own decoder, so there is no element to name. That rung auto-plugs by rank (hardware included) and only carries the stream until the TS probe names the codec and the rebuild moves to a gated explicit rung; a decoder that does fail there is handled by demotion, below. Scope: once per pipeline *start* — `restartOnError` replays the start and re-gates; a flush within one running pipeline does not. Knock-on: naming the element changes what the bus reports as an error's source, so the demotion attribution below matches `vpdec` as well as the factory-name prefix.
- **Runtime demotion.** A pipeline error on an explicit rung strikes that decoder off (for as long as the demotion lasts — see the age-out below) and rebuilds one rung down, with a health warning (`Hardware decoder v4l2slh265dec failed — using software decode (avdec_h265)`) re-applied on every later build so it doesn't flash once. There is exactly **one** rule that demotes: the error must be *attributed* to the active decoder element — the bus message's `element` is the chain's `vpdec`, or starts with the decoder's factory name. Everything else rebuilds the same pipeline and the decoder keeps its rung: an error naming another element (sink, parser, demux, queue), an error naming nothing at all, and the runner's synthesised errors (`playing_timeout`, `spawn_failed`, `runner_exit`, `max_restarts`, none of which name an element). A count-based escape hatch for the element-less case — two failures within 60 s — was tried and removed: it demoted on pattern rather than proof, and a compositor flap or a bus rewire mid engine-restart could still strand a verifiably healthy hardware decoder on software decode for the rest of the session. Errors on the `decodebin3` rung keep the default behaviour, and an error raised while an internal restart already owns the pipeline never demotes. When the ladder has fallen through to `decodebin3` with decoders already demoted, exactly those decoders — and nothing else — go into that rung's `GST_PLUGIN_FEATURE_RANK` mask so the bin can't auto-plug a struck-off decoder straight back; that error would be on the `decodebin3` rung, where nothing demotes: an endless replug loop. With no demotions on the books the var is absent entirely and the bin picks by rank.
- **Demotion age-out (TTL).** A demotion expires after `VP_DECODER_DEMOTION_TTL_MS` (default 5 min; `0` opts out and restores session-long demotions) and the hardware rung becomes eligible again — `engine/helpers/decoderDemotions.ts` holds the per-decoder timestamp, and every read of the demotion set goes through it. Why: one corrupt slice in a live feed was enough to strike hardware off, and the box then burned 80%+ CPU on software decode for hours until someone restarted the engine — for a stream that was healthy again seconds later. A hardware failure is now cheap to take (the driver abandons a wedged decode in ~2 s and resets the block instead of hanging V4L2 box-wide), so putting hardware back on trial periodically is the better trade. Eligibility on the next rebuild is **not** enough — a pipeline playing fine on software has no other reason to rebuild — so every live build that lands *below* a demoted rung arms a `setTimeout` for that demotion's deadline, and when it fires and the plan really has changed it goes through the same `restartPipeline` a codec change uses. Armed from the *build*, not from the failure: each rebuild re-arms it against the demotion's original timestamp (no drift, and a restart loop can't starve the retry), an instance that never saw the failure still arms one, and `onStop` plus the fallback card drop it so it can't fire into a torn-down pipeline. A decoder that fails its retry is re-demoted with a fresh timestamp, so a permanently broken decoder costs exactly one failed rebuild per TTL.
