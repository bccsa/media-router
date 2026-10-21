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
     a later audio does not take it back; a pin the map already holds writes
     nothing.
  4. Timestamps are the branch's (house-clock WI-P2-12): in the real runs of
     2 and 2b every cue reaches the mux with its own PTS (no restamp), and the
     hook adds no timer and no pad probe (no GAP keepalive).
  5. Inputs adding pads at once: the routing decision and the prog-map edit
     run one input at a time (mpegtsmux swaps its map unlocked).

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run: python3 mux_routing_test.py   (from plugins/mpegts-muxer/py)
"""
import contextlib
import os
import sys
import threading
import time

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


print("1b. PMT classifier + output-PID planner (one PID per input)")
KLVA = (0x05, b"KLVA")
OPUS = (0x05, b"Opus")
check("h264 by stream_type", m.pmt_stream_media(0x1B), "video")
check("hevc by stream_type", m.pmt_stream_media(0x24), "video")
check("aac by stream_type", m.pmt_stream_media(0x0F), "audio")
check("metadata PES is klv", m.pmt_stream_media(0x15), "klv")
check("0x06 + KLVA is klv", m.pmt_stream_media(0x06, [KLVA]), "klv")
check("0x06 + teletext desc is subtitle", m.pmt_stream_media(0x06, [(0x0A, None), (0x56, None)]), "subtitle")
check("0x06 + dvbsub desc is subtitle", m.pmt_stream_media(0x06, [(0x59, None)]), "subtitle")
check("0x06 + Opus registration is audio", m.pmt_stream_media(0x06, [OPUS]), "audio")
check("0x06 + Opus DVB extension is audio", m.pmt_stream_media(0x06, [(0x7F, 0x80)]), "audio")
check("0x06 + AC-3 desc is audio", m.pmt_stream_media(0x06, [(0x6A, None)]), "audio")
check("0x06 with only a language desc is data", m.pmt_stream_media(0x06, [(0x0A, None)]), "data")
check("0x06 with an unreadable registration is data", m.pmt_stream_media(0x06, [(0x05, None)]), "data")
check("unknown stream_type is data", m.pmt_stream_media(0x7F), "data")

ROUTABLE = {"video", "audio", "klv", "subtitle"}
# Subtitle-only input: the cue stream lands on exactly the input's PID.
check("klv-only input → klv on the input PID", m.plan_output_pid(264, "klv", {"klv"}, ROUTABLE, {}, {264}), 264)
# Video + klv input, klv pad first: video is the primary (PMT says so), klv spills.
taken = {264, 272}
a = {}
p1 = m.plan_output_pid(264, "klv", {"video", "klv"}, ROUTABLE, a, taken); a["klv"] = p1; taken.add(p1)
check("video+klv, klv first → klv spills to the next free PID", p1, 265)
p2 = m.plan_output_pid(264, "video", {"video", "klv"}, ROUTABLE, a, taken); a["video"] = p2
check("… and video takes the input PID", p2, 264)
check("a class already assigned keeps its PID", m.plan_output_pid(264, "klv", {"video", "klv"}, ROUTABLE, a, taken), 265)
# Spill skips other inputs' PIDs and reserved ones.
check("spill skips a PID another input owns", m.plan_output_pid(264, "audio", {"video", "audio"}, ROUTABLE, {"video": 264}, {264, 265, 266}), 267)
check("spill skips the reserved carousel PID", m.plan_output_pid(0x1EF, "audio", {"video", "audio"}, ROUTABLE, {"video": 0x1EF}, {0x1EF}), 0x1F1)
# Out of PIDs above the input: None (the native form returns -1); the hook reports and sinks.
check("exhausted → None", m.plan_output_pid(0x1FFD, "audio", {"video", "audio"}, ROUTABLE, {"video": 0x1FFD}, {0x1FFD, 0x1FFE}), None)
# No PMT seen yet: the first pad is treated as primary.
check("no PMT → first pad takes the input PID", m.plan_output_pid(300, "audio", set(), ROUTABLE, {}, {300}), 300)
# PMT lists a video the routes cannot take (no video route): audio is primary.
check("primary skips classes without a route", m.plan_output_pid(300, "audio", {"video", "audio"}, {"audio"}, {}, {300}), 300)

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

# Every GLib timer and pad probe the hook itself adds (none since WI-P2-12: a
# cue route's aligner fills between cues, so the hook keeps no GAP keepalive).
hook_added = []


def _spy(owner, name):
    real = getattr(owner, name)

    def wrapper(*args, **kwargs):
        if sys._getframe(1).f_globals.get("__name__") == m.__name__:
            hook_added.append(name)
        return real(*args, **kwargs)
    setattr(owner, name, wrapper)


for _name in ("timeout_add", "timeout_add_seconds", "idle_add"):
    _spy(GLib, _name)
_spy(Gst.Pad, "add_probe")


def pes_pts(data, pid):
    """PTS (90 kHz) of every PES that starts on `pid` in a TS byte string."""
    out = []
    for off in range(0, len(data) - 187, 188):
        pkt = data[off:off + 188]
        if pkt[0] != 0x47 or not pkt[1] & 0x40 or ((pkt[1] & 0x1F) << 8 | pkt[2]) != pid:
            continue
        h = pkt[4 + (1 + pkt[4] if pkt[3] & 0x20 else 0):]
        if h[:3] == b"\x00\x00\x01" and h[7] & 0x80:
            out.append(((h[9] >> 1) & 7) << 30 | h[10] << 22 | (h[11] >> 1) << 15 | h[12] << 7 | h[13] >> 1)
    return out


def tap_ts(pad, chunks):
    """Collect every byte `pad` pushes (buffers and buffer lists)."""
    def on_data(_pad, info):
        lst = info.get_buffer_list()
        bufs = [lst.get(i) for i in range(lst.length())] if lst is not None else [info.get_buffer()]
        chunks.extend(b.extract_dup(0, b.get_size()) for b in bufs if b is not None)
        return Gst.PadProbeReturn.OK
    pad.add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, on_data)


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
# Bytes: tsdemux times each cue from its PES PTS, so the mux output shows what the
# hook did to the timestamps.
pipe = Gst.parse_launch(
    'appsrc name=src format=bytes caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188" '
    "! tsdemux name=demux_0 latency=0 "
    'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" '
    "! fakesink name=out sync=false"
)
out_ts = []
tap_ts(pipe.get_by_name("mux").get_static_pad("src"), out_ts)
events.clear()
hook_added.clear()
m.install(pipe, {"inputs": [{
    "demux": "demux_0", "linkTo": "mux",
    "routes": {"klv": {"padName": "sink_384", "branch": "queue"},
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
check("mux produced output", len(out_ts) > 0)
IN_PTS = pes_pts(ts, 0x180)
OUT_PTS = pes_pts(b"".join(out_ts), 0x180)
check(f"every cue written ({len(OUT_PTS)} of {len(IN_PTS)})", len(OUT_PTS) == len(IN_PTS) == 40)
check("no restamp: each cue keeps its own PTS, one offset for all (the source spacing, 40 ms)",
      len({o - i for o, i in zip(OUT_PTS, IN_PTS)}) == 1)
check("no GAP keepalive: the hook added no timer and no pad probe", hook_added, [])
check("the hook keeps no sparse state", sorted(m.state()), ["bus", "handlers", "inputs", "pcr", "taken", "warned"])
check("no PCR pin for a klv-only input", m.state()["pcr"].get("mux"), None)
m.clear()
check("clear() drops the hook state", m.state(), None)

print("2b. real pipeline — generic input: the klv-only TS lands on exactly the input PID")
pipe_g = Gst.parse_launch(
    'appsrc name=src format=bytes caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188" '
    "! tsdemux name=demux_0 latency=0 "
    'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_300=(int)1,PCR_1=sink_300" '
    "! fakesink name=out sync=false"
)
out_g = []
tap_ts(pipe_g.get_by_name("mux").get_static_pad("src"), out_g)
events.clear()
hook_added.clear()
plugin_events = []
m.install(pipe_g, {"inputs": [{
    "demux": "demux_0", "linkTo": "mux", "pid": 300,
    "routes": {"video": {"branch": "queue"}, "audio": {"branch": "queue"},
               "klv": {"branch": "queue"}, "subtitle": {"branch": "queue"}},
    "ignorePids": [0x1F0], "pcr": {"program": 1},
}]}, {"emit_event": events.append, "emit_plugin_event": lambda c, p: plugin_events.append((c, p))})
check("PMT watch armed for a generic input", m.state()["bus"] is not None)
src_g = pipe_g.get_by_name("src")
chunks_g = [ts[off:off + 188 * 7] for off in range(0, len(ts), 188 * 7)]


def feed_g():
    if not chunks_g:
        src_g.emit("end-of-stream")
        return False
    src_g.emit("push-buffer", Gst.Buffer.new_wrapped(chunks_g.pop(0)))
    return True


GLib.timeout_add(10, feed_g)
eos_g, err_g = run_to_eos(pipe_g)
check("generic: pipeline reached EOS", eos_g)
check("generic: no GStreamer error", err_g, None)
linked_g = [e for e in events if e.get("event") == "pad_linked"]
check("generic: exactly one pad linked", len(linked_g), 1)
check("generic: klv went to the INPUT PID, not pid+2", linked_g[0].get("outPid") if linked_g else None, 300)
check("generic: PMT classes were read before linking", m.state()["inputs"]["demux_0"]["classes"], {"klv"})
check("generic: mux got sink_300 only", sorted(p.get_name() for p in pipe_g.get_by_name("mux").sinkpads), ["sink_300"])
check("generic: mux:routed plugin event", [(c, p["media"], p["outPid"], p["srcPid"]) for c, p in plugin_events],
      [("mux:routed", "klv", 300, 0x180)])
check("generic: mux produced output", len(out_g) > 0)
OUT_G = pes_pts(b"".join(out_g), 300)
check("generic: every cue written on the input PID with its own PTS (no restamp)",
      len(OUT_G) == len(IN_PTS) and len({o - i for o, i in zip(OUT_G, IN_PTS)}) == 1)
check("generic: the hook added only its PMT watch — no timer, no pad probe", hook_added, [])
check("generic: no error events", [e for e in events if e.get("event") == "error"], [])
m.clear()
check("generic: clear() drops the bus watch too", m.state(), None)

print("2c. prog-map gains an entry for a spilled PID before the pad is requested")
p2c = Gst.parse_launch('mpegtsmux name=mux prog-map="program_map,sink_300=(int)1,PCR_1=sink_300" ! fakesink')
m._state = {"pcr": {}, "handlers": [], "warned": set(), "taken": set(), "inputs": {}, "bus": None}
m._ensure_prog_map(p2c, "mux", 1, "sink_301")
pm = p2c.get_by_name("mux").get_property("prog-map").to_string()
check("spilled PID added to program 1", "sink_301=(int)1" in pm)
check("existing entries kept", "sink_300=(int)1" in pm and "PCR_1=(string)sink_300" in pm.replace("PCR_1=sink_300", "PCR_1=(string)sink_300"))
m._ensure_prog_map(p2c, "mux", 1, "sink_301")
check("idempotent", p2c.get_by_name("mux").get_property("prog-map").to_string().count("sink_301") == 1)
m._state = None

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
# The builder already pins the first input's PID: that pin writes nothing (each write frees the
# map mpegtsmux reads when a pad's first buffer creates its stream), a changed one still does.
p3b = Gst.parse_launch('mpegtsmux name=mux prog-map="program_map,sink_256=(int)1,PCR_1=sink_256" ! fakesink')
m.install(p3b, {"inputs": []}, CTX)
writes = []
p3b.get_by_name("mux").connect("notify::prog-map", lambda *_a: writes.append(1))
m._pin_pcr_before_link(p3b, "mux", 1, "video", "sink_256", "r")
check("a pin the map already holds writes nothing, and is still the pin", (len(writes), m.state()["pcr"]["mux"]),
      (0, {"media": "video", "pad": "sink_256"}))
m.clear()
m.install(p3b, {"inputs": []}, CTX)
m._pin_pcr_before_link(p3b, "mux", 1, "audio", "sink_320", "r")
check("a pin that changes PCR writes once", (len(writes), pcr_of(p3b)), (1, "sink_320"))
p3b.set_state(Gst.State.NULL)
m.clear()

print("4. no sparse machinery left in the hook")
check("no restamp helper, no GAP cadence", [n for n in ("_sparse_position", "_arm_sparse_pad", "SPARSE_GAP_MS",
                                                      "SPARSE_GAP_LEAD_MS") if hasattr(m, n)], [])

print("5. inputs adding pads at once: one routing decision and one prog-map edit at a time")
# Each demux adds its pads on its own streaming thread, and mpegtsmux frees its old prog-map
# on every set, unlocked: two inputs editing it together double-freed it (native, 2026-10-17).
# The probe stretches each edit to 50 ms and counts the entries that overlap one in flight;
# it runs the real edit under a lock of its own, so even the mutant never races in C.


def concurrent_run(n_in=4):
    """`n_in` generic klv-only inputs pushed together: (overlapping edits, linked output
    PIDs, the mux's prog-map, error events, EOS, GStreamer error)."""
    pids = [300 + 10 * i for i in range(n_in)]
    p5 = Gst.parse_launch(
        " ".join(f'appsrc name=src{i} format=bytes caps="video/mpegts,systemstream=(boolean)true,packetsize=(int)188" '
                 f"! tsdemux name=demux_{i} latency=0" for i in range(n_in))
        + ' mpegtsmux name=mux alignment=7 prog-map="program_map,PCR_1=sink_300" ! fakesink sync=false')
    events.clear()
    m.install(p5, {"inputs": [{
        "demux": f"demux_{i}", "linkTo": "mux", "pid": pid,
        "routes": {c: {"branch": "queue"} for c in ("video", "audio", "klv", "subtitle")},
        "ignorePids": [0x1F0], "pcr": {"program": 1}} for i, pid in enumerate(pids)]}, CTX)
    real, own, count = m._ensure_prog_map, threading.Lock(), threading.Lock()
    inside, overlaps = [0], [0]

    def stretched(*args):
        with count:
            inside[0] += 1
            overlaps[0] += inside[0] > 1
        time.sleep(0.05)
        try:
            with own:
                return real(*args)
        finally:
            with count:
                inside[0] -= 1

    m._ensure_prog_map = stretched
    srcs = [p5.get_by_name(f"src{i}") for i in range(n_in)]
    left = [ts[off:off + 188 * 7] for off in range(0, len(ts), 188 * 7)]

    def feed_all():
        if not left:
            for s in srcs:
                s.emit("end-of-stream")
            return False
        chunk = left.pop(0)
        for s in srcs:
            s.emit("push-buffer", Gst.Buffer.new_wrapped(chunk))
        return True

    GLib.timeout_add(10, feed_all)
    try:
        eos5, err5 = run_to_eos(p5)
    finally:
        m._ensure_prog_map = real
    linked5 = sorted(e.get("outPid") for e in events if e.get("event") == "pad_linked")
    prog_map = p5.get_by_name("mux").get_property("prog-map").to_string()
    errors = [e for e in events if e.get("event") == "error"]
    m.clear()
    return overlaps[0], linked5 == pids, prog_map, errors, eos5, err5


over5, linked_ok, pm5, errors5, eos5, err5 = concurrent_run()
check("4 inputs: every klv lands on its input's own PID, no error, EOS",
      (linked_ok, errors5, eos5, err5), (True, [], True, None))
check("4 inputs: every input PID went into prog-map", all(f"sink_{p}=(int)1" in pm5 for p in (300, 310, 320, 330)))
check("4 inputs: no prog-map edit overlapped another (the hook lock held across decision and edit)", over5, 0)
_lock = m._lock
m._lock = contextlib.nullcontext()
try:
    over_mut = concurrent_run()[0]
finally:
    m._lock = _lock
check(f"mutant, the hook lock taken out: the edits overlap ({over_mut}), so the check above can fail",
      over_mut > 0)

print()
if failures:
    print(f"{failures} check(s) FAILED")
    sys.exit(1)
print("all checks passed")
