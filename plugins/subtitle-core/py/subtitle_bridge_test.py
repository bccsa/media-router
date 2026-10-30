#!/usr/bin/env python3
"""The runner-facing plumbing on a fake GStreamer: `subtitle_bridge.install`
with pay and overlay, the pay path without the egress-trace module, the producer's
cue PES PTS (its teletext PES PTS, no retime), the consumer's install (no demux
probe), cue PTS, re-sends, pad add/remove and the burn-in's cue watch, the egress
trace's env gate and bookkeeping, the `show` trace, the text helper.
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


ORDER = []                  # the readers' links and state syncs, in order


class FakePad:
    def __init__(self, name, caps="meta/x-klv", parent=None):
        self.name, self.caps, self.probes, self.parent, self.peer = name, caps, [], parent, None

    def get_name(self):
        return self.name

    def get_current_caps(self):
        return NS(get_size=lambda: 1, get_structure=lambda i: NS(get_name=lambda: self.caps))

    def link(self, other):
        self.peer = other
        ORDER.append(("pad", other.parent.kind if other.parent else None))
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
        return self.pads.setdefault(n, FakePad(n, parent=self))

    def sync_state_with_parent(self):
        self.state = "PLAYING"
        ORDER.append(("sync", self.kind))

    def set_state(self, st):
        self.state = st

    def link(self, other):
        self.linked = other
        ORDER.append(("link", self.kind, other.kind))
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

# --- producer: each cue's PES PTS is its teletext PES PTS, no retime (WI-P3-8) --
warnings, events = [], []
subtitle_runtime.configure(warnings.append, lambda _ch, p: events.append(p))
srcdemux, appsink, appsrc = FakeElement("mrtsdemux", "demux"), FakeElement("appsink", "s"), FakeElement("appsrc", "a")
subtitle_bridge.install(FakePipe(demux=srcdemux, s=appsink, a=appsrc), {
    "pay": [{"appsink": "s", "appsrc": "a", "pid": 0x180, "holdMs": 3000, "label": "eng 888"}],
    "sourceDemux": "demux"}, None)                      # an older description's key: never read
entry = subtitle_bridge.state()["pay"][0]
check("producer: the bridge leaves the source demux alone (no pad, signal or probe)",
      srcdemux.pads == {} and srcdemux.signals == {})
BASE = 3600 * 90_000                                    # PES − 1 h is the house time
ttx = [BASE + 90 * ms + r for ms, r in ((49_400, 5), (49_480, 89), (49_560, 45), (49_640, 0))]
ns = [-(-(t - BASE) * 100_000 // 9) for t in ttx]       # the formula's PTS, ceil to the ns
for t_ns, text in zip(ns, [b"Hello", b"", b"Two\nlines", b"Bye"]):
    appsink.sample = NS(get_buffer=lambda t_ns=t_ns, text=text: FakeBuffer(text + b"\n\x00", t_ns))
    subtitle_pay._on_text_sample(appsink, entry)        # teletextdec's text: its PES's PTS
check("producer: each cue's PES PTS is its teletext PES PTS, 0 ticks whatever its ms remainder",
      [subtitle_egress_trace.klv_pes_ticks(b.data) for b in appsrc.pushed] == [[t] for t in ttx])
subtitle_pay.resend([entry])
check("producer: a live cue's re-send repeats its PES PTS",
      len(appsrc.pushed) == 5 and subtitle_egress_trace.klv_pes_ticks(appsrc.pushed[4].data) == [ttx[3]]
      and appsrc.pushed[4].pts == appsrc.pushed[3].pts)
check("producer: each cue starts at its content time, late by its arrival (house now 50 s), no warning",
      [(e["startMs"], e["lateMs"]) for e in events] == [(n / 1e6, round(50_000 - n / 1e6)) for n in ns]
      and warnings == [])
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

# --- consumer: installed without a demux probe; cues on their demuxed PTS -----
demux, ov = FakeElement("mrtsdemux", "subdemux"), FakeElement("textoverlay", "ov")
pipe = FakePipe(subdemux=demux, ov=ov)
subtitle_bridge.install(pipe, {"overlay": {"demux": "subdemux", "overlay": "ov"}}, None)
st_ov = subtitle_bridge.state()["overlay"]
check("overlay: installs without a probe on the demux, one on the overlay's video pad (WI-P3-7)",
      not any(p.probes for p in demux.pads.values()) and set(demux.signals) == {"pad-added", "pad-removed"}
      and [p for p in ov.pads] == ["video_sink"] and len(ov.pads["video_sink"].probes) == 1)
reader = FakeElement("appsink")


def cue_in(data, pts_ms):
    """One demuxed KLV buffer into the cue reader (house now is the fake clock's 50 000 ms)."""
    reader.sample = NS(get_buffer=lambda: FakeBuffer(data, int(pts_ms * 1_000_000)))
    return subtitle_overlay._on_cue_sample(reader, st_ov)


cues = st_ov["cues"]
hi = klv.encode_cue(250, 3250, "Hi")
cue_in(hi, 50_400.0)                                    # 400 ms ahead of now, as the bus sends it
check("overlay: a KLV buffer with PTS T is a cue from T + rel.start, anchored on its pts, its arrival kept",
      cues.pending == [sc.Cue(50_650.0, 53_650.0, "Hi", subtitle_overlay.klv_key(hi), "pts", 50_000.0)])
far = klv.encode_cue(0, 1000, "Far")
cue_in(far, 90_000_000.0)
check("overlay: a PTS far from house now anchors on arrival",
      cues.pending[0] == sc.Cue(50_000.0, 51_000.0, "Far", subtitle_overlay.klv_key(far), "now", 50_000.0))
# The re-send case: one cue's copies, each a demuxed buffer of its own.
re = klv.encode_cue(0, 3000, "Re")
cue_in(re, 52_000.0)
cue_in(re, 52_000.0)                                    # this release's re-send: the same PES again
cue_in(re, 53_040.0)                                    # an older producer's: the cue on a later PES PTS
cue_in(re + b"\x00\x00", 54_080.0)                      # bytes a demuxer appended after the triplet
cue_in(klv.encode_cue(0, 3000, "Next"), 54_100.0)
check("overlay: re-sends of a cue queue it once, whatever their PTS or trailing bytes; the next cue queues",
      [(c.start, c.text) for c in cues.pending] == [(50_000.0, "Far"), (50_650.0, "Hi"), (52_000.0, "Re"),
                                                    (54_100.0, "Next")]
      and subtitle_overlay.klv_key(re + b"\x00\x00") == subtitle_overlay.klv_key(re))

# --- consumer readers across pad add/remove; the show trace -------------------
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
added(demux, FakePad("private_0_0120", "application/x-teletext"), st_ov)   # media=private: no A/V pad
removed(demux, FakePad("private_0_0120", "application/x-teletext"), st_ov)
check("overlay: a non-subtitle pad's fakesink is retired too", len(pipe.children) == 2)
reader, sink = st_ov["readers"]["private_0_0180"]
check("overlay: without an aligner the cue reader is a queue (the video-player)",
      (reader.kind, sink.kind, reader.props) == ("queue", "appsink", {}) and reader.linked is sink)
subtitle_bridge.clear()

# --- the burn-in: each cue pad read through a sparse watch of the pace group (WI-P3-13) --
bdemux, bov = FakeElement("mrtsdemux", "subdemux"), FakeElement("textoverlay", "subov")
bpipe = FakePipe(subdemux=bdemux, subov=bov)
subtitle_bridge.install(bpipe, {"overlay": {"demux": "subdemux", "overlay": "subov", "aligner": "burnin"}}, None)
st_b = subtitle_bridge.state()["overlay"]
del ORDER[:]
klv_pad = FakePad("private_0_0180")
bdemux.signals["pad-added"][0](bdemux, klv_pad, st_b)
watch, sink = st_b["readers"]["private_0_0180"]
check("overlay: with an aligner each KLV pad's reader is a sparse mralignwatch of that pace group, input cues",
      (watch.kind, sink.kind) == ("mralignwatch", "appsink")
      and watch.props == {"aligner": "burnin", "input": "cues", "sparse": True}
      and bpipe.children == [watch, sink])
check("overlay: the watch is linked to the appsink before it runs, the pad to the watch last",
      ORDER == [("link", "mralignwatch", "appsink"), ("sync", "appsink"), ("sync", "mralignwatch"),
                ("pad", "mralignwatch")]
      and watch.linked is sink and klv_pad.peer is watch.pads["sink"] and watch.state == "PLAYING")
bdemux.signals["pad-removed"][0](bdemux, klv_pad, st_b)
check("overlay: pad-removed retires the watch and its appsink", bpipe.children == [] and st_b["readers"] == {})
subtitle_bridge.clear()
check("overlay: show trace carries cueLate, cueLag (now − start), frameLag, the margin and t0src",
      subtitle_overlay.show_line("Hi", sc.Cue(1000.0, 4000.0, "Hi", b"k", "pts", 900.0), 1020.0, 2400.0)
      == "show 'Hi' cueLate=20 cueLag=1400 frameLag=1380 margin=1500 t0src=pts")
check("overlay: no margin without the cue's arrival",
      subtitle_overlay.show_line("Hi", sc.Cue(1000.0, 4000.0, "Hi", b"k", "pts"), 1020.0, 2400.0)
      == "show 'Hi' cueLate=20 cueLag=1400 frameLag=1380 t0src=pts")
print("all subtitle_bridge tests passed")
