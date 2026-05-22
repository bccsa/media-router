# TODO Notes

## Open

- [ ] Screen goes black after changing browser URL to background1 and back
- [ ] High RAM usage on Pi — 1.5GB available; index.js, start-engine.js, and Pipewire consuming significant memory; Python vs C++ contributing (not actively an issue, revisit if it regresses)
- [ ] Splash image not showing when connecting a monitor
- [ ] Check that auto gain control is off
- [ ] gst-runner treats every Python-side error event as a fatal bus error and triggers `restartOnError`. A `set_property` against a missing element name therefore tears the live pipeline down (see VideoPlayerModule nov-guard fix). Plan: split Python emissions into `bus_error` (fatal — keep restart) vs `command_error` (non-fatal — log + propagate as RPC failure), update GstRunner.handlePythonEvent to only schedule a restart on `bus_error`. Every plugin doing live property control is one stale element name from the same regression.

## Done

### General
- [x] Latency grows over time from 50 ms to 200 ms
- [x] Tooltips for right-click menu items
- [x] Module settings displayable in right-click menu via x-contextMenu
- [x] Revamp manager file (1071 → 105 lines)
- [x] Reset button — kills service and restarts pipewire
- [x] Revamp media-router file (518 → 225 lines)
- [x] Plugins can spawn their own services (ProcessManager)
- [x] Revamp engine.ts (668 → 230 lines)
- [x] Per-plugin logging
- [x] Engine stop/start reliability
- [x] Unit tests baseline established
- [x] README + DEPENDENCIES docs
- [x] Module drag snap-back fix
- [x] Mute/unmute on audio plugins
- [x] VU meter measured after volume on null-sink modules
- [x] Module start reliability after add
- [x] Orphan process audio without connection
- [x] New module placement at viewport center
- [x] Trace/warn debugging + per-level log toggles
- [x] Drag jump-back when stationary
- [x] Live data resumes without refresh after idle
- [x] Stats page closes on outside click
- [x] Module auto-start on enable
- [x] Mute control debounce
- [x] VU meter zero on audio loss

### SRT & RIST
- [x] Test RIST
- [x] Fix SRT stats
- [x] Latency test SRT & RIST
- [x] Multi-connection RIST
- [x] Module start reliability after add
- [x] `[object Object]` on RIST link
- [x] SRT icon distinct from encoders
- [x] Connection indicator for SRT and RIST
- [x] Human-readable Bytes Received
- [x] Audio decoder after RIST input stops after a while
- [x] RIST modules connection badge
- [x] SRT/RIST latency growth

### Features
- [x] MPEG-TS muxer/demuxer plugins
- [x] DB seeded with dummy data on first start

### LCP
- [x] Fixed module width
- [x] Sort order small to large
- [x] Bigger slider knobs
- [x] Tablet landscape/portrait support
- [x] Migrate to Tailwind CSS
- [x] Larger touch targets for knobs and mute

### Audio
- [x] Yocto audio input failures
- [x] Opus noise gate (dtx=false)
- [x] Configurable inband-fec + packet loss %

### Manager UI
- [x] Engine online status reflects reality
- [x] Remove labels on links
- [x] Live settings sync between right-click and settings pane
- [x] Manager showing all links
- [x] Module config panel no longer overlaps top bar
- [x] Add-module menu interaction with settings menu
- [x] Light mode background contrast
- [x] Rename search field to "Search modules…"
- [x] Rename N-1 Mixer to "N-1 Audio Mixer"
- [x] New module visible without refresh

### Engine
- [x] Engine reconnect preserves running state
- [x] Restart after engine restarted
- [x] Spawned process counter in top bar
- [x] Reset honors stopped state
- [x] Engine state vs modules running sync
- [x] PWLink delete bug
- [x] Disconnected audio encoder phantom signal
- [x] N-1 mixer no output after reboot
- [x] "Source channel out of range" on Test 1 enc

### Data Flow Revamp
- [x] Module position snap-back after move
- [x] LCP stop/start has effect
- [x] Stop/start state syncs to LCP
- [x] Name live-update between manager-ui and LCP
- [x] LCP controls live-update
- [x] All config uses patch flow
- [x] Module name live-update on same page
- [x] Settings pane name resets on module switch
- [x] Live channel map changes
- [x] Channel map detects decoder channel count
- [x] No refresh needed after adding module

### Device / System (alpha testing)
- [x] Debug logging toggle reversed

### Feature Requests (alpha testing)
- [x] mDNS discovery
- [x] RAUC download progress + restart message
- [x] Output channel count detection on links
- [x] LCP light mode module name visibility
- [x] Engine online/offline indication live
- [x] USB audio hotplug detection
- [x] Device persistence on disconnect
- [x] LCP mute → on/off toggle styling
- [x] N-1 interlock mute sync engine ↔ manager ↔ LCP
- [x] Square on/off buttons
- [x] Clone module live update
- [x] Logo replaces media-router heading
- [x] Auto-format layout button (Sugiyama sweep)
- [x] Modules jump around when moving
- [x] Video player restart on stream loss
- [x] MPEG-TS muxer/demuxer latency growth
- [x] Engine auto-start after reset when stopped
- [x] Clone/add auto-start when engine stopped
- [x] VU meter zero on missed packet (2s hold)
- [x] Clone from settings panel parity with right-click
- [x] SRT failed connection CPU spike
- [x] Editable engine ID
- [x] Profile switch without engine restart
- [x] Host reboot command from manager dashboard
