#!/usr/bin/env python3
"""Self-checking tests for the NATIVE bus egress stamper (`mrtsstamp`).

Same contract as `gst_bus_stamper_test.py`, driven through the C++ element
instead of the python probe: the runner loads
`plugins/mpegts-core/native/mrtsstamp/libgstmrtsstamp.so` (via
`gst_bus_stamper.py`), splices an `mrtsstamp` between each bus capsfilter and
its `busout_*` tee, and toggles `active` from the same bus_attach / bus_detach
paths that arm and disarm the probe. The python probe stays the reference implementation and the fallback;
this file exists to prove the element is indistinguishable from it.

What is pinned here:

  --  The runner's own resolver finds the plugin and loads it (no
      GST_PLUGIN_PATH), and the element lands between the capsfilter and the
      tee — BEFORE the fan-out, so one stamp serves every consumer edge.
  R8  Flag off => nothing spliced, timestamps untouched.
  --  Lazy arm through the real handle_bus_attach / handle_bus_detach: inactive
      is pure passthrough, the first edge arms, the last disarms, a re-attach
      anchors afresh.
  R2  Every output buffer carries a valid PTS, non-decreasing, staircase
      repeating across PES-less buffers; PTS *and* DTS are stamped.
  --  The stamp is anchor + PES delta exactly; a legal 2^33 wrap is continuous;
      a real discontinuity re-anchors in place and drops the monotone floor.
  --  Writability: upstream of the tee the buffer is singly-owned and the
      element stamps it in place with ZERO copies; a buffer someone else holds
      a reference to costs one shallow GstBuffer copy and is still stamped
      correctly. This is why the element goes before the tee and not on a
      branch.
  R1  ADR-0005's named regression, through the element: real muxed TS, a
      deliberately wrong DTS and jittered push timing through a real tsdemux;
      the consumer's timeline must land on the producer's stamp.
      Mutation-checked: deleting `GST_BUFFER_DTS(buf) = stamp` from
      gstmrtsstamp.cpp moves the consumer's timeline by ~2 days and this fails.
  --  PARITY: the same fixture through the python probe and through the element
      produces the identical stamped ladder (deltas exact).

Skips (exit 0) where GStreamer / PyGObject is unavailable, or where the plugin
has not been built (`make native`).

Run:  python3 gst_mrtsstamp_element_test.py
"""
import importlib.util
import os
import random
import shutil
import sys
import tempfile
import time

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

Gst.init(sys.argv)

if not any(os.path.exists(p) for p in stamper.so_paths()):
    print("SKIP gst_mrtsstamp_element_test.py — mrtsstamp plugin not built "
          f"({', '.join(stamper.so_paths())}); run `make native`")
    sys.exit(0)

_failures = []
NS_PER_TICK_NUM, NS_PER_TICK_DEN = 100000, 9   # 90 kHz -> ns, exact in integers
STAMP_EL = stamper.ELEMENT_PREFIX + "busout_41000"


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


# --- harness ---------------------------------------------------------------
# The egress fragment is `busHelpers.buildBusSink` verbatim, because WHERE the
# element gets spliced is part of what is under test.
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
    """Bus messages delivered to the runner's REAL handler, which is what turns
    the element's messages into engine events. EOS/ERROR are watched here rather
    than popped, because a signal watch owns the queue once attached."""

    def __init__(self, pipe):
        self.done = []
        self.events = []
        runner.emit_event = self.events.append
        bus = pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message::element", runner.on_bus_message)
        bus.connect("message::eos", lambda _b, m: self.done.append(m))
        bus.connect("message::error", lambda _b, m: self.done.append(m))

    def pump(self, seconds=0.15):
        ctx = GLib.MainContext.default()
        deadline = time.time() + seconds
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

    def of(self, event):
        return [e for e in self.events if e["event"] == event]


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


def start(pipe, contract=True, native=True):
    """What handle_start does for a contract pipeline: contract clock, then the
    stamping backend — which is where the element gets spliced in."""
    runner.pipeline = pipe
    stamper.native_loaded = None if native else False
    if contract:
        runner._apply_contract_clock(pipe)
    stamper.enable(pipe, contract)


