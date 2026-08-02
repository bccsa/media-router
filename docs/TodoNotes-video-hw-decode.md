# TODO — Video player: display path, performance & hardware decode (v2.0)

Companion to `TodoNotes.md`. Open items only, distilled from the 2026-07-24/25
field test and the 2026-08-01 instrumented sessions on the field Pi 4
(`ivan-test.mediarouter.org`). Full investigation history lives in the git log
of `media-router-yocto` branch `feat/video-player-dynamic-surface` (the former
`docs/video-player-display-handover.md`).

**Where we are (2026-08-01, end of session):** 1080p50 H.264 plays
hardware-decoded, zero-copy on a vc4 overlay plane, **smooth at a flat
50 fps** (paced presentation, now the default), runner CPU **0.26 core**.
Direction decided: stay on weston — kmssink is last-resort only (it
complicates output routing and the LCP display, which is why weston is there).
**Every fix was validated on ONE Pi 4 field device — see the cross-machine
validation gate below before concluding any of it.**

## Performance — frame rate — SOLVED at the sink; smooth-mode designed

- [ ] **GATE: Pi 5 + Intel validation before concluding the display fixes.**
      Everything below was verified on a single Pi 4 (vc4, hw H.264 decode),
      but ALL of it ships fleet-wide: the waylandsink 0007 patch via the
      shared gst-plugins-bad bbappend (all machine images), and the app-side
      changes (sync default ON, tsparse-conditional chain, batching, F13/F19
      fixes) via rootfs OTA. Machine-specific risks to test explicitly:
      1. **waylandsink 0007 on other display stacks** — Pi 5 (rp1 DSI +
         vc4-class HDMI) and Intel (i915) have different buffer-release and
         flip timing than the path the deadlock analysis was done on; soak
         each (the v1 deadlock took <1 s to appear on dmabuf, so a short
         soak is meaningful, but include an SHM/software-decode source).
      2. **`sync=true` default with SOFTWARE decode** — Pi 5 has no H.264
         hw decode; paced presentation with 30-80 ms software decode times
         against PTS deadlines is the exact `max-lateness` scenario the
         buildSink notes warn about, and it was previously default-OFF
         there. Watch renderWatch and visual cadence; if it misbehaves the
         per-machine answer may be different defaults.
      3. Batching (busBatchMs 20) + tsparse-conditional chain on each
         machine's relay/consumer topology.
      Until this gate passes, the fixes are "validated on Pi 4", not
      "concluded".

- [x] **Smooth mode VALIDATED on Pi 4 (2026-08-01).** With "Honour buffer PTS" on:
      operator confirms smooth playback; weston timeline shows a flat 50
      flips/s with skipped vblanks 12.2/s → 2.2/s (the floor is the
      source-vs-display clock drift beat, ±1 vblank, imperceptible). Runner
      cost 0.26 core — tsparse on the BATCHED bus costs ~0.02 core (vs 0.11
      unbatched: its price was per-buffer overhead), so pacing is nearly
      free and the batching + pacing changes compose. DECIDED 2026-08-01:
      `sync` defaults ON (knob kept as the ultra-low-latency / degraded-PCR
      escape hatch — see the DEPLOY NOTE in TodoNotes.md). Latency measured:
      frames arrive at median ~0-1 ms before their presentation deadline, so
      pacing adds ~nothing at the median and up to a few tens of ms of
      per-frame jitter smoothing. Original item, for context: With `sync=false`
      nothing paces frames — arrival jitter reaches the compositor and
      latest-wins latching turns it into ~12 skipped vblanks/s (measured;
      independent of bus batching at 0/10/20 ms). The designed fix is live on
      the field device: enabling the module's existing **"Honour buffer PTS"
      (`sync`) toggle** now rebuilds the chain with
      `tsparse set-timestamps=true` (clock-anchored per-frame timestamps —
      the long-shipped HLS pacing recipe) and the sink presents each frame on
      time. Traced: unixfdsrc converts bus wire timestamps to running time,
      tsparse re-anchors per-frame from PCR. Costs the 0.11-core tsparse only
      while enabled; adds up to `bufferMs` of pacing latency. TO VALIDATE:
      flip the toggle in the manager UI, eyeball smoothness, capture a weston
      timeline histogram (expect skipped vblanks ≈ 0); consider making it the
      recommended default for playout if latency permits.

