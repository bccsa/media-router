#!/usr/bin/env python3
"""Self-checking tests for the keyframe gate in gst-pipeline-runner.py.

Runs REAL GStreamer pipelines through `_start_keyframe_gate`, because the
property under test is a data-flow one: buffers flagged DELTA_UNIT must be
DROPPED until the first keyframe, that keyframe and everything after it must
PASS, and — the second half of the same rule — a delta unit that arrives
flagged DISCONT must RE-ARM the gate, because DISCONT is the mark a `leaky=2`
queue leaves when it has shed buffers upstream.

Why it matters: every live RIST/TS join lands mid-GOP, and the live chain then
keeps losing AUs by design (four leaky jitter queues, most sharply the 200 ms
one feeding the parser, which sheds whenever the decoder stalls). Feeding
either kind of missing-reference delta unit to a stateless V4L2 decoder (rpivid
`v4l2slh265dec` on Pi 4, `hevc_dec` on Pi 5, kernel 6.12.87) makes GStreamer
submit slices with 0xff reference indices; the driver logs `Col ref index 255`,
programs COLBASE=0 and wedges phase1 — V4L2 dead box-wide until reboot. The EOS
drain (gst_drain_test.py) fixes teardown ORDERING and cannot save a decoder
that is already stuck.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_keyframe_gate_test.py
"""
import importlib.util
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_keyframe_gate_test.py — GStreamer unavailable ({exc})")
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


def collect_events():
    """Swap the runner's event emitter for a collector; returns the list."""
    events = []
    runner.emit_event = lambda obj: events.append(obj)
    return events


def watch_sink(pipe, name="out"):
    """Record `is_delta` for every buffer that reaches the named sink."""
    arrivals = []

    def _on_buffer(_pad, info):
        buf = info.get_buffer()
        arrivals.append(bool(buf.has_flags(Gst.BufferFlags.DELTA_UNIT)))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name(name).get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, _on_buffer)
    return arrivals


