#!/usr/bin/env python3
"""Self-checking tests for the runner's `preserveSourceTimeline` discontinuity
watch (gst-pipeline-runner.py, `_install_preserve_timeline`).

The feature itself is LEGACY: under the time-sync contract it is dropped
outright (`GstPluginBase.applyTimeSync`, ADR-0005), because the egress stamper
re-anchors in place where this errors the pipeline out to re-latch. It stays
live for the transcoder paths that run with the contract off, and its watch had
kept a private copy of the rule the stamper's watch was FIXED in on 2026-08-13:

  - the per-PID reference was advanced ACROSS the anomaly, so the PID that
    reported a jump was immediately coherent again from the value it jumped to;
  - and the only confirmation was a second anomalous buffer.

Together those make a SINGLE-PID source that loops undetectable — one anomaly,
then silence — which is exactly the field failure. What is pinned here is the
corrected rule, taken from `ts_timeline.TimelineStamper` rather than copied
again: same-PID confirmation against the epoch the anomaly proposed, the
reference retained so an outlier can prove itself one, and the cross-PID path
unchanged for muxed sources.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_preserve_timeline_test.py
"""
import contextlib
import importlib.util
import io
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_preserve_timeline_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path so the
# runner's lazy `import ts_timeline` resolves (plugins/mpegts-core/py).
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
# `MR_STAMPER_RUNNER` points both this suite and gst_bus_stamper_test.py at a
# mutated copy of the runner — one knob for the mutation drills.
_RUNNER = os.environ.get("MR_STAMPER_RUNNER") or os.path.join(
    _HERE, "gst-pipeline-runner.py")
sys.path.insert(0, os.path.dirname(os.path.abspath(_RUNNER)))
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

# The PES packet builder the contract's own suites use, so the bytes under test
# here are the bytes under test there. Its module self-checks on import; that
# output belongs to ts_psi's suite, not this one.
with contextlib.redirect_stdout(io.StringIO()):
    from ts_psi_test import pes_ts_packet
import ts_psi  # noqa: E402

Gst.init(sys.argv)

_failures = []
STEP = 3600                     # 40 ms in 90 kHz ticks
FIRST = 8_100_000               # 90 s
PTS_WRAP = 1 << 33
# The watch samples 1-in-8 buffers (the runner's `_WATCH_STRIDE`), so every
# rung is pushed this many times: one scanned buffer per rung.
STRIDE = 8


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def rig(ladder):
    """Push `ladder` (a list of buffers, each a list of (pid, pts)) through a
    pipeline with the watch armed, and return the events the runner emitted.

    `identity` stands in for the tsdemux: the watch reads the demux SINK pad,
    which carries the muxed TS whatever the element downstream of it is.
    """
    events = []
    runner.emit_event = lambda obj: events.append(obj)
    caps = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"
    pipe = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time do-timestamp=false caps={caps} "
        "! identity name=demux ! fakesink name=fs sync=false async=false")
    src = pipe.get_by_name("src")
    runner._install_preserve_timeline(pipe, {"demux": "demux"})
    # In production the watch arms once every demuxed pad has taken its offset
    # (`maybe_release_sink_probe`); no pads are added here, so arm it directly —
    # what is under test is the watch, not the latch handshake.
    runner._preserve_timeline["watch"] = True
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    for pes in ladder:
        payload = b"".join(pes_ts_packet(pid, pts=pts) for pid, pts in pes)
        for _ in range(STRIDE):
            buf = Gst.Buffer.new_wrapped(payload)
            src.emit("push-buffer", buf)
    src.emit("end-of-stream")
    pipe.get_bus().timed_pop_filtered(
        5 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    runner._clear_preserve_timeline()
    return [e for e in events if e.get("kind") == "timeline_discont"]


# ---------------------------------------------------------------------------
print("\n--- the single-PID rewind (the 2026-08-13 shape) ---")
# A looping source rewinds its PES timeline to ~0. One PID means nothing else
# can report the same jump a buffer later, so the OLD rule counted exactly one
# anomaly and never fired — the offsets stayed stale for the rest of the loop
# and downstream A/V pairing rode on values from before the rewind.
loop = ([[(0x100, FIRST + i * STEP)] for i in range(6)]
        + [[(0x100, 4500 + i * STEP)] for i in range(4)])
fired = rig(loop)
check("a SINGLE-PID rewind fires exactly one timeline_discont", len(fired) == 1)
# The jump reported is measured from the RETAINED pre-rewind reference, not
# from the proposal — 8118000 -> 8100 ticks, i.e. the whole 90 s the source
# wound back, which is what an operator needs to see.
check("and it names the PID and the whole jump, off the retained reference",
      fired and "0x100" in fired[0]["message"] and "-90.11s" in fired[0]["message"])

print("\n--- debounce: one bad PTS is not a discontinuity ---")
# The reference is deliberately NOT advanced across an anomaly, precisely so a
# stream that comes back to it proves the outlier was an outlier.
glitch = [[(0x100, FIRST + i * STEP - (90000 * 30 if i == 3 else 0))]
          for i in range(8)]
check("a single corrupt PES PTS does NOT restart the pipeline", rig(glitch) == [])

print("\n--- the cross-PID rule is not replaced, only joined ---")
# A muxed source whose jump lands on a different PID each buffer still confirms
# on the second anomalous buffer, exactly as before.
muxed = ([[(0x100, FIRST + i * STEP), (0x101, FIRST + i * STEP + 90)]
          for i in range(4)]
         + [[(0x100, 4500)], [(0x101, 4590)]])
fired = rig(muxed)
check("a muxed source still confirms on the second PID", len(fired) == 1)
check("and it is the confirming PID that reports it",
      fired and "0x101" in fired[0]["message"])

print("\n--- a legal 2^33 wrap is not a discontinuity ---")
# The 90 kHz counter wraps every ~26.5 h; the folded delta reads that as the
# 40 ms step it really is (the 2026-07-23 wrap drill).
wrap = [[(0x100, (PTS_WRAP - 3 * STEP + i * STEP) % PTS_WRAP)] for i in range(8)]
check("crossing 2^33 never restarts the pipeline", rig(wrap) == [])

print("\n--- a sparse PID riding a healthy mux is not one either ---")
# An 8 s metadata carousel is anomalous on EVERY appearance. Confirming against
# the epoch the previous anomaly PROPOSED (rather than counting a PID's
# anomalies) is what tells it apart from a rewind: it never continues from what
# it proposed last time.
SEC = 90000
sparse = []
for i in range(24):
    pes = [(0x100, FIRST + i * SEC)]
    if i % 8 == 0:
        pes.append((0x1FF, FIRST + i * SEC + 45000))
    sparse.append(pes)
check("a sparse metadata PID never restarts the pipeline", rig(sparse) == [])

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All preserveSourceTimeline watch tests passed.")
