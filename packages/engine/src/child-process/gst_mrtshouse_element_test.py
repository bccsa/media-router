#!/usr/bin/env python3
"""Tests for libgstmrtshouse.so (plan ch. 3 WI-S0-7): the plugin loads by path with
MRTSHOUSE_VERSION and registers its factory table at rank NONE; every element carries the
read-only `abi` (MRTSHOUSE_ABI) and part 10's counters. What each element does is its own
test's: mrtsrestamp, which took the placeholder probe's place, in gst_mrtsrestamp_element_test.py;
mrasrc in gst_mrasrc_element_test.py; mralignwatch in gst_mralignwatch_element_test.py.
Skips (exit 0) without GStreamer or the built plugin."""
import os
import re
import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtshouse_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

_HERE = os.path.dirname(os.path.abspath(__file__))
_SO = "libgstmrtshouse.so"
# Repo plugins tree first, then the packaged root, as the runners resolve it.
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
_LIBEXEC = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
_DIR = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse")
SO_PATHS = [os.path.join(_DIR, _SO), os.path.join(_LIBEXEC, "mpegts-core", _SO)]

# Part 10's counters (chapter 3), the properties every element of the plugin carries.
COUNTERS = ["desync-bytes", "cc-lost", "pes-oversize", "pes-dropped-cc", "header-spans",
            "psi-unsupported-sections", "pes-no-pts", "dts-discarded"]

_path = next((p for p in SO_PATHS if os.path.exists(p)), None)
if _path is None:
    print("SKIP gst_mrtshouse_element_test.py — mrtshouse plugin not built "
          f"({', '.join(SO_PATHS)}); run `make native`")
    sys.exit(0)
# A file that is there but does not load is a failure, not a skip: this raises.
plugin = Gst.Plugin.load_file(_path)

# The header the plugin was built from: beside a plugins-tree build, else this repository's.
_HDR = os.path.join(os.path.dirname(_path), "mrtshouse_abi.h")
if not os.path.exists(_HDR):
    _HDR = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core",
                                         "native", "mrtshouse", "mrtshouse_abi.h"))
with open(_HDR, encoding="utf-8") as fh:
    _abi_h = fh.read()
ABI = int(re.search(r"#define MRTSHOUSE_ABI (\d+)", _abi_h).group(1))
VERSION = re.search(r'#define MRTSHOUSE_VERSION "([^"]+)"', _abi_h).group(1)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def read_only(pspec):
    return bool(pspec.flags & GObject.ParamFlags.READABLE) and not (
        pspec.flags & GObject.ParamFlags.WRITABLE)


# --- the plugin and its factory table ----------------------------------------------------
check("plugin is named mrtshouse (entry symbol from libgstmrtshouse.so)",
      plugin.get_name() == "mrtshouse")
check(f"plugin version is MRTSHOUSE_VERSION ({VERSION})", plugin.get_version() == VERSION)
check("plugin source is media-router, license MIT/X11",
      plugin.get_source() == "media-router" and plugin.get_license() == "MIT/X11")
check("plugin loaded from the path given", plugin.get_filename() == _path)

factories = [f for f in Gst.Registry.get().get_feature_list_by_plugin("mrtshouse")
             if isinstance(f, Gst.ElementFactory)]
names = sorted(f.get_name() for f in factories)
check(f"the factory table registers mrtsrestamp, mrasrc and mralignwatch, the placeholder "
      f"probe gone (got {names})",
      "mrtsrestamp" in names and "mrasrc" in names and "mralignwatch" in names
      and "mrtshouse-probe" not in names)

for f in factories:
    name = f.get_name()
    check(f"{name}: rank NONE (placed by name, never auto-plugged)",
          f.get_rank() == Gst.Rank.NONE)
    el = f.create(None)
    abi = el.find_property("abi")
    check(f"{name}: `abi` is a read-only int with default MRTSHOUSE_ABI ({ABI})",
          abi is not None and abi.value_type == GObject.TYPE_INT and read_only(abi)
          and abi.default_value == ABI)
    check(f"{name}: `abi` reads MRTSHOUSE_ABI", el.get_property("abi") == ABI)
    try:
        el.set_property("abi", ABI + 1)
        refused = False
    except TypeError:
        refused = True
    check(f"{name}: `abi` refuses a write", refused and el.get_property("abi") == ABI)
    for c in COUNTERS:
        p = el.find_property(c)
        check(f"{name}: `{c}` is a read-only uint64, 0 when fresh",
              p is not None and p.value_type == GObject.TYPE_UINT64 and read_only(p)
              and el.get_property(c) == 0)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrtshouse_element_test.py")
    sys.exit(1)
print("\nALL gst_mrtshouse_element_test.py TESTS PASSED")
