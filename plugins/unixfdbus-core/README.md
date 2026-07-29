# unixfdbus-core — GstUnixFd bus transport (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Holds the base code for the inter-module GstUnixFd bus. See
`plugins/README.md` → "Native & Python code in plugins" for the build
contract and how other plugins consume this.

## Contents

| Path | What | Portability |
|---|---|---|
| `native/libmrbus/` | GstUnixFd bus transport static lib: fan-out server (per-client leaky send queues, CAPS-first, memfd + SCM_RIGHTS), raw-TS ingest buffering, stdin/stdout JSON control plane | Linux only (`memfd_create`, fd passing) |
| `native/mr-bus-fanout/` | Fan-out sidecar binary for non-GStreamer bus producers — drop-in replacement for `py/unixfd-fanout.py` (same CLI, control verbs, and events) | Linux only |
| `py/unixfd-fanout.py` | Python reference fan-out sidecar — the executable specification `mr-bus-fanout` is conformance-tested against | Linux only |
| `py/unixfd-test-server.py` | Upstream `unixfdsink` stand-in for integration tests (feeds a bus input edge, verifies RELEASE_BUFFER) | Linux only |
| `py/unixfd-fanout.test-client.py` | GstUnixFd protocol capture client used by the conformance and e2e suites | Linux only |
| `tests/unixfdFanout.test.ts` | GstUnixFd protocol conformance, parameterized over BOTH fan-out implementations against the same protocol clients (skips off-Linux) | — |

## Consumers

- The engine's bus fan-out per module (`unixfd-fanout.py` reference sidecar,
  `UnixFdFanoutController`).
- `hls-player` — prefers `mr-bus-fanout`, falls back to the python sidecar.
- `ts-splitter` — links `libmrbus.a` into its `mr-tssplit` child.
