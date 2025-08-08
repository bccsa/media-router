# WebRTC Audio Broadcasting with WHEP

A TypeScript implementation of WebRTC audio broadcasting using GStreamer and the WHEP (WebRTC-HTTP Egress Protocol) signaling standard.

## Features

**WHEP Protocol Support** - HTTP-based WebRTC signaling  
**Audio-only Broadcasting** - Efficient Opus-encoded audio streaming  
**GStreamer Integration** - Professional-grade media pipeline  
**TypeScript Implementation** - Type-safe development  
**Express.js Server** - RESTful WHEP signaling server  
**Auto Session Management** - Automatic cleanup and monitoring

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

```

## Installation

```bash
# Clone and install dependencies
npm install

# Build the TypeScript code
npm run build
```

## Usage Options

### Available Scripts

| Command         | Description                    |
| --------------- | ------------------------------ |
| `npm run build` | Build typescript to javascript |
| `npm run dev`   | Run development environment    |

### Configuration

whep-server-gstreamer exposes a class where you can pass the following settings to to configure the Whep server

```typescript
type WhepServerSettings = {
    pulseDevice: string; // PulseAudio source device
    port?: number; // Port for the WHEP server (default 9090)
    opusFec?: boolean; // Enable Opus FEC (default false)
    opusFecPacketLoss?: number; // Opus FEC packet loss percentage (default 5%)
    opusComplexity?: number; // Opus complexity (0-10) (default 10)
    opusBitrate?: number; // Opus bitrate in bps (default 64000)
    opusFrameSize?: number; // Opus frame size in ms (default 20ms)
    rtpRed?: boolean; // Enable RTP RED (default false)
    rtpRedDistance?: number; // RTP RED distance (default 2)
    enableTestClient?: boolean; // Enable test client (default false)
};

const settings: WhepServerSettings = {
    pulseDevice: "default",
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
| `GET`    | `/sessions`        | List all active sessions            |