def teardown():
    stamper.clear()
    runner.pipeline = None


# ---------------------------------------------------------------------------
print("\n--- the runner resolves and loads the plugin itself ---")
stamper.native_loaded = None
check("the runner's own resolver loads the plugin (no GST_PLUGIN_PATH)",
      stamper.load_native() is True)
check("and the element factory is registered",
      Gst.ElementFactory.find("mrtsstamp") is not None)
check("the resolver looks in the plugin's own folder first, install root second",
      [os.path.basename(os.path.dirname(p)) for p in stamper.so_paths()]
      == ["mrtsstamp", "mpegts-core"])


# ---------------------------------------------------------------------------
print("\n--- R8: contract OFF splices nothing at all ---")
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe, contract=False)
check("no stamper element is inserted with the flag off",
      pipe.get_by_name(STAMP_EL) is None and stamper.elements == {})
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
sent = [(i * 10 * Gst.MSECOND, i * 10 * Gst.MSECOND + 7) for i in range(5)]
for i, (pts, dts) in enumerate(sent):
    push(src, pes_packet(0x100, 900000 + i * 3600, i), pts, dts)
bus.wait(seen, 5)
bus.drain(pipe, src)
check("every buffer reaches downstream untouched", seen == sent)
check("the flag-off path emits nothing at all", bus.events == [])
teardown()


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
check("it arrives inactive (the flag alone arms nothing)",
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
print("\n--- lazy arm: `active` follows the consumer edges ---")
LAZY_STEP = 3600                                  # 40 ms in 90 kHz ticks
LAZY_FIRST = 8_100_000
sockdir = tempfile.mkdtemp(prefix="mr-mrtsstamp-test-")
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)


def lazy_push(i, arrival_ms):
    push(src, pes_packet(0x100, LAZY_FIRST + i * LAZY_STEP, i & 0x0F),
         arrival_ms * Gst.MSECOND, 0)


for i in range(3):
    lazy_push(i, 5 * i)
bus.wait(seen, 3)
check("buffers before the first attach keep their own arrival timestamps",
      [p for p, _ in seen[:3]] == [0, 5 * Gst.MSECOND, 10 * Gst.MSECOND])
check("and nothing is anchored while the tee has no consumer",
      bus.of("timeline_restamped") == [])

sock_a = os.path.join(sockdir, "edge-a.sock")
sock_b = os.path.join(sockdir, "edge-b.sock")
runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_a})
check("the first consumer edge activates the element",
      len(stamper.armed) == 1 and el.get_property("active") is True)

for i in range(3, 9):
    lazy_push(i, 5 * i)
bus.wait(seen, 9)
first = (bus.of("timeline_restamped") or [None])[0]
check("arming mid-stream anchors on the next PES it sees",
      first is not None and first["refPts90k"] == LAZY_FIRST + 3 * LAZY_STEP)
check("the anchor event carries the probe's field names verbatim",
      first is not None
      and set(first) == {"event", "tee", "pid", "anchorNs", "refPts90k", "message"}
      and first["tee"] == "busout_41000" and first["pid"] == 0x100)
armed = [p for p, _ in seen[3:9]]
check("stamps flow from that anchor the moment the edge is up",
      armed == [first["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
                for i in range(6)] if first else False)

runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_b})
check("a second consumer on the same tee does not re-arm",
      len(stamper.armed) == 1 and len(bus.of("timeline_restamped")) == 1)
runner.handle_bus_detach({"socket": sock_b})
check("one consumer of two leaving keeps it active",
      len(stamper.armed) == 1 and el.get_property("active") is True)
for i in range(9, 12):
    lazy_push(i, 5 * i)
