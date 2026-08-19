#!/usr/bin/env python3
"""Self-checking tests for the backlog shedder in gst-pipeline-runner.py.

Runs REAL GStreamer pipelines through `_start_backlog_shedder`, because the
properties under test are data-flow ones: which buffers are DROPPED, which one
ends the episode, and what the `backlog_shed` event says about it. The pure
arm/rate-limit arithmetic is `backlog_shed_test.py`; the end-to-end proof that
this cures the contract's latency ratchet (and that a legacy leg is untouched)
is `gst_latency_ratchet_test.py`.

The fixture stamps buffers `now − backlog`, so a leg holding `backlog` ms of
retained latency is reproduced exactly, with no queue to fill and no waiting:
lateness at the shed point is `backlog − ts_offset` by construction, and the
event's `retainedBeforeMs` must come back as the backlog that was injected.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_backlog_shed_test.py
"""
import importlib.util
import io
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_backlog_shed_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# `MR_SHED_RUNNER` points the suite at a MUTATED runner copy — how the shedder
# is falsified (disable it, watch the ratchet tests fail). Its directory wins on
# the path so that copy's sibling modules (`backlog_shed.py`) are the ones it
# imports, exactly as a spawned runner resolves them.
_RUNNER = os.environ.get("MR_SHED_RUNNER") or os.path.join(_HERE, "gst-pipeline-runner.py")
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(_RUNNER)))
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

_failures = []

BUDGET_MS = 300                    # the route's playout offset D
TOLERANCE_MS = 100                 # test-scale; ships at 250
HOLD_MS = 200                      # test-scale; ships at 5000


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def near(a, b, tol):
    return a is not None and abs(a - b) <= tol


def collect_plugin_events():
    """Swap the runner's plugin-event emitter for a collector; returns the list
    of (channel, payload) pairs."""
    events = []
    runner.emit_plugin_event = lambda ch, payload: events.append((ch, payload))
    return events


def build(keyframe_aligned=True, budget_ms=BUDGET_MS, dec="identity name=vdec",
          **policy):
    """A contract-clocked leg: appsrc → `vdec` (the shed point) → sink.

    `identity` stands in for the decoder for the same reason the keyframe-gate
    suite uses one: the shedder only ever touches the element's SINK pad, and a
    real stateless decoder is exactly what a unit test must not exercise. The
    sink is `sync=false` so the fixture is deterministic — the shedder reads its
    `ts-offset` and never asks it to pace anything.

    `dec` swaps that stand-in: the stall-watch case needs a `valve`, i.e. a
    decoder that takes the resume and emits nothing.
    """
    pipe = Gst.parse_launch(
        "appsrc name=src is-live=true format=time do-timestamp=false "
        f"! {dec} "
        f"! fakesink name=sink sync=false async=false ts-offset={budget_ms * 1000000}")
    # The contract's clock: monotonic, base_time 0, so running time IS clock
    # time and a buffer stamped `now − backlog` is exactly `backlog` late.
    runner._apply_contract_clock(pipe)
    cfg = {"element": "vdec", "sink": "sink", "keyframeAligned": keyframe_aligned,
           "toleranceMs": TOLERANCE_MS, "holdMs": HOLD_MS, "cooldownMs": 100_000,
           "sanityMs": 10_000}
    cfg.update(policy)
    ok = runner._start_backlog_shedder(pipe, cfg)
    arrivals = []

    def _on_sink(_pad, info):
        buf = info.get_buffer()
        arrivals.append(bool(buf.has_flags(Gst.BufferFlags.DELTA_UNIT)))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("sink").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, _on_sink)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * Gst.SECOND)
    runner.pipeline = pipe             # what `_now_running_ms` reads
    return pipe, pipe.get_by_name("src"), arrivals


def push(src, backlog_ms, delta=True):
    """One buffer carrying `backlog_ms` of retained latency."""
    clock = Gst.SystemClock.obtain()
    buf = Gst.Buffer.new_allocate(None, 32, None)
    buf.pts = clock.get_time() - int(backlog_ms * Gst.MSECOND)
    buf.duration = 20 * Gst.MSECOND
    if delta:
        buf.set_flags(Gst.BufferFlags.DELTA_UNIT)
    return src.emit("push-buffer", buf) == Gst.FlowReturn.OK


def push_for(src, ms, backlog_ms, delta=True, step_ms=20):
    """Push at `step_ms` cadence for `ms` of REAL time — the hold window is
    measured on the pipeline clock, so it can only be paid in real seconds."""
    end = time.monotonic() + ms / 1000.0
    n = 0
    while time.monotonic() < end:
        push(src, backlog_ms, delta)
        n += 1
        time.sleep(step_ms / 1000.0)
    return n


