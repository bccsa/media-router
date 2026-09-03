# MPEG-TS muxer CPU baseline (Stage 0 of the muxer light-weighting plan)

| Field    | Value |
|----------|-------|
| Date     | 2026-09-02 12:46 UTC |
| Box      | 10.9.16.108, Raspberry Pi 4 (4 cores), Media-Router 1.0 (wrynose) |
| Software | media-router 2.0.0 working tree of `feat/hw-encoder-vbr-ts-jitter-fix`, hot-deployed to `/opt/media-router` at 11:50 UTC |
| Tool     | `tools/runner-cpu-profile.sh -t 10` (this document is its first recorded run) |
| Status   | Baseline recorded. Nothing changed yet. |

## Purpose

The mpegts-muxer runner is the largest single CPU consumer on this box. The
plan to slim it (Stages 1–6, summarised at the end) needs a number to beat
that is measured the same way every time. This file is that number plus the
method, so any later run is comparable.

## Wiring during the measurement

```
video-encoder-mtbh3emmsdnk (v4l2 capture → hw H.264 → mpegtsmux)  ── bus 40000 ──▶ muxer video-0
audio-input-302m-mtcv6dcq1pcy (pulsesrc → 302M → mpegtsmux)       ── bus 40001 ──▶ audio-transcoder
audio-transcoder-mtjzbjrhyzsl:out-0                                ── bus 40003 ──▶ muxer audio-0
mpegts-muxer-mtjza0e6apmv (bus 40002)                              ──────────────▶ srt-output-mtbh442kdwsd
```

Muxer config: `alignment=7`, non-leaky 500 ms input queues, `emitStreamInfo`
on (KLV carousel + PCR pinned to the video PID), time-sync contract on
(native `mrtsstamp` on the egress tee). Video input is ~8 Mbit/s, which at
1316-byte bus chunks is ~760 buffers/s.

## Method

`tools/runner-cpu-profile.sh` samples `/proc/<pid>/task/*/stat` and
`/status` for every `gst-pipeline-runner.py` over a window and reports
per-thread CPU ticks (1/100 s; 100 ticks/s = one full core) and wakeups/s
(context-switch delta). Runners are labelled by the bus port they listen on,
resolved to the owning module through `/tmp/engine.log`.

Comparison rule: same wiring, same source (the ATEM feed), 10 s window,
take two samples and quote the higher. Load average and the box-wide
usr/sys split are recorded alongside because the bus work shows up as
`sys` time (memfd + sendmsg per chunk), not `usr`.

## Results (window = 10 s)

Two consecutive samples; the muxer is stable to within 3 %.

| Runner (module) | Sample 1 | Sample 2 | Core share |
|---|---|---|---|
| mpegts-muxer | 650 ticks | 633 ticks | 0.63–0.65 |
| video-encoder | 456 | – | 0.46 |
| srt-output (consumer) | 393 | – | 0.39 |
| audio-transcoder | 254 | – | 0.25 |
| audio-input-302m | 157 | – | 0.16 |
| **Box total** | usr 37 % sys 32 % idle 28 % | usr 34 % sys 30 % idle 34 % | load 6.9 / 5.4 / 5.0 |

### Muxer thread breakdown (sample 1, ticks per 10 s)

| Thread | Ticks | Wakeups/s | What runs there |
|---|---|---|---|
| mux:src | 128 | 348 | mpegtsmux aggregation → capssetter → capsfilter → mrtsstamp → tee |
| queue1:src | 126 | 457 | video input: tsdemux + runner-injected h264parse |
| busin_1:src | 98 | 746 | unixfdsrc receiving the video input (one memfd message per 1316 B) |
| python3 | 95 | 263 | GLib main loop; ~1.5 % of it is the 50 ms KLV carousel, the rest is C inside the loop (unattributed, see open items) |
| queue3:src | 77 | 276 | video branch queue feeding the mux request pad |
| unixfdsink | 57 | 729 | egress edge to srt-output (one memfd message per 1316 B) |
| queue0:src | 35 | 89 | audio input: tsdemux (+ parser) |
| watchdog | 17 | 898 | input stall watchdog re-arming a GSource per buffer |
| busin_0:src | 7 | 42 | unixfdsrc receiving the audio input |
| queue2:src | 4 | 70 | audio branch queue |

The per-thread numbers say where the plan's stages should land:

- Ingest (`busin_1` + `watchdog`) and egress (`unixfdsink` + part of
  `mux:src`) together are ~45 % of the muxer. They scale with buffer count,
  not bitrate, so bus granularity (Stage 3) is the lever.
- `queue1:src` (demux + parse) is ~20 % and only moves with Stage 5.
- `python3` is ~15 % and mostly unexplained.

## Targets

