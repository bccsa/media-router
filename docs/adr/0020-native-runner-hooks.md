# ADR-0020: A runner hook has a native form — `libmrhook_<module>.so` behind a C ABI — and a hook without one keeps its module on the python runner

`PipelineDescription.runnerHooks` (plugins/README.md, "Runner hooks") lets a
plugin ship pad-added logic, per-buffer probes and timers that run INSIDE the
pipeline runner. Under the python runner that is a python module in the
plugin's `py/` dir. Under the native runner (ADR-0019) the same hook is a
shared object in the plugin's `native/<tool>/` dir, `libmrhook_<module>.so`,
exporting three C functions (`packages/engine/native/mr-gst-runner/mr_hook.h`):

    int  mr_hook_abi(void);                                   // MR_HOOK_ABI
    int  mr_hook_install(GstElement* pipeline, const char* config_json, const MrHookCtx* ctx);
    void mr_hook_clear(void);

`config_json` is the entry's `config` verbatim; `ctx` carries `emit_event`
and `emit_plugin_event` — the two things the python `ctx` hands over — plus
`log`, one stderr line the runner prefixes (a python hook prints to stderr
itself). The runner resolves the `.so` the way every native asset is resolved
(the plugins tree, then `/usr/libexec/media-router/<plugin>/`; one owning
plugin, two owners fail loud), never `LD_LIBRARY_PATH`, and dlopens it
`RTLD_LOCAL`.

## Why

The python runner's per-module cost is the interpreter, not the pipeline
(ADR-0019). Embedding python into the native runner for the sake of hooks
would give that cost right back on exactly the modules that carry hooks
(muxer, transcoder, players). A C ABI keeps the seam the python hooks
established — plugin-owned, config-driven, engine ignorant of the domain
(ADR-0002, ADR-0017) — at native cost.

## Rules

- **The python module stays the reference.** A native hook is a port of the
  python one: same config, same events, same log lines, same names. The
  python suite (`py/<module>_test.py`) pins the behaviour; the native form is
  pinned black-box through the runner protocol suite
  (`native_runner_protocol_test.py`), driving the real elements.
- **Eligibility is on disk.** `nativeRunnerIneligibility` accepts a
  description's `runnerHooks` only when every module resolves to a
  `libmrhook_<module>.so` (`resolveNativeHook`). A module whose hook exists
  only as python is hosted on the python runner, silently and correctly. The
  native runner still refuses (`kind: 'unsupported'`) a hook it cannot find,
  as the loud guard against the two lists drifting.
- **A hook fault is never a pipeline fault.** Load or install failures are
  warnings and the hook is skipped, as with python. The ABI version is checked
  before anything is called.
- **One module per process.** A pipeline names a hook module at most once;
  the `.so` keeps its state in file scope, like the python module does.
- **Build and install** follow ADR-0001/0003: the plugin's own plain
  `Makefile` under `native/<tool>/`, discovered by the root `make native`,
  installed to `/usr/libexec/media-router/<plugin>/`. The ABI header is
  reached through `MR_PLUGINS_DIR/../packages/engine/native/mr-gst-runner`
  (plugins depend on the engine, never the reverse).

## Consequences

- `plugins/mpegts-muxer/native/mux-routing/` (`mux_routing`) and
  `plugins/subtitle-core/native/subtitle-bridge/` (`subtitle_bridge`, with a
  header-only twin of the KLV cue codec) are the two native hooks; the
  mpegts-muxer and teletext-subtitles moved to the native runner with them,
  transcoder and video-player with ADR-0019's Stage 3 (the video gates,
  same day).
- A new hook ships both forms or accepts staying on python; the README's
  hook section says so.

## References

- `packages/engine/native/mr-gst-runner/mr_hook.h` — the ABI; `hooks.cpp` — resolution and loading.
- `packages/engine/src/child-process/nativeRunner.ts` — `resolveNativeHook`, eligibility.
- `plugins/mpegts-muxer/native/mux-routing/mux_routing.cpp` — the reference port.
- [[0019]] — the native runner; [[0017]] — the muxer routing this ports.
