#!/usr/bin/env python3
"""Self-checking tests for the runner's bus egress stamper lifecycle (gst_bus_stamper.py),
the twin of mr-gst-runner's stamper.cpp (plan ch. 6 WI-P2-3).

Every `busout_*` egress gets an `mrtsstamp` element, spliced before PLAYING and armed per
consumer edge, which stamps by identity: PES − 1 h. The element's dataflow is
gst_mrtsstamp_element_test.py's; this file is what the runner does around it, driven through
the real handle_bus_attach / handle_bus_detach paths because that is what production calls.

What is pinned here:

  --  `enable` splices an inactive element only where there is a bus egress; a consumer
      pipeline neither loads nor misses the plugin.
  --  Lazy arm: a tee with no consumer edge is untouched, the first attach arms it, the last
      detach disarms it, and a re-attach stamps afresh (a new identity line).
  --  Identity: stamps are PES − 1 h whatever the arrival, PTS and DTS; the identity log
      line names the first PES, in mr-gst-runner's words.
  --  A gap marker (OQ-12) leaves an armed egress with its PTS and no DTS (B-19).
  --  No plugin: rule 6's alarm (`warning`, kind `timing_plugin`), no fallback, nothing
      spliced, the egress runs on its own timestamps, and `missing()` keeps a start from
      clearing the alarm.
  --  The element's bus messages become the identity line and the segment warning; any
      other source is ignored.

Skips (exit 0) where GStreamer / PyGObject is unavailable or the plugin is not built.

Run:  python3 gst_bus_stamper_test.py
"""
import importlib.util
import io
import os
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
# What PythonProcess does at spawn time: plugin-owned python on the path
# (plugins/mpegts-core/py).
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
import gst_native_plugins  # noqa: E402

import ts_psi  # noqa: E402  (after the sys.path insert above)
import ts_timeline as _tl  # noqa: E402  (its kept helpers)

Gst.init(sys.argv)

if not any(os.path.exists(p) for p in stamper.so_paths()):
    print("SKIP gst_bus_stamper_test.py — mrtsstamp plugin not built "
          f"({', '.join(stamper.so_paths())}); run `make native`")
    sys.exit(0)

_failures = []
STEP = 3600                      # 40 ms in 90 kHz ticks
MUX = _tl.MUX_CLOCK_BASE_90K
TEE = "busout_41000"


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


def gap_marker(pid, length_ns, cc=0):
    """OQ-12's marker packet: adaptation-only, the gap length in transport_private_data."""
    af = bytes([0x02, 8]) + length_ns.to_bytes(8, "big")
    return (bytes([ts_psi.SYNC, (pid >> 8) & 0x1F, pid & 0xFF, 0x20 | (cc & 0x0F), 183])
            + af + b"\xff" * (183 - len(af)))


def build_pipe():
    """appsrc -> the bus sink caps pair -> busout tee -> tap. The tap's sink pad sees exactly
    what a busedge `queue ! unixfdsink` branch would be handed."""
    pipe = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time do-timestamp=false caps={TS_CAPS} "
        f'! capssetter caps="{TS_CAPS}" replace=true ! capsfilter caps="{TS_CAPS}" '
        f"! tee name={TEE} allow-not-linked=true "
        f"{TEE}. ! identity name=tap ! fakesink name=fs sync=false async=false")
    return pipe, pipe.get_by_name("src")


def tap_buffers(pipe):
    seen = []

    def _on_buffer(_pad, info):
        b = info.get_buffer()
        seen.append((b.pts, b.dts, int(b.get_flags())))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("tap").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, _on_buffer)
    return seen


def push(src, payload, pts, dts, flags=0):
    buf = Gst.Buffer.new_wrapped(payload)
    buf.pts = pts
    buf.dts = dts
    if flags:
        buf.set_flags(flags)
    return src.emit("push-buffer", buf) == Gst.FlowReturn.OK


