#!/usr/bin/env python3
"""Dataflow tests for the native `mrlateness` tap (WI-P0-7): house/running-time lateness, DTS
fallback, chain_list (ADR-0011), the egress tap behind an armed stamper under a natural base
(B-26), untimed buffers, post-messages, EOS. The window maths is pinned by
mrts/tests/lateness_test. Skips (exit 0) without GStreamer or the built plugin."""
import os
import re
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrlateness_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

MS = 1000000
_HERE = os.path.dirname(os.path.abspath(__file__))
_SO = "libgstmrlateness.so"
# Repo plugins tree first, then the packaged root, as gst_stamp_native resolves.
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
_LIBEXEC = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
SO_PATHS = [os.path.join(_PLUGINS, "mpegts-core", "native", "mrlateness", _SO),
            os.path.join(_LIBEXEC, "mpegts-core", _SO)]

if not Gst.ElementFactory.find("mrlateness"):
    for _p in SO_PATHS:
        if os.path.exists(_p) and Gst.Plugin.load_file(_p) is not None:
            break
if not Gst.ElementFactory.find("mrlateness"):
    print("SKIP gst_mrlateness_element_test.py — mrlateness plugin not built "
          f"({', '.join(SO_PATHS)}); run `make native`")
    sys.exit(0)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def mono_ns():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def build(taps, base_time_zero=False, sink_extra="", caps="application/x-test"):
    """appsrc ! <taps> ! fakesink. base_time_zero pins the house-clock rule
    (§4.1): monotonic system clock, base_time 0, no start time."""
    pipe = Gst.parse_launch(
        "appsrc name=src is-live=true format=time do-timestamp=false "
        f"caps={caps} ! " + " ! ".join(taps)
        + f" ! fakesink name=fs sync=false async=false {sink_extra}")
    if base_time_zero:
        pipe.use_clock(Gst.SystemClock.obtain())
        pipe.set_start_time(Gst.CLOCK_TIME_NONE)
        pipe.set_base_time(0)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * Gst.SECOND)
    return pipe, pipe.get_by_name("src")


def buffer(pts=None, dts=None):
    b = Gst.Buffer.new_wrapped(b"\x00" * 188)
    b.pts = Gst.CLOCK_TIME_NONE if pts is None else pts
    b.dts = Gst.CLOCK_TIME_NONE if dts is None else dts
    return b


def feed(src, n, lateness_ns, period_s=0.02, dts_only=False):
    """n buffers, each stamped lateness_ns behind CLOCK_MONOTONIC at push."""
    for _ in range(n):
        t = mono_ns() - lateness_ns
        src.emit("push-buffer", buffer(dts=t) if dts_only else buffer(pts=t))
        time.sleep(period_s)


def windows_by_tap(pipe, settle_s=0.3):
    """Drain the bus; return {tap name: [`mrlateness` structures]}."""
    time.sleep(settle_s)
    out = {}
    bus = pipe.get_bus()
    while True:
        msg = bus.pop_filtered(Gst.MessageType.ELEMENT)
        if msg is None:
            return out
        s = msg.get_structure()
        if s is not None and s.get_name() == "mrlateness":
            out.setdefault(msg.src.get_name(), []).append(s)


def windows(pipe, settle_s=0.3):
    return [s for ws in windows_by_tap(pipe, settle_s).values() for s in ws]


def mean_of(ws):
    n = sum(s.get_value("count") for s in ws)
    return (sum(s.get_value("mean-ns") * s.get_value("count") for s in ws) / n) if n else None


def stop(pipe):
    pipe.set_state(Gst.State.NULL)


# --- 300 ms injected lateness, house reference ------------------------------
pipe, src = build(["mrlateness name=lat interval-ms=200"])
feed(src, 30, 300 * MS)
ws = windows(pipe)
m = mean_of(ws)
check("house: windows posted at the interval", len(ws) >= 2)
check(f"house: mean 300 ms +- 5 ms (got {m and m / MS:.2f} ms)",
      m is not None and abs(m - 300 * MS) <= 5 * MS)
check("house: every window names its reference",
      all(s.get_value("reference") == "house" for s in ws))
check("house: min <= mean <= max, last in range",
      all(s.get_value("min-ns") <= s.get_value("mean-ns") <= s.get_value("max-ns")
          and s.get_value("min-ns") <= s.get_value("last-ns") <= s.get_value("max-ns")
          for s in ws))
check("house: interval-ns ~ interval-ms",
      all(200 * MS <= s.get_value("interval-ns") < 400 * MS for s in ws))
check("house: no untimed", all(s.get_value("untimed") == 0 for s in ws))
stats = pipe.get_by_name("lat").get_property("stats")
check("stats mirrors the last window",
      stats.get_value("windows") == len(ws)
      and stats.get_value("mean-ns") == ws[-1].get_value("mean-ns"))
stop(pipe)

