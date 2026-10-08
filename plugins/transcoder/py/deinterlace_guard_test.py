#!/usr/bin/env python3
"""Self-checking tests for the transcoder runner hook (`deinterlace_guard.py`, #817).

  1. Pure rule: `decide()` drops a frame 0..1 duration behind the last one let
     through and passes anything newer or further back (a real re-anchor); an
     unknown duration falls back to 20 ms.
  2. REAL pipeline: videotestsrc -> deinterlace (yadif, then greedyl) with a
     DISCONT injected twice. Unguarded the output steps back (the bug — this
     keeps the suite honest); guarded it never does, every frame missing is a
     logged drop, and no drop reaches further back than one field.
  3. A real re-anchor (input 2 s earlier from one frame on) passes the guard
     and re-bases it: exactly one step back, the real one, and frames after it.
  4. FLUSH_STOP / STREAM_START / SEGMENT reset the guard, EOS does not; a
     missing element warns and installs nothing.

The pure part needs no GStreamer; the rest skips without it.
Run: python3 deinterlace_guard_test.py   (from plugins/transcoder/py)
"""
import contextlib
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deinterlace_guard as g  # noqa: E402

failures = 0
MS = 1_000_000


def check(name, got, want=True):
    global failures
    ok = got == want
    print(("PASS " if ok else "FAIL ") + f"{name}: got {got!r}" + ("" if ok else f", want {want!r}"))
    if not ok:
        failures += 1


print("1. decide() — the drop rule")
check("nothing let through yet -> pass", g.decide(None, 100 * MS, 20 * MS), False)
check("no PTS -> pass", g.decide(100 * MS, None, 20 * MS), False)
check("same PTS again (yadif's start repeat) -> drop", g.decide(100 * MS, 100 * MS, 20 * MS))
check("one field behind -> drop", g.decide(100 * MS, 80 * MS, 20 * MS))
check("just over one field behind -> pass", g.decide(100 * MS, 80 * MS - 1, 20 * MS), False)
check("two fields behind (a re-anchor's first frames) -> pass", g.decide(100 * MS, 60 * MS, 20 * MS), False)
check("forward -> pass", g.decide(100 * MS, 120 * MS, 20 * MS), False)
check("a 2 s step back is a real re-anchor -> pass", g.decide(10_980 * MS, 8_980 * MS, 20 * MS), False)
check("unknown duration: 20 ms window, drop at 20", g.decide(100 * MS, 80 * MS, None))
check("unknown duration: pass at 21", g.decide(100 * MS, 79 * MS, None), False)
check("zero duration: 20 ms window", g.decide(100 * MS, 80 * MS, 0))
check("the window is the frame's own duration (40 ms)", g.decide(100 * MS, 60 * MS, 40 * MS))
check("... and no more", g.decide(100 * MS, 60 * MS - 1, 40 * MS), False)


def finish():
    print()
    if failures:
        print(f"{failures} check(s) FAILED")
        sys.exit(1)
    print("all checks passed")
    sys.exit(0)


try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP pipeline sections — GStreamer unavailable ({exc})")
    finish()
Gst.init([])
for factory in ("videotestsrc", "deinterlace", "fakesink"):
    if Gst.ElementFactory.find(factory) is None:
        print(f"SKIP pipeline sections — {factory} unavailable")
        finish()

DROP_LINE = re.compile(r"\[deinterlace_guard\] dropped (\d+) stale frame\(s\) re-sent by deint \(up to (\d+) ms back\)")


