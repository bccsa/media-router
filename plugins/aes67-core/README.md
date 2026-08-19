# aes67-core — AES67 domain base code (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Owns everything the two AES67 plugins share, so the sending and
receiving ends of one stream cannot disagree about the session description or
the media clock. Pure stdlib python — see `plugins/README.md` → "Native &
Python code in plugins" for the layout contract, and ADR-0005 decision 7 (plus
its "Stage AES67" implementation notes) for the design.

## Contents

| Path | What | Portability |
|---|---|---|
| `py/aes67_sap.py` | SAP (RFC 2974) packets and the AES67 SDP (RFC 4566 + RFC 7273 clock attributes): build, parse, the 16-bit message id hash, and the discovery table with its ageing and deletion handling. No sockets — unit-testable without a network | Portable |
| `py/mr-sap.py` | The sidecar both plugins spawn: `--announce` re-sends a session every interval and DELETES it on shutdown; `--listen` maintains the table and emits full snapshots as JSON lines. I/O and lifecycle only | Linux/POSIX sockets |
| `py/aes67_clock.py` | The TAI↔house-clock arithmetic PTP-epoch RTP stamping is derived from, and the `disciplined` gate that refuses to claim the epoch on a box whose kernel TAI offset is unset. Also a CLI (`--json`) — how the TS side reads it, so the arithmetic has one definition | Linux (CLOCK_TAI) |
| `py/*_test.py` | Unit tests for both modules (`pnpm --filter @media-router/plugin-aes67-core test:py`, or `python3 aes67_sap_test.py` from `py/`) | Portable |
| `tests/aes67Gst.test.ts`, `tests/aes67_gst_probe.py` | Real-GStreamer suite: the RTP-timestamp mapping the epoch design rests on, the RFC 7273 caps round-trip through `gst_parse_launch`, and a bit-exact L24 RTP hop over loopback. Skips (loudly) where the elements are missing | Needs GStreamer + python-gi |
| `tests/sapSidecar.test.ts` | The sidecar end to end: one announcer, one listener, real sockets on 127.0.0.1 | Needs python3 |

## Consumers

- `aes67-input` — spawns `mr-sap.py --listen` for the stream picker.
- `aes67-output` — spawns `mr-sap.py --announce`, and runs `aes67_clock.py` to
  decide whether it may stamp RTP timestamps from the PTP epoch.

The pipeline-string helpers the two plugins share (caps, packet time, element
selection) live in `packages/engine/src/plugins/aes67Helpers.ts` with the other
launch-string builders — this folder is the python half of the domain only.
