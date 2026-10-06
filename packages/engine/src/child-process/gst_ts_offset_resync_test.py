#!/usr/bin/env python3
"""Self-checking tests for the live `ts-offset` resync in gst-pipeline-runner.py
(`handle_set_property` → `_resync_audio_sink`).

GstAudioBaseSink absorbs a `ts-offset` change under `alignment-threshold`
(40 ms) for as long as the stream is continuous, and applies a larger one only
after `discont-wait` (~1 s). So when a live set_property really CHANGES
ts-offset on an audio sink, the runner marks the next buffer DISCONT and the
sink re-positions on it at once. Pinned here, as the sink's render sees it:

  - a change marks exactly the next buffer, up or down, and two changes
    before that buffer still mark one;
  - re-pushing the same value marks nothing (route-D fan-out, sticky replay);
  - a sink without `alignment-threshold` (every video sink) is never marked;
  - a buffer the backlog shedder drops does not use the mark up: the first
    buffer that reaches the sink carries it.

The audio sink is a stand-in: a GstBaseSink with an `alignment-threshold`
property (the exact predicate the runner keys on) that records each rendered
buffer's DISCONT flag, so no audio device is needed. What a real audio sink
does with the flag is gstaudiobasesink.c's "resync after discont/resync";
native_runner_protocol_test.py case L checks it on the native runner.

Skips (exit 0) where GStreamer / PyGObject or Python elements are unavailable.

Run:  python3 gst_ts_offset_resync_test.py
"""
import importlib.util
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstBase", "1.0")
    from gi.repository import GLib, GObject, Gst, GstBase
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_ts_offset_resync_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", os.path.join(_HERE, "gst-pipeline-runner.py"))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
Gst.init(sys.argv)

_failures = []
RENDERED = []          # the DISCONT flag of each buffer the leg's sink rendered


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


class _AudioSinkStandIn(GstBase.BaseSink):
    __gstmetadata__ = ("audio sink stand-in", "Sink/Audio", "records DISCONT per rendered buffer", "media-router")
    __gsttemplates__ = Gst.PadTemplate.new("sink", Gst.PadDirection.SINK, Gst.PadPresence.ALWAYS, Gst.Caps.new_any())
    __gproperties__ = {
        "alignment-threshold": (GObject.TYPE_UINT64, "Alignment threshold", "what marks an audio sink",
                                0, GLib.MAXUINT64, 40 * Gst.MSECOND, GObject.ParamFlags.READWRITE),
    }

    def do_get_property(self, _prop):
        return 40 * Gst.MSECOND

    def do_set_property(self, _prop, _value):
        pass

    def do_render(self, buf):
        RENDERED.append(buf.has_flags(Gst.BufferFlags.DISCONT))
        return Gst.FlowReturn.OK


try:
    _registered = Gst.Element.register(None, "mraudiosinkstandin", Gst.Rank.NONE, _AudioSinkStandIn)
except Exception:  # noqa: BLE001 — pragma: no cover - environment gate
    _registered = False
if not _registered:
    print("SKIP gst_ts_offset_resync_test.py — cannot register a Python element (gst-python overrides missing?)")
    sys.exit(0)

AUDIO = "mraudiosinkstandin"
VIDEO = "fakesink signal-handoffs=true"     # ts-offset, no alignment-threshold
EVENTS = []
runner.emit_event = EVENTS.append
runner.emit_plugin_event = lambda _ch, _payload: None


def leg(sink, shed=None):
    """appsrc → `sink` (named `sink`) on the contract clock. `shed` arms the
    backlog shedder on the sink's own pad at start, as on every audio leg."""
    RENDERED.clear()
    pipe = Gst.parse_launch("appsrc name=src is-live=true format=time do-timestamp=false "
                            f"! {sink} name=sink sync=false async=false")
    if sink == VIDEO:
        pipe.get_by_name("sink").connect(
            "handoff", lambda _s, buf, _pad: RENDERED.append(buf.has_flags(Gst.BufferFlags.DISCONT)))
    runner._apply_contract_clock(pipe)
    if shed:
        check("the shedder arms on the sink", runner._start_backlog_shedder(pipe, shed) is True)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * Gst.SECOND)
    runner.pipeline = pipe
    return pipe, pipe.get_by_name("src")


