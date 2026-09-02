#!/usr/bin/env python3
"""Self-checking tests for the runner's throughput tracker.

What is pinned here:
  --  FALLBACK probe: counts single buffers AND buffer lists (an mpegtsmux
      emits lists; a BUFFER-only probe upstream of any basetransform was blind
      to them, and downstream of one it fired per dismantled buffer).
  --  NATIVE path: for a `busout_*` tee whose `mrtsstamp` element the stamper
      subsystem spliced in, get_throughput reads the element's `bytes-total`
      and no python probe runs on the streaming thread (the fix for the
      0.5-0.7 core per producer burn, 2026-09-02).

Skips (exit 0) where GStreamer / PyGObject is unavailable.
"""
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except Exception:  # pragma: no cover - env gate
    print("SKIP gst_track_throughput_test.py — GStreamer/PyGObject unavailable")
    sys.exit(0)

_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
Gst.init(sys.argv)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def collect_events():
    events = []
    runner.emit_event = lambda obj: events.append(obj)
    return events


def reset():
    runner.throughput_trackers.clear()
    runner.gst_bus_stamper.elements.clear()
    runner.pipeline = None


TEE = "busout_41000"


def build_pipe():
    pipe = Gst.parse_launch(
        f"appsrc name=src format=bytes is-live=true ! tee name={TEE} allow-not-linked=true "
        f"{TEE}. ! queue name=edgeq ! fakesink sync=false async=false")
    return pipe, pipe.get_by_name("src")


def push_and_drain(pipe, src, singles, list_sizes):
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    for n in singles:
        src.emit("push-buffer", Gst.Buffer.new_allocate(None, n, None))
    if list_sizes:
        bl = Gst.BufferList.new()
        for n in list_sizes:
            bl.insert(-1, Gst.Buffer.new_allocate(None, n, None))
        src.emit("push-buffer-list", bl)
    src.emit("end-of-stream")
    bus = pipe.get_bus()
    bus.timed_pop_filtered(5 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)


def total_bytes(events):
    ev = [e for e in events if e.get("event") == "throughput"]
    return ev[-1]["data"][TEE]["total_bytes"] if ev else None


# ---------------------------------------------------------------------------
print("--- fallback probe counts single buffers and whole buffer lists ---")
reset()
events = collect_events()
pipe, src = build_pipe()
runner.pipeline = pipe
runner.handle_track_throughput({"element": TEE, "pad": "sink"})
check("tracking acked on the tee sink pad",
      any(e.get("event") == "tracking" and e.get("element") == TEE for e in events))
check("no native element → python probe path (tracker has no 'native')",
      "native" not in runner.throughput_trackers[TEE])
push_and_drain(pipe, src, singles=[188, 376, 1316], list_sizes=[1316, 1316, 1316, 940])
runner.handle_get_throughput({})
got = total_bytes(events)
check(f"total_bytes == singles + list ({got} of {188 + 376 + 1316 + 1316 * 3 + 940})",
      got == 188 + 376 + 1316 + 1316 * 3 + 940)

# ---------------------------------------------------------------------------
print("\n--- native path: a spliced mrtsstamp's bytes-total is read, no probe installed ---")
reset()
events = collect_events()
pipe, src = build_pipe()
runner.pipeline = pipe


class FakeStamp:
    """Stands in for the spliced `mrtsstamp`: only `bytes-total` is read."""
    def __init__(self):
        self.total = 4242

    def get_property(self, name):
        assert name == "bytes-total", name
        return self.total


fake = FakeStamp()
runner.gst_bus_stamper.elements[TEE] = fake
runner.handle_track_throughput({"element": TEE, "pad": "sink"})
check("tracker bound to the native element",
      runner.throughput_trackers[TEE].get("native") is fake)
push_and_drain(pipe, src, singles=[188, 188], list_sizes=[])
runner.handle_get_throughput({})
check(f"total_bytes comes from the element, not the pushed bytes ({total_bytes(events)} == 4242)",
      total_bytes(events) == 4242)
fake.total = 5000
runner.handle_get_throughput({})
check("and follows the element's counter on the next poll (5000)", total_bytes(events) == 5000)

print("\n--- only a SINK-pad request on the tee uses the native counter ---")
# The element counts what enters the tee; a src-pad request (here on the edge
# queue, which has a static src pad — a tee's src pads are request pads) is a
# different measuring point and must stay on the probe even when an element
# is registered under that name.
reset()
events = collect_events()
pipe, src = build_pipe()
runner.pipeline = pipe
runner.gst_bus_stamper.elements["edgeq"] = FakeStamp()
runner.handle_track_throughput({"element": "edgeq", "pad": "src"})
check("src-pad tracking falls back to the probe",
      "edgeq" in runner.throughput_trackers and "native" not in runner.throughput_trackers["edgeq"])
push_and_drain(pipe, src, singles=[188, 188], list_sizes=[])
runner.handle_get_throughput({})
ev = [e for e in events if e.get("event") == "throughput"]
check(f"and counts the real bytes on that pad ({ev[-1]['data']['edgeq']['total_bytes']} of 376)",
      ev[-1]["data"]["edgeq"]["total_bytes"] == 376)

if _failures:
    print(f"\n{len(_failures)} throughput tracker test(s) FAILED")
    sys.exit(1)
print("\nAll throughput tracker tests passed.")
