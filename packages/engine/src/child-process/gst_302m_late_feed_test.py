#!/usr/bin/env python3
"""The Audio Output (302M)'s sink end plays late audio late, never drops it (B-217, MR-057).

The module's string from its render tap on (`identity sync=true`, audioconvert, `mrasrc` on the
sink by name, volume, level, the 40 ms non-leaky prefill), into mrtestaudiosink, whose device
counts the all-zero runs it plays between sounding frames:

  - a 1 kHz tone fed 30-300 ms late with jitter (first 300 ms late) plays every frame fed, with
    no hole, on the module's sync=false sink; the mutant, the same sink at sync=true (v2.0.0.101's),
    discards seconds of it and plays holes. Run it on a quiet host: under CPU load the harness's
    Python feed starves the 40 ms prefill and the ring, and an underrun's realign plays a hole
    and loses about its length (seen at load 2 with three spinners: 16 holes, 0.4 s);
  - drift: an hour of a device 100 ppm fast, and an hour 100 ppm slow, a tone stamped at house
    rate: no hole, no underrun, the render lateness flat (it would move 360 ms an hour if `mrasrc`
    did not follow the device on its timer, B-166). `MR_302M_DRIFT_SECS`, `_SPEED` and `_PPM` set the run.

The sync=false ring starts before its first write: the start's one write-position realign is a
hole of the start, so holes count from 2 s on.

Skips (exit 0) without GStreamer or the built plugins."""
import os
import random
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_302m_late_feed_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

_HERE = os.path.dirname(os.path.abspath(__file__))
_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins")),
    "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
_TEST_SO = os.path.join(os.path.dirname(_SO), "tests", "libgstmrtest.so")
for _f in (_SO, _TEST_SO):
    if not os.path.exists(_f):
        print(f"SKIP gst_302m_late_feed_test.py — {_f} not built "
              "(make -C plugins/mpegts-core/native/mrtshouse test)")
        sys.exit(0)
Gst.Plugin.load_file(_SO)
Gst.Plugin.load_file(_TEST_SO)

S, MS = 1_000_000_000, 1_000_000
FS, BUF = 48000, 480                       # 10 ms buffers
CAPS = "audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"
# The module's string from its render tap to its sink (AudioOutput302mModule.ts), the device a test one.
TAIL = ("identity name=live_upstream sync=true ! audioconvert ! mrasrc name=outasrc device-sink=sink ! "
        "volume name=vol volume=1.00 ! level post-messages=true interval=100000000 ! "
        "queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000 max-size-buffers=0 "
        "max-size-bytes=0 ! mrtestaudiosink name=sink {sync} provide-clock=false max-lateness=-1 "
        "ts-offset=0 {ring} {device}")
PROD_RING = "buffer-time=100000 latency-time=10000"
SINK_KEYS = ("holes", "hole-frames", "hole-max", "underruns", "renders", "sounded-frames")

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def tone(i):
    """Buffer i of a continuous 1 kHz tone at half scale, both channels (never 1 ms of zeros)."""
    import math
    out = bytearray()
    import struct
    for n in range(i * BUF, (i + 1) * BUF):
        v = 0.5 * math.sin(2 * math.pi * 1000 * n / FS)
        out += struct.pack("<ff", v, v)
    return bytes(out)


_TONE = [tone(i) for i in range(48)]       # the tone repeats every 48 buffers (480 ms)


def lateness_ms(n, seed=7):
    """n lateness values: the first 300 ms, then a random walk within 30-300 ms (8 ms steps)."""
    rng, out, cur = random.Random(seed), [], 300.0
    for _ in range(n):
        out.append(cur)
        cur = min(300.0, max(30.0, cur + rng.gauss(0, 8)))
    return out


