# Engine core stays in packages/engine

The engine's orchestration core — `routing/`, `modules/`, the child-process
management, and the gst pipeline runner — stays in `packages/engine` and is
NOT split into plugins. The dependency direction is one-way: plugins build
against `@media-router/engine`; the engine never imports plugin code. This
was considered and deliberately declined when the native/python code moved
into plugins ([[0001]]): stream-type executors and bus channel management are
the contract every plugin builds on, and moving them into plugins would
invert that dependency and create version skew across per-plugin engine
copies.

"Orchestration core" is the boundary, not "anything a plugin imports":
shared MEDIA-DOMAIN code is pulled the other way by [[0001]] and lives in a
`<domain>-core` library plugin. The SMPTE-302M TypeScript helpers moved out
on those grounds — `probe302mSupport` / `pacedMixer` / `buildAudioMixInput` /
`build302mEncodeBranch` / `mixMatrixClause` now live in
`plugins/audio-302m-core/`, which imports `@media-router/engine` (bus and
gst-inspect helpers) and is imported back by nothing in `packages/engine`.

Recorded exceptions:

1. **By name/path only (never an import):** the gst pipeline runner lazily
   `import`s python modules shipped by library plugins
   (`ts_psi`/`ts_video_info`/`ts_timeline` from mpegts-core, `librist` from
   rist-core) via the plugin PYTHONPATH, and `resolveNativeBinary()` scans
   plugin folders for binaries. Removing such a library plugin fails loud
   (ImportError in the runner / module health error), not silently.

2. **Per-buffer-adjacent python that stays in `packages/engine`:** the bus
   egress stamper (`src/child-process/gst_bus_stamper.py` + `gst_stamp_probe` /
   `gst_stamp_native` / `gst_stamp_events`), which [[0001]] would otherwise pull
   into a plugin because it runs on every buffer. It stays because it is
   GStreamer-runner code, not media logic: it installs pad probes on the
   runner's own pipeline, splices an element into it and translates its bus
   messages into the runner's engine events — none of which a plugin can reach.
   The condition on the exception is that it carries NO arithmetic: every
   timeline computation is delegated to mpegts-core's `ts_timeline` (exception 1
   above), which is what keeps [[0001]]'s "shared media maths lives in a
   `<domain>-core` plugin" intact. A stamper that grew its own maths would be
   breaking this ADR, not extending it.
