# mpegts-core — MPEG-TS packet core (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Owns the MPEG-TS domain base code — the python reference modules AND
their C++ port live here together. See `plugins/README.md` → "Native &
Python code in plugins" for the build contract.

## Contents

| Path | What | Portability |
|---|---|---|
| `native/mrts/` | C++17 MPEG-TS packet core static lib: PSI parse/build + discovery (`ts_psi`), packet-level splitter (`ts_split`), H.264/H.265 SPS probe (`ts_video_info`, `sps_parse`), and the `mrts_cli` test harness. `native/mrts/tests/` holds the C++ unit tests (ported from the `_test.py` scripts) | Any platform with a C++17 compiler |
| `py/ts_psi.py`, `py/ts_split.py`, `py/ts_video_info.py`, `py/sps_parse.py` | The python reference modules — the **executable specification** for `native/mrts`. The golden parity test drives both implementations over the same input and requires identical output bytes | Portable |
| `py/ts_timeline.py` | TS timeline shifter (`preserveSourceTimeline`) — imported lazily by the gst pipeline runner for the transcoder / audio-transcoder plugins | Portable |
| `py/native_parity_fixture.py`, `py/native_parity_ref.py` | Deterministic synthetic MPTS generator + python-side runner mirroring `mrts_cli` — the parity-suite fixtures | Portable |
| `py/*_test.py` | Python unit tests for the reference modules (manual run: `python3 ts_split_test.py` from `py/`) | Portable |
| `tests/nativeSplitParity.test.ts` | Cross-language golden parity suite: builds the portable core via `native/build-host.sh`, runs python and C++ over identical chunking, compares every output PID byte-for-byte | — |

## Consumers

- The gst pipeline runner (engine) imports `ts_psi` / `ts_video_info` /
  `ts_timeline` from `py/` via the plugin PYTHONPATH (tsProbe,
  preserveSourceTimeline).
- `ts-splitter` — links `libmrts.a` into its `mr-tssplit` child.
- `transcoder` / `audio-transcoder` — `preserveSourceTimeline`.
