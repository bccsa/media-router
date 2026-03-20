# Dependencies

## System Requirements

Media Router is developed and tested on **Debian 12 (Bookworm)** on **Raspberry Pi 5 (arm64)**. It should work on any Linux distribution with the required dependencies.

### Runtime Dependencies

| Dependency | Minimum Version | Tested Version | Purpose |
|-----------|----------------|----------------|---------|
| **Node.js** | 20.x | 20.19.2 | JavaScript runtime for manager and engine |
| **Python 3** | 3.10+ | 3.11.2 | GStreamer pipeline runner (GI bindings) |
| **PipeWire** | 1.0+ | 1.2.7 | Audio routing, null-sinks, loopbacks |
| **GStreamer** | 1.22+ | 1.22.0 | Media pipeline framework |
| **SQLite 3** | 3.x | (via better-sqlite3) | Manager config storage |

### GStreamer Plugins

All GStreamer plugin packages are required:

| Package | Version | Key Elements Used |
|---------|---------|-------------------|
| `gstreamer1.0-plugins-base` | 1.22.0 | `audioconvert`, `audioresample`, `level`, `volume`, `typefind` |
| `gstreamer1.0-plugins-good` | 1.22.0 | `pulsesrc`, `pulsesink`, `udpsrc`, `udpsink`, `interleave`, `deinterleave` |
| `gstreamer1.0-plugins-bad` | 1.22.0 | `mpegtsmux`, `tsdemux`, `opusenc`, `opusdec`, `clocksync` |
| `gstreamer1.0-plugins-ugly` | 1.22.0 | `twolamemp2enc`, `mpg123audiodec` |
| `gstreamer1.0-pipewire` | 1.2.7 | PipeWire integration for GStreamer |

### PipeWire Components

| Package | Purpose |
|---------|---------|
| `pipewire` | Core audio server |
| `wireplumber` | PipeWire session manager |
| `pipewire-pulse` | PulseAudio compatibility layer (used by `pulsesrc`/`pulsesink`) |
| `pipewire-alsa` | ALSA compatibility |

### Python GStreamer Bindings

| Package | Purpose |
|---------|---------|
| `python3-gi` | GObject Introspection for Python |
| `gir1.2-gstreamer-1.0` | GStreamer GI bindings |
| `gir1.2-gst-plugins-base-1.0` | GStreamer plugins base GI bindings |

### Build Tools

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| **pnpm** | 10.x | Package manager (workspace monorepo) |
| **TypeScript** | 5.9+ | Type checking and compilation |

## Installation (Debian/Ubuntu)

```bash
# Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# pnpm
npm install -g pnpm

# PipeWire + WirePlumber
sudo apt-get install -y \
    pipewire pipewire-pulse pipewire-alsa wireplumber

# GStreamer + plugins
sudo apt-get install -y \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-pipewire

# Python GStreamer bindings
sudo apt-get install -y \
    python3-gi \
    gir1.2-gstreamer-1.0 \
    gir1.2-gst-plugins-base-1.0

# Build tools
sudo apt-get install -y \
    build-essential \
    python3-dev
```

## Installation (Raspberry Pi OS / Bookworm)

Same as Debian above. PipeWire is the default audio server on Raspberry Pi OS Bookworm.

## Optional Dependencies

| Dependency | Purpose |
|-----------|---------|
| `libfdk-aac-dev` + `gstreamer1.0-fdkaac` | AAC-LD/ELD low-delay encoding (not in default repos) |
| `gstreamer1.0-libav` | Additional codec support via FFmpeg/libav |
| `pw-link` (part of pipewire) | Per-channel audio routing |

## npm Package Dependencies

All npm dependencies are managed via pnpm workspace. Key packages:

### Backend
| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| `express` | 5.x | Manager | HTTP server |
| `socket.io` | 4.x | Manager, Engine | Real-time browser communication |
| `better-sqlite3` | 12.x | Manager | SQLite database |
| `fastify` | 5.x | Engine | Local REST API |
| `pino` | 10.x | All | Structured logging |
| `ajv` | 8.x | Engine | JSON Schema validation |

### Frontend
| Package | Version | Used By | Purpose |
|---------|---------|---------|---------|
| `vue` | 3.5.x | Manager UI | Reactive UI framework |
| `pinia` | 3.x | Manager UI | State management |
| `vue-router` | 4.x | Manager UI | Client-side routing |
| `@vue-flow/core` | 1.48.x | Manager UI | Node-based routing editor |
| `socket.io-client` | 4.x | Manager UI | Real-time server communication |
| `lucide-vue-next` | 0.577.x | Manager UI | Icon library |
| `tailwindcss` | 4.x | Manager UI | Utility-first CSS |

### Development
| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | 5.9.x | Type checking |
| `vitest` | 3.2.x | Test framework |
| `@vue/test-utils` | 2.x | Vue component testing |
| `tsx` | 4.x | TypeScript execution (dev mode) |
| `prettier` | 3.x | Code formatting |

## Verifying Installation

```bash
# Check all system dependencies
node --version          # Should be >= 20
pnpm --version          # Should be >= 10
python3 --version       # Should be >= 3.10
gst-launch-1.0 --version  # Should be >= 1.22
pipewire --version      # Should be >= 1.0
pactl info              # Should show PipeWire as server

# Check GStreamer elements
gst-inspect-1.0 pulsesrc     # PipeWire/PulseAudio source
gst-inspect-1.0 opusenc      # Opus encoder
gst-inspect-1.0 mpegtsmux    # MPEG-TS muxer
gst-inspect-1.0 level        # Audio level metering

# Check Python GStreamer bindings
python3 -c "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst; print('OK')"

# Run project tests
pnpm test
```
