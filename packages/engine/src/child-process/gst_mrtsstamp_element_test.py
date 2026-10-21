#!/usr/bin/env python3
"""Self-checking tests for the bus egress stamper element (`mrtsstamp`, plan ch. 6 WI-P2-3).

The runner loads `plugins/mpegts-core/native/mrtsstamp/libgstmrtsstamp.so` (via
`gst_bus_stamper.py`), splices an `mrtsstamp` at the head of each `busout_*` egress and
toggles `active` from the bus_attach / bus_detach paths. Every armed buffer is stamped by
identity: the house time its first timing PES carries, `PES − 1 h`, under a monotone floor.
The lifecycle through the runner is gst_bus_stamper_test.py's; this file is the element.

What is pinned here:

  --  The runner's own resolver finds and loads the plugin (no GST_PLUGIN_PATH), version
      3.0.0 with the identity interface only, and the element lands at the HEAD of the
      egress — before the caps pair and the tee, so one stamp serves every consumer edge.
  --  Coalescing (ADR-0011): one bus buffer per buffer list, armed or not.
  R2  Every armed buffer carries a valid PTS and DTS, non-decreasing; a PES-less buffer
      repeats the stamp; the stamp is PES − 1 h exactly, whatever the arrival; a 2^33 wrap
      of the PES field is continuous; a non-identity segment still puts house time on the wire.
  --  Counters: in place upstream of the tee (copy-count 0), one shallow copy per shared
      buffer, bytes-total armed and in passthrough.
  --  A real mpegtsmux at alignment 0 and 7: one buffer per access-unit list, PES − 1 h.
  R1  The stamp survives a real tsdemux: a wrong DTS and jittered pushes leave no trace,
      because the element writes DTS too (tsdemux reads DTS first).
  --  Base-aware identity (WI-P1-7): base time 10 h and 14 h, wire = PES − 1 h.
  --  Gap markers (OQ-12, B-10, B-19): a marker leaves with its PTS, duration and flags and
      no DTS; a list holding one goes member by member; the restamp's marker keeps the PES
      behind it in the 5 s edge queue.

Skips (exit 0) where GStreamer / PyGObject is unavailable, or where the plugin
has not been built (`make native`).

Run:  python3 gst_mrtsstamp_element_test.py
"""
import importlib.util
import io
import os
import random
import shutil
import sys
import tempfile
import time
from contextlib import redirect_stderr

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtsstamp_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path.
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))

_RUNNER = os.environ.get("MR_STAMPER_RUNNER") or os.path.join(
    _HERE, "gst-pipeline-runner.py")
# The runner imports its egress-stamper subsystem as a sibling module, exactly
# as python does for the spawned script (script dir on sys.path[0]). A mutated
# runner copy (MR_STAMPER_RUNNER) may ship its own, so its directory wins.
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(_RUNNER)))
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

import gst_bus_stamper as stamper  # noqa: E402  (the module the runner just imported)

import ts_psi  # noqa: E402  (after the sys.path insert above)
import ts_timeline as _tl  # noqa: E402  (its kept helpers: pts90k_to_ns, house_from_mux_pts)

Gst.init(sys.argv)

if not any(os.path.exists(p) for p in stamper.so_paths()):
    print("SKIP gst_mrtsstamp_element_test.py — mrtsstamp plugin not built "
          f"({', '.join(stamper.so_paths())}); run `make native`")
    sys.exit(0)

_failures = []
STAMP_EL = stamper.ELEMENT_PREFIX + "busout_41000"
STEP = 3600                      # 40 ms in 90 kHz ticks
MUX = _tl.MUX_CLOCK_BASE_90K     # mpegtsmux's 1 h


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# --- synthetic TS fixture (identical to gst_bus_stamper_test.py) ------------
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"


def pes_packet(pid, pts90k, cc=0):
    hdr = bytes([ts_psi.SYNC, 0x40 | ((pid >> 8) & 0x1F), pid & 0xFF, 0x10 | (cc & 0x0F)])
    p = pts90k & ((1 << 33) - 1)
    pts_bytes = bytes([
        0x21 | (((p >> 30) & 0x07) << 1),
        (p >> 22) & 0xFF,
        0x01 | (((p >> 15) & 0x7F) << 1),
        (p >> 7) & 0xFF,
        0x01 | ((p & 0x7F) << 1),
    ])
    payload = b"\x00\x00\x01\xe0\x00\x00\x80\x80\x05" + pts_bytes
    pkt = hdr + payload
    return pkt + b"\xff" * (ts_psi.PKT - len(pkt))


def filler_packet(pid=0x1FFF, cc=0):
    hdr = bytes([ts_psi.SYNC, (pid >> 8) & 0x1F, pid & 0xFF, 0x10 | (cc & 0x0F)])
    return hdr + b"\xff" * (ts_psi.PKT - 4)


def content0(pipe):
    """90 kHz content time 1 s ahead of the pipeline's house clock: a PES of it is this + 1 h,
    as a mux on the house clock writes it."""
    return pipe.get_pipeline_clock().get_time() * 9 // 100000 + 90000


def house(c90k):
    """The identity stamp of content `c90k` (90 kHz, unwrapped): its house time in ns."""
    return _tl.pts90k_to_ns(c90k)


# --- harness ---------------------------------------------------------------
# The egress fragment is `busHelpers.buildBusSink` minus the lateness tap, because WHERE
# the element gets spliced is part of what is under test.
BUS_SINK = (f'capssetter caps="{TS_CAPS}" replace=true ! '
            f'capsfilter name=busfilter caps="{TS_CAPS}" ! '
            "tee name=busout_41000 allow-not-linked=true")


