# CLAUDE.md - Media Router

## Project Overview

Distributed media routing system (BCC South Africa) for audio/video routing, processing, and streaming. Supports SRT, RIST, WebRTC, and HLS protocols with PulseAudio integration and GStreamer-based native C++ modules.

**Architecture**: Manager (central server) ↔ Router (client devices) via custom UDP protocol (`dgram-comms`).

## Key Paths

- `server/router.js` — Main router process
- `server/manager.js` — Central manager server
- `server/controls/` — Server-side control modules (audio, video, SRT, etc.)
- `server/gst_modules/` — Native C++ GStreamer addons (node-gyp)
- `server/dgram-comms/` — Custom UDP communication layer with encryption
- `server/modular-dm/` — Data model framework (git submodule)
- `client/` — Manager web UI (port 8080)
- `client/modular-ui/` — UI framework (git submodule)
- `local-client/` — Local operator interface (port 8081)
- `local-profileman/` — Profile manager (port 8082)

## Tech Stack

- **Runtime**: Node.js on Debian Bookworm (Raspberry Pi / Linux)
- **Language**: JavaScript (ES6+, CommonJS modules)
- **Server**: Express + Socket.IO
- **Native addons**: C++ via node-addon-api / node-gyp
- **CSS**: Tailwind CSS
- **Frameworks**: modular-dm (data model), modular-ui (UI) — both git submodules

## Commands

```bash
# Install dependencies
./install-dependencies.sh
cd server && npm install
cd client && npm install

# Build native GStreamer modules
cd server/gst_modules/SrtVideoPlayer && node-gyp configure && node-gyp build
cd server/gst_modules/SrtOpusOutput && node-gyp configure && node-gyp build
cd server/gst_modules/SrtOpusInput && node-gyp configure && node-gyp build

# Debug builds (from root)
npm run build:gst:dev
npm run build:gst-opusOut:dev
npm run build:gst-opusIn:dev

# Run (use VS Code launch configs or directly)
node server/router.js
node server/manager.js

# Docker
docker-compose up manager router mediamtx

# No automated tests currently configured
```

## Code Conventions

- **CommonJS**: `const X = require('./path')` — no ES modules
- **Classes**: PascalCase (`AudioInput`, `SrtOpusOutput`)
- **Private/base classes**: underscore prefix (`_paAudioBase`, `_routerChildControlBase`)
- **Properties**: camelCase; private with underscore prefix (`_vu`, `_controls`)
- **Constants**: ALL_CAPS (`MR_PA_*` for PulseAudio names)
- **Indentation**: 4 spaces
- **One class per file**, filename matches class name
- **Mixin pattern**: `class Router extends Classes(dm, Resources, Logs, PulseAudio)`
- **Data model**: Controls extend `dm` base, use `SetAccess()`, `SetMeta()`, `NotifyProperty()`

## Class Hierarchy

```
dm (modular-dm base)
└─ _routerChildControlBase
   ├─ vuMeter (mixin)
   │  └─ _paAudioBase → _paAudioSourceBase → AudioInput
   │                   → _paAudioSinkBase → AudioOutput
   ├─ SrtBase → SrtOpusInput, SrtOpusOutput, SrtVideoPlayer, SrtVideoEncoder, SrtRelay
   ├─ HlsPlayer
   └─ WhepAudioServer, WebRTCClient, SoundProcessor, SoundDucking
```

## Git Workflow

- **Main branch**: `v1.1` (PR target)
- **Feature branches**: `<issue-number>-<type>-<description>` (e.g., `610-feat-send-periodic-vu-meter-updates`)
- **Commit format**: `{type}: {description}` — types: `feat`, `fix`, `docs`, `refactor`, `style`, `test`, `chore`

## Ports

| Port | Service |
|------|---------|
| 3000 | Manager (router config API) |
| 8080 | Manager web UI |
| 8081 | Local operator UI |
| 8082 | Profile manager UI |
| 8890 | SRT streams |
| 2000 | WebRTC config API |

## Key Patterns

- **Child processes**: Heavy media work runs in `server/child_processes/` (e.g., `vu_child.js`, `SrtVideoPlayer_child.js`)
- **Control modules** mirror between server (`server/controls/`) and client (`client/controls/`) with matching filenames
- **Config files**: `server/managerConf.json` and `server/profileConf.json` are gitignored runtime configs; defaults in `defaultManagerConf.json` / `defaultProfileConf.json`
- **Socket.IO** for manager↔browser; **dgram-comms** (UDP) for manager↔router