def run(method, disconts=(), reanchor_at=None, guard=True, n=40):
    """PTS (ms) out of `deinterlace mode=interlaced method=<method>` for `n`
    25 fps input frames from 10 s; DISCONT on the input frames in `disconts`,
    the input 2 s earlier from frame `reanchor_at` on. Returns (pts, drop
    lines, events) or None when the method does not exist here."""
    try:
        pipe = Gst.parse_launch(
            f"videotestsrc num-buffers={n} pattern=ball timestamp-offset={10 * Gst.SECOND} "
            "! video/x-raw,format=I420,width=64,height=48,framerate=25/1 "
            f"! deinterlace name=deint mode=interlaced method={method} ! fakesink name=out sync=false")
    except GLib.Error:
        return None
    seen = {"i": 0}

    def on_input(_pad, info):
        buf = info.get_buffer()
        i = seen["i"]
        seen["i"] += 1
        if i in disconts:
            buf.set_flags(Gst.BufferFlags.DISCONT)
        if reanchor_at is not None and i >= reanchor_at:
            buf.pts -= 2 * Gst.SECOND
        return Gst.PadProbeReturn.OK

    pts = []
    pipe.get_by_name("deint").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_input)
    pipe.get_by_name("out").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, lambda _pad, info: (pts.append(info.get_buffer().pts // MS), Gst.PadProbeReturn.OK)[1])
    events = []
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        if guard:
            g.install(pipe, {"element": "deint"}, {"emit_event": events.append})
        pipe.set_state(Gst.State.PLAYING)
        msg = pipe.get_bus().timed_pop_filtered(20 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
        pipe.set_state(Gst.State.NULL)
        g.clear()
    if msg is None or msg.type != Gst.MessageType.EOS:
        print(f"    {method}: no EOS ({msg.parse_error() if msg else 'timeout'})")
    return pts, [DROP_LINE.match(line) for line in err.getvalue().splitlines() if "dropped" in line], events


def back_steps(pts):
    return [(a, b) for a, b in zip(pts, pts[1:]) if b <= a]


for method in ("yadif", "greedyl"):
    print(f"2. {method}: DISCONT re-sends are dropped")
    raw = run(method, disconts=(10, 20), guard=False)
    if raw is None:
        print(f"SKIP {method} — not in this GStreamer's deinterlace")
        continue
    raw_pts = raw[0]
    pts, drops, events = run(method, disconts=(10, 20))
    check(f"{method} unguarded steps back (the bug reproduces)", len(back_steps(raw_pts)) > 0)
    check(f"{method} guarded never steps back", back_steps(pts), [])
    check(f"{method} every drop is logged in the reference format", all(drops) and len(drops) > 0)
    dropped = sum(int(m.group(1)) for m in drops if m)
    check(f"{method} every missing frame is a logged drop", len(raw_pts) - len(pts), dropped)
    check(f"{method} no drop reaches past one field (20 ms)", all(m and int(m.group(2)) <= 20 for m in drops))
    check(f"{method} no warning", events, [])

    print(f"3. {method}: a real re-anchor passes and re-bases")
    pts, drops, _ = run(method, disconts=(10,), reanchor_at=25)
    steps = back_steps(pts)
    check(f"{method} exactly one step back, the real one (~2 s)",
          len(steps) == 1 and 1900 <= steps[0][0] - steps[0][1] <= 2100)
    after = len(pts) - 1 - pts.index(steps[0][1]) if len(steps) == 1 else 0
    check(f"{method} the frames after the re-anchor flow ({after})", after >= 20)
    check(f"{method} the re-anchor itself was never dropped", all(m and int(m.group(2)) <= 20 for m in drops))


print("4. events and install")
g._gst()
seg = Gst.Segment()
seg.init(Gst.Format.TIME)


class Info:
    def __init__(self, ev):
        self.ev = ev

    def get_event(self):
        return self.ev


for label, ev, resets in (("FLUSH_STOP", Gst.Event.new_flush_stop(True), True),
                          ("STREAM_START", Gst.Event.new_stream_start("s"), True),
                          ("SEGMENT", Gst.Event.new_segment(seg), True),
                          ("EOS", Gst.Event.new_eos(), False)):
    st = {"name": "deint", "last": 500 * MS, "dropped": 2, "back": 20 * MS}
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        g._on_event(None, Info(ev), st)
    check(f"{label} {'resets' if resets else 'keeps'} the last frame", st["last"] is None, resets)
    check(f"{label} reports the pending drops",
          (st["dropped"], "dropped 2 stale frame(s) re-sent by deint (up to 20 ms back)" in err.getvalue()), (0, True))

pipe = Gst.parse_launch("videotestsrc ! fakesink name=out")
events = []
err = io.StringIO()
with contextlib.redirect_stderr(err):
    g.install(pipe, {"element": "nope"}, {"emit_event": events.append})
check("a missing element warns", events,
      [{"event": "warning", "message": "deinterlace guard: element 'nope' not found — not installed"}])
check("... and installs nothing", g.state(), None)
pipe = Gst.parse_launch("videotestsrc ! deinterlace name=deint ! fakesink")
g.install(pipe, {"element": "deint"}, {"emit_event": events.append})
check("installed: two probes on the deinterlacer's src pad", len(g.state()["probes"]), 2)
g.clear()
check("clear() drops the state", g.state(), None)

finish()
