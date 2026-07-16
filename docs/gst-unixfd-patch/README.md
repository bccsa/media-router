# gst-unixfd patch for the media-router fleet (GStreamer 1.28.2)

Instructions for the Yocto/CI-CD project. One patch to `gstreamer1.0-plugins-bad`
plus one sysctl requirement. Without this patch the unixfd bus transport
(`MR_BUS_TRANSPORT=unixfd`) is unsafe at scale — see "Why" below.

## What to apply

### 1. Patch `gstreamer1.0-plugins-bad` (1.28.x)

Patch file: `0001-unixfdsink-never-block-slow-consumer-kick.patch` (this directory).
Paths are relative to the `gst-plugins-bad` tarball root (`gst/unixfd/...`).

Add a bbappend, e.g. `meta-custom/recipes-multimedia/gstreamer/gstreamer1.0-plugins-bad_%.bbappend`:

```bitbake
FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"

SRC_URI += "file://0001-unixfdsink-never-block-slow-consumer-kick.patch"
```

and place the patch in `gstreamer1.0-plugins-bad/` next to it.

The patch makes three changes to `gst/unixfd/gstunixfdsink.c` (all marked
`Local patch (media-router)` in the source):

1. **Never block in render — kick slow consumers.** Stock `unixfdsink`
   sends `NEW_BUFFER` commands on BLOCKING client sockets while holding the
   element's object lock. A consumer that stops draining its socket (stalled
   pipeline, preroll, zombie connection) blocks the send forever; because the
   lock is held, the command thread (which accepts clients and drains
   RELEASE_BUFFER messages) can never run, so the producer pipeline freezes
   permanently, and any operation that touches sibling element locks
   (e.g. `gst_bin_add` during a dynamic fan-out attach) deadlocks the
   process's mainloop. The patch checks `G_IO_OUT` before each `NEW_BUFFER`
   send and kicks (disconnects) a client whose socket is full — the client
   reconnects through its own restart path. Measured on gate01: a
   connected-never-reading client froze the producer in seconds; with the
   patch it is kicked with a warning and healthy siblings flow untouched.

2. **4 MB `SO_SNDBUF` on accepted client sockets.** At thousands of
   commands/s the default ~208 KB socket buffer holds well under a second of
   headroom, so a briefly-pausing client (downstream preroll at join) would
   trip the kick. 4 MB gives seconds of headroom so only genuinely hung
   consumers get kicked. **Requires `net.core.wmem_max >= 4194304`** (the
   setsockopt is silently clamped otherwise) — see step 2.

3. **Unlink a stale socket path before bind.** A SIGKILL'd producer leaves
   its socket file behind and the next bind fails EADDRINUSE. Engine
   pipelines restart aggressively, so pre-existing paths are unlinked before
   binding ("last bind wins", matching the previous UDP-bus semantics).

The rest of the media-router 1.24 tree's local unixfd changes (copy-to-shm,
allocator, wait-for-connection, num-clients, partial send/receive loops) are
upstream backports that **1.28.2 already contains — do not port them.**

### 2. sysctl (image-level, must survive RAUC slot switches)

```
# /etc/sysctl.d/60-media-router-unixfd.conf
net.core.wmem_max = 4194304
net.core.wmem_default = 4194304
```

Bake into the image (e.g. a `files/` fragment in the device-manager or base
recipe). Do NOT rely on runtime `sysctl -w` — manual settings are lost on
every RAUC slot switch (this has already bitten twice on gate01).

## Why (short version)

Per-consumer unixfd fan-out gives every listener its own
`tee ! leaky-queue ! unixfdsink <socket>` branch, so a slow consumer should
only shed its own data. Stock 1.28 defeats this isolation: the blocking
send-under-object-lock freezes the producer's whole chain on one bad client
(observed live: ip-input rx_queue pegged at 16 MB, 2.4 M drops, 24-stream
graph dark) and deadlocks bus_attach (`gst_bin_add →
gst_object_check_uniqueness` iterates sibling locks). The engine has runner-
level mitigations (edge-stall watchdog, leaky ingress) but the element-level
fix is the only complete one.

## Validation performed (2026-07-16, gate01, x86-64, gst 1.28.2)

- Patched plugin cross-built and installed over stock (`Version 1.28.2.mr1`),
  full engine restart: graph converged, 0 restarts / 0 errors / 0 edge
  stalls, ip-input clean, audio 0.00 % silence.
- Zombie-client acceptance test: producer at 1500 commands/s, one healthy
  consumer + one connected-never-reading client. Result: exactly 1 kick (the
  zombie), 0 send errors, healthy consumer uninterrupted. Same scenario
  freezes an unpatched sink permanently.
- Note for tests at low ulimits: each in-flight command carries an fd, and
  sends fail (client kicked via the existing error path) when the sending
  user's in-flight-fd quota (RLIMIT_NOFILE) is exceeded — engine services run
  with nofile 524288, so the byte-buffer path (the kick) triggers first in
  production.

## Scope / arch

- The patch is arch-independent C; applies to x86-64 (gate01/.160/.16.20)
  and aarch64 (.211-class) builds alike.
- gate01 currently runs a hand-installed patched `libgstunixfd.so`
  (stock backed up at `/usr/lib/gstreamer-1.0/libgstunixfd.so.stock`).
  This disappears on the next RAUC slot switch — the Yocto patch is the
  permanent home.
- The dev Pi (.214) runs the equivalent fixes in its local `~/gst-1.24`
  prefix (`/home/mrstation/gstreamer-src`, 1.24.13 + local diff).
