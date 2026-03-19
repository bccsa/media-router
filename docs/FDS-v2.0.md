# Media Router v2.0 — Functional Design Specification

| Field            | Value                              |
|------------------|------------------------------------|
| Document         | FDS-MR-2.0                         |
| Version          | 0.1 (Draft)                        |
| Date             | 2026-03-13                         |
| Organisation     | BCC South Africa                   |
| Status           | Draft — Awaiting Review            |
| Related          | URS-MR-2.0                         |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Architecture](#2-system-architecture)
3. [Engine](#3-engine)
4. [Manager](#4-manager)
5. [Manager Web UI](#5-manager-web-ui)
6. [Local Control Panel](#6-local-control-panel)
7. [Local API](#7-local-api)
8. [Communication Layer](#8-communication-layer)
9. [Plugin System](#9-plugin-system)
10. [Security](#10-security)
11. [Observability & Reliability](#11-observability--reliability)
12. [Testing Strategy](#12-testing-strategy)
13. [Deployment & Build](#13-deployment--build)
14. [Requirement Traceability](#14-requirement-traceability)

---

## 1. Introduction

### 1.1 Purpose

This document translates the user requirements defined in URS-MR-2.0 into a functional design. It describes **what** the system does, how its components interact, and the data structures and interfaces between them — without prescribing implementation detail at the code level. It serves as the primary input for detailed architecture and implementation work.

### 1.2 Scope

Covers all subsystems: engine, manager, manager web UI, local control panel, local API, communication layer, plugin system, security, observability, testing, and deployment.

### 1.3 Conventions

- **v1.0** refers to the current production system (JavaScript, modular-dm, modular-ui).
- **v2.0** refers to the system described in this document.
- Requirement IDs (e.g. UR-ENG-001) reference the URS.
- Diagrams use ASCII art for portability.

---

## 2. System Architecture

### 2.1 High-Level Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Manager Server                              │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Config   │  │ Auth &   │  │ Link     │  │ NestJS HTTP/WS API │  │
│  │ Store    │  │ RBAC     │  │ Resolver │  │ (Socket.IO)        │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────────────┘  │
│        │             │             │               │       │        │
│        └─────────────┴─────────────┴───────────────┘       │        │
│                          │                                  │        │
└──────────────────────────┼──────────────────────────────────┼────────┘
                           │ UDP (dgram-comms v2)             │ Socket.IO / WS
            ┌──────────────┼───────────┐                      │
            ▼              ▼           ▼                      ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐    ┌──────────────┐
   │ Engine A   │  │ Engine B   │  │ Engine C   │    │ Manager UI   │
   │ (RPi 5)   │  │ (RPi 4)   │  │ (x86_64)  │    │ (Vue + TS)   │
   │            │  │            │  │            │    └──────────────┘
   │ ┌────────┐│  │ ┌────────┐│  │ ┌────────┐│
   │ │Modules ││  │ │Modules ││  │ │Modules ││
   │ │(plugins)│  │ │(plugins)│  │ │(plugins)│
   │ └────────┘│  │ └────────┘│  │ └────────┘│
   │            │  │            │  │            │
   │ ┌────────┐│  │ ┌────────┐│  │ ┌────────┐│
   │ │Local   ││  │ │Local   ││  │ │Local   ││
   │ │API+LCP ││  │ │API+LCP ││  │ │API+LCP ││
   │ └────────┘│  │ └────────┘│  │ └────────┘│
   └────────────┘  └────────────┘  └────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Engine** | Runs media modules (GStreamer pipelines), manages PipeWire audio, hosts local API and local control panel. Operates autonomously when manager is unreachable. |
| **Manager** | Central configuration store, user auth, RBAC, profile management, cross-device link resolution. Pushes config to engines, receives status updates. |
| **Manager Web UI** | Vue.js SPA for visual routing, module configuration, engine monitoring. Connects via Socket.IO. |
| **Local Control Panel** | Vue.js app on engine device for operators. Volume, mute, channel switching. Connects to engine via Socket.IO. |
| **Local API** | REST API on engine for device config, manager profiles, system info, health. Replaces v1.0 profile manager. |
| **Communication Layer** | UDP-based dgram-comms (engine↔manager), Socket.IO (manager↔UI, engine↔LCP). |

### 2.3 Key Changes from v1.0

| Aspect | v1.0 | v2.0 |
|--------|------|------|
| Language | JavaScript (CommonJS) | TypeScript (throughout) |
| Data model | modular-dm (generic framework) | Custom TypeScript modules (NestJS on manager, lightweight Fastify on engine) |
| UI framework | modular-ui (custom DOM framework) | Vue.js + Vue Flow |
| Audio routing | PulseAudio loopbacks | PipeWire native linking (pwlink) |
| Stream routing | Audio-only, no video routing | MPEG-TS stream routing (audio + video combined), splitting, combining, muxing, demuxing |
| Plugin system | Hard-coded module loading | Plugin interface with architecture tags |
| Auth | MD5, single role | bcrypt, RBAC with per-engine permissions |
| Config storage | JSON dump to disk | SQLite database (table per engine), schema validation, profiles |
| Local config | Profile manager web app + .env file | REST API (Local API) |
| Testing | None | Vitest, 100% coverage on engine + manager + UI |
| Logging | console.log (memory only) | Structured JSON logging with rotation |

---

## 3. Engine

### 3.1 Process Architecture

The engine is a single Node.js process (TypeScript + Fastify) that orchestrates media processing through child processes. Unlike the manager (which is a NestJS API server), the engine is primarily a process orchestrator — it manages GStreamer child processes, PipeWire links, and stream routing. A lightweight Fastify instance serves the Local API (section 7) and the LCP static files. This keeps the engine lean and avoids the overhead of a full DI/decorator framework where it provides no benefit.

```
┌─────────────────────────────────────────────────────────────────┐
│                  Engine Process (TypeScript + Fastify)            │
│                                                                  │
│  ┌───────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│  │ Module        │  │ PipeWire   │  │ Codec Capability       │  │
│  │ Registry      │  │ Manager    │  │ Detector               │  │
│  │ (plugins)     │  │ (pwlink)   │  │ (V4L2/VAAPI probe)    │  │
│  └───────┬───────┘  └─────┬──────┘  └────────────┬───────────┘  │
│          │                │                       │              │
│  ┌───────┴────────────────┴───────────────────────┴───────────┐  │
│  │                    Stream Router                            │  │
│  │  (route, split, combine elementary streams between modules) │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │ Module  │  │ Module  │  │ Module  │  │ Module  │  ...        │
│  │ Instance│  │ Instance│  │ Instance│  │ Instance│             │
│  │ (proxy) │  │ (proxy) │  │ (proxy) │  │ (proxy) │             │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘            │
│       │            │            │            │                   │
└───────┼────────────┼────────────┼────────────┼───────────────────┘
        │            │            │            │
   ┌────┴────┐  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
   │ Child   │  │ Child   │  │ Child   │  │ Child   │
   │ Process │  │ Process │  │ Process │  │ Process │
   │ (GStr)  │  │ (GStr)  │  │ (GStr)  │  │ (GStr)  │
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

**Carried forward from v1.0:** The child process isolation pattern works well. Each GStreamer pipeline runs in its own process, communicating with the engine via control IPC. The exponential backoff restart strategy (base 3s, max 60s, reset after 30s stable) is retained.

**Changed:** The `spawn` mixin and `_routerChildControlBase` class hierarchy are replaced with a typed TypeScript service that manages child process lifecycle through a structured interface.

### 3.2 Stream Management Model

#### 3.2.1 Elementary Streams

All media is routed between module instances (GStreamer child processes) — **media streams never pass through the Node.js engine process itself**. The engine orchestrates routing by configuring links between child processes; the actual media data flows directly between processes or via PipeWire's native graph, bypassing the Node.js event loop entirely.

**Two kinds of IPC** are used in the system. This document distinguishes them throughout:

| | **Control IPC** | **Media IPC** |
|-|----------------|--------------|
| **Between** | Engine (Node.js) ↔ GStreamer child process | GStreamer child process ↔ GStreamer child process |
| **Purpose** | Lifecycle commands, config updates, probed stream info, VU data, stats | Continuous media byte streams (MPEG-TS packets, raw video frames) |
| **Transport** | Node.js `child_process` IPC channel (JSON messages over a single pipe) | Unix domain sockets, shared memory, or named pipes |
| **Bandwidth** | Low — structured messages, kilobytes/s | High — media throughput, megabytes/s to gigabytes/s |
| **Direction** | Bidirectional (request/response + unsolicited events) | Unidirectional per pipe (source → destination) |
| **Engine involvement** | Engine sends/receives messages | Engine sets up the pipe, then is not involved in the data flow |

There are three routing domains:

1. **PipeWire audio** — mixable PCM audio streams routed via PipeWire native linking (kernel-space audio graph, zero Node.js involvement in data path)
2. **MPEG-TS** — transport streams containing encoded audio and/or video, routed between GStreamer child processes via media IPC (the engine sets up the pipes, but media bytes flow process-to-process)
3. **Raw video** — decoded/uncompressed video frames routed between GStreamer child processes via media IPC (shared-memory or pipe), enabling video processing chains without re-encoding (e.g. decoder → player, decoder → encoder for transcoding)

| Stream Type | Description | Colour Code |
|-------------|-------------|-------------|
| `audio/pcm` | Raw PCM audio (PipeWire-routable, mixable) | Blue |
| `muxed/mpegts` | MPEG-TS transport stream containing encoded audio and/or video | Orange |
| `video/raw` | Decoded raw video frames (media IPC between GStreamer child processes) | Green |

Streams are identified by type. The routing engine prevents incompatible connections (e.g. PCM audio output → MPEG-TS input). Raw video ports can only connect to other raw video ports.

#### 3.2.2 Module Ports

Each module declares typed **input ports** and **output ports** as part of its plugin manifest:

```typescript
interface ModulePort {
    id: string;                    // Unique within module (e.g. "audio_out_1")
    direction: "input" | "output";
    streamType: StreamType;        // "audio/pcm" | "muxed/mpegts" | "video/raw"
    channelConfig?: {              // For audio/pcm ports
        channels: number;          // Number of channels
        // Sample rate and bit depth are device-level settings (AudioDeviceSettings)
        // — not per-port. All audio on the device uses the same format.
    };
    mpegtsConfig?: {               // For muxed/mpegts ports
        streamInfo?: MpegTsStreamInfo;   // Describes stream composition (static default or probed)
    };
    label: string;                 // Human-readable label for UI
}

// Unified MPEG-TS stream descriptor. Serves as both:
//   1. Static default — declared in plugin manifest or module config, describing
//      what a port expects before any stream connects.
//   2. Probed data — updated in-place when the engine probes the actual stream,
//      enriched with PIDs, measured bitrates, etc. Cached in config for offline use.
//
// The `source` field distinguishes the two states. The UI and routing engine always
// use this single structure — no separate "hint" vs "probed layout".
//
// Stream types follow ISO 13818-1 (MPEG-TS) elementary stream categories:
//   video    — video elementary stream (H.264, H.265, AV1, etc.)
//   audio    — audio elementary stream (AAC, Opus, AC-3, E-AC-3, MP2, etc.)
//   subtitle — DVB subtitle, DVB teletext, SCTE-27, or closed-caption stream
//   data     — DSM-CC, KLV metadata, or other data elementary stream

interface MpegTsStreamInfo {
    source: "static" | "probed";       // "static" = declared default; "probed" = from live stream
    probedAt?: string;                 // ISO timestamp of last probe (only when source = "probed")
    streams: MpegTsElementaryStreamInfo[];  // Elementary streams in the MPEG-TS
    programs?: MpegTsProgram[];        // MPEG-TS program table (only when source = "probed")
    acceptsAny?: boolean;              // true = port accepts/produces any MPEG-TS content
}

interface MpegTsProgram {
    programNumber: number;
    pcrPid: number;
    streamPids: number[];              // PIDs belonging to this program
}

// Each entry describes one elementary stream. All fields beyond `type` are optional
// when source = "static" (omit what is unknown). When source = "probed", the engine
// populates all fields it can discover from the PAT/PMT.
interface MpegTsElementaryStreamInfo {
    type: "video" | "audio" | "subtitle" | "data";
    pid?: number;                      // MPEG-TS PID (populated when probed)
    codec?: string;                    // e.g. "h264", "h265", "aac", "opus", "ac3"
    bitrate?: number;                  // kbps (measured when probed, advisory when static)
    language?: string;                 // ISO 639 language code
    // Video-specific
    resolution?: { width: number; height: number };
    framerate?: number;
    // Audio-specific
    channels?: number;                 // e.g. 2 = stereo, 6 = 5.1
    sampleRate?: number;               // Hz
    // Subtitle-specific
    format?: string;                   // e.g. "dvb_subtitle", "dvb_teletext", "scte27"
    // Data-specific
    dataFormat?: string;               // e.g. "dsmcc", "klv", "id3"
}
```

**Stream info** is advisory — it helps the UI show meaningful labels (e.g. "1V + 2A (H.264/AAC)") and the routing engine warn on likely mismatches, but does not prevent connections. The underlying transport is always MPEG-TS regardless of stream info.

A port's `streamInfo` starts as `source: "static"` (from the plugin manifest or module config) with only the fields the module knows upfront. When the engine probes a live stream (§3.2.7), the same `streamInfo` is updated to `source: "probed"` with full details (PIDs, measured bitrates, resolution, etc.). This probed state is cached in the module's stored configuration so the manager UI can display it even when the engine is offline. When the stream reconnects and the layout differs, the `streamInfo` is re-probed and the cache updated.

**Port examples by module type:**

| Module | Port ID | Dir | Stream Type | Stream Info (static default) | Label |
|--------|---------|-----|-------------|----------------------------|-------|
| SrtInput | `mpegts_out` | out | `muxed/mpegts` | `{ source: "static", streams: [{ type: "video", codec: "h264" }, { type: "audio", codec: "aac", channels: 2 }] }` | "MPEG-TS Output" |
| SrtOutput | `mpegts_in` | in | `muxed/mpegts` | `{ source: "static", acceptsAny: true }` | "MPEG-TS Input" |
| VideoEncoder | `video_in` | in | `video/raw` | — | "Raw Video Input" |
| VideoEncoder | `audio_in` | in | `audio/pcm` | — | "Audio Input (optional)" |
| VideoEncoder | `mpegts_out` | out | `muxed/mpegts` | *(dynamic — updated from module config)* | "MPEG-TS Output" |
| VideoDecoder | `mpegts_in` | in | `muxed/mpegts` | `{ source: "static", acceptsAny: true }` | "MPEG-TS Input" |
| VideoDecoder | `video_out` | out | `video/raw` | — | "Raw Video Output" |
| VideoDecoder | `audio_out_1..N` | out | `audio/pcm` | — | "Audio Output 1..N" |
| VideoPlayer | `video_in` | in | `video/raw` | — | "Raw Video Input" |
| AudioEncoder | `audio_in` | in | `audio/pcm` | — | "PCM Input" |
| AudioEncoder | `mpegts_out` | out | `muxed/mpegts` | *(dynamic — updated from module config)* | "MPEG-TS Output" |
| AudioDecoder | `mpegts_in` | in | `muxed/mpegts` | `{ source: "static", streams: [{ type: "audio" }] }` | "MPEG-TS Input" |
| AudioDecoder | `audio_out` | out | `audio/pcm` | — | "PCM Output" |
| MpegTsMuxer | `mpegts_in_1..N` | in | `muxed/mpegts` | `{ source: "static", acceptsAny: true }` | "MPEG-TS Input 1..N" |
| MpegTsMuxer | `mpegts_out` | out | `muxed/mpegts` | *(dynamic — depends on inputs)* | "MPEG-TS Out (Muxed)" |
| MpegTsDemuxer | `mpegts_in` | in | `muxed/mpegts` | `{ source: "static", acceptsAny: true }` | "MPEG-TS Input" |
| MpegTsDemuxer | `audio_out_1..N` | out | `audio/pcm` | — | "Audio Output 1..N" |
| MpegTsDemuxer | `video_out` | out | `video/raw` | — | "Raw Video Output" |
| MpegTsDemuxer | `mpegts_video_out` | out | `muxed/mpegts` | `{ source: "static", streams: [{ type: "video" }] }` | "Video Passthrough" |
| HlsInput | `mpegts_out` | out | `muxed/mpegts` | *(dynamic — probed from HLS source)* | "MPEG-TS Output" |
| HlsInput | `audio_out_1..N` | out | `audio/pcm` | — | "Audio Output 1..N" |
| AudioInput | `audio_out` | out | `audio/pcm` | — | "PCM Output" |
| AudioOutput | `audio_in` | in | `audio/pcm` | — | "PCM Input" |
| N1Mixer | `audio_in_1..N` | in | `audio/pcm` | — | "Input 1..N" |
| N1Mixer | `audio_out_1..N` | out | `audio/pcm` | — | "Monitor 1..N" |

#### 3.2.3 Links

A **link** connects an output port on one module to an input port on another module:

```typescript
interface StreamLink {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    destModuleId: string;
    destPortId: string;
    channelMapping?: ChannelMapping;  // Per-channel routing for audio
}

interface ChannelMapping {
    // Maps destination channel index → source channel index
    // e.g. { 0: 0, 1: 1 } = stereo passthrough
    // e.g. { 0: 2, 1: 3 } = channels 3+4 from source → stereo destination
    [destChannel: number]: number;
}
```

#### 3.2.4 Routing Operations

The stream router supports these operations:

| Operation | Description | Implementation |
|-----------|-------------|----------------|
| **Route** | Connect output port → input port of same stream type | PipeWire link (audio/pcm) or media IPC between child processes (MPEG-TS, video/raw) |
| **Split (MPEG-TS)** | One MPEG-TS output → multiple inputs | GStreamer `tee` element in source child process; media IPC to multiple destination processes |
| **Split (raw video)** | One raw video output → multiple inputs | GStreamer `tee` element in decoder child process; media IPC to multiple destinations (e.g. encoder + player) |
| **Combine** | Multiple MPEG-TS inputs → one output | GStreamer `mpegtsmux` in destination child process; receives media IPC from multiple sources |
| **Encode** | Package audio/pcm into MPEG-TS (AudioEncoder), or encode raw video into MPEG-TS (VideoEncoder) | AudioEncoder encodes PipeWire PCM stream into selected codec (e.g. Opus, AAC) and packages in MPEG-TS container. VideoEncoder encodes raw video frames into selected codec (e.g. H.264) and packages in MPEG-TS. Dedicated MpegTsMuxer available for combining multiple encoded streams. |
| **Decode** | Extract audio/video from MPEG-TS | AudioDecoder auto-detects codec and outputs audio/pcm. VideoDecoder auto-detects codec and outputs video/raw + audio/pcm. Dedicated MpegTsDemuxer available for fine-grained stream splitting. |
| **Mix** | Multiple PCM audio inputs → one output | PipeWire mixer node (kernel-space, no Node.js involvement) |
| **Channel map** | Route specific audio channels from multi-channel source | PipeWire channel routing or `deinterleave`/`interleave` elements |

**Data path architecture:** The engine's Node.js process acts purely as a control plane — it uses control IPC to manage module lifecycle, link state, and configuration. The media data plane is entirely external: PipeWire handles audio in kernel space, MPEG-TS streams and raw video frames flow between GStreamer child processes via media IPC (Unix domain sockets, shared-memory, or named pipes). This ensures the Node.js event loop is never blocked by media throughput.

#### 3.2.5 PipeWire Audio Routing

**v1.0 problem:** PulseAudio loopback modules with rate-limited `pactl` commands (200ms queue delay), causing routing instability and wrong destinations.

**v2.0 approach:** Use PipeWire's native linking API (`pw-link` or libpipewire bindings) for audio/pcm streams:

```
Source Module (PipeWire sink) ──pw-link──▶ Destination Module (PipeWire source)
```

- No loopback modules — direct node-to-node links
- Per-channel routing via PipeWire port connections
- Link state monitoring for stability detection
- No rate limiting needed (PipeWire handles concurrency)

**Device-level PCM audio settings:** Each engine has a configured sample rate and bit depth (`AudioDeviceSettings` in `EngineConfig`). On startup, the engine configures PipeWire's default format to match these settings. All audio streams on the device — whether from PipeWire audio modules, decoded from MPEG-TS, or captured from hardware — are converted to the device sample rate and bit depth. This ensures a single consistent format across the entire PipeWire graph, avoiding per-link resampling and simplifying routing. The settings are configured per engine in the manager UI and pushed to the engine on connection.

**Carried forward:** The `MR_PW_` naming prefix (replacing `MR_PA_`) for Media Router-managed PipeWire nodes, enabling cleanup of stale nodes on startup.

#### 3.2.6 N-1 Mixer Module

The N-1 mixer is a specialised PipeWire audio module for broadcast monitoring:

```
                    ┌─────────────────────────────┐
  Translator A ────▶│ In/Out Pair A               │────▶ Translator A
  (return audio)    │   Out = mix of B + C + D    │     (monitor feed)
                    │                             │
  Translator B ────▶│ In/Out Pair B               │────▶ Translator B
  (return audio)    │   Out = mix of A + C + D    │     (monitor feed)
                    │                             │
  Translator C ────▶│ In/Out Pair C               │────▶ Translator C
  (return audio)    │   Out = mix of A + B + D    │     (monitor feed)
                    │                             │
  Translator D ────▶│ In/Out Pair D               │────▶ Translator D
  (return audio)    │   Out = mix of A + B + C    │     (monitor feed)
                    └─────────────────────────────┘
```

- Configurable number of input/output pairs
- Each output carries a mix of **all inputs except** its own paired input
- Implemented as PipeWire mixing nodes with per-pair filter graphs
- Volume control per pair input (operator can adjust individual source levels in their monitor)

#### 3.2.7 MPEG-TS Stream Probing

When a module first receives an MPEG-TS stream (SRT input connects, RIST link comes up, HLS playlist resolves), the engine probes the incoming stream to discover its actual content. The port's `MpegTsStreamInfo` (§3.2.2) is updated in-place from `source: "static"` to `source: "probed"` with full details.

**Probing flow:**

```
MPEG-TS stream connects (SRT/RIST/HLS)
  ↓
GStreamer child process inspects PAT/PMT tables
  ↓
Extracts: programme list, PIDs, codec types, audio channel counts,
          languages, bitrates, resolution, sample rates
  ↓
Reports probed data to engine via control IPC
  ↓
Engine updates the port's MpegTsStreamInfo:
  source → "probed", probedAt → now, streams[] populated with PIDs/codecs/etc.
  ↓
Engine caches updated streamInfo in module config → synced to manager
  ↓
Engine matches probed streamInfo against downstream port streamInfo best-effort:
  • Audio stream count ≥ linked decoder/output count? OK
  • Video codec matches downstream expectation? OK
  • Audio codec / channels / sample rate compatible? OK
  • Mismatch? Log warning, continue with best-effort routing
```

**Offline config:** Because the probed `streamInfo` is cached in the module's stored configuration (synced to the manager database), the manager UI can display full stream details even when the engine is offline. This enables informed configuration changes without a live connection. The cache is updated whenever the stream reconnects and the content differs from the stored state.

**Best-effort matching:** When the probed `streamInfo` on a source port does not match the `streamInfo` on a downstream destination port (e.g. source has 3 audio streams but destination expects 1, or the video codec is H.265 but destination expects `"h264"`), the engine:

1. Routes what it can — partial matches are routed rather than failing entirely
2. Logs a warning to the device log with details: source vs destination stream info, which links could not be satisfied
3. Reports the mismatch as a module warning (visible via the module state icon in the UI)
4. If the stream content changes during runtime (e.g. HLS variant switch), re-probes and re-evaluates matches

### 3.3 Encoding & Decoding

#### 3.3.1 Codec Capability Detection

On startup, the engine probes the host system for available hardware acceleration:

```typescript
interface CodecCapabilities {
    encoders: CodecInfo[];
    decoders: CodecInfo[];
}

interface CodecInfo {
    codec: "h264" | "h265" | "av1" | "opus" | "aac" | "pcm";
    type: "hardware" | "software";
    api?: "v4l2" | "vaapi";              // Hardware API if applicable
    gstElement: string;                   // GStreamer element name (e.g. "v4l2h264enc", "x264enc")
    maxResolution?: { width: number; height: number };
    maxFramerate?: number;
}
```

**Detection method:**
1. Query GStreamer element factory for available encoder/decoder elements
2. Probe V4L2 devices (`/dev/video*`) for hardware codec support
3. Check VAAPI availability via `vainfo`
4. Build capability map and report to manager on connection

**Selection logic:**
- Hardware encoder/decoder selected by default when available
- Software fallback always registered for H.264 and H.265
- The codec dropdown in AudioEncoder/VideoEncoder module config only shows codecs available on the target engine (based on reported capabilities)
- User can override to force software encoding where hardware is available
- Decoder modules (AudioDecoder, VideoDecoder) auto-detect — they do not expose a codec selection; the capability map determines which decoders are available at runtime

#### 3.3.2 Encoder/Decoder Modules

There is one encoder and one decoder module per media type (audio, video). The user selects the target codec on encoder modules; decoder modules auto-detect the incoming codec.

| Module | Input Port(s) | Output Port(s) | Codec Selection |
|--------|--------------|----------------|-----------------|
| **AudioEncoder** | `audio/pcm` | `muxed/mpegts` (encoded audio) | User selects codec: Opus, AAC, or PCM passthrough. Available choices filtered by engine capabilities. |
| **AudioDecoder** | `muxed/mpegts` | `audio/pcm` | Auto-detect: inspects incoming stream and decodes accordingly. |
| **VideoEncoder** | `video/raw` (piped) **or** V4L2 capture device + `audio/pcm` (optional) | `muxed/mpegts` (encoded video + optional audio) | User selects codec: H.264, H.265, (AV1 P3). User selects video source mode: piped raw stream or V4L2 device. |
| **VideoDecoder** | `muxed/mpegts` | `video/raw` + `audio/pcm` (if audio present) | Auto-detect: inspects incoming codec and decodes accordingly. |
| **VideoPlayer** | `video/raw` (piped) | *(display output — no stream ports)* | Renders raw video frames to a configured display output (e.g. HDMI via DRM/KMS). |
| **MpegTsMuxer** | N × `muxed/mpegts` | `muxed/mpegts` (combined) | — |
| **MpegTsDemuxer** | `muxed/mpegts` | N × `audio/pcm` + `video/raw` (decoded) or `muxed/mpegts` (video passthrough) | — |

**AudioEncoder / AudioDecoder:** Single module each. The AudioEncoder receives a PipeWire PCM stream, encodes it with the selected codec (e.g. `codec: "opus"`, `"aac"`, or `"pcm"` for raw PCM passthrough), and packages the result in an MPEG-TS container — this is the standard path from the PipeWire audio domain into the MPEG-TS transport domain. The AudioDecoder performs the reverse: it receives an MPEG-TS stream containing audio, auto-detects the codec from the PMT, decodes, and outputs PCM to PipeWire.

**VideoEncoder:** Accepts raw video input from one of two sources:
- **Piped raw video** (`video/raw` input port) — receives decoded frames from a VideoDecoder or another raw video source via media IPC. Enables transcoding workflows (e.g. decode H.265 → re-encode as H.264).
- **V4L2 capture device** — captures directly from a camera or capture card. The device is selected in the module configuration (populated from the engine's discovered V4L2 device list).

The encoder always outputs MPEG-TS. An optional `audio/pcm` input is muxed into the output stream alongside the encoded video.

**VideoDecoder:** Outputs decoded raw video frames on a `video/raw` output port. The raw video output can be split (via GStreamer `tee`) to multiple destinations — e.g. one feed to a VideoPlayer for local monitoring and another to a VideoEncoder for transcoding. If the input MPEG-TS contains audio, it is also extracted as `audio/pcm` output(s).

**VideoPlayer:** Receives a piped `video/raw` stream and renders it to a display output. Configured with target display device (e.g. HDMI-1). Does not produce any output stream ports — it is a terminal sink module.

For complex workflows, dedicated **MpegTsMuxer**/**MpegTsDemuxer** modules allow fine-grained stream composition and splitting without encoding/decoding.

### 3.4 Protocol Modules

#### 3.4.1 SRT Modules

**Carried forward from v1.0:** SRT URI generation, connection modes (caller/listener/rendezvous), encryption, stats collection.

| Module | Direction | Ports | Modes |
|--------|-----------|-------|-------|
| SrtInput | Receive | Output: `muxed/mpegts` | caller, listener, rendezvous |
| SrtOutput | Send | Input: `muxed/mpegts` | caller, listener, rendezvous |

**Relay** is no longer a dedicated module. An SRT relay is achieved by linking an SrtInput's MPEG-TS output to an SrtOutput's MPEG-TS input in the routing editor — the v2.0 MPEG-TS routing domain handles this natively.

**Point-to-multipoint (new):** SRT listener mode already supports multiple callers (v1.0's `caller_count` tracks this). v2.0 makes this explicit with per-caller stats and the ability to accept/reject callers.

**SRT configuration:**
```typescript
interface SrtConfig {
    host: string;           // "0.0.0.0" for listener
    port: number;
    mode: "caller" | "listener" | "rendezvous";
    latency: number;        // ms
    streamId?: string;
    passphrase?: string;    // Min 10 chars, enables encryption
    pbKeyLen: 16 | 24 | 32;
    maxBandwidth?: number;  // Percentage of stream bitrate
    // Cross-device link reference (populated by manager)
    linkedSourceModule?: {
        engineId: string;
        moduleId: string;
    };
}
```

#### 3.4.2 RIST Modules

**Carried forward from v1.0:** RIST URL generation, multi-link support for redundancy.

| Module | Direction | Ports |
|--------|-----------|-------|
| RistInput | Receive | Output: `muxed/mpegts` |
| RistOutput | Send | Input: `muxed/mpegts` |

**Point-to-multipoint:** RIST natively supports multiple peers per session. Configuration uses the existing multi-link URL format:

```
rist://host1:port1?cname=link1&buffer=50,rist://host2:port2?cname=link2
```

#### 3.4.3 WebRTC (External — MediaMTX)

WebRTC ingress and egress are handled by an external **MediaMTX** service running alongside the engine, not by built-in modules. The engine publishes MPEG-TS streams to MediaMTX (via SRT or RIST output) and receives streams from MediaMTX (via SRT or RIST input). MediaMTX handles the WebRTC signalling, WHEP/WHIP endpoints, and browser-facing transport.

This replaces the v1.0 built-in WHEP audio server and WebRTC client modules.

#### 3.4.4 HLS Module

**Carried forward from v1.0:** HLS playlist parsing, multi-audio/subtitle stream selection, VOD playback control.

| Module | Direction | Ports |
|--------|-----------|-------|
| HlsInput | Receive | Output: N × `audio/pcm` + `muxed/mpegts` |

**Segment format support:** HLS streams use either MPEG-TS segments (traditional HLS) or fMP4/CMAF segments (modern HLS, required for HLS with fMP4 / CMAF / low-latency HLS). The HlsInput module handles both transparently:

| Source Segment Format | Output | Processing |
|----------------------|--------|------------|
| MPEG-TS (`.ts`) | `muxed/mpegts` | Direct passthrough — segments are forwarded to the output port as-is |
| fMP4 / CMAF (`.m4s` + `init.mp4`) | `muxed/mpegts` | Transmux — the GStreamer child process demuxes the fMP4 container (via `qtdemux` or `ismldemux`) and remuxes the elementary streams into MPEG-TS (via `mpegtsmux`). No re-encoding occurs; codec payloads are copied directly. |

The output port always produces `muxed/mpegts` regardless of the source segment format. This ensures downstream modules (decoders, SRT outputs, etc.) receive a consistent transport format.

**Resolution & codec change handling:** HLS Adaptive Bitrate (ABR) streaming may switch between variants with different resolutions, bitrates, or codecs during playback. The HlsInput module handles this:

1. **Detection** — GStreamer's `hlsdemux` element signals a caps renegotiation when the variant changes. The child process detects the new resolution, bitrate, and/or codec.
2. **Continuity** — The MPEG-TS output stream is updated to reflect the new parameters. For resolution changes, the video PID remains stable but the stream carries the new resolution; downstream decoders handle the change via GStreamer caps renegotiation.
3. **Re-probe** — The module triggers a re-probe (§3.2.7), updating the port's `MpegTsStreamInfo` with the new codec, resolution, bitrate, and channel details.
4. **Notification** — The updated layout is reported to the manager and cached. If the change causes a mismatch with downstream link hints (e.g. resolution exceeds a linked encoder's configured max), a warning is logged and reported via the module state icon.
5. **Subtitle & audio track continuity** — When switching variants, alternative audio and subtitle renditions (EXT-X-MEDIA) are maintained. If the new variant lacks a previously-active audio rendition, the module logs a warning.

### 3.5 Child Process Management

**Carried forward from v1.0:** Each GStreamer pipeline runs in an isolated child process communicating with the engine via control IPC (Node.js `child_process` IPC channel). Media data between child processes flows separately via media IPC (§3.2.1).

```typescript
interface ChildProcessConfig {
    command: string;              // GStreamer pipeline or module command
    restartPolicy: {
        maxRestarts: number;      // Default: 10
        baseDelay: number;        // Default: 3000ms
        maxDelay: number;         // Default: 60000ms
        backoffMultiplier: number; // Default: 2
        stableAfter: number;      // Default: 30000ms (reset counter)
    };
    ipcMessages: {
        // Typed message definitions for parent↔child communication
        [messageName: string]: { request: unknown; response: unknown };
    };
}
```

**Changed from v1.0:**
- Typed control IPC messages (v1.0 uses untyped `[msg, data]` arrays)
- Graceful shutdown sequence: `SIGTERM` → 2s wait → `SIGKILL` (carried forward)
- No `abort()` calls — all memory leaks must be fixed, not worked around

### 3.6 Concurrency & External Process Safety

Node.js is single-threaded, but external process management introduces concurrency hazards: a child process can exit at any moment, PipeWire operations are asynchronous, and config updates can arrive while a module is mid-start or mid-stop. The engine must handle all of these safely.

#### 3.6.1 Module Lifecycle Serialisation

Each module instance maintains a **state machine** with a per-module operation queue. Concurrent lifecycle operations on the same module are serialised:

```typescript
type ModuleState = "idle" | "starting" | "running" | "stopping" | "error";

interface ModuleLifecycle {
    state: ModuleState;
    // Queue ensures only one lifecycle transition runs at a time per module
    enqueue(operation: () => Promise<void>): Promise<void>;
}
```

**Serialisation rules:**
- `start()` while `starting` → queued (not duplicated)
- `stop()` while `starting` → queued, runs after start completes
- `start()` while `stopping` → queued, runs after stop completes
- `configUpdate()` while `starting` or `stopping` → queued
- Rapid `stop()` + `start()` (restart) → both queued in order, no interleaving

This prevents the v1.0 race condition where a `run = false` followed by `run = true` could arrive before the first transition completed, leading to orphaned processes or double-starts.

#### 3.6.2 Child Process Tracking

The engine maintains a **process registry** that tracks every spawned child process:

```typescript
interface ProcessRegistry {
    // Register a spawned process — tracked until confirmed dead
    register(moduleId: string, process: ChildProcess): void;

    // Mark process as terminated (on 'exit' event)
    unregister(moduleId: string, pid: number): void;

    // Kill all tracked processes (engine shutdown)
    killAll(signal?: NodeJS.Signals): Promise<void>;

    // Get orphan processes (registered but not associated with active module)
    getOrphans(): ChildProcess[];
}
```

**Invariants:**
- Every `spawn()` call registers the process before returning
- Every `exit` event unregisters the process
- `killAll()` is called on module stop-all (§3.6.5) and engine process shutdown (§3.6.6)
- On module destroy, the module's process is killed and awaited before the module is removed from the registry
- A periodic sweep (every 60s) checks for orphaned processes (child still alive but module removed) and kills them

#### 3.6.3 PipeWire Operation Safety

PipeWire link operations (`pw-link`, node creation/destruction) are asynchronous external commands. They must be handled carefully:

```typescript
interface PipeWireManager {
    // All operations return Promises — caller must await
    createNode(config: PipeWireNodeConfig): Promise<PipeWireNode>;
    destroyNode(nodeId: string): Promise<void>;
    createLink(sourcePort: string, destPort: string): Promise<PipeWireLink>;
    destroyLink(linkId: string): Promise<void>;

    // Cleanup all Media Router-managed nodes/links
    cleanupAll(): Promise<void>;
}
```

**Concurrency rules:**
- PipeWire operations for a given module are serialised through the module's lifecycle queue (3.6.1)
- Cross-module PipeWire operations (creating a link between module A's output and module B's input) acquire both modules' queues to prevent one module from being destroyed mid-link
- Node/link creation is **idempotent** — if a node already exists with the same `MR_PW_` name, it is reused rather than duplicated
- On failure (pw-link returns non-zero), the operation is retried once after 500ms before reporting error
- All `MR_PW_` prefixed nodes and links are cleaned up on engine startup (carried forward from v1.0's `MR_PA_` cleanup pattern)

#### 3.6.4 Control IPC Message Ordering

Control IPC is inherently ordered (Node.js IPC uses a single pipe), but responses may be interleaved with unsolicited messages (stats, VU data). The engine handles this with:

```typescript
interface IpcChannel {
    // Request-response with timeout (correlates by request ID)
    request(message: string, data?: unknown, timeout?: number): Promise<unknown>;

    // Unsolicited message handler
    on(message: string, handler: (data: unknown) => void): void;
}
```

- Each `request()` call generates a unique ID and waits for a response with the matching ID
- If the child process exits before responding, pending requests are rejected with an error
- Unsolicited messages (VU data, stats) are delivered to registered handlers independently of request/response flow
- A configurable timeout (default 5s) prevents hanging requests if a child becomes unresponsive

#### 3.6.5 Module Stop-All Sequence

When the user stops all modules (or switches profile), the engine stops its media processing but **remains running** — the manager connection, Local API, and local control panel stay active at all times.

```
1. Set engine state = "stopping" (reject new module start operations)
2. Notify manager of stop-all
3. Stop all modules in parallel (each module's stop is serialised internally)
4. Await all module stop completions (with 10s timeout)
5. Kill any remaining child processes (ProcessRegistry.killAll)
6. Destroy all PipeWire nodes and links (PipeWireManager.cleanupAll)
7. Close control IPC channels and media IPC pipes for stopped modules
8. Set engine state = "idle" (ready to accept new start operations)
```

If step 4 times out, step 5 force-kills remaining processes. No process is left orphaned.

The engine process itself does **not** exit. The manager connection (dgram-comms UDP), Local API (Fastify), and local control panel (Socket.IO) remain active throughout. The engine can be restarted (modules started again) at any time via the manager or local control panel.

#### 3.6.6 Engine Process Shutdown

Full engine process restart typically occurs when the user selects "reset" (from the manager or local control panel), or on system shutdown (`SIGTERM`/`SIGINT`). The engine process exits and is restarted by the system service manager (e.g. systemd):

```
1. Run module stop-all sequence (§3.6.5)
2. Close manager connection
3. Close Local API server
4. Close local control panel Socket.IO
5. Flush logs
6. Exit
```

#### 3.6.7 Resource Leak Detection

In development and optionally in production, the engine periodically audits tracked resources:

| Check | Interval | Action |
|-------|----------|--------|
| Orphaned child processes | 60s | Log warning, kill if unresponsive |
| Stale PipeWire `MR_PW_` nodes | 60s | Log warning, clean up if module not active |
| Open file descriptor count | 300s | Log warning if above threshold (default: 512) |
| Control IPC channels without active module | 60s | Close and log |

### 3.7 Autonomous Operation

When the manager connection is lost, the engine:

1. Continues running with last-known configuration (carried forward from v1.0 `firstConnect` pattern)
2. Retries manager connection at a fixed interval (default: 5 seconds) to ensure speedy reconnection
3. Buffers status updates and delivers on reconnection
4. Local API and local control panel remain fully functional
5. Logs manager disconnection event

---

## 4. Manager

### 4.1 Architecture

The manager is a NestJS application providing:

```
┌─────────────────────────────────────────────────────────┐
│                    Manager (NestJS)                       │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │                   NestJS Modules                     │ │
│  │                                                     │ │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │ │
│  │  │ Engine     │  │ Config     │  │ Auth         │  │ │
│  │  │ Module     │  │ Module     │  │ Module       │  │ │
│  │  │            │  │            │  │              │  │ │
│  │  │ • status   │  │ • profiles │  │ • users      │  │ │
│  │  │ • comms    │  │ • schemas  │  │ • roles      │  │ │
│  │  │ • codec    │  │ • versions │  │ • permissions│  │ │
│  │  │   caps     │  │ • atomic   │  │ • sessions   │  │ │
│  │  │ • links    │  │   writes   │  │ • rate limit │  │ │
│  │  └────────────┘  └────────────┘  └──────────────┘  │ │
│  │                                                     │ │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │ │
│  │  │ Link       │  │ UI Gateway │  │ Audit        │  │ │
│  │  │ Resolver   │  │ (Socket.IO)│  │ Module       │  │ │
│  │  │            │  │            │  │              │  │ │
│  │  │ • cross-   │  │ • realtime │  │ • change log │  │ │
│  │  │   device   │  │ • delta    │  │ • user       │  │ │
│  │  │ • breaking │  │   updates  │  │   actions    │  │ │
│  │  │   change   │  │ • RBAC     │  │              │  │ │
│  │  │   detect   │  │   filter   │  │              │  │ │
│  │  └────────────┘  └────────────┘  └──────────────┘  │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              dgram-comms v2 (UDP Server)             │ │
│  │  Encrypted, multi-path, guaranteed delivery          │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Configuration Store

#### 4.2.1 Storage Format

Configuration is stored in an **SQLite database** with a table entry per engine. This replaces v1.0's single JSON file dump and provides transactional writes, concurrent access safety, and structured querying.

```typescript
interface ConfigStore {
    getEngine(engineId: string): Promise<EngineConfig>;
    getAllEngines(): Promise<EngineConfig[]>;
    saveEngine(engineId: string, config: EngineConfig): Promise<void>;
    deleteEngine(engineId: string): Promise<void>;
    validate(data: object, schema: JSONSchema): ValidationResult;
    backup(): Promise<string>;  // Returns backup file path
}
```

**Database schema (logical):**

```sql
-- One row per engine
CREATE TABLE engines (
    engine_id   TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    config      TEXT NOT NULL,          -- JSON blob (full EngineConfig)
    active_profile_id TEXT,
    schema_version TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User accounts (manager-level)
CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'operator',
    permissions TEXT,                    -- JSON blob (Permission[])
    disabled    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    user_id     TEXT,
    engine_id   TEXT,
    action      TEXT NOT NULL,
    details     TEXT                     -- JSON blob
);
```

**Key benefits over v1.0 JSON file:**
- **Transactional writes** — SQLite's WAL mode ensures no partial writes on crash
- **Per-engine storage** — modifying one engine's config does not rewrite all configs
- **Structured queries** — find engines by name, list profiles, audit log queries
- **Concurrent access** — multiple Socket.IO connections can read safely
- **Built-in backup** — `VACUUM INTO` for point-in-time database snapshots

**Write sequence:**
1. Validate data against JSON Schema
2. Begin SQLite transaction
3. Update engine row with new config JSON
4. Commit transaction (atomic — either fully applied or rolled back)

**Import/export** uses JSON format for portability: the engine config JSON blob is extracted from/inserted into the database, so import/export files remain human-readable JSON.

#### 4.2.2 Configuration Schema

The engine config JSON blob stored in SQLite is validated against a versioned JSON Schema before applying:

```typescript
interface EngineConfig {
    schemaVersion: string;          // e.g. "2.0.0"
    engineId: string;               // Unique identifier
    displayName: string;
    audio: AudioDeviceSettings;     // Device-level PCM audio settings
    profiles: {
        [profileId: string]: ProfileConfig;
    };
    activeProfileId: string | null;
    localUsers: LocalUserAccount[];  // Pushed to engine on connection
    codecCapabilities?: CodecCapabilities;  // Reported by engine
}

interface AudioDeviceSettings {
    sampleRate: 44100 | 48000 | 96000;  // Device-wide sample rate (default: 48000)
    bitDepth: 16 | 24 | 32;             // Device-wide bit depth (default: 24)
}

interface ProfileConfig {
    name: string;                   // Human-readable (e.g. "Sunday Service")
    modules: {
        [moduleId: string]: ModuleConfig;
    };
    links: StreamLink[];            // Connections between modules
    crossDeviceLinks: CrossDeviceLink[];  // References to modules on other engines
}

interface ModuleConfig {
    pluginId: string;               // Plugin type identifier
    displayName: string;
    enabled: boolean;
    settings: Record<string, unknown>;  // Plugin-specific settings
    ports: ModulePort[];            // Declared by plugin, may be dynamic
    operatorVisible: boolean;       // Show in local control panel
    position?: { x: number; y: number };  // Position in routing editor
    // No separate cached layout — probed data is stored in each port's streamInfo (source: "probed")
}
```

#### 4.2.3 Schema Migration

When the schema version in a stored config doesn't match the current version, a migration pipeline runs:

```
v2.0.0 → v2.1.0 → v2.2.0 → ... → current
```

Each migration is a function `(oldConfig) => newConfig`. Migrations are sequential and idempotent.

#### 4.2.4 Configuration Version History

The manager keeps the last 10 versions of each engine's configuration for rollback:

```sql
CREATE TABLE engine_config_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    engine_id   TEXT NOT NULL REFERENCES engines(engine_id),
    config      TEXT NOT NULL,          -- Full EngineConfig JSON snapshot
    saved_at    TEXT NOT NULL,          -- ISO timestamp
    label       TEXT                    -- Optional user label (e.g. "Before codec change")
);
-- Index for per-engine queries, oldest versions pruned when count > 10
CREATE INDEX idx_history_engine ON engine_config_history(engine_id, saved_at);
```

**Deferred snapshotting:** To avoid storing intermediate states during active editing, a new version is only committed after **10 minutes of configuration inactivity** (no further writes to that engine's config). The manager maintains a per-engine debounce timer:

```
Config write arrives for engine X
  ↓
Reset engine X's snapshot timer to 10 minutes
  ↓
Timer fires (no further writes for 10 min)
  ↓
Snapshot current config → engine_config_history
  ↓
If engine X has > 10 versions, delete oldest
```

**Rollback flow:**

1. User opens version history for an engine (manager UI)
2. Manager lists stored versions with timestamps and optional labels
3. User selects a version to preview (diff view against current config)
4. User confirms restore → manager replaces current config with selected version
5. If the engine is online, the restored config is pushed immediately

The current (live) config is always the `config` column in the `engines` table. The `engine_config_history` table holds only historical snapshots.

### 4.3 Configuration Profiles

Each engine supports multiple named profiles. Only one profile is active at a time.

**Profile operations:**

| Operation | Behaviour |
|-----------|-----------|
| Create | New empty profile or duplicate of existing |
| Switch | Stop current config → apply selected profile → optionally auto-start |
| Edit (inactive) | Changes stored but do NOT affect running engine |
| Edit (active) | Changes applied to running engine in real time |
| Rename | Update profile name (no effect on content) |
| Delete | Prevented if last remaining profile |
| Import | Load JSON file as new named profile (inserted into database) |
| Export | Download single profile as JSON |

**Profile indicator in the UI:**

- The **active profile** is shown with a "Live" badge (e.g. green pill) next to the profile name in the device header and in the profile selector dropdown.
- When the user opens a **non-active profile** for editing, the routing editor displays a prominent **banner** across the top (e.g. amber/yellow bar: *"Editing profile 'Lab Testing' — this profile is not active on the device"*). The banner includes a quick-action button to activate the profile.
- The routing editor background or border colour shifts subtly (e.g. slightly desaturated or tinted) when editing a non-active profile, providing a persistent ambient cue beyond the banner.
- Live module status (VU meters, connection state, health icons) is **not shown** when viewing a non-active profile, since those modules are not running. The nodes render in a static/blueprint style instead.

### 4.4 Cross-Device Module Discovery & Config Linking

#### 4.4.1 Link Resolution

When a user configures an SRT/RIST input module, the manager can auto-populate settings from a compatible output module on another engine:

```typescript
interface CrossDeviceLink {
    id: string;
    destEngineId: string;
    destModuleId: string;
    destPortId: string;
    sourceEngineId: string;
    sourceModuleId: string;
    sourcePortId: string;
    autoSync: boolean;           // Currently linked (vs manually overridden)
}
```

#### 4.4.2 Compatible Source Discovery

The manager builds a list of compatible sources by scanning all engine configs:

```
User selects SRT input module on Engine A
  ↓
Manager scans all engines for SRT/RIST output modules
  ↓
Filters by protocol compatibility (SRT↔SRT, RIST↔RIST)
  ↓
Presents list: "Engine B / SrtOutput_1 (port 8890, H.264+Opus)"
  ↓
User selects → auto-populate: port, codec, channels, encryption, mode
```

#### 4.4.3 Change Propagation

When a source module's configuration changes, the Link Resolver classifies the change:

| Change Type | Classification | Action |
|-------------|---------------|--------|
| Port number | Non-breaking | Auto-propagate to linked destinations |
| Encryption passphrase | Non-breaking | Auto-propagate |
| Codec, channel count | Non-breaking | Auto-propagate |
| Bitrate, latency | Non-breaking | Auto-propagate |
| Mode change (listener→caller) | **Breaking** | Warn user, list affected devices/modules |
| Encryption removed | **Breaking** | Warn user |
| Module deleted | **Breaking** | Warn user |

Breaking changes require explicit user confirmation before applying.

### 4.5 Engine Connection Handling

**Carried forward from v1.0:** The manager maintains a map of connected engines via dgram-comms sockets. Encryption keys are derived from engine passwords.

**Connection lifecycle:**
1. Engine connects with `clientID` (displayName) and encryption key (password)
2. Manager validates against stored engine config
3. Manager pushes full profile config to engine (chunked, carried forward from v1.0's 20ms interval approach)
4. Engine reports codec capabilities
5. Bidirectional config sync: manager pushes changes down, engine pushes status up
6. On disconnect: mark engine offline, retain config

---

## 5. Manager Web UI

### 5.1 Application Architecture

```
┌─────────────────────────────────────────────────────────┐
│                Vue.js Application                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Pinia    │  │ Socket.IO│  │ Vue Router             │ │
│  │ Stores   │  │ Client   │  │                        │ │
│  │          │  │          │  │ /login                 │ │
│  │ • engines│◄─┤ • events │  │ /engines               │ │
│  │ • auth   │  │ • delta  │  │ /engines/:id/routing   │ │
│  │ • ui     │  │   sync   │  │ /engines/:id/settings  │ │
│  └──────────┘  └──────────┘  │ /admin/users           │ │
│                              └────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │                   Views                               ││
│  │                                                      ││
│  │  ┌────────────────┐  ┌────────────────────────────┐  ││
│  │  │ Engine List    │  │ Visual Routing Editor      │  ││
│  │  │ (dashboard)    │  │ (Vue Flow)                 │  ││
│  │  └────────────────┘  └────────────────────────────┘  ││
│  │                                                      ││
│  │  ┌────────────────┐  ┌────────────────────────────┐  ││
│  │  │ Crosspoint     │  │ Admin Panel               │  ││
│  │  │ Matrix View    │  │ (users, roles, audit)     │  ││
│  │  └────────────────┘  └────────────────────────────┘  ││
│  └──────────────────────────────────────────────────────┘│
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │              Component Library                        ││
│  │  Button, Input, Select, Toggle, Slider, Modal, etc.  ││
│  └──────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### 5.2 State Management

**v1.0 problem:** Global variables, synchronous XHR for script loading, no central state management. The modular-ui framework handles state through its own `Set()`/`Get()` pattern with event bubbling.

**v2.0 approach:** Pinia stores with Socket.IO integration:

```typescript
// Engine store — single source of truth for all engine state
interface EngineStore {
    engines: Map<string, EngineState>;

    // Actions
    updateFromServer(delta: Partial<EngineState>): void;
    sendToServer(engineId: string, changes: object): void;
}

interface EngineState {
    config: EngineConfig;
    status: {
        online: boolean;
        cpu: number;
        memory: number;
        temperature: number;
        uptime: number;
    };
    codecCapabilities: CodecCapabilities;
    moduleStates: Map<string, ModuleRuntimeState>;
}

interface ModuleRuntimeState {
    running: boolean;
    ready: boolean;
    health: ModuleHealth;        // Overall module health for state icon
    pendingRestart: boolean;     // true = restart-required config changes are waiting to be applied
    liveUpdatableParams?: string[];  // Params that are currently live-updatable (reported by module at runtime, depends on active backend)
    vuData?: number[];           // VU meter levels
    srtStats?: SrtStatistics;    // SRT connection stats
    ristStats?: RistStatistics;
    // MPEG-TS stream info lives on the port itself (port.mpegtsConfig.streamInfo)
    error?: string;
    warnings?: string[];         // Non-fatal issues (e.g. stream layout mismatches)
}

type ModuleHealth = "ok" | "warning" | "error" | "stopped";
// ok      — running normally
// warning — running but with non-fatal issues (e.g. stream mismatch, high restart count)
// error   — failed to start, crashed, or unrecoverable issue
// stopped — not running (user-stopped or not yet started)
```

### 5.3 Visual Routing Editor

**v1.0 problem:** HTML/CSS-based line drawing between modules, fragile and hard to manage.

**v2.0 approach:** Vue Flow (DOM/SVG-based node graph library).

#### 5.3.1 Node Rendering

Each module is rendered as a Vue Flow node containing a Vue component:

```
┌─────────────────────────────────────┐
│ [●] SRT Input "Studio Feed"  [▶ ■]  │  ← Header: state icon, name, run/stop
├─────────────────────────────────────┤
│                                     │
│  Status: Connected (2 callers)      │  ← Live status
│  Bitrate: 4.2 Mbps                 │
│  RTT: 12ms                         │
│                                     │
├───────────────────────┬─────────────┤
│                       │ ● Video Out │  ← Output ports (right side)
│                       │ ● Audio Out │     Coloured by stream type
│                       │ ● Audio Out │
└───────────────────────┴─────────────┘
```

**State icon** — a coloured dot in the module header indicating current health:

| State | Icon | Colour | Meaning |
|-------|------|--------|---------|
| `ok` | ● | Green | Running normally |
| `warning` | ● | Yellow/amber | Running with non-fatal issues (e.g. stream layout mismatch, high restart count) |
| `error` | ● | Red | Failed, crashed, or unrecoverable |
| `stopped` | ○ | Grey | Not running |

Clicking the state icon opens a **diagnostic popover** showing:
- Current module state and uptime
- Any errors (stack trace summary, last crash reason)
- Warnings (e.g. "Probed stream has 4 audio tracks, only 2 linked")
- Restart history (count, timestamps)
- For MPEG-TS modules: probed stream info vs downstream port expectations

Input ports appear on the left side, output ports on the right. Port colours and optional line patterns indicate stream type:

| Stream Type | Colour | Line Pattern |
|-------------|--------|-------------|
| `muxed/mpegts` | Orange (#E67E22) | Solid |
| `audio/pcm` | Blue (#3498DB) | Dashed |
| `video/raw` | Green (#2ECC71) | Dotted |

Palette is distinguishable under protanopia, deuteranopia, and tritanopia. Line patterns provide a secondary differentiator independent of colour.

#### 5.3.2 Connection Interaction

1. User clicks an output port → drag begins
2. A provisional Bezier curve follows the cursor
3. Compatible input ports highlight; incompatible ports dim
4. Drop on compatible port → link created, sent to manager
5. Drop on empty space or incompatible port → cancelled
6. Click existing link → popover for channel mapping, stream selection
7. Right-click link → context menu (delete, etc.)
8. Right-click module node → context menu (focus toggle, delete, copy, enable/disable, etc.)
9. On mobile/touch: long-press replaces right-click for context menus

#### 5.3.3 Routing Editor Features

| Feature | Implementation |
|---------|---------------|
| Zoom/pan | Vue Flow built-in (mouse wheel, drag background) |
| Minimap | Vue Flow MiniMap component |
| Snap-to-grid | Vue Flow grid snapping |
| Multi-select | Shift+click or drag-select box |
| Auto-layout | Optional dagre/elkjs layout algorithm |
| Live VU meters | Canvas2D overlay inside module nodes (60fps capable). Click a VU meter bar → popup volume slider (live-updatable, no restart) |
| Module settings | Double-click node → settings panel/modal |
| Context menu | Right-click module node (long-press on mobile/touch) → menu with: toggle focus, delete, copy, enable/disable, restart, and other contextual actions |
| Live-updatable hint | Settings panel marks live-updatable parameters with an icon (e.g. ⚡) |
| Pending restart badge | Module node header shows a restart icon when `pendingRestart` is true |

#### 5.3.4 Focus Mode

Focus mode reduces visual noise during live operation. Every device and every module has exactly two states: **normal** and **focused**. When focus mode is off, everything renders at full colour. When focus mode is on, normal-state items are muted and focused items render at full colour.

**Two states only:**

| | Focus mode OFF | Focus mode ON — normal state | Focus mode ON — focused state |
|-|---------------|------------------------------|-------------------------------|
| **Rendering** | Full colour | Muted (light grey) | Full colour |

**Module visual behaviour (focus mode ON):**

| Element | Normal state | Focused state |
|---------|-------------|---------------|
| Module background | Light grey / 30% opacity | Full colour |
| Module text/labels | Grey | Full colour |
| VU meters | Grey bars (still animated) | Coloured bars |
| Port dots | Grey | Coloured by stream type |
| Links | Light grey / 20% opacity | Full colour (if both endpoints focused) |
| State icon | Grey (still reflects state shape ●/○) | Coloured by health |

Links render at full colour only when **both** endpoints are focused. If only one endpoint is focused, the link renders at intermediate opacity (e.g. 50%).

**Device visual behaviour (focus mode ON):**

| Element | Normal state | Focused state |
|---------|-------------|---------------|
| Device card/header | Muted / light grey | Full colour |
| Device status indicators | Grey (still live) | Full colour |
| All modules within | All muted (regardless of module state) | Per-module state applies |
| List position | Sorted to bottom of device list | Normal sort order |

On a normal-state device, all modules render muted regardless of their individual state. Module states are preserved but only take visual effect when the device is focused.

**Interaction:**

```
[Focus Mode: OFF]  ← toggle button in toolbar
        ↓ click
[Focus Mode: ON ]  ← normal-state items go muted, focused items stay full colour
        ↓ right-click device header → context menu → "Toggle Focus"
Device toggles between normal ↔ focused
  • Normal devices sort to bottom of list
        ↓ right-click module node (on a focused device) → context menu → "Toggle Focus"
Module toggles between normal ↔ focused
        ↓ click toolbar toggle again
[Focus Mode: OFF]  ← everything renders full colour (states preserved)

Mobile/touch: long-press replaces right-click to open context menus.
```

**Storage model:**

| Data | Stored where | Scope |
|------|-------------|-------|
| Focus mode on/off | Browser `localStorage` | Per-session (per-browser) — different operators on the same manager see independent toggle state |
| Device state (normal/focused) | Manager database (per-engine flag) | Shared — persists across sessions |
| Module states (per device) | Manager database (device config) | Shared — persists across sessions |

```typescript
interface EngineConfig {
    // ... existing fields ...
    focused?: boolean;            // true = focused, false/undefined = normal
    focusedModuleIds?: string[];  // Module IDs in focused state
}
```

When focus mode is off, these fields have no visual effect but are still persisted — toggling focus mode on/off does not lose selections. New devices default to normal state (`focused` undefined).

### 5.4 Engine Dashboard

The engine list view shows all managed engines with:

- Online/offline status (real-time via Socket.IO)
- Active profile name and badge
- CPU, memory, temperature indicators
- Search/filter by name or property
- Quick actions: start/stop, switch profile
- RBAC filtering: users only see engines they have permission for

### 5.5 Component Library

A shared set of Vue components for consistent styling:

- `MrButton` — Primary, secondary, danger variants
- `MrInput` — Text, number, password with validation
- `MrSelect` — Single/multi select with search
- `MrToggle` — On/off switch
- `MrSlider` — Range slider with value display
- `MrModal` — Dialog/popover
- `MrTabs` — Tab navigation
- `MrTable` — Sortable, filterable data table
- `MrVuMeter` — Canvas2D VU meter (carried forward concept, reimplemented in Vue). Clickable: opens a popup `MrSlider` for live volume adjustment

All styled with Tailwind CSS v4, supporting dark and light mode via CSS custom properties.

### 5.5.1 Colour Theme

The UI uses a **Protocol-style dark theme** as the default, with a light mode alternative. All colours are defined as CSS custom properties on `:root` (light) and `.dark` (dark), enabling runtime theme switching.

**Design language:** Deep, desaturated dark backgrounds with emerald/teal accent colour. Minimal borders, subtle card elevation, high-contrast text.

#### Dark Mode (Primary)

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#0f1117` | Page background |
| `--bg-secondary` | `#161921` | Routing editor canvas, secondary areas |
| `--bg-sidebar` | `#111318` | Sidebar navigation |
| `--bg-card` | `#1a1d27` | Cards, panels, module nodes, modals |
| `--bg-input` | `#1a1d27` | Form inputs |
| `--border-primary` | `#252833` | Card borders, panel dividers |
| `--border-secondary` | `#1e2130` | Subtle separators within cards |
| `--text-primary` | `#e2e8f0` | Headings, labels, primary content |
| `--text-secondary` | `#94a3b8` | Descriptions, secondary labels |
| `--text-muted` | `#64748b` | Placeholders, disabled text, port labels |
| `--accent` | `#10b981` | Primary buttons, active states, toggle on |
| `--accent-hover` | `#34d399` | Button hover, link hover |
| `--accent-muted` | `rgba(16, 185, 129, 0.1)` | Accent backgrounds, selection highlight |
| `--accent-text` | `#34d399` | Links, active sidebar items |

#### Light Mode

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#ffffff` | Page background |
| `--bg-secondary` | `#f8fafc` | Secondary areas |
| `--bg-sidebar` | `#f1f5f9` | Sidebar |
| `--bg-card` | `#ffffff` | Cards, panels |
| `--border-primary` | `#e2e8f0` | Borders |
| `--text-primary` | `#0f172a` | Primary text |
| `--text-secondary` | `#475569` | Secondary text |
| `--text-muted` | `#94a3b8` | Muted text |
| `--accent` | `#10b981` | Accent (same emerald) |

#### Semantic Colour Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--port-audio-pcm` | `#3b82f6` (blue) | Audio/PCM port dots and connection lines |
| `--port-muxed-mpegts` | `#f59e0b` (amber) | MPEG-TS port dots and connection lines |
| `--port-video-raw` | `#10b981` (emerald) | Video/raw port dots and connection lines |
| `--health-ok` | `#22c55e` (green) | Module running, healthy |
| `--health-warning` | `#f59e0b` (amber) | Module warning state |
| `--health-error` | `#ef4444` (red) | Module error state |
| `--health-stopped` | `#6b7280` (grey) | Module stopped |
| `--vu-green` | `#22c55e` | VU meter normal level |
| `--vu-yellow` | `#eab308` | VU meter caution level |
| `--vu-red` | `#ef4444` | VU meter clipping/peak |

#### Typography

- **Font family:** Inter, system-ui, -apple-system, sans-serif
- **Scrollbars:** Custom styled — 6px width, rounded, uses `--text-muted` / `--border-primary`

### 5.6 Responsive Design

- Desktop: Full routing editor with side panels
- Tablet: Routing editor with collapsible panels
- Mobile: Engine list and module settings as stacked views; routing editor with pinch-to-zoom

---

## 6. Local Control Panel

### 6.1 Architecture

The local control panel is a **separate Vue.js application** running on the engine device, served on a dedicated port. It is purpose-built for operators (translators, sound engineers) who need simple, direct controls.

**v1.0 carried forward:** The concept of a full-screen, dark-themed operator interface with audio mixer controls. The Electron shell for kiosk mode.

**Changed:** Rebuilt in Vue.js + TypeScript. Does NOT share components with the manager UI (different use case and interaction patterns).

### 6.2 Operator Interface

```
┌──────────────────────────────────────────────────────────┐
│  Studio Router                               [ON] [OFF]  │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ Floor   │  │ Transl. │  │ SRT Feed│  │ HLS     │    │
│  │ Mic     │  │ Return  │  │ Studio B│  │ Main    │    │
│  │         │  │         │  │         │  │         │    │
│  │ ██ ██   │  │ ██ ██   │  │ ██ ██   │  │ ██ ██   │    │
│  │ ██ ██   │  │ ██ ██   │  │ ██ ██   │  │ ██ ██   │    │
│  │ ██ ██   │  │ ██ ██   │  │    ██   │  │ ██ ██   │    │
│  │ ██      │  │ ██      │  │         │  │ ██      │    │
│  │         │  │         │  │         │  │         │    │
│  │    ●    │  │    ●    │  │  ●      │  │    ●    │    │
│  │    │    │  │    │    │  │  │      │  │    │    │    │
│  │    │    │  │    │    │  │  │      │  │    │    │    │
│  │         │  │         │  │         │  │         │    │
│  │ [MUTE]  │  │ [MUTE]  │  │ [MUTE]  │  │ [MUTE]  │    │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

**Shown controls:**
- Only modules where `operatorVisible: true`
- VU meters (Canvas2D, same as v1.0 concept)
- Vertical volume faders (touch-friendly, fader-style sliders optimised for touch-screen operation)
- Mute buttons with solo group support
- Engine start/stop toggle

### 6.3 Communication

Connects to the engine process via Socket.IO on the local network. No manager involvement — operates independently.

---

## 7. Local API

### 7.1 Architecture

The Local API is a REST API served by the engine's embedded Fastify instance on a configurable port. It replaces the v1.0 profile manager (local-profileman).

```
┌────────────────────────────────────────────────────┐
│           Engine (TypeScript + Fastify)              │
│                                                     │
│   ┌──────────────────────────────────────────────┐  │
│   │           Local API Routes                    │  │
│   │                                              │  │
│   │   /api/v1/profiles      Manager connections  │  │
│   │   /api/v1/device        Device identity      │  │
│   │   /api/v1/system/*      System info (R/O)    │  │
│   │   /api/v1/engine/*      Start/stop/restart   │  │
│   │   /api/v1/logs          Log retrieval        │  │
│   │   /api/v1/health        Health check         │  │
│   │   /api/v1/diagnostics   Module status        │  │
│   │                                              │  │
│   │   ┌────────────────────────────────────────┐ │  │
│   │   │ Auth Middleware                         │ │  │
│   │   │ • Localhost bypass                     │ │  │
│   │   │ • Session auth for remote requests     │ │  │
│   │   └────────────────────────────────────────┘ │  │
│   └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### 7.2 Response Envelope

All responses follow a standard envelope:

```typescript
// Success
{
    "status": "ok",
    "data": { ... }
}

// Error
{
    "status": "error",
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "Invalid port number: must be 1024-65535",
        "details": [ ... ]
    }
}
```

### 7.3 Endpoint Summary

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/profiles` | GET | Yes* | List manager connection profiles |
| `/api/v1/profiles` | POST | Yes* | Create profile |
| `/api/v1/profiles/:id` | GET | Yes* | Get profile |
| `/api/v1/profiles/:id` | PUT | Yes* | Update profile |
| `/api/v1/profiles/:id` | DELETE | Yes* | Delete profile |
| `/api/v1/profiles/:id/activate` | POST | Yes* | Activate (connect to manager) |
| `/api/v1/profiles/deactivate` | POST | Yes* | Disconnect from all managers |
| `/api/v1/device` | GET | Yes* | Get device identity and settings |
| `/api/v1/device` | PUT | Yes* | Update device identity and settings |
| `/api/v1/device/env` | GET | Yes* | Get environment variables |
| `/api/v1/device/env` | PUT | Yes* | Set environment variables |
| `/api/v1/system/info` | GET | Yes* | CPU, memory, temp, version |
| `/api/v1/system/audio-devices` | GET | Yes* | PipeWire sources and sinks |
| `/api/v1/system/video-devices` | GET | Yes* | V4L2 devices |
| `/api/v1/system/network` | GET | Yes* | Network interfaces |
| `/api/v1/system/ports` | GET | Yes* | Ports in use |
| `/api/v1/engine/start` | POST | Yes* | Start engine |
| `/api/v1/engine/stop` | POST | Yes* | Stop engine |
| `/api/v1/engine/restart` | POST | Yes* | Restart engine |
| `/api/v1/device/reboot` | POST | Yes* | Reboot device |
| `/api/v1/display/start` | POST | Yes* | Launch LCP kiosk |
| `/api/v1/display/stop` | POST | Yes* | Close LCP kiosk |
| `/api/v1/logs` | GET | Yes* | Retrieve logs (filterable) |
| `/api/v1/logs/stream` | WS/SSE | Yes* | Live log stream |
| `/api/v1/health` | GET | **No** | Health check (always public) |
| `/api/v1/diagnostics` | GET | Yes* | Module and process status |

\* Auth bypassed for localhost requests. Required for non-localhost when local user accounts are configured.

### 7.4 OpenAPI Documentation

The Local API ships an OpenAPI 3.x specification file auto-generated from Fastify route schemas (e.g. using `@fastify/swagger`). Available at `/api/v1/docs` (Swagger UI) in development mode.

---

## 8. Communication Layer

### 8.1 Engine ↔ Manager (dgram-comms v2)

**Carried forward from v1.0:** The dgram-comms UDP layer with encryption, guaranteed delivery, and message fragmentation. This works well for the use case and is retained with the following enhancements.

#### 8.1.1 Retained Behaviour

| Feature | Detail |
|---------|--------|
| Protocol | UDP datagrams |
| Encryption | AES-256-CBC with SHA-256 key derivation |
| Max packet size | 1412 bytes (avoids IP fragmentation) |
| Fragmentation | Header: `messageId:fragmentIndex:totalFragments:` |
| Guaranteed delivery | ACK-based with retry (10 attempts, 500ms interval) |
| Keepalive | Every `connectionTimeout/4` (1.25s default) |
| Disconnect detection | 3 missed keepalives |
| Connection flow | Client sends `connect` → Server responds `connected` |

#### 8.1.2 New: Multi-Path Delivery

For network redundancy, the engine can send each message to multiple destination IP address/port combinations simultaneously. Each path can optionally be bound to a specific network interface, or left unbound to use OS-level routing:

```
                     ┌── 10.0.1.100:3000 (via eth0) ──────▶ Manager (primary)
Engine sends to ─────┼── 10.0.2.100:3000 (via eth0) ──────▶ Manager (secondary route, same NIC)
                     └── 192.168.1.50:3000 (via wlan0) ───▶ Manager (different NIC)
```

Paths are independent destination address/port pairs — multiple paths may share the same network interface. The interface binding is optional and orthogonal to the destination address.

**Path configuration (per engine):**

```typescript
interface ManagerPath {
    host: string;           // Destination IP or hostname
    port: number;           // Destination port
    bindInterface?: string; // Optional: bind to specific NIC (e.g. "eth0", "wlan0")
    bindAddress?: string;   // Optional: bind to specific source IP
}

interface ManagerConnectionProfile {
    name: string;
    paths: ManagerPath[];   // 1 or more paths — single path for simple setups, multiple for redundancy
    encryptionKey: string;
}
```

- Each manager connection profile contains an array of one or more paths
- A single path is valid (no redundancy, simplest setup)
- Additional paths can be added at any time for redundancy
- When no `bindInterface`/`bindAddress` is set, the OS routing table determines which interface is used — this allows network-level routing decisions (e.g. policy routing on the network router)
- When a specific interface is bound, traffic is forced through that NIC regardless of OS routing
- Each packet includes a **message sequence number**
- Manager accepts the first receipt of each sequence number
- Duplicate copies (from other paths) are discarded
- Path health is tracked independently — if one path fails, the other continues

#### 8.1.3 Message Format

```typescript
interface DgramMessage {
    type: "data" | "keepAlive" | "ack" | "connect" | "connected";
    clientID: string;
    iv?: string;                    // Encryption IV (hex)
    seq?: number;                   // Multi-path sequence number (new)
    data: {
        topic?: string;
        message?: unknown;
        ackID?: number;
        socketID?: string;
    };
}
```

### 8.2 Manager ↔ Web UI

**Socket.IO** over WebSocket (carried forward from v1.0).

#### 8.2.1 Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `auth` | Client → Server | `{ username, password }` |
| `auth:result` | Server → Client | `{ success, user, permissions }` |
| `engine:state` | Server → Client | Full or delta engine state |
| `engine:update` | Client → Server | Configuration changes |
| `engine:status` | Server → Client | Online/offline, resource metrics |
| `profile:switch` | Client → Server | `{ engineId, profileId }` |
| `link:warning` | Server → Client | Breaking change notification |

#### 8.2.2 Delta Updates

**v1.0 problem:** Full configuration sent on every change (v1.0's `confManager.append()` broadcasts the entire modified subtree).

**v2.0 approach:** Delta/patch updates using JSON Patch (RFC 6902) or a similar diff format:

```typescript
// Server sends only what changed
{
    event: "engine:state",
    engineId: "router_1",
    patch: [
        { op: "replace", path: "/modules/SrtOut1/settings/srtPort", value: 8891 },
        { op: "replace", path: "/status/cpu", value: 42 }
    ]
}
```

### 8.3 Engine ↔ Local Control Panel

**Socket.IO** over localhost (carried forward from v1.0). Simple bidirectional events:

| Event | Direction | Payload |
|-------|-----------|---------|
| `state` | Engine → LCP | Module runtime states (filtered by `operatorVisible`) |
| `config:update` | Engine → LCP | Active profile configuration changes (module added/removed/updated, routing changes) |
| `control` | LCP → Engine | Operator actions (volume, mute, start/stop) |

#### 8.3.1 Live Config Propagation

When the manager pushes a configuration change to the engine's active profile, the engine applies the change and immediately forwards the resulting state update to the local control panel via Socket.IO. The LCP reactively updates its UI (modules appear/disappear, settings change, routing updates) without requiring a page reload.

```
Manager UI ──(engine:update)──▶ Manager ──(dgram)──▶ Engine
                                                       │
                                            applies config change
                                                       │
                                           ┌───────────┴───────────┐
                                           ▼                       ▼
                                   Engine state updated     LCP notified
                                   (status back to mgr)    (config:update)
                                                               │
                                                               ▼
                                                     LCP re-renders affected
                                                     components reactively
```

This ensures the operator's view is always in sync with the manager's configuration, even when a technician is making changes remotely.

#### 8.3.2 Bidirectional Runtime State Sync

Runtime control actions (volume, mute, start/stop) can originate from **either** the manager UI or the local control panel. The engine is the single source of truth — it applies the change and propagates the resulting state to both sides:

**Manager UI → LCP:**
```
Manager UI ──(engine:update)──▶ Manager ──(dgram)──▶ Engine
                                                       │
                                              applies change (live)
                                                       │
                                           ┌───────────┴───────────┐
                                           ▼                       ▼
                                  state ack to Manager       LCP notified
                                  (engine:state delta)      (config:update)
```

**LCP → Manager UI:**
```
LCP ──(control)──▶ Engine
                     │
            applies change (live)
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  LCP state updated        Manager notified
  (state event)            (dgram state update)
                                 │
                                 ▼
                          Manager broadcasts
                          (engine:state delta)
                                 │
                                 ▼
                          All browser clients
                          update reactively
```

Both paths converge on the same result: all connected clients (manager UI browsers and LCP) reflect the current state. Volume slider positions, mute states, and other runtime controls stay in sync regardless of where the change originated.

---

## 9. Plugin System

### 9.1 Plugin Structure

Each plugin is a self-contained package:

```
plugins/
  srt-input/
    package.json              ← Plugin manifest
    engine/
      SrtInputModule.ts       ← Engine-side module (registered with engine plugin loader)
      SrtInputChild.ts        ← Child process logic (if needed)
    manager/
      SrtInputConfig.ts       ← Manager-side config schema & validation
    ui/
      SrtInputNode.vue        ← Vue Flow node component (manager UI)
      SrtInputSettings.vue    ← Settings panel component
    lcp/
      SrtInputControl.vue     ← Local control panel component (optional)
```

### 9.2 Plugin Manifest

```json
{
    "name": "@media-router/plugin-srt-input",
    "version": "1.0.0",
    "mediaRouter": {
        "pluginId": "srt-input",
        "displayName": "SRT Input",
        "description": "Receive MPEG-TS stream via SRT",
        "category": "protocol",
        "architectures": ["arm64", "x86_64"],
        "ports": [
            {
                "id": "mpegts_out",
                "direction": "output",
                "streamType": "muxed/mpegts",
                "label": "MPEG-TS Output"
            }
        ],
        "configSchema": {
            "$ref": "./config-schema.json"  // JSON Schema with liveUpdatable annotations
        },
        "engine": "./engine/SrtInputModule.ts",
        "manager": "./manager/SrtInputConfig.ts",
        "ui": "./ui/SrtInputNode.vue",
        "lcp": "./lcp/SrtInputControl.vue"
    }
}
```

### 9.3 Configuration Update Model

Each plugin parameter is classified in the plugin's JSON Schema config as either **live-updatable** or **restart-required**:

```json
{
    "type": "object",
    "properties": {
        "bitrate": {
            "type": "number",
            "description": "Video bitrate in kbps",
            "default": 4000,
            "x-liveUpdatable": true
        },
        "codec": {
            "type": "string",
            "enum": ["h264", "h265"],
            "description": "Video codec",
            "default": "h264"
        }
    }
}
```

Properties with `"x-liveUpdatable": true` in the schema indicate that a parameter **may** support live updates, depending on the active backend. The schema annotation is a static capability hint — the actual live-update availability is determined at runtime by the module.

**Runtime capability reporting:** When a module starts (or when its backend selection changes), it reports which parameters are currently live-updatable via `liveUpdatableParams` in its runtime state. This allows the same module to advertise different capabilities depending on configuration — for example, a VideoEncoder using a software encoder (x264) may support live bitrate changes, while the same module using a hardware encoder (V4L2 H.264) may not.

```typescript
// Schema marks bitrate as potentially live-updatable
// "x-liveUpdatable": true

// At runtime, module reports actual capability:
// Software encoder active  → liveUpdatableParams: ["bitrate", "keyframeInterval"]
// Hardware encoder active  → liveUpdatableParams: []
```

The manager UI uses `liveUpdatableParams` from runtime state (not the static schema) to determine which fields show the live-update icon (⚡).

**Config update flow:**

```
User changes parameter in manager UI
  ↓
Manager saves new value to stored config (always)
  ↓
Is module running?
  ├─ No  → Done (new config applied on next start)
  └─ Yes → Is parameter in liveUpdatableParams?
              ├─ Yes → Engine sends update to child process via control IPC
              │         Child process applies change (e.g. GStreamer property set)
              │         Module continues running with new value
              └─ No  → Change stored as pending
                        Module continues running with old value
                        Runtime state updated: pendingRestart = true
                        Manager UI shows "pending restart" indicator
```

**Pending restart state:** When a running module has restart-required changes that have not been applied, the module's runtime state includes `pendingRestart: true`. The manager UI displays a visual indicator (e.g. a restart icon badge on the module node). The pending changes are applied when the user explicitly restarts the module.

**Mixed updates:** If a single config save includes both live-updatable and restart-required changes, the live-updatable changes are applied immediately and the restart-required changes are held as pending.

### 9.4 Plugin Lifecycle

```typescript
interface PluginModule {
    // Called when module instance is created
    onInit(config: ModuleConfig, context: EngineContext): Promise<void>;

    // Called when module is started (run command)
    onStart(): Promise<void>;

    // Called when module is stopped
    onStop(): Promise<void>;

    // Called when module is destroyed
    onDestroy(): Promise<void>;

    // Report which params are currently live-updatable given the active backend.
    // Called after onStart() and whenever backend selection changes.
    // Returns a subset of params marked x-liveUpdatable in the schema.
    getLiveUpdatableParams(): string[];

    // Called for live-updatable parameter changes while running.
    // Only receives changes for params listed in getLiveUpdatableParams().
    // Restart-required changes are held as pending and not passed here.
    onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void>;

    // Return current runtime state (VU, stats, etc.)
    getState(): ModuleRuntimeState;
}

interface EngineContext {
    // PipeWire integration
    pipewire: PipeWireManager;

    // Child process spawning
    spawn(command: string, config: ChildProcessConfig): ChildProcessHandle;

    // Logging
    logger: Logger;

    // Codec capabilities of this engine
    codecs: CodecCapabilities;
}
```

### 9.5 Architecture Tags

Plugins declare supported architectures in their manifest. The engine filters available plugins on startup:

```typescript
const availablePlugins = allPlugins.filter(p =>
    p.architectures === undefined ||     // Untagged = all architectures
    p.architectures.includes(currentArch)
);
```

The manager only shows module types available on the target engine.

### 9.6 Plugin Discovery

Plugins are discovered at startup from a `plugins/` directory. Each subdirectory with a valid `package.json` containing a `mediaRouter` section is loaded. Adding a new module type does NOT require modifying core engine or manager code.

---

## 10. Security

### 10.1 Authentication

#### 10.1.1 Manager Authentication

| Aspect | v1.0 | v2.0 |
|--------|------|------|
| Password hashing | MD5 | bcrypt (cost factor 12+) |
| Default credentials | `admin`/`admin` | None — first-run setup required |
| Rate limiting | None | 5 attempts per 15 minutes per IP |
| Session management | Socket.IO auth on every connection | JWT or session cookie with expiry |
| Password storage | Flat JSON file | SQLite `users` table |

#### 10.1.2 Local API Authentication

```
Request arrives at Local API
  ↓
Is source address localhost/loopback? ──Yes──▶ Bypass auth, allow request
  ↓ No
Are local user accounts configured? ──No──▶ (Not possible: default account always exists)
  ↓ Yes
Is request authenticated (valid session)? ──No──▶ 401 Unauthorized
  ↓ Yes
Allow request
```

A default local user account with a randomly generated password is created by the manager when a new engine profile is created. This ensures non-localhost access always requires authentication.

### 10.2 Role-Based Access Control

#### 10.2.1 Role Hierarchy

```
Admin
  ├── Full access to all engines
  ├── User management
  ├── Global settings
  └── All profiles on all engines

Operator
  ├── Per-engine permissions:
  │   ├── Control: start/stop, mute, volume, runtime controls
  │   └── Edit: add/remove/configure modules, routing, profiles
  └── Only sees assigned engines
```

#### 10.2.2 Permission Enforcement

```typescript
interface Permission {
    engineId: string;
    level: "control" | "edit";
}

interface User {
    id: string;
    username: string;
    passwordHash: string;
    role: "admin" | "operator";
    permissions: Permission[];     // Only for operators
    disabled: boolean;
}
```

**Server-side enforcement:** Every Socket.IO event and REST endpoint checks permissions before acting. The UI hides/disables controls the user cannot access, but this is a convenience — the server is the authority.

**Immediate effect:** Permission changes are pushed to connected clients via Socket.IO. No re-login required.

### 10.3 Input Sanitisation

| Vector | Mitigation |
|--------|-----------|
| XSS (UI) | Vue.js auto-escapes template interpolation; `v-html` not used with user data |
| Shell injection | GStreamer pipelines built with typed parameters, not string interpolation; `child_process.spawn()` with array args, not `shell: true` |
| Config injection | All config validated against JSON Schema before applying |

---

## 11. Observability & Reliability

### 11.1 Structured Logging

**v1.0 problem:** `console.log` mixed with custom `_log()` method, memory-only, lost on restart.

**v2.0 approach:** Structured JSON logging (NestJS Logger on manager, pino on engine via `@fastify/pino`):

```typescript
{
    "timestamp": "2026-03-13T14:22:01.123Z",
    "level": "error",
    "module": "SrtInput_1",
    "engineId": "studio_router",
    "message": "SRT connection lost",
    "context": { "host": "10.0.0.5", "port": 8890, "retryCount": 3 }
}
```

- Severity levels: `debug`, `info`, `warn`, `error`
- Persisted to disk with log rotation (size and time-based)
- All modules use the same logger interface (NestJS DI on manager, explicit injection on engine)
- Queryable via Local API (`/api/v1/logs`)

### 11.2 Health Checks

Both engine and manager expose `/health`:

```typescript
// Engine health
{
    "status": "healthy",
    "uptime": 1209600,           // seconds (2 weeks)
    "activeModules": 12,
    "failedModules": 0,
    "managerConnected": true,
    "pipewireStatus": "running",
    "memoryUsage": { "rss": 128000000, "heapUsed": 64000000 }
}
```

### 11.3 Metrics

Optional Prometheus-compatible metrics endpoint hosted on the **manager only**. The manager aggregates metrics from all connected engines (received via dgram-comms status updates) and exposes them on a single endpoint. A monitoring server (e.g. Grafana + Prometheus) scrapes only the manager — it does not need to reach individual engine devices.

**Endpoint:** `GET /metrics` on the manager HTTP port (Prometheus text exposition format).

**Exposed metrics (per engine, per module):**

- CPU and memory usage per engine process
- Stream statistics (bitrate, packet loss, RTT) per module
- PipeWire link status
- Manager connection latency and path health per engine
- Child process restart counts
- Engine online/offline state

### 11.4 Long-Running Stability

The system must run continuously for weeks. Key design decisions supporting this:

| Concern | Approach |
|---------|----------|
| Memory leaks | No `abort()` workarounds. All native modules leak-tested. Child process isolation limits blast radius. |
| File descriptor leaks | PipeWire links and child processes cleaned up on module stop/destroy. Periodic FD count monitoring. |
| Log disk usage | Rotation by size (default 50MB) and age (default 7 days) |
| Config corruption | SQLite WAL mode with transactional writes. Schema validation before apply. Database backup via `VACUUM INTO`. |
| PipeWire stability | Native linking (no loopback modules). Link state monitoring with auto-reconnect. |
| Child process crashes | Exponential backoff restart. Max restart limit with alerting. |

---

## 12. Testing Strategy

### 12.1 Framework

**Vitest** across all codebases (engine, manager, UI). Single framework satisfying UR-TST-002.

### 12.2 Coverage Requirements

| Codebase | Requirement | Coverage Target |
|----------|-------------|-----------------|
| Engine code (TypeScript) | UR-TST-008 | 100% |
| Manager code (NestJS) | UR-TST-008 | 100% |
| Manager web UI (Vue) | UR-TST-007 | 100% |
| Local control panel (Vue) | UR-TST-007 | 100% |
| GStreamer native modules (C++) | UR-TST-004 | Integration tests only |
| PipeWire integration | UR-TST-004 | Integration tests only |

### 12.3 Test Categories

| Category | Scope | Runs In |
|----------|-------|---------|
| Unit tests | Business logic, config validation, protocol handling, permissions, Vue components | CI on every PR. No hardware/network required. |
| Integration tests | GStreamer pipelines, PipeWire routing, SRT/RIST connectivity | Separate CI runner with media stack. |
| E2E tests | Full engine↔manager↔UI flow | Manual or dedicated CI environment. |

### 12.4 What to Test (High Value)

- Stream routing logic: mux/demux decisions, channel mapping, N-1 mix matrix
- Config validation and schema migration
- Cross-device link resolution and breaking change detection
- dgram-comms protocol: packet encode/decode roundtrips, fragmentation, dedup
- RBAC permission evaluation
- Plugin lifecycle (init, start, stop, destroy, config update)
- Vue components: routing editor interactions, port compatibility checks

### 12.5 What NOT to Unit Test

- GStreamer pipeline execution (integration test territory)
- PipeWire node creation (requires running PipeWire daemon)
- Actual SRT/RIST network connectivity (integration test)
- Socket.IO transport internals (framework responsibility)

---

## 13. Deployment & Build

### 13.1 Target Platforms

| Platform | Architecture | Notes |
|----------|-------------|-------|
| Raspberry Pi 4 | arm64 | H.264 HW encode/decode (V4L2/OpenMAX) |
| Raspberry Pi 5 | arm64 | H.265 HW decode only, no H.264 HW |
| x86_64 Linux | amd64 | VAAPI for HW encode/decode where available |

All platforms: Debian Bookworm or later, Node.js 20 LTS+, GStreamer 1.20+, PipeWire.

### 13.2 Bootstrap Script

A single `./install.sh` script that:

1. Detects platform and architecture
2. Installs system dependencies (GStreamer, PipeWire, build tools)
3. Installs Node.js (via nvm or system package)
4. Runs `npm install` across all workspaces
5. Builds native GStreamer modules (`node-gyp`)
6. Validates the installation (health check)

### 13.3 Project Structure

```
media-router/
├── packages/
│   ├── engine/                 ← Engine application (TypeScript + Fastify)
│   │   ├── src/
│   │   │   ├── modules/        ← Core engine modules
│   │   │   ├── pipewire/       ← PipeWire management service
│   │   │   ├── stream-router/  ← Stream routing logic
│   │   │   ├── child-process/  ← Child process manager
│   │   │   ├── local-api/      ← Local REST API module
│   │   │   ├── local-panel/    ← Serves LCP static files
│   │   │   └── dgram-comms/    ← UDP communication client
│   │   ├── native/             ← C++ GStreamer addons
│   │   └── vitest.config.ts
│   │
│   ├── manager/                ← NestJS manager application
│   │   ├── src/
│   │   │   ├── engine/         ← Engine connection management
│   │   │   ├── config/         ← Config store, profiles, schemas
│   │   │   ├── auth/           ← Authentication, RBAC
│   │   │   ├── link-resolver/  ← Cross-device link management
│   │   │   ├── audit/          ← Audit logging
│   │   │   └── dgram-comms/    ← UDP communication server
│   │   └── vitest.config.ts
│   │
│   ├── manager-ui/             ← Vue.js manager web UI
│   │   ├── src/
│   │   │   ├── components/     ← Shared component library
│   │   │   ├── views/          ← Route views
│   │   │   ├── stores/         ← Pinia stores
│   │   │   ├── routing-editor/ ← Vue Flow integration
│   │   └── vitest.config.ts
│   │
│   ├── local-panel/            ← Vue.js local control panel
│   │   ├── src/
│   │   │   ├── components/     ← Purpose-built operator components
│   │   │   ├── views/
│   │   │   └── stores/
│   │   └── vitest.config.ts
│   │
│   ├── dgram-comms/            ← Shared UDP communication library
│   │   ├── src/
│   │   └── vitest.config.ts
│   │
│   └── shared/                 ← Shared TypeScript types and utilities
│       ├── src/
│       │   ├── types/          ← Stream types, port types, config schemas
│       │   ├── schemas/        ← JSON Schema definitions
│       │   └── utils/          ← Shared utilities
│       └── vitest.config.ts
│
├── plugins/                    ← Plugin packages
│   ├── srt-input/
│   ├── srt-output/
│   ├── rist-input/
│   ├── rist-output/
│   ├── audio-encoder/             ← Single module, selectable codec (Opus/AAC/PCM)
│   ├── audio-decoder/             ← Single module, auto-detect codec
│   ├── video-encoder/             ← Single module, selectable codec (H.264/H.265/AV1)
│   ├── video-decoder/             ← Single module, auto-detect codec
│   ├── video-player/              ← Raw video display sink
│   ├── hls-input/
│   ├── audio-input/            ← PipeWire audio capture
│   ├── audio-output/           ← PipeWire audio playback
│   ├── mpegts-muxer/
│   ├── mpegts-demuxer/
│   └── n1-mixer/               ← N-1 audio mixer
│
├── docs/
│   ├── URS-v2.0.md
│   ├── FDS-v2.0.md             ← This document
│   ├── api/                    ← Generated API docs
│   └── user-guide/             ← User documentation
│
├── install.sh                  ← Bootstrap script
├── package.json                ← Workspace root
├── tsconfig.base.json          ← Shared TypeScript config
├── eslint.config.js            ← Shared ESLint config
└── .github/
    └── workflows/
        ├── ci.yml              ← Lint + test on PR
        └── release.yml         ← Build and package
```

### 13.4 CI/CD

GitHub Actions pipeline on every PR:

1. **Lint:** ESLint across all packages
2. **Type check:** `tsc --noEmit` across all packages
3. **Unit tests:** Vitest with coverage enforcement
4. **Build:** Compile TypeScript, build Vue apps

---

## 14. Requirement Traceability

| Requirement | FDS Section |
|-------------|-------------|
| UR-ENG-001 to UR-ENG-009 | 3.2 Stream Management Model |
| UR-ENG-010 to UR-ENG-019b | 3.3 Encoding & Decoding, 3.2 Stream Management Model |
| UR-ENG-020 to UR-ENG-024a | 3.4 Protocol Modules |
| UR-ENG-030 to UR-ENG-035 | 3.5 Child Process Management, 3.6 Concurrency & External Process Safety |
| UR-ENG-040 to UR-ENG-042 | 3.1 Process Architecture, 7.1 Architecture |
| UR-MGR-001 to UR-MGR-007 | 4.2 Configuration Store, 9.3 Configuration Update Model |
| UR-MGR-010 to UR-MGR-012 | 4.1 Architecture |
| UR-MGR-020 to UR-MGR-028 | 4.3 Configuration Profiles |
| UR-MGR-030 to UR-MGR-035 | 4.4 Cross-Device Module Discovery |
| UR-UI-001 to UR-UI-005 | 5.1 Application Architecture, 5.6 Component Library |
| UR-UI-010 to UR-UI-016c | 5.3 Visual Routing Editor |
| UR-UI-040 to UR-UI-043 | 5.3.4 Focus Mode |
| UR-UI-017 to UR-UI-019 | Deferred to future version (URS §9) |
| UR-UI-020 to UR-UI-023 | 5.4 Engine Dashboard |
| UR-UI-030 to UR-UI-033 | 5.5 Component Library, 5.6 Responsive Design |
| UR-LCP-001 to UR-LCP-007 | 6 Local Control Panel |
| UR-API-001 to UR-API-061 | 7 Local API |
| UR-COM-001 to UR-COM-006 | 8.1 Engine ↔ Manager |
| UR-COM-010 to UR-COM-012 | 8.2 Manager ↔ Web UI |
| UR-COM-020, UR-COM-021 | 8.3 Engine ↔ Local Control Panel |
| UR-PLG-001 to UR-PLG-006 | 9 Plugin System |
| UR-SEC-001 to UR-SEC-006 | 10.1 Authentication, 10.3 Input Sanitisation |
| UR-SEC-010 to UR-SEC-022 | 10.2 Role-Based Access Control |
| UR-SEC-030 to UR-SEC-035 | 10.1.2 Local API Authentication |
| UR-REL-001 to UR-REL-005 | 11.4 Long-Running Stability, 3.6 Autonomous Operation |
| UR-OBS-001 to UR-OBS-006 | 11.1 Structured Logging, 11.2 Health Checks, 11.3 Metrics |
| UR-TST-001 to UR-TST-008 | 12 Testing Strategy |
| UR-DEP-001 to UR-DEP-009 | 13 Deployment & Build |
| UR-DOC-001 to UR-DOC-004 | 13.3 Project Structure (docs/) |

---

*End of Document*
