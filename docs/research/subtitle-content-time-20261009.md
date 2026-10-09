# Subtitle content time — investigation 2026-10-09 (NO-OCC-Gate01)

The narrative behind ADR-0016's 2026-10-09 amendment: what was measured on
the gate, what was tried, and how the bridge reads content time off the
engine's stamps. The decision itself lives in the ADR.

## The gate chain and the three causes

Chain: ingest → ts-splitter → transcoders EN/FR (burn-in) with
teletext-subtitles (pages 888/600) on `subtitles-in`. Burned-in teletext ran
1–6 s late; the original amendment text, kept verbatim below, lists the
three measured causes and the design that answered them.


Measured on NO-OCC-Gate01: burned-in teletext showed 1–6 s late, from three
stacked causes.

1. The broadcaster's video PES lead the PCR by 0.9–1.5 s, the teletext PES by
   52 ms, so a frame's teletext arrives ~1.05 s after the frame.
2. The cue had no content time. The producer started it at house-now (when
   `teletextdec` finished the page) and put that send time on the PES, and
   the teletext module's egress was anchor-stamped (the anchored stamper
   re-bases a content-timed PES on the first cue's lateness).
3. The consumer took t0 from its `tsdemux` PTS. On a sparse KLV-only TS with
   the PCR on the KLV PID that time wandered ±3 s around house time, inside
   `frame_time`'s 10 s tolerance: the EN and FR transcoders showed one cue
   2–4 s apart.

Now:

- **Producer.** A cue starts at its content time: the page buffer's PTS
  (`teletextdec` copies the input buffer's timestamp onto the page — gst 1.28
  `gst_teletextdec_push_page`), else house-now when that is missing or > 10 s
  off (warned once per page), never below the previous start. Every send
  of a cue — the first and each 2 s re-send — carries the same PES bytes
  (the TS chunk around them differs: continuity counters advance, re-sends
  carry no PCR): PTS = cue start, block `0 --> (end − start)`. A clear is a
  zero-length cue at its own content time. The 2026-09-16 "re-sends jump back" fault does
  not return: re-sends REPEAT a PTS and starts never decrease, so the KLV PID
  never steps back.
