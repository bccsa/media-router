# Media Router

A distributed media routing system for broadcast audio and video. Built for [BCC South Africa](https://bccsa.org), Media Router enables real-time audio/video capture, encoding, routing, and playout across networked devices using GStreamer and PipeWire.

## Overview

Media Router follows a **Manager + Engine** architecture:

- **Manager** — Central configuration authority. Stores routing state in SQLite, serves the web UI, and communicates with engines over encrypted UDP.
- **Engine** — Runs on each media device (e.g. Raspberry Pi). Executes GStreamer pipelines, manages PipeWire audio routing, and reports status back to the manager.
- **Plugins** — Self-contained modules that add media capabilities (audio input/output, encoding, decoding, SRT, RIST, etc.).

```
                    Browser (Vue 3)
                        |
                   Socket.IO + REST
                        |
                    +---------+
                    | Manager |  ← SQLite config store
                    +---------+
                        |
                  dgram-comms (encrypted UDP)
                        |
            +-----------+-----------+
            |                       |
        +--------+             +--------+
        | Engine |             | Engine |
        +--------+             +--------+
            |                       |
       GStreamer +             GStreamer +
       PipeWire                PipeWire
```

## Architecture

| Component | Package | Description |
|-----------|---------|-------------|
| **Shared Types** | `packages/shared-types` | TypeScript interfaces, logging, utilities shared across all packages |
| **dgram-comms** | `packages/dgram-comms` | Encrypted UDP protocol with AES-256-GCM, fragmentation, and keepalives |
| **Engine** | `packages/engine` | GStreamer pipeline management, PipeWire audio routing, plugin host |
| **Manager** | `packages/manager` | Express v5 HTTP server, Socket.IO, SQLite config store, engine orchestration |
| **Manager UI** | `packages/manager-ui` | Vue 3 + Vue Flow routing editor, Pinia stores, Tailwind CSS dark theme |
| **Local Panel** | `packages/local-panel` | Operator control interface (faders, VU meters, mute buttons) |
| **Profile Manager** | `packages/profile-manager` | Engine-side app for configuring which manager to connect to |

### Plugins

| Plugin | Directory | Description |
|--------|-----------|-------------|
| Audio Input | `plugins/audio-input` | Captures from PipeWire/PulseAudio source devices |
| Audio Output | `plugins/audio-output` | Plays to PipeWire/PulseAudio sink devices |
| Audio Encoder | `plugins/audio-encoder` | Encodes PCM to Opus/AAC in MPEG-TS, outputs via UDP multicast |
| Audio Decoder | `plugins/audio-decoder` | Decodes MPEG-TS audio with auto-detection (Opus, AAC, MP2) |
| Example Plugin | `plugins/example-plugin` | Template for creating new plugins |

See [plugins/README.md](plugins/README.md) for the full plugin development guide.

### Port Map

| Port | Service |
|------|---------|
| 3000 | dgram-comms (engine <-> manager encrypted UDP) |
| 3001 | Engine Local API (Fastify REST) |
| 5173 | Manager UI dev server (Vite) |
| 8080 | Manager HTTP + Socket.IO |
| 8081 | Local Control Panel |
| 8082 | Profile Manager |

## Quick Start

### Prerequisites

Install system dependencies first — see [DEPENDENCIES.md](DEPENDENCIES.md) for version details.

**Required:**
- Node.js >= 20
- pnpm >= 10
- Python 3 (with GStreamer bindings)
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

### First-time Setup

1. Open the Manager UI at `http://localhost:5173` (dev) or `http://localhost:8080` (production)
2. Register an engine: sidebar -> Settings -> Register Engine (set an ID and password)
3. On the engine device, create a connection profile:
   ```bash
   curl -X POST http://localhost:3001/api/v1/profiles \
     -H 'Content-Type: application/json' \
     -d '{"name":"<engine-id>","managerHost":"<manager-ip>","managerPort":3000,"password":"<password>"}'

   curl -X POST http://localhost:3001/api/v1/profiles/<engine-id>/activate
   ```
4. The engine should appear as "online" in the sidebar
5. Click the engine -> Add Module -> choose Audio Input, Encoder, Decoder, etc.
6. Draw connections between module ports to route audio

## Testing

```bash
# Run all tests (166 tests across 17 files)
pnpm test

# Run with coverage
pnpm test -- --coverage

# Run a specific test file
pnpm test -- packages/engine/src/routing/PortRegistry.test.ts

# Watch mode
pnpm test:watch
```

## Project Structure

```
media-router/
  packages/
    shared-types/     # TypeScript types, logger, utilities
    dgram-comms/      # Encrypted UDP transport
    engine/           # Media engine (GStreamer + PipeWire)
    manager/          # Central manager (Express + SQLite)
    manager-ui/       # Web UI (Vue 3 + Vue Flow)
    local-panel/      # Operator control panel
    profile-manager/  # Engine connection config
  plugins/
    audio-input/      # Mic/line capture
    audio-output/     # Speaker/headphone playout
    audio-encoder/    # Opus/AAC encoding
    audio-decoder/    # Auto-detect decoding
    example-plugin/   # Plugin template
  docs/
    URS-v2.0.md       # User Requirements Specification
    FDS-v2.0.md       # Functional Design Specification
    implementation-plan-v2.0.md
    TodoNotes.md      # Active issue tracker
```

## Roadmap

The project follows a phased implementation plan. Current status:

| Phase | Name | Status |
|-------|------|--------|
| 0 | Project Foundation | Done |
| 1 | Communication Layer (dgram-comms) | Done |
| 2 | Engine Core | Done |
| 3 | GStreamer Child Process Runtime | Done |
| 4 | Manager Core | Done |
| 5 | Core Audio Plugins | Done |
| 6 | Protocol Plugins: SRT & RIST | Planned |
| 7 | Protocol Plugins: HLS & Stream Probing | Planned |
| 8 | Audio Processing Plugins | Planned |
| 8B | Audio Channel Mapping & Link Metadata | In Progress |
| 9 | Manager Web UI | In Progress |
| 10 | Local Control Panel | Planned |
| 11 | Profile Manager App | Planned |
| 12 | Video Modules & Advanced Features | Planned |
| 13 | Security & Authentication | Planned |
| 14 | Observability & Logging | In Progress |
| 15 | Hardening & Deployment | Planned |

See [docs/implementation-plan-v2.0.md](docs/implementation-plan-v2.0.md) for full details.

## Documentation

- [User Requirements Specification](docs/URS-v2.0.md)
- [Functional Design Specification](docs/FDS-v2.0.md)
- [Implementation Plan](docs/implementation-plan-v2.0.md)
- [Plugin Development Guide](plugins/README.md)
- [Dependencies](DEPENDENCIES.md)

## License

See [LICENSE](LICENSE).