def build_pipe(consumer="busout_41000. ! identity name=tap ! fakesink name=fs "
                        "sync=false async=false"):
    pipe = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time do-timestamp=false caps={TS_CAPS} "
        f"! {BUS_SINK} {consumer}")
    return pipe, pipe.get_by_name("src")


class Bus:
    """Bus messages delivered to the runner's REAL handler, which is what turns the element's
    messages into events and log lines (`err`). The element messages are recorded too.
    EOS/ERROR are watched here rather than popped, because a signal watch owns the queue."""

    def __init__(self, pipe):
        self.done = []
        self.events = []
        self.messages = []
        self.err = io.StringIO()
        runner.emit_event = self.events.append
        bus = pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message::element", runner.on_bus_message)
        bus.connect("message::element", self._record)
        bus.connect("message::eos", lambda _b, m: self.done.append(m))
        bus.connect("message::error", lambda _b, m: self.done.append(m))

    def _record(self, _bus, msg):
        s = msg.get_structure()
        if s is not None and s.get_name().startswith("mrtsstamp-"):
            fields = {s.nth_field_name(i): s.get_value(s.nth_field_name(i))
                      for i in range(s.n_fields())}
            self.messages.append((msg.src.get_name(), s.get_name(), fields))

    def pump(self, seconds=0.15):
        ctx = GLib.MainContext.default()
        deadline = time.time() + seconds
        with redirect_stderr(self.err):
            while time.time() < deadline:
                if not ctx.iteration(False):
                    time.sleep(0.002)

    def wait(self, seen, n, timeout_s=5.0):
        deadline = time.time() + timeout_s
        while len(seen) < n and time.time() < deadline:
            self.pump(0.01)
        self.pump(0.05)
        return len(seen)

    def drain(self, pipe, src, timeout_s=10):
        src.emit("end-of-stream")
        deadline = time.time() + timeout_s
        while not self.done and time.time() < deadline:
            self.pump(0.02)
        pipe.set_state(Gst.State.NULL)
        return bool(self.done) and self.done[0].type == Gst.MessageType.EOS

    def of(self, kind):
        return [m for m in self.messages if m[1] == kind]


def tap_timestamps(pipe, name="tap"):
    seen = []

    def _on_buffer(_pad, info):
        buf = info.get_buffer()
        seen.append((buf.pts, buf.dts))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name(name).get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, _on_buffer)
    return seen


def push(src, payload, pts, dts):
    buf = Gst.Buffer.new_wrapped(payload)
    buf.pts = pts
    buf.dts = dts
    return src.emit("push-buffer", buf) == Gst.FlowReturn.OK


def start(pipe):
    """What handle_start does for every pipeline: contract clock, then the stamper, which is
    where the element gets spliced in."""
    runner.pipeline = pipe
    stamper.native_loaded = None
    runner._apply_contract_clock(pipe)
    stamper.enable(pipe)


def teardown():
    stamper.clear()
    runner.pipeline = None


def uptime_clock(at_ns):
    """A monotonic clock of its own reading `at_ns` now, whatever this box's
    uptime; the process-wide system clock is left alone."""
    clock = Gst.SystemClock(clock_type=Gst.ClockType.MONOTONIC)
    clock.set_calibration(clock.get_internal_time(), at_ns, 1, 1)
    return clock


# ---------------------------------------------------------------------------
print("\n--- the runner resolves and loads the plugin itself ---")
stamper.native_loaded = None
check("the runner's own resolver loads the plugin (no GST_PLUGIN_PATH)",
      stamper.load_native() is True and stamper.missing() is False)
check("and the element factory is registered",
      Gst.ElementFactory.find("mrtsstamp") is not None)
check("the resolver looks in the plugin's own folder first, install root second",
      [os.path.basename(os.path.dirname(p)) for p in stamper.so_paths()]
      == ["mrtsstamp", "mpegts-core"])
plugin = Gst.Registry.get().find_plugin("mrtsstamp")
check("the plugin is 3.0.0, the identity-only interface",
      plugin is not None and plugin.get_version() == "3.0.0")
probe_el = Gst.ElementFactory.make("mrtsstamp")
own = sorted(p.name for p in probe_el.list_properties()
             if p.owner_type == probe_el.__gtype__)
check(f"its own properties are the identity ones only ({own})",
      own == ["active", "bytes-total", "coalesce", "coalesced-lists", "copy-count"])
check("it arrives inactive, coalescing", probe_el.get_property("active") is False
      and probe_el.get_property("coalesce") is True)


# ---------------------------------------------------------------------------
print("\n--- the element is spliced at the HEAD of the egress, inactive ---")
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
check("an mrtsstamp is inserted for the busout tee", el is not None)
upstream = el.get_static_pad("sink").get_peer()
downstream = el.get_static_pad("src").get_peer()
# ADR-0011: before the caps pair, not between the capsfilter and the tee — a
# basetransform (capssetter, capsfilter) dismantles the mux's buffer lists,
# and the element must see them whole to coalesce them.
check("its upstream peer is the mux (here the appsrc) — ahead of the caps pair",
      upstream is not None and upstream.get_parent_element().get_name() == "src")
check("its downstream peer is the capssetter — the fan-out is BELOW the stamp",
      downstream is not None
      and downstream.get_parent_element().get_factory().get_name() == "capssetter")
tee_up = pipe.get_by_name("busout_41000").get_static_pad("sink").get_peer()
check("the tee's own upstream is still the capsfilter (strings untouched)",
      tee_up is not None and tee_up.get_parent_element().get_name() == "busfilter")
