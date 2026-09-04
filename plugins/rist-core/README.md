# rist-core — RIST domain code (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel. Used by `rist-input` and `rist-output`.

- `native/mrrist/` — GStreamer plugin with `mrristsrc` / `mrristsink`, librist
  in C (ADR-0013). Built by `make native`, installed to
  `/usr/libexec/media-router/rist-core/libgstmrrist.so`, loaded by the runner
  via `gst_rist_native.py` (never `GST_PLUGIN_PATH`). Stats are posted as
  `mrrist-stats` bus messages carrying librist's JSON.
- `py/librist.py` — ctypes bindings for librist, the LEGACY path: imported by
  the runner only when a pipeline declares a `rist` runner config. Kept as the
  fallback and reference until the elements have field time; `librist_test.py`
  covers its librist-quirk handling (`pnpm run test:py`).