def run(desc, secs, speed=1, feed=None):
    """`desc` on MrTestClock at `speed` for `secs` of clock time: the sink's counters, the last mrasrc-stats
    from 10 s on, the prefill's levels per second, errors."""
    import gc
    gc.disable()   # a collection pause in the feed thread would be a hole of the harness's own
    clk = GObject.new(GObject.type_from_name("MrTestClock"))
    clk.set_property("speed", speed)
    p = Gst.parse_launch(desc)
    p.use_clock(clk)
    stop = threading.Event()
    p.set_state(Gst.State.PLAYING)
    th = threading.Thread(target=feed, args=(p, clk, stop), daemon=True) if feed else None
    if th:
        th.start()
    bus, start = p.get_bus(), clk.get_time()
    stats, levels, errors, next_level = [], [], [], 1.0
    while clk.get_time() - start < secs * S:
        now = (clk.get_time() - start) / S
        if now >= next_level:
            snk = p.get_by_name("sink")
            levels.append((now, p.get_by_name("prefill").get_property("current-level-time"),
                           {k: snk.get_property(k) for k in SINK_KEYS}))
            next_level += 1.0
        m = bus.timed_pop(20 * Gst.MSECOND)
        if m is None:
            continue
        if m.type == Gst.MessageType.ERROR:
            errors.append(m.parse_error()[0].message)
            break
        if m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-stats":
            stats.append((now, sdict(m.get_structure())))
    sink = {k: p.get_by_name("sink").get_property(k) for k in SINK_KEYS}
    stop.set()
    if th:
        th.join(2)
    p.set_state(Gst.State.NULL)
    gc.enable()
    return sink, stats, levels, errors


def late_feeder(late):
    """appsrc: buffer i stamped i x 10 ms (running time), pushed when the clock reads it + late[i]."""
    def feed(p, clk, stop):
        src = p.get_by_name("src")
        while p.get_base_time() == 0 and not stop.is_set():
            time.sleep(0.001)
        base = p.get_base_time()
        for i, l in enumerate(late):
            # A clock wait, not a sleep loop: the feed's own jitter stays well under the prefill.
            Gst.Clock.id_wait(clk.new_single_shot_id(base + i * 10 * MS + int(l * MS)))
            if stop.is_set():
                return
            b = Gst.Buffer.new_wrapped(_TONE[i % len(_TONE)])
            b.pts, b.duration = i * 10 * MS, 10 * MS
            if src.emit("push-buffer", b) != Gst.FlowReturn.OK:
                return
    return feed


def after(levels, sink, t0):
    """The sink's counters from clock second t0 to the end (the start's one write-position realign excluded)."""
    base = next((c for t, _, c in levels if t >= t0), None) or {k: 0 for k in SINK_KEYS}
    return {k: sink[k] - base[k] if k != "hole-max" else sink[k] for k in SINK_KEYS}


# The drift runs: the input waits on the device (the element suite's long device case), so a sped-up
# clock's scheduling cannot starve the ring; the sink end as the module's, its ring 2 s.
DRIFT = ("mrasrc name=outasrc device-sink=sink ! volume name=vol volume=1.00 ! "
         "queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000 max-size-buffers=0 "
         "max-size-bytes=0 ! mrtestaudiosink name=sink sync=false provide-clock=false buffer-time=2000000 "
         "latency-time=20000 ppm={ppm} device-ns=1000000000")


def paced_feeder(p, clk, stop):
    """appsrc (block=true): a tone stamped at house rate, as fast as the device takes it."""
    src, i = p.get_by_name("src"), 0
    while not stop.is_set():
        b = Gst.Buffer.new_wrapped(_TONE[i % len(_TONE)])
        b.pts, b.duration = i * 10 * MS, 10 * MS
        if src.emit("push-buffer", b) != Gst.FlowReturn.OK:
            return
        i += 1


# --- late with jitter: played late, never dropped ------------------------------------------------
_SECS = 40
_late = lateness_ms(_SECS * 100)
print(f"\n--- a tone fed 30-300 ms late with jitter (first 300, mean {sum(_late) / len(_late):.0f} ms), "
      f"{_SECS} s, the module's sink end ---")
_src = f"appsrc name=src is-live=true format=time do-timestamp=false block=false max-bytes=0 caps={CAPS} ! "
_dev = "ppm=100 device-ns=40000000"
_sk, _st, _lv, _err = run(_src + TAIL.format(sync="sync=false", ring=PROD_RING, device=_dev), _SECS + 3,
                          feed=late_feeder(_late))