check("it arrives inactive (enabling alone arms nothing)",
      el.get_property("active") is False and stamper.armed == [])
teardown()
pipe.set_state(Gst.State.NULL)


# ---------------------------------------------------------------------------
print("\n--- egress_head: walks every caps-only element, stops at the producer ---")
# Two capsfilters and a capssetter in front of the tee: the walk must pass ALL
# of them and land on the producer's src pad.
p2 = Gst.parse_launch(
    f"appsrc name=src2 caps={TS_CAPS} ! capsfilter caps={TS_CAPS} ! capssetter caps=\"{TS_CAPS}\" replace=true "
    f"! capsfilter caps={TS_CAPS} ! tee name=busout_41001 allow-not-linked=true")
peer, sink = stamper.native.egress_head(p2.get_by_name("busout_41001"))
check("multi-caps walk lands on the producer (appsrc) src pad",
      peer is not None and peer.get_parent_element().get_name() == "src2")
check("and the returned sink is the FIRST caps element's sink (the splice point)",
      sink is not None and sink.get_parent_element().get_factory().get_name() == "capsfilter"
      and sink.get_parent_element().get_static_pad("sink").get_peer() == peer)
# A tee with a non-caps element directly upstream: the walk stops there.
p3 = Gst.parse_launch(f"appsrc name=src3 caps={TS_CAPS} ! queue name=q3 ! tee name=busout_41002 allow-not-linked=true")
peer3, sink3 = stamper.native.egress_head(p3.get_by_name("busout_41002"))
check("a non-caps upstream (queue) is the head — the walk does not pass it",
      peer3 is not None and peer3.get_parent_element().get_name() == "q3"
      and sink3.get_parent_element().get_name() == "busout_41002")
# A tee with nothing upstream at all.
p4 = Gst.parse_launch("tee name=busout_41003 allow-not-linked=true ! fakesink")  # sink pad unlinked
check("no upstream at all → (None, None), never an exception",
      stamper.native.egress_head(p4.get_by_name("busout_41003")) == (None, None))
for p in (p2, p3, p4):
    p.set_state(Gst.State.NULL)

# The egress lateness tap (buildBusSink, WI-P0-8) sits between the caps pair
# and the tee: the stamp must land AHEAD of it, so it reads the stamp.
import gst_lateness_native  # noqa: E402
if gst_lateness_native.load_plugin():
    p5 = Gst.parse_launch(
        f"appsrc name=src5 caps={TS_CAPS} ! capssetter caps=\"{TS_CAPS}\" replace=true "
        f"! capsfilter caps={TS_CAPS} ! mrlateness name=lat_busout_41004 reference=house "
        f"! tee name=busout_41004 allow-not-linked=true")
    peer5, sink5 = stamper.native.egress_head(p5.get_by_name("busout_41004"))
    check("egress_head walks past the lateness tap to the producer",
          peer5 is not None and peer5.get_parent_element().get_name() == "src5"
          and sink5.get_parent_element().get_factory().get_name() == "capssetter")
    p5.set_state(Gst.State.NULL)
else:
    print("SKIP lateness-tap splice check — libgstmrlateness.so not built")


# ---------------------------------------------------------------------------
print("\n--- coalesce (ADR-0011): one bus buffer per buffer LIST, armed or not ---")
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
sizes = []


def _size_probe(_pad, info):
    buf = info.get_buffer()
    if buf is not None:
        sizes.append((buf.get_size(), buf.pts, buf.dts))
    return Gst.PadProbeReturn.OK


pipe.get_by_name("tap").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, _size_probe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
check("coalescing is on by default", el.get_property("coalesce") is True)


def push_list(members, pts, dts):
    """A mux-shaped list: N whole-packet buffers of one access unit, the
    timestamps on every member (what mpegtsmux alignment=7 emits)."""
    lst = Gst.BufferList.new()
    for m in members:
        b = Gst.Buffer.new_wrapped(m)
        b.pts, b.dts = pts, dts
        lst.insert(-1, b)
    assert src.emit("push-buffer-list", lst) == Gst.FlowReturn.OK


members = [pes_packet(0x100, 900000, 0), filler_packet(cc=1), filler_packet(cc=2)]
push_list(members, 10 * Gst.MSECOND, 10 * Gst.MSECOND + 7)
bus.wait(sizes, 1)
check("a 3-member list arrives downstream as ONE buffer of the concatenated bytes",
      len(sizes) == 1 and sizes[0][0] == 3 * ts_psi.PKT)
check("carrying the first member's timestamps",
      sizes and sizes[0][1] == 10 * Gst.MSECOND and sizes[0][2] == 10 * Gst.MSECOND + 7)
check("and the element counted the merge", el.get_property("coalesced-lists") == 1)
check("bytes-total counts the coalesced bytes once",
      el.get_property("bytes-total") == 3 * ts_psi.PKT)
push(src, filler_packet(cc=3), 20 * Gst.MSECOND, 20 * Gst.MSECOND)
bus.wait(sizes, 2)
check("a plain buffer still passes as itself", len(sizes) == 2 and sizes[1][0] == ts_psi.PKT)
el.set_property("coalesce", False)
push_list([filler_packet(cc=4), filler_packet(cc=5)], 30 * Gst.MSECOND, 30 * Gst.MSECOND)
bus.wait(sizes, 4)
check("coalesce=false hands the members on one by one",
      len(sizes) == 4 and sizes[2][0] == ts_psi.PKT and sizes[3][0] == ts_psi.PKT
      and el.get_property("coalesced-lists") == 1)