- [x] **waylandsink commit pacing — FIELD-VERIFIED at 50 fps.** Live 1080p50:
      arrivals == presented == ~50 fps, dropped == 0, RSS flat over a soak
      (was ~35/15). Patch v3 is deadlock-hardened: v1 hit an AB-BA between
      `window_lock` and the display thread's `sync_mutex` (held across
      callback dispatch) — syncs are now created strictly outside
      `window_lock` with a `commit_scheduled` flag closing the early-fire
      race. Hand-built on the Pi 5 dev box against 1.28.2 and deployed on the
      field device (`/data/gst-backup` holds stock; any OTA also reverts).
      REMAINING: ships permanently via the image build (patch 0007 in the
      gst-plugins-bad bbappend). Original item, for context: `0007-waylandsink-commit-staged-buffers-without-waiting-fo.patch`
      in media-router-yocto's gst-plugins-bad bbappend (applies after the SAND
      series): staged buffers get an immediate display-thread commit instead
      of parking behind the compositor's frame callback — the measured cause
      of the 35 fps ceiling (commits clustered at vblank+5.6 ms, repaint loop
      idling 40–120 ms in `exit_loop`, sink discarding the excess; ruled out:
      runner priority, repaint-window both ways, overdraw, GPU clocks). Also
      fixes a latent teardown use-after-free (frame callback pointer
      overwritten while armed). Rides the SAND image build together with the
      unixfdsink ingest coalescing below; verify with renderWatch — expect
      presented ≈ repaint rate (~50) and sink drops ≈ 0, and re-check the
      `repaint-window=15` choice afterwards (with per-buffer commits the
      15 ms window may no longer matter for the video path).
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
- [ ] **RT scheduling for audio/streaming threads (image).** PipeWire's
      processing threads and librist's data-output thread run without RT
      priority on the yocto image (librist logs "Failed to set data output
      thread to RR scheduler"; no rtkit / RLIMIT_RTPRIO for the mrstation
      user). On a 50-60 %-loaded Pi 4 that scheduling jitter is why the
      paced audio sink needs ~170 ms of pacing margin to avoid xruns
      (field 2026-08-02: 100 ms ring + 250 ms offset still xruns ~1/3 min).
      An RLIMIT_RTPRIO/rtkit fix shrinks jitter for every audio consumer at
      once and would let syncOffsetMs come back down.
- [ ] **librist `rist-reader` thread: 0.27 core.** Library-internal cost of
      RIST receive; investigate librist config (profile, reorder buffer,
      crypto) before considering upstream work. Lowest priority of the CPU
      items.

## Hardware HEVC — WORKING via hand-deployed SAND stack (2026-08-01)

The full SAND set (base 0001 + bad 0002–0007, incl. the pacing patch — all
seven apply and build together cleanly) was built natively on the Pi 5 dev
box against 1.28.2 and hand-deployed on the field Pi 4 (stock in
`/data/gst-backup`; libgstvideo swapped atomically). Gate results:
1. [x] **Decode proof PASSES**: 4 s 720p50 HEVC → EOS in 1.0 s wall,
       **0.73 core-seconds total** (software: 6.7) — hardware decode on the
       hevc block, `Selected format NV12_128C8 DRM NV12:SAND128`.
       **Test-recipe gotchas (bake into the CI gate):** a bare `fakesink`
       CANNOT prove SAND decode — upstream v4l2codecs hides DRM formats
       from ANY-caps peers (`static_src_caps_no_drm`), and post-0006 SAND
       is DRM-only; a capsfilter alone still fails on the mandatory
       VideoMeta in decide_allocation. Use `… ! v4l2slh265dec !
       fakevideosink sync=false` (advertises all metas + any caps-features).
