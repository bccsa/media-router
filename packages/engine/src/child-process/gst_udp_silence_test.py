"""Self-checking tests for udpsrc SILENCE as a state (gst_source_gate.py).

`udpsrc` posts `GstUDPSrcTimeout` every `timeout` of silence. The runner used
to turn that into a fatal error and rebuild the whole producer on its restart
backoff — on .103 an mpegts-ip-input whose feed paused rebuilt every ~15 s,
destroying every consumer edge each time, for a listening socket that needed
nothing. Now:

  - the first timeout emits `input_silent` ONCE; the pipeline stays PLAYING,
    no error, no teardown, later timeouts are silent themselves;
  - the first packet back emits `input_resumed` (once), and a later silence
    starts a fresh `input_silent`;
  - `udpSilenceRestartMs` (mpegts-ip-input sets it for MULTICAST only) turns a
    silence past that bound into the old `udp_timeout` error → restart path;
  - stop clears the watch.

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run:  python3 gst_udp_silence_test.py
"""
import importlib.util
import os
import socket
import sys
import time

try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_udp_silence_test.py — GStreamer unavailable ({exc})")
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
if Gst.ElementFactory.find("udpsrc") is None:
    print("SKIP gst_udp_silence_test.py — udpsrc unavailable")
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
    ctx = GLib.MainContext.default()
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ctx.iteration(False)
        time.sleep(0.005)


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def send_ts_packet(port, n=3):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for _ in range(n):
        s.sendto(bytes([0x47]) + bytes(187), ("127.0.0.1", port))
    s.close()


TIMEOUT_NS = 300_000_000            # udpsrc silence timeout for the test: 300 ms
CAPS = 'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188"'

print("--- silence is reported once and the pipeline stays up ---")
events = collect_events()
runner.loop = None
port = free_port()
runner.handle_start({"pipeline": f"udpsrc name=netsrc port={port} timeout={TIMEOUT_NS} {CAPS} ! fakesink sync=false",
                     "playingTimeoutMs": 400})
check("the pipeline starts (udpsrc is not live: it parks in PAUSED until data)",
      runner.pipeline is not None and any(e["event"] == "started" for e in events))
check("the PLAYING watchdog is data-gated for a udpsrc head",
      runner.playing_watchdog_id is None and runner.source_gate.data_wait is not None)
check("the silence watch is armed on the udpsrc", runner.source_gate.udp_silence is not None and runner.source_gate.udp_silence["probes"])
spin(TIMEOUT_NS / 1e9 * 5)          # five timeouts' worth of silence, > the 400 ms watchdog
silent = [e for e in events if e["event"] == "input_silent"]
errors = [e for e in events if e["event"] == "error"]
check("exactly one input_silent after ~5 timeouts, naming the element",
      len(silent) == 1 and silent[0].get("element") == "netsrc" and silent[0].get("kind") == "udp_timeout")
check("no bus-style waiting_for_data for a udp head (one warning, not two)",
      not any(e["event"] == "waiting_for_data" for e in events))
check("no error event (no PLAYING timeout either) and no teardown",
      errors == [] and runner.pipeline.get_state(0)[1] == Gst.State.PAUSED)

print("\n--- the first packet back resumes, a later silence warns again ---")
send_ts_packet(port)
spin(0.5)
check("input_resumed is reported once", sum(1 for e in events if e["event"] == "input_resumed") == 1)
check("and the pipeline reached PLAYING on that data", runner.pipeline.get_state(2 * Gst.SECOND)[1] == Gst.State.PLAYING)
spin(TIMEOUT_NS / 1e9 * 3)
check("a fresh silence after data is reported again (second input_silent)",
      sum(1 for e in events if e["event"] == "input_silent") == 2)
check("still no error", not any(e["event"] == "error" for e in events))
runner.handle_stop()
check("stop clears the silence watch", runner.source_gate.udp_silence is None)

print("\n--- a multicast-style restart bound turns long silence into the old udp_timeout error ---")
events = collect_events()
port = free_port()
runner.handle_start({"pipeline": f"udpsrc name=netsrc port={port} timeout={TIMEOUT_NS} {CAPS} ! fakesink sync=false",
                     "udpSilenceRestartMs": 800})
spin(0.5)
check("under the bound: input_silent only, no error",
      any(e["event"] == "input_silent" for e in events) and not any(e["event"] == "error" for e in events))
spin(1.2)
errs = [e for e in events if e["event"] == "error"]
check("past the bound: one udp_timeout error (the restart path), pipeline torn down",
      len(errs) == 1 and errs[0].get("kind") == "udp_timeout"
      and runner.pipeline.get_state(0)[1] == Gst.State.NULL and runner.source_gate.udp_silence is None)
runner.handle_stop()

print("\n--- a pipeline without udpsrc arms nothing ---")
events = collect_events()
runner.handle_start({"pipeline": "audiotestsrc is-live=true ! fakesink sync=false"})
check("no udp silence watch for a non-udp head", runner.source_gate.udp_silence is None)
runner.handle_stop()

if _failures:
    print(f"\n{len(_failures)} FAILED:")
    for f in _failures:
        print("  - " + f)
    sys.exit(1)
print("\nAll udp silence tests passed.")
