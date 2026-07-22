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
| `pipewire-tools` | **Required.** Provides `pw-link` for native port-to-port audio routing |
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

## Kernel sysctl Settings

The engine moves high-rate media over kernel sockets; the defaults
(~208 KB) are too small. Install as e.g. `/etc/sysctl.d/60-media-router.conf`:

```
# unixfd bus transport: unixfdsink requests SO_SNDBUF=4MB per client
# socket; setsockopt is silently CLAMPED to wmem_max, so without this
# the buffer stays ~208KB and slow-but-alive consumers lose data.
net.core.wmem_max = 4194304
net.core.wmem_default = 4194304

# UDP receive headroom for bursty MPEG-TS mux output into local receivers
# (measured: 760k drops on a 208KB rcvbuf at 24 streams; 0 drops at 128M).
# rmem_max also caps what `udpsrc buffer-size=...` can actually request.
net.core.rmem_max = 134217728
net.core.rmem_default = 134217728
```

Apply with `sudo sysctl --system` (or reboot). On image-based /
read-only-rootfs deployments, bake the fragment into the image — runtime
`sysctl -w` does not survive a rootfs swap.

## unixfd Bus Transport (REQUIRED)

The inter-pipeline media bus is GStreamer unixfd IPC — this is the only bus
transport (the legacy loopback-UDP-multicast bus and its
`MR_BUS_TRANSPORT` switch were removed). The engine refuses to start
without it. Hard requirements:

- **GStreamer ≥ 1.24** — `unixfdsrc`/`unixfdsink` (in `plugins-bad`).
  Stock Debian 12 ships 1.22 — dev boxes use the local prefix
  (`source ~/gst-1.24/env.sh`); the fleet images ship 1.28.
- **A patched `unixfdsink`** for production fan-out: stock unixfdsink
  (verified through 1.28.2) sends to clients on *blocking* sockets while
  holding the element's object lock, so a single stalled consumer freezes
  the producer pipeline permanently and can deadlock dynamic branch
  attachment. The required patch (never block — skip unwritable clients,
  kick after 10 s dead; 4 MB client `SO_SNDBUF`; stale socket unlink before
  bind) is maintained with the deployment tooling, outside this repository.
- The `wmem` sysctl values above.
- The `watchdog` element (`plugins-bad` debugutils) — bus source-silent
  stall detection (`buildBusSrc({stallTimeoutMs})`).

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
