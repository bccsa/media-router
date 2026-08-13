#!/usr/bin/env python3
"""The native stamping backend: loading `mrtsstamp` and splicing it in.

`mrtsstamp` (plugins/mpegts-core/native/mrtsstamp) is a `GstBaseTransform`
wrapping `mrts::TimelineStamper` — the same object the native sidecars run, so
the contract still has one definition per language and not three. It is the
PREFERRED backend; `gst_stamp_probe` is the reference implementation and the
fallback for a box where the plugin is missing or fails to load, and everything
here is written so that failing is never fatal.

What forced the split is measurement, not taste: the python probe's remaining
cost is not TS parsing but fixed per-buffer overhead — PyGObject callback
dispatch and the whole-buffer `bytes` copy pygobject makes on every
`MapInfo.data` read — which no amount of optimising the python can remove (+323
ticks/min on a routed producer on .42, against ~18 for the same maths inside
mr-tssplit).

The elements are spliced in ONCE, before PLAYING (a graph change is only safe
while the pipeline is in NULL) and arrive INACTIVE; `active` is the lazy arm the
runner's bus_attach/bus_detach paths toggle. Inactive is basetransform
passthrough with `transform_ip_on_passthrough` off, so a disarmed egress never
sees the buffer at all and costs nothing.
"""
import os
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

from gst_stamp_events import ELEMENT_PREFIX  # noqa: E402

# tee name -> inserted `mrtsstamp` element. Mutated in place (never rebound) —
# `gst_bus_stamper` holds a reference to this same dict.
elements = {}


def so_paths():
    """Candidate paths for the native stamper plugin, in resolution order.

    Mirrors `nativeBinaries.ts::resolveNativeBinary` for the owning plugin
    (mpegts-core): the repo/deployed plugins tree first — a dev drop-in must be
    able to win — then the packaged install root. NOT GST_PLUGIN_PATH: a plugin
    on the global search path would be scanned into every GStreamer process on
    the box, and this one must only ever exist where the runner puts it.
    """
    so = "libgstmrtsstamp.so"
    here = os.path.dirname(os.path.abspath(__file__))
    # {src,dist}/child-process -> packages/engine -> repo root, as the TS
    # resolver walks it.
    plugins = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
        os.path.join(here, "..", "..", "..", "..", "plugins"))
    libexec = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
    return [os.path.join(plugins, "mpegts-core", "native", "mrtsstamp", so),
            os.path.join(libexec, "mpegts-core", so)]


def load_plugin():
    """Try to load the native stamper plugin. False => the python probe is used
    instead, unchanged. Never fatal: a box without the plugin still runs the
    contract, just at the python probe's cost. The CACHING of this outcome lives
    in `gst_bus_stamper.load_native` (one attempt per process)."""
    for path in so_paths():
        if not os.path.exists(path):
            continue
        try:
            plugin = Gst.Plugin.load_file(path)
        except Exception as e:  # noqa: BLE001 — any load failure is a fallback
            sys.stderr.write(f"[gst-runner.py] busStamp: mrtsstamp plugin at {path} "
                             f"failed to load ({e}) — falling back to the python "
                             f"probe\n")
            sys.stderr.flush()
            continue
        if plugin is None:
            continue
        sys.stderr.write(f"[gst-runner.py] busStamp: native stamper loaded "
                         f"(mrtsstamp {plugin.get_version()} from {path})\n")
        sys.stderr.flush()
        return True
    sys.stderr.write("[gst-runner.py] busStamp: no mrtsstamp plugin found "
                     f"({', '.join(so_paths())}) — falling back to the "
                     f"python probe\n")
    sys.stderr.flush()
    return False


def insert_elements(pipe):
    """Splice an inactive `mrtsstamp` in front of every `busout_*` tee.

    Element API, not pipeline strings: the TS-side `buildBusSink` fragment stays
    byte-identical, so with the contract off the graph a producer builds is the
    same graph it built before this existed. Inserted BEFORE the tee so one
    stamp fans out to every consumer edge — on a tee branch each branch would
    see a shared (non-writable) buffer and pay its own copy, and the branches
    are created and destroyed at runtime anyway.

    Inactive on arrival: `active` is the lazy arm, toggled from the same
    bus_attach / bus_detach paths that arm and disarm the python probe.
    """
    # Collect first, splice second: adding elements invalidates a live
    # GstIterator (RESYNC), and the walk is the only place we need it.
    tees = []
    it = pipe.iterate_elements()
    while True:
        result, element = it.next()
        if result != Gst.IteratorResult.OK:
            break
        if (element.get_name() or "").startswith("busout_"):
            tees.append(element)
    for tee in tees:
        name = tee.get_name()
        sink = tee.get_static_pad("sink")
        peer = sink.get_peer() if sink is not None else None
        if peer is None:
            sys.stderr.write(f"[gst-runner.py] busStamp: {name} has no upstream peer "
                             f"— not inserting mrtsstamp\n")
            sys.stderr.flush()
            continue
        stamp = Gst.ElementFactory.make("mrtsstamp", ELEMENT_PREFIX + name)
        if stamp is None:
            sys.stderr.write("[gst-runner.py] busStamp: mrtsstamp factory missing "
                             "— falling back to the python probe\n")
            sys.stderr.flush()
            return
        parent = tee.get_parent() or pipe
        parent.add(stamp)
        ok = (peer.unlink(sink)
              and peer.link(stamp.get_static_pad("sink")) == Gst.PadLinkReturn.OK
              and stamp.get_static_pad("src").link(sink) == Gst.PadLinkReturn.OK)
        if not ok:
            # Put the graph back the way it was rather than ship a half-spliced
            # pipeline; the python probe covers this tee instead.
            sys.stderr.write(f"[gst-runner.py] busStamp: could not splice mrtsstamp "
                             f"into {name} — falling back to the python probe\n")
            sys.stderr.flush()
            parent.remove(stamp)
            peer.link(sink)
            continue
        stamp.sync_state_with_parent()
        elements[name] = stamp
    if elements:
        sys.stderr.write("[gst-runner.py] busStamp: native stamper inserted on "
                         f"{', '.join(sorted(elements))}\n")
        sys.stderr.flush()


def activate(el, name):
    """Arm one spliced element. Setting `active` IS the whole arm: it resets the
    latch and takes the element out of passthrough, in that order."""
    el.set_property("active", True)
    sys.stderr.write("[gst-runner.py] busStamp: producer-stamped timeline "
                     f"armed on {name} (first consumer edge, native mrtsstamp)\n")
    sys.stderr.flush()


def deactivate(el):
    """Disarm one spliced element — drops the whole latch state, the same
    contract the probe's removal has (see `gst_bus_stamper.release`)."""
    try:
        el.set_property("active", False)
    except Exception:  # noqa: BLE001 — a disposed element is already disarmed
        pass


def drift_stats(el):
    """The element's `drift` property as the python probe's dict, or None while
    it has nothing to report."""
    s = el.get_property("drift")
    if s is None:
        return None
    return {k: s.get_value(k) for k in
            ("ppm", "slewNs", "marginNs", "engageNs", "samples", "window")}


def copy_count_note(el):
    """Disarm-time note for the runner's log. Buffers this egress could not be
    stamped in place on: expected 0 upstream of the tee (singly-owned buffer, no
    copy); anything else says something up the chain is holding a reference and
    every buffer is paying a shallow GstBuffer copy for it."""
    return f" (native, {el.get_property('copy-count')} non-writable buffers)"