2. [ ] **Live HEVC through the player: FAILS — two distinct blockers found
       when the OCC feed switched to H.265 (2026-08-01 evening):**
       a. **1080p SAND hardware decode hangs — SEVERITY: CAN FREEZE THE
          ENTIRE DEVICE.** After the player retried 1080p HEVC decode for a
          while, the field box hard-hung: frozen last frame on screen,
          network down, power-cycle required (operator-confirmed,
          2026-08-01 evening). A wedged rpivid/V4L2 decode job apparently
          takes the kernel with it — treat as critical, not just a decode
          failure. Boot-time evidence is lost (no persistent journal on the
          image — see observability debt). INTERIM GUARD on the field box:
          `media-router.service.d/hevc-mask.conf` sets
          `GST_PLUGIN_FEATURE_RANK=v4l2slh265dec:0` so the patched decoder
          is never auto-selected (explicit test pipelines can still use it
          for repro work); the hand-patched dist was restored to the built
          decodebin3 chain. The decisive bisect:
          synthetic 720p50 decodes perfectly (1.0 s wall, 0.73 core-s);
          synthetic 1080p50 AND a captured 10 s OCC sample
          (`/data/test-media/occ-hevc-sample.ts`, Main@L4.1 1080p50
          B-frames) hang the device with `Decoding frame 2 took too long
          [v4l2slh265dec]`. Resolution-dependent, content-independent —
          suspects are the resolution-scaled math in 0003 (absolute bit
          size) / 0004 (slice-header offset) or SAND stride/column count at
          1920 (15 cols vs 10). Repro assets on the device:
          `hevc-720p50.ts` (passes) vs `hevc-1080p50.ts` (hangs) — for
          oswald.
       b. **decodebin3 never plugs the SAND decoder** (hangs inside
          `db_output_stream_setup_decoder` with parsebin-fixated
          `stream-format=hvc1` caps; direct `h265parse ! v4l2slh265dec`
          works) — confirmed uncontended with file input, sink-independent.
          Needs either a decodebin3-level fix or a codec-aware pipeline
          builder in the video player (probe codec via tsProbe, build the
          explicit parse+decoder chain, restart on codec change — decodebin3
          reuse was for same-codec ABR switches, which the bus path doesn't
          have).
       INTERIM on the field device: the deployed video-player dist is
       HAND-PATCHED to the direct HEVC chain (`decodebin3` →
       `h265parse ! v4l2slh265dec` in dist/helpers/pipelines.js) — HEVC-only
       and moot until (a) is fixed; the player shows the SMPTE fallback on
       the current HEVC feed. **Recommend switching the OCC feed back to
       H.264 for production until the 1080p SAND hang is fixed** (H.264 path
       is fully validated at 50 fps smooth).
3. [x] **SAND keeps the overlay plane**: weston places the NC12/SAND128
       dmabuf on overlay plane 125 (`FORMAT: NV12` in the atomic commits;
       no GL fallback, which could not have sampled SAND). Visual
       confirmation of no chroma corruption = the 0006 single-object fix
       doing its job (operator eyeball still advised).
4. [ ] DVFS re-probe after boot-coherence fix (unchanged; `force_turbo=1`
       still masks it on the field device).
- [ ] **Image build remains the delivery vehicle** — the hand-deploy proves
      the exact artifact set oswald's branch + patch 0007 will produce.
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

- [ ] **`clockSync` freezes on the first frame — epoch mismatch (diagnosed
      2026-08-01).** With clockSync the chain deliberately passes source PES
      timestamps through (`tsparse set-timestamps=false`) to share the A/V
      timeline — but nothing maps the source epoch onto the shared clock's
      running time, so the sink schedules the first frame at the raw PES
      epoch (measured: 19.2 HOURS in the future) and waits. Structural, not
      a regression: the pre-branch chain had the same shape. Needs the
      engine's epoch/timeline-latch machinery (see `preserveSourceTimeline`
      / the epoch-consistent latch work) wired into the video player's live
      description, and clarity on whether the feature assumes a paired
      audio-decoder pipeline that establishes the shared epoch. Until then:
      leave the toggle OFF; with `sync` now defaulting ON, plain paced
      playback covers everything except cross-pipeline lipsync.

