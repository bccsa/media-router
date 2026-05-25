# Media Router — Plugin Development Guide

Plugins extend Media Router with new media processing capabilities. Each plugin is a self-contained directory in `plugins/` with a manifest, engine module, and optional UI components.

## Directory Structure

```
plugins/
└── my-plugin/
    ├── package.json          # Manifest + dependencies
    ├── tsconfig.json         # TypeScript config
    └── engine/
        └── MyPluginModule.ts # Engine-side GStreamer pipeline logic
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
| A network ingress/egress plugin | `srt-input` / `srt-output` | UDP-port allocation, per-caller stats, badges |
| A plugin that owns a hardware device (audio source/sink, V4L2, DRM) | `audio-input` / `audio-output` | `static registerServices` for device provider, watchdog hooks |
| A CLI-tool wrapper (returns `null` from `buildPipeline`) | `rist-input` / `rist-output` | `ProcessManager` lifecycle, stderr parsing |
| A PipeWire-only plugin (no GStreamer) | `n1-mixer` | Per-port PipeWire nodes via `getPipeWireNodeForPort` |
| A multi-port plugin with variable port count | `mpegts-demuxer` (1→N) / `mpegts-muxer` (N→1) / `n1-mixer` | `getDynamicPorts(config)` |
| A plugin that probes hardware at load time to populate its manifest | `video-encoder` (HW encoders) / `audio-encoder` (codec capability) | `static initManifest(manifest)` |

The Quick Start example above is a minimal skeleton — for anything non-trivial, copying a real plugin will save more time than reading docs.

---

## Manifest Reference (`package.json` → `mediaRouter`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pluginId` | `string` | Yes | Unique identifier (e.g. `"srt-input"`) |
| `displayName` | `string` | Yes | UI display name |
| `description` | `string` | Yes | Description for the Add Module panel |
| `category` | `string` | Yes | One of: `"protocol"`, `"codec"`, `"processing"`, `"utility"` |
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

### Stream Types

| Type | Routing | Description |
|------|---------|-------------|
| `audio/pcm` | PipeWire loopback | Raw audio between PipeWire nodes |
| `audio/opus` | Reserved | Encoded Opus audio |
| `audio/aac` | Reserved | Encoded AAC audio |
| `muxed/mpegts` | UDP multicast on loopback | MPEG-TS container (audio, video, subs) |
| `video/raw` | Reserved | Raw video frames |
| `video/h264` | Reserved | Encoded H.264 video |
| `video/h265` | Reserved | Encoded H.265/HEVC video |
| `text/subtitle` | Reserved | Subtitle streams |
| `data/generic` | Reserved | Generic data/metadata |

### Connection Rules

