# Media Router

A distributed media routing system for broadcast audio and video. Built for [BCC South Africa](https://bccsa.org), Media Router enables real-time audio/video capture, encoding, routing, and playout across networked devices using GStreamer and PipeWire.

## Overview

Media Router follows a **Manager + Engine** architecture:

- **Manager** — Central configuration authority. Stores routing state in SQLite, serves the web UI, and communicates with engines over encrypted UDP.
- **Engine** — Runs on each media device (e.g. Raspberry Pi). Executes GStreamer pipelines, manages PipeWire audio routing, and reports status back to the manager.
- **Plugins** — Self-contained modules that add media capabilities (audio input/output, encoding, decoding, SRT, RIST, N-1 mixing, etc.).

```
Browser (Vue 3)                              LCP (Vue 3)
     |                                           |
Socket.IO                                   Socket.IO
     |                                           |
 +---------+         dgram-comms          +--------+
 | Manager | ◄──── encrypted UDP ────►    | Engine |
 +---------+         (port 3000)          +--------+
  SQLite DB                                GStreamer +
                                           PipeWire
```

### Data Flow

All config changes (settings, rename, position, connections, etc.) flow through a unified **N-1 Patch Router** system:

- **One `patch` event** carries JSON Patch ops for any config change
- Each router receives from any client, persists/applies, forwards to all **other** clients (skip sender)
- Browser → Manager Router → Engine Router → LCP (and vice versa)
- Lifecycle commands (start/stop/reset/restart) remain as separate events
- Streams (VU meters, system stats, logs) remain as separate high-frequency events

## Architecture

| Component | Package | Description |
|-----------|---------|-------------|
| **Shared Types** | `packages/shared-types` | TypeScript interfaces, logging, `PatchOp`, `applyJsonPatch` utility |
| **dgram-comms** | `packages/dgram-comms` | Encrypted UDP protocol with AES-256-GCM, fragmentation, and keepalives |
| **Engine** | `packages/engine` | GStreamer pipeline management, PipeWire audio routing, plugin host, N-1 patch router |
| **Manager** | `packages/manager` | Express HTTP server, Socket.IO, SQLite config store, N-1 patch router |
| **Manager UI** | `packages/manager-ui` | Vue 3 + Vue Flow routing editor, Pinia stores, Tailwind CSS dark theme |
| **Local Panel** | `packages/local-panel` | Operator control interface (vertical faders, VU meters, mute buttons) |
| **Profile Manager** | `packages/profile-manager` | Engine-side app for configuring which manager to connect to |

### Plugins

| Plugin | Directory | Description |
|--------|-----------|-------------|
| Audio Input | `plugins/audio-input` | Captures from PipeWire source devices via native `module-remap-source` |
| Audio Output | `plugins/audio-output` | Plays to PipeWire sink devices via native `module-remap-sink` |
| Audio Encoder | `plugins/audio-encoder` | Encodes PCM to Opus/AAC in MPEG-TS, outputs via UDP multicast |
| Audio Decoder | `plugins/audio-decoder` | Decodes MPEG-TS audio with auto-detection (Opus, AAC, MP2) |
| SRT Input | `plugins/srt-input` | Receives SRT streams (listener mode) |
| SRT Output | `plugins/srt-output` | Sends SRT streams (caller mode) |
| RIST Input | `plugins/rist-input` | Receives RIST streams via `ristreceiver` CLI |
| RIST Output | `plugins/rist-output` | Sends RIST streams via `ristsender` CLI |
| N-1 Mixer | `plugins/n1-mixer` | Mix-minus routing — each output gets all inputs except its own |
| Example Plugin | `plugins/example-plugin` | Template for creating new plugins |

See [plugins/README.md](plugins/README.md) for the full plugin development guide.

### Port Map

| Port | Service |
|------|---------|
| 3000 | dgram-comms (engine ↔ manager encrypted UDP) |
| 3001 | Engine Local API (Fastify REST) |
| 5173 | Manager UI dev server (Vite) |
| 5174 | Local Panel dev server (Vite) |
| 8080 | Manager HTTP + Socket.IO |
| 8081 | Local Control Panel (Socket.IO + static files) |
| 8082 | Profile Manager |

## Quick Start

### Prerequisites

Install system dependencies first — see [DEPENDENCIES.md](DEPENDENCIES.md) for version details.

**Required:**
- Node.js >= 20
- pnpm >= 10
- Python 3 (with GStreamer GI bindings)
- GStreamer 1.22+
- PipeWire 1.0+

### Install

```bash
git clone https://github.com/bfrsa/media-router.git
cd media-router
pnpm install
pnpm build
```

### Run (Development)

Open three terminals:

```bash
# Terminal 1 — Manager backend
pnpm --filter @media-router/manager dev

# Terminal 2 — Manager UI (hot reload)
pnpm --filter @media-router/manager-ui dev

# Terminal 3 — Engine
pnpm --filter @media-router/engine dev
```

Then open `http://localhost:5173` in your browser.

### Run (Production)

```bash
pnpm build

# Manager (serves built UI on port 8080)
node packages/manager/dist/index.js

# Engine (on each media device)
node packages/engine/dist/index.js
```

The LCP is served automatically by the engine on port 8081.

### First-time Setup

1. Open the Manager UI at `http://localhost:5173` (dev) or `http://localhost:8080` (production)
2. Register an engine: sidebar → Settings → Register Engine (set an ID and password)
3. On the engine device, create a connection profile:
   ```bash
   curl -X POST http://localhost:3001/api/v1/profiles \
     -H 'Content-Type: application/json' \
     -d '{"name":"<engine-id>","managerHost":"<manager-ip>","managerPort":3000,"password":"<password>"}'

   curl -X POST http://localhost:3001/api/v1/profiles/<engine-id>/activate
   ```
4. The engine should appear as "online" in the sidebar within ~5 seconds
5. Click the engine → Open Routing Editor → Add Module → choose Audio Input, Encoder, etc.
6. Draw connections between module ports to route audio

### Build Number

To display a version/build number on each engine (shown in Manager UI and LCP header):

```bash
echo "v2.0.1" > build-number.txt
```

The engine searches for this file in its working directory and up to 3 parent directories. Restart the engine to pick up changes.

## Testing

```bash
# Run all tests (280 tests across 27 files)
pnpm test

# Run with coverage
pnpm test -- --coverage

# Run a specific test file
pnpm test -- packages/engine/src/routing/PortRegistry.test.ts
```

## Project Structure

```
media-router/
  packages/
    shared-types/     # TypeScript types, PatchOp, applyJsonPatch, logger
    dgram-comms/      # Encrypted UDP transport
    engine/           # Media engine (GStreamer + PipeWire + EnginePatchRouter)
    manager/          # Central manager (Express + SQLite + PatchRouter)
    manager-ui/       # Web UI (Vue 3 + Vue Flow)
    local-panel/      # Operator control panel (faders, VU, mute)
    profile-manager/  # Engine connection config
  plugins/
    audio-input/      # Mic/line capture (PipeWire remap-source)
    audio-output/     # Speaker/headphone playout (PipeWire remap-sink)
    audio-encoder/    # Opus/AAC encoding
    audio-decoder/    # Auto-detect decoding
    srt-input/        # SRT receiver
    srt-output/       # SRT sender
    rist-input/       # RIST receiver
    rist-output/      # RIST sender
    n1-mixer/         # N-1 mix-minus (dynamic pair count)
    example-plugin/   # Plugin template
  docs/
    URS-v2.0.md       # User Requirements Specification
    FDS-v2.0.md       # Functional Design Specification
    implementation-plan-v2.0.md
    TodoNotes.md      # Active issue tracker
```

## Roadmap

| Phase | Name | Status |
|-------|------|--------|
| 0 | Project Foundation | Done |
| 1 | Communication Layer (dgram-comms) | Done |
| 2 | Engine Core | Done |
| 3 | GStreamer Child Process Runtime | Done |
| 4 | Core Audio Plugins | Done |
| 5 | Manager Core | Done |
| 6 | Manager Web UI | Done |
| 7 | Protocol Plugins: SRT & RIST | Done |
| 8 | Protocol Plugins: HLS & Stream Probing | Partial (probing done, HLS not started) |
| 8B | Audio Channel Mapping | Partial (designed, pw-link implemented) |
| 9 | Audio Processing Plugins | Partial (N-1 mixer done, sound processor/ducking not started) |
| 10 | Local Control Panel | Done |
| 11 | Profile Manager App | Partial (API done, UI scaffold) |
| 12 | Video Modules | Not started |
| 13 | Security & Auth | Not started |
| 14 | Observability & Logging | Partial (structured logging done) |
| 15 | Hardening & Deployment | Not started |

See [docs/implementation-plan-v2.0.md](docs/implementation-plan-v2.0.md) for full details.

## Documentation

- [User Requirements Specification](docs/URS-v2.0.md)
- [Functional Design Specification](docs/FDS-v2.0.md)
- [Implementation Plan](docs/implementation-plan-v2.0.md)
- [Plugin Development Guide](plugins/README.md)
- [Dependencies](DEPENDENCIES.md)

## License

See [LICENSE](LICENSE).