def pump_until(cond, timeout_s=3.0):
    """Iterate the default main context — where the stall watch's GLib timeouts
    live, and nothing else in this suite needs — until `cond()` or the timeout.
    """
    ctx = GLib.MainContext.default()
    end = time.monotonic() + timeout_s
    while True:
        while ctx.pending():
            ctx.iteration(False)
        if cond():
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.01)


def teardown(pipe):
    runner._stop_backlog_shedder()
    pipe.set_state(Gst.State.NULL)
    runner.pipeline = None


runner.emit_event = lambda obj: None
runner.emit_plugin_event = lambda ch, payload: None

# --- steady state costs nothing ---------------------------------------------
# A leg INSIDE its budget must be untouched: every buffer reaches the sink and
# no episode is ever opened. This is the "the guard is invisible until it isn't"
# assertion — the shedder sits on the live path of every paced leg on the fleet.
pipe, src, arrivals = build()
n = push_for(src, 600, backlog_ms=BUDGET_MS - 50)      # 50 ms of slack
time.sleep(0.2)
check("a leg inside its budget is never shed", len(arrivals) == n and n > 10)
check("and no episode is opened", runner._backlog_shed["sheds"] == 0)
# Retained latency is reported even when nothing is wrong — that reading is what
# renderWatch attributes with (and what a soak trace plots).
reading = runner._backlog_shed_window(runner._now_running_ms())
check("a healthy leg still reports its retained latency",
      near(reading["retainedMs"], BUDGET_MS - 50, 60) and reading["budgetMs"] == BUDGET_MS)
check("healthy lateness is NEGATIVE — inside the budget", reading["latenessMs"] < 0)
check("and the window reading is consumed once",
      runner._backlog_shed_window(runner._now_running_ms()) is None)
teardown(pipe)

# --- the video leg: shed, then resume only on a keyframe ---------------------
events = collect_plugin_events()
pipe, src, arrivals = build(keyframe_aligned=True)
BACKLOG_MS = 1300                                   # 1 s past a 300 ms budget
n = push_for(src, HOLD_MS + 250, backlog_ms=BACKLOG_MS)
time.sleep(0.2)
st = runner._backlog_shed
check("a sustained backlog opens an episode", st["shedding"] is True)
check("late buffers stop reaching the decoder once it opens", 0 < len(arrivals) < n)
before_arrivals = len(arrivals)

# Caught up, but a DELTA unit: resuming here would hand the decoder references
# that were dropped — the V4L2 wedge. It must NOT end the episode.
push(src, backlog_ms=BUDGET_MS - 50, delta=True)
time.sleep(0.2)
check("catching up does NOT resume the picture mid-GOP",
      len(arrivals) == before_arrivals and st["shedding"] is True)

# The IRAP ends it, and passes.
push(src, backlog_ms=BUDGET_MS - 50, delta=False)
time.sleep(0.3)
check("the next keyframe ends the episode", st["shedding"] is False)
check("and that keyframe itself is presented",
      len(arrivals) == before_arrivals + 1 and arrivals[-1] is False)

shed = [p for ch, p in events if ch == "backlog_shed"]
check("exactly one backlog_shed event was emitted", len(shed) == 1)
ev = shed[0] if shed else {}
check("the event names the outcome", ev.get("outcome") == "recovered")
check("it reports the retained latency it started from",
      near(ev.get("retainedBeforeMs"), BACKLOG_MS, 120))
check("it reports the retained latency it ended at, back inside the budget",
      near(ev.get("retainedAfterMs"), BUDGET_MS - 50, 120)
      and ev.get("retainedAfterMs") <= BUDGET_MS + 20)
check("it reports the route's budget", ev.get("budgetMs") == BUDGET_MS)
check("excess is retained minus budget on both ends",
      near(ev.get("excessBeforeMs"), ev.get("retainedBeforeMs") - BUDGET_MS, 1)
      and near(ev.get("excessAfterMs"), ev.get("retainedAfterMs") - BUDGET_MS, 1))
check("it counts the buffers it dropped, and they are the ones missing",
      ev.get("droppedBuffers") == n - before_arrivals + 1)
check("it counts the episode", ev.get("shedCount") == 1)
check("the episode is one-shot: the leg flows again afterwards",
      push(src, backlog_ms=BUDGET_MS - 50, delta=True) is True)
time.sleep(0.2)
check("post-shed delta units are presented normally",
      len(arrivals) == before_arrivals + 2)
teardown(pipe)