- **The page PTS has to be content time first.** `alignBranchesToStamps`
  retimes only `audio_`/`video_` pads (both runners), and tsdemux's own time
  for a private PID carries the input's video-PTS-vs-PCR lead. So the bridge
  (`sourceDemux`) reads each bus chunk's stamp on the demux sink pad, gives
  every private PES its place on the program's one mapping, `house = K +
  PTS/90` (`subtitle_stamp_model.StampModel`), then rewrites the teletext pad's
  buffers to it, joined by payload hash. The teletext module does not
  declare `alignBranchesToStamps`.
  K is read back off the engine's stamps, which are not simply "the mapping
  of a PES in the chunk": the stamper maps one reference PES (the PCR PID's
  first when it knows its timing PID, else the first video/audio PES — the
  anchored mode learns the timing PID only in `condition`, off under
  MR_LATCH_REPAIR=0) and then clamps to a monotone floor per stream; a chunk
  with no timing PES gets its arrival, also floored. With the OCC feed's
  video PTS ~1 s ahead of its audio, nearly every audio-referenced chunk is
  clamped. So K is learned only from a chunk whose stamp ROSE and whose
  reference both rules agree on (the PCR PID's first PES is also its first
  video/audio PES): K = stamp − ref/90. It is kept across clamped,
  arrival-stamped and disagreeing chunks, and dropped when a clamped chunk's
  reference maps > 0.3 s above or > 2.5 s below its stamp, or a rise implies
  a K > 0.3 s off (a re-anchor), until the next agreeing rise. Pinned against
  the real `ts_timeline.TimelineStamper` in both timing-PID modes, through
  +427 s, +7 s and −600 s jumps, on the OCC offsets and on audio-leading ones
  (audio +600 / video +100, vMix +1800), attached mid-stream, and in house
  mode on a KLV-only stream (`py/subtitle_ts_engine_test.py`): no PES placed
  more than a frame off; audio-leading with the timing PID unknown misses
  ~1 in 4; learning from every rise instead placed cues 500 ms off in the
  same test. The first field cut picked "the PES the stamp came
  from" per chunk without the floor and started cues 1.0–1.3 s late.
- **Identity egress.** teletext-subtitles declares `houseTimelineEgress`, so
  the KLV egress stamp is exactly PES − 1 h = the cue's content time.
- **Consumer.** The bridge probes the subtitle tsdemux's sink pad, assembles
  the KLV PES (stream_id 0xBD) and records `sha1(KLV) → stamp of the chunk
  the PES started in` (64-entry LRU, 5 s max age). A cue anchors on that
  stamp (`t0src=chunk`), else its tsdemux PTS (`pts`), else arrival (`now`).
  An arrival-anchored re-send of the cue already held is ignored, so it is
  not stretched. Trace: `[subtitle_bridge] show '…' cueLate=<frame − start>
  frameLag=<now − frame> t0src=…`; the producer logs `cue <label> start=…
  late=…`, and `lateMs` rides the `subtitle:cue` event into the module status.

- **No mpegtsmux in the pay tail; the bridge packs each cue's TS.** First
  `alignment=7` held a cue's ~3 packets until 7 had accumulated (page-888
  egress one 1316-byte buffer every ~5 s, cues 1–4 s late in ~2 s re-send
  steps). With `alignment=0` the gate still held cues: the bridge's egress
  trace (`[subtitle_bridge] egress … mux=+ tee=+`) put the hold BEFORE the
  mux src pad, 2–6 s, a cue released when up to two later pushes arrived.
  Not reproduced locally on gst 1.28.2 with the same chain, nor with the
  module's exact pipeline run live from the OCC capture (every cue at the
  mux src ≤ 1 ms), and the source has nothing that defers a lone buffer
  (`gst_aggregator_check_pads_ready`: one pad with a buffer is ready, live or
  not; `gst_base_ts_mux_aggregate_buffer` writes and `push_packets(align 0)`
  pushes at once). The gate-only cause stays unknown; the aggregator is out
  of the path instead: `appsrc (video/mpegts) ! bus sink`, the bridge pushing
  one buffer per cue (`py/subtitle_pack.py`) laid out as mpegtsmux wrote it —
  PAT, PMT (PID 0x20, PCR on the KLV PID, stream_type 0x06 + `KLVA`
  registration; sections byte-identical, pinned against gst 1.28 output),
  PES 0xBD with explicit length and PTS = cue start + 1 h, PCR = PTS − 125 ms
  when it advances. The identity stamper reads the start back exactly (both
  twins, pinned).
- **Each cue chunk is padded with null packets to 7 × 188 bytes.** A
  tsdemux/tsparse that (re)starts or takes a DISCONT buffer clears its packet
  size (`mpegts_packetizer_clear` from mpegtsbase's DISCONT path) and
  re-detects it from ≥ 832 bytes; a bare 3-packet cue (564 bytes) sat in its
  adapter until the next cue — the first cue after every consumer start — or,
  flushed by a following DISCONT, was lost. Measured locally live: 22/22 cues
  decoded by a consumer tsdemux 0–1 ms after their push, the first included.

What this does not fix:

- Arriving on time. The cue is now stamped at its frame, but it still
  reaches a renderer ~1 s after that frame (cause 1). A renderer must hold
  video for at least the broadcaster's video-vs-teletext lead: the
  transcoder's `subtitleDelayMs` (ADR-0005, same day). Without the hold the
  cue shows on the first frame after it arrives, as before.
- Hops that re-stamp a private PES at arrival (a KLV-only leg off a splitter,
  the mpegts-muxer's restamped cue pad). There the chunk stamp is the arrival
  time and the cue shows on arrival, no worse than before.
- (Resolved 2026-10-09.) The C++ twin (`native/subtitle-bridge`, ADR-0020)
  still implemented the 2026-09-16 behaviour; it was deleted rather than
  ported — the bridge is python-only and its descriptions pin the python runner.

## Field rounds after the first drop

- **Round 2 (two-candidate reference).** With MR_LATCH_REPAIR=0 the anchored
  stamper never learns its timing PID (only `condition` sets it; the house
  mode learns it from PCR packets), so it maps the FIRST video/audio PES of a
  chunk; the bridge preferred the PCR PID's PES and started cues 1.0–1.3 s
  late on audio-first chunks. Ground truth: the ingest `anchored: house=…
  firstPes=…` line vs the wire teletext PTS.
- **Round 3 (the floor).** `ts_timeline.stamp()` clamps every stamp to a
  monotone floor per stream; a chunk without a timing PES gets its arrival,
  also floored, and a PES-less chunk repeats the floor. On this feed (video
  PTS ~1 s ahead of audio) almost every chunk is stamped at the video level.
  The model therefore learns K = stamp − ref/90 only where the stamp ROSE,
  keeps it across clamped and arrival-stamped chunks, and drops it on a
  re-anchor (a clamped chunk mapping > 0.3 s above or > 2.5 s below its
  stamp, a rise implying a K > 0.3 s off). Round 7 restricted learning to
  rises whose reference both engine rules agree on: with audio leading video
  and the timing PID unknown, learning from every rise placed cues 500 ms off.
  Gate result: producer content time within 40 ms of the ingest anchor.
- **Rounds 4–5 (the egress hold).** The page-888 bus edge showed each cue
  leaving two pushes late. An opt-in egress trace (`egress … mux=+ tee=+`)
  put the hold before the mpegtsmux src pad (2–6 s). It did not reproduce
  locally on gst 1.28.2 (same chain, then the module's exact pipeline run live
  from the OCC capture), and the aggregator/tsmux source has nothing that
  defers a lone buffer. Resolved later: the ENGINE caches plugin TS code — a
  module restart re-runs only the python hooks — so the gate never ran
  `alignment=0`; the "two-buffer hold" was `alignment=7` fed 3 packets per
  push. The bridge-packed tail (no mpegtsmux) shipped meanwhile and stays: it
  removes the aggregator from a sparse path, and its null padding fixes a
  real consumer stall (a restarting or DISCONT-flushed tsdemux needs ≥ 832
  bytes to re-detect the packet size; a bare 3-packet cue waited for the next
  one, or was lost).
- **Round 6+ (review).** A single cue slot dropped short cues under the
  transcoder hold (now a queue ordered by start); locks around the pay and
  overlay state; the pay tail's runner pin.

Gate after all of it: both transcoders draw every cue with cueLate 4–5 ms,
egress src=+0, A/V skew unchanged.
