#!/usr/bin/env python3
"""The runner-facing plumbing on a fake GStreamer: `subtitle_bridge.install`
with pay and overlay, the pay path without the egress-trace module, the
consumer's reader lifecycle across pad add/remove, the egress trace's env gate
and bookkeeping, the consumer `show` trace, and the text/pad-name helpers.
Run: python3 subtitle_bridge_test.py
"""
import importlib
import os
import sys
import types

import subtitle_bridge
import subtitle_cues as sc
import subtitle_egress_trace
import subtitle_klv as klv
import subtitle_overlay
import subtitle_pack as sp
import subtitle_pay
import subtitle_runtime
from subtitle_testlib import check, packets, pes

NS = types.SimpleNamespace

check("clean strips NUL/CR/trailing", subtitle_pay.clean_text(b"Hello\r\nWorld  \n\n\x00") == "Hello\nWorld")
check("clean blank page is clear", subtitle_pay.clean_text(b"\n\x00") == "")
check("clean keeps inner blank line", subtitle_pay.clean_text(b"a\n\nb\n") == "a\n\nb")
check("clean tolerates bad utf8", subtitle_pay.clean_text(b"ok\xff\n") == "ok�")
check("pad name -> pid", subtitle_pay.pid_from_pad_name("private_0_0181") == 0x181
      and subtitle_pay.pid_from_pad_name("x") is None)


# --- a fake GStreamer ---------------------------------------------------------
class FakeBuffer:
    def __init__(self, data=b"", pts=None):
        self.data, self.pts, self.dts, self.duration = bytes(data), pts, None, None

    @classmethod
    def new_wrapped(cls, data):
        return cls(data)

    def extract_dup(self, off, n):
        return self.data[off:off + n]

    def get_size(self):
        return len(self.data)


class FakePad:
    def __init__(self, name, caps="meta/x-klv"):
        self.name, self.caps, self.probes = name, caps, []

    def get_name(self):
        return self.name

    def get_current_caps(self):
        return NS(get_size=lambda: 1, get_structure=lambda i: NS(get_name=lambda: self.caps))

    def link(self, _other):
        return 0

    def add_probe(self, *args):
        self.probes.append(args)
        return 1


class FakeElement:
    def __init__(self, kind, name=None):
        self.kind, self.name, self.props, self.signals, self.pushed = kind, name, {}, {}, []
        self.pads, self.state, self.sample = {}, "NEW", None

    def set_property(self, k, v):
        self.props[k] = v

    def connect(self, sig, cb, *a):
        self.signals[sig] = (cb, a)

    def get_static_pad(self, n):
        return self.pads.setdefault(n, FakePad(n))

    def sync_state_with_parent(self):
        self.state = "PLAYING"

    def set_state(self, st):
        self.state = st

    def link(self, _other):
        return True

    def emit(self, sig, *a):
        if sig == "push-buffer":
            self.pushed.append(a[0])
        return self.sample if sig == "pull-sample" else None


class FakePipe:
    def __init__(self, **els):
        self.els, self.children = els, []

    def get_by_name(self, n):
        return self.els.get(n)

    def add(self, e):
        self.children.append(e)

    def remove(self, e):
        self.children.remove(e)

    def get_clock(self):
        return NS(get_time=lambda: 50_000_000_000)

    def get_base_time(self):
        return 0


FakeGst = NS(CLOCK_TIME_NONE=(1 << 64) - 1, Buffer=FakeBuffer, FlowReturn=NS(OK=0),
             PadProbeType=NS(BUFFER=1, BUFFER_LIST=2), PadProbeReturn=NS(OK=0, DROP=1),
             State=NS(NULL="NULL"), ElementFactory=NS(make=lambda kind, name: FakeElement(kind, name)))