# --- DTS-only buffers are measured off DTS ----------------------------------
pipe, src = build(["mrlateness name=lat interval-ms=100"])
feed(src, 15, 120 * MS, dts_only=True)
m = mean_of(windows(pipe))
check(f"DTS-only buffers measured (got {m and m / MS:.2f} ms)",
      m is not None and abs(m - 120 * MS) <= 5 * MS)
stop(pipe)

# --- a list of 7 stays ONE list downstream (chain_list, ADR-0011), one sample --
seen = {"lists": [], "buffers": 0}


def on_sink(_pad, info):
    if info.type & Gst.PadProbeType.BUFFER_LIST:
        seen["lists"].append(info.get_buffer_list().length())
    elif info.type & Gst.PadProbeType.BUFFER:
        seen["buffers"] += 1
    return Gst.PadProbeReturn.OK


pipe, src = build(["mrlateness name=lat interval-ms=10"])
pipe.get_by_name("fs").get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, on_sink)
lst = Gst.BufferList.new()
t0 = mono_ns() - 50 * MS
for i in range(7):
    lst.insert(-1, buffer(pts=t0 + i * MS))
time.sleep(0.02)   # let the 10 ms window open first
src.emit("push-buffer", buffer(pts=mono_ns()))
time.sleep(0.02)
src.emit("push-buffer-list", lst)
time.sleep(0.2)
st = pipe.get_by_name("lat").get_property("stats")
check(f"list of 7 arrives downstream as one list (lists {seen['lists']})",
      seen["lists"] == [7])
check("no list member split off as a single buffer", seen["buffers"] == 1)
check("chain_list counted once", st.get_value("lists") == 1)
ws = windows(pipe, settle_s=0)
check("the list is one sample", sum(s.get_value("count") for s in ws) == 2)
stop(pipe)

# --- running-time vs house: agree at base_time 0; house stays right otherwise --
TAPS = ["mrlateness name=h reference=house interval-ms=200",
        "mrlateness name=r reference=running-time interval-ms=200"]

pipe, src = build(TAPS, base_time_zero=True)
check("base_time = 0 pipeline really has base_time 0", pipe.get_base_time() == 0)
feed(src, 30, 300 * MS)
by_tap = windows_by_tap(pipe)
mh, mr = mean_of(by_tap.get("h", [])), mean_of(by_tap.get("r", []))
check(f"base_time 0: house reads 300 ms (got {mh and mh / MS:.2f})",
      mh is not None and abs(mh - 300 * MS) <= 5 * MS)
check(f"base_time 0: running-time agrees with house (diff "
      f"{mh is not None and mr is not None and (mr - mh) / MS:.3f} ms)",
      mh is not None and mr is not None and abs(mr - mh) <= 2 * MS)
stop(pipe)

pipe, src = build(TAPS)
base = pipe.get_base_time()
check("default pipeline has base_time != 0", base != 0)
feed(src, 30, 300 * MS)
by_tap = windows_by_tap(pipe)
mh, mr = mean_of(by_tap.get("h", [])), mean_of(by_tap.get("r", []))
check(f"base_time != 0: house stays 300 ms (got {mh and mh / MS:.2f})",
      mh is not None and abs(mh - 300 * MS) <= 5 * MS)
check("base_time != 0: running-time is off by the base time (so the case is real)",
      mh is not None and mr is not None and abs(mr - mh) > Gst.SECOND)
stop(pipe)

# --- B-26: behind an armed stamper under a natural base, the egress tap ----------------------
# mrtsstamp writes running time, PES − 1 h − base (video-encoder keeps its natural base,
# `liveCaptureClock`), so `house` reads base + λ there. The egress tap is the one the modules
# build (fixtures/aligner/pipelines.json, which vitest rewrites), whatever its reference.
_STAMP_PATHS = [os.path.join(_PLUGINS, "mpegts-core", "native", "mrtsstamp", "libgstmrtsstamp.so"),
                os.path.join(_LIBEXEC, "mpegts-core", "libgstmrtsstamp.so")]
_FIXTURE = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core",
                                         "tests", "fixtures", "aligner", "pipelines.json"))
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"
MUX_90K = 3600 * 90000   # mpegtsmux's 1 h


def pes_packet(pts90k):
    """One TS packet opening a video PES (stream 0xe0) whose PTS is `pts90k`."""
    p = pts90k & ((1 << 33) - 1)
    pts = bytes([0x21 | (((p >> 30) & 0x07) << 1), (p >> 22) & 0xFF,
                 0x01 | (((p >> 15) & 0x7F) << 1), (p >> 7) & 0xFF, 0x01 | ((p & 0x7F) << 1)])
    pkt = bytes([0x47, 0x41, 0x00, 0x10]) + b"\x00\x00\x01\xe0\x00\x00\x80\x80\x05" + pts
    return pkt + b"\xff" * (188 - len(pkt))


