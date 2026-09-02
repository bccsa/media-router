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
