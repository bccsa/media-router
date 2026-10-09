#!/usr/bin/env python3
"""`subtitle_native` on a fake GStreamer: the bridge splices `mrpeshouse` in
front of the source tsdemux when the factory is there (no python chunk probe,
`pes-house` fills the StampIndex, announced pads narrow `pids`), and keeps the
python probe — graph untouched — when it is absent, disabled or will not link.
The real element: subtitle_peshouse_gst_test.py. Run: python3 subtitle_native_test.py
"""
import os
import tempfile
import types

import subtitle_bridge
import subtitle_native
import subtitle_runtime
from subtitle_testlib import check

NS = types.SimpleNamespace
OK, REFUSED = 0, -1


class Pad:
    def __init__(self, name, owner=None, refuse=False):
        self.name, self.owner, self.peer, self.refuse, self.probes = name, owner, None, refuse, []

    def get_peer(self):
        return self.peer

    def link(self, other):
        if self.refuse or other.refuse or self.peer or other.peer:
            return REFUSED
        self.peer, other.peer = other, self
        return OK

    def unlink(self, other):
        if self.peer is not other:
            return False
        self.peer = other.peer = None
        return True

    def add_probe(self, *a):
        self.probes.append(a)

    def get_name(self):
        return self.name


class El:
    def __init__(self, kind, name, refuse=False):
        self.kind, self.name, self.props, self.signals, self.state = kind, name, {}, {}, "NULL"
        self.pads = {n: Pad(n, self, refuse and n == "src") for n in ("sink", "src")}

    def get_static_pad(self, n):
        return self.pads[n]

    def get_name(self):
        return self.name

    def get_parent(self):
        return None

    def connect(self, sig, cb, *a):
        self.signals[sig] = (cb, a)

    def set_property(self, k, v):
        self.props[k] = v

    def sync_state_with_parent(self):
        self.state = "PLAYING"


class Pipe:
    def __init__(self, **els):
        self.els, self.children = els, list(els.values())

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


def fake_gst(available, refuse=False, made=None):
    def make(kind, name):
        el = El(kind, name, refuse)
        if made is not None:
            made.append(el)
        return el
    return NS(PadLinkReturn=NS(OK=OK), PadProbeType=NS(BUFFER=1), Plugin=NS(load_file=lambda p: None),
              ElementFactory=NS(find=lambda n: object() if available else None, make=make))


def run(gst, env=None):
    """install_retime on `queue ! demux`; → (pipe, queue, demux, retime, traces)."""
    traces = []
    subtitle_runtime.gst = lambda: (None, gst)
    subtitle_runtime.trace = traces.append
    subtitle_native._loaded = None
    os.environ.pop(subtitle_native.DISABLE_ENV, None)
    if env is not None:
        os.environ[subtitle_native.DISABLE_ENV] = env
    queue, demux = El("queue", "q"), El("tsdemux", "demux")
    queue.pads["src"].link(demux.pads["sink"])
    pipe = Pipe(q=queue, demux=demux)
    retime = subtitle_bridge.subtitle_pay.install_retime(pipe, "demux")
    os.environ.pop(subtitle_native.DISABLE_ENV, None)
    return pipe, queue, demux, retime, traces


empty = tempfile.mkdtemp()
os.environ["MR_PLUGINS_DIR"], os.environ["MR_LIBEXEC_DIR"] = empty, empty   # no .so anywhere

made = []
pipe, queue, demux, retime, traces = run(fake_gst(True, made=made))
el = retime["native"]
check("available: journal says native", "retime source: native mrpeshouse" in traces)
check("available: spliced queue ! mrpeshouse ! demux, synced, named after the demux",
      el is made[0] and el.kind == "mrpeshouse" and el.name == "demux_peshouse" and el in pipe.children
      and queue.pads["src"].peer is el.pads["sink"] and el.pads["src"].peer is demux.pads["sink"]
      and el.state == "PLAYING")
check("available: no python chunk probe on the demux sink", demux.pads["sink"].probes == [])
cb, args = el.signals["pes-house"]
cb(el, 0x120, 900_000, "ab" * 20, 1_234_500_000, *args)
cb(el, 0x120, 900_900, "cd" * 20, -1, *args)
check("pes-house: hash → house ms recorded, -1 = unknown",
      retime["index"].lookup(bytes.fromhex("ab" * 20), 50_000.0) == 1234.5
      and len(retime["index"]) == 2 and retime["index"].lookup(bytes.fromhex("cd" * 20), 50_000.0) is None)
demux.signals["pad-added"][0](demux, Pad("private_0_0120"), *demux.signals["pad-added"][1])
demux.signals["pad-added"][0](demux, Pad("private_0_0121"), *demux.signals["pad-added"][1])
check("pad-added narrows the element's pids", el.props.get("pids") == "0x120,0x121")

for label, gst, env in (("factory missing, no .so", fake_gst(False), None),
                        ("disabled by MR_SUBTITLE_NATIVE_RETIME=0", fake_gst(True), "0"),
                        ("splice refused", fake_gst(True, refuse=True), None)):
    pipe, queue, demux, retime, traces = run(gst, env)
    check(f"{label}: journal says python probe, the probe is on the demux sink",
          "retime source: python probe" in traces and retime["native"] is None
          and len(demux.pads["sink"].probes) == 1)
    check(f"{label}: graph untouched (queue ! demux, nothing added)",
          queue.pads["src"].peer is demux.pads["sink"] and pipe.children == [queue, demux])
subtitle_bridge.clear()
print("all subtitle_native tests passed")