# --- the cooldown: a second backlog inside it is not shed --------------------
events = collect_plugin_events()
pipe, src, arrivals = build(keyframe_aligned=False, cooldownMs=100_000)
push_for(src, HOLD_MS + 150, backlog_ms=BACKLOG_MS)
push(src, backlog_ms=BUDGET_MS - 50, delta=False)      # ends episode 1
time.sleep(0.2)
check("first episode ran", runner._backlog_shed["sheds"] == 1)
mid = len(arrivals)
push_for(src, HOLD_MS + 400, backlog_ms=BACKLOG_MS)
time.sleep(0.2)
check("a fresh backlog inside the cooldown is NOT shed",
      runner._backlog_shed["shedding"] is False and runner._backlog_shed["sheds"] == 1)
check("and its buffers are all delivered rather than dropped", len(arrivals) > mid + 10)
check("only the first episode was reported",
      len([p for ch, p in events if ch == "backlog_shed"
           and p.get("outcome") == "recovered"]) == 1)
teardown(pipe)

# --- the audio leg: no keyframe alignment ------------------------------------
events = collect_plugin_events()
pipe, src, arrivals = build(keyframe_aligned=False)
n = push_for(src, HOLD_MS + 250, backlog_ms=BACKLOG_MS)
time.sleep(0.2)
check("the audio leg opens an episode on the same rule",
      runner._backlog_shed["shedding"] is True)
before_arrivals = len(arrivals)
# Raw PCM references nothing, so the FIRST buffer inside budget ends it —
# whatever its flags say. (Every raw audio buffer carries DELTA_UNIT.)
push(src, backlog_ms=BUDGET_MS - 50, delta=True)
time.sleep(0.2)
check("a buffer back inside budget ends an unaligned episode immediately",
      runner._backlog_shed["shedding"] is False)
check("and it is delivered whole — no sample is ever cut",
      len(arrivals) == before_arrivals + 1)
ev = [p for ch, p in events if ch == "backlog_shed"][0]
check("the audio event carries the same before/after pair",
      near(ev.get("retainedBeforeMs"), BACKLOG_MS, 120)
      and ev.get("retainedAfterMs") <= BUDGET_MS + 20)
teardown(pipe)

# --- the sanity ceiling: an implausible timeline is reported, never shed -----
events = collect_plugin_events()
pipe, src, arrivals = build(keyframe_aligned=True)
n = push_for(src, HOLD_MS + 400, backlog_ms=60_000)     # a minute "late"
time.sleep(0.2)
check("an implausible timeline never opens an episode",
      runner._backlog_shed["shedding"] is False and runner._backlog_shed["sheds"] == 0)
check("every buffer is delivered — the stream is NOT dropped", len(arrivals) == n)
implausible = [p for ch, p in events if ch == "backlog_shed"
               and p.get("outcome") == "implausible"]
check("and it is reported exactly once, not per buffer", len(implausible) == 1)
check("renderWatch is not fed a nonsense reading either",
      runner._backlog_shed_window(runner._now_running_ms())["latenessMs"] > 10_000)
teardown(pipe)

# --- staleness: an old sample is not reported as current ---------------------
pipe, src, arrivals = build()
push(src, backlog_ms=BUDGET_MS - 50)
time.sleep(0.2)
st = runner._backlog_shed
check("a fresh sample is reported",
      runner._backlog_shed_window(runner._now_running_ms()) is not None)
push(src, backlog_ms=BUDGET_MS - 50)
time.sleep(0.2)
st["last_at"] -= runner.BACKLOG_SHED_STALE_MS + 1000
check("a stale sample is withheld — a gated leg says nothing, not something old",
      runner._backlog_shed_window(runner._now_running_ms()) is None)
teardown(pipe)

# --- config handling ---------------------------------------------------------
pipe = Gst.parse_launch(
    "appsrc name=src ! identity name=vdec ! fakesink name=sink sync=false async=false")
runner._backlog_shed = {"pad": None, "element": "stale", "probe_id": None}
check("no config = no shedder, and start succeeds",
      runner._start_backlog_shedder(pipe, None) is True)
check("no config drops a stale shedder rather than inheriting it",
      runner._backlog_shed is None)

errors = []
runner.emit_event = lambda obj: errors.append(obj)
check("an element the pipeline lacks is a HARD error",
      runner._start_backlog_shedder(
          pipe, {"element": "nosuch", "sink": "sink"}) is False)
check("the hard error names the element the module asked for",
      any("nosuch" in e.get("message", "") for e in errors))
