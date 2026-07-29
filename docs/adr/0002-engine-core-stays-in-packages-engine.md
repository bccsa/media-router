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

One recorded exception, by name/path only (never an import): the gst pipeline
runner lazily `import`s python modules shipped by library plugins
(`ts_psi`/`ts_video_info`/`ts_timeline` from mpegts-core, `librist` from
rist-core) via the plugin PYTHONPATH, and `resolveNativeBinary()` scans
plugin folders for binaries. Removing such a library plugin fails loud
(ImportError in the runner / module health error), not silently.
