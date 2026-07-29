# Scoped native resolution and namespaced install

Native binaries and python sidecars resolve **scoped to the requesting
plugin**: `resolveNativeBinary(name, pluginId)` / `resolvePythonScript(name,
pluginId)` check the calling plugin's own folder first, so two plugins may
ship a tool with the same name without conflict. Installed binaries keep the
same namespacing on the image — `make native-install` places them at
`/usr/libexec/media-router/<plugin>/<tool>`, never flat `/usr/bin` — so dev
checkouts and installed systems behave identically.

Only two ambiguity cases remain, and both fail loud instead of silently
picking a winner:

1. A name resolved WITHOUT a scoping pluginId that ≥2 plugins ship — error
   log naming every match, resolution returns null → module health error.
2. Runner-imported python module filenames (python has one flat import
   namespace per process) — duplicate names across `plugins/*/py` dirs are
   reported by a fail-loud engine startup check.

`MR_NATIVE_BIN_DIR` remains the authoritative dev override for binaries;
`MR_PLUGINS_DIR` / `MR_LIBEXEC_DIR` override the scan roots (tests).
