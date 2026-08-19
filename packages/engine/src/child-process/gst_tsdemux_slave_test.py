#!/usr/bin/env python3
"""Does a contract consumer's `tsdemux` RE-SLAVE to the producer's house stamps,
or free-run on the PES clock after latching a basis once?

Promoted from the .42 decay diagnosis (2026-08-13/14), where it was the probe
that decided WHICH fault was being chased. The contract stamps the BUS buffer
PTS with house-clock media time and a drift servo keeps that stamp glued to the
house clock (ADR-0005 decisions 2+3, Stage 3b). If tsdemux keeps taking its
basis from those stamps, a source whose PES clock runs at a different rate than
ours costs nothing. If it latched once and then advanced purely on PES deltas,
the consumer's output timeline would walk away from the house clock at the
source's drift rate FOR EVER, no producer-side instrument could see it, and the
backlog shedder would be treating a runaway timeline as a backlog.

It re-slaves — and this suite is what keeps that true. The field drift is
~18 ppm, which would need ~16 h to reach 1 s; here the PES clock is skewed by
SKEW_PPM (3 %), so free-running would show a full second of divergence in ~33 s.
What is asserted is the shape as well as the size: the divergence must SETTLE
(a one-time transient), not accumulate.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_tsdemux_slave_test.py
"""
import os
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_tsdemux_slave_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path.
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
import ts_psi  # noqa: E402

_failures = []

VIDEO_PID = 0x100
PMT_PID = 0x1000
PROGRAM = 1
FPS = 50
SKEW_PPM = 30_000.0        # 3 % — the field's 18 ppm, compressed ~1700×
SECONDS = 12.0
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def pes_packet(pid, pts90k, cc=0):
    """One PUSI packet carrying a PES header with `pts90k` (fixture shape from
    gst_mrtsstamp_element_test.py — stream id 0xE0, PTS-only flags)."""
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


Gst.init([])

pipe = Gst.parse_launch(
    f'appsrc name=src is-live=true format=time do-timestamp=false caps="{TS_CAPS}" ! '
    "tsdemux name=demux latency=0 ! "
    "fakesink name=sink sync=false async=false")

# The contract's clock, exactly as `_apply_contract_clock` applies it: monotonic
# system clock, running-time IS clock time.
clock = Gst.SystemClock.obtain()
clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
pipe.use_clock(clock)
pipe.set_start_time(Gst.CLOCK_TIME_NONE)
pipe.set_base_time(0)

src = pipe.get_by_name("src")
demux = pipe.get_by_name("demux")
sink = pipe.get_by_name("sink")

# One frame per input buffer, emitted in order, so input stamps are matched to
# the demux output FIFO rather than by value — tsdemux rebases what it emits,
# which is the very thing under test.
pending = []          # house stamps of frames pushed, oldest first
samples = []          # (elapsed_s, out_pts − house_stamp) in ms
counters = {"in": 0, "out": 0, "pads": 0}
lock = threading.Lock()
t0 = 0


def on_out_buffer(_pad, info):
    buf = info.get_buffer()
    if buf is None or buf.pts == Gst.CLOCK_TIME_NONE:
        return Gst.PadProbeReturn.OK
    with lock:
        counters["out"] += 1
        if not pending:
            return Gst.PadProbeReturn.OK
        house = pending.pop(0)
        samples.append(((house - t0) / Gst.SECOND, (buf.pts - house) / 1e6))
    return Gst.PadProbeReturn.OK


def on_pad_added(_demux, pad):
    counters["pads"] += 1
    pad.add_probe(Gst.PadProbeType.BUFFER, on_out_buffer)
    pad.link(sink.get_static_pad("sink"))


demux.connect("pad-added", on_pad_added)

pipe.set_state(Gst.State.PLAYING)
pipe.get_state(Gst.CLOCK_TIME_NONE)

t0 = clock.get_time()
pes0 = 900000          # arbitrary source epoch


