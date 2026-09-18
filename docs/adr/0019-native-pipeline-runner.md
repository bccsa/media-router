# ADR-0019: A native pipeline runner hosts the modules whose pipelines need no python; the python runner stays for the rest

Each module's pipeline still runs in its own child process (ADR-0012), but
that child is now one of two binaries speaking the **same** stdin/stderr JSON
protocol: `gst-pipeline-runner.py` (python, the reference) or `mr-gst-runner`
(C++, `packages/engine/native/mr-gst-runner/`). The engine picks per
pipeline (`selectRunner`, `child-process/nativeRunner.ts`): a description that
stays inside the native runner's feature set runs natively — by default,
nothing to set — and everything else runs on python as before. A module can
pin either with `runner`; `MR_GST_RUNNER_NATIVE=0` is the engine-wide
rollback to python.

## Why

Measured on a 2 GB Pi 5 (10.9.16.50, 36 audio-matrix runners, 2026-09-16),
the same launch string run three ways, anonymous memory per process:

| Class | C `gst-launch` | minimal python | python runner | live runner |
|---|---|---|---|---|
| audio-input-302m | 8.6 MB | 22.4 MB | 29.2 MB | 31.0 MB |
| n1-mixer-302m | 7.8 MB | 22.1 MB | 28.7 MB | 29.1 MB |
| srt-output | 4.8 MB | 19.2 MB | 25.7 MB | 27.2 MB |

The GStreamer graph is 5–9 MB. The interpreter and PyGObject add a flat
~14 MB (`import gi` alone is 10 MB), and the runner's python-side runtime
state another ~6.5 MB — none of it the pipeline. Thirty-six runners were
1.05 GB of a 2 GB box; the native runner returns ~20 MB per module.

## What the native runner implements — and what it refuses

Everything the audio-matrix and wire-facing modules use: parse / PLAYING /
EOS-drain with the same 6 s budget the engine's kill windows are derived
from; the PLAYING watchdog and the non-live source gate (`waiting_for_data`,
`bus_producer_restarted`, udp silence); VU and `busReports` forwarding; live
`set_property` / `get_property`, element `get_stats` (off the main loop, as
python does for srt), throughput (native `bytes-total` on a stamped tee);
per-consumer bus fan-out edges with the stale-socket, mid-transition and
stall-watchdog handling of the python original, `bus_reinput`; the time-sync
contract's house clock and the `mrtsstamp` egress stamper with identical
events and log lines; `inputStallWatch`; avdec thread hooks. Stage 2
(2026-09-17) added the two presentation-leg subsystems: multi-branch stamp
alignment (`alignBranchesToStamps`) and the backlog shedder (`backlogShed`,
policy + post-shed stall watch), which move audio-output-302m and
audio-decoder over. The aligner parses TS through mpegts-core's `ts_psi` /
`ts_timeline` sources compiled in, exactly as mrtsstamp does. That is a
compile-time engine→plugin source dependency, which ADR-0002's exception 1
(name/path lookups at runtime) does not cover; ADR-0002 records it as its
exception 3, on the condition of its exception 2: the runner carries no TS
arithmetic of its own.

Stage 3 (same day) closed the video legs: `linkOnPadAdded` pad-link rules
with stream discovery (transcoder), the keyframe gate, the render keep-up
watch and the report-only TS video-info probe (video-player,
mpegts-ip-input), the `mrrist` plugin loaded by path (rist in/out), the
decoder-branch EOS drain through the gate pad, and runner hooks in their
native `.so` form (ADR-0020). The gates reuse mpegts-core's `ts_video_info` /
`sps_parse` sources the same way the aligner does.

It **refuses** (an `error` with `kind: 'unsupported'`) a start payload naming
`rist` (the legacy librist stats object), `readKlvNames` / `set_klv_payload`,
`preserveSourceTimeline`, `useStdioForData`, the legacy net `clock` without
the contract, or a `runnerHooks` module with no native form on disk.
`nativeRunnerIneligibility` in the engine is the same list (it resolves the
hook `.so` files itself), so the engine never sends such a payload natively;
the runner-side refusal is the loud guard against the two drifting apart.

The python-probe stamping fallback does not exist natively: a box without
`libgstmrtsstamp.so` runs the contract unstamped and says so (warning event +
log). The plugin ships in every image and is resolved the same way
(plugins tree, then `/usr/libexec/media-router/mpegts-core`).

## Consequences

- The binary lives in `packages/engine/native/mr-gst-runner/` — it is the
  runner, engine core (ADR-0002), not media-domain code. The root `Makefile`
  discovers `packages/engine/native/*/Makefile` next to `plugins/*/native/*`
  and installs it under `/usr/libexec/media-router/engine/` (ADR-0003's
  namespace, with `engine` as the owner).
- `json-glib` is a build AND runtime dependency (DEPENDS + RDEPENDS in the
  Yocto recipe); nothing else on the image pulls the library in.
- The engine passes `MR_PLUGINS_DIR` to every runner spawn so an installed
  binary finds the deployed plugins tree the way the python runner derives it
  from its own path.
- ADR-0001's "never inside `packages/engine`" is amended for this one
  binary (see its Status): the runner is engine core (ADR-0002), built and
  installed through the same plain-make contract and discovery as plugin
  native code.
- Runner hooks have a native form since ADR-0020 (mux_routing,
  subtitle_bridge); a pipeline naming a hook without one stays on python.
  Since Stage 3 every module's description is eligible unless it carries one
  of the refused fields above; the python runner remains the reference
  implementation and the rollback, not a feature tier.
- Protocol conformance is pinned black-box by
  `native_runner_protocol_test.py` (in `test:py`); the engine-side selection
  by `nativeRunner.test.ts`.
- Native was opt-in (`MR_GST_RUNNER_NATIVE=1`) for the first trial; after
  the clean 16 h soak on three boxes (2026-09-18) it is the default, so a
  fresh image runs native with no drop-in. Rollback: `MR_GST_RUNNER_NATIVE=0`
  engine-wide (a `media-router.service.d` drop-in) or `runner: 'python'` per
  module.

## References

- `packages/engine/native/mr-gst-runner/` — the runner (`runner.h` lists the feature set).
- `packages/engine/src/child-process/nativeRunner.ts` — eligibility and selection.
- `packages/engine/src/child-process/PythonProcess.ts` — the spawn site (one class, two binaries).
- [[0012]] — the process model this keeps; [[0005]] — the contract it must honour byte-for-byte.
