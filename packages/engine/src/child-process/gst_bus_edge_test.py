#!/usr/bin/env python3
"""Self-checking test for the per-consumer bus edge branch in gst-pipeline-runner.py.

The branch is `queue leaky=2 ! unixfdsink` and every property on it is
load-bearing (see `_try_bus_attach`). This pins the shape through a REAL
`Gst.parse_bin_from_description` so a typo in the description string, or a
lost bound, fails here rather than on a production box. In particular the
byte cap: a time-only leaky queue is unbounded once the stream's timestamps
stall (gate01, 2026-09-06 — five muxers at 2.8 GB each).

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_bus_edge_test.py
"""
import importlib.util
import os
import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_bus_edge_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


desc = runner.bus_edge_branch_description("/tmp/mr-bus-40000-abc123.sock")
check("byte cap is 500 ms at 64 Mbit/s", runner.BUS_EDGE_QUEUE_MAX_BYTES == 4_000_000)
check("time bound is 5 s — past any in-place re-anchor step, so a forward stamp step never leaks a buffer",
      runner.BUS_EDGE_QUEUE_MS == 5_000)
check(
    "description pins the byte cap next to the time bound",
    "max-size-time=5000000000 max-size-buffers=0 max-size-bytes=4000000" in desc,
)

if Gst.ElementFactory.find("unixfdsink") is None:
    print("SKIP parse check — unixfdsink not available in this GStreamer")
else:
    bin_ = Gst.parse_bin_from_description(desc, True)
    queue = sink = None
    it = bin_.iterate_elements()
    while True:
        ok, el = it.next()
        if ok != Gst.IteratorResult.OK:
            break
        name = el.get_factory().get_name()
        if name == "queue":
            queue = el
        elif name == "unixfdsink":
            sink = el
    check("branch parses into queue + unixfdsink", queue is not None and sink is not None)
    if queue is not None:
        check("queue is leaky downstream (drops oldest)", int(queue.get_property("leaky")) == 2)
        check("queue time bound is 5 s", queue.get_property("max-size-time") == 5_000_000_000)
        check("queue buffer count is unbounded", queue.get_property("max-size-buffers") == 0)
        check(
            "queue byte bound is the edge cap",
            queue.get_property("max-size-bytes") == runner.BUS_EDGE_QUEUE_MAX_BYTES,
        )
    if sink is not None:
        check("sink does not sync to clock", sink.get_property("sync") is False)
        check("sink is not async", sink.get_property("async") is False)
        check(
            "sink does not block waiting for a client",
            sink.get_property("wait-for-connection") is False,
        )
        check(
            "sink binds the consumer's edge socket",
            sink.get_property("socket-path") == "/tmp/mr-bus-40000-abc123.sock",
        )

if _failures:
    print(f"\n{len(_failures)} bus edge test(s) FAILED")
    sys.exit(1)
print("\nAll bus edge tests passed.")
