"""Loads the `mrlateness` tap (libgstmrlateness.so, WI-P0-8) by path, never GST_PLUGIN_PATH:
plugins tree first, then the packaged root, as nativeBinaries.ts `resolveNativeAsset` does.
Loaded at runner start: a later `bus_input_add` may name it, so no pipeline string gates it."""
import os
import sys

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

SO_NAME = "libgstmrlateness.so"
_loaded = None   # None = not attempted, True/False = outcome (one attempt per process)


def so_paths():
    here = os.path.dirname(os.path.abspath(__file__))
    # {src,dist}/child-process -> packages/engine -> repo root, as the TS
    # resolver walks it.
    plugins = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
        os.path.join(here, "..", "..", "..", "..", "plugins"))
    libexec = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
    return [os.path.join(plugins, "mpegts-core", "native", "mrlateness", SO_NAME),
            os.path.join(libexec, "mpegts-core", SO_NAME)]


def load_plugin():
    """Load the plugin once per process. True when `mrlateness` is registered."""
    global _loaded
    if _loaded is not None:
        return _loaded
    if Gst.ElementFactory.find("mrlateness"):
        _loaded = True
        return True
    for path in so_paths():
        if not os.path.exists(path):
            continue
        try:
            plugin = Gst.Plugin.load_file(path)
        except Exception as e:  # noqa: BLE001 — report and try the next candidate
            sys.stderr.write(f"[gst-runner.py] mrlateness: plugin at {path} failed to load ({e})\n")
            sys.stderr.flush()
            continue
        if plugin is None:
            continue
        _loaded = True
        return True
    # One line: the engine leaves the taps out of its strings in this case too.
    sys.stderr.write(f"[gst-runner.py] mrlateness: no {SO_NAME} found ({', '.join(so_paths())}) "
                     f"— no lateness reported\n")
    sys.stderr.flush()
    _loaded = False
    return False