_a = after(_lv, _sk, 2)
_fed = len(_late) * BUF
check(f"sync=false discards nothing: of {_fed} frames fed, {_sk['sounded-frames']} sounded at the device "
      f"({(_fed - _sk['sounded-frames']) / 48:.1f} ms short: what the prefill still holds at the end)",
      not _err and 0 <= _fed - _sk["sounded-frames"] <= 4800)
_lat = [s.get("render-lateness-ns", 0) for t, s in _st if t >= 20]
check(f"sync=false: from 2 s no hole the device played ({_a['holes']} holes, {_a['hole-frames']} frames; "
      f"{_sk['holes']} with the start's), no underrun ({_a['underruns']}), {_sk['renders']} renders, no error {_err}",
      not _err and _a["holes"] == 0 and _a["underruns"] == 0 and _sk["renders"] > _SECS * 50)
check(f"... it plays late: the render lateness from 20 s at least the feed's first 300 ms "
      f"({min(_lat) / MS if _lat else -1:.0f} .. {max(_lat) / MS if _lat else -1:.0f} ms)",
      bool(_lat) and min(_lat) >= 300 * MS)

print("\n--- the mutant: the same feed into the sink at sync=true (v2.0.0.101's), 20 s ---")
_sk, _st, _lv, _err = run(_src + TAIL.format(sync="sync=true", ring=PROD_RING, device=_dev), 23,
                          feed=late_feeder(_late[:2000]))
_a = after(_lv, _sk, 2)
_fed = 2000 * BUF
check(f"sync=true discards the late samples: of {_fed} frames fed, {_sk['sounded-frames']} sounded "
      f"({(_fed - _sk['sounded-frames']) / 48:.0f} ms discarded)",
      not _err and _fed - _sk["sounded-frames"] > 48000)
check(f"sync=true drops the late samples: from 2 s the device plays holes ({_a['holes']} holes, "
      f"{_a['hole-frames'] / 48:.0f} ms, longest {_sk['hole-max'] / 48:.0f} ms)",
      not _err and _a["holes"] > 0)

# --- drift: an hour each way, a house-rate tone ---------------------------------------------------
_DRIFT = int(os.environ.get("MR_302M_DRIFT_SECS", "3660"))
_SPEED = int(os.environ.get("MR_302M_DRIFT_SPEED", "6"))
_PPMS = [int(v) for v in os.environ.get("MR_302M_DRIFT_PPM", "100,-100").split(",") if v]
for _ppm in _PPMS:
    print(f"\n--- drift: a house-rate tone into a device {_ppm:+d} ppm, {_DRIFT} s on a {_SPEED}x clock ---")
    _sk, _st, _lv, _err = run(
        f"appsrc name=src format=time block=true max-bytes=65536 caps={CAPS} ! " + DRIFT.format(ppm=_ppm),
        _DRIFT, speed=_SPEED, feed=paced_feeder)
    _a = after(_lv, _sk, 2)
    _late = [s.get("render-lateness-ns", 0) for t, s in _st if t >= 120]
    _last = _st[-1][1] if _st else {}
    _span = (max(_late) - min(_late)) / MS if _late else -1
    check(f"{_ppm:+d} ppm: from 2 s no hole ({_a['holes']}), no underrun ({_a['underruns']}), no error {_err}",
          not _err and _a["holes"] == 0 and _a["underruns"] == 0)
    check(f"... the render lateness from 120 s within 2 ms ({_span:.2f} ms over {len(_late)} posts; uncorrected "
          f"{abs(_ppm) * _DRIFT / 1000:.0f} ms)", len(_late) > 50 and 0 <= _span < 2)
    check(f"... the device term locked at {_last.get('device-ppb', 0) / 1000:+.2f} ppm ({_ppm:+d})",
          _last.get("state") == "locked" and abs(_last.get("device-ppb", 0) - _ppm * 1000) <= 1000)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_302m_late_feed_test.py")
    sys.exit(1)
print("\nOK gst_302m_late_feed_test.py")
