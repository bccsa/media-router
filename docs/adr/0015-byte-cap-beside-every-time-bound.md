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
  a restart.
- Raw video (1080p50 I420 ≈ 1.2 Gbit/s) would shed constantly under this cap,
  hence the exemption. `buildLeakyQueue` / `buildBackpressureQueue` default to
  `maxBytes = 0` so an unconverted caller stays exactly as it was.
- A stalled consumer still pins up to 40 MB of shm per edge on the producer
  (unixfdsink holds each sent copy until the consumer's 5 s ingress lets it
  go). Bounded, but a per-consumer budget to remember on busy fan-outs.
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
