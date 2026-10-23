# ADR-0015: Every time-bounded compressed-stream queue on the bus also carries a byte cap

A GStreamer `queue` on a compressed stream (TS, ES, 302M) that is bounded by
`max-size-time` must also set `max-size-bytes`, sized as 64 Mbit/s worth of
its time bound and floored at 1 MiB (`tsQueueByteCap` in
`packages/engine/src/plugins/queueBounds.ts`; the runner mirrors the rate as
`BUS_EDGE_QUEUE_BYTES_PER_MS`). Raw-video queues are exempt and keep
`max-size-bytes=0`. Locked 2026-09-07.

## Why

`queue` measures its time level as the running time of the newest buffer in
minus the running time of the last buffer out. That level only grows while the
stream's timestamps advance. When stamps stall or step back — a re-anchored
source, a wedged consumer that stops popping, a KLV pad with a frozen clock —
a time-only bound reads as near-empty forever, `leaky=2` never sheds,
`leaky=0` never back-pressures, and the queue grows at wire rate. A byte bound
is blind to timestamps and fires regardless.

Working hypothesis, not yet confirmed on a box: this is how five mpegts-muxers
on gate01 (2026-09-06) each grew to 2.8 GB of anonymous heap at exactly their
program bitrate while their SRT callers looped on reach-PLAYING. Whether or
not that is the retention point, a time-only queue has no bound in that
failure mode and the byte cap costs nothing on a healthy stream.

## Consequences

- 64 Mbit/s is a runaway stop, not a latency budget: no stream this system
  carries (HEVC 4K ≈ 20 Mbit/s, 16-ch 302M ≈ 18 Mbit/s) approaches it, so the
  cap never fires on a healthy path and adds no latency.
- On a NON-leaky queue the cap blocks instead of dropping — the same failure
  mode the time bound already has; the input stall watch turns the stall into
  a restart. Amended by [[0029]] (Phase 2): the stall watch is deleted, and a
  muxer route's queue is its `mralignwatch` (5 s, `max-size-bytes` =
  `tsQueueByteCap(5000)`), which blocks upstream when full and raises the
  module's `aligner-full` warning; nothing restarts.
- Raw video (1080p50 I420 ≈ 1.2 Gbit/s) would shed constantly under this cap,
  hence the exemption. `buildLeakyQueue` / `buildBackpressureQueue` default to
  `maxBytes = 0` so an unconverted caller stays exactly as it was.
- A stalled consumer still pins up to 40 MB of payload per edge on the
  producer (unixfdsink holds each sent copy until the consumer's 5 s ingress
  lets it go). Bounded, but a per-consumer budget to remember on busy
  fan-outs, and more shm than its payload: each in-flight bus buffer is a
  memfd of its own, rounded up to whole pages, so a 1,323-byte buffer pins
  4 KiB on a Pi 4 and 16 KiB on a 16K-page kernel. An edge stalled at the
  40 MB cap of 1,316-byte buffers therefore pins about 125 MB, or about
  500 MB, not 40 MB. The fd count per edge is bounded the same way, by the
  consumer's 5 s ingress queue (plan chapter 15.4 B-91, measured 2026-10-22).
  The producer also keeps each copy the consumer releases in its
  unixfdsink's allocator pool, mapped, until that sink stops, so a stall's
  high-water mark stays pinned for the edge's life, and
  `vm.max_map_count` (65,530; the image does not set it) caps one producer
  process at about 65,000 copies: the fifth stalled 30 Mbit/s edge at 5 s
  passes it (measured 2026-10-22; plan 15.4 B-94, open).
- The bus queues read a silence right only on the image's GStreamer (plan
  chapter 15.4 B-68). A stock `queue` keeps its src time at the last buffer
  out once it has drained, so the first buffer back after a silence longer
  than the time bound reads as the whole silence, and a second buffer that
  arrives before the queue's thread takes the first leaks it (`leaky=2`; the
  next one goes out DISCONT). meta-custom's gstreamer1.0 patch 0001 makes a
  drained queue start its level afresh at the next buffer in. A queue that
  holds data is unchanged: a stall still sheds at the bound, and a forward
  stamp step longer than the bound still reads as full, as in any
  stamp-bounded queue. The bounds, the cost of a stalled edge above and its
  fd bound are unchanged.
- Not yet converted (tracked in queueBounds.ts): `buildTsUdpInput`'s jitter
  queue, mpegts-ip-output / mpegts-ip-input back-pressure queues, the
  video-player's compressed pre-decode queue, and the literal queues in
  audio-transcoder, audio-decoder and n1-mixer-302m.

## Exception: the per-consumer bus edge queue (time bound 5 s, byte cap 500 ms)

The runner's per-consumer fan-out edge queue (`BUS_EDGE_QUEUE_MS` /
`BUS_EDGE_QUEUE_MAX_BYTES` in `gst-pipeline-runner.py`) deliberately does NOT
size its byte cap to its time bound. It carries a **5 s** time bound but a
**500 ms** byte cap (4 MB at 64 Mbit/s). The time bound is generous ONLY so a
producer re-anchor — which steps the stamp timeline forward by up to the
conditioner's bound (ADR-0005 Stage 3f) — is not read as a full queue and
leaked, one buffer per re-anchor, breaking continuity on every PID (measured
.103, 2026-09-08). The byte cap stays at the shed granularity (500 ms) because
here it is the real per-consumer memory backstop, not a companion to the time
bound: a stalled consumer sheds at 500 ms of stream or 4 MB, whichever comes
first, and a healthy re-anchor (which adds timeline, not bytes) never
approaches the cap. So the two bounds are sized to two different jobs, and the
formula above ("64 Mbit/s × the time bound") is the default for queues whose
time bound IS the latency target — not for this one.

With the image's GStreamer (B-68 above) a forward step into a drained queue,
which is what a silence is under identity egress, is no longer a level. A step
while the queue holds data still is, so the 5 s stays.
