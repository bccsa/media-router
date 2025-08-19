# WhepAudioServer

Simple webrtc whep server build on gstreamer

## API endpoints

### Get

-   /whep - whep endpoint to establish webrtc connection (Note: ICE candidates is included in the SDP offer this endpoints returns)
-   /sessions/stats/:type?count=100 - get webrtc statistics
    -   Available types: rtt, packetsLost, packetsLostPercent, packetSent, sessionCount
    -   Available query params: count - to limit the amount of results you want to receive, this will sample the data and return a balanced result

## Configuration

### General Settings

-   Port - Port on which the whep server should run (Whep will be available on http://${Device IP}:${Configured port}/whep)

### Encoder Settings

-   Enable Opus FEC - Enable opus Forward Error Correction
-   Opus Frame Size - Opus frame size (Can decrease to improve latency / increse to reduce overall bandwidth)
-   FEC Packet Loss - Opus FEC packet loss percentage (preset value)
-   Complexity level - Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
-   Bitrate - Opus encoding bitrate

### RED Settings (Redundant Audio Data)

-   Enable RED - Toggle to enable / disable red

---
