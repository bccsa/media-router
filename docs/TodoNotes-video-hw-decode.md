# TODO — Video player hardware decode & display pipeline (v2.0)

Companion to `TodoNotes.md`; findings and follow-ups from the
`feat/video-player-dynamic-surface` field test (2026-07-24/25, two Pi 400
test devices, one live-relay + player, one player-only).

**Status: the branch is NOT PR-ready.** The code is complete and
unit-tested (1955 TS tests + 19 python self-checks), and every behaviour was
exercised on real hardware — but the platform underneath it has defects
(below) that an OS/image update must fix first, and the branch must be
re-tested on that updated OS before the PR.

---

## What the branch changes (recap)

- **Surface follows the display's preferred mode** instead of hard-coded
  1280×720 (`resolveConnectorMode`/`firstConnectedDisplay`). Measured on
  hw-decoded 1080p50: fixed-720p forced an active software scale — 25 fps
  ceiling at 2.6× decode CPU; matched surface puts videoconvert/videoscale
  into caps passthrough — 57–60 fps at ~zero cost. (The ISP `v4l2convert`
  was tried and reverted: hard ~46 fps ceiling at 1080p regardless of
  output size — it can never sit in a 1080p50 path.)
- **Headless guard** — DRM present but no connected physical output → no
  pipeline + health `error` instead of a sink error-loop; recovers on
  hotplug via the wayland-session watcher.
- **Compositor gate** — hosts with waylandsink installed never fall back to
  kmssink (it steals DRM master and fights the compositor's startup;
  observed after display hotplug as video flashing over the console then
  vanishing). Waiting state has its own health message.
- **renderWatch** — runner-side keep-up monitor (`render_lag.py`): sink-pad
  frame rate vs caps-declared framerate, hysteresis 0.85/0.95 ×3 windows,
  post-start zero-frame windows count as lag (starvation is lag, not
  stall). Surfaces in the manager UI as
  *"Video output can't keep up (a/b fps) — lower the stream or display
  resolution"*. Validated end-to-end on a starving software-HEVC pipeline.

## Platform findings (what the OS/image must fix)

### 1. Boot partition incoherence → HEVC decoder silently absent

- Kernel 6.12 renamed the HEVC decoder's DT compatible
  (`raspberrypi,rpivid-vid-decoder` → `raspberrypi,hevc-dec`). Devices
  whose boot partition carries kernel 6.12 (May 2026 build) with DTBs from
  the 2024-12-20 bootfiles set have a node the driver never matches:
  `/dev/video19` never appears, **zero errors anywhere**.
- The OTA updater covers rootfs slots only — boot partitions drift by
  provisioning date. Three same-app-version devices had three different
  boot states (one with working `rpi-hevc-dec`, two without).
- Temporary fix applied to one test device (backups in
  `/data/bootfw-backup-20241220/`): firmware release **1.20260521**
  `start4.elf` + `fixup4.dat` + `bcm2711-rpi-400.dtb` + used overlays
  (`vc4-kms-v3d.dtbo`, `gpio-fan.dtbo`). After reboot the node matches and
  `/dev/video19` auto-registers.
- **Build requirement:** ship kernel + DTBs + overlays from the same kernel
  build, with a matched firmware pair; include the boot partition in the
  update/versioning story (or stamp + audit it).

### 2. GStreamer cannot use the HEVC block (even when present)

- The `rpivid` engine outputs **column-tiled (SAND / NC12,
  `NV12MT_COL128`) frames**. GStreamer 1.28.2's `v4l2slh265dec` fails:
  system-memory path → `Unsupported pixel format`; DMABuf path to
  waylandsink → `Failed to configure the buffer pool` (format negotiates,
  pool config doesn't — consistent with partially-landed support).
- Upstream state: v4l2codecs SAND support MR exists and passes 142/147 of
  the JCT-VC HEVC conformance suite; `NV12MT_COL128` is in v4l2-core; the
  driver itself is upstreamed.
  - https://discourse.gstreamer.org/t/v4l2codecs-feasibility-of-adding-support-for-raspberry-pi-hevc-sand-formats-nc12-nc30/3522
  - https://lwn.net/Articles/1060711/
- **Build requirement:** a GStreamer new enough to include the completed
  v4l2codecs SAND work (or cherry-pick the MR / carry vendor patches).
  Gate it with a **real decode proof in image CI**: a test HEVC TS must
  reach EOS with user-CPU ≪ clip duration. Device presence proves nothing —
  every failure in this saga was silent at the "file exists" level.

### 3. decodebin3 has no decoder fallback → mask required until (2) lands

- With `v4l2slh265dec` registered (rank 257 > avdec's 256) and broken,
  decodebin3 picks it and the pipeline **dies with no fallback** — HEVC
  playback error-loops instead of degrading to software.
- **Build requirement (interim):** `GST_PLUGIN_FEATURE_RANK=v4l2slh265dec:0`
  in the engine service environment (a user-unit drop-in
  `media-router.service.d/hevc-mask.conf` carries it on the test device).
  Remove when (2) is proven.

### 4. Software HEVC budget (measured, Pi 400 @ stock clocks)

- Dense 8-bit 1080p50 broadcast HEVC via `avdec_h265` (4 threads):
  **~32 fps max, ~2.5 core-seconds per second of stream** — cannot sustain
  50 fps even unloaded; on a loaded box the leaky queues shed keyframes →
  grey frames with motion smear.
- H.264 1080p50 hardware decode (`v4l2h264dec`) works end-to-end today
  (~62 fps, low CPU).
- **Until (1)+(2) land: player endpoints must receive H.264, or HEVC at
  ≤720p50.** This is a routing/feed decision, not code.

### 5. Kiosk platform details (also in
`hardware-setup-recommendations.md`)

- `getty` and the compositor must not share a VT — a keypress (on
  keyboard-integrated devices, any key) hands the display to the login
  console and pauses the compositor (`atomic commit: Permission denied`
  flood). Disable the console getty on kiosk hosts.
- The compositor EACCES flood filled the 64 MB runtime journal and engine
  logs went dark. **Unresolved residual:** engine stdout stopped reaching
  journald and did not recover after journald restart + vacuum + engine
  restarts — needs its own investigation (observability loss on exactly
  the boxes that misbehave).
- Empty EDID (bad cable/adapter) → VESA fallback 1024×768 4:3 → letterbox
  that looks like an aspect bug. Verify EDID bytes at install time.

## Branch follow-ups (before/at PR, after the OS update)

- [ ] **Re-test the full branch on the updated OS** — the PR gate. Includes
      re-running the sw-vs-hw scale benchmarks and the renderWatch
      behaviour with a working hw HEVC decoder.
- [ ] **Surface caps must admit DMABuf** once hw HEVC lands: zero-copy
      SAND→compositor only works if nothing touches pixels — exactly the
      surface==source passthrough case — but today's surface caps pin
      system-memory `video/x-raw`, which would force a download. Extend
      `surfaceCaps()` to offer `video/x-raw(memory:DMABuf)` alongside.
- [ ] **renderWatch expected-fps fallback**: streams without VUI timing
      negotiate `framerate=0/1` and the monitor stays silent by design.
      Fall back to the framerate the ts-probe (`videoinfo`) reports.
- [ ] Consider surfacing `cpuDecodeThreading=frame` as guidance when the
      lag warning fires on a software-decode pipeline (frame-threading
      trades latency for throughput).
- [ ] Journald/engine-logging investigation (see 5).