- Only `output` → `input` connections are allowed (but users can drag from either side)
- Stream types must match (`audio/pcm` ↔ `audio/pcm`, `muxed/mpegts` ↔ `muxed/mpegts`)
- Cross-type connections are blocked (use encoder/decoder to bridge)
- `maxConnections` is enforced on both source and target ports

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
| `x-widget` | `"slider"` \| `"imageUpload"` | `"slider"` renders a range slider instead of a number input. `"imageUpload"` (string-valued field) renders a file picker that uploads via the `plugin:upload` RPC and stores the resulting absolute path; preview thumbnail loaded back through `plugin:upload-get`. |
| `x-step` | `number` | Step value for slider |
| `x-live` | `boolean` | Send value changes immediately (no Apply button needed) |
| `x-liveUpdatable` | `boolean` | Mark as live-updatable (same as `x-live`) |
| `x-debounceMs` | `number` | Live-update strategy for slow underlying APIs: only fire after the value has been idle for N ms (default is a 50 ms throttle that fires the first change immediately). Use for sliders where each change is expensive — e.g. `"x-debounceMs": 300` on video bitrate so the encoder isn't reconfigured on every pixel of slider drag. |
| `x-maxFrom` | `string` | Key of another setting that controls slider maximum |
| `x-enumBy` | `{ field, map }` | Field-dependent dropdown options (e.g. `{ "field": "codec", "map": { "opus": [...], "aac": [...] } }`) |
| `x-maxBy` | `{ field, map }` | Field-dependent max for number inputs (e.g. `{ "field": "codec", "map": { "opus": 8, "aac": 6 } }`) |
| `x-showWhen` | `string` | Only show field when condition matches (e.g. `"codec=opus"`) |
| `x-contextMenu` | `boolean` | Show this setting in the module's right-click context menu |
| `x-unit` | `string` | Unit label displayed next to the value (e.g. `"%"`, `"kbps"`, `"ms"`) |
| `x-readOnly` | `boolean` | Display as read-only (greyed out, not editable) |

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
| **GStreamer pipeline** | a `PipelineDescription` | Python `gst-pipeline-runner.py` child process spawned by `GstChildProcess` | `audio-decoder`, `audio-encoder`, `srt-input`, `srt-output`, `mpegts-demuxer`, `mpegts-muxer`, `video-encoder`, `video-player`, `audio-input`, `audio-output` |
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
    /** Named elements with live-updatable properties. */
    liveElements?: Record<string, string[]>;
    /** Auto-restart on bus error / EOS. */
    restartOnError?: boolean;
    /**
     * Inner gst-runner restart backoff window. Defaults to 1s → 5s, which
     * pegs CPU when the failure is durable (e.g. SRT caller against an
     * unreachable remote re-spawns Python every few seconds). Tune for the
     * failure mode — SRT plugins ship 5s → 10s.
     */
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
    /** Dynamic-pad linking rules (tsdemux, decodebin, …). See below. */
    linkOnPadAdded?: PadLinkRule[];
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

### Static Hooks (Class-Level, Not Instance-Level)

Two optional **static** methods on the module class run **once per plugin class** during engine startup — before any module instances exist. They let a plugin probe the host for capabilities and contribute engine-wide services.

#### `static initManifest(manifest)` — Probe host capabilities

Use when the manifest depends on what the host machine actually supports. The method is called once after the manifest is parsed; mutate `manifest` in place to surface detected capabilities (codec lists, encoder enums, hardware presence flags).

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

For plugins where each port maps to a distinct PipeWire node (rather than one shared null-sink for the whole module), also implement `getPipeWireNodeForPort(portId)`:

```typescript
getPipeWireNodeForPort(portId: string): { source?: string; sink?: string } {
    // e.g. each output port has its own remap-sink named MR_PW_<instanceId>_<portId>
    return { sink: `${this.pwNodeName}_${portId}` };
}
```

Real examples: [`n1-mixer`](n1-mixer/engine/N1MixerModule.ts) (per-port PipeWire nodes), [`mpegts-demuxer`](mpegts-demuxer/engine/MpegTsDemuxerModule.ts) and [`mpegts-muxer`](mpegts-muxer/engine/MpegTsMuxerModule.ts) (dynamic outputs/inputs based on stream counts).

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

#### Get Element Property

Read a property value from a running element:

```typescript
const bitrate = await this.getElementProperty('enc', 'bitrate');
// Returns: 256000

const bytesServed = await this.getElementProperty('usink', 'bytes-served');
// Returns: 1234567 (for udpsink)
```

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

#### Polling Live Stats

For live-updating stats (throughput, connection info), use a timer that polls element properties:

```typescript
private statsTimer: ReturnType<typeof setInterval> | null = null;
private lastBytes = 0;
private lastPollTime = 0;

async onStart(): Promise<void> {
    await super.onStart();

    // Start polling every 2s
    this.lastPollTime = Date.now();
    this.statsTimer = setInterval(async () => {
        try {
            // Read bytes-served from a named udpsink
            const bytes = await this.getElementProperty('usink', 'bytes-served') as number;
            if (typeof bytes === 'number') {
                const now = Date.now();
                const elapsed = (now - this.lastPollTime) / 1000;
                const delta = bytes - this.lastBytes;
                const kbps = elapsed > 0 ? Math.round((delta * 8) / elapsed / 1000) : 0;
                this.lastBytes = bytes;
                this.lastPollTime = now;
                this.setStatusData('throughput', {
                    'Output Bitrate': `${kbps} kbps`,
                    'Total Bytes': `${(bytes / 1024 / 1024).toFixed(1)} MB`,
                });
            }
        } catch { /* ignore errors during polling */ }
    }, 2000);
}

async onStop(): Promise<void> {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    await super.onStop();
}
```

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
const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
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

