# mpegts-core — the MPEG-TS core (library plugin)

Library plugin: no `mediaRouter` manifest, so it never appears in the Add
Module panel. It owns the MPEG-TS domain code: the C++ core every TS-handling
element and sidecar links (`native/mrts`, archive `libmrts.a`), the GStreamer
plugins built on it, the Python reference modules, and the TypeScript reader
of PMT descriptor loops. Build contract: `plugins/README.md` → "Native &
Python code in plugins".

## The rule: the C++ runs, the Python is the reference

Everything that reads or writes timing in a transport stream (the packet
walk, PSI, PES reassembly, PCR read and write, the PES header rewrite, the
33-bit unwrap, the 1 h formula) is implemented once, in C++17 in
`native/mrts`, and the house-clock elements in `native/mrtshouse` are built
on it (ADR-0029, "The shared TS module"). Those elements have no Python
fallback, and nothing new is twinned. New timing code is prototyped and
tested in Python first, because that is quicker, and ported to C++ once it
is right; the Python stays in `py/` as the reference, is never loaded by a
runner for a new path, and keeps its tests in `test:py`. ADR-0001 called the
python "the executable specification"; ADR-0029 amends that to: the python
is the reference, only the C++ runs. A Python test harness that drives a
native element over appsrc/appsink is tooling, not a twin. Nothing in `py/`
is deleted for being a twin (plan OQ-1); the frozen paths that still import
it at runtime stop doing so phase by phase (below).

## Contents

### `native/`

| Path | What |
|---|---|
| `native/build-host.sh` | Host build of the portable core, its tests and `mrts_cli` (any Linux or macOS with a C++17 compiler); used by the vitest suites. `./build-host.sh test` also runs the C++ tests |
| `native/.gitignore` | The build outputs below |

### `native/mrts/` — the C++17 core, no GStreamer, built `-fPIC` into `libmrts.a`