bus.drain(pipe, src)
teardown()


# ---------------------------------------------------------------------------
print("\n--- R2: every buffer carries a valid, non-decreasing PTS (and DTS), PES − 1 h ---")


def run_ladder(entries, jitter=True, pid=0x100):
    """Push a PES ladder through one armed egress: entry i is content `c0 + i * STEP` on the
    house clock (None = a PES-less filler buffer). Returns (tap timestamps, bus, c0)."""
    pipe, src = build_pipe()
    b = Bus(pipe)
    start(pipe)
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    seen = tap_timestamps(pipe)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    c0 = content0(pipe)
    for i, k in enumerate(entries):
        if k is None:
            push(src, filler_packet(), 0, 0)
        else:
            # Arrival-jittered PTS and a nonsense DTS: what the stamp replaces.
            push(src, pes_packet(pid, MUX + c0 + k * STEP, i),
                 i * 7 * Gst.MSECOND if jitter else 0, 3 * Gst.SECOND)
    b.wait(seen, len(entries))
    b.drain(pipe, src)
    teardown()
    return seen, b, c0


ladder = [None if i in (3, 7) else i for i in range(12)]
seen, bus, c0 = run_ladder(ladder)
check("every buffer got a PTS (none left CLOCK_TIME_NONE)",
      len(seen) == 12 and all(p != Gst.CLOCK_TIME_NONE for p, _ in seen))
check("the ladder is monotone non-decreasing",
      all(seen[i][0] <= seen[i + 1][0] for i in range(len(seen) - 1)))
check("DTS is stamped too (tsdemux prefers DTS — see R1)",
      all(dts == pts for pts, dts in seen))
expected, last = [], None
for k in ladder:
    last = last if k is None else house(c0 + k * STEP)
    expected.append(last)
check("the stamp is PES − 1 h, exactly; a PES-less buffer repeats the previous stamp",
      [p for p, _ in seen] == expected and seen[3][0] == seen[2][0] and seen[7][0] == seen[6][0])
check("arrival jitter is gone — the ladder is a clean 40 ms step",
      {seen[i + 1][0] - seen[i][0] for i in (0, 1, 4, 5)} == {40_000_000})
ident = bus.of("mrtsstamp-identity")
check("one mrtsstamp-identity message names the first PES (pid, stamp, PTS)",
      len(ident) == 1 and ident[0][0] == STAMP_EL
      and ident[0][2] == {"pid": 0x100, "stamp": house(c0), "pts": (MUX + c0) % (1 << 33)})
check("the runner logs it as the identity line",
      f"busStamp busout_41000: identity egress: first PES pid=0x100 stamp={house(c0)} "
      f"pts={(MUX + c0) % (1 << 33)}" in bus.err.getvalue())
# A timing PES behind its floor (a B-frame's first PES) is held there, never stamped back.
seen, bus, c0 = run_ladder([0, 1, 2, 1, 3], jitter=False)
check("a PES behind the last stamp is held at the floor",
      [p for p, _ in seen] == [house(c0), house(c0 + STEP), house(c0 + 2 * STEP),
                               house(c0 + 2 * STEP), house(c0 + 3 * STEP)])


# ---------------------------------------------------------------------------
print("\n--- 2^33 wraps are continuous: the PES field at 25.5 h, the content at 26.5 h ---")
# Content 1 s ahead of a house clock that sits three buffers before the wrap; identity
# unwraps near the clock, so neither the field's nor the content's wrap shows.
WRAP = 1 << 33
for what, c_wrap in (("the PES field", WRAP - 3 * STEP - MUX), ("the content", WRAP - 3 * STEP)):
    pipe, src = build_pipe()
    bus = Bus(pipe)
    start(pipe)
    pipe.use_clock(uptime_clock(house(c_wrap - 90000)))
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    seen = tap_timestamps(pipe)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    for i in range(24):
        push(src, pes_packet(0x100, (MUX + c_wrap + i * STEP) % WRAP, i), i * Gst.MSECOND, 0)
    bus.wait(seen, 24)
    bus.drain(pipe, src)
    teardown()
    wraps = ((MUX + c_wrap) % WRAP > (MUX + c_wrap + 23 * STEP) % WRAP if what == "the PES field"
             else c_wrap % WRAP > (c_wrap + 23 * STEP) % WRAP)
    check(f"{what}: the fixture really wraps", wraps)
    check(f"{what}: every step across the wrap is the plain 40 ms, on the content's house time",
          len(seen) == 24 and [p for p, _ in seen] == [house(c_wrap + i * STEP) for i in range(24)])


