"""deinterlace_guard — the transcoder's runner hook (ADR-0020) that drops the
stale frames GStreamer's `deinterlace` re-sends after a discontinuity.

This module is the reference; `native/deinterlace-guard/deinterlace_guard.cpp`
is its native port (same config, rule and log line).

Why: `deinterlace` flushes its field history (`gst_deinterlace_reset_history`)
on every DISCONT buffer, SEGMENT, caps change and EOS, and in that flush it
outputs fields it had already pushed. The motion-adaptive methods keep
history, so their output steps BACKWARD in time. Measured live on gate01,
2026-10-08: yadif re-sent 6-8 frames per 200 ms gap plus 2 at start,
greedyh/greedyl one, and mpegtsmux logged "ignoring DTS going backward" each
time. `linear` keeps no history and never did this (#817). A leaky queue marks
its next buffer DISCONT, so the transcoder's raw-frame queue triggers the
flush every time it sheds.

Each re-sent frame is exactly 0 or 1 field duration behind the newest frame
already out (its PTS comes from one history slot older). So the rule, a buffer
probe on the deinterlacer's src pad, is: a frame whose PTS is not after the
last frame let through, and at most one frame duration behind it, is a
re-send and is dropped. Any bigger step back is a real new timeline (a
time-sync re-anchor) and passes, re-basing the guard. The window is one
duration, not more, because the first frames of a real re-anchor can land
two fields behind the old maximum. FLUSH_STOP, STREAM_START and SEGMENT reset
the guard. The deinterlacer pushes its re-sends before forwarding a SEGMENT,
so none can follow one.

Config: {"element": "<name= of the deinterlace element>"}.
"""
import sys

DEFAULT_DURATION_NS = 20_000_000

_Gst = None
_emit_event = None   # callable(dict) — engine events (warnings)
_state = None        # {"pad", "probes", "name", "last", "dropped", "back"}


def decide(last_pts, pts, duration):
    """True when the frame at `pts` is a stale re-send to drop. PTS and
    durations in ns; None = invalid/unknown."""
    if last_pts is None or pts is None:
        return False
    return pts <= last_pts and last_pts - pts <= (duration or DEFAULT_DURATION_NS)


def _gst():
    global _Gst
    if _Gst is None:
        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        _Gst = Gst
    return _Gst


def _trace(msg):
    sys.stderr.write(f"[deinterlace_guard] {msg}\n")
    sys.stderr.flush()


def _warn(message):
    if _emit_event:
        _emit_event({"event": "warning", "message": f"deinterlace guard: {message}"})


def install(pipe, config, ctx=None):
    """Runner hook entry point, called once per pipeline start before PLAYING."""
    global _emit_event, _state
    clear()
    if ctx:
        _emit_event = ctx.get("emit_event")
    name = (config or {}).get("element") or ""
    el = pipe.get_by_name(name) if name else None
    pad = el.get_static_pad("src") if el is not None else None
    if pad is None:
        _warn(f"element '{name}' not found — not installed")
        return
    Gst = _gst()
    st = {"pad": pad, "probes": [], "name": name, "last": None, "dropped": 0, "back": 0}
    st["probes"].append(pad.add_probe(Gst.PadProbeType.BUFFER, _on_buffer, st))
    # Flush events reach a probe only with EVENT_FLUSH in its mask.
    st["probes"].append(pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM | Gst.PadProbeType.EVENT_FLUSH,
                                      _on_event, st))
    _state = st


def clear():
    global _state
    if _state is None:
        return
    _report(_state)
    for probe in _state["probes"]:
        _state["pad"].remove_probe(probe)
    _state = None


def state():
    return _state


def _report(st):
    if st["dropped"]:
        _trace(f"dropped {st['dropped']} stale frame(s) re-sent by {st['name']} "
               f"(up to {st['back'] / 1e6:.0f} ms back)")
        st["dropped"] = 0
        st["back"] = 0


def _on_buffer(pad, info, st):
    Gst = _Gst
    buf = info.get_buffer()
    pts = None if buf.pts == Gst.CLOCK_TIME_NONE else buf.pts
    duration = None if buf.duration == Gst.CLOCK_TIME_NONE else buf.duration
    if decide(st["last"], pts, duration):
        st["dropped"] += 1
        st["back"] = max(st["back"], st["last"] - pts)
        return Gst.PadProbeReturn.DROP
    _report(st)
    if pts is not None:
        st["last"] = pts
    return Gst.PadProbeReturn.OK


def _on_event(pad, info, st):
    Gst = _Gst
    t = info.get_event().type
    if t in (Gst.EventType.FLUSH_STOP, Gst.EventType.STREAM_START, Gst.EventType.SEGMENT, Gst.EventType.EOS):
        _report(st)
        if t != Gst.EventType.EOS:
            st["last"] = None
    return Gst.PadProbeReturn.OK
