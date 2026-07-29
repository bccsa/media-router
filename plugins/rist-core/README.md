# rist-core — RIST bindings (library plugin)

Library plugin: no `mediaRouter` manifest, never appears in the Add Module
panel.

`py/librist.py` holds the ctypes bindings for librist, imported lazily by the
gst pipeline runner (via the plugin PYTHONPATH) when a pipeline declares a
`rist` runner config — used by `rist-input` and `rist-output`.