FakeGLib = NS(timeout_add=lambda ms, cb: 7, source_remove=lambda i: None, idle_add=lambda cb: cb())
traced = []
os.environ["MR_SUBTITLE_NATIVE_RETIME"] = "0"           # the python probe here; subtitle_native_test.py the splice
subtitle_runtime.gst = lambda: (FakeGLib, FakeGst)
subtitle_runtime.trace = traced.append


# --- pay without the egress-trace module, even with the trace switched on -----
saved = sys.modules.get("subtitle_egress_trace")
sys.modules["subtitle_egress_trace"] = None              # its import raises ImportError
os.environ[subtitle_pay.EGRESS_TRACE_ENV] = "1"
try:
    importlib.reload(subtitle_pay)                       # the bridge holds this module object
    appsink, appsrc = FakeElement("appsink", "ttxsink"), FakeElement("appsrc", "subsrc")
    subtitle_bridge.install(FakePipe(ttxsink=appsink, subsrc=appsrc), {"pay": [
        {"appsink": "ttxsink", "appsrc": "subsrc", "pid": 0x180, "holdMs": 3000, "label": "t"}]}, None)
    entry = subtitle_bridge.state()["pay"][0]
    appsink.sample = NS(get_buffer=lambda: FakeBuffer(b"Hello\n\x00", 49_000_000_000))
    subtitle_pay._on_text_sample(appsink, entry)
    check("pay: without the trace module the bridge installs and pushes the cue chunk",
          subtitle_pay.subtitle_egress_trace is None and entry["egress"] is None
          and len(appsrc.pushed) == 1 and len(appsrc.pushed[0].data) == 7 * 188
          and appsrc.pushed[0].pts == 49_000_000_000)
finally:
    os.environ.pop(subtitle_pay.EGRESS_TRACE_ENV, None)
    if saved is None:
        sys.modules.pop("subtitle_egress_trace", None)
    else:
        sys.modules["subtitle_egress_trace"] = saved
    importlib.reload(subtitle_pay)
    subtitle_bridge.clear()

# --- source retime: a page before the first chunk-stamp join warns once per pad --
warnings = []
subtitle_runtime.configure(warnings.append, None)
srcdemux, appsink, appsrc = FakeElement("tsdemux", "demux"), FakeElement("appsink", "s"), FakeElement("appsrc", "a")
subtitle_bridge.install(FakePipe(demux=srcdemux, s=appsink, a=appsrc), {
    "pay": [{"appsink": "s", "appsrc": "a", "pid": 0x180, "holdMs": 3000}], "sourceDemux": "demux"}, None)
ttx_pad = FakePad("private_0_0020", "application/x-teletext")
srcdemux.signals["pad-added"][0](srcdemux, ttx_pad, *srcdemux.signals["pad-added"][1])
_kind, on_buffer, ps = ttx_pad.probes[0]
for _ in range(3):
    on_buffer(ttx_pad, NS(get_buffer=lambda: FakeBuffer(b"\x10" * 46, 7_000_000_000)), ps)
check("retime: no chunk-stamp hit yet → one warning per pad, tsdemux time kept",
      [w["message"] for w in warnings] == [
          "subtitle bridge: private_0_0020: content time unavailable yet — tsdemux time used"])
subtitle_runtime.configure(None, None)
subtitle_bridge.clear()

# --- egress trace: off by default, its bookkeeping ------------------------------
check("egress trace: off unless MR_SUBTITLE_EGRESS_TRACE=1", subtitle_pay.egress_trace("t", FakeGst) is None)
os.environ[subtitle_pay.EGRESS_TRACE_ENV] = "1"
check("egress trace: on with MR_SUBTITLE_EGRESS_TRACE=1",
      isinstance(subtitle_pay.egress_trace("t", FakeGst), subtitle_egress_trace.EgressTrace))
os.environ.pop(subtitle_pay.EGRESS_TRACE_ENV, None)
cue_klv = klv.encode_cue(0, 3000, "Hello")
mixed = b"".join(packets(0x180, pes(0xBD, 90_000 * 3600 + 450_000, cue_klv), pcr=90_000 * 3600)) + \
    b"".join(packets(0x100, pes(0xE0, 90_000 * 3600 + 900_000, b"\x00")))