def push(src, n, late_ms=0):
    """`n` buffers stamped `late_ms` behind the contract clock, then let them land."""
    clock = Gst.SystemClock.obtain()
    for _ in range(n):
        buf = Gst.Buffer.new_allocate(None, 32, None)
        buf.pts = clock.get_time() - int(late_ms * Gst.MSECOND)
        buf.duration = 20 * Gst.MSECOND
        src.emit("push-buffer", buf)
        time.sleep(0.02)
    time.sleep(0.2)


def set_ts_offset(ms):
    runner.handle_set_property({"cmd": "set_property", "id": f"ts{ms}", "element": "sink",
                                "property": "ts-offset", "value": int(ms * Gst.MSECOND)})


def teardown(pipe):
    runner._stop_backlog_shedder()
    pipe.set_state(Gst.State.NULL)
    runner.pipeline = None


# --- an audio sink: a real change marks exactly the next buffer --------------
pipe, src = leg(AUDIO)
push(src, 3)                        # (the stream's first buffer is DISCONT anyway)
RENDERED.clear()
set_ts_offset(20)
check("a +20 ms push is acked with the value it set",
      any(e.get("event") == "property_set" and e.get("id") == "ts20" and e.get("value") == 20_000_000
          for e in EVENTS))
check("and the sink runs it", pipe.get_by_name("sink").get_property("ts-offset") == 20_000_000)
push(src, 3)
check("+20 ms marks exactly the next buffer DISCONT", RENDERED == [True, False, False])
RENDERED.clear()
set_ts_offset(20)
push(src, 3)
check("re-pushing the same value marks nothing", RENDERED == [False, False, False])
RENDERED.clear()
set_ts_offset(0)
push(src, 2)
check("a decrease is marked the same way", RENDERED == [True, False])
RENDERED.clear()
set_ts_offset(40)
set_ts_offset(60)
push(src, 2)
check("two changes before the next buffer still mark only that one", RENDERED == [True, False])
teardown(pipe)

# --- a video sink: never marked ----------------------------------------------
pipe, src = leg(VIDEO)
push(src, 2)
RENDERED.clear()
set_ts_offset(20)
push(src, 3)
check("a sink without alignment-threshold (every video sink) is never marked", RENDERED == [False] * 3)
check("and the push still applies there", pipe.get_by_name("sink").get_property("ts-offset") == 20_000_000)
teardown(pipe)

# --- the shedder drops: the mark waits for the first buffer the sink gets ---
# What sits upstream is stood in for (no queue here, as in gst_backlog_shed_test).
runner._upstream_queued_ms = lambda _pad: 10_000.0
pipe, src = leg(AUDIO, shed={"element": "sink", "sink": "sink", "keyframeAligned": False,
                             "toleranceMs": 50, "holdMs": 0, "cooldownMs": 100_000, "sanityMs": 10_000})
push(src, 2)
push(src, 3, late_ms=500)           # the 2nd late buffer matures the 0 ms hold
check("a late backlog opens an episode on the sink pad", runner._backlog_shed["shedding"] is True)
before = len(RENDERED)
set_ts_offset(20)
push(src, 3, late_ms=500)
check("buffers the shedder drops never reach the sink",
      len(RENDERED) == before and runner._backlog_shed["shedding"] is True)
push(src, 2)                        # back inside budget: ends the episode and passes
check("the episode ends on the first buffer back inside budget", runner._backlog_shed["shedding"] is False)
check("and that first rendered buffer carries the mark, alone", RENDERED[before:] == [True, False])
teardown(pipe)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All ts-offset resync tests passed.")