def feed_pes(src, n, lateness_ns, period_s=0.02):
    """n buffers, each a PES carrying house time lateness_ns behind CLOCK_MONOTONIC, + 1 h."""
    for _ in range(n):
        b = Gst.Buffer.new_wrapped(pes_packet((mono_ns() - lateness_ns) * 9 // 100000 + MUX_90K))
        b.pts = 0
        src.emit("push-buffer", b)
        time.sleep(period_s)


if not Gst.ElementFactory.find("mrtsstamp"):
    for _p in _STAMP_PATHS:
        if os.path.exists(_p) and Gst.Plugin.load_file(_p) is not None:
            break
with open(_FIXTURE, encoding="utf-8") as _fh:
    _refs = set(re.findall(r"mrlateness name=lat_busout_\d+ reference=(\S+)", _fh.read()))
check(f"the modules build every egress tap on one reference ({sorted(_refs)})", len(_refs) == 1)
if Gst.ElementFactory.find("mrtsstamp") is None or len(_refs) != 1:
    print("SKIP B-26 natural-base case — mrtsstamp plugin not built (make native)")
else:
    EGRESS_REF = _refs.pop()
    STAMPED = ["mrtsstamp active=true", "mrlateness name=h reference=house interval-ms=200",
               f"mrlateness name=e reference={EGRESS_REF} interval-ms=200"]
    pipe, src = build(STAMPED, caps=TS_CAPS)
    base = pipe.get_base_time()
    time.sleep(1)   # a stamp older than the pipeline's start would clamp to 0
    feed_pes(src, 30, 300 * MS)
    by_tap = windows_by_tap(pipe)
    mh, me = mean_of(by_tap.get("h", [])), mean_of(by_tap.get("e", []))
    check(f"natural base: the base is real ({base / Gst.SECOND:.0f} s, the clock at PLAYING)",
          base > 10 * Gst.SECOND)
    check(f"natural base: house reads base + λ, B-26 (off by "
          f"{mh is not None and (mh - base - 300 * MS) / MS:.3f} ms)",
          mh is not None and abs(mh - base - 300 * MS) <= 5 * MS)
    check(f"natural base: the egress tap (reference={EGRESS_REF}) reads λ = 300 ms "
          f"(got {me and me / MS:.2f} ms)", me is not None and abs(me - 300 * MS) <= 5 * MS)
    stop(pipe)

    pipe, src = build(STAMPED, base_time_zero=True, caps=TS_CAPS)
    feed_pes(src, 30, 300 * MS)
    by_tap = windows_by_tap(pipe)
    mh, me = mean_of(by_tap.get("h", [])), mean_of(by_tap.get("e", []))
    check(f"base 0 control: house reads 300 ms (got {mh and mh / MS:.2f})",
          mh is not None and abs(mh - 300 * MS) <= 5 * MS)
    check(f"base 0 control: the egress tap agrees with house within 1 ms (diff "
          f"{mh is not None and me is not None and (me - mh) / MS:.3f} ms)",
          mh is not None and me is not None and abs(me - mh) <= 1 * MS)
    stop(pipe)

# --- buffers with no timestamp count as untimed, not as samples --------------
# basesrc stamps an untimed FIRST buffer with DTS 0, so lead with a timed one.
pipe, src = build(["mrlateness name=lat interval-ms=50 reference=running-time"])
feed(src, 1, 10 * MS)
for _ in range(10):
    src.emit("push-buffer", buffer())
    time.sleep(0.02)
time.sleep(0.06)
feed(src, 1, 10 * MS)   # closes the window holding the last untimed ones
ws = windows(pipe)
check("untimed-only windows are posted",
      any(s.get_value("count") == 0 and s.get_value("untimed") > 0 for s in ws))
check("untimed buffers counted, not sampled",
      sum(s.get_value("untimed") for s in ws) == 10
      and sum(s.get_value("count") for s in ws) == 2)
stop(pipe)

# --- post-messages=false still fills stats; idle posts nothing; EOS passes ----
pipe, src = build(["mrlateness name=lat interval-ms=50 post-messages=false"])
feed(src, 10, 10 * MS)
check("post-messages=false posts nothing", windows(pipe) == [])
check("... but stats still fill",
      pipe.get_by_name("lat").get_property("stats").get_value("windows") >= 1)
stop(pipe)

pipe, src = build(["mrlateness name=lat interval-ms=50"])
feed(src, 5, 10 * MS)
windows(pipe, settle_s=0.1)
time.sleep(0.3)
check("no buffers, no window: nothing posted while idle", windows(pipe, settle_s=0) == [])
src.emit("end-of-stream")
msg = pipe.get_bus().timed_pop_filtered(2 * Gst.SECOND,
                                        Gst.MessageType.EOS | Gst.MessageType.ERROR)
check("EOS passes through to the sink",
      msg is not None and msg.type == Gst.MessageType.EOS)
stop(pipe)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrlateness_element_test.py")
    sys.exit(1)
print("\nALL gst_mrlateness_element_test.py TESTS PASSED")
