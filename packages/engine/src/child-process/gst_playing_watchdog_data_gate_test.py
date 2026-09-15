"""Self-checking tests for the runner's DATA-GATED "reached PLAYING" watchdog.

`unixfdsrc` is not a live source. A bus consumer whose producer is connected
but DARK (an interlock-disabled encoder, a caller whose peer is down) therefore
sits ASYNC in PAUSED, and the blanket 10 s watchdog used to read that as a
wedge: `playing_timeout` error → restart → identical pipeline → 10 s → again.
Measured 2026-09-15 on the SCC French master: 940 rebuilds an hour for two dark
inputs, each one a PipeWire stream torn down and re-created, journald dropping
~145 lines every 30 s. `gst_source_gate.py`; engine side GstRunner.ts
`waiting_for_data` / `data_arrived` → `busGate`.

What is pinned here:
  - A unixfdsrc-headed pipeline on a connected, silent bus does NOT time out:
    no `playing_timeout` error, no watchdog armed, one `waiting_for_data`
    event (naming the socket) after the watchdog period, then nothing more.
  - The first buffer clears the wait: `data_arrived` is reported, the pipeline
    reaches PLAYING and the watchdog is not left armed.
  - A pipeline whose head IS live (audiotestsrc is-live) keeps the old
    behaviour: the watchdog is armed at start. (udpsrc is NOT live — it is
    gated too, see gst_udp_silence_test.py.)
  - `handle_stop` while waiting clears every probe and timer (no dangling
    warning fires after the pipeline is gone).

Skips (exit 0) where GStreamer / PyGObject / unixfdsink is unavailable.
Run:  python3 gst_playing_watchdog_data_gate_test.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import time

try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_playing_watchdog_data_gate_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

Gst.init([])
if Gst.ElementFactory.find("unixfdsink") is None or Gst.ElementFactory.find("unixfdsrc") is None:
    print("SKIP gst_playing_watchdog_data_gate_test.py — unixfd elements unavailable")
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


def spin(seconds):
    """Run the default GLib context for `seconds` (the runner's timers and
    idles live there; the test has no main loop of its own)."""
    ctx = GLib.MainContext.default()
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ctx.iteration(False)
        time.sleep(0.005)


sockdir = tempfile.mkdtemp(prefix="mr-data-gate-test-")
SOCK = os.path.join(sockdir, "edge.sock")
WATCHDOG_MS = 400

# A producer whose edge socket ACCEPTS but carries nothing: exactly a dark input.
producer = Gst.parse_launch(
    f"appsrc name=a is-live=true format=time ! unixfdsink socket-path={SOCK}")
producer.set_state(Gst.State.PLAYING)
producer.get_state(3 * Gst.SECOND)
time.sleep(0.2)

print("--- a dark unixfd bus waits instead of timing out ---")
events = collect_events()
runner.loop = None
runner.handle_start({"pipeline": f"unixfdsrc socket-path={SOCK} ! queue ! fakesink sync=false",
                     "playingTimeoutMs": WATCHDOG_MS})
check("the start is accepted", any(e["event"] == "started" for e in events)
      and runner.pipeline is not None)
check("the watchdog is NOT armed at start for a unixfdsrc head",
      runner.playing_watchdog_id is None and runner.source_gate.data_wait is not None)
spin(WATCHDOG_MS / 1000.0 * 3)
timeouts = [e for e in events if e["event"] == "error" and e.get("kind") == "playing_timeout"]
waits = [e for e in events if e["event"] == "waiting_for_data"]
check("three watchdog periods of silence produce no playing_timeout error", timeouts == [])
check("the pipeline is still up, parked in PAUSED", runner.pipeline is not None
      and runner.pipeline.get_state(0)[1] == Gst.State.PAUSED)
check("exactly one waiting_for_data report, naming the socket",
      len(waits) == 1 and waits[0].get("sockets") == [SOCK] and SOCK in waits[0]["message"])
check("and still no watchdog armed while dark", runner.playing_watchdog_id is None)

print("\n--- the first buffer clears the wait and the pipeline plays ---")
a = producer.get_by_name("a")
buf = Gst.Buffer.new_wrapped(bytes([0x47]) + bytes(187))
buf.pts = 0
buf.duration = Gst.SECOND // 50
a.emit("push-buffer", buf)
spin(1.0)
check("data_arrived is reported (so the health warning is cleared)",
      any(e["event"] == "data_arrived" for e in events))
check("the pipeline reached PLAYING",
      any(e["event"] == "state_change" and e["state"] == "playing" for e in events)
      and runner.pipeline.get_state(0)[1] == Gst.State.PLAYING)
check("the wait is gone and no watchdog is left armed after PLAYING",
      runner.source_gate.data_wait is None and runner.playing_watchdog_id is None)
check("still no playing_timeout error",
      not any(e["event"] == "error" and e.get("kind") == "playing_timeout" for e in events))
runner.handle_stop()
check("stop leaves nothing behind", runner.pipeline.get_state(0)[1] == Gst.State.NULL and runner.source_gate.data_wait is None)

print("\n--- a live head keeps the blanket deadline ---")
events = collect_events()
runner.handle_start({"pipeline": "audiotestsrc is-live=true ! fakesink sync=false",
                     "playingTimeoutMs": WATCHDOG_MS})
check("live head (audiotestsrc is-live): the watchdog is armed at start, no data wait",
      runner.playing_watchdog_id is not None and runner.source_gate.data_wait is None)
spin(0.5)
runner.handle_stop()

print("\n--- the producer restarts (socket re-created) while we wait: reconnect, do not strand ---")
events = collect_events()
runner.handle_start({"pipeline": f"unixfdsrc socket-path={SOCK} ! queue ! fakesink sync=false",
                     "playingTimeoutMs": WATCHDOG_MS})
check("waiting on the dark bus", runner.source_gate.data_wait is not None and runner.source_gate.data_wait["identity"].get(SOCK))
producer.set_state(Gst.State.NULL)
os.unlink(SOCK) if os.path.exists(SOCK) else None
producer = Gst.parse_launch(
    f"appsrc name=a is-live=true format=time ! unixfdsink socket-path={SOCK}")
producer.set_state(Gst.State.PLAYING)
producer.get_state(3 * Gst.SECOND)
spin(runner.source_gate.DATA_WAIT_POLL_MS / 1000.0 * 2.5)
gone = [e for e in events if e["event"] == "error" and e.get("kind") == "bus_producer_restarted"]
check("a re-created producer socket is reported as a restartable error within a poll or two",
      len(gone) == 1 and SOCK in gone[0]["message"])
check("and the wait is cleared (the normal restart path reconnects)", runner.source_gate.data_wait is None)
check("still no playing_timeout error",
      not any(e["event"] == "error" and e.get("kind") == "playing_timeout" for e in events))
runner.handle_stop()

print("\n--- stop while waiting clears probes and the pending warning ---")
events = collect_events()
runner.handle_start({"pipeline": f"unixfdsrc socket-path={SOCK} ! queue ! fakesink sync=false",
                     "playingTimeoutMs": WATCHDOG_MS})
check("waiting again on the same dark bus", runner.source_gate.data_wait is not None)
runner.handle_stop()
check("stop clears the wait immediately", runner.source_gate.data_wait is None)
spin(WATCHDOG_MS / 1000.0 * 2)
check("no waiting_for_data fires after the pipeline is gone",
      not any(e["event"] == "waiting_for_data" for e in events))

producer.set_state(Gst.State.NULL)
shutil.rmtree(sockdir, ignore_errors=True)

if _failures:
    print(f"\n{len(_failures)} FAILED:")
    for f in _failures:
        print("  - " + f)
    sys.exit(1)
print("\nAll data-gated PLAYING watchdog tests passed.")
