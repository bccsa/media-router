# Media Router v2.0 — User Requirements Specification

| Field            | Value                              |
|------------------|------------------------------------|
| Document         | URS-MR-2.0                         |
| Version          | 0.1 (Draft)                        |
| Date             | 2026-03-13                         |
| Organisation     | BCC South Africa                   |
| Status           | Draft — Awaiting Review            |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Scope](#2-scope)
3. [Definitions & Abbreviations](#3-definitions--abbreviations)
4. [System Overview](#4-system-overview)
5. [User Requirements](#5-user-requirements)
   - 5.1 Media Engine (Router)
   - 5.2 Manager
   - 5.3 Manager Web UI
   - 5.4 Local Control Panel
   - 5.5 Local API
   - 5.6 Communication
   - 5.7 Plugin System
   - 5.8 Security
   - 5.9 Reliability & Observability
   - 5.10 Deployment & Operations
6. [Constraints](#6-constraints)
7. [Assumptions](#7-assumptions)
8. [Traceability to v1.0 Issues](#8-traceability-to-v10-issues)

---

## 1. Introduction

### 1.1 Purpose

This document defines the user requirements for Media Router v2.0, a distributed media routing system for audio and MPEG-TS stream routing, processing, and streaming. It replaces the v1.0 system currently deployed by BCC South Africa.

### 1.2 Background

Media Router v1.0 provides audio-focused routing with SRT, RIST, WebRTC, and HLS protocol support on Raspberry Pi and Linux devices. v2.0 extends this to full MPEG-TS stream routing (audio, video, and combined streams) with splitting, combining, muxing, and demuxing capabilities, a modernised UI, plugin architecture, and improved reliability.

### 1.3 Document Conventions

- **SHALL** — Mandatory requirement
- **SHOULD** — Strongly recommended, deviations require justification
- **MAY** — Optional / nice-to-have
- Priority: **P1** = Must have for initial release, **P2** = Should have, **P3** = Nice to have

---

## 2. Scope

### 2.1 In Scope

- Media engine (router) for audio and MPEG-TS stream routing (including video), encoding, decoding, muxing, and demuxing
- Centralised manager server for multi-router configuration and monitoring
- Manager web UI for configuration and visual routing
- Local control panel for on-device operation
- Plugin system for modular extension
- Communication layers between all components
- Deployment on Raspberry Pi 4/5 and x86 Linux systems

### 2.2 Out of Scope

- Content management / media asset management
- User-facing streaming platforms (viewers)
- Hardware design / procurement
- Non-Linux operating systems

---

## 3. Definitions & Abbreviations

| Term | Definition |
|------|-----------|
| **Engine** | The media processing process running on a router device (called "Router" in v1.0) |
| **Manager** | Central server that configures and monitors multiple engines |
| **Module** | A plugin unit that performs a specific media function (e.g. SRT input, Opus encoder) |
| **Stream** | A flow of media data (audio, video, or multiplexed) between modules |
| **Link** | A configured connection between two module ports carrying a stream |
| **Mux** | Combining multiple elementary streams into a single transport stream |
| **Demux** | Splitting a transport stream into separate elementary streams |
| **MPEG-TS** | MPEG Transport Stream — container format for multiplexed media |

---

## 4. System Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Manager Server                       │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Config Store │  │ Auth / Users │  │  REST / WS API│  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└────────┬──────────────────┬─────────────────┬───────────┘
         │ UDP (multi-path) │ Socket.IO / WS  │ Socket.IO
         ▼                  ▼                  ▼
┌────────────────┐  ┌──────────────┐  ┌───────────────────┐
│  Engine (RPi)  │  │  Manager UI  │  │  Local Control     │
│  ┌──────────┐  │  │  (Vue + TS)  │  │  Panel (Vue + TS)  │
│  │ Modules  │  │  └──────────────┘  └───────────────────┘
│  │ (plugins)│  │
│  └──────────┘  │
└────────────────┘
```

---

## 5. User Requirements

### 5.1 Media Engine (Router)

#### 5.1.1 Stream Management Model

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-ENG-001 | The engine SHALL support MPEG-TS-like stream management where streams can be split, combined, muxed, and demuxed between module instances. Media streams SHALL be routed directly between module child processes via media IPC (not through the Node.js engine process). | P1 |
| UR-ENG-002 | The engine SHALL support three routing domains: (1) MPEG-TS stream routing for muxed audio/video streams via media IPC between GStreamer child processes, (2) PipeWire-based routing for mixable PCM audio streams via PipeWire's native graph, and (3) raw video stream routing via media IPC between GStreamer child processes (e.g. decoded video piped to an encoder or player). The Node.js engine process acts as a control plane only — media data SHALL NOT flow through the Node.js event loop. | P1 |
| UR-ENG-003 | The engine SHALL support per-channel audio routing (e.g. channels 1–2 of a 10-channel input routed to module A, channels 3–4 to module B). | P1 |
| UR-ENG-004 | The engine SHALL support MPEG-TS stream routing between modules, enabling video (with audio) to be routed, split, and combined (not present in v1.0). | P1 |
| UR-ENG-005 | The engine SHALL support multiplexing multiple audio and video streams over a single SRT or RIST connection. | P1 |
| UR-ENG-006 | The engine SHALL support demultiplexing a received transport stream and mapping its elementary streams to new outputs (e.g. 1 video + N audio in → N video outputs each with a dedicated audio channel). | P1 |
| UR-ENG-006a | The engine SHALL provide device-level PCM audio settings (sample rate and bit depth). All audio streams received or produced on the device SHALL be converted to the configured sample rate and bit depth. These settings SHALL be configurable per engine in the manager. | P1 |
| UR-ENG-007 | The engine SHOULD replace PulseAudio-style loopback routing with PipeWire native linking (pwlink) to improve audio routing stability. | P2 |
| UR-ENG-008 | The engine SHOULD provide an N-1 routing/mixing module for PipeWire audio streams. The module SHALL expose multiple input/output connection-point pairs, where each pair is wired to a specific destination. Each output pair SHALL carry a mix of all inputs **except** the audio returning from that pair's destination, enabling standard broadcast N-minus-1 monitoring (e.g. a translator hears all other sources but not their own return). | P2 |
| UR-ENG-009 | When a module receives an MPEG-TS stream (e.g. SRT input, RIST input, HLS input), the engine SHALL probe the stream on first connection to discover its actual content (video codecs, audio tracks with codec and channel count, subtitle tracks, PIDs). The port's stream info SHALL be updated in-place with probed data and cached in the module's stored configuration for offline config editing. Downstream links SHALL be matched best-effort against the probed stream info. Mismatches between source and destination stream info SHALL be logged to the device log. | P1 |

#### 5.1.2 Encoding & Decoding

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-ENG-010 | The engine SHALL provide a single **AudioEncoder** module supporting selectable codec output (at minimum: Opus, AAC, PCM). The user selects the target codec in the module configuration; available codecs are determined by the engine's detected capabilities. | P1 |
| UR-ENG-011 | The engine SHALL provide a single **AudioDecoder** module that automatically detects the incoming audio codec and decodes accordingly (at minimum: Opus, AAC, PCM). No user codec selection is required on the decoder. | P1 |
| UR-ENG-012 | The engine SHALL provide a single **VideoEncoder** module supporting selectable codec output (at minimum: H.264, H.265). The user selects the target codec in the module configuration. | P1 |
| UR-ENG-013 | The engine SHOULD support AV1 as an additional selectable codec in the VideoEncoder module where hardware support is available. | P3 |
| UR-ENG-013a | The engine SHOULD provide software-based AV1 encoding and decoding using modern efficient libraries (e.g. SVT-AV1 for encoding, dav1d for decoding) as a fallback when hardware AV1 support is not available. | P3 |
| UR-ENG-014 | The engine SHALL provide a single **VideoDecoder** module that automatically detects the incoming video codec and decodes accordingly (at minimum: H.264, H.265), outputting a raw video stream. | P1 |
| UR-ENG-014a | The engine SHALL provide a **VideoPlayer** module that receives a piped raw video stream and renders it to a display output. | P1 |
| UR-ENG-015 | Encoder modules SHALL include built-in MPEG-TS packaging (AudioEncoder packages encoded audio in MPEG-TS; VideoEncoder packages encoded video + optional audio in MPEG-TS). Decoder modules SHALL include built-in MPEG-TS demuxing. | P1 |
| UR-ENG-016 | Dedicated mux/demux modules SHALL be available for complex workflows that require fine-grained stream composition. | P2 |
| UR-ENG-017 | The engine SHALL always provide software-based video encoding and decoding for all supported codecs (H.264, H.265) as a fallback. | P1 |
| UR-ENG-018 | The engine SHALL automatically detect available hardware encoding/decoding capabilities (V4L2, VAAPI) on startup and select hardware acceleration by default where available. | P1 |
| UR-ENG-019 | The engine SHALL report its detected codec capabilities to the manager. The manager UI SHALL only present encoding/decoding options (codec choices in encoder modules) that are available on the target device, hiding unsupported options from the user. | P1 |
| UR-ENG-019a | The VideoEncoder module SHALL accept either a piped raw video stream as input OR capture from a configured V4L2 device. The video source mode (piped or V4L2) SHALL be user-configurable. | P1 |
| UR-ENG-019b | The engine SHALL support raw video stream routing between modules (e.g. VideoDecoder output → VideoEncoder input, VideoDecoder output → VideoPlayer input), including splitting a single raw video output to multiple destinations. | P1 |

#### 5.1.3 Protocol Support

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-ENG-020 | The engine SHALL support SRT for point-to-point streaming (caller, listener, rendezvous modes). | P1 |
| UR-ENG-020a | The engine SHALL support SRT for point-to-multipoint streaming (one sender to multiple receivers). | P1 |
| UR-ENG-021 | The engine SHALL support RIST for point-to-point streaming. | P1 |
| UR-ENG-021a | The engine SHALL support RIST for point-to-multipoint streaming. | P1 |
| UR-ENG-022 | WebRTC ingress and egress SHALL be provided by an external MediaMTX service. The engine SHALL interface with MediaMTX via SRT or RIST (input/output modules). No built-in WebRTC modules are required. | P1 |
| UR-ENG-023 | The engine SHALL support HLS input for receiving broadcast streams. The HLS module SHALL support both MPEG-TS and fMP4 (fragmented MP4 / CMAF) segment formats, automatically transmuxing fMP4 segments into MPEG-TS for the output port. | P1 |
| UR-ENG-023a | The HLS module SHALL handle resolution and codec changes during playback (e.g. ABR variant switches) and update the MPEG-TS stream layout and downstream probed metadata accordingly. | P1 |

#### 5.1.4 Process Model

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-ENG-030 | Media processing (GStreamer pipelines) SHALL run in isolated child processes to prevent crashes from affecting the main engine process. | P1 |
| UR-ENG-031 | Child processes SHALL restart automatically with exponential backoff on failure. | P1 |
| UR-ENG-032 | The engine SHALL NOT use `abort()` or hard process kills as a workaround for memory leaks. All memory leaks SHALL be identified and fixed. | P1 |
| UR-ENG-033 | The engine SHALL handle global uncaught exceptions and unhandled promise rejections gracefully with logging and controlled recovery. | P1 |
| UR-ENG-034 | The engine SHALL manage all external processes (GStreamer child processes, PipeWire link operations, system commands) in a concurrency-safe manner. Concurrent start/stop/restart operations on the same module SHALL be serialised to prevent race conditions, orphaned processes, or resource leaks. | P1 |
| UR-ENG-035 | The engine SHALL track all spawned child processes and external resources (PipeWire nodes, PipeWire links, open file descriptors, control IPC channels, media IPC pipes). On engine shutdown, all tracked resources SHALL be cleaned up, and no orphaned processes SHALL remain. | P1 |

#### 5.1.5 Technology

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-ENG-040 | The engine SHALL be implemented in TypeScript. | P1 |
| UR-ENG-041 | The engine SHALL use a lightweight application structure (e.g. Fastify) rather than a full-featured API framework. The engine is primarily a process orchestrator managing GStreamer child processes, PipeWire links, and stream routing — not an API server — and its framework choice SHALL reflect this role. | P1 |
| UR-ENG-042 | The engine's Local API (section 5.5) SHALL be served via an embedded Fastify instance within the engine process. | P1 |

---

### 5.2 Manager

#### 5.2.1 Core Functions

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-MGR-001 | The manager SHALL provide centralised configuration and monitoring of multiple engines (routers). | P1 |
| UR-MGR-002 | The manager SHALL persist configuration in an SQLite database with a table entry per engine. SQLite's transactional writes SHALL prevent partial or corrupt configuration on crash. | P1 |
| UR-MGR-003 | The manager SHALL validate all configuration against a defined schema before applying. | P1 |
| UR-MGR-004 | The manager SHALL support configuration versioning and migration between schema versions. | P2 |
| UR-MGR-005 | The manager SHALL keep the last 10 versions of each engine's configuration for easy rollback. A new version SHALL only be stored after 10 minutes of configuration inactivity (no further edits), to avoid storing intermediate states during active editing sessions. The user SHALL be able to view and restore any stored version. | P2 |
| UR-MGR-006 | The manager SHALL track engine online/offline status in real time. | P1 |
| UR-MGR-006a | Each module configuration parameter SHALL be classified as either **live-updatable** (can be applied to a running module without restart) or **restart-required** (requires a module restart to take effect). This classification SHALL be declared in the plugin's configuration schema. The actual set of live-updatable parameters MAY vary at runtime depending on the active backend (e.g. software vs hardware encoder) — the running module SHALL report its current live-updatable capabilities. | P1 |
| UR-MGR-006b | The manager UI SHALL visually indicate which parameters are live-updatable based on the module's **runtime-reported** capabilities (not only the static schema). The indication SHALL update when the module's backend changes. | P1 |
| UR-MGR-006c | Changes to restart-required parameters on a running module SHALL NOT be auto-applied. The changes SHALL be saved but held as pending until the user explicitly restarts the module. | P1 |
| UR-MGR-006d | The manager UI SHALL visually indicate when a running module has unapplied (pending) configuration changes awaiting a restart. | P1 |
| UR-MGR-007 | The manager SHALL support import and export of engine configurations. | P1 |

#### 5.2.2 Configuration Profiles

A technician may use the same physical device for different purposes (e.g. live event A, live event B, lab testing, training). The manager should allow storing multiple named configuration profiles per engine so the operator can switch the device's entire module setup without manually reconfiguring or importing/exporting JSON files.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-MGR-020 | The manager SHOULD support storing multiple named configuration profiles per engine (e.g. "Sunday Service", "Conference Room", "Lab Testing"). | P2 |
| UR-MGR-021 | The manager SHOULD allow a user to switch an engine's active configuration profile. Switching SHALL stop the current configuration, apply the selected profile, and optionally auto-start the engine. | P2 |
| UR-MGR-022 | The manager SHOULD allow creating a new profile by duplicating an existing one. | P2 |
| UR-MGR-023 | The manager SHOULD allow renaming and deleting profiles. Deleting the last remaining profile SHALL be prevented. | P2 |
| UR-MGR-024 | Each profile SHALL be a complete, independent module configuration. Changing one profile SHALL NOT affect others. | P2 |
| UR-MGR-025 | The manager UI SHALL clearly indicate which profile is currently active on each engine. When the user is viewing or editing a non-active profile, the UI SHALL display a prominent visual indicator (e.g. banner, badge, or distinct colour scheme) making it unmistakable that the profile is not the one currently running on the device. | P1 |
| UR-MGR-028 | The manager SHALL allow editing non-active profiles while the engine continues running on its currently active profile. Changes to a non-active profile SHALL NOT affect the running engine until that profile is activated. | P1 |
| UR-MGR-026 | The manager SHOULD support importing a configuration file as a new named profile on an existing engine. | P3 |
| UR-MGR-027 | The manager SHOULD support exporting a single profile from an engine. | P3 |

#### 5.2.3 Cross-Device Module Discovery & Config Linking

When configuring an SRT or RIST input on one engine, the user currently has to manually enter the remote port, codec, channel count, and connection mode. Because the manager already holds the configuration of every engine, it can offer automatic discovery and linking: the user picks a source device and a compatible output module, and the input auto-configures itself. A persistent reference keeps the two sides in sync and warns the user when a source-side change would break connectivity.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-MGR-030 | When adding or editing an SRT/RIST input module, the manager SHOULD offer a list of all engines known to the manager and the compatible SRT/RIST output modules on each engine, allowing the user to select a source instead of manually entering connection parameters. | P2 |
| UR-MGR-031 | On source selection (UR-MGR-030), the manager SHOULD auto-populate the input module's configuration (port, codec, channel count, encryption settings, etc.) from the selected source module's current configuration. The user SHALL still be able to override any auto-populated value. | P2 |
| UR-MGR-032 | The manager SHOULD store a persistent reference (link) from the input module to its source output module. When the source module's configuration is updated, the linked input module's configuration SHOULD be updated automatically to match. | P2 |
| UR-MGR-033 | If a source module configuration change would break connectivity with linked input modules (e.g. switching from SRT listener to caller mode, or removing encryption), the manager SHALL notify the user of the breaking change before applying it, listing all affected devices and modules. Non-breaking changes (e.g. port number, encryption passphrase, codec, channel count) SHALL be propagated automatically to linked destination modules without requiring user intervention. | P2 |
| UR-MGR-034 | The user SHALL be able to unlink an input module from its source at any time, converting it back to a manually configured module without losing its current settings. | P2 |
| UR-MGR-035 | The manager UI SHOULD visually indicate which input modules are linked to a remote source, and provide a way to navigate to the source module's configuration. | P3 |

#### 5.2.4 Technology

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-MGR-010 | The manager SHALL be implemented in TypeScript. | P1 |
| UR-MGR-011 | The manager SHALL use NestJS as its application framework. NestJS is a natural fit for the manager's API-server role (structured modules, dependency injection, guards, interceptors). | P1 |
| UR-MGR-012 | The manager SHALL replace the modular-dm framework with custom logic specific to this project's requirements. | P1 |

---

### 5.3 Manager Web UI

#### 5.3.1 Technology & Architecture

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-UI-001 | The manager web UI SHALL be built with Vue.js and TypeScript. | P1 |
| UR-UI-002 | The manager web UI SHALL use Tailwind CSS v4 with per-component styles (no single monolithic CSS file). | P1 |
| UR-UI-003 | The manager web UI SHALL provide a reusable controls library (select, text input, buttons, toggles, sliders) for consistent styling. | P1 |
| UR-UI-004 | The manager web UI SHALL maintain a modular approach where each module type has its own Vue component. | P1 |
| UR-UI-005 | Module configurations SHALL be represented as a flat array (Vue-friendly), not a deep nested object structure. | P1 |

#### 5.3.2 Visual Routing

The visual routing editor uses a DOM/SVG-based node-and-wire approach (e.g. Vue Flow) rather than HTML5 Canvas. At the expected scale (50–200 nodes), DOM/SVG delivers identical performance to Canvas while providing native CSS styling, Vue component integration inside nodes, built-in accessibility, and standard touch/event handling. Canvas2D only wins at 10,000+ elements and sacrifices all of these benefits. (Note: ComfyUI is actively migrating away from Canvas/litegraph.js to Vue for these reasons.)

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-UI-010 | The manager UI SHALL provide a DOM/SVG-based visual routing view (e.g. Vue Flow) for configuring connections between modules. Each module SHALL be rendered as a Vue component node with typed input/output ports. | P1 |
| UR-UI-011 | Each module node SHALL display clearly labelled input and output connection points (ports). Each port SHALL visually indicate its stream type (e.g. audio, video, MPEG-TS) using distinct icons, colours, or shapes so the type is identifiable at a glance. | P1 |
| UR-UI-011a | Clicking on an output port SHALL initiate a drag operation that draws a provisional link. Releasing the drag on a compatible input port SHALL create the connection. Dropping on an incompatible port or empty space SHALL cancel the operation. | P1 |
| UR-UI-011b | The system SHALL prevent connecting incompatible port types (e.g. a raw audio output to a video input). Incompatible ports SHOULD be visually dimmed or hidden during a drag operation. | P1 |
| UR-UI-012 | Links SHALL be drawn as Bezier curves that avoid crossing module boxes where possible. | P2 |
| UR-UI-013 | Links and ports SHALL be colour-coded by stream type. The base palette SHALL be: **orange** for MPEG-TS streams, **blue** for PipeWire audio (mixable streams). Additional stream types SHALL use colours that maintain sufficient contrast with these. | P1 |
| UR-UI-013a | The colour palette SHALL be colour-blindness friendly (distinguishable under protanopia, deuteranopia, and tritanopia). Colours SHOULD be supplemented with distinct line patterns (solid, dashed, dotted) or icons so that stream types remain identifiable without colour alone. | P1 |
| UR-UI-014 | Users SHALL be able to click or hover over a link to configure its properties (channel mappings, stream selection) via a popover or inline panel. | P1 |
| UR-UI-015 | The routing view SHALL support zoom, pan, minimap, snap-to-grid, and multi-select. | P1 |
| UR-UI-016 | Module nodes SHALL render live status information (e.g. VU meters, connection state, stream statistics) inside the node using standard Vue components. | P2 |
| UR-UI-016a | Each module node SHALL display a clickable state icon indicating the module's current health (e.g. running/ok, warning, error, stopped). Clicking the icon SHALL open a panel showing any errors, warnings, or diagnostic information for that module (e.g. stream mismatch details, connection failures, restart history). | P1 |
| UR-UI-016b | Right-clicking a module node SHALL open a context menu with quick commands including: toggle focus state, delete module, copy module, enable/disable module, and other contextual actions. On mobile/touch devices, a long-press SHALL trigger the same context menu. | P1 |
| UR-UI-016c | Clicking a VU meter on a module node SHALL open a popup volume slider, allowing the operator to quickly adjust the volume for that audio channel. The volume change SHALL be applied live without requiring a module restart. | P1 |

#### 5.3.3 Focus Mode

During live operation, operators often only need to monitor a subset of modules across multiple devices. Focus mode reduces visual clutter by dimming all modules to a muted state and allowing the user to selectively highlight the ones they care about.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-UI-040 | The manager UI SHALL provide a **focus mode** toggle. When enabled, devices and modules in **normal** state SHALL be rendered in a muted/light-grey visual state. Devices and modules in **focused** state SHALL render at full colour. VU meters SHALL continue to animate in both states (muted colours for normal, full colours for focused). | P2 |
| UR-UI-041 | Modules have two states: **normal** and **focused**. While focus mode is on, the user SHALL be able to toggle individual modules between these states via the right-click context menu. When focus mode is off, all modules render at full colour regardless of their state. | P2 |
| UR-UI-041a | Devices have two states: **normal** and **focused**. While focus mode is on, normal-state devices SHALL be rendered muted and SHALL automatically sort to the bottom of the device list. On a normal-state device, all modules render muted regardless of their individual state. | P2 |
| UR-UI-042 | Focus state selections (which devices and modules are marked as focused) SHALL be saved as part of the device configuration in the manager, so they persist across page reloads. | P2 |
| UR-UI-043 | Focus mode SHALL be a per-session setting (stored in the browser, not in the server). Different users accessing the same manager instance SHALL be able to independently enable or disable focus mode. | P2 |

#### 5.3.4 Multi-Router Management

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-UI-020 | The manager UI SHALL display all managed engines with their status. | P1 |
| UR-UI-021 | The manager UI SHALL provide a search/filter to quickly find engines by name or property. | P1 |
| UR-UI-022 | The manager UI SHALL support flexible layout options for engine arrangement. | P2 |
| UR-UI-023 | The manager UI SHALL show real-time resource indicators (CPU, memory, temperature) per engine. | P1 |

#### 5.3.5 Look & Feel

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-UI-030 | The manager UI SHALL support dark and light mode. | P1 |
| UR-UI-031 | The manager UI SHALL be mobile-friendly with responsive layouts. | P1 |
| UR-UI-032 | The manager UI and local control panel SHALL have a consistent visual design. | P1 |
| UR-UI-033 | The overall look and feel SHALL be modernised compared to v1.0. | P1 |

---

### 5.4 Local Control Panel

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-LCP-001 | The local control panel SHALL be a web-based interface running on the engine device. | P1 |
| UR-LCP-002 | The local control panel SHALL be built with Vue.js and TypeScript. It is a separate application from the manager UI with its own purpose-built components optimised for operator use (e.g. translators adjusting volume, switching channels). | P1 |
| UR-LCP-003 | The local control panel SHALL provide an audio mixer view for operator use. Volume sliders SHALL be vertical (fader-style) for easy touch-screen operation. | P1 |
| UR-LCP-005 | The local control panel SHALL support dark and light mode. | P1 |
| UR-LCP-006 | The local control panel SHALL be mobile-friendly. | P1 |
| UR-LCP-007 | The local control panel SHALL only display modules flagged as operator-visible. | P1 |

---

### 5.5 Local API

The Local API replaces the v1.0 Profile Manager (port 8082) and consolidates all engine-local configuration into a single, well-defined REST API hosted on the engine device. This API handles everything that is NOT managed by the central manager — device identity, manager connection profiles, system settings, audio device discovery, and local display configuration.

#### 5.5.1 General

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-001 | The engine SHALL expose a local REST API on a configurable HTTP port for all local device configuration. | P1 |
| UR-API-002 | The Local API SHALL replace the v1.0 Profile Manager (local-profileman) web application. The profile manager SHALL be removed. | P1 |
| UR-API-003 | The Local API SHALL be documented using OpenAPI 3.x (Swagger) with a machine-readable specification file shipped with the engine. | P1 |
| UR-API-004 | The Local API specification SHALL be versioned (e.g. `/api/v1/...`). Breaking changes SHALL increment the API version. | P1 |
| UR-API-005 | The Local API SHALL return consistent JSON responses with a standard envelope (status, data, error fields). | P1 |
| UR-API-006 | The Local API SHALL return appropriate HTTP status codes (200, 201, 400, 401, 404, 409, 500) with descriptive error messages. | P1 |
| UR-API-007 | The Local API SHALL validate all input against a defined JSON Schema before applying changes. Invalid requests SHALL be rejected with a 400 response describing the validation error. | P1 |
| UR-API-008 | The Local API SHOULD be accessible from the local control panel UI and from external tools (curl, scripts, automation). | P1 |
| UR-API-009 | The Local API SHALL require authentication when accessed from a non-loopback address. Loopback requests (127.0.0.1 / ::1) MAY bypass authentication for local tooling convenience. | P2 |

#### 5.5.2 Manager Connection Profiles

In v1.0, the Profile Manager UI is the only way to configure which central manager the engine connects to. v2.0 replaces this with API endpoints.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-010 | The Local API SHALL provide CRUD endpoints for manager connection profiles. | P1 |
| UR-API-011 | Each manager profile SHALL include at minimum: a unique profile name, manager host, manager port, username (engine display name on manager), password (encryption key), and an active flag. | P1 |
| UR-API-012 | The Local API SHALL support activating a specific manager profile. Only one profile SHALL be active at a time. Activating a profile SHALL cause the engine to disconnect from any current manager and connect to the newly selected one. | P1 |
| UR-API-013 | The Local API SHALL support deactivating all profiles (disconnecting from all managers) without deleting them. | P1 |
| UR-API-014 | Manager profile changes SHALL be persisted to disk immediately using atomic writes. | P1 |
| UR-API-015 | The Local API SHALL report the current manager connection status (connected, connecting, disconnected, authentication failed) per profile. | P1 |
| UR-API-016 | The Local API SHALL support configuring multiple manager profiles for quick switching between environments (e.g. production, test, backup). | P2 |

**Example endpoints:**

```
GET    /api/v1/profiles              — List all manager profiles with connection status
POST   /api/v1/profiles              — Create a new manager profile
GET    /api/v1/profiles/:id          — Get a specific profile
PUT    /api/v1/profiles/:id          — Update a profile
DELETE /api/v1/profiles/:id          — Delete a profile
POST   /api/v1/profiles/:id/activate — Activate this profile (connect to manager)
POST   /api/v1/profiles/deactivate   — Deactivate all profiles (disconnect)
```

#### 5.5.3 Device Identity & Engine Settings

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-020 | The Local API SHALL provide endpoints to get and set the engine's device identity (display name). | P1 |
| UR-API-021 | The Local API SHALL provide endpoints to get and set the engine startup behaviour: startup delay time and auto-start state. | P1 |
| UR-API-022 | The Local API SHALL provide an endpoint to get and set the local control panel display mode (e.g. touch-optimised 800x480 vs fullscreen 1920x1080). | P2 |
| UR-API-023 | The Local API SHALL provide endpoints to get and set custom environment variables (replacing the v1.0 .env file editor). | P2 |
| UR-API-024 | Changes to device identity or engine settings SHALL be persisted to disk using atomic writes. | P1 |

**Example endpoints:**

```
GET    /api/v1/device                 — Get device identity and engine settings
PUT    /api/v1/device                 — Update device identity and engine settings
GET    /api/v1/device/env             — Get custom environment variables
PUT    /api/v1/device/env             — Set custom environment variables
```

#### 5.5.4 System Information (Read-Only)

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-030 | The Local API SHALL provide a read-only endpoint returning system information: CPU usage, CPU temperature, memory usage, IP addresses, and build/version number. | P1 |
| UR-API-031 | The Local API SHALL provide a read-only endpoint listing discovered audio devices (PipeWire/PulseAudio sources and sinks) with their properties (name, channels, sample rate, description). | P1 |
| UR-API-032 | The Local API SHALL provide a read-only endpoint listing discovered video devices (V4L2 capture devices, display outputs) with their properties. | P2 |
| UR-API-033 | The Local API SHALL provide a read-only endpoint listing network interfaces with their addresses and link status. | P2 |
| UR-API-034 | The Local API SHALL provide a read-only endpoint listing ports in use (UDP and TCP) by the engine and its modules. | P2 |

**Example endpoints:**

```
GET    /api/v1/system/info            — CPU, memory, temperature, version
GET    /api/v1/system/audio-devices   — PipeWire/PulseAudio sources and sinks
GET    /api/v1/system/video-devices   — V4L2 capture devices and displays
GET    /api/v1/system/network         — Network interfaces and addresses
GET    /api/v1/system/ports           — Ports in use by engine
```

#### 5.5.5 Engine Control

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-040 | The Local API SHALL provide an endpoint to start and stop the engine (equivalent to the v1.0 `run` toggle). | P1 |
| UR-API-041 | The Local API SHALL provide an endpoint to restart the engine process. | P1 |
| UR-API-042 | The Local API SHALL provide an endpoint to trigger a device reboot (with confirmation/safety mechanism). | P2 |
| UR-API-043 | The Local API SHALL provide an endpoint to launch or stop the local control panel display (kiosk mode). | P2 |

**Example endpoints:**

```
POST   /api/v1/engine/start           — Start the engine
POST   /api/v1/engine/stop            — Stop the engine
POST   /api/v1/engine/restart         — Restart the engine process
POST   /api/v1/device/reboot          — Reboot the device (requires confirmation token)
POST   /api/v1/display/start          — Launch local control panel kiosk
POST   /api/v1/display/stop           — Close local control panel kiosk
```

#### 5.5.6 Logs

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-050 | The Local API SHALL provide an endpoint to retrieve engine logs with filtering by severity level, time range, and module name. | P1 |
| UR-API-051 | The Local API SHOULD provide a WebSocket or SSE endpoint for streaming live log output. | P2 |

**Example endpoints:**

```
GET    /api/v1/logs?level=error&since=2026-03-13T00:00:00Z&module=SrtOpusInput
GET    /api/v1/logs/stream             — WebSocket/SSE live log stream
```

#### 5.5.7 Health & Diagnostics

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-API-060 | The Local API SHALL provide a `/health` endpoint returning engine health status, uptime, and active module count. This endpoint SHALL NOT require authentication. | P1 |
| UR-API-061 | The Local API SHOULD provide a `/diagnostics` endpoint returning detailed status of all running modules, child processes, and stream statistics. | P2 |

**Example endpoints:**

```
GET    /api/v1/health                  — Health check (no auth required)
GET    /api/v1/diagnostics             — Detailed module and process status
```

---

### 5.6 Communication

#### 5.6.1 Engine ↔ Manager

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-COM-001 | Engine-to-manager communication SHALL use UDP-based messaging (dgram-comms or successor). | P1 |
| UR-COM-002 | The communication layer SHALL support multi-path delivery: the engine SHALL be configurable to send each message to multiple destination IP address/port combinations for redundancy. The user SHALL also be able to optionally bind each path to a specific network interface. The receiver accepts the first receipt of each message and discards duplicates. | P1 |
| UR-COM-003 | The communication layer SHALL use a numbering or unique identification scheme to correlate packets across paths and detect duplicates. | P1 |
| UR-COM-004 | The communication layer SHALL retain encryption (AES-256 or equivalent). | P1 |
| UR-COM-005 | The communication layer SHALL retain guaranteed delivery with ACK-based retransmission. | P1 |
| UR-COM-006 | The communication layer SHALL retain message fragmentation for large payloads. | P1 |

#### 5.6.2 Manager ↔ Web UI

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-COM-010 | Manager-to-web-UI communication SHALL use Socket.IO or WebRTC data channels — to be evaluated during architecture phase for efficiency and ease of implementation. | P1 |
| UR-COM-011 | The communication layer SHALL support real-time bidirectional data updates. | P1 |
| UR-COM-012 | The communication layer SHALL support delta/patch updates rather than sending full configuration on every change. | P2 |

#### 5.6.3 Engine ↔ Local Control Panel

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-COM-020 | Engine-to-local-control-panel communication SHALL use Socket.IO (local network only). | P1 |
| UR-COM-021 | Configuration changes made to an engine's active profile via the manager SHALL be pushed to the engine in real time and reflected on the local control panel without requiring a page reload or manual refresh. | P1 |

---

### 5.7 Plugin System

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-PLG-001 | All media modules SHALL be implemented as plugins that can be independently developed and loaded. | P1 |
| UR-PLG-002 | Each plugin SHALL be able to include engine (router) components, manager components, and optional local control panel components. | P1 |
| UR-PLG-003 | Plugins SHALL be tagged with supported architectures (e.g. x86_64, arm64, armv7, rpi5). Untagged plugins are assumed to support all architectures. | P1 |
| UR-PLG-004 | The plugin system SHALL define a clear interface/contract that plugins must implement (input/output port declarations, configuration schema, lifecycle hooks). | P1 |
| UR-PLG-005 | Adding a new module type SHALL NOT require modifying core engine or manager code. | P1 |
| UR-PLG-006 | Plugins SHOULD be discoverable at runtime (dynamic loading) without restarting the engine. | P3 |

---

### 5.8 Security

#### 5.8.1 Authentication & Data Protection

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-SEC-001 | User authentication SHALL use bcrypt, scrypt, or PBKDF2 for password hashing (not MD5). | P1 |
| UR-SEC-002 | Default credentials SHALL NOT be shipped. First-run setup SHALL require setting an admin password. | P1 |
| UR-SEC-003 | The manager SHALL enforce rate limiting on authentication attempts. | P1 |
| UR-SEC-004 | The manager web UI SHOULD support TLS (HTTPS) natively or document reverse proxy setup. | P2 |
| UR-SEC-005 | User input displayed in the UI SHALL be sanitised to prevent XSS. | P1 |
| UR-SEC-006 | Configuration values interpolated into shell commands or GStreamer pipelines SHALL be escaped or passed via safe APIs (no shell injection). | P1 |

#### 5.8.2 User Management & Permissions

In v1.0, all authenticated users have full access to all routers. v2.0 should support user accounts with granular permissions so that operators can only control assigned devices, and only admins can change configurations or manage users.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-SEC-010 | The manager SHALL support multiple user accounts, each with a unique username and password. | P1 |
| UR-SEC-011 | The manager SHALL provide an admin interface for creating, editing, disabling, and deleting user accounts. | P1 |
| UR-SEC-012 | The manager SHOULD support role-based access control with at minimum two roles: **admin** (full access) and **operator** (restricted access). | P2 |
| UR-SEC-013 | The manager SHOULD allow assigning per-engine permissions to users or roles. A user SHALL only see and interact with engines they have been granted access to. | P2 |
| UR-SEC-014 | Per-engine permissions SHOULD distinguish between **control** (start/stop, mute, volume, module runtime controls) and **edit** (add/remove/configure modules, change profiles, modify routing). | P2 |
| UR-SEC-015 | An operator with **control** permission on an engine SHOULD be able to operate it (start/stop, adjust volumes, mute) but SHALL NOT be able to modify its module configuration or routing. | P2 |
| UR-SEC-016 | An operator with **edit** permission on an engine SHOULD have full configuration access to that engine, including module setup and routing changes. | P2 |
| UR-SEC-017 | Admin users SHALL have full access to all engines and all manager settings (user management, global configuration, all profiles). | P1 |
| UR-SEC-018 | The manager SHOULD support assigning permissions to individual users or to roles (groups of users). | P3 |
| UR-SEC-019 | Permission changes SHALL take effect immediately without requiring the affected user to log out and back in. | P2 |
| UR-SEC-020 | The manager UI SHOULD visually hide or disable controls that the current user does not have permission to use, rather than showing an error after the fact. | P2 |
| UR-SEC-021 | The manager SHALL enforce permissions server-side. Client-side UI restrictions alone SHALL NOT be relied upon for access control. | P1 |
| UR-SEC-022 | The manager SHOULD provide an audit log recording which user made which configuration change and when. | P3 |

#### 5.8.3 Local API & Local Control Panel Authentication

The local API and local control panel run on the engine device itself. Requests originating from the device (localhost) should work without authentication to support headless and kiosk-style operator setups. For remote access to these services (e.g. from a device on the local network), optional user accounts provide session-based authentication. Local user accounts are configured in the manager and pushed to the engine as part of its configuration on connection.

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-SEC-030 | Requests to the local API and local control panel originating from the device itself (localhost / loopback) SHALL bypass authentication. | P1 |
| UR-SEC-031 | The manager SHOULD support configuring local user accounts per engine for authenticating remote sessions to the engine's local API and/or local control panel web UI. | P2 |
| UR-SEC-032 | Local user accounts SHALL be managed in the manager and included in the configuration sent to the engine on connection. The engine SHALL NOT store local user accounts independently. | P2 |
| UR-SEC-033 | The manager SHALL create a default local user account with a randomly generated password when a new device profile is created. | P1 |
| UR-SEC-034 | Non-localhost requests to an engine's local API and local control panel SHALL require authentication. | P1 |
| UR-SEC-035 | Local user account management (create, update, delete) SHALL be performed through the manager UI and pushed to the engine as part of configuration updates. | P2 |

---

### 5.9 Reliability & Observability

#### 5.9.1 Reliability

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-REL-001 | The engine SHALL continue operating if the manager connection is lost, using last-known configuration. | P1 |
| UR-REL-002 | PipeWire/PulseAudio routing SHALL be stable — audio SHALL NOT route to wrong destinations or fail to route silently. | P1 |
| UR-REL-003 | All GStreamer native modules SHALL be free of known memory leaks. | P1 |
| UR-REL-004 | The engine SHALL gracefully shut down all child processes and release resources on stop. | P1 |
| UR-REL-005 | Configuration writes SHALL be transactional — a crash during save SHALL NOT corrupt the configuration database or local config files. | P1 |

#### 5.9.2 Observability

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-OBS-001 | The system SHALL provide structured logging (JSON format) with severity levels (debug, info, warn, error). | P1 |
| UR-OBS-002 | Logs SHALL be persisted to disk with rotation (not memory-only). | P1 |
| UR-OBS-003 | All modules SHALL use the same logging interface (no mix of console.log and custom loggers). | P1 |
| UR-OBS-004 | The engine and manager SHALL expose health check endpoints (HTTP /health). | P1 |
| UR-OBS-005 | The **manager** SHOULD expose a Prometheus-compatible metrics endpoint aggregating metrics from all connected engines. A monitoring server SHALL only need to scrape the manager, not individual engine devices. | P3 |
| UR-OBS-006 | SRT/RIST stream statistics SHALL be available in real time through the manager UI. | P1 |

#### 5.9.3 Testing

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-TST-001 | All new TypeScript modules containing business logic (routing, configuration, protocol handling, permission checks) SHALL have unit tests. | P1 |
| UR-TST-002 | The project SHALL use a single test framework across engine, manager, and web UI codebases. | P1 |
| UR-TST-003 | Unit tests SHALL run without requiring hardware, media streams, or network access. | P1 |
| UR-TST-004 | The project SHOULD provide integration tests for GStreamer pipelines, PipeWire routing, and SRT/RIST connectivity, run separately from unit tests. | P2 |
| UR-TST-005 | Tests SHALL be executed automatically in the CI pipeline on every pull request. | P1 |
| UR-TST-006 | The project SHOULD define minimum code coverage thresholds for business logic modules. Thresholds to be determined during architecture phase. | P2 |
| UR-TST-007 | The manager web UI and local control panel UI SHALL maintain 100% unit test coverage. | P1 |
| UR-TST-008 | The engine and manager server-side code SHALL maintain 100% unit test coverage. | P1 |

---

### 5.10 Deployment & Operations

#### 5.10.1 Deployment & Development

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-DEP-001 | The system SHALL support deployment on Raspberry Pi 4 (arm64), Raspberry Pi 5 (arm64), and x86_64 Linux (Debian Bookworm or later). | P1 |
| UR-DEP-005 | The project SHALL have CI/CD pipelines (GitHub Actions) for linting and testing. | P2 |
| UR-DEP-006 | The project SHALL have automated tests covering at minimum: communication layer, configuration validation, and plugin interface contracts. | P2 |
| UR-DEP-007 | The codebase SHALL use TypeScript throughout (engine, manager, and UI). | P1 |
| UR-DEP-008 | The codebase SHALL use ESLint with a shared configuration. | P2 |
| UR-DEP-009 | The project SHALL provide an install/bootstrap script that installs all system dependencies, Node.js packages, and builds native modules in a single command for easy development environment setup. | P1 |

#### 5.10.2 Documentation

| ID | Requirement | Priority |
|----|-------------|----------|
| UR-DOC-001 | The project SHALL provide technical documentation covering architecture, module APIs, communication protocols, plugin development, and configuration schema. | P1 |
| UR-DOC-002 | The project SHALL provide user documentation covering installation, manager UI usage, local control panel operation, and local API usage. | P1 |
| UR-DOC-003 | All public APIs (manager, local API, plugin interfaces) SHALL have complete reference documentation. | P1 |
| UR-DOC-004 | Documentation SHALL be maintained alongside code — outdated documentation SHALL be treated as a bug. | P1 |

---

## 6. Constraints

| ID | Constraint |
|----|-----------|
| C-001 | The team has strong JavaScript/TypeScript expertise. Language choices outside this ecosystem (e.g. Go, Rust) require compelling justification. |
| C-002 | Target hardware includes Raspberry Pi 5 with limited CPU and memory — modules must be resource-efficient. |
| C-003 | GStreamer is the media framework — native C++ addons are required for media processing. |
| C-004 | Deployed systems may have unreliable network connectivity — the engine must operate independently when the manager is unreachable. |
| C-005 | The system is used in live broadcast scenarios — latency and reliability are critical. Long-running stability (weeks of continuous uptime without restart) is required. |

---

## 7. Assumptions

| ID | Assumption |
|----|-----------|
| A-001 | PipeWire is available on all target systems (replacing PulseAudio where needed). |
| A-002 | GStreamer 1.20+ with SRT and RIST plugins is available. WebRTC is handled externally by MediaMTX. |
| A-003 | Hardware video encoding/decoding availability varies by device (e.g. Raspberry Pi 5 has no H.264 hardware encode/decode and only H.265 hardware decode). Software encoding/decoding must always be available as a fallback. |
| A-004 | The existing dgram-comms encryption model (AES-256-CBC) is sufficient for the threat model (pre-shared keys over private networks). |
| A-005 | AV1 hardware encoding on ARM is not yet production-ready. Software-based AV1 (SVT-AV1/dav1d) is available but CPU-intensive on ARM — both hardware and software AV1 are deferred to P3. |
| A-006 | Node.js 20 LTS or later is the minimum runtime version. |

---

## 8. Traceability to v1.0 Issues

This section maps v1.0 known issues to v2.0 requirements that address them.

| v1.0 Issue | Impact | Addressed By |
|-----------|--------|-------------|
| PipeWire audio routing instability (wrong destinations, failed routes) | Audio goes to wrong places during live broadcasts | UR-REL-002, UR-ENG-007 |
| Inflexible audio channel routing (can't split multi-channel inputs) | Can't map individual channels to different modules | UR-ENG-003 |
| No MPEG-TS stream routing | Video can only be received/sent, not routed between modules | UR-ENG-004 |
| Can't split or combine streams | Streams are monolithic — can't demux audio from video for separate processing or mux streams together | UR-ENG-001, UR-ENG-002, UR-ENG-006 |
| Manager UI hacky module linking | HTML/CSS lines fragile and hard to manage | UR-UI-010 through UR-UI-015 |
| Memory leaks in GstvuMeter / GstGeneric (abort() workaround) | Devices freeze over time, require hard restart | UR-ENG-032, UR-REL-003 |
| MD5 password hashing | Insecure authentication | UR-SEC-001 |
| No tests | No confidence in changes, regressions undetected | UR-DEP-006 |
| Memory-only logging, lost on restart | Can't debug issues after the fact | UR-OBS-001, UR-OBS-002 |
| No config validation | Invalid configs accepted silently, discovered at runtime | UR-MGR-003 |
| Fixed timing delays (200ms PA commands, 1500ms HLS) | Race conditions, unreliable startup | UR-REL-002, UR-ENG-033 |
| Synchronous XHR in client require() | Blocks browser main thread, deprecated API | UR-UI-001 (Vue build system) |
| No mobile support, no dark mode | Unusable on phones, no night-time operation mode | UR-UI-030, UR-UI-031 |
| No health checks or monitoring export | Blind to system health, no alerting | UR-OBS-004, UR-OBS-005 |
| No multi-path network redundancy | Single network path failure takes engine offline | UR-COM-002, UR-COM-003 |
| modular-dm framework overhead | Generic framework not optimised for this use case | UR-MGR-012 |
| No plugin system — adding modules requires core changes | Hard to extend, tight coupling | UR-PLG-001 through UR-PLG-005 |
| Profile manager is a separate web app with no API | Can't automate local config, no scripting, no integration | UR-API-001 through UR-API-061 |
| Local config scattered across .env file, profileConf.json, and UI | No single source of truth for local settings | UR-API-020 through UR-API-024 |
| Single config per engine — switching purpose requires manual import/export | Tedious to repurpose devices for different events or testing | UR-MGR-020 through UR-MGR-027 |
| All authenticated users have full access to everything | No per-device or per-role restrictions, risky in multi-operator environments | UR-SEC-010 through UR-SEC-022 |
| `dub` typo in Router.js:125 breaking duplication | Router duplication crashes | Fixed in v2.0 rewrite |
| Global variables in client code | State management issues | UR-UI-001 (Vue state management) |

---

## 9. Future Improvements (Post v2.0)

The following features are out of scope for v2.0 but are candidates for future versions:

| ID | Feature | Description |
|----|---------|-------------|
| FUT-001 | Crosspoint matrix view | A per-device crosspoint matrix routing view as an alternative to the node-wire editor. Sources on one axis, destinations on the other, clickable intersections to create/remove routes, filterable by stream type. Common in broadcast tooling (Dante Controller, Lawo VSM, Grass Valley). |

*End of Document*
