#!/usr/bin/env python3
"""Self-checking tests for the runner's bus egress stamper (gst_bus_stamper.py).

The stamper is the PRODUCER half of the time-sync contract (ADR-0005 decision
2): a buffer probe on every `busout_*` tee sink pad rewrites bus buffer PTS/DTS
to `houseAnchor + (payload PES - firstPES)`, so what leaves this process is
mapped media time instead of an arrival time. These run REAL GStreamer
pipelines because every property under test is a dataflow one — what a
downstream element actually receives — and the headline test runs a real muxed
transport stream through a real `tsdemux`, which is the only thing that can
prove the contract survives a consumer.

What is pinned here:

  R8  Flag off => nothing installed, timestamps untouched, byte-identical.
  --  The probe is armed LAZILY: a tee with no consumer edge is never
      instrumented, the first attach arms it, the last detach disarms it, and a
      re-attach anchors afresh. Driven through the real handle_bus_attach /
      handle_bus_detach path, because that is what production calls.
  R2  Every output buffer carries a valid PTS, non-decreasing, with the
      staircase repeating across buffers that contain no PES header. A
      timestampless buffer would make the time-bounded leaky queues on the bus
      (500 ms busedge, 5 s consumer ingress) unable to measure their own level.
  --  The stamp is the mapped media time exactly, and a legal 2^33 PTS wrap is
      continuous rather than a discontinuity.
  --  A real source discontinuity re-anchors IN PLACE (event, no restart).
  R1  ADR-0005's named regression: a producer that stamps PTS but leaves a
      stale DTS is silently ignored, because `tsdemux` takes its PCR skew basis
      from GST_BUFFER_DTS_OR_PTS — DTS FIRST. Real muxed TS, a deliberately
      wrong DTS and jittered push timing go through a real tsdemux; the
      consumer's timeline must land on the producer's stamp. Mutation-checked:
      deleting `buf.dts = pos` from gst_bus_stamper.py moves the consumer's
      timeline by ~2 days and this test fails.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_bus_stamper_test.py
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
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_bus_stamper_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path so the
# runner's lazy `import ts_timeline` resolves (plugins/mpegts-core/py).
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

# Pin this suite to the PYTHON probe. The runner prefers the native `mrtsstamp`
# element wherever the plugin is built (`load_native`), and with it loaded
# every pipeline below would silently be testing that instead — leaving the
# reference implementation, and the fallback path a box without the plugin
# runs, uncovered. The element has its own suite
# (`gst_mrtsstamp_element_test.py`), which also cross-checks the two
# buffer-for-buffer.
stamper.native_loaded = False

_failures = []
NS_PER_TICK_NUM, NS_PER_TICK_DEN = 100000, 9   # 90 kHz -> ns, exact in integers


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# --- synthetic TS fixture ---------------------------------------------------
# Hand-built packets, so the PES ladder under test is exactly what we say it is
# (a muxer's own timeline would be an uncontrolled input). Layout matches what
# ts_psi.read_pes_pts parses: payload starts 00 00 01 <stream_id>, then length,
# the '10' marker byte, PTS_DTS_flags and the 5-byte PTS.
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
    """A packet with NO PES header — continuation / null padding. The stamper
    must still hand it a PTS (the staircase repeats)."""
    hdr = bytes([ts_psi.SYNC, (pid >> 8) & 0x1F, pid & 0xFF, 0x10 | (cc & 0x0F)])
    return hdr + b"\xff" * (ts_psi.PKT - 4)


def build_stamper_pipe():
    """appsrc -> busout tee -> tap. The tap's sink pad sees exactly what a
    busedge `queue ! unixfdsink` branch would be handed."""
    pipe = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time do-timestamp=false caps={TS_CAPS} "
        "! tee name=busout_41000 allow-not-linked=true "
        "busout_41000. ! identity name=tap ! fakesink name=fs sync=false async=false")
    return pipe, pipe.get_by_name("src")


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


def drain(pipe, src, timeout_s=10):
    src.emit("end-of-stream")
    msg = pipe.get_bus().timed_pop_filtered(
        timeout_s * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    ok = msg is not None and msg.type == Gst.MessageType.EOS
    pipe.set_state(Gst.State.NULL)
    return ok


def collect_events():
    events = []
    runner.emit_event = lambda obj: events.append(obj)
    return events


def arm_stamper(pipe, tee="busout_41000"):
    """What a tee's first consumer attach does, without the bus-edge machinery:
    turn the contract on, then arm that tee. The lazy-arm path itself is driven
    end to end through handle_bus_attach in its own section below; the dataflow
    sections here are about the stamping, so they arm directly."""
    stamper.enable(pipe, True)
    stamper.arm(pipe.get_by_name(tee), tee)


def wait_for(seen, n, timeout_s=5.0):
    """appsrc pushes from its own task, so the tap fills asynchronously."""
    deadline = time.time() + timeout_s
    while len(seen) < n and time.time() < deadline:
        time.sleep(0.005)
    return len(seen)


# ---------------------------------------------------------------------------
print("\n--- R8: contract OFF is byte-identical (no probe, no rewrite) ---")
events = collect_events()
pipe, src = build_stamper_pipe()
stamper.enable(pipe, False)
check("no stamper is armed with the flag off", stamper.armed == [])
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
check("and an attach cannot arm one either with the flag off",
      stamper.armed == [])
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
sent = [(i * 10 * Gst.MSECOND, i * 10 * Gst.MSECOND + 7) for i in range(5)]
for i, (pts, dts) in enumerate(sent):
    push(src, pes_packet(0x100, 900000 + i * 3600, i), pts, dts)
drain(pipe, src)
check("every buffer reaches downstream untouched", seen == sent)
check("the flag-off path emits nothing at all", events == [])

# The flag-off promise is also a *code* one: an `enabled` that is None (the key
# simply absent from the start payload, i.e. every pipeline today) must behave
# exactly like False.
stamper.enable(pipe, None)
stamper.arm(pipe.get_by_name("busout_41000"), "busout_41000")
check("an absent timeSyncContract key installs nothing", stamper.armed == [])


# ---------------------------------------------------------------------------
print("\n--- lazy arm: the probe follows the consumer edges ---")
# The first cut armed a probe on every busout_* tee at pipeline start, consumers
# or not. Measured on the Pi 400 at 10.9.1.42 (2026-08-12) that cost 2492
# ticks/min on ONE producer whose egress tee had no edges at all — 83% of the
# contract's entire CPU bill, spent stamping buffers nobody was reading. The
# probe now arms on a tee's first consumer edge and disarms on its last. Driven
# here through the real handle_bus_attach / handle_bus_detach commands, because
# that is exactly what BusFanoutCoordinator sends in production.
LAZY_STEP = 3600                                  # 40 ms in 90 kHz ticks
LAZY_FIRST = 8_100_000
sockdir = tempfile.mkdtemp(prefix="mr-stamper-test-")
events = collect_events()
pipe, src = build_stamper_pipe()
runner.pipeline = pipe                            # what handle_bus_attach resolves on
runner._apply_contract_clock(pipe)
stamper.enable(pipe, True)
check("the flag alone arms nothing — no consumer edge, no probe",
      stamper.armed == [])
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)


def lazy_push(i, arrival_ms):
    push(src, pes_packet(0x100, LAZY_FIRST + i * LAZY_STEP, i & 0x0F),
         arrival_ms * Gst.MSECOND, 0)


for i in range(3):
    lazy_push(i, 5 * i)
wait_for(seen, 3)
check("buffers before the first attach keep their own arrival timestamps",
      [p for p, _ in seen[:3]] == [0, 5 * Gst.MSECOND, 10 * Gst.MSECOND])
check("and nothing is anchored while the tee has no consumer",
      not any(e["event"] == "timeline_restamped" for e in events))

sock_a = os.path.join(sockdir, "edge-a.sock")
sock_b = os.path.join(sockdir, "edge-b.sock")
runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_a})
check("the first consumer edge arms the stamper", len(stamper.armed) == 1)

for i in range(3, 9):
    lazy_push(i, 5 * i)
wait_for(seen, 9)
first = next((e for e in events if e["event"] == "timeline_restamped"), None)
check("arming mid-stream anchors on the next PES it sees",
      first is not None and first["refPts90k"] == LAZY_FIRST + 3 * LAZY_STEP)
armed = [p for p, _ in seen[3:9]]
expect_armed = [first["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
                for i in range(6)] if first else []
check("stamps flow from that anchor the moment the edge is up",
      armed == expect_armed)

runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_b})
check("a second consumer on the same tee does not re-arm",
      len(stamper.armed) == 1
      and sum(1 for e in events if e["event"] == "timeline_restamped") == 1)
runner.handle_bus_detach({"socket": sock_b})
check("one consumer of two leaving keeps the stamper armed",
      len(stamper.armed) == 1)
for i in range(9, 12):
    lazy_push(i, 5 * i)
wait_for(seen, 12)
check("and the surviving consumer keeps its original anchor",
      [p for p, _ in seen[9:12]]
      == [first["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
          for i in range(6, 9)])

runner.handle_bus_detach({"socket": sock_a})
check("the LAST consumer leaving disarms it", stamper.armed == [])
for i in range(12, 15):
    lazy_push(i, 500 + 5 * i)
wait_for(seen, 15)
check("a tee with no consumers is back to untouched arrival timestamps",
      [p for p, _ in seen[12:15]]
      == [(500 + 5 * i) * Gst.MSECOND for i in range(12, 15)])

# Re-attach on a fresh edge: a NEW anchor is the correct answer, not a resumed
# one. An anchor only ever means anything to the consumers that were there when
# it was taken, and the arriving consumer has no memory of the old timeline.
sock_c = os.path.join(sockdir, "edge-c.sock")
time.sleep(0.05)                                  # let the house clock advance
runner.handle_bus_attach({"tee": "busout_41000", "socket": sock_c})
check("re-attaching after a full detach arms it again", len(stamper.armed) == 1)
for i in range(15, 18):
    lazy_push(i, 1000 + 5 * i)
wait_for(seen, 18)
restamps = [e for e in events if e["event"] == "timeline_restamped"]
check("the re-attach anchors afresh rather than resuming the old timeline",
      len(restamps) == 2 and restamps[1]["anchorNs"] > restamps[0]["anchorNs"]
      and restamps[1]["refPts90k"] == LAZY_FIRST + 15 * LAZY_STEP)
check("and the new staircase is measured from the new anchor",
      [p for p, _ in seen[15:18]]
      == [restamps[1]["anchorNs"] + i * LAZY_STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN
          for i in range(3)])

runner.handle_bus_detach({"socket": sock_c})
drain(pipe, src)
stamper.clear()
runner.pipeline = None
shutil.rmtree(sockdir, ignore_errors=True)


# ---------------------------------------------------------------------------
print("\n--- R2: every buffer carries a valid, non-decreasing PTS ---")
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)          # base_time=0, as in production
arm_stamper(pipe)
check("one stamper armed per busout tee", len(stamper.armed) == 1)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)

FIRST_PES = 8_100_000            # 90 s in 90 kHz ticks
STEP = 3600                      # 40 ms
# Buffers 3 and 7 carry NO PES header — the staircase has to cover them.
pes_ladder = []
segbuf = io.StringIO()
with redirect_stderr(segbuf):
    for i in range(12):
        if i in (3, 7):
            push(src, filler_packet(), 0, 0)
            pes_ladder.append(None)
            continue
        pts = FIRST_PES + i * STEP
        pes_ladder.append(pts)
        # Arrival-jittered PTS and a nonsense DTS: exactly what the stamper is
        # there to overwrite.
        push(src, pes_packet(0x100, pts, i), i * 7 * Gst.MSECOND, 3 * Gst.SECOND)
    drain(pipe, src)

check("every buffer got a PTS (none left CLOCK_TIME_NONE)",
      len(seen) == 12 and all(p != Gst.CLOCK_TIME_NONE for p, _ in seen))
check("the ladder is monotone non-decreasing",
      all(seen[i][0] <= seen[i + 1][0] for i in range(len(seen) - 1)))
check("DTS is stamped too (tsdemux prefers DTS — see R1)",
      all(dts == pts for pts, dts in seen))

anchor = next((e["anchorNs"] for e in events if e["event"] == "timeline_restamped"), None)
ref = next((e["refPts90k"] for e in events if e["event"] == "timeline_restamped"), None)
check("a timeline_restamped event names the anchor", anchor is not None and ref == FIRST_PES)
check("exactly one restamp event per egress",
      sum(1 for e in events if e["event"] == "timeline_restamped") == 1)

expected = []
last = None
for p in pes_ladder:
    if p is None:
        expected.append(last)            # staircase: PES-less buffer repeats
    else:
        last = anchor + (p - ref) * NS_PER_TICK_NUM // NS_PER_TICK_DEN
        expected.append(last)
check("the stamp is anchor + PES delta, exactly", [p for p, _ in seen] == expected)
check("PES-less buffers repeat the previous stamp rather than inventing one",
      seen[3][0] == seen[2][0] and seen[7][0] == seen[6][0])
check("an identity segment raises no complaint",
      "non-identity" not in segbuf.getvalue().lower())
check("arrival jitter is gone — the ladder is a clean 40 ms step",
      {seen[i + 1][0] - seen[i][0] for i in (0, 1, 4, 5)} == {40_000_000})


# ---------------------------------------------------------------------------
print("\n--- a NON-IDENTITY segment still puts house time on the wire ---")
# What leaves the process is not the PTS we write: unixfdsink transmits
# gst_segment_to_running_time(segment, pts) + base_time. A producer whose egress
# carries anything but an identity segment — an upstream GstPad.set_offset
# (preserveSourceTimeline's own mechanism), a trimmed segment, a non-zero base
# after a seek — therefore ships a stamp shifted by exactly that mapping, and
# the whole contract is silently wrong with nothing to notice it. The stamp is
# computed in RUNNING time and mapped back through the segment, so the number on
# the wire is house time either way.
SEG_OFFSET = 5 * Gst.SECOND
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)
# A pad offset on the source is how a real pipeline gets here; it lands as a
# non-zero `base` on the segment every downstream element sees.
pipe.get_by_name("src").get_static_pad("src").set_offset(SEG_OFFSET)
arm_stamper(pipe)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
for i in range(8):
    push(src, pes_packet(0x100, FIRST_PES + i * STEP, i), i * 7 * Gst.MSECOND, 0)
wait_for(seen, 8)
tap_seg_ev = pipe.get_by_name("tap").get_static_pad("sink").get_sticky_event(
    Gst.EventType.SEGMENT, 0)
tap_seg = tap_seg_ev.parse_segment() if tap_seg_ev is not None else None
drain(pipe, src)
check("the fixture really is a non-identity segment",
      tap_seg is not None and (tap_seg.base != 0 or tap_seg.start != 0))
anchor = next((e["anchorNs"] for e in events if e["event"] == "timeline_restamped"), None)
ref = next((e["refPts90k"] for e in events if e["event"] == "timeline_restamped"), None)
expected = [anchor + i * STEP * NS_PER_TICK_NUM // NS_PER_TICK_DEN for i in range(8)]
check("the anchor is still taken from the first PES", ref == FIRST_PES)
# THE POINT: running time — what goes on the wire — carries the house-clock
# ladder, even though the buffer PTS no longer equals it.
wire = [tap_seg.to_running_time(Gst.Format.TIME, p) for p, _ in seen[:8]]
check("running time on the wire is the house-clock ladder, exactly", wire == expected)
check("and the buffer PTS was mapped, not left raw",
      [p for p, _ in seen[:8]] != expected)
check("DTS took the same mapping", [d for _, d in seen[:8]] == [p for p, _ in seen[:8]])
check("a mappable segment is not an engine-visible warning",
      not any(e["event"] == "warning" for e in events))

# The residue: a segment with NO running-time mapping at all (no SEGMENT event,
# a non-TIME format, a stamp outside the segment). That case DOES ship shifted
# timing, so it must escalate to the engine rather than the runner's stderr —
# where a `printerr` line is invisible to the operator and to log-based fleet
# monitoring. Once per armed egress: it is a property of the segment, and a
# per-buffer warning would drown the journal.
events = collect_events()
fake = {"tee": "busout_41000"}
stamper._segment_warn(fake, "no SEGMENT event on the tee sink")
stamper._segment_warn(fake, "no SEGMENT event on the tee sink")
check("an unmappable segment is an engine-visible warning event",
      len(events) == 1 and events[0]["event"] == "warning"
      and "busout_41000" in events[0]["message"]
      and "no SEGMENT event" in events[0]["message"])
check("and it is reported once per armed egress, not per buffer", len(events) == 1)
# The native element reports the same condition over the bus; the runner must
# translate it into the SAME event, or which backend noticed becomes visible.
events = collect_events()
stamper.handle_message(
    stamper.ELEMENT_PREFIX + "busout_41000", "mrtsstamp-segment-warning",
    Gst.Structure.new_from_string(
        'mrtsstamp-segment-warning, why=(string)"no SEGMENT event on the tee sink"'))
check("the native backend's segment warning becomes the identical event",
      len(events) == 1
      and events[0] == stamper.segment_warning_event(
          "busout_41000", "no SEGMENT event on the tee sink"))


# ---------------------------------------------------------------------------
print("\n--- a legal 2^33 PTS wrap is continuous, not a discontinuity ---")
# The 33-bit 90 kHz counter wraps every ~26.5 h. The latch's `unwrap_near` has
# to absorb it: a wrap must produce the SAME 40 ms step as any other buffer and
# must not re-anchor (the 2026-07-23 wrap drill).
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)
arm_stamper(pipe)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
WRAP = 1 << 33
start = WRAP - 3 * STEP          # last three buffers before the boundary
for i in range(24):
    push(src, pes_packet(0x100, (start + i * STEP) % WRAP, i), i * Gst.MSECOND, 0)
drain(pipe, src)
steps = {seen[i + 1][0] - seen[i][0] for i in range(len(seen) - 1)}
check("every step across the wrap is the plain 40 ms", steps == {40_000_000})
check("the wrap does not re-anchor",
      not any(e["event"] == "timeline_reanchor" for e in events))


# ---------------------------------------------------------------------------
print("\n--- a real source discontinuity re-anchors IN PLACE ---")
# preserveSourceTimeline answers a discontinuity by erroring out and letting the
# pipeline restart (its offsets are baked into pad offsets). The egress stamper
# only holds two numbers, so it re-anchors on the spot: one PTS step, no
# restart, no consumer cooperation, and every branch of this producer moves
# together so A/V pairing survives.
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)
arm_stamper(pipe)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
# Two PIDs, as any real A/V producer has: the watch needs a second anomalous
# buffer before it believes a discontinuity, and on an interleaved stream a
# single clean step produces one.
JUMP_AT, JUMP = 20, 90000 * 600          # +10 min at buffer 20
for i in range(48):
    p = FIRST_PES + i * STEP + (JUMP if i >= JUMP_AT else 0)
    push(src, pes_packet(0x100, p, i) + pes_packet(0x101, p + 90, i),
         i * Gst.MSECOND, 0)
    time.sleep(0.001)
drain(pipe, src)
reanchors = [e for e in events if e["event"] == "timeline_reanchor"]
check("the discontinuity produced a timeline_reanchor event", len(reanchors) == 1)
check("it is a re-anchor, NOT the restart-forcing error preserveSourceTimeline emits",
      not any(e["event"] == "error" for e in events))
check("the re-anchor names the offending PID and the jump",
      bool(reanchors) and reanchors[0]["pid"] in (0x100, 0x101)
      and "re-anchored" in reanchors[0]["message"])
# Detection is at least one buffer late, so a bounded number of buffers leave
# carrying the jumped stamp — but only a bounded number. THIS is what the
# monotone floor must not survive: the floor gets set from the jumped payload,
# and left in place it pins the timeline ten minutes ahead and freezes every
# later stamp against it until the house clock catches up.
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
# The 2026-08-13 field failure, through the real probe. A looping VOD rewinds
# its PES timeline to ~0 every pass, and mr-tssplit hands the stamper each of
# its per-PID SPTS outputs as its OWN single-PID buffer — so the cross-PID
# confirmation above (a second PID reporting the same jump a buffer later) has
# nothing to confirm with. The watch counted exactly one anomaly per output,
# never re-anchored, and the monotone floor pinned every later stamp to the
# last pre-loop value for the REST of the loop: on .202 that was 11.6 minutes
# of video frozen at one identical PTS behind a sync=true sink.
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)
arm_stamper(pipe)
seen = tap_timestamps(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
LOOP_AT, LOOP0, LOOP_N = 20, 4500, 48    # rewind to 50 ms at buffer 20
for i in range(LOOP_N):
    p = FIRST_PES + i * STEP if i < LOOP_AT else LOOP0 + (i - LOOP_AT) * STEP
    push(src, pes_packet(0x100, p, i), i * Gst.MSECOND, 0)
    time.sleep(0.001)
wait_for(seen, LOOP_N)
drain(pipe, src)
reanchors = [e for e in events if e["event"] == "timeline_reanchor"]
check("the loop re-anchored a single-PID egress", len(reanchors) == 1)
check("named on the only PID there is",
      bool(reanchors) and reanchors[0]["pid"] == 0x100)
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
print("\n--- the drift loop's periodic report ---")
# The slew is a continuous correction (ADR-0005 decision 5's drift term), so
# unlike the anchor and the re-anchor it has no MOMENT to report at: what the
# burn-in needs is a periodic line. The timer that emits it is armed by the
# first arm and dropped by the last release; `report_drift` is what it calls,
# and it is called directly here because a 30 s timer in a test is not a test.
events = collect_events()
pipe, src = build_stamper_pipe()
runner._apply_contract_clock(pipe)
arm_stamper(pipe)
st = stamper.stamper_for("busout_41000")
check("arming the first egress arms the drift timer",
      stamper.drift_timer_id is not None)
stamper.report_drift()
check("a stamper that has measured nothing reports nothing",
      not [e for e in events if e["event"] == "timeline_drift"])

# Drive the probe's own stamper through a simulated drift. Feeding it directly
# (rather than through the pipeline) is what makes an hour of a 50 ppm HLS
# source fit in a unit test: the stamper takes house time as an argument, and
# the drift is a property of the relationship between that and the payload.
# Shape and constants are ts_timeline_test.py's HLS fixture.
D_STEP, D_STEP_NS, D_HOUSE = 18000, 200_000_000, 5_000_000_000


def hls_house(i):
    t_ns = i * D_STEP_NS
    lead = min(2_000_000_000, t_ns * 2_000_000_000 // (30 * 1_000_000_000))
    return (D_HOUSE + t_ns - lead - (i % 30) * 26_666_666
            - (t_ns * 50) // 1_000_050)


def feed(st, lo, hi):
    for i in range(lo, hi):
        st["stamper"].stamp(pes_packet(0x100, FIRST_PES + i * D_STEP, i), hls_house(i))


# PART OF a window first — past the settling period, so the trend window is
# genuinely filling. This is the case the report has to keep quiet through and
# the one an over-simple `samples > 0` gate would leak: the servo has levels but
# no slope yet, so ppm/margin/engage are zero because they are NOT MEASURED, and
# an event saying `0 ppm` reads as measured.
feed(st, 0, 2400)                       # 8 min: 5 min settling + 3 min of window
stamper.report_drift()
check("and a servo still filling its trend window still reports nothing",
      not [e for e in events if e["event"] == "timeline_drift"]
      and 0 < st["stamper"].drift_stats()["samples"] < 10)

feed(st, 2400, 3600 * 5)                # ... out to a full simulated hour
stamper.report_drift()
drifts = [e for e in events if e["event"] == "timeline_drift"]
check("once the servo has locked, the report names the source's offset",
      len(drifts) == 1 and -60 <= drifts[0]["ppm"] <= -30
      and drifts[0]["tee"] == "busout_41000")
check("and carries the cumulative correction and the margin it engaged at",
      bool(drifts) and drifts[0]["slewNs"] < 0
      and drifts[0]["samples"] == 10 and drifts[0]["engageNs"] < 0
      and "ppm" in drifts[0]["message"])
stamper.release("busout_41000")
check("the last release drops the timer with the last stamper",
      stamper.drift_timer_id is None)
drain(pipe, src)


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

events = collect_events()
pipe = Gst.parse_launch(
    f"appsrc name=src is-live=true format=time do-timestamp=false caps={TS_CAPS} "
    "! tee name=busout_41000 allow-not-linked=true "
    "busout_41000. ! queue ! tsdemux name=dmx ! identity name=tap "
    "! fakesink name=fs sync=false async=false")
runner._apply_contract_clock(pipe)
arm_stamper(pipe)
src = pipe.get_by_name("src")
consumer = []


def _on_out(_pad, info):
    consumer.append(info.get_buffer().pts)
    return Gst.PadProbeReturn.OK


pipe.get_by_name("tap").get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER, _on_out)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)

random.seed(7)
CHUNK = 7 * ts_psi.PKT
off = n = 0
while off < len(TS):
    # Jittered arrival PTS (what a live relay carries today) and a DTS that is
    # both wrong and non-monotone — if the stamper leaves DTS alone this is the
    # skew basis tsdemux believes.
    push(src, TS[off:off + CHUNK],
         n * 10 * Gst.MSECOND + random.randint(0, 4) * Gst.MSECOND,
         5 * Gst.SECOND + random.randint(0, 200) * Gst.MSECOND)
    off += CHUNK
    n += 1
    time.sleep(random.choice([0.0, 0.003, 0.012]))
drain(pipe, src)

anchor = next((e["anchorNs"] for e in events if e["event"] == "timeline_restamped"), None)
ref = next((e["refPts90k"] for e in events if e["event"] == "timeline_restamped"), None)
pes = [v for v in (ts_psi.read_pes_pts(p) for p in ts_psi.iter_packets(TS)) if v is not None]
check("the producer anchored on the mux's first PES", anchor is not None and ref == pes[0])

n_cmp = min(len(consumer), len(pes))
check("the consumer produced a frame per PES", n_cmp > 100)
dev = [consumer[i] - (anchor + (pes[i] - ref) * NS_PER_TICK_NUM // NS_PER_TICK_DEN)
       for i in range(n_cmp)]
# Landing ON the producer's timeline (not merely parallel to it) is the whole
# contract: the residual is the fixed demux/PCR lead, not a per-consumer anchor.
check(f"the consumer's timeline lands on the producer's stamp "
      f"(offset {dev[0] / 1e6:.1f} ms)", abs(dev[0]) < Gst.SECOND)
# tsdemux's PCR skew model is an estimator: it converges over the first seconds
# (measured ~23 ms of settling here) and then holds. Once settled the offset is
# EXACTLY constant, which is the real claim — jittered push timing leaves no
# trace on the consumer, because the basis it rides is the stamp, not arrival.
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
print("All gst bus egress stamper tests passed.")
