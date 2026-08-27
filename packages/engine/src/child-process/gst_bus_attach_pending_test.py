#!/usr/bin/env python3
"""Self-checking tests for the runner's PENDING bus-attach queue.

A `bus_attach` can legitimately arrive before `start`: the engine now queues
attaches for a producer whose own unixfd input gate hasn't opened yet
(`GstRunner`'s queue) and flushes them at launch, and GLib dispatches both
commands onto the same main context. `_try_bus_attach` used to open with

    if pipeline is None:
        return True

so `_attach_or_queue` / `_retry_pending_bus_attaches` treated a pipeline-less
attach as DONE and popped it: the branch was never built, and every consumer of
that edge waited forever on a socket nobody would create ("Waiting for producer
bus socket(s)").

What is pinned here:

  - An attach with no pipeline stays PENDING and arms the 250 ms retry — the
    same treatment as the already-covered "tee not created yet" case.
  - That pending attach is SATISFIED once a pipeline appears: the retry builds
    the real branch on the real tee and emits `bus_attached`.
  - `bus_detach` cancels a still-pending attach (nothing is left to flush).
  - The one-shot ~10 s warning names what is actually missing (the pipeline),
    not a tee no pipeline could contain.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_bus_attach_pending_test.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_bus_attach_pending_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path so the
# runner's lazy plugin imports resolve.
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

Gst.init(sys.argv)

if Gst.ElementFactory.find("unixfdsink") is None:  # pragma: no cover - env gate
    print("SKIP gst_bus_attach_pending_test.py — unixfdsink unavailable")
    sys.exit(0)

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
    runner._pending_bus_attaches.clear()
    runner._bus_teardowns.clear()
    runner._bus_branches.clear()
    runner._bus_retry_timer_id = None
    runner.pipeline = None


sockdir = tempfile.mkdtemp(prefix="mr-bus-attach-test-")
TEE = "busout_41000"


def build_producer_pipe():
    """A producer's egress tee, exactly what a bus_attach resolves against."""
    return Gst.parse_launch(
        "fakesrc num-buffers=0 ! tee name=%s allow-not-linked=true" % TEE)


# ---------------------------------------------------------------------------
print("--- an attach with no pipeline stays pending (never silently dropped) ---")
reset()
events = collect_events()
sock_a = os.path.join(sockdir, "edge-a.sock")
runner.handle_bus_attach({"tee": TEE, "socket": sock_a})
check("the attach is queued rather than popped",
      list(runner._pending_bus_attaches) == [sock_a])
check("and it remembers the tee it was aimed at",
      runner._pending_bus_attaches.get(sock_a, [None])[0] == TEE)
check("the 250 ms retry timer is armed", runner._bus_retry_timer_id is not None)
check("nothing was attached and no branch invented",
      runner._bus_branches == {}
      and not any(e["event"] == "bus_attached" for e in events))

# A retry round with STILL no pipeline must not drop it either.
runner._retry_pending_bus_attaches()
check("a retry round with no pipeline keeps it pending",
      list(runner._pending_bus_attaches) == [sock_a]
      and runner._pending_bus_attaches[sock_a][1] == 1)


# ---------------------------------------------------------------------------
print("\n--- the pending attach is satisfied once the pipeline exists ---")
pipe = build_producer_pipe()
runner.pipeline = pipe
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
keep_going = runner._retry_pending_bus_attaches()
check("the retry builds the branch the moment the pipeline is up",
      sock_a in runner._bus_branches)
check("and the queue empties", runner._pending_bus_attaches == {})
check("the timer stops itself once the queue is empty",
      keep_going is False and runner._bus_retry_timer_id is None)
check("with the real socket served by a real unixfdsink",
      os.path.exists(sock_a))
check("and the attach is announced",
      any(e["event"] == "bus_attached" and e["socket"] == sock_a for e in events))

runner.handle_bus_detach({"socket": sock_a})
pipe.set_state(Gst.State.NULL)


# ---------------------------------------------------------------------------
print("\n--- bus_detach cancels a still-pending attach ---")
reset()
events = collect_events()
sock_b = os.path.join(sockdir, "edge-b.sock")
runner.handle_bus_attach({"tee": TEE, "socket": sock_b})
check("queued while there is no pipeline",
      list(runner._pending_bus_attaches) == [sock_b])
runner.handle_bus_detach({"socket": sock_b})
check("the detach removes it from the queue", runner._pending_bus_attaches == {})
# The pipeline arriving afterwards must not resurrect the cancelled edge.
pipe = build_producer_pipe()
runner.pipeline = pipe
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
runner._retry_pending_bus_attaches()
check("and a later pipeline does not resurrect it",
      runner._bus_branches == {} and not os.path.exists(sock_b))
pipe.set_state(Gst.State.NULL)


# ---------------------------------------------------------------------------
print("\n--- the ~10 s warning names what is actually missing ---")
reset()
events = collect_events()
sock_c = os.path.join(sockdir, "edge-c.sock")
runner._pending_bus_attaches[sock_c] = [TEE, runner._BUS_ATTACH_WARN_AFTER - 1]
runner._retry_pending_bus_attaches()
warns = [e for e in events if e["event"] == "warning"]
check("one warning, and it blames the missing pipeline (not a phantom tee)",
      len(warns) == 1
      and "pipeline not up yet" in warns[0]["message"]
      and sock_c in warns[0]["message"])
check("still retrying afterwards", list(runner._pending_bus_attaches) == [sock_c])

# Same round with a pipeline present but no such tee: the tee wording stands.
reset()
events = collect_events()
pipe = Gst.parse_launch("fakesrc num-buffers=0 ! fakesink")
runner.pipeline = pipe
runner._pending_bus_attaches[sock_c] = [TEE, runner._BUS_ATTACH_WARN_AFTER - 1]
runner._retry_pending_bus_attaches()
warns = [e for e in events if e["event"] == "warning"]
check("a pipeline without the tee still warns about the tee",
      len(warns) == 1 and f"tee {TEE} not up yet" in warns[0]["message"])
pipe.set_state(Gst.State.NULL)

reset()
shutil.rmtree(sockdir, ignore_errors=True)

print()
if _failures:
    print(f"FAILED ({len(_failures)}): " + ", ".join(_failures))
    sys.exit(1)
print("gst_bus_attach_pending_test.py: all checks passed")
