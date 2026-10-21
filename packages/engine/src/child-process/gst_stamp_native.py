#!/usr/bin/env python3
"""The stamper's one backend: loading `mrtsstamp` (plugins/mpegts-core/native/mrtsstamp, a
`GstBaseTransform` on `mrts::IdentityStamp`) and splicing it in, the twin of mr-gst-runner's
stamper.cpp. There is no python fallback: without the plugin the egress runs unstamped and the
module carries the rule-6 alarm (`gst_bus_stamper.load_native`).

The elements are spliced in ONCE, before PLAYING (a graph change is only safe while the
pipeline is in NULL) and arrive INACTIVE; `active` is the lazy arm the runner's
bus_attach/bus_detach paths toggle. Inactive, an element only counts bytes (`bytes-total`, the
producer's throughput source, see `bytes_total`).
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


def _log(line):
    sys.stderr.write(f"[gst-runner.py] {line}\n")
    sys.stderr.flush()


def so_paths():
    """Candidate paths for the stamper plugin, in resolution order: the repo/deployed plugins
    tree first (a dev drop-in must be able to win), then the packaged install root, as
    `nativeBinaries.ts` resolves the owning plugin (mpegts-core). Never GST_PLUGIN_PATH: a
    plugin there would be scanned into every GStreamer process on the box."""
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
    """Load the stamper plugin: None, or why it is not loaded (the tried paths, a failed
    load's error), the alarm's detail. The caching lives in `gst_bus_stamper.load_native`."""
    tried = []
    for path in so_paths():
        if not os.path.exists(path):
            tried.append(path)
            continue
        try:
            plugin = Gst.Plugin.load_file(path)
        except Exception as e:  # noqa: BLE001 — report it and try the next candidate
            tried.append(f"{path} ({getattr(e, 'message', None) or e})")
            continue
        if plugin is None:
            tried.append(f"{path} (failed)")
            continue
        _log(f"busStamp: native stamper loaded (mrtsstamp {plugin.get_version()} from {path})")
        return None
    return f"libgstmrtsstamp.so not loaded, tried {', '.join(tried)}"


def egress_head(tee):
    """The link at the HEAD of `tee`'s egress chain, as (upstream src pad,
    downstream sink pad): walk upstream from the tee through the elements
    `buildBusSink` puts in front of it (capssetter, capsfilter, the mrlateness
    tap, which must read the stamp) and stop at the first other one — the mux. The stamper splices in
    THERE, not at the tee, so it is handed the mux's per-access-unit buffer
    LISTS intact: a GstBaseTransform (capssetter and capsfilter both are) has no
    chain_list, so the core dismantles a list into single buffers before the
    element's neighbour ever sees it — and the element's whole coalescing job
    (ADR-0011) is to merge each list into one bus buffer before that happens.
    Returns (None, None) when the tee has no upstream at all."""
    sink = tee.get_static_pad("sink")
    while sink is not None:
        peer = sink.get_peer()
        if peer is None:
            return None, None
        el = peer.get_parent_element()
        factory = el.get_factory() if el is not None else None
        fname = factory.get_name() if factory is not None else ""
        if fname not in ("capssetter", "capsfilter", "mrlateness"):
            return peer, sink
        sink = el.get_static_pad("sink")
    return None, None


def busout_tees(pipe):
    """Every `busout_*` tee of `pipe`."""
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
    return tees


def insert_elements(pipe, tees):
    """Splice an inactive `mrtsstamp` at the head of every egress in `tees`.

    Element API, not pipeline strings: the TS-side `buildBusSink` fragment stays
    byte-identical. Inserted BEFORE the tee so one stamp fans out to every
    consumer edge — on a tee branch each branch would see a shared
    (non-writable) buffer and pay its own copy, and the branches
    are created and destroyed at runtime anyway — and before the caps pair so
    the element sees the mux's buffer lists (`egress_head`). The list
    coalescing is not gated by `active`: it is a bus-format property of the
    egress, on from the first buffer.
    """
    for tee in tees:
        name = tee.get_name()
        peer, sink = egress_head(tee)
        if peer is None:
            _log(f"busStamp: {name} has no upstream peer — not inserting mrtsstamp")
            continue
        stamp = Gst.ElementFactory.make("mrtsstamp", ELEMENT_PREFIX + name)
        if stamp is None:
            _log("busStamp: mrtsstamp factory missing — egress will NOT be stamped")
            break
        parent = tee.get_parent() or pipe
        parent.add(stamp)
        ok = (peer.unlink(sink)
              and peer.link(stamp.get_static_pad("sink")) == Gst.PadLinkReturn.OK
              and stamp.get_static_pad("src").link(sink) == Gst.PadLinkReturn.OK)
        if not ok:
            # Put the graph back the way it was rather than ship a half-spliced pipeline.
            _log(f"busStamp: could not splice mrtsstamp into {name} — egress will NOT be stamped")
            parent.remove(stamp)
            peer.link(sink)
            continue
        stamp.sync_state_with_parent()
        elements[name] = stamp
    if elements:
        _log(f"busStamp: native stamper inserted on {', '.join(sorted(elements))}")


def activate(el, name):
    """Arm one spliced element: `active` forgets the stream and takes the element out of
    passthrough."""
    el.set_property("active", True)
    _log(f"busStamp: identity egress armed on {name} (PES - 1 h, native mrtsstamp)")


def deactivate(el):
    """Disarm one spliced element; it forgets the stream."""
    try:
        el.set_property("active", False)
    except Exception:  # noqa: BLE001 — a disposed element is already disarmed
        pass


def copy_count_note(el):
    """Disarm-time note for the runner's log. Buffers this egress could not be
    stamped in place on: expected 0 upstream of the tee (singly-owned buffer, no
    copy); anything else says something up the chain is holding a reference and
    every buffer is paying a shallow GstBuffer copy for it."""
    return f" (native, {el.get_property('copy-count')} non-writable buffers)"


def bytes_total(el):
    """Bytes that passed the element since it was spliced in (armed or not).
    The runner's throughput tracker reads this for a `busout_*` tee instead of
    installing a per-buffer python probe on the tee — that probe cost 0.5-0.7
    of a core per producer at 12 Mbps (Pi 4, 2026-09-02)."""
    return int(el.get_property("bytes-total"))