## UDP Multicast (Generic Plugin Infrastructure)

Inter-module routing of `muxed/mpegts` streams uses UDP multicast on loopback (`239.255.0.x`, ports 40000-50000). `MediaRouter` exposes a generic UDP-port pool used by **any** plugin that produces or consumes a muxed/mpegts stream — encoders, demuxers, muxers, SRT in/out, RIST in/out. The API is plugin-agnostic; nothing about it is encoder-specific.

| Method on `services.mediaRouter` | Purpose |
|---|---|
| `assignUdpPort(instanceId, portId?)` | Acquire a port for this module (or a specific output port for multi-port plugins). Returns `{ host, port }` or `null` if the pool is exhausted. |
| `getUdpEndpoint(instanceId, portId?)` | Re-read a previously-assigned endpoint (e.g. when the same plugin builds the pipeline a second time). |
| `releaseUdpPort(instanceId, portId?)` | Release one specific slot. |
| `releaseAllUdpPortsFor(instanceId)` | Release the bare slot **and** every per-port sub-slot. Called automatically on module stop. |
| `getModuleUdpSource(sinkModuleId, sinkPortId?)` | From the *consumer* side: find the upstream encoder's port for a given input port. Returns `undefined` if no connection. |

### Producer pattern (encoder, muxer, SRT-in re-broadcasting…)

```typescript
buildPipeline(config: Record<string, unknown>): PipelineDescription {
    const instanceId = this.services?.instanceId ?? '';
    const endpoint = this.services?.mediaRouter?.assignUdpPort(instanceId);
    const udpSink = endpoint
        ? `udpsink host=${endpoint.host} port=${endpoint.port} multicast-iface=lo auto-multicast=true sync=false`
        : 'fakesink sync=false';

    return { pipeline: `... ! mpegtsmux latency=0 alignment=7 ! ${udpSink}` };
}
```

For per-output-port allocation (e.g. MPEG-TS demuxer with N outputs), pass a `portId`:

```typescript
const ep = router.assignUdpPort(instanceId, 'audio-0');
```

### Consumer pattern (decoder, muxer input, SRT-out…)

Consumers return `null` from `buildPipeline` when no upstream is connected. The router restarts them when a connection is made.

```typescript
buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
    const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
    if (!udpSource) {
        this.setHealth('warning', 'No encoder connected');
        return null;
    }
    const udpSrc = `udpsrc multicast-group=${udpSource.host} port=${udpSource.port} multicast-iface=lo auto-multicast=true`;
    return { pipeline: `${udpSrc} ! tsdemux latency=0 ! opusdec ! ...` };
}
```

---

## Available Services (`this.services`)

| Property | Type | Description |
|----------|------|-------------|
| `pipeWire` | `PipeWireManager` | Create null-sinks, set volume, load loopbacks, list source/sink devices |
| `mediaRouter` | `MediaRouter` | Assign/release UDP ports (`assignUdpPort` / `releaseUdpPort`), look up upstream UDP sources (`getModuleUdpSource`) |
| `processManager` | `ProcessManager` | Spawn and manage external CLI tools (auto-killed on module stop — see below) |
| `deviceProviders` | `DeviceProviderRegistry` | Register custom device types via `services.deviceProviders.register(...)`; prefer `registerPipeWireDeviceProvider` for PipeWire source/sink helpers |
| `instanceId` | `string` | Unique module instance ID |

### ProcessManager — Spawning External Processes

Plugins can spawn arbitrary external processes (CLI tools like `ristreceiver`, `srt-live-transmit`, `ffmpeg`, etc.) via the `ProcessManager` service. Processes are automatically killed when the module stops — no manual cleanup needed.

