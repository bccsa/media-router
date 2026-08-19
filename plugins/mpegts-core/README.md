# mpegts-core — MPEG-TS packet core (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Owns the MPEG-TS domain base code — the python reference modules AND
their C++ port live here together. See `plugins/README.md` → "Native &
Python code in plugins" for the build contract.

## Contents

| Path | What | Portability |
|---|---|---|
| `native/mrts/` | C++17 MPEG-TS packet core static lib: PSI parse/build + discovery (`ts_psi`), packet-level splitter (`ts_split`), H.264/H.265 SPS probe (`ts_video_info`, `sps_parse`), the timeline latch + egress stamper (`ts_timeline`, port of `py/ts_timeline.py`), and the `mrts_cli` test harness. `native/mrts/tests/` holds the C++ unit tests (ported from the `_test.py` scripts) | Any platform with a C++17 compiler |
| `native/mrtsstamp/` | `mrtsstamp` — GStreamer plugin (`libgstmrtsstamp.so`) wrapping `mrts::TimelineStamper`: the time-sync contract's producer-side egress stamper for **gst** producers (ADR-0005). A `GstBaseTransform` in in-place mode with a boolean `active` property (the lazy arm); the gst runner loads it by explicit path and splices one in front of every `busout_*` tee | Linux + GStreamer ≥ 1.24 dev headers (skipped by `make native` without them) |
| `py/ts_psi.py`, `py/ts_split.py`, `py/ts_video_info.py`, `py/sps_parse.py` | The python reference modules — the **executable specification** for `native/mrts`. The golden parity test drives both implementations over the same input and requires identical output bytes | Portable |
| `py/ts_timeline.py` | TS timeline shifter (`preserveSourceTimeline`) — imported lazily by the gst pipeline runner for the transcoder / audio-transcoder plugins — and `TimelineStamper`, the time-sync contract's producer-side egress stamper (ADR-0005), imported by `unixfd-fanout.py`. The stamper carries all three of the contract's recovery mechanisms: the discontinuity watch, the bounded-staleness net, and the drift slew that holds the arrival-vs-stamp margin against the source's crystal offset (`drift_stats()` is what the producers publish in their stats line) | Portable |
| `py/native_parity_fixture.py`, `py/native_parity_ref.py` | Deterministic synthetic MPTS generator + python-side runner mirroring `mrts_cli` — the parity-suite fixtures | Portable |
| `py/*_test.py` | Python unit tests for the reference modules (manual run: `python3 ts_split_test.py` from `py/`) | Portable |
| `tests/nativeSplitParity.test.ts` | Cross-language golden parity suite: builds the portable core via `native/build-host.sh`, runs python and C++ over identical chunking, compares every output PID byte-for-byte | — |

## Consumers

- The gst pipeline runner (engine) imports `ts_psi` / `ts_video_info` /
  `ts_timeline` from `py/` via the plugin PYTHONPATH (tsProbe,
  preserveSourceTimeline), and loads `native/mrtsstamp/libgstmrtsstamp.so` by
  explicit path (never GST_PLUGIN_PATH) for the egress stamp — falling back to
  the python probe in `gst-pipeline-runner.py` when it is absent.
- `ts-splitter` — links `libmrts.a` into its `mr-tssplit` child.
- `unixfdbus-core` — `mr-bus-fanout` links `libmrts.a` for `ts_timeline`;
  `unixfd-fanout.py` imports the python one (`--stamp-timeline`).
- `transcoder` / `audio-transcoder` — `preserveSourceTimeline`.