def push():
    cc = 0
    n = 0
    while True:
        now = clock.get_time()
        elapsed = (now - t0) / Gst.SECOND
        if elapsed >= SECONDS:
            break
        # PES advances at the SOURCE's rate: real time scaled by the skew.
        pes = pes0 + int(elapsed * (1.0 + SKEW_PPM / 1e6) * 90000)
        pkts = []
        if n % 25 == 0:            # PSI often enough for tsdemux to lock
            pkts.append(ts_psi.build_pat(1, {PROGRAM: PMT_PID}, cc=n % 16))
            pkts.append(ts_psi.build_pmt(PMT_PID, PROGRAM, VIDEO_PID,
                                         [(VIDEO_PID, 0x1B)], cc=n % 16))
        pkts.append(ts_psi.build_pcr_packet(VIDEO_PID, int(pes * 300), cc=cc))
        pkts.append(pes_packet(VIDEO_PID, pes, cc=cc))
        cc = (cc + 1) & 0x0F
        n += 1

        buf = Gst.Buffer.new_wrapped(b"".join(pkts))
        # The producer's contract stamp: house time, servo-corrected, i.e.
        # exactly the wall clock this buffer is delivered at.
        buf.pts = now
        buf.dts = now
        with lock:
            pending.append(now)
            counters["in"] += 1
        src.emit("push-buffer", buf)
        time.sleep(1.0 / FPS)
    src.emit("end-of-stream")


threading.Thread(target=push, daemon=True).start()
loop = GLib.MainLoop()
GLib.timeout_add(int(SECONDS * 1000) + 1500, lambda: (loop.quit(), False)[1])
loop.run()
pipe.set_state(Gst.State.NULL)

check(f"the fixture matched frames through tsdemux (pads={counters['pads']} "
      f"in={counters['in']} out={counters['out']})", len(samples) > 200)

if samples:
    (ta, da), (tb, db) = samples[0], samples[-1]
    run_s = tb - ta
    slope_ppm = ((db - da) / 1e3) / run_s * 1e6 if run_s > 0 else 0.0

    def slope_between(lo_s, hi_s):
        win = [s for s in samples if lo_s <= s[0] <= hi_s]
        if len(win) < 2 or win[-1][0] <= win[0][0]:
            return 0.0
        return ((win[-1][1] - win[0][1]) / 1e3) / (win[-1][0] - win[0][0]) * 1e6

    # A free-running timeline diverges just as fast at the END as at the start;
    # a re-slaved one is settling, so its rate DECAYS. Compare the first third
    # against the last.
    head_ppm = slope_between(ta, ta + run_s / 3)
    tail_ppm = slope_between(ta + 2 * run_s / 3, tb)
    free_running_ms = SKEW_PPM / 1e6 * run_s * 1e3
    print(f"    {run_s:.1f} s at {SKEW_PPM:.0f} ppm skew: divergence {da:.1f} → {db:.1f} ms "
          f"(slope {slope_ppm:.0f} ppm, first third {head_ppm:.0f} → last third "
          f"{tail_ppm:.0f} ppm, "
          f"free-running would be {free_running_ms:.0f} ms)")

    check("tsdemux does NOT free-run on the PES clock", abs(slope_ppm) < 0.2 * SKEW_PPM)
    check("the divergence SETTLES rather than accumulating — the rate DECAYS",
          abs(tail_ppm) < 0.35 * abs(head_ppm) and abs(tail_ppm) < 0.1 * SKEW_PPM)
    check("total divergence stays far below a free-running timeline's",
          abs(db) < 0.35 * free_running_ms)
    # The consequence for the backlog shedder: consumer timeline error is
    # bounded and small, so a large lateness reading really is a BACKLOG and
    # not a timeline walking away — which is what makes shedding to `lateness
    # ≤ 0` a target the leg can actually reach.
    check("consumer timeline error stays inside the shedder's tolerance",
          abs(db) < 250)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst tsdemux slave tests passed.")
