# Hardware Setup Recommendations

Deployment-environment requirements for Media Router hosts. Written for
whoever prepares the OS image / boot firmware for target devices; everything
here is application-agnostic and applies regardless of how the image is built.

Tested on: Raspberry Pi 4 Model B (2 GB) and Raspberry Pi 400 (4 GB),
64-bit Linux 6.12, GStreamer 1.28, KMS graphics (`vc4-kms-v3d`). The
principles (CMA sizing, hardware-codec throughput) carry to other SBCs, but
the numbers below were measured on this family.

---

## 1. Video memory (CMA)

KMS graphics and the hardware video codecs allocate their buffers from the
kernel's **CMA pool** (`CmaTotal` in `/proc/meminfo`) — scanout framebuffers,
decoder reference frames, and hardware-scaler queues all live there. If the
pool is too small, the compositor cannot allocate even one framebuffer and
crash-loops (`DRM_IOCTL_MODE_CREATE_DUMB failed: Cannot allocate memory`,
followed by a segfault), which presents as "no video output" / "video player
never starts".

### Why the default cannot be trusted

The stock device tree requests a 512 MiB CMA pool, which must be placed in
the DMA zone (below 1 GB) as one contiguous block. Whether that succeeds
depends on what else lands in that window — legacy GPU-memory carve-outs
(§3), kernel image placement (randomized each boot when KASLR is enabled),
and other early reservations. **The same image can succeed on one board and
fail on the next.** When it fails, the kernel logs one line and falls back to
a 6 MiB pool:

```
OF: reserved mem: failed to allocate memory for node 'linux,cma': size 512 MiB
cma: Reserved 6 MiB at 0x...
```

6 MiB cannot hold a single 1080p framebuffer (~8.3 MiB), so graphics are
dead on that boot. Observed in the field on multiple boards.

**Request a size that always fits instead of a large one that sometimes
fits.** In Raspberry Pi firmware terms (`config.txt`):

```ini
# Video output + hardware decode of one 1080p50 stream, with margin:
dtoverlay=vc4-kms-v3d,cma-128

# Headless host that only hardware-decodes/encodes (no display):
dtoverlay=vc4-kms-v3d,cma-96

# Multiple concurrent decodes, 4K output, or future headroom:
dtoverlay=vc4-kms-v3d,cma-256
```

### Measured CMA budget (1080p50 H.264, hardware decode)

| Consumer | CMA used |
|---|---|
| One hardware H.264 decode session (1080p) | 9–12 MB |
| Decode + hardware scaler (ISP) session | 31–39 MB |
| Two concurrent decode+ISP sessions | 63 MB |
| Compositor scanout, 1080p output (2–3 buffers) | 17–25 MB |

So `cma-128` covers a display plus a 1080p50 decode with >2× margin;
`cma-96` covers dual headless decode sessions. Values are per the supported
overlay steps (64/96/128/192/256/320/384/448/512).

**CMA is not subtracted from usable RAM.** While DMA isn't using it, the
kernel lends CMA pages to ordinary movable allocations and reclaims them on
demand — `MemTotal` is unaffected by the CMA size, and a low `CmaFree` under
memory pressure is normal borrowing, not exhaustion. The only true failure
signal is `cma: … alloc failed` in `dmesg`.

### Verification (run on every new image/board)

```sh
grep Cma /proc/meminfo          # CmaTotal must match the configured size
dmesg | grep -iE "cma|reserved mem" | head   # no "failed to allocate"
dmesg | grep -c "alloc failed"  # 0 during/after video playback
```

---

## 2. Legacy GPU memory split (`gpu_mem`)

`gpu_mem` / `gpu_mem_1024` carve memory out of the low DMA zone for the
legacy VideoCore firmware allocator. **Under KMS graphics
(`vc4-kms-v3d`) this memory is unused** — KMS allocates from CMA — but the
carve-out still shrinks the window the CMA pool must fit into, and it is
subtracted from `MemTotal` outright.

Observed misconfiguration: `gpu_mem_1024=396` reserved 396 MB that nothing
used, reduced usable RAM by ~320 MB, and shrank the low zone enough to make
the 512 MiB CMA request fail (§1) — a double loss.

**Recommendation: leave `gpu_mem` at the platform default (76 MB on this
family); never raise it on a KMS system.** Only legacy camera/display stacks
(`start_x`, firmware graphics) need more, and Media Router uses neither.

```ini
gpu_mem_1024=76
```

---

## 3. Hardware codec & scaler throughput

Measured on Pi 400 @ stock clocks, GStreamer 1.28, dense 8.6 Mbps 1080p50
H.264 stream:

| Path | Throughput | CPU cost |
|---|---|---|
| Hardware H.264 decode (`v4l2h264dec`), 1080p | ~62 fps | low (~0.9 core·s per 100 frames incl. demux) |
| Hardware convert/scale (ISP, `v4l2convert`), 1080p in | **~46 fps ceiling** | ~zero |
| Software convert+scale actively resizing 1080p→720p | ~25 fps | very high (2.6× decode cost) |
| Software convert+scale at **matched** in/out size | ~60 fps | ~zero (elements pass through) |

**HEVC is a special case — read this before planning any H.265 stream.**

