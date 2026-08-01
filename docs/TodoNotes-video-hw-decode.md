# TODO — Video player: display path, performance & hardware decode (v2.0)

Companion to `TodoNotes.md`. Open items only, distilled from the 2026-07-24/25
field test and the 2026-08-01 instrumented sessions on the field Pi 4
(`ivan-test.mediarouter.org`). Full investigation history lives in the git log
of `media-router-yocto` branch `feat/video-player-dynamic-surface` (the former
`docs/video-player-display-handover.md`).

**Where we are:** 1080p50 H.264 plays hardware-decoded, zero-copy on a vc4
overlay plane (no GL in the video path), at **~37 fps presented / 50 decoded**;
video-player runner CPU is **0.24 core** (decode+display dominate). Direction
decided: stay on weston — kmssink is last-resort only (it complicates output
routing and the LCP display, which is why weston is there).

## Performance — frame rate (the 37 → 50 fps gap)

- [ ] **waylandsink commit pacing (gst-level) — the main fps lever.** The sink
      commits only on frame callbacks; weston dispatches callbacks at repaint
      start, so any callback→commit slip past the cycle boundary drops a whole
      vblank (measured: commits cluster at vblank+5.6 ms; repaint loop idles
      40–120 ms in `exit_loop` during misses; sink discards the excess —
      `rendered`/`dropped` ≈ 37/13 fps). Ruled out: runner priority,
      repaint-window in both directions (5 worse / 15 best / 18 equal),
      overdraw, GPU clocks. Fix directions: commit a staged buffer without
      waiting for the callback when one is due, or pace commits to the
      presentation clock.
- [ ] **weston patch (alternative/complement, upstreamable):** dispatch frame
      callbacks at flip-completion instead of repaint start — widens every
      client's turnaround budget to a full cycle and removes ~20 ms latency
      (cog included).
- [ ] **Productize `[core] repaint-window=15`** — validated on the field
      device (GL clients 25→50 fps; hand-set in `/data/weston.ini` there
      ONLY). Belongs in `device-startup.sh`'s weston.ini creation/migration
      (media-router-yocto).

## Performance — CPU (runner now 0.24 core; remaining targets)

- [ ] **unixfdsink ingest coalescing (relay → mr-tssplit edge).** The relay
      still pushes ~692 unbatched buffers/s (per-RTP ~1.3 KB) into
      mr-tssplit's ingest; symmetric fix to `ae748f68` (mr-tssplit fanout
      coalescing, 692→39 buf/s), implemented inside the
      `0001-unixfdsink-never-block-slow-consumer-kick.patch` the yocto layer
      already carries: accumulate to `BUFFER_BYTES` (24 KB) or 20 ms before
      memfd+send. Needs a gstreamer1.0-plugins-bad rebuild — ride along with
      the SAND image build. Expected: most of the relay's non-librist cost
      (~0.16 core) plus mr-tssplit receive overhead.
- [ ] **librist `rist-reader` thread: 0.27 core.** Library-internal cost of
      RIST receive; investigate librist config (profile, reorder buffer,
      crypto) before considering upstream work. Lowest priority of the CPU
      items.

## Hardware HEVC (blocked on the SAND image build)

- [ ] **Build & flash oswald's `feat/video-palyer-add-hevc-support` yocto
      branch** (SAND patches for gst-plugins-bad/-base). Gate list on a
      device, in order:
      1. decode proof: `/data/test-media/hevc-720p50.ts` (on the field
         device; regenerate with ffmpeg/libx265, 4 s testsrc2 720p50 TS) must
         reach EOS via `v4l2slh265dec` with user CPU ≪ clip length — on stock
         libs it fails `not-negotiated` in 0.22 s;
      2. live HEVC through the video player;
      3. **do SAND/NC12 dmabufs keep the overlay-plane path?** vc4 planes
         support SAND natively, but weston must accept the Broadcom SAND
         modifier for plane placement — else HEVC decodes but falls to a GL
         path that cannot sample SAND;
      4. re-probe GPU DVFS (`meta-custom/scripts/vcprobe.py`) — see platform
         items below.
- [ ] **Until then: H.264-only routing to Pi 4 players** (policy, not code).
      Software HEVC is NOT a fallback: measured 6.7 core-s for a 4 s 720p50
      clip — not realtime even at 720p.
- [ ] **Ship the `v4l2slh265dec` rank mask**
      (`GST_PLUGIN_FEATURE_RANK=v4l2slh265dec:0` in the engine unit env) until
      the SAND gate passes: the decoder registers at rank 257 and decodebin3
      has no fallback, so any HEVC stream error-loops today. The field device
      has NO mask installed. Remove once SAND is proven.
- [ ] Pi 5 characterization before making rank/routing per-machine: Pi 5 is
      the inverse of Pi 4 (H.265 hw only, no H.264 hw — FDS §2065).

## Platform / image (media-router-yocto)

- [ ] **Boot-partition coherence (the original F1).** Kernel/DTB/firmware must
      ship as a matched set and be stamped+audited; OTA covers rootfs only, so
      boot partitions drift silently by provisioning date. The
      `rpi-bootfiles.bbappend` 20241220 pin predates the 6.12 kernel; unpin
      globally and regression-check the two DSI devices (Pi 4 + Touch Display,
      Pi 5 + Touch Display 2).
- [ ] **GPU DVFS broken on the field device**: v3d/h264/isp/hevc pinned at
      their 250 MHz idle floor under full load (likely a firmware/DTB
      mismatch symptom). `force_turbo=1` is the interim on `.108`. Re-probe
      after the boot-coherence fix; `vcprobe.py` is the tool (the image ships
      neither vcgencmd nor debugfs — consider adding vcgencmd to the image).
- [ ] **Bake the validated display config into the image**: `cma-128` on the
      vc4 overlay + `gpu_mem_1024=76` (both field-validated — the 512 MiB CMA
      default silently falls back to 6 MiB and crash-loops weston;
      `gpu_mem_1024=396` steals ~320 MB unused under KMS). Pi 4 conf has
      `disable_fw_kms_setup=1` already; mirror CMA decisions on Pi 5 after
      measuring there.
- [ ] **CI decode-proof gate** in the image build: a generated HEVC/H.264 TS
      must decode to EOS with bounded CPU — device-node presence proves
      nothing (every failure in this saga was silent at the file-exists
      level).
- [ ] **Observability debt on kiosk hosts**: engine stdout doesn't reach
      journald (unowned bug — a `/tmp/engine.log` drop-in is the field
      workaround); mask getty on the compositor VT (keypress steals the
      display); image lacks vcgencmd/debugfs.
- [ ] RAUC rootfs slot margin: re-check the 4 GiB fit when the SAND gstreamer
      lands (`IMAGE_OVERHEAD_FACTOR` is pinned tight).

## Smaller app follow-ups

- [ ] renderWatch expected-fps fallback: streams without VUI timing negotiate
      `framerate=0/1` and the watch stays silent; fall back to the ts-probe
      (`videoinfo`) framerate.
- [ ] Fallback-card sizing under the source-sized live path (the accepted risk
      in `buildLivePipeline`): fallback should inherit the last live surface
      so kiosk-shell's same-size rule can't reject a live↔fallback
      transition across a resolution change. Add a test for that transition.
- [ ] Pi 5 / Intel app-behaviour smoke test before the next release: the app
      ships to all machines via rootfs OTA regardless of the Pi 4-scoped
      platform work (headless guard, compositor gate, surface path).