def run_to_eos(pipe, timeout_s=10):
    msg = pipe.get_bus().timed_pop_filtered(
        timeout_s * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    ok = msg is not None and msg.type == Gst.MessageType.EOS
    pipe.set_state(Gst.State.NULL)
    return ok


# --- appsrc fixture: full control over the DELTA_UNIT flag ------------------
# `identity name=vpdec` stands in for the decoder: the gate only ever touches
# the element's SINK pad, so the element behind it is irrelevant — and a real
# stateless decoder is exactly what must not be exercised in a unit test.
def build_appsrc():
    pipe = Gst.parse_launch(
        "appsrc name=src is-live=true format=time block=true "
        "! identity name=vpdec ! fakesink name=out sync=false async=false")
    return pipe, pipe.get_by_name("src")


def push(src, delta, i, discont=False):
    buf = Gst.Buffer.new_allocate(None, 32, None)
    buf.pts = i * Gst.SECOND // 25
    buf.duration = Gst.SECOND // 25
    if delta:
        buf.set_flags(Gst.BufferFlags.DELTA_UNIT)
    if discont:
        # What a leaky queue leaves on the first buffer after it sheds — see
        # gstqueue.c `head_needs_discont`; baseparse carries it to the AU.
        buf.set_flags(Gst.BufferFlags.DISCONT)
    return src.emit("push-buffer", buf) == Gst.FlowReturn.OK


def wait_for(pred, timeout_s=5):
    """appsrc hands buffers to a streaming thread — wait for the probe to have
    seen them rather than racing it."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


runner.emit_event = lambda obj: None

pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
check("gate wires onto a named element", runner._start_keyframe_gate(pipe, {"decoder": "vpdec"}))
state = runner._keyframe_gate
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)

# The mid-GOP join: 3 delta units before the stream's first keyframe, then a
# keyframe, then ordinary GOP traffic including a later keyframe.
for i, delta in enumerate([True, True, True, False, True, True, False, True]):
    push(src, delta, i)
src.emit("end-of-stream")
check("appsrc fixture runs to EOS", run_to_eos(pipe))

check("the 3 leading delta units never reached the decoder", len(arrivals) == 5)
check("the first buffer through the gate is the KEYFRAME", arrivals[:1] == [False])
check(
    "everything after the first keyframe passes, delta units included",
    arrivals == [False, True, True, False, True],
)
check("the gate counted exactly the delta units it dropped", state["dropped"] == 3)
check("the gate latched open on the keyframe", state["opened"] is True)
check("an intact stream never re-arms the gate", state["rearms"] == 0)

# The probe STAYS on the pad (it has to, to re-arm) — so an open gate costs one
# flag test per AU and nothing else. The assertion is above: every delta unit
# after the keyframe reached the decoder while the probe was still installed.
check("no drops were counted after the gate opened", state["dropped"] == 3)
runner._stop_keyframe_gate()
check("_stop_keyframe_gate clears the module state", runner._keyframe_gate is None)

# --- upstream loss re-arms the gate ----------------------------------------
# The 200 ms leaky ES queue sheds its OLDEST buffers whenever the decoder
# stalls (device open + CMA + DMABuf negotiation at startup is ~1 s of stream
# time), i.e. exactly the AUs after the keyframe the gate just passed. The
# buffer that follows the shed carries DISCONT; every delta unit from there to
# the next IRAP references frames the decoder never saw.
pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
runner._start_keyframe_gate(pipe, {"decoder": "vpdec"})
state = runner._keyframe_gate
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)

#     (delta, discont)
plan = [
    (False, False),   # keyframe: the gate opens
    (True, False),    # ordinary GOP traffic
    (False, True),    # DISCONT on a KEYFRAME: self-contained, passes, stays open
    (True, False),
    (True, True),     # DISCONT on a delta unit: the shed — re-arm here
    (True, False),    # shut: references are missing until the next IRAP
    (True, False),
    (False, False),   # next IRAP: the gate re-opens
    (True, False),
]
for i, (delta, discont) in enumerate(plan):
    push(src, delta, i, discont)
wait_for(lambda: len(arrivals) == 6 and state["dropped"] == 3)

check("the loss re-armed the gate exactly once", state["rearms"] == 1)
check("a DISCONT keyframe passes without re-arming", arrivals[2:3] == [False])
check("every delta unit between the loss and the next IRAP was dropped",
      state["dropped"] == 3)
check("the picture resumes on the next IRAP",
      arrivals == [False, True, False, True, False, True])
check("the gate is open again after the IRAP", state["opened"] is True)

# An OPEN gate must still be detachable: the probe no longer self-removes, so
# `_stop_keyframe_gate` is the ONLY thing that ever takes it off the pad.
runner._stop_keyframe_gate()
push(src, True, len(plan), True)          # would be dropped by a live gate
src.emit("end-of-stream")
check("re-arm fixture runs to EOS", run_to_eos(pipe))
check("_stop_keyframe_gate detaches an OPEN gate too",
      arrivals[-1] is True and state["dropped"] == 3)

# --- stopping an UNOPENED gate takes the probe off the pad ------------------
pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
runner._start_keyframe_gate(pipe, {"decoder": "vpdec"})
state = runner._keyframe_gate
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)
push(src, True, 0)                        # dropped: gate still shut
for _ in range(500):                      # appsrc hands off to a streaming
    if state["dropped"]:                  # thread — wait for the drop rather
        break                             # than race it
    time.sleep(0.01)
check("the shut gate dropped the first delta unit", state["dropped"] == 1)
runner._stop_keyframe_gate()
push(src, True, 1)                        # passes: probe removed
src.emit("end-of-stream")
run_to_eos(pipe)
check("an unopened gate is removed by _stop_keyframe_gate", arrivals == [True])

# --- fault injector (VP_FAULT_DROP_DELTAS) ---------------------------------
# The gate stops every gap it can SEE. The injector manufactures one it cannot:
# N delta AUs vanish at the decoder's sink pad and NOTHING that follows is
# flagged DISCONT, so the re-arm rule never fires and the decoder is handed AUs
# referencing pictures it never got — the unprotected loss that wedges rpivid,
# reproduced on demand. It ships disabled; these tests pin both that it is inert
# by default and that it lies exactly as advertised when armed.


def build_gate_with_fault(pipe, value):
    """Build a gate with the env var set to `value` (None = unset), then put the
    environment back — the budget is read once, at gate build."""
    prev = os.environ.get("VP_FAULT_DROP_DELTAS")
    if value is None:
        os.environ.pop("VP_FAULT_DROP_DELTAS", None)
    else:
        os.environ["VP_FAULT_DROP_DELTAS"] = value
    try:
        runner._start_keyframe_gate(pipe, {"decoder": "vpdec"})
    finally:
        if prev is None:
            os.environ.pop("VP_FAULT_DROP_DELTAS", None)
        else:
            os.environ["VP_FAULT_DROP_DELTAS"] = prev
    return runner._keyframe_gate


check("unset env leaves the injector inert", runner._fault_drop_budget() == 0)
for bad in ("", "0", "-1", "abc", "3.5"):
    check(f"{bad!r} is not an arming value",
          build_gate_with_fault(build_appsrc()[0], bad)["fault_budget"] == 0)
runner._stop_keyframe_gate()

# Armed: the first keyframe opens the gate, the next N delta AUs disappear.
pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
state = build_gate_with_fault(pipe, "3")
check("the env var arms exactly the budget it names", state["fault_budget"] == 3)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)

#       key,  d,    d,    d,    d,    d,   key,   d
plan = [False, True, True, True, True, True, False, True]
for i, delta in enumerate(plan):
    push(src, delta, i)
src.emit("end-of-stream")
check("fault-injector fixture runs to EOS", run_to_eos(pipe))

check("exactly N delta units were swallowed", state["fault_dropped"] == 3)
check("the budget is spent, so the burst is one-shot", state["fault_budget"] == 0)
check("the deltas after the burst reach the decoder",
      arrivals == [False, True, True, False, True])
check("the injector's drops are not counted as gate drops", state["dropped"] == 0)
# The point of the whole exercise: the gap carries no DISCONT, so the gate's
# own protection cannot see it and the decoder eats the missing references.
check("the injected gap never re-arms the gate", state["rearms"] == 0)
check("the gate stays open across the injected gap", state["opened"] is True)
runner._stop_keyframe_gate()

# Keyframes are never the injector's target — the picture has to be able to
# recover, and an IRAP references nothing that was dropped.
pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
state = build_gate_with_fault(pipe, "5")
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)
#       key,  d,   key,   d,   key,   d,    d,    d,    d,    d
plan = [False, True, False, True, False, True, True, True, True, True]
for i, delta in enumerate(plan):
    push(src, delta, i)
src.emit("end-of-stream")
check("keyframe-immunity fixture runs to EOS", run_to_eos(pipe))
check("every keyframe survived the burst", arrivals.count(False) == 3)
# 7 delta units offered, 5 swallowed: the 3 keyframes and the last 2 deltas
# are what the decoder sees.
check("only delta units were swallowed, and only N of them",
      state["fault_dropped"] == 5 and arrivals == [False, False, False, True, True])
runner._stop_keyframe_gate()

# Rebuilt without the var: nothing carries over from the armed run.
pipe, src = build_appsrc()
arrivals = watch_sink(pipe)
state = build_gate_with_fault(pipe, None)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)
for i, delta in enumerate([False, True, True, True]):
    push(src, delta, i)
src.emit("end-of-stream")
check("unarmed fixture runs to EOS", run_to_eos(pipe))
check("with the var unset the gate passes every post-keyframe delta",
      arrivals == [False, True, True, True] and state["fault_dropped"] == 0)
runner._stop_keyframe_gate()

# --- config handling -------------------------------------------------------
pipe, _src = build_appsrc()
# Seed a stale gate: an ungated pipeline must not inherit the previous one's
# pad — the teardown drain reaches the decoder through this state.
runner._keyframe_gate = {"pad": None, "decoder": "stale", "probe_id": None,
                         "dropped": 0, "opened": True, "since_close": 0, "rearms": 0}
check("no config = no gate, and start succeeds", runner._start_keyframe_gate(pipe, None) is True)
check("no config drops a stale gate rather than inheriting it",
      runner._keyframe_gate is None)

events = collect_events()
check(
    "a decoder name the pipeline lacks is a HARD error",
    runner._start_keyframe_gate(pipe, {"decoder": "nosuch"}) is False,
)
check(
    "the hard error names the element the module asked for",
    any(e.get("event") == "error" and "nosuch" in e.get("message", "") for e in events),
)
pipe.set_state(Gst.State.NULL)
runner.emit_event = lambda obj: None
runner._keyframe_gate = None

# --- real encoder: flags come from h264parse, not from the test -------------
if Gst.ElementFactory.find("x264enc") is None or Gst.ElementFactory.find("h264parse") is None:
    print("SKIP real-encoder case — x264enc/h264parse unavailable")
else:
    KEY_INT = 10
    pipe = Gst.parse_launch(
        "videotestsrc num-buffers=40 ! video/x-raw,framerate=25/1,width=176,height=144 "
        f"! x264enc key-int-max={KEY_INT} tune=zerolatency ! h264parse name=parse "
        "! identity name=vpdec ! fakesink name=out sync=false async=false")
    arrivals = watch_sink(pipe)

    # Simulate the mid-GOP join on the wire: swallow the stream's own opening
    # keyframe (plus two AUs) upstream of the gate, so the first thing the
    # "decoder" is offered is a delta unit referencing a frame it never saw.
    joined = {"n": 0, "dropped_keyframes": 0}

    def _join_mid_gop(_pad, info):
        joined["n"] += 1
        if joined["n"] <= 3:
            if not info.get_buffer().has_flags(Gst.BufferFlags.DELTA_UNIT):
                joined["dropped_keyframes"] += 1
            return Gst.PadProbeReturn.DROP
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("parse").get_static_pad("src").add_probe(
        Gst.PadProbeType.BUFFER, _join_mid_gop)
    runner._start_keyframe_gate(pipe, {"decoder": "vpdec"})
    state = runner._keyframe_gate
    pipe.set_state(Gst.State.PLAYING)
    check("encoded fixture runs to EOS", run_to_eos(pipe))

    check("the fixture really did cut the opening keyframe", joined["dropped_keyframes"] == 1)
    check(
        "real h264parse delta units are dropped ahead of the first keyframe",
        0 < state["dropped"] < KEY_INT,
    )
    check("the gate opened on a real encoder keyframe", state["opened"] is True)
    check("the decoder's first buffer is a keyframe", arrivals[:1] == [False])
    check("delta units flow freely after it", arrivals.count(True) > 0)
    check(
        "nothing is dropped after the gate opens",
        len(arrivals) == joined["n"] - 3 - state["dropped"],
    )
    # Real parser flags, not ours: an unbroken encoded stream must never look
    # like upstream loss, or the gate would blank the picture on every GOP.
    check("a continuous real stream never re-arms the gate", state["rearms"] == 0)
    runner._stop_keyframe_gate()

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst keyframe gate tests passed.")