# ---------------------------------------------------------------------------
print("\n--- a NON-IDENTITY segment still puts house time on the wire ---")
# What leaves the process is gst_segment_to_running_time(segment, pts) + base_time, so on
# any segment but the identity one a raw stamp ships shifted and nothing notices.
# `transform_ip` maps the house stamp back through the transform's own segment.
SEG_OFFSET = 5 * Gst.SECOND
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
# A pad offset on the source is how a real pipeline gets here; it lands as a
# non-zero `base` on the segment every downstream element sees.
src.get_static_pad("src").set_offset(SEG_OFFSET)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
c0 = content0(pipe)
for i in range(8):
    push(src, pes_packet(0x100, MUX + c0 + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 8)
tap_seg_ev = pipe.get_by_name("tap").get_static_pad("sink").get_sticky_event(
    Gst.EventType.SEGMENT, 0)
tap_seg = tap_seg_ev.parse_segment() if tap_seg_ev is not None else None
bus.drain(pipe, src)
teardown()
check("the fixture really is a non-identity segment",
      tap_seg is not None and (tap_seg.base != 0 or tap_seg.start != 0))
expected = [house(c0 + i * STEP) for i in range(8)]
wire = [tap_seg.to_running_time(Gst.Format.TIME, p) for p, _ in seen[:8]]
check("running time on the wire is the content's house time, exactly", wire == expected)
check("and the buffer PTS was mapped, not left raw",
      [p for p, _ in seen[:8]] != expected)
check("DTS took the same mapping", [d for _, d in seen[:8]] == [p for p, _ in seen[:8]])
check("a mappable segment is not an engine-visible warning", bus.events == [])


# ---------------------------------------------------------------------------
print("\n--- counters: in place upstream of the tee, a copy only when shared ---")
# A real source element (filesrc) hands on singly-owned buffers, which is the
# production case upstream of the tee: basetransform runs us in place and there
# is no copy at all. Downstream of the tee every branch would see a shared
# buffer — the reason the element is spliced where it is.
tsdir = tempfile.mkdtemp(prefix="mr-mrtsstamp-ts-")
tspath = os.path.join(tsdir, "ladder.ts")
c_file = Gst.SystemClock.obtain().get_time() * 9 // 100000 + 90000
with open(tspath, "wb") as f:
    for i in range(60):
        f.write(pes_packet(0x100, MUX + c_file + i * STEP, i & 0x0F))
pipe = Gst.parse_launch(
    f"filesrc location={tspath} blocksize={ts_psi.PKT} ! {BUS_SINK} "
    "busout_41000. ! identity name=tap ! fakesink name=fs sync=false async=false")
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
deadline = time.time() + 10
while not bus.done and time.time() < deadline:
    bus.pump(0.02)
pipe.set_state(Gst.State.NULL)
teardown()
shutil.rmtree(tsdir, ignore_errors=True)
check(f"a singly-owned buffer is stamped IN PLACE — no copies "
      f"({el.get_property('copy-count')} of {len(seen)})",
      len(seen) == 60 and el.get_property("copy-count") == 0)
check("and every stamp is the file's PES − 1 h",
      [p for p, _ in seen] == [house(c_file + i * STEP) for i in range(60)])
check(f"bytes-total counts every byte while armed ({el.get_property('bytes-total')} of {60 * ts_psi.PKT})",
      el.get_property("bytes-total") == 60 * ts_psi.PKT)

# The other side of the same claim: hold a reference to every buffer on the
# element's sink pad and basetransform must make it writable first.
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
held = []
el.get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER,
    lambda _p, i: (held.append(i.get_buffer()), Gst.PadProbeReturn.OK)[1])
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
c0 = content0(pipe)
for i in range(10):
    push(src, pes_packet(0x100, MUX + c0 + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 10)
bus.drain(pipe, src)
teardown()
check(f"a shared buffer is counted as a copy ({el.get_property('copy-count')} of 10)",
      el.get_property("copy-count") == 10)
check("the input buffers are left untouched (the copy is real, not in-place)",
      [b.pts for b in held] == [i * 7 * Gst.MSECOND for i in range(10)])
check("and the copied buffers carry the correct stamp anyway",
      [p for p, _ in seen] == [house(c0 + i * STEP) for i in range(10)])

# The byte counter is the producer's throughput source and must run in
# PASSTHROUGH too — a producer with no consumer attached still reports its
# output bitrate, and the runner reads `bytes-total` instead of installing a
# per-buffer python probe on the tee (0.5-0.7 of a core per producer, Pi 4).
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
for i in range(10):
    push(src, pes_packet(0x100, MUX + content0(pipe) + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 10)
bus.drain(pipe, src)
teardown()
check(f"bytes-total counts in passthrough, never armed "
      f"({el.get_property('bytes-total')} of {10 * ts_psi.PKT}, active={el.get_property('active')})",
      el.get_property("active") is False and el.get_property("bytes-total") == 10 * ts_psi.PKT)
check("and passthrough leaves the arrival timestamps alone, posting nothing",
      [p for p, _ in seen] == [i * 7 * Gst.MSECOND for i in range(10)] and bus.messages == [])


# ---------------------------------------------------------------------------
print("\n--- a real mpegtsmux at alignment 0 and 7: one buffer per AU list, PES − 1 h ---")
for align in (0, 7):
    pipe = Gst.parse_launch(
        "audiotestsrc is-live=true num-buffers=30 ! audio/x-raw,format=S32LE,rate=48000,channels=2 "
        f"! avenc_s302m strict=experimental ! mpegtsmux name=mux latency=0 alignment={align} "
        f"! {BUS_SINK} busout_41000. ! identity name=tap ! fakesink name=fs sync=false async=false")
    bus = Bus(pipe)
    start(pipe)
    el = pipe.get_by_name(STAMP_EL)
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    got, lists = [], []

    def on_mux_buf(_pad, info, got=got):
        b = info.get_buffer()
        data = b.extract_dup(0, b.get_size())
        pes = next((v for v in (ts_psi.read_pes_pts(p) for p in ts_psi.iter_packets(data)
                                if p[1] & 0x40) if v is not None), None)
        got.append((b.pts, b.dts, pes, len(data)))
        return Gst.PadProbeReturn.OK

    def on_list(_pad, info, lists=lists):
        lists.append(info.get_buffer_list().length())
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("tap").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_mux_buf)
    el.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER_LIST, on_list)
    pipe.set_state(Gst.State.PLAYING)
    deadline = time.time() + 10
    while not bus.done and time.time() < deadline:
        bus.pump(0.02)
    now = pipe.get_pipeline_clock().get_time()
    pipe.set_state(Gst.State.NULL)
    teardown()
    want, last = [], None
    for _p, _d, pes, _n in got:
        last = last if pes is None else _tl.house_from_mux_pts(pes, now)
        want.append(last)
    check(f"alignment={align}: the mux pushed AU lists and each left as ONE buffer "
          f"({len(lists)} lists of up to {max(lists, default=0)} members, {len(got)} buffers)",
          len(got) >= 25 and len(got) == len(lists) and max(lists) >= 2
          and el.get_property("coalesced-lists") == sum(1 for n in lists if n >= 2))
    check(f"alignment={align}: every buffer is stamped PES − 1 h of its PES, DTS with it",
          sum(1 for g in got if g[2] is not None) >= 25
          and [(p, d) for p, d, _pes, _n in got] == [(w, w) for w in want])
    check(f"alignment={align}: bytes-total is every byte the egress carried",
          el.get_property("bytes-total") == sum(g[3] for g in got))
    check(f"alignment={align}: one identity message", len(bus.of("mrtsstamp-identity")) == 1)


