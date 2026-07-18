# TODO Notes

## Open

- [x] 302M plugins invisible in the manager UI (2026-07-18) — `AddModulePanel.vue` grouped the palette by a hard-coded category list without `input`/`output`, so `audio-input-302m` / `audio-output-302m` never rendered (search couldn't reach them either). Fixed: categories extended + unknown categories now fold into their own trailing groups so a new category can never silently vanish again.
- [x] N-1 Audio Mixer on the 302M bus (2026-07-18) — new `n1-mixer-302m` plugin alongside the PipeWire `n1-mixer`: decode-once + `tee` per input (unlimited sources per input, summed), one force-live `audiomixer` per output fed by every input except its own pair, `build302mEncodeBranch` → bus sink per output. Bare-minimum controls (`pairCount`, `mixLatencyMs`); outputs without contributors aren't built/allocated. 19 tests. **TODO: live-verify on a 302M-capable box (gst ≥ 1.26, e.g. .211/gate01 on 1.28) — this Pi's gst 1.22 mpegtsmux can't mux 302M, so the module health-errors here by design.**

- [ ] Engine child-restart wedge on runner process death (found on gate01, 2026-07-18) — SIGTERM-killing a module's `gst-pipeline-runner.py` (which then SIGSEGVs during unixfd teardown) leaves the module dead permanently: the respawned python exits `code=0` immediately, `gst-runner.js` treats a clean exit as an intentional stop and never retries, and every downstream consumer blocks forever in `Waiting for producer bus socket(s)` (busSocketGate; the socket hash is deterministic per connection, so the path would resolve if the producer ever rebuilt). Engine event loop stays healthy — only an engine restart recovers. Production impact: any OOM-kill/segfault of a producer runner takes down its whole downstream chain silently. Fix direction: gst-runner should retry (with backoff) on unexpected clean exits shortly after spawn, and/or the engine should health-check modules stuck in the socket-gate wait.
- [ ] gate01 config: `Enc NO 256k aac` (feeds Mux 1080p NO) has `tsAlignment=0` (Continuous) while every other encoder uses 7 (SRT-aligned) — wire cadence is clean, but align it for consistency before calibrating the NO mux's `offsetMs`.
- [ ] Muxer A/V alignment re-rolls on upstream PTS discontinuity (measured gate01 2026-07-18) — each mux input's `tsdemux` re-anchors its segment to current arrival when the source PTS jump (loop-wrap sim: lipsync moved +421 → −2441 ms across ONE wrap, no restarts), while re-stamped inputs (audio encoder chains) keep their old anchor. In production, any upstream discontinuity (source hiccup, upstream module restart, 33-bit PTS wrap every 26.5 h) shifts that mux's lipsync by an arbitrary amount until the muxer restarts. Fix direction: detect discont re-anchor in a mux input branch and either re-anchor ALL branches together or trigger a muxer self-restart; long-term fix is the net-clock/PTS-preserving audio path. Also means: never calibrate `offsetMs` against the looped OCC sim — only against live content.

- [x] Engine "system over custom" consolidation (review follow-up, 2026-07-10) — (1) **Sticky live-prop replay**: `GstChildProcess` records the last value per element property and replays them on every PLAYING transition, so live changes (volume, overlay text, encoder bitrate, LSP dynamics params) survive crash-restarts at BOTH restart layers; `setElementProperty` is now also safe while the pipeline is down (recorded, applied on next PLAYING). Ducker re-seeds unity in `onPipelinePlaying` since the replay restores the last duck gain. (2) Deleted dead `liveElements`/`vuElements` from `PipelineDescription` (consumed by nothing) + all plugin usages. (3) Demuxer `stream_discovered`/`stream_names` migrated onto the generic `pluginEvent` channel (`stream:discovered`/`stream:names`) — deleted both bespoke passthroughs from Python/GstRunner/GstChildProcess. (4) `ThroughputPoller` generalized to named multi-counters (`getBytes` may return `Record<name, bytes>`; `publish(total, counters)`) — transcoder's hand-rolled per-rendition rate math (incl. its duplicate reset guard) deleted.

- [x] Audio Dynamics plugin (plan tasks 8.3/8.4) — compressor / ducker / gate in one `audio-dynamics` module with a dedicated **sidechain graph input** (any module's audio output keys the processing). DSP = LSP LADSPA `sc-compressor-stereo` / `sc-gate-stereo` via the gst `ladspa` wrapper (two stereo monitors → deinterleave → 4-ch interleave; program on 0/1, key on 2/3; lookahead 0 = zero added latency). All params live-updatable; GR + key-level meters polled into status/badge. New engine helper `findLadspaElement()` (LADSPA element names embed the .so version). E2E-verified on real PipeWire (−42 dB duck, clean recovery). **Deps: dev box needs `apt install lsp-plugins-ladspa`; fleet image needs gst-plugins-bad `ladspa` PACKAGECONFIG + an lsp-plugins-ladspa recipe (Yocto work in meta-custom, in progress).**

- [x] Transcoder plugin (issue #650) — ABR-ready video transcoder: one MPEG-TS video input, decode-once → `tee` → N config-driven renditions (per-output width/height/bitrate), each its own MPEG-TS output port. Shared codec/framerate/GOP; own `encoderBranch.ts` (CBR element selection, sibling to Video Encoder's). **TODO: validate on real hardware under load** (parallel software x264 on a Pi 5; HW encoder is single-instance, so use the Software impl for multi-rendition ABR).
- [x] Transcoder per-encode encoder settings (issue #657) — renditions may now override `codec`, `encoderImpl`, `rateControl`, `speedPreset`, `h264Profile`, `sceneCut` individually; each module-global stays the default and a blank override inherits it. Impl is resolved **per rendition** against the (possibly overridden) codec. UI: `MrArrayField` grew a collapsible per-item **Advanced** section (new `x-advanced` schema flag) with enum labels, item-relative `x-showWhen`, and explicit inherit affordances. `framerate`/`gopFrames`/`bufferMs`/decode-threading stay global (single shared decoder + ABR keyframe alignment).
- [x] Engine fix (found while wiring the transcoder via API): `getDynamicPorts` now receives the module instance's authoritative config from `ModuleInstance`. The engine resolves ports *before* a module starts, when the plugin's own `this.config` is still empty (applied in `onInit`) — so a not-yet-running dynamic-port module previously resolved its port set from empty config and showed the wrong count. Latent for muxer/demuxer/n1-mixer (their defaults masked it); it surfaced on the transcoder because its manifest default (3 renditions) differs from an empty-config fallback.
- [ ] Verify HLS Player on a Pi against a live HLS stream — language auto-detect, multi-language inline audio + subtitles, ABR, and MPEG-TS routing to a downstream module
- [x] Video-player fallback/resume race — when the source drops and returns within ~2 s (e.g. an upstream transcoder rebuild), the "Source resumed" restart landed while the fallback switch was mid-flight and was DROPPED by `restartPipeline`'s in-progress latch; the player then showed "No video detected" forever while healthy data flowed (observed on .172, 2026-07-02). Fixed: a trigger that lands mid-cycle now queues exactly one follow-up stop/start cycle, so the pipeline always converges on the latest stall/resume state. 2 tests added.
- [x] Screen goes black after changing browser URL to background1 and back
- [ ] High RAM usage on Pi — 1.5GB available; index.js, start-engine.js, and Pipewire consuming significant memory; Python vs C++ contributing (not actively an issue, revisit if it regresses)
- [x] Splash image not showing when connecting a monitor
- [x] Check that auto gain control is off
- [x] gst-runner treats every Python-side error event as a fatal bus error and triggers `restartOnError`. A `set_property` against a missing element name therefore tears the live pipeline down (see VideoPlayerModule nov-guard fix). Plan: split Python emissions into `bus_error` (fatal — keep restart) vs `command_error` (non-fatal — log + propagate as RPC failure), update GstRunner.handlePythonEvent to only schedule a restart on `bus_error`. Every plugin doing live property control is one stale element name from the same regression.

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
- [x] HLS Player plugin (hls-pipe submodule) — pulls HLS → MPEG-TS, auto-detects audio/subtitle languages from the playlist, multi-language inline mux + inline WebVTT subtitles, ABR + live-latency controls (built + unit-tested; live-stream verification pending)
- [x] HLS Player review fixes — URL-clear stops the runner, pacing re-anchors after stalls, crash-loop visibility (shared `spawnRunnerProcess` health wiring, also rist-in/out), serialized live URL updates; `PacedUdpTsSink` moved into the engine; structural `SegmentSink` in hls-pipe
- [ ] MPEG-TS muxer/demuxer plugins revamp that it detect the input streams and make outputs acordingly
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
- [x] Restart module while engine stopped no longer starts a dormant module
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
