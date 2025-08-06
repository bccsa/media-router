# WebRTC Audio Broadcasting with WHEP

A TypeScript implementation of WebRTC audio broadcasting using GStreamer and the WHEP (WebRTC-HTTP Egress Protocol) signaling standard.

## Features

✅ **WHEP Protocol Support** - HTTP-based WebRTC signaling  
✅ **Audio-only Broadcasting** - Efficient Opus-encoded audio streaming  
✅ **GStreamer Integration** - Professional-grade media pipeline  
✅ **TypeScript Implementation** - Type-safe development  
✅ **Express.js Server** - RESTful WHEP signaling server  
✅ **Auto Session Management** - Automatic cleanup and monitoring

## Prerequisites

Make sure you have GStreamer installed on your system:

```bash
# Ubuntu/Debian
sudo apt-get install gstreamer1.0-tools gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly gstreamer1.0-libav \
    libnice10 gstreamer1.0-nice gir1.2-gst-plugins-bad-1.0 \
    gir1.2-gst-plugins-base-1.0

# Ubuntu/Debian dev dependencies (needed to build this project)
sudo apt install build-essential libgirepository1.0-dev libcairo2-dev \
    gir1.2-gtk-3.0 pkg-config

# Check installation
gst-inspect-1.0 webrtcbin
gst-inspect-1.0 opusenc
```

## Installation

```bash
# Clone and install dependencies
npm install

# Build the TypeScript code
npm run build
```

## Quick Start

### Option 1: Run Everything Together (Recommended)

```bash
# Start both WHEP server and broadcaster
npm run full-demo
```

### Option 2: Manual Setup

**Terminal 1 - Start WHEP Server:**

```bash
npm run whep-server
```

**Terminal 2 - Start Audio Broadcaster:**

```bash
npm run dev-broadcaster
```

## Usage Options

### Available Scripts

| Command                     | Description                           |
| --------------------------- | ------------------------------------- |
| `npm run whep-server`       | Start WHEP signaling server           |
| `npm run dev-whep`          | Start WHEP server with auto-reload    |
| `npm run dev-broadcaster`   | Start broadcaster in development mode |
| `npm run start-broadcaster` | Build and run broadcaster             |
| `npm run full-demo`         | Run server and broadcaster together   |

### Configuration

Configure the broadcaster by setting environment variables:

```bash
# Custom WHEP endpoint
WHEP_ENDPOINT=http://localhost:8080/whep npm run dev-broadcaster

# Different audio frequency (musical notes)
AUDIO_FREQ=880 npm run dev-broadcaster  # A5 note (880Hz)
```

### Audio Configuration

The broadcaster generates a sine wave test signal. You can modify the frequency in [`src/index.ts`](src/index.ts):

```typescript
const config: WHEPConfig = {
    whepEndpoint: 'http://localhost:8080/whep',
    audioFreq: 440, // 440 Hz = A4 musical note
    duration: 60, // Broadcast duration in seconds
    waveType: 0, // 0=sine, 1=square, 2=saw, etc.
    stunServer: 'stun://stun.l.google.com:19302',
};
```

## API Endpoints

### WHEP Server Endpoints

| Method   | Endpoint           | Description                         |
| -------- | ------------------ | ----------------------------------- |
| `POST`   | `/whep`            | Create new WHEP session (SDP offer) |
| `GET`    | `/whep/:sessionId` | Get session information             |
| `DELETE` | `/whep/:sessionId` | Delete session                      |
| `PATCH`  | `/whep/:sessionId` | Send ICE candidates                 |
| `GET`    | `/health`          | Server health check                 |
| `GET`    | `/sessions`        | List all active sessions            |

### Example Usage

```bash
# Check server health
curl http://localhost:8080/health

# List active sessions
curl http://localhost:8080/sessions

# Send SDP offer (example)
curl -X POST http://localhost:8080/whep \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

## Architecture

### Components

1. **WHEP Server** ([`src/whep-server.js`](src/whep-server.js))
    - Express.js HTTP server
    - WHEP protocol implementation
    - Session management
    - SDP offer/answer exchange

2. **WHEP Client** ([`src/whep-client.ts`](src/whep-client.ts))
    - GStreamer WebRTC pipeline
    - HTTP-based signaling
    - Automatic session cleanup

3. **Main Application** ([`src/index.ts`](src/index.ts))
    - Application entry point
    - Configuration management
    - Error handling

### Pipeline Architecture

```
audiotestsrc → audioconvert → audioresample → queue →
opusenc → rtpopuspay → queue → webrtcbin → WHEP Server
```
