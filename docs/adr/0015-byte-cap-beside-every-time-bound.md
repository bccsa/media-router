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
