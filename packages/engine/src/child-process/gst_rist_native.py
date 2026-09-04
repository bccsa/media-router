"""Loader for the native RIST elements (`mrristsink` / `mrristsrc`,
plugins/rist-core/native/mrrist/libgstmrrist.so).

Resolution mirrors `gst_stamp_native.so_paths` and nativeBinaries.ts for the
owning plugin (rist-core): the repo/deployed plugins tree first — a dev
drop-in must be able to win — then the packaged install root. Deliberately
NOT GST_PLUGIN_PATH: a plugin on the global search path would be scanned
into every GStreamer process on the box.

Unlike the stamper there is no python fallback for the ELEMENTS: a RIST module
pipeline that names `mrristsink`/`mrristsrc` fails at parse if the plugin is
missing, and the error names the paths searched. (The runner's `rist` config
path — python librist binding on an appsink/appsrc — still exists for
pipelines that ask for it.)
"""
import os
import sys

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

SO_NAME = "libgstmrrist.so"
_loaded = None   # None = not attempted, True/False = outcome (one attempt per process)


def so_paths():
    here = os.path.dirname(os.path.abspath(__file__))
    # {src,dist}/child-process -> packages/engine -> repo root, as the TS
    # resolver walks it.
    plugins = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
        os.path.join(here, "..", "..", "..", "..", "plugins"))
    libexec = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
    return [os.path.join(plugins, "rist-core", "native", "mrrist", SO_NAME),
            os.path.join(libexec, "rist-core", SO_NAME)]


def load_plugin():
    """Load the plugin once per process. Returns True when `mrristsink` and
    `mrristsrc` are registered (already or now), False otherwise."""
    global _loaded
    if _loaded is not None:
        return _loaded
    if Gst.ElementFactory.find("mrristsink") and Gst.ElementFactory.find("mrristsrc"):
        _loaded = True
        return True
    for path in so_paths():
        if not os.path.exists(path):
            continue
        try:
            plugin = Gst.Plugin.load_file(path)
        except Exception as e:  # noqa: BLE001 — report and try the next candidate
            sys.stderr.write(f"[gst-runner.py] mrrist: plugin at {path} failed to load ({e})\n")
            sys.stderr.flush()
            continue
        if plugin is None:
            continue
        sys.stderr.write(f"[gst-runner.py] mrrist: native RIST elements loaded "
                         f"(mrrist {plugin.get_version()} from {path})\n")
        sys.stderr.flush()
        _loaded = True
        return True
    sys.stderr.write(f"[gst-runner.py] mrrist: no {SO_NAME} found ({', '.join(so_paths())}) — "
                     f"RIST pipelines naming mrristsink/mrristsrc will fail to parse\n")
    sys.stderr.flush()
    _loaded = False
    return False