- The HEVC hardware block (`rpivid`) is separate from the H.264 decoder and
  appears as `/dev/video19` (`rpi-hevc-dec`) — but only when the boot
  partition's device tree matches the kernel. The node's compatible string
  was renamed upstream (`raspberrypi,rpivid-vid-decoder` →
  `raspberrypi,hevc-dec`); a kernel updated without its own DTBs silently
  loses the decoder (no error anywhere — the device just never appears).
  **Ship kernel, DTBs and overlays from the same build, always.**
- Even with the device present, **stock upstream GStreamer (≤1.28) cannot
  use it**: the block emits column-tiled (SAND) frames that
  `v4l2slh265dec` fails to negotiate (`Unsupported pixel format`). Hardware
  HEVC via GStreamer requires a vendor-patched GStreamer (SAND/NV12
  column-format support) or an ffmpeg-based decode path. Do not assume
  "device exists" = "pipeline uses it" — validate with a real decode run.
- Measured software fallback (`avdec_h265`, 4 threads, Pi 400): a dense
  8-bit 1080p50 broadcast stream decodes at **~32 fps using ~2.5
  core-seconds per second** — not sustainable, and on a loaded box it
  starves the sink of keyframes (grey frames with motion smear). Plan
  software-decoded HEVC at **≤720p50**, or use H.264 (hardware-decodable
  today) for full-HD player endpoints.
- OTA update schemes that replace only the root filesystem preserve
  whatever the boot partition was provisioned with — two devices at the
  same application version can differ in codec availability. Audit and
  version the boot partition as part of the image, not just the
  application.

Planning rules that follow:

- Hardware 1080p decode sustains 50 fps with ~20% margin. Two concurrent
  1080p50 decodes exceed the decode block's budget — don't plan on more than
  one full-rate 1080p50 stream per device.
- **Do not place the ISP converter in a ≥50 fps path.** ~46 fps at 1080p is
  a hard ceiling regardless of output size or format; it is fine for ≤30 fps
  content or off-rate work.
- Software convert/scale elements are free **only when input equals output**
  (GStreamer passthrough). Render surfaces should therefore match the source
  format wherever possible (§5) — an application that forces a fixed
  off-size surface turns these elements into the most expensive stage of the
  pipeline.

---

## 4. Displays

- **Match rendered surfaces to the display's native mode.** Rendering at a
  fixed lower resolution and letting the compositor upscale wastes CPU twice
  (active software downscale + GPU upscale) and loses resolution. The
  display's preferred mode is line 1 of
  `/sys/class/drm/card*-<connector>/modes`.
- **Writeback connectors are not displays.** `card*-Writeback-*` reports
  `connected` with a large preferred mode (4096×2160 observed) on headless
  boards; anything enumerating outputs must skip it or it will size buffers
  for a 4K display nobody can see.
- **Do not run a login console (`getty`) on the kiosk compositor's VT.**
  Both claim the same virtual terminal; any keypress on an attached keyboard
  (on keyboard-integrated devices, the device itself) can hand the VT to the
  console — the compositor's seat session pauses, the screen shows a login
  prompt, and the compositor floods the log with
  `atomic: couldn't commit new state: Permission denied` until the VT
  returns. Disable the getty on that VT in the image, or move the compositor
  to a dedicated VT.
- **Headless hosts should not run the kiosk compositor.** With no connected
  display the compositor exits and the service manager respawns it
  indefinitely (observed: a restart every ~80 s, thousands per day) —
  pointless churn on a box doing real-time media work. Disable the
  compositor service on relay/headless roles.
- An unplugged HDMI cable does not always read `disconnected` — powered-off
  displays and extenders can hold hotplug asserted. Verify with the `status`
  file, not by assumption.
- **Verify the EDID actually reads.** A bad cable/adapter (or a display that
  mishandles DDC) yields an empty EDID; the kernel then falls back to the
  VESA safe modes and drives the panel at **1024×768 (4:3)** — 16:9 content
  gets letterboxed and the picture looks like a wrong-aspect bug when it is
  a cabling fault. Check with:

  ```sh
  wc -c /sys/class/drm/card*-<connector>/edid    # 0 bytes = EDID not read
  cat /sys/class/drm/card*-<connector>/modes     # only VESA modes = fallback
  ```

---

## 5. Quick health checklist for a new device

```sh
# hardware codecs present
ls /dev/video10                               # want: exists (H.264 decode)
ls /dev/video19                               # want: exists (HEVC block; see the
                                              # HEVC caveats above — presence does
                                              # not mean GStreamer can use it)

# per-codec decode PROOF (device presence is not enough) — must reach PLAYING
# and hit EOS with user CPU time well under the clip duration:
# gst-launch-1.0 filesrc location=<test.ts> ! tsparse ! tsdemux ! h264parse \
#   ! v4l2h264dec ! fakesink sync=false

# video memory
grep CmaTotal /proc/meminfo                   # want: matches configured cma-<N>
dmesg | grep "failed to allocate memory for node 'linux,cma'"   # want: no output
dmesg | grep -c "alloc failed"                # want: 0 during/after video playback

# graphics stack
systemctl status <compositor>.service         # active, restart counter 0 (display hosts)

# throughput sanity (a healthy board completes this in <6 s of user CPU;
# a large regression on identical hardware means the board is throttling —
# check power delivery and cooling)
time gst-launch-1.0 -q videotestsrc num-buffers=300 \
  ! video/x-raw,width=1920,height=1080 \
  ! x264enc speed-preset=ultrafast ! fakesink
```