| Path | What |
|---|---|
| `Makefile` | Builds `libmrts.a` (always `-fPIC`, even under a command-line `CXXFLAGS`) and `mrts_cli`. `test` builds the suites, `tests/mrts_bench` and `tests/fixture_gen`, runs the suites, then `tests/trace_cli_test.sh`. Installs nothing |
| `ts_house.h`, `ts_house.cpp` | The timescales: 90 kHz, 27 MHz and ns conversions with Python's floor rule, `fold33`, `unwrap_near`, the bus formula `house_from_mux_pts` and its inverse `mux_pts_from_house`, `Unwrapper` (continuous per stream, DTS nearest its own PTS), the network boundary `NetEpoch` / `bus_to_net` / `net_to_bus` / `net_pcr27` (Phase 5), and `IdentityStamp`, the bus stamp `PES − 1 h` per stream that `mrtsstamp`, `mr-tssplit` and `mr-bus-fanout` use (Phase 2) |
| `ts_packet.h`, `ts_packet.cpp` | The packet layer: header helpers, `PacketView`, `PacketWalker` (carries split packets across feeds, resyncs, counts desync bytes), `CcTracker` (continuity per PID) |
| `ts_pes.h`, `ts_pes.cpp` | PES headers: `parse_pes_header`, the in-place PTS/DTS rewrite, `PesHeaderSpan` (a header split over two packets), `PesAssembler` (whole PES on every selected PID, capped and counted) |
| `ts_pcr.h`, `ts_pcr.cpp` | The PCR: read, write, PCR-only packets, `discontinuity_indicator`, `PcrScheduler` (egress cadence, Phase 5) |
| `ts_psi.h`, `ts_psi.cpp` | PSI parse and build and `PsiDiscovery` (port of `py/ts_psi.py`), generalised in C++ only: program selection, PMT generation, descriptor loops, `registration_format`, multi-packet sections |
| `ts_split.h`, `ts_split.cpp` | `SplitterCore`, the packet-level per-PID SPTS splitter of `mr-tssplit` (port of `py/ts_split.py`), on `PacketWalker` |
| `ts_timeline.h`, `ts_timeline.cpp` | `timing_pes`, the one rule Phase 2 kept of the anchored stamper (port of `py/ts_timeline.py`'s): a PES may define a timeline when it is video or audio, or on the PCR carrier. Used by `IdentityStamp` and the runner's branch retime; when Phase 3 deletes the file, the rule moves into `ts_house`, since `IdentityStamp` keeps it |
| `ts_video_info.h`, `ts_video_info.cpp`, `sps_parse.h`, `sps_parse.cpp` | H.264/H.265 SPS probe for the video-info tap (not timing) |
| `lateness.h`, `lateness.cpp` | `LatenessWindow`, the accumulator behind every lateness reading (Phase 0) |
| `ts_stc.h`, `ts_stc.cpp` | The virtual STC: `ClockLock` (lower-envelope lock of a remote clock to arrival), `PcrValidator`, `VirtualStc` (per program: epochs, degraded mode, the straddle rule) |
| `ts_restamp.h`, `ts_restamp.cpp` | `RestampCore`, the ingest restamp: STC or fixed mode, O and per-PID trims, the overlap guard with CC renumbering, the PCR rewrite, gaps, trace recording |
| `ts_gap.h`, `ts_gap.cpp` | The bus gap marker's adaptation-only packet: build and read |
| `ts_trace.h`, `ts_trace.cpp` | Arrival traces (`.stct`): writer, reader, and `TracePlayer`, which replays a trace as the TS its recorder read |
| `ts_dump.h`, `ts_dump.cpp` | `PesIndex`: the PES index of a TS as JSON lines (every PES of the followed program, each PAT/PMT change, the counters), what `mrts_cli dump` prints and `ts_conformance_test` compares; `crc32_zlib` |
| `asrc_servo.h`, `asrc_servo.cpp` | `AsrcServo`: `ClockLock` on input frame count against buffer PTS, and the phase servo that commands `mrasrc`'s ratio |
| `align_watch.h`, `align_watch.cpp` | What `mralignwatch` decides (Phase 2): W from the arrival rhythm (`ArrivalRhythm`), the pace group and its process-wide registry (`PaceGroup`, `PaceRegistry`), the gap planner (`GapPlanner`) |
| `ts_select.h`, `ts_select.cpp` | `SelectDemux`, what `mrtsdemux` does in select mode (Phase 2): one stream of one program on the formula timeline (`PES − 1 h`, unwrapped from the clock), the jump rule, bus gap markers turned into gaps, the no-stream warning; Phase 3's `DemuxCore` generalises it |
| `mrts_cli.cpp` | Test harness, never installed: `dump` (`PesIndex`; `--program N` follows that program of the PAT), `trace2jsonl` / `jsonl2trace`, `restamp-replay` (`--config`, `--sweep`, `--expect`) |

### `native/mrts/tests/` — C++ unit tests (`make -C native/mrts test`, root `make native-test`)

| Path | What |
|---|---|
| `check.h` | The assertion harness |
| `ts_house_test.cpp`, `ts_packet_test.cpp`, `ts_pes_test.cpp`, `ts_pcr_test.cpp`, `ts_psi_test.cpp`, `ts_split_test.cpp`, `ts_timeline_test.cpp`, `ts_video_info_test.cpp`, `lateness_test.cpp`, `ts_stc_test.cpp`, `ts_trace_test.cpp`, `ts_restamp_test.cpp`, `asrc_servo_test.cpp`, `ts_gap_test.cpp`, `align_watch_test.cpp`, `ts_select_test.cpp` | The 16 suites, one per module |
| `ts_conformance_test.cpp` | Every `tests/fixtures/<name>.ts` through `PesIndex` at 188, 1316 and 24 576-byte chunks against `<name>.expect.jsonl` (and `<name>.p<N>.expect.jsonl` for program N), line by line; the synthetic fixtures must be `fixture_gen`'s bytes, `cap-cc-loss` its source with the named packets removed, the parity port `py/native_parity_fixture.py`'s length and CRC-32. `MRTS_FIXTURES` names another fixture directory |
| `trace_gen.h`, `ts_gen.h`, `fixture_gen.cpp` | The deterministic generators: arrival traces (`fixture_gen --trace`, with outages, jumps, late PES, a queuing caller's backlog `--backlog` and a PID stamped ahead `--ahead`; `--shift PID:MS -i IN.stct` stamps PIDs of a recorded trace further ahead, the derived fixtures), the synthetic `.ts` fixtures (`--ts KIND`: `parity`, the byte-for-byte port of `py/native_parity_fixture.py`, LCG and all; `mpts-two-programs`, `wrap-33bit`, `pes-header-split`, `pes-no-pts`, `source-restart`) and packets removed from a capture (`--drop PID@N,...`) |
| `trace_cli_test.sh` | `mrts_cli`'s trace verbs, and every `tests/fixtures/restamp/*.expect.json` against its regenerated trace |
| `mrts_bench.cpp` | ns per packet of the walk, the rewrite and the reassembly (the Pi 4 budget, WI-S0-11); `--wrap-at` moves a capture's timestamps across the 33-bit wrap. Built by `test`, never run by it |

### `native/mrtshouse/` — `libgstmrtshouse.so`, the house-clock elements

| Path | What |
|---|---|
| `Makefile` | Builds the plugin (gstreamer-1.0, -base-1.0, -audio-1.0) against `libmrts.a`, `-Wl,-z,defs`. `test` also builds `tests/abi0/libgstmrtshouse.so` (the same plugin at ABI 0, for the loader tests), `tests/restamp_ref` and `tests/asrc_bench`. Installs only the plugin, to `/usr/libexec/media-router/mpegts-core/` |
| `mrtshouse_abi.h` | `MRTSHOUSE_ABI` (1) and `MRTSHOUSE_VERSION`: the element protocol both runners check at load |
| `mrtshouse.h` | What every element shares: the read-only `abi` property, the counter properties, the debug category, the element types |
| `gstmrtshouse.cpp` | `GST_PLUGIN_DEFINE` and the factory table `kFactories`, one row per element |
| `gstmrtsrestamp.cpp` | `mrtsrestamp`: `RestampCore` as an element, with the gap markers and the outage task (Phase 1) |
| `gstmrasrc.cpp` | `mrasrc`: the capture ASRC, `AsrcServo` driving `GstAudioResampler` (Phase 1) |
| `mrasrc_resampler.h` | `mrasrc`'s resampler settings, in one place so the bench measures exactly them |
| `gstmralignwatch.cpp` | `mralignwatch`: the input of a non-live aggregator. A FIFO released at the pace its pace group shares, the silence watchdog and the gap fill, LATENCY answered as non-live (Phase 2) |
| `gstmrtsdemux.cpp` | `mrtsdemux`: the formula demux, select mode (`select="audio/x-smpte-302m"`, Phase 2): one ALWAYS pad, `SelectDemux` on it, GAP events, the `mrtsdemux` message; no stand-in |
| `tests/restamp_ref.cpp` | `RestampCore` without GStreamer: the reference the element and protocol tests hold `mrtsrestamp` to |
| `tests/asrc_bench.c` | `GstAudioResampler` CPU at `mrasrc`'s settings, against the Pi 4 budget; run by hand |

### The other native tools

| Path | What |
|---|---|
| `native/mrtsstamp/gstmrtsstamp.cpp`, `native/mrtsstamp/Makefile` | `mrtsstamp` (`libgstmrtsstamp.so`, 3.0.0): the egress stamper both runners splice at every `busout_*` tee. Identity only (`mrts::IdentityStamp`, `PES − 1 h`, base-aware, gap markers passed), since Phase 2 |
| `native/mrlateness/gstmrlateness.cpp`, `native/mrlateness/Makefile` | `mrlateness` (`libgstmrlateness.so`): the lateness tap on every bus edge and output sink (Phase 0) |
| `native/mrpeshouse/gstmrpeshouse.cpp`, `pes_walk.h`, `pes_walk.cpp`, `stamp_model.h`, `stamp_model.cpp`, `Makefile`, `tests/stamp_model_test.cpp`, `tests/stamp_model_vectors.txt`, `tests/README.md` | The subtitle bridge's PES stamp model (frozen, python runner only); deleted with subtitle K recovery in Phase 3 |

### `py/` — the reference modules

| Path | What |
|---|---|
| `ts_psi.py`, `ts_split.py`, `ts_video_info.py`, `sps_parse.py` | References of the PSI, splitter and SPS code. `ts_psi.py`, `ts_video_info.py` and `sps_parse.py` also serve the Python runner's `tsProbe`, which is not timing |
| `ts_timeline.py` | Reference of `ts_timeline`. Still imported at runtime by branch alignment and retime, for its helpers, until Phase 3 |
| `video_pace.py` | Reference of `mrts::VideoPace` (plan ch. 8 WI-P4-3, ch. 15.4 B-161), written before its C++ port: when each decoded frame leaves `mrvideopace`, and which frames go so that a slower display keeps up; the display period from presentation feedback or a blocking sink's returns. Never loaded. As a script it replays a recorded call sequence, the line format `mrts_cli pace` reads |
| `native_parity_fixture.py`, `native_parity_ref.py` | The synthetic MPTS generator and the Python splitter whose output `ts-splitter`'s `mrTssplit.test.ts` expects (the parity vitest went in Phase 2) |
| `ts_psi_test.py`, `ts_split_test.py`, `ts_video_info_test.py`, `ts_timeline_test.py`, `video_pace_test.py` | The reference suites (`test:py`). `video_pace_test.py --mutants` checks that each of its mutants fails its case; with `VIDEO_PACE_TRACE=<file>` it records every call for the C++ parity |

### `engine/` and `tests/`

| Path | What |
|---|---|
| `engine/esDescriptors.ts`, `engine/index.ts` | The TypeScript ES descriptor-loop reader every TS plugin uses (`descriptorsFromEsInfo`, `esInfoBytes`, `isoLanguage`); tests in `esDescriptors.test.ts` |
| `tests/hlsPipeReference.test.ts` | `mrts_cli dump` against hls-pipe's TypeScript demuxer, PES for PES (pid, PTS, DTS, length, CRC-32); hls-pipe's known limits are an allowlist with reasons, any other difference fails. `HLS_PIPE_DIR` names another hls-pipe checkout, `HLS_PIPE_REFERENCE_FIXTURES` adds captures |
| `tests/dump_vs_ffprobe.py` | `mrts_cli dump` against ffprobe, PES for PES |
| `tests/tsFixtures.ts` | Hand-built TS for the ts-splitter and unixfdbus-core suites |
| `tests/fixtures/*.ts`, `*.expect.jsonl` | The conformance fixtures (plan ch. 3 part 7.2, WI-S0-9): `syn-*` from `fixture_gen --ts`, `cap-*` field captures of at most 2 MB (OCC 1080i H.264 + AAC + teletext; vMix's VBR mux, a PCR only on each IDR; our mux egress of AAC + Opus and of 1080i H.264 with unbounded video PES; 302M with `BSSD`; KLVA subtitles; an SRT ingest of 1316-byte datagrams from a third-party mux; `cap-cc-loss` derived by `--drop`), each with its `mrts_cli dump`, reviewed against ffprobe |
| `tests/fixtures/restamp/*.stct`, `*.expect.json` | Arrival traces and their expectations (plan ch. 5 part 7.2, WI-P1-5): the synthetic ones name the `fixture_gen` command that regenerates them (no `.stct` committed); the field traces (`trace-*`, at most 2 MB) are committed and their notes say where and how each was recorded and what its dump shows; a derived one (`trace-*-ahead-*`) names the `fixture_gen --shift` that makes it from a committed field trace |
| `tests/fixtures/restamp/sweep-grid.json` | WI-P1-6's grid of the STC constants (plan ch. 5 part 4.3), for `mrts_cli restamp-replay --sweep`; the criteria, the per-trace results and the constants chosen are in ADR-0029 |
| `tests/fixtures/cap-occ-1080i-h264-21aac-ttx.ts`, `.expect.jsonl` | The OCC recording's first 2 MB, every PID (H.264 1080i on the PCR PID, 21 AAC PIDs, teletext, a 514-byte PMT ahead of each PAT; drafted as `-mp2-ttx`, plan ch. 15.4 B-85) and its `mrts_cli dump`: the splitter pass-through tests (WI-P2-4) and `scn-split-passthrough` |
| `tests/fixtures/aligner/pipelines.json`, `scn-*.expect.json` | The aligner conformance set (WI-P2-14): the runner commands the real modules build, kept as a vitest file snapshot by `packages/engine/src/child-process/testing/alignerConformance.test.ts`, and each scenario's graph, inputs and pass bounds for `aligner_conformance_test.py` |

Every `tests/` directory stays in the repository and never reaches a box:
the image and the dist tarball prune them (WI-S0-13). Run the suites from a
checkout, never from `/opt`.

## Leaving the runtime, phase by phase (plan chapter 3 part 6.2)

| Phase | What goes or stops being loaded | Why then |
|---|---|---|
| 2 (done) | `tests/nativeSplitParity.test.ts` and `mrts_cli`'s splitter mode (WI-P2-4); the anchored stamper in `ts_timeline` (anchor, latch and latch repair, watch, staleness net, late/early tiers, drift servo, conditioner, their event JSON) with its tests, so `ts_timeline` keeps only `timing_pes` (WI-P2-2); the stamper's Python probe (WI-P2-3) and `unixfd-fanout.py` (WI-P2-5). `py/ts_split.py`, `py/native_parity_*.py` and `py/ts_timeline.py` stay as reference | Phase 2 deletes anchored stamping and the wire conditioner, and the splitter pass-through ends the byte parity |
| 3 | The last runtime importers of `py/ts_timeline.py` (branch retime and the align block), `native/mrts/ts_timeline.{h,cpp}` (its `timing_pes` moved into `ts_house`), the `ts_psi.h` forwarders, `native/mrpeshouse/` with the subtitle K recovery | Phase 3 deletes branch alignment, retime and K recovery |
| — | `py/ts_psi.py`, `py/ts_video_info.py`, `py/sps_parse.py` stay | The Python runner's `tsProbe` imports them (OQ-1) |

## Consumers

- **Both pipeline runners** load `native/mrtshouse/libgstmrtshouse.so`
  (`mrtsrestamp`, `mrasrc`, `mralignwatch`, `mrtsdemux`), `native/mrtsstamp/libgstmrtsstamp.so` and
  `native/mrlateness/libgstmrlateness.so` by explicit path, never
  `GST_PLUGIN_PATH`: the plugins tree first, then
  `/usr/libexec/media-router/mpegts-core/`. Without `libgstmrtshouse.so`, or
  with one below the runner's ABI, a module starts with `identity` in the
  restamp's and every `mralignwatch`'s place, `audioresample` in `mrasrc`'s
  (the PCM captures run unlocked at their device's nominal rate), and the
  alarm "Native TS module not loaded" (a pipeline naming `mrtsdemux`, which
  has no stand-in by design, is refused with that alarm); a live input add
  that names one of its elements is refused with that alarm, never stood in
  (B-17); without `libgstmrtsstamp.so` an egress runs unstamped with that
  alarm, in either runner (no Python stamper since Phase 2).
- **`libmrts.a`** is linked by `mrtsstamp`, `mrlateness`, `mrpeshouse` and
  `mrtshouse` here, by the engine's `mr-gst-runner`, by `ts-splitter`'s
  `mr-tssplit` and by `unixfdbus-core`'s `mr-bus-fanout`.
- **The Python runner** imports `ts_psi` and `ts_video_info` (`tsProbe`) and
  `ts_timeline`'s helpers (branch alignment and retime, until Phase 3) via the
  plugin PYTHONPATH.
- **TypeScript plugins** read ES descriptors through
  `@media-router/plugin-mpegts-core` (`engine/`).