# ---------------------------------------------------------------------------
print("\n--- R1: the stamp survives a real tsdemux (the DTS trap) ---")


def mux_real_ts(offset_ns, nbuf=150):
    """A genuine mpegtsmux stream: real PES headers, real PCR, real PSI, its content on the
    house timeline from `offset_ns` (PES = content + 1 h)."""
    pipe = Gst.parse_launch(
        f"audiotestsrc num-buffers={nbuf} samplesperbuffer=1024 timestamp-offset={offset_ns} "
        "! audioconvert ! avenc_aac ! mpegtsmux ! appsink name=out sync=false")
    pipe.set_state(Gst.State.PLAYING)
    out = []
    sink = pipe.get_by_name("out")
    while True:
        sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
        if sample is None:
            break
        buf = sample.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if ok:
            out.append(bytes(mi.data))
            buf.unmap(mi)
    pipe.set_state(Gst.State.NULL)
    return b"".join(out)


TS = mux_real_ts(Gst.SystemClock.obtain().get_time() + Gst.SECOND)
check("the fixture is a real muxed transport stream", len(TS) > 100 * ts_psi.PKT)

pipe, src = build_pipe("busout_41000. ! queue ! tsdemux name=dmx ! identity name=tap "
                       "! fakesink name=fs sync=false async=false")
bus = Bus(pipe)
start(pipe)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
consumer = []
pipe.get_by_name("tap").get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER,
    lambda _p, i: (consumer.append(i.get_buffer().pts), Gst.PadProbeReturn.OK)[1])
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)

random.seed(7)
CHUNK = 7 * ts_psi.PKT
off = n = 0
while off < len(TS):
    # Jittered arrival PTS (what a live relay carries today) and a DTS that is
    # both wrong and non-monotone — if the element leaves DTS alone, THAT is the
    # skew basis tsdemux believes.
    push(src, TS[off:off + CHUNK],
         n * 10 * Gst.MSECOND + random.randint(0, 4) * Gst.MSECOND,
         5 * Gst.SECOND + random.randint(0, 200) * Gst.MSECOND)
    off += CHUNK
    n += 1
    bus.pump(random.choice([0.0, 0.003, 0.012]))
now = pipe.get_pipeline_clock().get_time()
bus.drain(pipe, src)
teardown()

pes = [v for v in (ts_psi.read_pes_pts(p) for p in ts_psi.iter_packets(TS)) if v is not None]
n_cmp = min(len(consumer), len(pes))
check("the consumer produced a frame per PES", n_cmp > 100)
dev = [consumer[i] - _tl.house_from_mux_pts(pes[i], now) for i in range(n_cmp)]
check(f"the consumer's timeline lands on the identity stamp "
      f"(offset {dev[0] / 1e6:.1f} ms)", abs(dev[0]) < Gst.SECOND)