bus.wait(seen, 12)
check("and the surviving consumer keeps its original anchor",
      [p for p, _ in seen[9:12]]
      == [first["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
          for i in range(6, 9)])

runner.handle_bus_detach({"socket": sock_a})
check("the LAST consumer leaving deactivates it",
      stamper.armed == [] and el.get_property("active") is False)
for i in range(12, 15):
    lazy_push(i, 500 + 5 * i)
bus.wait(seen, 15)
check("inactive is pure passthrough — arrival timestamps again, untouched",
      [p for p, _ in seen[12:15]] == [(500 + 5 * i) * Gst.MSECOND for i in range(12, 15)])

sock_c = os.path.join(sockdir, "edge-c.sock")
time.sleep(0.05)                                  # let the house clock advance
runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_c})
for i in range(15, 18):
    lazy_push(i, 1000 + 5 * i)
bus.wait(seen, 18)
restamps = bus.of("timeline_restamped")
check("re-activating anchors AFRESH rather than resuming the old timeline",
      len(restamps) == 2 and restamps[1]["anchorNs"] > restamps[0]["anchorNs"]
      and restamps[1]["refPts90k"] == LAZY_FIRST + 15 * LAZY_STEP)
check("and the new staircase is measured from the new anchor",
      [p for p, _ in seen[15:18]]
      == [restamps[1]["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
          for i in range(3)])
runner.handle_bus_detach({"socket": sock_c})
bus.drain(pipe, src)
teardown()
shutil.rmtree(sockdir, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n--- R2: every buffer carries a valid, non-decreasing PTS (and DTS) ---")
FIRST_PES = 8_100_000            # 90 s in 90 kHz ticks
STEP = 3600                      # 40 ms


def run_ladder(native=True, entries=None, jitter=True):
    """Push a PES ladder (None = a PES-less filler buffer) through one armed
    egress and return (tap timestamps, events)."""
    pipe, src = build_pipe()
    b = Bus(pipe)
    start(pipe, native=native)
    stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
    seen = tap_timestamps(pipe)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    for i, pts in enumerate(entries):
        if pts is None:
            push(src, filler_packet(), 0, 0)
        else:
            # Arrival-jittered PTS and a nonsense DTS: what the stamper exists
            # to overwrite.
            push(src, pes_packet(0x100, pts, i),
                 i * 7 * Gst.MSECOND if jitter else 0, 3 * Gst.SECOND)
    b.wait(seen, len(entries))
    b.drain(pipe, src)
    teardown()
    return seen, b


ladder = [None if i in (3, 7) else FIRST_PES + i * STEP for i in range(12)]
seen, bus = run_ladder(entries=ladder)
check("every buffer got a PTS (none left CLOCK_TIME_NONE)",
      len(seen) == 12 and all(p != Gst.CLOCK_TIME_NONE for p, _ in seen))
check("the ladder is monotone non-decreasing",
      all(seen[i][0] <= seen[i + 1][0] for i in range(len(seen) - 1)))
check("DTS is stamped too (tsdemux prefers DTS — see R1)",
      all(dts == pts for pts, dts in seen))
first = (bus.of("timeline_restamped") or [None])[0]
check("a timeline_restamped event names the anchor",
      first is not None and first["refPts90k"] == FIRST_PES)
check("exactly one restamp event per egress", len(bus.of("timeline_restamped")) == 1)

expected, last = [], None
for p in ladder:
    if p is None:
        expected.append(last)            # staircase: PES-less buffer repeats
    else:
        last = first["anchorNs"] + (p - FIRST_PES) * NS_PER_TICK_NUM // NS_PER_TICK_DEN
        expected.append(last)
check("the stamp is anchor + PES delta, exactly", [p for p, _ in seen] == expected)
check("PES-less buffers repeat the previous stamp rather than inventing one",
      seen[3][0] == seen[2][0] and seen[7][0] == seen[6][0])
check("arrival jitter is gone — the ladder is a clean 40 ms step",
      {seen[i + 1][0] - seen[i][0] for i in (0, 1, 4, 5)} == {40_000_000})


# ---------------------------------------------------------------------------
print("\n--- a legal 2^33 PTS wrap is continuous, not a discontinuity ---")
WRAP = 1 << 33
start_pts = WRAP - 3 * STEP      # last three buffers before the boundary
seen, bus = run_ladder(
    entries=[(start_pts + i * STEP) % WRAP for i in range(24)], jitter=False)
check("every step across the wrap is the plain 40 ms",
      {seen[i + 1][0] - seen[i][0] for i in range(len(seen) - 1)} == {40_000_000})
check("the wrap does not re-anchor", bus.of("timeline_reanchor") == [])


# ---------------------------------------------------------------------------
print("\n--- a NON-IDENTITY segment still puts house time on the wire ---")
# The element's half of the python probe's segment section: what leaves the
# process is gst_segment_to_running_time(segment, pts) + base_time, so on any
# segment but the identity one a raw stamp ships shifted and nothing notices.
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
for i in range(8):
    push(src, pes_packet(0x100, FIRST_PES + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 8)
tap_seg_ev = pipe.get_by_name("tap").get_static_pad("sink").get_sticky_event(
    Gst.EventType.SEGMENT, 0)
tap_seg = tap_seg_ev.parse_segment() if tap_seg_ev is not None else None
bus.drain(pipe, src)
teardown()
check("the fixture really is a non-identity segment",
      tap_seg is not None and (tap_seg.base != 0 or tap_seg.start != 0))
first = (bus.of("timeline_restamped") or [None])[0]
check("the anchor is still taken from the first PES",
      first is not None and first["refPts90k"] == FIRST_PES)
expected = [first["anchorNs"] + i * STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
            for i in range(8)] if first else []
wire = [tap_seg.to_running_time(Gst.Format.TIME, p) for p, _ in seen[:8]]
check("running time on the wire is the house-clock ladder, exactly", wire == expected)
check("and the buffer PTS was mapped, not left raw",
      [p for p, _ in seen[:8]] != expected)
check("DTS took the same mapping", [d for _, d in seen[:8]] == [p for p, _ in seen[:8]])
check("a mappable segment is not an engine-visible warning", bus.of("warning") == [])


# ---------------------------------------------------------------------------
print("\n--- a real source discontinuity re-anchors IN PLACE ---")
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
# Two PIDs, as any real A/V producer has: the watch needs a second anomalous
# buffer before it believes a discontinuity, and an interleaved stream supplies
# one on the very next step.
JUMP_AT, JUMP = 20, 90000 * 600          # +10 min at buffer 20
for i in range(48):
    p = FIRST_PES + i * STEP + (JUMP if i >= JUMP_AT else 0)
    push(src, pes_packet(0x100, p, i) + pes_packet(0x101, p + 90, i),
         i * Gst.MSECOND, 0)
    bus.pump(0.002)
bus.wait(seen, 48)
bus.drain(pipe, src)
teardown()
reanchors = bus.of("timeline_reanchor")
check("the discontinuity produced a timeline_reanchor event", len(reanchors) == 1)
check("it is a re-anchor, not an error that forces a restart",
      bus.of("error") == [])
check("the re-anchor carries the probe's field names verbatim",
      bool(reanchors)
      and set(reanchors[0]) == {"event", "tee", "pid", "anchorNs", "refPts90k",
                                "count", "message"}
      and reanchors[0]["pid"] in (0x100, 0x101)
      and reanchors[0]["count"] == 1
      and "re-anchored" in reanchors[0]["message"])
# The monotone floor MUST drop with the anchor: detection is a buffer or two
# late, so by then the floor holds a stamp derived from the jumped payload.
jumped = [i for i in range(1, len(seen))
          if seen[i][0] - seen[i - 1][0] > 60 * Gst.SECOND]
check("only a bounded run of buffers carries the jumped stamp", len(jumped) <= 2)
tail = [p for p, _ in seen[JUMP_AT + 6:]]
check("the timeline recovers instead of freezing at the jumped value",
      len(tail) > 10 and tail[-1] > tail[0])
check("and it steps at the source's real 40 ms rate again",
      {tail[i + 1] - tail[i] for i in range(len(tail) - 1)} == {40_000_000})


# ---------------------------------------------------------------------------
print("\n--- the VOD loop: a SINGLE-PID egress re-anchors too ---")
# The 2026-08-13 field failure, through the NATIVE backend (mrts::TimelineStamper
# inside the element) — the same fixture gst_bus_stamper_test.py runs against
# the python probe, because which implementation stamped must stay invisible.
# A looping VOD rewinds its PES timeline to ~0 every pass, and mr-tssplit hands
# the stamper each of its per-PID SPTS outputs as its OWN single-PID buffer, so
# the cross-PID rule above has nothing to confirm with: one anomaly per output,
# no re-anchor, and the monotone floor pinned every later stamp to the last
# pre-loop value for the rest of the loop.
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
LOOP_AT, LOOP0, LOOP_N = 20, 4500, 48    # rewind to 50 ms at buffer 20
for i in range(LOOP_N):
    p = FIRST_PES + i * STEP if i < LOOP_AT else LOOP0 + (i - LOOP_AT) * STEP
    push(src, pes_packet(0x100, p, i), i * Gst.MSECOND, 0)
    bus.pump(0.002)
bus.wait(seen, LOOP_N)
bus.drain(pipe, src)
teardown()
reanchors = bus.of("timeline_reanchor")
check("the loop re-anchored a single-PID egress", len(reanchors) == 1)
check("named on the only PID there is, over the native bus message",
      bool(reanchors) and reanchors[0]["pid"] == 0x100
      and reanchors[0]["count"] == 1)
stamps = [p for p, _ in seen]
run = best = 1
for i in range(1, len(stamps)):
    run = run + 1 if stamps[i] == stamps[i - 1] else 1
    best = max(best, run)
check("the frozen run is bounded, not the whole rest of the loop", best <= 2)
tail = stamps[LOOP_AT + 3:]
check("and the timeline steps at the source's real 40 ms rate again",
      len(tail) > 10
      and {tail[i + 1] - tail[i] for i in range(len(tail) - 1)} == {40_000_000})


# ---------------------------------------------------------------------------
print("\n--- writability: in place upstream of the tee, a copy only when shared ---")
# A real source element (filesrc) hands on singly-owned buffers, which is the
# production case upstream of the tee: basetransform runs us in place and there
# is no copy at all. Downstream of the tee every branch would see a shared
# buffer — the reason the element is spliced where it is.
tsdir = tempfile.mkdtemp(prefix="mr-mrtsstamp-ts-")
tspath = os.path.join(tsdir, "ladder.ts")
with open(tspath, "wb") as f:
    for i in range(60):
        f.write(pes_packet(0x100, FIRST_PES + i * STEP, i & 0x0F))
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
check("and the ladder is still the exact 40 ms staircase",
      {seen[i + 1][0] - seen[i][0] for i in range(len(seen) - 1)} == {40_000_000})
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
for i in range(10):
    push(src, pes_packet(0x100, FIRST_PES + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 10)
bus.drain(pipe, src)
teardown()
check(f"a shared buffer is counted as a copy ({el.get_property('copy-count')} of 10)",
      el.get_property("copy-count") == 10)
check("the input buffers are left untouched (the copy is real, not in-place)",
      [b.pts for b in held] == [i * 7 * Gst.MSECOND for i in range(10)])
check("and the copied buffers carry the correct stamp anyway",
      len(seen) == 10
      and {seen[i + 1][0] - seen[i][0] for i in range(9)} == {40_000_000})

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
    push(src, pes_packet(0x100, FIRST_PES + i * STEP, i), i * 7 * Gst.MSECOND, 0)
bus.wait(seen, 10)
bus.drain(pipe, src)
teardown()
check(f"bytes-total counts in passthrough, never armed "
      f"({el.get_property('bytes-total')} of {10 * ts_psi.PKT}, active={el.get_property('active')})",
      el.get_property("active") is False and el.get_property("bytes-total") == 10 * ts_psi.PKT)


# ---------------------------------------------------------------------------
print("\n--- the drift loop is readable off the element ---")
# The slew has no moment to report at, so the runner POLLS it (`report_drift`)
# rather than being called back — which means the native backend has to expose
# what the python stamper returns from `drift_stats()`. Same field names, so
# the `timeline_drift` engine event is the same event whichever backend built
# it, and `drift_stats_of` reads either without knowing which it has.
pipe, src = build_pipe()
bus = Bus(pipe)
start(pipe)
el = pipe.get_by_name(STAMP_EL)
d = el.get_property("drift")
check("the element exposes a drift structure with the python field names",
      d is not None
      and sorted(d.nth_field_name(i) for i in range(d.n_fields()))
      == ["engageNs", "marginNs", "ppm", "samples", "slewNs", "window"])
check("a stamper that has measured nothing reports no samples",
      d.get_value("samples") == 0 and d.get_value("ppm") == 0
      and d.get_value("window") == 10)
st = stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
check("and the runner reads it back as nothing to report yet",
      stamper.drift_stats_of(st) is None)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
# The element takes house time from the pipeline clock, so a drift fixture
# cannot be simulated through it in a unit test the way the python stamper's
# can (gst_bus_stamper_test.py drives that half). What is pinned here is the
# SURFACE: shape, arm-reset, and that the runner reads it through one function.
for i in range(4):
    push(src, pes_packet(0x100, FIRST_PES + i * STEP, i), i * 40 * Gst.MSECOND, 0)
bus.wait(seen, 4)
bus.drain(pipe, src)
teardown()


# ---------------------------------------------------------------------------
print("\n--- PARITY: python probe and native element stamp identically ---")
# Absolute stamps differ by construction (each anchors at its own house-clock
# instant); the LADDER — every step from the anchor on — must be identical
# buffer for buffer, including the PES-less repeats.
par_ladder = [None if i in (5, 6, 13) else FIRST_PES + i * STEP for i in range(20)]
py_seen, _ = run_ladder(native=False, entries=par_ladder)
el_seen, _ = run_ladder(native=True, entries=par_ladder)
check("both backends emitted the same number of buffers",
      len(py_seen) == len(el_seen) == 20)
py_rel = [p - py_seen[0][0] for p, _ in py_seen]
el_rel = [p - el_seen[0][0] for p, _ in el_seen]
check("the stamped ladders are identical, delta for delta", py_rel == el_rel)
check("and so are the DTS ladders",
      [d - py_seen[0][1] for _, d in py_seen] == [d - el_seen[0][1] for _, d in el_seen])


# ---------------------------------------------------------------------------
print("\n--- R1: the stamp survives a real tsdemux (the DTS trap) ---")


def mux_real_ts(nbuf=150):
    """A genuine mpegtsmux stream: real PES headers, real PCR, real PSI."""
    pipe = Gst.parse_launch(
        f"audiotestsrc num-buffers={nbuf} samplesperbuffer=1024 ! audioconvert "
        "! avenc_aac ! mpegtsmux ! appsink name=out sync=false")
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


TS = mux_real_ts()
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
bus.drain(pipe, src)
teardown()

first = (bus.of("timeline_restamped") or [None])[0]
anchor = first["anchorNs"] if first else None
ref = first["refPts90k"] if first else None
pes = [v for v in (ts_psi.read_pes_pts(p) for p in ts_psi.iter_packets(TS)) if v is not None]
check("the producer anchored on the mux's first PES", anchor is not None and ref == pes[0])

n_cmp = min(len(consumer), len(pes))
check("the consumer produced a frame per PES", n_cmp > 100)
dev = [consumer[i] - (anchor + (pes[i] - ref) * NS_PER_TICK_NUM // NS_PER_TICK_DEN)
       for i in range(n_cmp)]
check(f"the consumer's timeline lands on the producer's stamp "
      f"(offset {dev[0] / 1e6:.1f} ms)", abs(dev[0]) < Gst.SECOND)
settled = dev[len(dev) * 3 // 5:]
spread = max(settled) - min(settled)
check(f"once tsdemux settles, push jitter leaves no trace at all "
      f"(spread {spread / 1e6:.3f} ms)", spread < Gst.MSECOND)
check("and the whole run stays within a frame or two of the stamp",
      max(dev) - min(dev) < 100 * Gst.MSECOND)


print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All native mrtsstamp element tests passed.")