**Basic usage:**

```typescript
import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

export class RistReceiverModule extends GstPluginBase {
    private receiver?: ManagedProcess;

    async onStart(): Promise<void> {
        // Spawn an external process owned by this module
        this.receiver = this.services!.processManager.spawn(
            this.services!.instanceId,
            {
                label: 'ristreceiver',
                command: 'ristreceiver',
                args: ['-p', '2088:2089', '-o', 'udp://127.0.0.1:5000'],
                autoRestart: true,    // auto-restart on crash
                onStdout: (line) => this.log.info(line),
                onStderr: (line) => this.parseRistStats(line),
            },
        );

        // Listen for health changes
        this.receiver.on('error', (msg) => this.setHealth('error', msg));
        this.receiver.on('started', () => this.setHealth('ok'));

        await super.onStart();
    }

    // No need to override onStop() — ProcessManager auto-kills on module stop
}
```

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
| `setElementProperty(el, prop, val)` | method | Set GStreamer element property (live) |
| `getElementProperty(el, prop)` | method | Get GStreamer element property |
| `getElementStats(el)` | method | Read element `stats` GstStructure as dict |

---

## Network Ports Reference

| Port | Service |
|------|---------|
| 3000 | dgram-comms (engine ↔ manager UDP) |
| 3001 | Engine Local API (Fastify) |
| 8080 | Manager HTTP + Socket.IO |
| 8081 | Local Control Panel (Socket.IO) |
| 8082 | Profile Manager |
| 40000-50000 | UDP multicast (MPEG-TS inter-module routing) |

---

## Example Plugins

Complete working plugins to copy from. Each one demonstrates a distinct subset of the contract:

| Plugin | Path | Patterns demonstrated |
|--------|------|----------------------|
| Audio Input | `plugins/audio-input/` | Device picker, `registerPipeWireDeviceProvider`, device watchdog, native `module-remap-source`, VU process |
| Audio Output | `plugins/audio-output/` | Symmetric to audio-input but for sinks; `registerPipeWireDeviceProvider` with `direction: 'sink'` |
| Audio Encoder | `plugins/audio-encoder/` | `static initManifest` for codec capability probing, live bitrate via `setElementProperty`, UDP-port allocation |
| Audio Decoder | `plugins/audio-decoder/` | Stream probing (`probeMpegTsStream`), idle when no upstream connected (`null` from `buildPipeline`). **Requires `mpegts-demuxer` to be installed** — that plugin's `static registerServices` provides the opus/aac/mp2/ac3 codec classifiers `probeMpegTsStream` consults. Without it, `probeResult.codec` always reports `'unknown'` and the decoder silently falls back to `decodebin`. |
| SRT Input / Output | `plugins/srt-input/`, `plugins/srt-output/` | Per-caller stat polling, dynamic `statusSections` for multi-peer state, badges, `restartBackoffMs` tuning |
| RIST Input / Output | `plugins/rist-input/`, `plugins/rist-output/` | **No GStreamer pipeline** — `ProcessManager` driving `ristreceiver` / `ristsender`, stderr-JSON stat parsing |
| MPEG-TS Demuxer | `plugins/mpegts-demuxer/` | `getDynamicPorts(config)`, per-output `assignUdpPort(instanceId, portId)`, `linkOnPadAdded` rules |
| MPEG-TS Muxer | `plugins/mpegts-muxer/` | Symmetric to demuxer — dynamic *inputs*, fanning into one muxed/mpegts output |
| N-1 Mixer | `plugins/n1-mixer/` | **PipeWire-only** (no GStreamer), `getPipeWireNodeForPort` for per-port routing, dynamic port pairs |
| Video Encoder | `plugins/video-encoder/` | `static initManifest` for HW encoder probing (V4L2 vs software), per-codec `getLiveUpdatableParams` override, DRM/V4L2 device providers |
| Video Player | `plugins/video-player/` | Multi-sink selection (Wayland → KMS direct → KMS auto → fallback), text-overlay live updates |