def wait_for(seen, n, timeout_s=5.0):
    """appsrc pushes from its own task, so the tap fills asynchronously."""
    deadline = time.time() + timeout_s
    while len(seen) < n and time.time() < deadline:
        time.sleep(0.005)
    return len(seen)


def drain(pipe, src, timeout_s=10):
    src.emit("end-of-stream")
    msg = pipe.get_bus().timed_pop_filtered(
        timeout_s * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return msg is not None and msg.type == Gst.MessageType.EOS


def identity_lines(pipe):
    """The element's `mrtsstamp-identity` messages, run through the runner's REAL handler
    (popped off the bus here: this suite has no main loop). Returns the log text."""
    err = io.StringIO()
    bus = pipe.get_bus()
    with redirect_stderr(err):
        while True:
            msg = bus.pop_filtered(Gst.MessageType.ELEMENT)
            if msg is None:
                break
            runner.on_bus_message(bus, msg)
    return err.getvalue()


def house(c90k):
    return _tl.pts90k_to_ns(c90k)


events = []
runner.emit_event = events.append


# ---------------------------------------------------------------------------
print("\n--- enable: a spliced element per bus egress, nothing for a consumer ---")
stamper.native_loaded = None
consumer = Gst.parse_launch(f"appsrc name=src caps={TS_CAPS} ! fakesink")
runner._apply_contract_clock(consumer)
stamper.enable(consumer)
check("a pipeline without a busout tee splices nothing and does not even try the plugin",
      stamper.elements == {} and stamper.native_loaded is None and events == [])
stamper.clear()
consumer.set_state(Gst.State.NULL)
pipe, src = build_pipe()
runner.pipeline = pipe
runner._apply_contract_clock(pipe)
err = io.StringIO()
with redirect_stderr(err):
    stamper.enable(pipe)
el = stamper.elements.get(TEE)
check("a producer gets one inactive mrtsstamp for its egress, the plugin loaded once",
      el is not None and el.get_property("active") is False and stamper.native_loaded is True
      and stamper.missing() is False and stamper.armed == [] and events == [])
check("and the runner says where it loaded it from and what it spliced",
      "busStamp: native stamper loaded (mrtsstamp 3.0.0 from " in err.getvalue()
      and f"busStamp: native stamper inserted on {TEE}" in err.getvalue())


# ---------------------------------------------------------------------------
print("\n--- lazy arm: the element follows the consumer edges ---")
sockdir = tempfile.mkdtemp(prefix="mr-stamper-test-")
seen = tap_buffers(pipe)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
c0 = pipe.get_pipeline_clock().get_time() * 9 // 100000 + 90000   # content: house now + 1 s


def ladder_push(i, arrival_ms):
    push(src, pes_packet(0x100, MUX + c0 + i * STEP, i & 0x0F), arrival_ms * Gst.MSECOND, 0)


for i in range(3):
    ladder_push(i, 5 * i)
wait_for(seen, 3)
check("buffers before the first attach keep their own arrival timestamps",
      [p for p, _d, _f in seen[:3]] == [0, 5 * Gst.MSECOND, 10 * Gst.MSECOND])
check("and nothing is reported while the tee has no consumer", identity_lines(pipe) == "")

sock_a = os.path.join(sockdir, "edge-a.sock")
sock_b = os.path.join(sockdir, "edge-b.sock")
err = io.StringIO()
with redirect_stderr(err):
    runner.handle_bus_attach({"tee": TEE, "socket": sock_a})
check("the first consumer edge arms the element",
      stamper.armed == [TEE] and el.get_property("active") is True
      and f"busStamp: identity egress armed on {TEE} (PES - 1 h, native mrtsstamp)" in err.getvalue())
for i in range(3, 9):
    ladder_push(i, 5 * i)
wait_for(seen, 9)
check("stamps are PES − 1 h from the arm on, PTS and DTS, whatever the arrival",
      [(p, d) for p, d, _f in seen[3:9]] == [(house(c0 + i * STEP),) * 2 for i in range(3, 9)])
check("the identity line names the first PES after the arm, in mr-gst-runner's words",
      identity_lines(pipe).strip().splitlines()
      == [f"[gst-runner.py] busStamp {TEE}: identity egress: first PES pid=0x100 "
          f"stamp={house(c0 + 3 * STEP)} pts={(MUX + c0 + 3 * STEP) % (1 << 33)}"])

with redirect_stderr(io.StringIO()):
    runner.handle_bus_attach({"tee": TEE, "socket": sock_b})
check("a second consumer on the same tee does not re-arm", stamper.armed == [TEE])
runner.handle_bus_detach({"socket": sock_b})
check("one consumer of two leaving keeps it armed",
      stamper.armed == [TEE] and el.get_property("active") is True)
for i in range(9, 12):
    ladder_push(i, 5 * i)
wait_for(seen, 12)
check("and the stamps run on, with no second identity line",
      [p for p, _d, _f in seen[9:12]] == [house(c0 + i * STEP) for i in range(9, 12)]
      and identity_lines(pipe) == "")

err = io.StringIO()
with redirect_stderr(err):
    runner.handle_bus_detach({"socket": sock_a})
check("the LAST consumer leaving disarms it",
      stamper.armed == [] and el.get_property("active") is False
      and f"busStamp {TEE}: last consumer edge detached — stamper disarmed (native, 0 "
          "non-writable buffers)" in err.getvalue())
for i in range(12, 15):
    ladder_push(i, 500 + 5 * i)
wait_for(seen, 15)
check("a tee with no consumers is back to untouched arrival timestamps",
      [p for p, _d, _f in seen[12:15]] == [(500 + 5 * i) * Gst.MSECOND for i in range(12, 15)])

sock_c = os.path.join(sockdir, "edge-c.sock")
with redirect_stderr(io.StringIO()):
    runner.handle_bus_attach({"tee": TEE, "socket": sock_c})
for i in range(15, 18):
    ladder_push(i, 1000 + 5 * i)
wait_for(seen, 18)
check("a re-attach stamps afresh: PES − 1 h again, and a new identity line on its first PES",
      [p for p, _d, _f in seen[15:18]] == [house(c0 + i * STEP) for i in range(15, 18)]
      and f"stamp={house(c0 + 15 * STEP)} " in identity_lines(pipe))


# ---------------------------------------------------------------------------
print("\n--- a gap marker leaves the armed egress with its PTS and no DTS ---")
GAP = int(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
push(src, gap_marker(0x100, 300 * Gst.MSECOND), 9 * Gst.SECOND, 4 * Gst.SECOND,
     Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
ladder_push(18, 1100)
wait_for(seen, 20)
check("the marker keeps its PTS and flags, its DTS cleared; the PES behind it is stamped",
      len(seen) == 20 and seen[18] == (9 * Gst.SECOND, Gst.CLOCK_TIME_NONE, seen[18][2])
      and seen[18][2] & GAP == GAP and seen[19][:2] == (house(c0 + 18 * STEP),) * 2)
runner.handle_bus_detach({"socket": sock_c})
drain(pipe, src)
stamper.clear()
runner.pipeline = None
shutil.rmtree(sockdir, ignore_errors=True)
check("clear() forgets the elements and the arm", stamper.elements == {} and stamper.armed == []
      and stamper.enabled is False)


# ---------------------------------------------------------------------------
print("\n--- no plugin: the rule-6 alarm, no fallback, the egress runs unstamped ---")
events.clear()
real_so_paths = stamper.native.so_paths
nowhere = ["/nonexistent/mrtsstamp/libgstmrtsstamp.so", "/nonexistent/libexec/libgstmrtsstamp.so"]
stamper.native.so_paths = lambda: list(nowhere)
stamper.native_loaded = None
try:
    pipe, src = build_pipe()
    runner.pipeline = pipe
    runner._apply_contract_clock(pipe)
    stamper.enable(pipe)
    detail = f"libgstmrtsstamp.so not loaded, tried {', '.join(nowhere)}"
    check("one warning of kind timing_plugin with the rule-6 sentence and the tried paths",
          events == [{"event": "warning", "kind": "timing_plugin",
                      "message": f"{gst_native_plugins.ALARM} ({detail})", "detail": detail}])
    check("and missing() says so, so the start's timingPlugin stays None",
          stamper.missing() is True and stamper.native_loaded is False)
    check("nothing is spliced", stamper.elements == {}
          and pipe.get_by_name(stamper.ELEMENT_PREFIX + TEE) is None)
    seen = tap_buffers(pipe)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)
    sock_d = os.path.join(tempfile.mkdtemp(prefix="mr-stamper-test-"), "edge-d.sock")
    with redirect_stderr(io.StringIO()):
        runner.handle_bus_attach({"tee": TEE, "socket": sock_d})
    check("an attach arms nothing", stamper.armed == [])
    c0 = pipe.get_pipeline_clock().get_time() * 9 // 100000 + 90000
    for i in range(3):
        push(src, pes_packet(0x100, MUX + c0 + i * STEP, i), 7 * i * Gst.MSECOND, 3 * Gst.SECOND)
    wait_for(seen, 3)
    check("buffers leave with their own timestamps (no house time on the bus)",
          [(p, d) for p, d, _f in seen[:3]] == [(7 * i * Gst.MSECOND, 3 * Gst.SECOND) for i in range(3)])
    runner.handle_bus_detach({"socket": sock_d})
    shutil.rmtree(os.path.dirname(sock_d), ignore_errors=True)
    drain(pipe, src)
    events.clear()
    stamper.clear()
    stamper.enable(pipe)
    check("the miss is reported once per process, not per start", events == [] and stamper.missing())
    stamper.clear()
    runner.pipeline = None
finally:
    stamper.native.so_paths = real_so_paths
    stamper.native_loaded = None


# ---------------------------------------------------------------------------
print("\n--- the element's bus messages, through the runner's handler ---")
events.clear()
SRC = stamper.ELEMENT_PREFIX + TEE


def message(text):
    err = io.StringIO()
    s = Gst.Structure.new_from_string(text)
    with redirect_stderr(err):
        stamper.handle_message(SRC, s.get_name(), s)
    return err.getvalue()


out = message("mrtsstamp-identity, pid=(int)256, stamp=(gint64)5000000000, pts=(gint64)324450000")
check("mrtsstamp-identity is one log line and no event",
      out == f"[gst-runner.py] busStamp {TEE}: identity egress: first PES pid=0x100 "
             "stamp=5000000000 pts=324450000\n" and events == [])
out = message('mrtsstamp-segment-warning, why=(string)"no SEGMENT event on the tee sink"')
check("a segment warning is an engine-visible warning event and a log line",
      events == [stamper.segment_warning_event(TEE, "no SEGMENT event on the tee sink")]
      and "no SEGMENT event on the tee sink — the house-clock stamp cannot be mapped onto "
          "running time" in events[0]["message"]
      and out == f"[gst-runner.py] busStamp {TEE}: no SEGMENT event on the tee sink — "
                 "stamp written unmapped\n")
events.clear()
out = message('mrtsstamp-map-failed, why=(string)"buffer would not map READ — stamp skipped"')
check("a map failure the same, saying the buffer kept its source timing",
      len(events) == 1 and events[0]["event"] == "warning"
      and out.endswith("— buffer passed through with source timing\n"))
events.clear()
err = io.StringIO()
with redirect_stderr(err):
    stamper.handle_message("someotherelement", "mrtsstamp-identity",
                           Gst.Structure.new_from_string("mrtsstamp-identity, pid=(int)1"))
check("a message from another element is ignored", events == [] and err.getvalue() == "")
check("is_stamper_message keys on the element's prefix",
      stamper.is_stamper_message("mrtsstamp-identity") and not stamper.is_stamper_message("level")
      and not stamper.is_stamper_message(None))


print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst bus egress stamper tests passed.")