check("egress trace: PES PTS a chunk carries (private only)",
      subtitle_egress_trace.klv_pes_ticks(mixed) == [90_000 * 3600 + 450_000])
big = packets(0x180, pes(0xBD, 1_800_000, klv.encode_cue(0, 3000, "x" * 400)))
check("egress trace: continuation-only chunk carries none", subtitle_egress_trace.klv_pes_ticks(big[1]) == [])
check("egress trace: a pushed cue maps to its written PTS, wrapped at 2^33",
      sp.pes_ticks(5000) == 90_000 * 3600 + 450_000
      and sp.pes_ticks(1_767_069_165) == (1_767_069_165 + 3_600_000) * 90 % (1 << 33))
lines = []
trace = subtitle_egress_trace.EgressTrace("eng 888", lines.append, FakeGst)
chunk = sp.KlvTsPacker(0x180).cue_chunk(sp.pes_ticks(5000), klv.encode_cue(0, 3000, "Hi"))
other = sp.KlvTsPacker(0x180).cue_chunk(sp.pes_ticks(6000), klv.encode_cue(0, 3000, "Ho"))
trace.pushed(5000)
check("egress trace: a push is pending under its written PES PTS", list(trace.pending) == [sp.pes_ticks(5000)])
trace.seen("tee", other)
check("egress trace: a chunk it never saw pushed logs nothing", lines == [] and len(trace.pending) == 1)
trace.seen("src", chunk)
trace.seen("tee", chunk)
check("egress trace: src then tee logs one line and retires the push",
      len(lines) == 1 and lines[0].startswith("egress eng 888 start=5000 src=+") and " tee=+" in lines[0]
      and not trace.pending)
for n in range(40):
    trace.pushed(10_000 + n)
check("egress trace: pending bounded, oldest dropped",
      len(trace.pending) == subtitle_egress_trace.PENDING_MAX
      and sp.pes_ticks(10_000) not in trace.pending and sp.pes_ticks(10_039) in trace.pending)

# --- consumer readers across pad add/remove; the show trace -------------------
demux, ov = FakeElement("tsdemux", "subdemux"), FakeElement("textoverlay", "ov")
pipe = FakePipe(subdemux=demux, ov=ov)
subtitle_bridge.install(pipe, {"overlay": {"demux": "subdemux", "overlay": "ov"}}, None)
st_ov = subtitle_bridge.state()["overlay"]
added, removed = demux.signals["pad-added"][0], demux.signals["pad-removed"][0]
for _ in range(3):
    pad = FakePad("private_0_0180")
    added(demux, pad, st_ov)
    removed(demux, pad, st_ov)
check("overlay: pad-removed retires the cue reader (NULL + removed), none accumulate",
      pipe.children == [] and st_ov["readers"] == {})
added(demux, FakePad("private_0_0180"), st_ov)
old = list(pipe.children)
added(demux, FakePad("private_0_0180"), st_ov)          # re-added without a removal
check("overlay: a re-added pad name replaces its old reader",
      len(pipe.children) == 2 and all(e.state == "NULL" for e in old) and not set(old) & set(pipe.children))
added(demux, FakePad("audio_0_0101", "audio/mpeg"), st_ov)
removed(demux, FakePad("audio_0_0101", "audio/mpeg"), st_ov)
check("overlay: a non-subtitle pad's fakesink is retired too", len(pipe.children) == 2)
subtitle_bridge.clear()
check("overlay: show trace carries cueLate, cueLag (now − start), frameLag and t0src",
      subtitle_overlay.show_line("Hi", sc.Cue(1000.0, 4000.0, "Hi", b"k", "chunk"), 1020.0, 2400.0)
      == "show 'Hi' cueLate=20 cueLag=1400 frameLag=1380 t0src=chunk")
print("all subtitle_bridge tests passed")