- [ ] renderWatch expected-fps fallback: streams without VUI timing negotiate
      `framerate=0/1` and the watch stays silent; fall back to the ts-probe
      (`videoinfo`) framerate.
- [x] renderWatch source-shortfall attribution (2026-08-01/02): the
      intermittent "can only do 41 fps" warning on the OCC H.264 feed was NOT
      render lag — per-window counters showed arrivals == presented,
      dropped == 0: the sink presents everything that arrives. Runner now
      reports `arrivalsFps` in renderwatch events; when achieved ≈ arrivals
      the module warns "Stream under-delivering — check the source/link"
      instead of the (wrong for this case) lower-the-resolution advice.
- [ ] OCC feed delivery dips — root cause still open (2026-08-02 field
      forensics, ~9 h of 4-point instrumentation on .108: wire/librist →
      relay → tssplit → sink):
      * The RIST WAN link runs recovered-loss storms in production hours
        (10–20 % missing, RTT ~210 ms, librist recovers ~100 %, `lost=0`) —
        which is exactly why ad-hoc link checks always came back "innocent":
        only UNRECOVERED loss is visible without stats. A 130 missing/s storm
        was absorbed cleanly (presented 97–101) by the 5 s buffer, so
        moderate storms alone don't explain the warnings; worse storms might.
      * Overnight there are shallow dips (presented 85–92 %, below warning
        threshold) on a wall-clock grid (~:10/:40 s, gaps of exactly
        60/300/600/1500 s) with NO wire dip, no discontinuities, no catch-up
        burst, fanout `drops={}`. Origin unidentified (not cron, not engine
        event-loop stalls — both phase-checked). A genuine warning episode
        has not yet been caught with full instrumentation; RWX (sink windows)
        + RSX (librist stats) diagnostics left ACTIVE on .108's deployed
        runner for the next occurrence (revert = redeploy engine dist).
      * TODO: surface librist quality/missing/recovered in the rist-input
        module's health/status so recovered-loss storms are operator-visible.
        → DONE 2026-08-02 (Loss % field + hysteresis health warning).
      * Related incident (2026-08-02 09:10): an 832 ms WAN blackout made
        librist delete+recreate the flow; the runner's rist-reader thread
        exited on the transient read error (-3) and never drained the new
        flow's fifo ("Rist data out fifo queue overflow") — relay wedged
        until a module restart, downstream ts-splitter "no input data".
        Fixed: read loop now retries through RistError instead of breaking.
        The video player resumed from its watchdog fallback with corrupted
        decoder state (green band + ~10 late-drops/window) that persisted
        until an engine restart. ADDRESSED (2026-08-02, three parts):
        resume now waits for 3 consecutive flowing polls before rebuilding
        live (no rebuild against a churning source); render_lag treats
        sustained sink drops (>5 % of expected) as lag even when presented
        fps sits inside the hysteresis band (the degraded state was 0.88 —
        silent for 5 min); and a renderwatch lag within 120 s of a
        stall-resume triggers ONE automatic rebuild. Field repro of the
        original corruption is still outstanding (needs an upstream stall
        >5 s — SIGSTOP repro was not possible in-session).
      * CAUTION (measurement hazard): per-buffer Python pad probes on
        packet-sized buffers (~750/s × 2 pads) overloaded the relay on a
        Pi 4 under storm load (relay 0.07 → 1.6 cores, presented collapsed
        to 30–80) — probe per-frame or per-batch points only.
- [ ] Fallback-card sizing under the source-sized live path (the accepted risk
      in `buildLivePipeline`): fallback should inherit the last live surface
      so kiosk-shell's same-size rule can't reject a live↔fallback
      transition across a resolution change. Add a test for that transition.
- [ ] Pi 5 / Intel app-behaviour smoke test before the next release —
      SUPERSEDED in scope by the cross-machine validation GATE at the top of
      this file (which now also covers the display fixes); the original
      smoke-test list (headless guard, compositor gate, surface path) still
      applies as part of that gate.