| Stage | Expected effect on the muxer (ticks / 10 s) | Gate |
|---|---|---|
| 1 quick wins (probe cleanup, watchdog rework, traceback guard) | −40 to −60 | `watchdog` thread gone from the top list; no `on_out_buffer` probe after settle |
| 2 keep buffer lists through the egress | −30 to −60 | `mux:src` down, `unixfdsink` wakeups unchanged |
| 3 per-AU bus buffers | −250 to −350 | `busin_1` and `unixfdsink` wakeups fall from ~750/s to ≤ 150/s; srt-output runner drops too |
| 4 sparse metadata pad, 1 s carousel | −10 | carousel pushes 20/s → 1/s, no bitrate collapse (the 2026-07 failure mode) |
| 5 no re-parse on video | −60 to −100 | `queue1:src` halves; A/V offsets unchanged at the receiver |
| **Whole plan** | **≤ 300 (from 650)** | |

Any stage that changes the wire (3, 4) must also be re-measured at the
receiver (srt-output runner, and a player) because the saving is meant to be
fleet-wide, not moved downstream.

## Open items carried into Stage 1

- The ~7 % main-thread cost is inside the GLib loop in C (Python stack
  sampling via `sys.remote_exec` showed only the carousel). Counting GstBus
  messages from inside the runner would settle it; that probe was not run.
- Earlier the same day (10:55–11:25 UTC) a previous build looped a Python
  traceback per buffer from the alignment probe's `buf.unmap(mi)`
  (`TypeError: Expected Gst.MapInfo, but got gi.repository.Gst.MapInfo`,
  45,854 lines in `/tmp/engine.log`). It did not recur on the 11:50 deploy
  but the code path is unchanged; Stage 1 makes the probe map-free.
- The engine (not the runner) re-probes bus 40001 every 10 s because
  `MpegTsProbe` reports `audio/x-smpte-302m` as `codec: unknown` (~13 % of a
  core on the engine node process). Separate fix.

## How to re-run

```
mrscp tools/runner-cpu-profile.sh 10.9.16.108:/tmp/
mrssh 10.9.16.108 'sh /tmp/runner-cpu-profile.sh -t 10'
mrssh 10.9.16.108 'sh /tmp/runner-cpu-profile.sh -t 10 -m mpegts-muxer'   # muxer only
```

Append a new dated row block to this file rather than overwriting the
baseline.

## Stage 1 — runner quick wins (deployed to 10.9.16.108 2026-09-02 13:55 UTC)

Changes (all in the working tree, uncommitted):