settled = dev[len(dev) * 3 // 5:]
spread = max(settled) - min(settled)
check(f"once tsdemux settles, push jitter leaves no trace at all "
      f"(spread {spread / 1e6:.3f} ms)", spread < Gst.MSECOND)
check("and the whole run stays within a frame or two of the stamp",
      max(dev) - min(dev) < 100 * Gst.MSECOND)


# ---------------------------------------------------------------------------
print("\n--- base-aware identity (WI-P1-7): base time 10 h and 14 h, wire = PES − 1 h ---")
# video-encoder keeps a natural base time (liveCaptureClock) and its restamp
# writes PES = capture time on the house timescale + 1 h. 14 h is past half a
# 2^33 period, where unwrapping against running time folds a whole period.
for hours in (10, 14):
    base = hours * 3600 * Gst.SECOND
    pipe, src = build_pipe()
    bus = Bus(pipe)
    start(pipe)
    pipe.use_clock(uptime_clock(base + Gst.SECOND))
    pipe.set_base_time(base)                     # start time is NONE: it survives PLAYING
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    seen = tap_timestamps(pipe)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    c0 = content0(pipe)
    for i in range(6):
        push(src, pes_packet(0x41, MUX + c0 + i * STEP, i), i * 40 * Gst.MSECOND, 0)
    bus.wait(seen, 6)
    tap = pipe.get_by_name("tap")
    seg = tap.get_static_pad("sink").get_sticky_event(Gst.EventType.SEGMENT, 0).parse_segment()
    tap_base = tap.get_base_time()
    bus.drain(pipe, src)
    teardown()
    # The wire is what unixfdsink sends: running time + base time.
    wire = [seg.to_running_time(Gst.Format.TIME, p) + tap_base for p, _ in seen[:6]]
    want = [house(c0 + i * STEP) for i in range(6)]
    check(f"base {hours} h: the egress really runs on that base time", tap_base == base)
    check(f"base {hours} h: wire = PES − 1 h exactly, every buffer "
          f"(first off by {(wire[0] - want[0]) / 1e9 if wire else None} s)",
          len(seen) == 6 and wire == want)
    check(f"base {hours} h: DTS rides with PTS", all(d == p for p, d in seen[:6]))
    ident = bus.of("mrtsstamp-identity")
    check(f"base {hours} h: the identity message names the content's house time, not running time",
          len(ident) == 1 and ident[0][2]["stamp"] == want[0])


# ---------------------------------------------------------------------------
print("\n--- the bus gap marker (OQ-12) leaves the egress with its PTS, no DTS ---")
# Its PTS is the gap's end and its packets' private data the gap's length; a
# stamp would replace that PTS with the staircase. OQ-12's form has no duration;
# the second marker carries one to show a duration is never touched either, and
# the DTS the restamp gives it (its input's timeline), which no bus queue may read.
GAP_FLAGS = int(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)


def gap_marker(pid, length_ns, cc=0):
    """OQ-12's marker packet: adaptation-only, the gap length in the adaptation
    field's transport_private_data."""
    af = bytes([0x02, 8]) + length_ns.to_bytes(8, "big")
    return (bytes([ts_psi.SYNC, (pid >> 8) & 0x1F, pid & 0xFF, 0x20 | (cc & 0x0F), 183])
            + af + b"\xff" * (183 - len(af)))


def tap_buffers(pipe, name="tap"):
    seen = []

    def _on_buffer(_pad, info):
        b = info.get_buffer()
        seen.append((b.pts, b.dts, b.duration, int(b.get_flags()),
                     b.extract_dup(0, b.get_size())))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name(name).get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, _on_buffer)
    return seen


pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_buffers(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
c0 = content0(pipe)
pes = [pes_packet(0x41, MUX + c0 + i * STEP, i) for i in range(4)]
markers = [(gap_marker(0x41, 500 * Gst.MSECOND), 7 * Gst.SECOND, Gst.CLOCK_TIME_NONE,
            Gst.CLOCK_TIME_NONE),
           (gap_marker(0x41, 300 * Gst.MSECOND, 1), 8 * Gst.SECOND, 2 * Gst.SECOND,
            300 * Gst.MSECOND)]
push(src, pes[0], 0, 0)
push(src, pes[1], 40 * Gst.MSECOND, 0)
for data, pts, dts, duration in markers:
    mb = Gst.Buffer.new_wrapped(data)
    mb.pts, mb.dts, mb.duration = pts, dts, duration
    mb.set_flags(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
    src.emit("push-buffer", mb)
push(src, pes[2], 80 * Gst.MSECOND, 0)
push(src, pes[3], 120 * Gst.MSECOND, 0)
bus.wait(seen, 6)
bus.drain(pipe, src)
teardown()
got = seen[2:4]
check("its GAP|DISCONT flags and bytes are intact",
      len(seen) == 6 and all(g[3] & GAP_FLAGS == GAP_FLAGS for g in got)
      and [g[4] for g in got] == [m[0] for m in markers])
check("each marker leaves with its own PTS and duration and no DTS, also one that came with a DTS",
      len(seen) == 6
      and [(g[0], g[1], g[2]) for g in got]
      == [(pts, Gst.CLOCK_TIME_NONE, duration) for _d, pts, _dts, duration in markers])
data = [s for s in seen if not s[3] & int(Gst.BufferFlags.GAP)]
want = [house(c0 + i * STEP) for i in range(4)]
check("the data on either side is stamped PES − 1 h as usual",
      [(s[0], s[1]) for s in data] == [(w, w) for w in want])

# A marker inside a buffer list must not be merged into the access unit (B-10).
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
el = pipe.get_by_name(STAMP_EL)
seen = tap_buffers(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
c0 = content0(pipe)
lst = Gst.BufferList.new()
for data, flags, pts in ((gap_marker(0x41, 200 * Gst.MSECOND), True, 5 * Gst.SECOND),
                         (pes_packet(0x41, MUX + c0, 0), False, 0),
                         (filler_packet(cc=1), False, 0)):
    b = Gst.Buffer.new_wrapped(data)
    b.pts = b.dts = pts   # the marker too: a DTS, as the restamp gives it one
    if flags:
        b.set_flags(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
    lst.insert(-1, b)
src.emit("push-buffer-list", lst)
bus.wait(seen, 3)
bus.drain(pipe, src)
teardown()
check("a list holding a marker is handed on member by member, not merged",
      len(seen) == 3 and el.get_property("coalesced-lists") == 0)
check("the marker keeps its PTS and flags, its DTS cleared; the AU behind it is stamped",
      len(seen) == 3 and seen[0][0] == 5 * Gst.SECOND
      and seen[0][1] == Gst.CLOCK_TIME_NONE and seen[0][3] & GAP_FLAGS == GAP_FLAGS
      and seen[1][0] == seen[1][1] == house(c0) and seen[2][0] == seen[1][0])


# ---------------------------------------------------------------------------
print("\n--- restamp -> identity egress -> the 5 s edge queue: the PES behind a marker stays ---")
# A capture's mux stamps its buffers' DTS on its own time (seconds) and the restamp gives
# its marker that DTS; the egress puts the data on house time. A DTS left on the marker made
# the edge queue (DTS first) read house minus it as its level and leak the PES behind it.
# Deterministic: the edge's pushing thread is held on the marker, as a slow consumer holds
# it, while the next buffer arrives; the test's own pad runs each push to the queue.
import threading  # noqa: E402

import gst_native_plugins  # noqa: E402
import ingest_restamp_fixture as fx  # noqa: E402

gst_native_plugins.load(lambda _event: None)
EDGE_QUEUE = runner.bus_edge_branch_description("unused").split(" ! ")[0].replace(
    "queue ", "queue name=edge ", 1)


def bufs_of(info):
    lst = info.get_buffer_list() if info.type & Gst.PadProbeType.BUFFER_LIST else None
    return [lst.get(i) for i in range(lst.length())] if lst else [info.get_buffer()]


def edge_marker_case():
    pipe = Gst.parse_launch(
        f"mrtsrestamp name=restamp clock-mode=fixed arrival=buffer-pts ! {BUS_SINK} "
        f"busout_41000. ! {EDGE_QUEUE} ! fakesink name=fs sync=false async=false")
    bus = Bus(pipe)
    start(pipe)
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    entered, left = [], []
    held, release = threading.Event(), threading.Event()

    def on_enter(_pad, info):
        entered.extend((b.pts, b.dts, int(b.get_flags()), b.extract_dup(0, b.get_size()))
                       for b in bufs_of(info))
        return Gst.PadProbeReturn.OK

    def on_leave(_pad, info):
        for b in bufs_of(info):
            if b.has_flags(Gst.BufferFlags.GAP) and not held.is_set():
                held.set()
                release.wait(5)
            left.append((b.pts, b.dts, int(b.get_flags()), b.extract_dup(0, b.get_size())))
        return Gst.PadProbeReturn.OK

    kinds = Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST
    edge = pipe.get_by_name("edge")
    edge.get_static_pad("sink").add_probe(kinds, on_enter)
    edge.get_static_pad("src").add_probe(kinds, on_leave)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    feed = Gst.Pad.new("feed", Gst.PadDirection.SRC)
    feed.link(pipe.get_by_name("restamp").get_static_pad("sink"))
    feed.set_active(True)
    feed.push_event(Gst.Event.new_stream_start("feed"))
    feed.push_event(Gst.Event.new_caps(Gst.Caps.from_string(TS_CAPS)))
    seg = Gst.Segment.new()
    seg.init(Gst.Format.TIME)
    feed.push_event(Gst.Event.new_segment(seg))

    house0 = pipe.get_pipeline_clock().get_time() + Gst.SECOND
    cc = {}

    def numbered(pkts):
        out = b""
        for p in pkts:
            pid = ((p[1] & 0x1F) << 8) | p[2]
            n = cc.get(pid, 0)
            cc[pid] = n + 1
            out += p[:3] + bytes([(p[3] & 0xF0) | (n & 0x0F)]) + p[4:]
        return out

    def send(i):
        """A 60 ms MPEG audio PES on its house time + 1 h; DTS on the mux's own time."""
        house_ns = house0 + i * 60 * Gst.MSECOND
        pts90 = (fx.ns90k(house_ns) + MUX) % fx.PTS_WRAP
        pkts = ([fx.psi_packet(0, fx.PAT), fx.psi_packet(fx.PID_PMT, fx.PMT)] if i == 0 else [])
        pkts += fx.packetize(fx.PID_A, fx.pes(0xC0, pts90, None, bytes(300)))
        b = Gst.Buffer.new_wrapped(numbered(pkts))
        b.pts, b.dts = house_ns, Gst.SECOND + i * 60 * Gst.MSECOND
        return feed.push(b) == Gst.FlowReturn.OK

    ok = all(send(i) for i in range(10))
    pipe.get_by_name("restamp").set_property("offset-ns", 500 * Gst.MSECOND)
    ok &= send(10)                  # the marker, then the PES that shows the gap
    ok &= held.wait(5)              # the edge has popped the marker and is pushing it
    ok &= send(11)                  # arrives while the PES behind the marker waits
    release.set()
    ok &= all(send(i) for i in range(12, 16))
    deadline = time.time() + 3
    while len(left) < len(entered) and time.time() < deadline:
        time.sleep(0.01)
    feed.push_event(Gst.Event.new_eos())
    deadline = time.time() + 5
    while not bus.done and time.time() < deadline:
        bus.pump(0.02)
    pipe.set_state(Gst.State.NULL)
    feed.set_active(False)
    teardown()

    marks = [i for i, x in enumerate(entered) if x[2] & int(Gst.BufferFlags.GAP)]
    behind = entered[marks[0] + 1] if marks and marks[0] + 1 < len(entered) else None
    check("the edit's one marker leaves the egress with no DTS, its PTS the house "
          "time of the PES behind it, its length 500 ms",
          ok and len(marks) == 1 and entered[marks[0]][1] == Gst.CLOCK_TIME_NONE
          and behind is not None and entered[marks[0]][0] == behind[0]
          and abs(fx.gap_length(entered[marks[0]][3]) - 500 * Gst.MSECOND) <= fx.TICK)
    check(f"every buffer the 5 s edge queue took leaves it, in order and unchanged "
          f"({len(left)} of {len(entered)})",
          ok and len(entered) == 17 and [x[2:] for x in left] == [x[2:] for x in entered])


if Gst.ElementFactory.find("mrtsrestamp") is None:
    print("SKIP the restamp edge case — libgstmrtshouse.so not built (`make native`)")
else:
    edge_marker_case()

if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All native mrtsstamp element tests passed.")
