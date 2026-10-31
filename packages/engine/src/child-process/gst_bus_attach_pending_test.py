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
  - B-193: a teardown probe on the streaming thread leaves its record (and the
    attach waiting) to the main loop, one there drops it at once; a stop releases
    a still-detaching edge's path, and its late probe leaves a successor alone.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_bus_attach_pending_test.py
"""
import importlib.util
import os
import shutil
import socket
import sys
import tempfile
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
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


# ---------------------------------------------------------------------------
print("\n--- an edge still detaching: its record is the main loop's (B-193) ---")
reset()
events = collect_events()
ctx = GLib.MainContext.default()
ctx.acquire()   # this thread runs the main loop, as the runner's loop.run() does
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"
pipe = Gst.parse_launch(
    f'appsrc name=src is-live=true format=time caps="{TS_CAPS}" ! tee name={TEE} allow-not-linked=true')
src = pipe.get_by_name("src")
into_tee = [0]   # buffers into the tee: one in means the one before it has left it


def _into_tee(_pad, _info):
    into_tee[0] += 1
    return Gst.PadProbeReturn.OK


pipe.get_by_name(TEE).get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, _into_tee)
runner.pipeline = pipe
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)


def push():
    src.emit("push-buffer", Gst.Buffer.new_wrapped(b"\xff" * 1316))


def count(name, sock):
    return sum(1 for e in events if e["event"] == name and e.get("socket") == sock)


def items(it):
    out = []
    while True:
        res, item = it.next()
        if res == Gst.IteratorResult.RESYNC:
            it.resync()
            out.clear()
        elif res != Gst.IteratorResult.OK:
            return out
        else:
            out.append(item)


def hold_edge(sock):
    """Hold the next push into `sock`'s edge: the tee src pad stays in use, so the
    teardown probe cannot fire inside add_probe and fires on the streaming thread."""
    held, go = threading.Event(), threading.Event()

    def _hold(_pad, _info):
        held.set()
        go.wait(10)
        return Gst.PadProbeReturn.REMOVE

    for pad in items(pipe.get_by_name(TEE).iterate_src_pads()):
        peer = pad.get_peer()
        branch = peer.get_parent_element() if peer is not None else None
        if branch is not None and any(
                el.get_factory().get_name() == "unixfdsink"
                and el.get_property("socket-path") == runner._bus_bind_path(sock)
                for el in items(branch.iterate_recurse())):
            peer.add_probe(Gst.PadProbeType.BUFFER, _hold)
            return held, go
    return None, None


def wait(cond, loop=False, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        while loop and ctx.iteration(False):
            pass
        if cond():
            return True
        time.sleep(0.002)
    return False


def accepts(path):
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


def ino(path):
    try:
        return os.lstat(path).st_ino
    except OSError:
        return None


sock_s = os.path.join(sockdir, "edge-s.sock")
runner.handle_bus_attach({"tee": TEE, "socket": sock_s})
runner.handle_bus_detach({"socket": sock_s})
check("an idle pad: the probe fires on the main loop and drops the record at once",
      count("bus_detached", sock_s) == 1 and sock_s not in runner._bus_teardowns
      and not os.path.lexists(sock_s))
runner.handle_bus_attach({"tee": TEE, "socket": sock_s})
check("so an attach right after the detach binds at once",
      count("bus_attached", sock_s) == 2 and accepts(sock_s))

CYCLES = 10
deferred = kept = dropped = reattached = 0
for _cycle in range(CYCLES):
    held, go = hold_edge(sock_s)
    if held is None:
        break
    n0, det0, att0 = into_tee[0], count("bus_detached", sock_s), count("bus_attached", sock_s)
    push()
    if not held.wait(5):
        go.set()
        break
    runner.handle_bus_detach({"socket": sock_s})
    deferred += count("bus_detached", sock_s) == det0
    go.set()
    push()
    if not wait(lambda: into_tee[0] >= n0 + 2 and count("bus_detached", sock_s) > det0):
        break
    kept += sock_s in runner._bus_teardowns   # the main loop has not run since the detach
    dropped += wait(lambda: sock_s not in runner._bus_teardowns, loop=True)
    runner.handle_bus_attach({"tee": TEE, "socket": sock_s})
    reattached += count("bus_attached", sock_s) > att0
check(f"the probe waits for a held push, so it fires on the streaming thread: {deferred} of {CYCLES}",
      deferred == CYCLES)
check(f"its record stays until the main loop runs: {kept} of {CYCLES}", kept == CYCLES)
check(f"the main loop drops it, and an attach then binds at once: {dropped} and {reattached} of {CYCLES}",
      dropped == CYCLES and reattached == CYCLES)
runner.handle_bus_detach({"socket": sock_s})

sock_u = os.path.join(sockdir, "edge-u.sock")
runner.handle_bus_attach({"tee": TEE, "socket": sock_u})
held, go = hold_edge(sock_u)
n0 = into_tee[0]
push()
pending = held is not None and held.wait(5)
runner.handle_bus_detach({"socket": sock_u})
pending = pending and count("bus_detached", sock_u) == 0 and accepts(sock_u)
runner._clear_pending_bus_attaches()   # handle_stop, then _teardown_pipeline's first step
runner._release_bus_paths()
check("a stop while an edge's probe is still pending, its sink listening", pending)
check("the stop releases that edge's path too", not os.path.lexists(sock_u))
successor = None
if not os.path.lexists(sock_u):
    successor = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    successor.bind(sock_u)
    successor.listen(1)
successor_ino = ino(sock_u)
if go is not None:
    go.set()
push()
fired = wait(lambda: into_tee[0] >= n0 + 2 and count("bus_detached", sock_u) == 1)
check("the probe fires later and leaves the path a successor took since alone",
      fired and successor is not None and ino(sock_u) == successor_ino and accepts(sock_u))
if successor is not None:
    successor.close()
wait(lambda: sock_u not in runner._bus_teardowns, loop=True)
pipe.set_state(Gst.State.NULL)
ctx.release()

reset()
shutil.rmtree(sockdir, ignore_errors=True)

print()
if _failures:
    print(f"FAILED ({len(_failures)}): " + ", ".join(_failures))
    sys.exit(1)
print("gst_bus_attach_pending_test.py: all checks passed")
