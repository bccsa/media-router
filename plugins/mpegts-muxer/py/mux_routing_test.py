#!/usr/bin/env python3
"""Self-checking tests for the mpegts-muxer runner hook (`mux_routing.py`).

  1. Pure helpers: the route classifier agrees with its TS twin
     `muxRouteMedia` (muxPids.test.ts pins the same table); PID parsing;
     parser table.
  2. REAL pipeline: a TS carrying three KLV streams (0x180, 0x181 and the
     name-carousel PID 0x1f0) is demuxed and routed into an mpegtsmux by one
     input with a single `klv` route and `ignorePids: [0x1f0]`. Exactly one
     pad links (to `sink_384`), the other two are sunk with a warning, NO
     error is raised and the mux produces output — the 2026-09-15 restart
     loop (KLV-only TS, tsdemux NOT_LINKED) cannot recur.
  3. PCR pin: audio pins PCR_1 when nothing is pinned, video takes it over,
     a later audio does not take it back.
  4. Sparse route: every buffer restamped to the mux position, none dropped,
     GAP keepalive ticking while idle, no GAP refused.

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run: python3 mux_routing_test.py   (from plugins/mpegts-muxer/py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mux_routing as m  # noqa: E402

failures = 0


def check(name, got, want=True):
    global failures
    ok = got == want
    print(("PASS " if ok else "FAIL ") + f"{name}: got {got!r}" + ("" if ok else f", want {want!r}"))
    if not ok:
        failures += 1


print("1. pure helpers")
TABLE = [
    ("video/x-h264", "video"), ("video/x-h265", "video"), ("audio/mpeg", "audio"),
    ("audio/x-opus", "audio"), ("meta/x-klv", "klv"), ("application/x-teletext", "subtitle"),
    ("subpicture/x-dvb", "subtitle"), ("meta/x-id3", "data"), ("private/x-unmapped", "data"), ("", "data"),
]
for caps_name, want in TABLE:
    check(f"route {caps_name or '<empty>'}", m.route_media_for_caps(caps_name), want)
check("pid from tsdemux pad name", m.pid_from_pad_name("private_0_0181"), 0x181)
check("pid from odd pad name", m.pid_from_pad_name("sink"), None)
check("aac parser", m.parser_for_caps_name("audio/mpeg", 4), "aacparse")
check("mpeg audio parser", m.parser_for_caps_name("audio/mpeg", 1), "mpegaudioparse")
check("klv is parser-free", m.parser_for_caps_name("meta/x-klv"), "")
check("unknown codec", m.parser_for_caps_name("video/x-wmv"), None)

try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover
    print(f"SKIP pipeline sections — GStreamer unavailable ({exc})")
    sys.exit(1 if failures else 0)
Gst.init([])

events = []
CTX = {"emit_event": events.append, "emit_plugin_event": lambda c, p: None}


def run_to_eos(pipe, timeout_s=20):
    loop = GLib.MainLoop()
    result = {"eos": False, "err": None}
    bus = pipe.get_bus()
    bus.add_signal_watch()

    def on_msg(_bus, msg):
        if msg.type == Gst.MessageType.EOS:
            result["eos"] = True
            loop.quit()
        elif msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            result["err"] = f"{err.message} ({dbg})"
            loop.quit()

    bus.connect("message", on_msg)
    GLib.timeout_add_seconds(timeout_s, lambda: (loop.quit(), False)[1])
    pipe.set_state(Gst.State.PLAYING)
    loop.run()
    pipe.set_state(Gst.State.NULL)
    bus.remove_signal_watch()
    return result["eos"], result["err"]


def make_klv_ts(n_buffers=40):
    """A TS with three KLV PES streams on PIDs 0x180, 0x181 and 0x1f0."""
    pipe = Gst.parse_launch(
        "mpegtsmux name=mux alignment=7 "
        'prog-map="program_map,sink_384=(int)1,sink_385=(int)1,sink_496=(int)1,PCR_1=sink_384" '
        "! appsink name=out sync=false emit-signals=false "
        'appsrc name=a format=time caps="meta/x-klv,parsed=true" ! mux.sink_384 '
        'appsrc name=b format=time caps="meta/x-klv,parsed=true" ! mux.sink_385 '
        'appsrc name=c format=time caps="meta/x-klv,parsed=true" ! mux.sink_496 '
    )
    srcs = [pipe.get_by_name(n) for n in ("a", "b", "c")]
    out = pipe.get_by_name("out")
    chunks = []

    def push_all():
        for i in range(n_buffers):
            for k, src in enumerate(srcs):
                payload = bytes([0x06, 0x0E, 0x2B, 0x34] + [k] * 28) + f"cue {i}".encode()
                buf = Gst.Buffer.new_wrapped(payload)
                buf.pts = buf.dts = i * 40 * Gst.MSECOND
                buf.duration = 40 * Gst.MSECOND
                src.emit("push-buffer", buf)
        for src in srcs:
            src.emit("end-of-stream")
        return False

    GLib.idle_add(push_all)
    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect("message", lambda _b, msg: loop.quit() if msg.type in (Gst.MessageType.EOS, Gst.MessageType.ERROR) else None)
    pipe.set_state(Gst.State.PLAYING)

    def drain():
        while True:
            smp = out.emit("try-pull-sample", 0)
            if smp is None:
                return True
            b = smp.get_buffer()
            chunks.append(b.extract_dup(0, b.get_size()))

    GLib.timeout_add(20, drain)
    GLib.timeout_add_seconds(10, lambda: (loop.quit(), False)[1])
    loop.run()
    while True:
        smp = out.emit("try-pull-sample", 0)
        if smp is None:
            break
        b = smp.get_buffer()
        chunks.append(b.extract_dup(0, b.get_size()))
    pipe.set_state(Gst.State.NULL)
    return b"".join(chunks)


print("2. real pipeline — KLV-only TS through one media-agnostic input")
ts = make_klv_ts()
check("generated a TS", len(ts) > 188 * 10 and len(ts) % 188 == 0)
pipe = Gst.parse_launch(
    'appsrc name=src format=time caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188" '
    "! tsdemux name=demux_0 latency=0 "
    'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" '
    "! fakesink name=out sync=false"
)
out_count = {"n": 0}
pipe.get_by_name("mux").get_static_pad("src").add_probe(
    Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST,
    lambda pad, info: (out_count.__setitem__("n", out_count["n"] + 1), Gst.PadProbeReturn.OK)[1],
)
events.clear()
m.install(pipe, {"inputs": [{
    "demux": "demux_0", "linkTo": "mux",
    "routes": {"klv": {"padName": "sink_384", "branch": "queue", "sparse": True},
               "video": {"padName": "sink_256", "branch": "queue"}},
    "ignorePids": [0x1F0], "pcr": {"program": 1},
}]}, CTX)
src = pipe.get_by_name("src")
chunks = [ts[off:off + 188 * 7] for off in range(0, len(ts), 188 * 7)]


def feed():
    if not chunks:
        src.emit("end-of-stream")
        return False
    src.emit("push-buffer", Gst.Buffer.new_wrapped(chunks.pop(0)))
    return True


GLib.timeout_add(10, feed)
eos, err = run_to_eos(pipe)
check("pipeline reached EOS", eos)
check("no GStreamer error", err, None)
linked = [e for e in events if e.get("event") == "pad_linked"]
check("exactly one pad linked", len(linked), 1)
check("the linked pad is the klv route", linked[0].get("media") if linked else None, "klv")
check("linked pad carries its source PID", linked[0].get("pid") if linked else None, 0x180)
check("rule id names the demuxer", linked[0].get("rule") if linked else None, "demux_0::any")
check("no error events", [e for e in events if e.get("event") == "error"], [])
warnings = [e.get("message", "") for e in events if e.get("event") == "warning"]
check("carousel PID 0x1f0 was excluded", any("0x1f0 is excluded" in w for w in warnings))
check("second klv stream was sunk", any("second klv stream" in w for w in warnings))
pads = [p.get_name() for p in pipe.get_by_name("mux").sinkpads]
check("mux got only the pinned request pad", sorted(pads), ["sink_384"])
check("mux produced output", out_count["n"] > 0)
check("sparse klv route armed", len(m.state()["sparse"]), 1)
check("no PCR pin for a klv-only input", m.state()["pcr"].get("mux"), None)
m.clear()
check("clear() drops the hook state", m.state(), None)

print("3. PCR pin — video first, audio only until video shows up")
p3 = Gst.parse_launch(
    'mpegtsmux name=mux prog-map="program_map,sink_256=(int)1,sink_320=(int)1,sink_496=(int)1,PCR_1=sink_256" ! fakesink'
)
m.install(p3, {"inputs": []}, CTX)


def pcr_of(pipe_):
    return pipe_.get_by_name("mux").get_property("prog-map").get_string("PCR_1")


m._pin_pcr_before_link(p3, "mux", 1, "audio", "sink_320", "r")
check("first audio pad takes PCR", pcr_of(p3), "sink_320")
m._pin_pcr_before_link(p3, "mux", 1, "video", "sink_256", "r")
check("video takes PCR over from audio", pcr_of(p3), "sink_256")
m._pin_pcr_before_link(p3, "mux", 1, "audio", "sink_321", "r")
check("a later audio pad does not take PCR back", pcr_of(p3), "sink_256")
m._pin_pcr_before_link(p3, "mux", 1, "video", "sink_257", "r")
check("a second video pad does not re-pin", pcr_of(p3), "sink_256")
other = [k for k in p3.get_by_name("mux").get_property("prog-map").to_string().split(",") if "sink_320=(int)1" in k]
check("other prog-map entries survive the edit", len(other), 1)
p3.set_state(Gst.State.NULL)
m.clear()

print("4. sparse route — restamp to the mux position, GAP keepalive while idle")
p4 = Gst.parse_launch(
    'appsrc name=cue format=time is-live=true caps="meta/x-klv,parsed=true" ! queue name=q4 '
    'mpegtsmux name=mux alignment=7 latency=1000000000 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" ! fakesink sync=false'
)
mux4 = p4.get_by_name("mux")
req4 = mux4.request_pad_simple("sink_384")
p4.get_by_name("q4").get_static_pad("src").link(req4)
m.install(p4, {"inputs": []}, CTX)
st4 = m._arm_sparse_pad(p4, req4, "r4", "klv")
seen4 = []
req4.add_probe(Gst.PadProbeType.BUFFER,
               lambda pad, info: (seen4.append((info.get_buffer().pts, p4.get_clock().get_time() - p4.get_base_time())),
                                  Gst.PadProbeReturn.OK)[1])
p4.set_state(Gst.State.PLAYING)
cue = p4.get_by_name("cue")
loop4 = GLib.MainLoop()
pushed = {"n": 0}


def push_cue():
    rt = p4.get_clock().get_time() - p4.get_base_time()
    b = Gst.Buffer.new_wrapped(b"\x06\x0e\x2b\x34" + bytes(28) + b"cue")
    if pushed["n"] % 2 == 0:          # every other cue carries NO PTS, as tsdemux does
        b.pts = b.dts = rt + 5 * Gst.SECOND
    cue.emit("push-buffer", b)
    pushed["n"] += 1
    return pushed["n"] < 3


GLib.timeout_add(300, push_cue)
GLib.timeout_add(2600, loop4.quit)
loop4.run()
p4.set_state(Gst.State.NULL)
check("every cue buffer reached the mux (none dropped)", len(seen4), 3)
check("every cue buffer was restamped", st4["restamped"], 3)
check("restamped PTS sits at the mux position, PTS or not",
      all(abs(rt - pts) < 300 * Gst.MSECOND for pts, rt in seen4))
check("GAP keepalive ticked throughout (>= 3 in 2.6 s at 500 ms)", st4["gaps"] >= 3)
check("no GAP was refused by the aggregator", st4["gap_refused"], 0)
m.clear()
check("clear() removed the GAP timer", st4["timer"], None)

print()
if failures:
    print(f"{failures} check(s) FAILED")
    sys.exit(1)
print("all checks passed")