errors.clear()
check("a sink the pipeline lacks is a HARD error too",
      runner._start_backlog_shedder(
          pipe, {"element": "vdec", "sink": "nosink"}) is False)
check("that error names the sink", any("nosink" in e.get("message", "") for e in errors))
runner.emit_event = lambda obj: None
runner._backlog_shed = None
pipe.set_state(Gst.State.NULL)

# The legacy path, stated as a runner property: no `backlogShed` key at all
# (which is what `backlogShedConfig` returns with the contract off) leaves the
# pad untouched — no probe, no drops, nothing to measure.
pipe, src, arrivals = (Gst.parse_launch(
    "appsrc name=src is-live=true format=time do-timestamp=false "
    "! identity name=vdec ! fakesink name=sink sync=false async=false"), None, [])
runner._start_backlog_shedder(pipe, None)
src = pipe.get_by_name("src")
pipe.get_by_name("sink").get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER, lambda _p, _i: (arrivals.append(1), Gst.PadProbeReturn.OK)[1])
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * Gst.SECOND)
n = push_for(src, 400, backlog_ms=5_000)          # 5 s "late", unarmed
time.sleep(0.2)
check("with no shedder armed, an hour-late leg is left exactly as it is",
      len(arrivals) == n and runner._backlog_shed is None)
pipe.set_state(Gst.State.NULL)

# --- the post-shed stall: a decoder that took the resume and went silent -----
# Pi 400, 2026-08-18: a TEXTBOOK shed — correct IRAP resume, back inside
# budget, one clean event — left the stateless V4L2 HEVC decoder producing
# nothing at all, with no error posted and the pipeline still PLAYING, for 12 h.
# `valve drop=true` is exactly that decoder: it accepts everything the shed
# hands it and emits nothing. The grace is shortened per instance (it ships at
# 10 s) so the two stages are seconds, not half a minute, of test time.
STALL_GRACE_MS = 300

events = collect_plugin_events()
pipe, src, arrivals = build(keyframe_aligned=True, dec="valve name=vdec")
vdec = pipe.get_by_name("vdec")
runner._backlog_shed["stall"].grace_ms = STALL_GRACE_MS
# FLUSH_STOP is a SERIALIZED downstream event, so a plain EVENT_FLUSH mask sees
# only the start half — both flags, then filter, or the pair is unobservable.
RESET_EVENTS = (Gst.EventType.FLUSH_START, Gst.EventType.FLUSH_STOP,
                Gst.EventType.SEGMENT)
resets = []


def _watch_resets(_pad, info):
    ev = info.get_event()
    if ev is not None and ev.type in RESET_EVENTS:
        resets.append(ev.type)
    return Gst.PadProbeReturn.OK


vdec.get_static_pad("sink").add_probe(
    Gst.PadProbeType.EVENT_FLUSH | Gst.PadProbeType.EVENT_DOWNSTREAM, _watch_resets)
# The real leg gates the same element. A flushed decoder has lost its
# references, and nothing in the STREAM will say so — so the gate has to be
# re-closed with it, or the first post-flush delta AU re-creates the wedge.
runner._start_keyframe_gate(pipe, {"decoder": "vdec"})
check("nothing is watched before a shed — the guard costs a healthy leg nothing",
      runner._backlog_shed["stall"].armed is False
      and runner._backlog_shed["stall_probe_id"] is None)

