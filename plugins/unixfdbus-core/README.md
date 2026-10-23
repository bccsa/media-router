# unixfdbus-core — GstUnixFd bus transport (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Holds the base code for the inter-module GstUnixFd bus. See
`plugins/README.md` → "Native & Python code in plugins" for the build
contract and how other plugins consume this.

## Contents

| Path | What | Portability |
|---|---|---|
| `native/libmrbus/` | GstUnixFd bus transport static lib: fan-out server (per-client leaky send queues, CAPS-first, memfd + SCM_RIGHTS), raw-TS ingest buffering, stdin/stdout JSON control plane | Linux only (`memfd_create`, fd passing) |
| `native/mr-bus-fanout/` | Fan-out sidecar binary for non-GStreamer bus producers (hls-player): moves the TS onto house time (`house_rebase.{h,cpp}`, tested by `tests/house_rebase_test.cpp`) and stamps each buffer by identity. `tests/house_rebase_ref.cpp` replays a chunk trace through the rebase for the Python reference's parity; with `HOUSE_REBASE_TRACE=<file>` the C++ suite records its own chunks there. Both are built by `make test`, never installed | Linux only |
| `py/house_rebase.py` | The Python reference of the rebase (plan ch. 15.4 B-55), rule for rule as built, with the mrts pieces it reads (packet walk, PES header and split-header span, PCR, unwrap, PSI discovery). Nothing loads it at runtime; as a script it replays a chunk trace as `tests/house_rebase_ref` does | Any (stdlib) |
| `py/house_rebase_test.py` | `tests/house_rebase_test.cpp` case by case on the reference, the same checks in the same order (`test:py`) | Any |
| `py/house_rebase_parity_test.py`, `py/house_rebase_parity_fixture.py` | The reference's C++ output parity (`test:py`): both suites pass and record byte-identical inputs; those, hls-pipe's inline-AV output across EXT-X-DISCONTINUITY (modelled on its muxer and the paced sink: no hls-pipe recording exists), random programs and mpegts-core's conformance recordings go through `tests/house_rebase_ref` and the reference, and every PES PTS and DTS, PCR and DI, every byte and the stats must agree. Builds the C++ tools as `make test` does | Linux only (skips elsewhere) |
| `py/unixfd-test-server.py` | Upstream `unixfdsink` stand-in for integration tests (feeds a bus input edge, verifies RELEASE_BUFFER) | Linux only |
| `py/unixfd-fanout.test-client.py` | GstUnixFd protocol capture client used by the conformance and e2e suites | Linux only |
| `tests/unixfdFanout.test.ts` | GstUnixFd protocol conformance of `mr-bus-fanout` and its house time on the wire, against the python protocol clients (skips off-Linux) | — |

## Consumers

- The engine's `UnixFdFanoutController`, which drives `mr-bus-fanout`'s
  control verbs.
- `hls-player` — runs `mr-bus-fanout`; there is no fallback.
- `ts-splitter` — links `libmrbus.a` into its `mr-tssplit` child.
