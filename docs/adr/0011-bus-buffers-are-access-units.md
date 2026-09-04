# ADR-0011: Bus buffers are access units, not wire datagrams

A buffer on the unixfd bus is one access unit of MPEG-TS packets (whole
188-byte packets, however many the mux produced for that AU), not a 1316-byte
wire datagram. The producer's egress element (`mrtsstamp`, spliced at the
HEAD of every `busout_*` egress — directly on the producer's src, before the
`capssetter ! capsfilter` pair) coalesces `mpegtsmux`'s per-AU buffer list
into one buffer before anything else sees it. Two rules bind every consumer:

1. **No bus consumer may assume a buffer size.** Whole-packet alignment is the
   only guarantee; a buffer may be 188 bytes or a 400 KB keyframe.
2. **Anything that sends bus buffers to a datagram socket must know whether
   its sink slices.** srtsink splits to its SRT payload size itself; the
   native `mrristsink` re-slices to 1316 bytes itself (ADR-0013; before that
   the runner fed librist the slices); udpsink does not split, so
   mpegts-ip-output raw mode inserts `tsparse alignment=7 set-timestamps=false`
   (`buildTsRechunk`). A new output plugin that forgets this ships oversized
   datagrams.

## Why

Every bus buffer is one unixfd message: memfd + sendmsg + recvmsg + a release
message back, plus a thread hop per queue. At 1316 bytes that is ~760
messages/s per hop at 8 Mbit/s. Measured 2026-09-02 (Pi 5, 8.6 Mbit/s over
unixfdsink→unixfdsrc): a hop cost 25 producer + 45 consumer ticks/10 s at
1316-byte buffers and 11 + 9 at 24 KB buffers; on the Pi 4 mpegts-muxer (two
hops) the transport was ~45 % of its 0.54 core. Bytes per second are
unchanged; the cost was the buffer count. On the box the muxer went from 0.65
to 0.24 of a core, the video encoder from 0.46 to 0.26, the SRT output from
0.39 to 0.09, box idle from ~30 % to ~55 %.

## Considered options

- `mpegtsmux alignment=0`: emits one 188-byte buffer per TS packet — 7× worse.
- A large `mpegtsmux alignment` (e.g. 128 = 24 KB): holds packets across
  access units, so a 128 kbit/s audio mux emitted once per ~950 ms. Latency
  that scales inversely with bitrate is unacceptable on a bus every producer
  uses.
- Removing `capssetter ! capsfilter` to let buffer lists reach the tee:
  measured no gain — unixfdsink sends one message per list member regardless,
  and the stamper's own base class dismantles lists too.
- Coalescing at the egress element (chosen): per-AU boundaries come for free
  from the mux's own list, so there is no added latency, and the pipeline
  strings stay untouched (the element is inserted by the runner).

## Consequences

- `mrtsstamp` is spliced before the caps pair, not between the capsfilter and
  the tee, and gains `coalesce` (default on) and `coalesced-lists`. It now
  negotiates the raw producer caps (streamheader included); the capssetter
  still strips that downstream.
- With the time-sync contract off (`MR_TIME_SYNC_CONTRACT=0`) no element is
  spliced and the bus reverts to 1316-byte buffers. Relay producers (srt-input,
  mpegts-ip-input, rist-input) emit 1316-byte buffers regardless. Consumers
  that re-chunk do so with `set-timestamps=false`, so on those paths tsparse is
  a pure re-slice with no re-timing — the cost is small and the picture is
  untouched.
- Native and python bus ingest (`libmrbus`, `unixfd-fanout.py`) already
  produced 24 KB buffers, so consumers were already exercised on large
  buffers; leaky queues now shed whole access units instead of mid-AU slices.
- mpegts-ip-output RTP mode relies on rtpmp2tpay's `mtu` to size datagrams
  (it splits on 188-byte boundaries); tsparse is only inserted there when a
  size is forced.

## References

- `docs/research/mpegts-muxer-cpu-baseline.md` — the measurements, Stage 3.
- `plugins/mpegts-muxer/spike/muxer_rig.py` — the local rig that reproduces
  the muxer with the real runner.