- `alignBranchesToStamps`: the per-AU src-pad probes are removed when the
  branch settles or gives up (they were never removed before), and on a
  branch with more than one elementary stream the sink-pad TS parser is now
  released too (`pending` could never reach zero there, so it ran for the
  pipeline's life). The sink probe reads buffers with `extract_dup` instead
  of map/unmap and is fenced: an exception costs one log line and the
  feature, never a traceback per buffer.
- The muxer's per-input `watchdog` element is gone. The runner now watches
  each `busin_<i>` src pad with a one-shot probe re-armed once a second
  (`PipelineDescription.inputStallWatch`, built by `busStallWatch()`), and
  fails the pipeline with the same `bus_stall` error shape when 5 s pass
  with no buffer. The video-player keeps the element for now.
- Tests: `gst_input_stall_watch_test.py` (new), muxer and contract tests
  updated; `gst_branch_align_test.py` still passes end to end.

Deploy: `/tmp/stage1-dist.tar`, `/tmp/deploy.sh` and the profiler are staged
on 10.9.16.108. Run `sh /tmp/deploy.sh` on the box (sudo prompts once), wait
~60 s, then `sh /tmp/runner-cpu-profile.sh -t 10` twice and record the muxer
block below. Expected: the `watchdog` thread disappears from the muxer's top
list, `busin_1:src` wakeups unchanged (~750/s), total down 40–60 ticks/10 s.
Also check `/tmp/engine.log` for `branchAlign:` settle lines on both demuxes
and the absence of any traceback.

| Date | Sample | Muxer ticks/10 s | Notes |
|---|---|---|---|
| 2026-09-02 13:56 UTC | 1 | 544 (0.54 core) | mux:src 121, queue1:src 105, python3 90, queue2:src 78, busin_1:src 65, unixfdsink 62; no `watchdog` thread |
| 2026-09-02 13:57 UTC | 2 | 543 (0.54 core) | box usr 33 % sys 32 % idle 32 % |

Result: **−100 ticks/10 s (−16 %)** against the 633–650 baseline, twice the
40–60 expected. The extra came from the input thread: `busin_1:src` fell from
93–98 ticks / ~750 wakeups/s to 65 ticks / ~270 wakeups/s — the watchdog's
per-buffer GSource churn was waking the unixfdsrc thread too, not only its
own. Both `branchAlign:` settle lines present, no tracebacks, no error events
after the restart (the four `level:50` lines at 13:55:29–32 are the usual
connect-before-channel retries during engine start-up, resolved by 13:55:33).
`unixfdsink` wakeups rose (~730 → ~920/s) with unchanged ticks — the egress
is now paced by the mux alone.

## Stage 2 — skipped on measurement (2026-09-02)

A/B on the dev Pi 5 (8.6 Mbit/s CBR through `mpegtsmux alignment=7 → tee →
queue → unixfdsink → unixfdsrc → queue → tsdemux`): with and without the
`capssetter ! capsfilter` pair the consumer received the same ~820 buffers/s
of 1318 B and producer + consumer CPU differed by < 5 ticks/10 s. unixfdsink
sends one message per list member regardless, and `mrtsstamp`'s own base
class dismantles lists too. Nothing to gain; the pair stays.

## Stage 3 — per-access-unit bus buffers (ADR-0011; deployed 2026-09-02 14:24 UTC)

Spikes that chose the mechanism (dev Pi 5, same rig): the unixfd hop cost 25
producer + 45 consumer ticks/10 s at 1316 B buffers and 11 + 9 at 24 KB;
`mpegtsmux alignment=0` emits one 188 B buffer per packet (7× worse);
`alignment=128` holds packets across AUs (a 128 kbit/s audio mux emitted every
~950 ms). So `mrtsstamp` gained a sink-pad `chain_list` that merges the mux's
per-AU buffer list into one buffer, and the runner splices it at the HEAD of
the egress (before the caps pair) where the list is still whole. srt-output
and mpegts-ip-output now always re-chunk with `tsparse alignment=7
set-timestamps=false` (rist-output already sliced in the runner).

| Runner | Stage 1 | Stage 3 | Core share |
|---|---|---|---|
| mpegts-muxer | 544 | 239 / 247 | 0.24 |
| video-encoder | 456 (baseline) | 263 | 0.26 |
| srt-output | 393 (baseline) | 147 | 0.15 |
| audio-transcoder | 254 (baseline) | 197 | 0.20 |
| audio-input-302m | 157 (baseline) | 118 | 0.12 |
| **Box** | usr 33 % sys 32 % idle 32 % | usr 25–30 % sys 21 % idle 47–52 % | load 3.8–4.6 |

Muxer threads (Stage 3, ticks/10 s): mux:src 93, python3 76, queue1:src 22,
queue2:src 13, queue0:src 9, busin_0:src 7 — the input and egress threads
that were ~45 % of the muxer are now noise. Verified on the box: both bus
hops carry ~11.2 Mbit/s (tapped with a second unixfd client: 25 buf/s ×
55 KB into the muxer, 44 buf/s × 32 KB out), `tsparse` on the live stream
emits 1181 × 1316 B/s, and a local end-to-end run through a real srtsink
delivers 919 vs 917 datagrams/s with coalescing on vs off.

Gate evidence for the wire change (both halves the plan asked for):

- **Wakeups/s at the muxer's bus edges** (10 s window, 14:26 UTC): `busin_1:src`
  746 → 12 wk/s, `busin_0:src` 42 → 9, `unixfdsink` 729 → below the top-8 cut
  (< 43), `queue4:src` 245 → 24. The plan's gate was "≤ 150/s"; all are under 30.
- **Receiver re-measure** (.103, the srt-input → ts-splitter → video-player
  box, 2026-09-02 15:00 UTC): srt-input egress 1004–1041 buf/s at 10.6–11.0
  Mbit/s (1316-byte datagrams, unchanged — the wire is still SRT), runner at
  0.05 core; end-to-end encoder edge (.108) → player input (.103) 96 ms median,
  103 p90, 52–125 range, measured by matching the same access units across
  both boxes with wall clocks verified within 1 ms. The muxer output → player
  input leg is 13 ms median. The receiver's own player chain (50 ms buffer,
  300 ms playout offset D, decode) was not changed by this work.

Observed after the deploy:

- The receiver side (srt-input → video-player on another box) froze at ~one
  frame until its modules were restarted; the sender's engine restart is
  what it did not survive. Pre-existing reconnect behaviour, now on the list.
- The muxer's egress stamper anchors on PID 0x1f0 (the KLV carousel), not a
  media PID — every muxer start in the log history did, so Stage 3 exposed
  rather than caused it. The stamper should skip private-data PIDs (or
  anchor on the PCR PID); until then the muxer's stamped timeline follows
  the carousel's push clock. Harmless for srt-output (`sync=false`).
- The muxer's GLib main thread was its second-largest cost (76–159 ticks,
  230–260 wakeups/s, C-side work only). ATTRIBUTED 2026-09-03 with the local
  rig (`plugins/mpegts-muxer/spike/muxer_rig.py`, the real runner on the
  muxer's exact pipeline): `mpegtsmux` posted GstAggregator's "Impossible to
  configure latency: max < min" WARNING ~130×/s because the LIVE klvsrc
  appsrc pad takes part in the aggregator's latency arithmetic; each message
  wakes the main loop and is marshalled into the python bus handler. With
  `is-live=false` on klvsrc: bus messages 129/s → 0, runner 63 → 34 ticks/10 s
  (main thread 17 → 5, mux:src 27 → 11), output identical (44 buf/s,
  8.45 Mbit/s, 25.1 video AU/s, 19.5 KLV PES/s, monotonic PTS). One property
  in `mpegtsMuxerPipeline.ts`; dist installed on .108, takes effect at the
  muxer's next (re)start. This was never python cost — the runner's python
  share on the muxer after it is ~5 ticks/10 s.
- Two `GStreamer-WARNING: pad has no probe with id` lines from the Stage 1
  probe cleanup racing a self-removed probe; fixed in the working tree,
  not yet deployed.
