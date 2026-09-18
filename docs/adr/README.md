# Architecture Decision Records (ADRs)

This folder locks the architecture. Every record captures a decision that is
hard to reverse, would surprise a future reader, and was a real trade-off —
so nobody "fixes" something that was deliberate, and nobody re-litigates a
settled question without seeing why it was settled.

**Read this folder before changing the architecture** (moving code across
package/plugin boundaries, changing build contracts, changing how components
communicate). If your change conflicts with an ADR, either follow the ADR or
supersede it with a new one — don't silently diverge.

## Format

Sequential files: `NNNN-short-slug.md`. Keep them short — 1-3 sentences of
decision + why is a valid ADR. Optional sections only when they earn their
place: `Considered Options`, `Consequences`, `Status` (when superseded, mark
the old one `superseded by ADR-NNNN`). Number = highest existing + 1.

## Index

| ADR | Decision |
|---|---|
| [0001](0001-plugin-owned-native-and-python-code.md) | Plugins own their C++/python; shared base code lives in `<domain>-core` library plugins; plain-make contract, zero-registration discovery; amended by 0019 (the engine's own runner lives in `packages/engine/native/`) |
| [0002](0002-engine-core-stays-in-packages-engine.md) | Engine orchestration core stays in `packages/engine`; plugins depend on the engine, never the reverse (three recorded exceptions: name/path-only plugin lookups, the runner's per-buffer-adjacent stamper python, and mpegts-core TS sources compiled into the native runner) |
| [0003](0003-scoped-native-resolution-and-namespaced-install.md) | Native/python resolution is scoped to the requesting plugin; installs are namespaced under `/usr/libexec/media-router/<plugin>/`; ambiguity fails loud |
| [0004](0004-out-of-repo-plugins-injected-at-image-build.md) | Product-specific plugins may live in the consuming product's repo (under `media-router-plugin/`) and be injected into `plugins/` at image build |
| [0005](0005-time-sync-backend.md) | Monotonic house clock in every process; producers stamp bus PTS as contractual media time; `base_time=0`, playout offset D; linuxptp discipline for AES67/ST 2110 |
| [0006](0006-hardware-sinks-held-at-unity-gain.md) | Hardware PipeWire sinks are forced to unity gain on detection; all attenuation happens in software (`MR_PW_*` nodes / GStreamer) |
| [0007](0007-plugins-compute-ui-renders.md) | `packages/` holds only generic systems; UI widget vocabulary is generic and never module-specific; domain computation lives plugin-side and travels as data (`StatusGraph` → `x-widget: "graph"`) |
| [0008](0008-302m-fan-in-contract.md) | Every 302M fan-in: force-live mixers are clock-paced (`identity sync=true`), callers chain only from the returned `continuationName`, and one source bypasses the mixer — trading silence-fill for a restart |
| [0009](0009-probe-driven-shape-self-heal.md) | Probe-driven pipeline shapes re-probe on a 10 s timer while degraded and self-restart ONLY out of the fallback state; restarting a healthy pipeline stays forbidden ([[0005]]) |
| [0010](0010-bus-gate-defers-and-names.md) | A `bus_attach` arriving before the pipeline exists is queued and flushed at launch, never dropped; the socket-gate health warning names the upstream module and clears only its own warning; non-live heads (unixfdsrc, udpsrc) start the PLAYING deadline at first data and UDP silence is a warning state, not a rebuild (`gst_source_gate.py`); a consumer whose pipeline launched at or before its producer's current launch is relaunched on the producer's PLAYING (`BusFanoutCoordinator`) |
| [0011](0011-bus-buffers-are-access-units.md) | A bus buffer is one access unit, not a 1316 B datagram: the egress stamper coalesces the mux's per-AU lists; wire-facing outputs always re-chunk; no consumer may assume a buffer size |
| [0012](0012-runner-orchestration-in-the-engine-process.md) | `GstRunner` is hosted inside the engine process (no forked `gst-runner.js` per module); only the python pipeline runner is a child; the runner reaches the world through its `RunnerHost` seam and never `process`; `MR_GST_RUNNER_FORK=1` is the one-release rollback |
| [0013](0013-rist-bridge-as-native-elements.md) | RIST input/output run on native `mrristsrc`/`mrristsink` elements (rist-core, librist in C) instead of the runner's python appsrc/appsink drain; stats via `mrrist-stats` bus messages; the plugin is required, loaded by path, never `GST_PLUGIN_PATH` |
| [0014](0014-302m-stream-width.md) | A 302M stream is 2/4/6/8 channels wide and no more — wide desks are several producer modules; the producer declares its wire width via `getBusStreamChannels` (never its `channels` config); multichannel capture AND playback placement go through the device's whole width, unpositioned, with a `mix-matrix` (`pipewiresrc` in, `pulsesink` out) |
| [0015](0015-byte-cap-beside-every-time-bound.md) | Every time-bounded compressed-stream queue on the bus also sets `max-size-bytes` (64 Mbit/s × its time bound, ≥ 1 MiB, `tsQueueByteCap`) because a time-only bound goes unbounded when stamps stall; raw-video queues exempt |
| [0016](0016-subtitle-carrier-klv-webvtt.md) | Subtitles travel as KLV-wrapped WebVTT cues (`meta/x-klv`, cue times relative to the carrying PES — amended 2026-09-16) via `subtitle-core` (its python bridge rides the generic `runnerHooks` seam); renderers set `textoverlay`'s `text` from a video-pad probe, never the text pad |
| [0017](0017-media-agnostic-muxer-inputs.md) | Muxer inputs are media-agnostic: N generic `input-N` ports, ONE PID per input (the stream's output PID, next free when automatic, written back; amended 2026-09-18 — no PID blocks), every demuxed stream routed by class (video/audio/klv/subtitle) by the plugin's own runner hook `mux_routing` (a multi-stream source: highest class on the input's PID, the rest on the next free PIDs, decided from the source PMT; unrouted pads → fakesink; PCR picked video-first; no engine code); legacy `video-N`/`audio-N` ports keep the per-kind `muxSlotPid` ranges; the D2 name carousel is retired — identity = ISO 639 descriptors only |
| [0018](0018-conditioner-program-wide-steps.md) | The time-sync conditioner absorbs a source clock step ONCE per program: the reference (PCR-carrying) PID's step is the program's correction, every other PID — private ones included — adopts it when its own PTS shows the same jump (or at once when first seen); a PID stepping alone keeps a private correction (vMix pacer reset) that is released after 30 s if it never reverts (a branch alignment is placement, not a clock step) |
| [0019](0019-native-pipeline-runner.md) | A native C++ runner (`packages/engine/native/mr-gst-runner`, same JSON protocol) hosts every pipeline whose description stays inside its feature set, by default (`MR_GST_RUNNER_NATIVE=0` rolls the engine back to python, `runner` pins per module); python-only features (legacy librist stats, KLV payload, `preserveSourceTimeline`, stdio data, legacy net clock, hooks without a native form) keep the python runner; the runner refuses what the engine's eligibility list excludes so the two cannot drift |
| [0020](0020-native-runner-hooks.md) | A runner hook has a native form, `libmrhook_<module>.so` in the plugin's `native/<tool>/` behind the `mr_hook.h` C ABI (install/clear + emit callbacks), resolved like every native asset; the python module stays the reference; a description whose hooks all exist natively is eligible for the native runner, any other keeps its module on python |
| [0021](0021-discovered-port-retirement.md) | A discovery-materialised port (ts-splitter PID output) is retired only by a discovery event that omits it — a live source with a different PMT, never a dark one — and only when no STORED connection references it (`MediaRouter.hasStoredConnection`, the persisted graph, consumer active or not); a referenced-but-absent entry stays, flagged `stale`; the native child and bus channel are left alone until the next stop |
| [0022](0022-settings-help-text-contract.md) | Settings text = `title` heading + one-sentence (≤120 char) `description` in a "?" popover (`MrHelpTip`), never an inline paragraph; `title` is the field's name in form, array items and context menu; shared schema copies stay identical; lint test enforces caps; two tooltip idioms (`MrTooltip` for non-scrolling chrome, `MrHelpTip` for scroll boxes / touch) share one bubble style |