push_for(src, HOLD_MS + 250, backlog_ms=BACKLOG_MS)
check("the episode opened", runner._backlog_shed["shedding"] is True)
vdec.set_property("drop", True)          # the wedge: nothing comes out again
stderr_log = io.StringIO()
real_stderr = sys.stderr
sys.stderr = stderr_log
try:
    push(src, backlog_ms=BUDGET_MS - 50, delta=False)      # the IRAP ends it
    ended = pump_until(lambda: runner._backlog_shed["shedding"] is False, 2.0)
    check("the keyframe ends the episode as usual", ended)
    check("and the shed arms a watch on the decoder's OUTPUT",
          runner._backlog_shed["stall"].armed is True
          and runner._backlog_shed["stall_probe_id"] is not None)
    check("the shed itself is still reported exactly once",
          len([p for ch, p in events if ch == "backlog_shed"]) == 1)

    flushed = pump_until(lambda: Gst.EventType.FLUSH_STOP in resets, 3.0)
    check("silence past the grace flushes the decoder", flushed)
    # The pair, then the SEGMENT the flush-stop dropped put back — without it
    # the decoder's next buffer would arrive on no timeline at all.
    check("as a flush-start / flush-stop pair, with the segment restored after it",
          resets[-3:] == [Gst.EventType.FLUSH_START, Gst.EventType.FLUSH_STOP,
                          Gst.EventType.SEGMENT])
    check("counted once — one flush per stall, not per tick",
          runner._backlog_shed["stall"].flushes == 1)
    check("and the keyframe gate is re-closed with it, so the flushed decoder "
          "is fed an IRAP next",
          runner._keyframe_gate["opened"] is False
          and runner._keyframe_gate["rearms"] == 1)
    check("and the watch stays armed for the flush to work",
          runner._backlog_shed["stall"].armed is True)

    errs = []
    bus = pipe.get_bus()

    def _drained(n):
        msg = bus.pop_filtered(Gst.MessageType.ERROR)
        if msg is not None:
            errs.append(msg)
        return len(errs) >= n

    escalated = pump_until(lambda: _drained(1), 3.0)
    check("a decoder still silent after the flush posts a bus ERROR", escalated)
    err = errs[0].parse_error()[0] if errs else None
    check("the error says what happened, in the grep-distinct wording",
          err is not None and err.message.startswith("post-shed stall:")
          and "escalating to pipeline restart" in err.message)
    # Attribution matters: an error naming `vdec` would cost the hardware
    # decoder its rung for the whole engine session (video-player's demotion
    # rule). This watch judged the decoder wedged; the decoder posted nothing.
    check("posted from the PIPELINE, not the decoder element", errs[0].src is pipe)
    check("the watch is over — no second flush, no second escalation",
          runner._backlog_shed["stall"].armed is False
          and runner._backlog_shed["stall"].flushes == 1
          and runner._backlog_shed["stall"].escalations == 1
          and runner._backlog_shed["stall_probe_id"] is None)
    check("and no further error is posted after the escalation",
          not pump_until(lambda: _drained(2), 1.0))
finally:
    sys.stderr = real_stderr
logged = stderr_log.getvalue()
check("the stall is logged under the shedder's own prefix, grep-distinct",
      "backlog shed: vdec post-shed stall: no decoder output for 0.3s "
      "— flushing vdec" in logged)
check("and the escalation is logged too",
      "post-shed stall: decoder produced no output after shed + flush" in logged)
check("the gate re-close is logged under the gate's own prefix",
      "keyframe gate: vdec re-armed after a post-shed decoder flush" in logged)
teardown(pipe)
runner._stop_keyframe_gate()

# The other outcome, which is the one every healthy leg takes: the decoder DOES
# come back, and the watch costs a single probe callback.
pipe, src, arrivals = build(keyframe_aligned=True)
runner._backlog_shed["stall"].grace_ms = STALL_GRACE_MS
push_for(src, HOLD_MS + 250, backlog_ms=BACKLOG_MS)
push(src, backlog_ms=BUDGET_MS - 50, delta=False)
check("the shed recovered",
      pump_until(lambda: runner._backlog_shed["shedding"] is False, 2.0))
check("one buffer out of the decoder disarms the watch immediately",
      runner._backlog_shed["stall"].armed is False
      and runner._backlog_shed["stall_probe_id"] is None)
pump_until(lambda: False, (2 * STALL_GRACE_MS + 200) / 1000.0)
check("so nothing is flushed and nothing is escalated",
      runner._backlog_shed["stall"].flushes == 0
      and runner._backlog_shed["stall"].escalations == 0
      and pipe.get_bus().pop_filtered(Gst.MessageType.ERROR) is None)
teardown(pipe)

# The AUDIO leg is never watched: its shed drops whole decoded buffers at the
# sink's own pad — a timestamp gap the sink re-anchors over, with no decoder
# state to wedge and nothing a flush or a restart could improve.
pipe, src, arrivals = build(keyframe_aligned=False)
runner._backlog_shed["stall"].grace_ms = STALL_GRACE_MS
push_for(src, HOLD_MS + 250, backlog_ms=BACKLOG_MS)
push(src, backlog_ms=BUDGET_MS - 50, delta=True)          # ends an audio shed
check("the audio shed finished",
      pump_until(lambda: runner._backlog_shed["shedding"] is False, 2.0))
check("an audio shed arms no stall watch at all",
      runner._backlog_shed["stall"].armed is False
      and runner._backlog_shed["stall_probe_id"] is None)
pump_until(lambda: False, (2 * STALL_GRACE_MS + 200) / 1000.0)
check("and none of its stages can ever run",
      runner._backlog_shed["stall"].flushes == 0
      and runner._backlog_shed["stall"].escalations == 0
      and pipe.get_bus().pop_filtered(Gst.MessageType.ERROR) is None)
teardown(pipe)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst backlog shed tests passed.")
