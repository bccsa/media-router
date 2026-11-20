#!/usr/bin/env python3
"""The Audio Output (302M)'s sink end plays late audio late, never drops it, and keeps a margin (B-217, B-249).

The module's own string from its live upstream on (plugins/audio-output-302m/tests/fixtures/sink-end.json, which
AudioOutput302mModule.test.ts holds the module to: the render tap, `mrasrc` with its 60 ms margin, the queue, the
sync=false sink), into mrtestaudiosink, whose device counts the frames it plays and the all-zero runs between them
(holes). A 1 kHz tone, 10 ms buffers, each fed late by a profile, then 2 s more so the queue and ring play out:

  - rising: 30 ms for 10 s, then a walk within 30-300 ms (8 ms steps); field: the walk within 30-70 ms from 30 ms
    (MR-057 on TECH01); step: 30 ms, 70 ms from 10 s, 30 ms at 25 s, 70 ms at 30 s; old: c38's walk from its
    300 ms max. Each MR_302M_RUNS times (5), a seed each, waiting for a load under 3 first.
  - pass: every frame fed taken by mrasrc and every frame it made sounding but at most 1 ms (the allowance:
    mrasrc's resampler holds 32 frames; the feed ends with EOS, where mrasrc posts its counts); no hole after 2 s,
    except in the rising walk, where the feed gets later than any margin: there holes come only until the walk
    first reached its maximum (each rebuilds the margin), none after, and their length is the rise less the
    margin plus a margin each; the delay from then on flat (what the catch-up played out added back), nothing lost.
  - the catch-up (B-249; MR_302M_CATCH_RUNS runs, 3): a late start (the first 0.8 s of the feed at once), a
    400 ms spike for 1 s, rising then falling (30 ms, 30-200 ms over 10 s, 30 ms from 40 s): nothing lost, holes
    only at the spike or on the rise, back to the target (the feed, the device, two segments, the margin and a
    buffer: 160 ms) at the end; the late start in the time a 60 s window and 0.5 % imply (+-20 %); the field
    walk after a 0.5 s late start, 190 s: the backlog played out, no more holes than with catch-up-ppm=0.
  - mutants: c38's sink end (a 40 ms min-threshold queue, no margin) fails that pass on every run: in the rising
    walk it plays holes to the end and loses audio, in the field walk it loses audio at the start and, on some
    runs, plays holes for good; v2.0.0.101's (sync=true, ts-offset 0: a budget of the ~110 ms its sink
    declares, most of it the ring's own) cuts the field walk into holes, as on TECH01, and the rising walk.
  - writer stalls (B-249 fix round 3; seeds 7, 8, 9, 420 s): the thread that writes into the sink (302M: `outq`'s;
    the Audio Decoder's sink end: the one into `asrc`) is held (it spins) 80-120 ms at content 10, 15, 20, 25, 55
    and 150 s, the feed 30 ms late: each stall a hole at most (each with its refill), nothing lost, each adding at
    most its length plus the margin, 40 ms and two segments to the delay, which is back at the target at the end,
    within a window and what was in hand at 0.5 % (+20 %) of the last stall, and a window more for each of decq's
    300 ms of it on the Audio Decoder (what waits past decq, here in appsrc, comes into view only as decq drains;
    900 s on a server).
  - flushes (B-249 fix round 4; seeds 7, 8, 9, a 70-90 ms feed): a 3 s device stall past the first window (300 s),
    a flush into the sink (150 s), outq held 0.6 s then READY and back (260 s), and the same with a 1.5 s input gap
    20 s on (100 s), the gap alone (c40, 150 s), and outq held 0.6 s then a flush into the sink below it (c40,
    330 s): no hole and no refill after the event's own, the catch-up `watching` after it (not after a gap: it resets
    nothing), the end at the target and not below the feed, the device and the margin (before c40 the gap kept its
    length, what outq held past a flush stayed, and the reading crept after a flush), after the gap alone at most
    20 ms over the reading before it, no device stall but the device's own.
  - drift: an hour of a device 100 ppm fast, and an hour 100 ppm slow, a tone stamped at house rate: no hole, no
    underrun, no refill after the start, the render lateness's level the same at the end as after 2 min and its
    p1-p99 within 2 ms and max-min within 20 (B-166). `MR_302M_DRIFT_SECS`, `_SPEED` and `_PPM` set the run.
  - MR_302M_PULSE_SINK=<a null sink>: a real pulsesink on that sink, holes counted on its monitor: the edge
    profile (10 s at 30 ms, then the feed set to land its writes 0-30 ms ahead of the device clock in 3 ms steps,
    shuffled, 30 s each; seeds 7, 8, 9: inside the server's read-ahead, where c1a929b9 lost audio with no refill),
    the Audio Decoder's sink end on the same edge (plugins/audio-decoder/tests/fixtures/sink-end.json, which
    AudioDecoderModule.test.ts holds the module to; no queue between its `asrc` and the sink): 10 s at 30 ms,
    then 20 steps of 3 s each landing its writes 2 ms ahead of the clock, the 10 buffers before each step
    coming at once so the last push before the pause blocks in the sink (21eade5e dropped the write after it;
    seeds 7, 8), the flush profile (two flushes into the sink, as mrasrc's device flush makes them), then the
    field and the rising profile for MR_302M_PULSE_SECS (600), and the catch-up's late start and spike. Pass: every
    hole after the start has a refill within 3 s of it, the rising walk none once at its max, every frame fed taken
    and the frames heard within 1 ms of what mrasrc made; the late start and the spike back to the server's target
    (190 ms), the late start in a window plus 0.5 % (+-20 %); a flush one hole, its refills each at most
    the 3 s cap as they reach the sink (REFILL_MAX_MS: c1a929b9 put 5 and 10 s of silence in one), at most
    200 ms lost, sound to the end; the writer stalls on both tails (600 s, the decoder 900; every hole with its
    refill); an outage of 2.5, 6.5 and 10 s on both tails: one hole, each refill at most the cap, lost at most a
    10 ms buffer a cap crossed where pulsesink's segment count does not move (1.22: the write after each capped
    refill is behind the server's read index), nothing where it does (1.28). MR_302M_PULSE_MON_US sets the
    monitor's latency (so the graph quantum). Not in the chain (it needs a server). MR_302M_PARTS picks parts
    (sink, mutants, catch, stalls, flushes, pulse, drift).

A run that fails while the load was 3 or more is run again once, after the load fell. Skips (exit 0) without
GStreamer or the built plugins."""
import json
import math
import os
import random
import struct
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
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
_NATIVE = os.path.join(_PLUGINS, "mpegts-core", "native")
_SOS = (os.path.join(_NATIVE, "mrtshouse", "libgstmrtshouse.so"),
        os.path.join(_NATIVE, "mrtshouse", "tests", "libgstmrtest.so"),
        os.path.join(_NATIVE, "mrlateness", "libgstmrlateness.so"))
for _f in _SOS:
    if not os.path.exists(_f):
        print(f"SKIP gst_302m_late_feed_test.py — {_f} not built (make -C plugins/mpegts-core/native/mrtshouse test)")
        sys.exit(0)
    Gst.Plugin.load_file(_f)

S, MS = 1_000_000_000, 1_000_000
FS, BUF = 48000, 480                       # 10 ms buffers
CAPS = "audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"
MARGIN_MS = 60                             # OUTPUT_MARGIN_MS
START_S = 2
DRAIN_S = 2
SECS = int(os.environ.get("MR_302M_SECS", "40"))
RUNS = int(os.environ.get("MR_302M_RUNS", "5"))
LOAD_MAX = 3.0
# Which parts run (all by default): sink (the profiles), mutants, catch (the catch-up's), stalls (writer stalls),
# flushes (the catch-up across flushes and READY), pulse (MR_302M_PULSE_SINK), drift.
PARTS = set(os.environ.get("MR_302M_PARTS", "sink,mutants,catch,stalls,flushes,pulse,drift").split(","))
SINK_KEYS = ("holes", "hole-frames", "hole-max", "underruns", "renders", "sounded-frames")

with open(os.path.join(_PLUGINS, "audio-output-302m", "tests", "fixtures", "sink-end.json"), encoding="utf-8") as _fh:
    MODULE_TAIL = json.load(_fh)["tail"]
# The Audio Decoder's, fed PCM (no decoder); the ts-offset times nothing on its sync=false sink.
with open(os.path.join(_PLUGINS, "audio-decoder", "tests", "fixtures", "sink-end.json"), encoding="utf-8") as _fh:
    DEC_TAIL = json.load(_fh)["tail"].replace("%DECODER% ! ", "").replace("%TS_OFFSET%", "0")
DECQ_MS = int(DEC_TAIL.split("max-size-time=")[1].split()[0]) // MS if "max-size-time=" in DEC_TAIL else 0
# The test device: pulsesink's 10 ms segments (its latency-time default), 100 ppm fast, 40 ms of its own.
TEST_SINK = "mrtestaudiosink name=sink"
TEST_DEVICE = " latency-time=10000 ppm=100 device-ns=40000000"
# c38's sink end (9c91de16), the render tap included: the 40 ms min-threshold prefill, no margin.
C38_TAIL = ("identity name=live_upstream sync=true ! mrlateness name=lat_render reference=running-time ! audioconvert"
            " ! mrasrc name=outasrc device-sink=sink ! volume name=vol volume=1.00"
            " ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000"
            " ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000 max-size-buffers=0"
            " max-size-bytes=0 ! %SINK% sync=false provide-clock=false max-lateness=-1 buffer-time=100000 ts-offset=0")
# v2.0.0.101's (92f0a789): sync=true on the house clock, custom slaving, no queue; its budget the ts-offset
# (D 60 less the 100 ms the sink declares, clamped: 0) plus the latency the sink declares (101.3 ms in the field).
V101_TAIL = ("identity name=live_upstream sync=true ! mrlateness name=lat_render reference=running-time ! audioconvert"
             " ! mrasrc name=outasrc device-sink=sink ! volume name=vol volume=1.00"
             " ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000"
             " ! %SINK% sync=true provide-clock=false slave-method=3 max-lateness=-1 buffer-time=100000"
             " ts-offset=0")

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def tail_for(tail, sink=TEST_SINK, device=TEST_DEVICE):
    return tail.replace("%SINK%", sink) + device


def tone(i):
    """Buffer i of a continuous 1 kHz tone at half scale, both channels (never 1 ms of zeros)."""
    out = bytearray()
    for n in range(i * BUF, (i + 1) * BUF):
        v = 0.5 * math.sin(2 * math.pi * 1000 * n / FS)
        out += struct.pack("<ff", v, v)
    return bytes(out)


_TONE = [tone(i) for i in range(48)]       # the tone repeats every 48 buffers (480 ms)


# --- the profiles: lateness (ms) of each 10 ms buffer ---------------------------------------------------------

def walk(n, lo, hi, first, start_i, seed):
    rng, out, cur = random.Random(seed), [], float(first)
    for i in range(n):
        out.append(cur)
        if i >= start_i:
            cur = min(hi, max(lo, cur + rng.gauss(0, 8)))
    return out


PROFILES = {
    "rising": lambda n, seed: walk(n, 30.0, 300.0, 30.0, 1000, seed),
    "field": lambda n, seed: walk(n, 30.0, 70.0, 30.0, 0, seed),
    "step": lambda n, seed: [30.0 if (i < 1000 or 2500 <= i < 3000) else 70.0 for i in range(n)],
    "old": lambda n, seed: walk(n, 30.0, 300.0, 300.0, 0, seed),
}
# The catch-up's (B-249): a late start (the first 0.8 s of the feed at once at 0.83 s: the backlog a late sink start
# leaves in the queue), a spike (400 ms for 1 s at 10 s), rising then falling (30 ms, 30-200 ms over 10 s, held,
# 30 ms from 40 s), and the field walk after a 0.5 s late start, long enough to be caught up (against catch-up-ppm=0).
CATCH = {
    "late": (lambda n, seed: [max(30.0, 830.0 - 10 * i) for i in range(n)], 270),
    "spike": (lambda n, seed: [400.0 if 1000 <= i < 1100 else 30.0 for i in range(n)], 180),
    "risefall": (lambda n, seed: [30.0 if i < 1000 else min(200.0, 30 + (i - 1000) * 0.17) if i < 4000 else 30.0
                                  for i in range(n)], 170),
    "field-long": (lambda n, seed: [max(l, 530.0 - 10 * i) for i, l in enumerate(walk(n, 30.0, 70.0, 30.0, 0, seed))],
                   190),
}
CATCH_RUNS = int(os.environ.get("MR_302M_CATCH_RUNS", "3"))
# On a real pulsesink the sink's own start may come up 0.3-2 s late on top (the dev Pi): room for 2.8 s at 0.5 %.
PULSE_CATCH_SECS = {"late": 660, "spike": 540}
RATE = 0.005                               # OUTPUT_CATCH_UP_PPM
WINDOW_S = 60                              # mrts::ASRC_CATCHUP_WINDOW_NS


# --- the harness ---------------------------------------------------------------------------------------------

def wait_quiet(limit_s=900):
    """Wait (up to limit_s) for a 1-minute load under LOAD_MAX: the dev Pi is shared. The load at the end."""
    t0 = time.monotonic()
    while os.getloadavg()[0] >= LOAD_MAX and time.monotonic() - t0 < limit_s:
        time.sleep(5)
    return os.getloadavg()[0]


LAST_LATENCY_NS = None   # the pipeline's min latency, read 3 s into the last run
LAST_ASRC = {}           # the last run's mrasrc stats at its end (its EOS post where the feed ended)


def run(desc, secs, speed=1, feed=None, setup=None):
    """`desc` on MrTestClock at `speed` for `secs` of clock time: the sink's counters, the mrasrc-stats posts,
    the sink's counters per second, errors. `setup(p, clk, t0)` adds probes before it plays (t0[0]: the clock's
    start, once it plays)."""
    import gc
    gc.disable()   # a collection pause in the feed thread would be a hole of the harness's own
    clk = GObject.new(GObject.type_from_name("MrTestClock"))
    clk.set_property("speed", speed)
    p = Gst.parse_launch(desc)
    p.use_clock(clk)
    stop = threading.Event()
    t0 = [None]
    if setup:
        setup(p, clk, t0)
    p.set_state(Gst.State.PLAYING)
    th = threading.Thread(target=feed, args=(p, clk, stop), daemon=True) if feed else None
    if th:
        th.start()
    bus, start = p.get_bus(), clk.get_time()
    t0[0] = start
    stats, levels, errors, next_level = [], [], [], 1.0
    snk = p.get_by_name("sink")
    global LAST_LATENCY_NS
    LAST_LATENCY_NS = None
    while clk.get_time() - start < secs * S:
        now = (clk.get_time() - start) / S
        if LAST_LATENCY_NS is None and now >= 3:
            q = Gst.Query.new_latency()
            LAST_LATENCY_NS = q.parse_latency()[1] if p.query(q) else -1
        if now >= next_level:
            levels.append((now, {k: snk.get_property(k) for k in SINK_KEYS}))
            next_level += 1.0
        m = bus.timed_pop(20 * Gst.MSECOND)
        if m is None:
            continue
        if m.type == Gst.MessageType.ERROR:
            errors.append(m.parse_error()[0].message)
            break
        if m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-stats":
            stats.append((now, sdict(m.get_structure())))
    sink = {k: snk.get_property(k) for k in SINK_KEYS}
    stop.set()
    if th:
        th.join(2)
    a = p.get_by_name("outasrc") or p.get_by_name("asrc")
    global LAST_ASRC
    LAST_ASRC = sdict(a.get_property("stats")) if a else {}
    p.set_state(Gst.State.NULL)
    gc.enable()
    return sink, stats, levels, errors


def late_feeder(late, eos=False):
    """appsrc: buffer i stamped i x 10 ms (running time), pushed when the clock reads it + late[i] (a callable: its
    value for i); then nothing, or EOS (mrasrc posts its stats at it: the frames it took and made, exact)."""
    def feed(p, clk, stop):
        src = p.get_by_name("src")
        while p.get_base_time() == 0 and not stop.is_set():
            time.sleep(0.001)
        base = p.get_base_time()
        for i, l in enumerate(late):
            if callable(l):
                l = l(i)
            # A clock wait, not a sleep loop: the feed's own jitter stays well under the margin.
            Gst.Clock.id_wait(clk.new_single_shot_id(base + i * 10 * MS + int(l * MS)))
            if stop.is_set():
                return
            b = Gst.Buffer.new_wrapped(_TONE[i % len(_TONE)])
            b.pts, b.duration = i * 10 * MS, 10 * MS
            if src.emit("push-buffer", b) != Gst.FlowReturn.OK:
                return
        if eos:
            src.emit("end-of-stream")
    return feed


SRC = f"appsrc name=src is-live=true format=time do-timestamp=false block=false max-bytes=0 caps={CAPS} ! "


def holes_from(levels, sink, t0):
    """The sink's holes and hole frames from clock second t0 to the end."""
    base = next((c for t, c in levels if t >= t0), None) or {k: 0 for k in SINK_KEYS}
    return sink["holes"] - base["holes"], sink["hole-frames"] - base["hole-frames"]


def last_hole_s(levels):
    """The clock second by which the last hole had come (0: none)."""
    last, prev = 0.0, 0
    for t, c in levels:
        if c["holes"] > prev:
            last = t
        prev = c["holes"]
    return last


def one_run(tail, name, seed):
    """One profile run on `tail`: the outcome, and the load before and after."""
    gen, secs = CATCH[name] if name in CATCH else (PROFILES[name], SECS)
    n = secs * 100
    late = gen(n, seed)
    load0 = wait_quiet()
    sk, st, lv, err = run(SRC + tail, secs + DRAIN_S, feed=late_feeder(late, eos=True))
    fed = n * BUF
    # Lost: what mrasrc never took, and what it made that never sounded (its 32-frame tail leaves after the EOS
    # post). The device term and the catch-up make fewer or more frames than were fed; neither is a loss (B-249).
    took, made = LAST_ASRC.get("in-frames", 0), LAST_ASRC.get("out-frames", 0)
    lost = (fed - took) + max(0, made - sk["sounded-frames"])
    h2, hf2 = holes_from(lv, sk, START_S)
    imax = next(i for i, l in enumerate(late) if l >= max(late))
    t_max = imax / 100 + late[imax] / 1000
    # The render lateness with what the catch-up removed added back: flat unless the delay crept (B-249).
    lat = [(t, (s.get("render-lateness-ns", 0) + s.get("catch-up-removed-ns", 0)) / MS) for t, s in st
           if s.get("render-lateness-ns", 0)]
    steady = [v for t, v in lat if t >= max(START_S + 3, t_max + 3) and t <= secs]
    raw = [(t, s.get("render-lateness-ns", 0) / MS) for t, s in st if s.get("render-lateness-ns", 0)]
    cu = [(t, s.get("catch-up-state", "off")) for t, s in st]
    begins = [t for (t, a), (_, b) in zip(cu, cu[1:]) if b == "catching-up" and a != "catching-up"]
    return {"name": name, "seed": seed, "fed": fed, "lost": lost, "short": fed - sk["sounded-frames"], "holes": h2,
            "hole_ms": hf2 / 48, "holes_all": sk["holes"], "last_hole": last_hole_s(lv), "t_max": t_max,
            "rise": max(late) - late[0], "lat": steady, "first_late": late[0], "err": err,
            "refills": (st[-1][1].get("margin-refills", 0) if st else 0), "load": (load0, os.getloadavg()[0]),
            "latency": LAST_LATENCY_NS, "raw": raw, "begins": begins, "secs": secs,
            "removed": (st[-1][1].get("catch-up-removed-ns", 0) / MS if st else 0),
            "cu_end": cu[-1][1] if cu else "none"}


def passes(r):
    """The margin's pass: nothing lost beyond 1 ms; no hole after the start, or (rising) none after the walk first
    reached its maximum and no more hole time than the rise less one margin plus a margin each; flat after."""
    span = (max(r["lat"]) - min(r["lat"])) if r["lat"] else 99
    ok = not r["err"] and 0 <= r["lost"] <= 48 and span < 5
    if r["name"] == "rising":
        return ok and r["last_hole"] <= r["t_max"] + 1.5 and r["hole_ms"] <= r["rise"] + MARGIN_MS * (r["holes"] - 1) + 20
    return ok and r["holes"] == 0


def describe(r):
    lat = f"{min(r['lat']):.0f}..{max(r['lat']):.0f} ms" if r["lat"] else "none"
    extra = f", last hole by {r['last_hole']:.0f} s, max reached {r['t_max']:.1f} s" if r["name"] == "rising" else ""
    return (f"{r['holes']} holes after {START_S} s ({r['hole_ms']:.0f} ms{extra}), lost {r['lost'] / 48:.2f} ms, "
            f"render lateness {lat}, {r['refills']} refills, load {r['load'][0]:.1f}/{r['load'][1]:.1f}"
            f"{', errors ' + str(r['err']) if r['err'] else ''}")


def run_checked(tail, name, seed, label):
    r = one_run(tail, name, seed)
    if not passes(r) and max(r["load"]) >= LOAD_MAX:
        print(f"  ({label} {name} seed {seed} failed at load {max(r['load']):.1f}: run again once, alone, quiet)")
        r = one_run(tail, name, seed)
    return r


TABLE = []

# --- the module's sink end: every profile, RUNS times ----------------------------------------------------------
_c39 = tail_for(MODULE_TAIL)
print(f"--- the module's sink end ({SECS} s + {DRAIN_S} s drain, {RUNS} runs a profile): {_c39}")
for _name in (PROFILES if "sink" in PARTS else ()):
    for _k in range(RUNS):
        _r = run_checked(_c39, _name, 7 + _k, "c39")
        TABLE.append(("c39", _r))
        check(f"c39 {_name} seed {7 + _k}: {describe(_r)}", passes(_r))

# --- mutants ----------------------------------------------------------------------------------------------------
_c38 = tail_for(C38_TAIL)
print("\n--- mutant: c38's sink end (the 40 ms min-threshold prefill, no margin) ---")
for _name in (("rising", "field") if "mutants" in PARTS else ()):
    _rs = []
    for _k in range(RUNS):
        _r = one_run(_c38, _name, 7 + _k)
        _rs.append(_r)
        TABLE.append(("c38", _r))
        print(f"  c38 {_name} seed {7 + _k}: {describe(_r)}")
    # The start alone loses audio on c38 (the reviewer's minor 6), so every run fails the margin's pass.
    check(f"c38 {_name}: every run fails the margin's pass ({[r['holes'] for r in _rs]} holes after the start, "
          f"{[round(r['lost'] / 48) for r in _rs]} ms lost)", not any(passes(r) for r in _rs))
    if _name == "rising":
        check(f"c38 rising: every run plays holes after the start and loses more than 100 ms",
              all(r["holes"] > 0 and r["lost"] > 48 * 100 for r in _rs))

_v101 = tail_for(V101_TAIL)
print("\n--- mutant: v2.0.0.101's sink end (sync=true, ts-offset 0: its budget the latency the sink declares) ---")
for _name in (("rising", "field") if "mutants" in PARTS else ()):
    _rs = []
    for _k in range(2):
        _r = one_run(_v101, _name, 7 + _k)
        _rs.append(_r)
        TABLE.append(("v101", _r))
        print(f"  v101 {_name} seed {7 + _k}: {describe(_r)}; budget {(_r['latency'] or 0) / MS:.1f} ms declared")
    if _name == "rising":
        check(f"v101 rising: lateness past its budget is discarded ({[round(r['lost'] / 48) for r in _rs]} ms lost, "
              f"{[r['holes'] for r in _rs]} holes)", all(r["lost"] > 48000 and r["holes"] > 0 for r in _rs))
    else:
        # MR-057 itself: the ring takes most of the declared latency, so a feed 30-70 ms late is cut.
        check(f"v101 field: the field's feed is cut, as on TECH01 ({[r['holes'] for r in _rs]} holes, "
              f"{[round(r['lost'] / 48) for r in _rs]} ms lost)", all(r["lost"] > 4800 and r["holes"] > 0 for r in _rs))

# --- the catch-up (B-249): back to the margin at 0.5 %; the target: the feed's 30 ms, the device's 40 ms, two -----
# segments in flight, the 60 ms margin and a buffer (the trough is read just before a buffer comes); the time to
# within 5 ms of the end against a window plus (start - end) at 0.5 %.
TARGET_MAX = 30 + 40 + 20 + MARGIN_MS + 10
_c39_off = tail_for(MODULE_TAIL.replace(" catch-up-ppm=5000", ""))


def recovery(r, t_from):
    """Render lateness at t_from + 3-8 s and over the last 10 s; when it came within 5 ms of the end for good."""
    early = [v for t, v in r["raw"] if t_from + 3 <= t <= t_from + 8]
    tail = [v for t, v in r["raw"] if t >= r["secs"] - 10 and t <= r["secs"]]
    if not early or not tail:
        return None
    end = sum(tail) / len(tail)
    reach = 0.0
    for t, v in r["raw"]:
        if t <= r["secs"] and abs(v - end) > 5:
            reach = t
    return max(early), end, reach


def describe_cu(r, rec):
    lv = f"{rec[0]:.0f} -> {rec[1]:.0f} ms by {rec[2]:.0f} s" if rec else "no lateness read"
    return (f"{r['holes']} holes after {START_S} s ({r['hole_ms']:.0f} ms), lost {r['lost'] / 48:.2f} ms, render "
            f"lateness {lv}, catch-up runs from {[round(t) for t in r['begins']]} s removed {r['removed']:.0f} ms "
            f"({r['cu_end']} at the end), {r['refills']} refills, load {r['load'][0]:.1f}/{r['load'][1]:.1f}"
            f"{', errors ' + str(r['err']) if r['err'] else ''}")


CU_TABLE = []
if "catch" in PARTS:
    print(f"\n--- the catch-up (B-249): {CATCH_RUNS} runs a profile on the module's sink end ---")
    for _name in CATCH:
        for _k in range(CATCH_RUNS):
            _seed = 7 + _k
            _r = one_run(_c39, _name, _seed)
            if _name == "field-long":
                _o = one_run(_c39_off, _name, _seed)
                _ok = not _r["err"] and _r["holes"] <= _o["holes"] and 0 <= _r["lost"] <= 48 and _r["removed"] >= 400
                CU_TABLE.append((_name, _seed, _r, _o))
                check(f"field walk after a 0.5 s late start, 190 s, seed {_seed}: {describe_cu(_r, recovery(_r, 0.53))}; "
                      f"catch-up-ppm=0: {_o['holes']} holes, lost {_o['lost'] / 48:.2f} ms: no more holes than with none, "
                      f"the backlog played out", _ok)
                continue
            t_from = {"late": 0.83, "spike": 11.4, "risefall": 40.0}[_name]
            rec = recovery(_r, t_from)
            CU_TABLE.append((_name, _seed, _r, rec))
            ok = not _r["err"] and 0 <= _r["lost"] <= 48 and rec is not None and rec[1] <= TARGET_MAX
            if _name == "late":
                # Proven for a window after the sink starts, then the excess at 0.5 %: +-20 %.
                want = WINDOW_S + (rec[0] - rec[1]) / 1000 / RATE if rec else 0
                ok = ok and _r["holes"] == 0 and rec[0] - rec[1] >= 700 and abs(rec[2] - want) <= 0.2 * want
                extra = f"; back by {rec[2]:.0f} s, a window and 0.5 % imply {want:.0f} s (+-20 %)" if rec else ""
            elif _name == "spike":
                ok = ok and _r["holes"] <= 2 and len(_r["begins"]) >= 1 and _r["last_hole"] <= 12.5
                extra = f"; holes only at the spike (last by {_r['last_hole']:.0f} s)"
            else:
                ok = ok and _r["last_hole"] <= 21.5 and len(_r["begins"]) >= 1 and all(b >= 40 + WINDOW_S - 2
                                                                                       for b in _r["begins"][-1:])
                extra = f"; holes only on the rise (last by {_r['last_hole']:.0f} s), caught up from a window after the fall"
            check(f"{_name} seed {_seed}: {describe_cu(_r, rec)}{extra}; target at most {TARGET_MAX} ms", ok)

# --- writer stalls (B-249 fix round 3): the thread into the sink is held 80-120 ms at each STALL_AT_S ---------------
# (302M: outq's; the Audio Decoder: the one into `asrc`), a 30 ms feed: 5 s apart, then 30 s (inside the catch-up's
# window), then 95 s (while it runs). Each hole stays as delay until the catch-up plays it out.
STALL_AT_S = (10, 15, 20, 25, 55, 150)
STALL_SECS = int(os.environ.get("MR_302M_STALL_SECS", "420"))
_STALL_SEEDS = [int(v) for v in os.environ.get("MR_302M_STALL_SEEDS", "7,8,9").split(",") if v]


def stall_plan(seed):
    rng = random.Random(seed * 17)
    return [(t, round(rng.uniform(80, 120), 1)) for t in STALL_AT_S]


def stall_probe(p, dec, plan, fired, now):
    """Hold the writer thread at each (content s, ms) of plan, timed on its buffers' PTS; now() at each into fired.
    It spins: a writer asleep with its buffer waiting reads as one blocked in the sink (c41's full stream)."""
    pad = p.get_by_name("asrc").get_static_pad("sink") if dec else p.get_by_name("outq").get_static_pad("src")
    st = {"k": 0, "t0": None}

    def probe(_pad, info):
        b = info.get_buffer()
        if b is None or b.pts == Gst.CLOCK_TIME_NONE:
            return Gst.PadProbeReturn.OK
        if st["t0"] is None:
            st["t0"] = b.pts
        k = st["k"]
        if k < len(plan) and b.pts - st["t0"] >= plan[k][0] * S:
            fired.append(now())
            until = time.monotonic() + plan[k][1] / 1000.0
            while time.monotonic() < until:
                pass
            st["k"] += 1
        # No Python on the writer thread once the plan is done (the GIL would be a stall of the harness's own).
        return Gst.PadProbeReturn.REMOVE if st["k"] >= len(plan) else Gst.PadProbeReturn.OK

    pad.add_probe(Gst.PadProbeType.BUFFER, probe)


def stall_metrics(raw, fired, plan, secs):
    """From the render lateness posts (t s, ms): before the first stall, each stall's growth (the median 1.5-4 s after
    it less 0.2-3 s before), the peak, the end (the last 10 s), when it came within 5 ms of the end for good."""
    def med(lo, hi):
        v = sorted(x for t, x in raw if lo <= t <= hi)
        return v[len(v) // 2] if v else None
    growth = []
    for k, f in enumerate(fired):
        nxt = fired[k + 1] if k + 1 < len(fired) else secs
        b, a = med(f - 3.0, f - 0.2), med(f + 1.5, min(f + 4.0, nxt - 0.2))
        growth.append(round(a - b, 1) if a is not None and b is not None else None)
    tail = [x for t, x in raw if secs - 10 <= t <= secs]
    end = sum(tail) / len(tail) if tail else None
    reach = 0.0
    for t, x in raw:
        if t <= secs and end is not None and abs(x - end) > 5:
            reach = t
    peak = max((x for t, x in raw if t <= secs), default=None)
    return {"base": med(fired[0] - 4.0, fired[0] - 0.2) if fired else None, "growth": growth, "peak": peak,
            "end": end, "reach": reach, "recovery": reach - fired[-1] if fired else None}


def stall_predicted(m, plan, queue_ms=0):
    """The catch-up's own bound on the recovery: a window after the last stall, then what was in hand past the end at
    0.5 %; with an upstream-queue of queue_ms, a window more for each queue's worth (what waits before it is seen only
    as it drains)."""
    x = max(m["growth"][-1] or 0, (m["peak"] or 0) - (m["end"] or 0), 0.0)
    return WINDOW_S * (max(1, math.ceil(x / queue_ms)) if queue_ms else 1) + x / 1000 / RATE


def stall_ok(m, plan, holes, lost_frames, target, err, secs, cu_end, queue_ms=0):
    # A stall that fits in what the sink holds (the last stall's growth among it) adds nothing.
    grown = all(g is not None and -5 < g <= ms + MARGIN_MS + 40 + 20 for g, (_, ms) in zip(m["growth"], plan))
    return (not err and len(m["growth"]) == len(plan) and grown and holes <= len(plan) and 0 <= lost_frames <= 48
            and m["end"] is not None and m["end"] <= target and m["reach"] <= secs - 20
            and m["recovery"] <= 1.2 * stall_predicted(m, plan, queue_ms) and cu_end != "catching-up")


def describe_stall(m, plan, holes, hole_ms, lost_frames, removed, refills, queue_ms=0):
    return (f"stalls {[ms for _, ms in plan]} ms at {[round(f, 1) for f in m['fired']]} s: {holes} holes "
            f"({hole_ms:.0f} ms), lost {lost_frames / 48:.2f} ms, {refills} refills; render lateness "
            f"{m['base']:.0f} ms before, grew {m['growth']} ms a stall, peak {m['peak']:.0f}, end {m['end']:.0f} ms, "
            f"back {m['recovery']:.0f} s after the last stall (the window and 0.5 % bound it at "
            f"{stall_predicted(m, plan, queue_ms):.0f} s); removed {removed:.0f} ms")


STALL_TABLE = []
if "stalls" in PARTS:
    print(f"\n--- writer stalls: {STALL_AT_S} s, 80-120 ms each, a 30 ms feed, {STALL_SECS} s, the test sink ---")
    for _dec in (False, True):
        for _seed in _STALL_SEEDS:
            _plan = stall_plan(_seed)
            _tail = tail_for(DEC_TAIL) if _dec else _c39
            _n = STALL_SECS * 100
            _fired = []

            def _setup(p, clk, t0, _plan=_plan, _fired=_fired, _dec=_dec):
                stall_probe(p, _dec, _plan, _fired, lambda: (clk.get_time() - (t0[0] or 0)) / S)

            wait_quiet()
            _l0 = os.getloadavg()[0]
            _sk, _st, _lv, _err = run(SRC + _tail, STALL_SECS + DRAIN_S, feed=late_feeder([30.0] * _n, eos=True),
                                      setup=_setup)
            _took, _made = LAST_ASRC.get("in-frames", 0), LAST_ASRC.get("out-frames", 0)
            _lost = (_n * BUF - _took) + max(0, _made - _sk["sounded-frames"])
            _h, _hf = holes_from(_lv, _sk, START_S)
            _raw = [(t, s.get("render-lateness-ns", 0) / MS) for t, s in _st if s.get("render-lateness-ns", 0)]
            _m = stall_metrics(_raw, _fired, _plan, STALL_SECS)
            _m["fired"] = _fired
            _cu = _st[-1][1].get("catch-up-state", "none") if _st else "none"
            _rm = (_st[-1][1].get("catch-up-removed-ns", 0) / MS) if _st else 0
            _rf = _st[-1][1].get("margin-refills", 0) if _st else 0
            _what = "decoder" if _dec else "302M"
            STALL_TABLE.append(("test", _what, _seed, _m, _h, _hf / 48, _lost / 48, _rm))
            _q = DECQ_MS if _dec else 0
            _ok = _m["base"] is not None and stall_ok(_m, _plan, _h, _lost, TARGET_MAX, _err, STALL_SECS, _cu, _q)
            check(f"{_what} writer stalls seed {_seed} (test sink, load {_l0:.1f}/{os.getloadavg()[0]:.1f}): "
                  f"{describe_stall(_m, _plan, _h, _hf / 48, _lost, _rm, _rf, _q) if _m['base'] is not None else _m}; "
                  f"target at most {TARGET_MAX} ms{', errors ' + str(_err) if _err else ''}", _ok)

# --- flushes with the catch-up on (B-249 fix round 4; review 4's x_edge.py shapes) --------------------------------
# devstall: the test device stops 3 s (mrasrc's own flushes); flush: one from outq's src pad; ready: outq held 0.6 s,
# READY and back (READY empties outq), a 1.5 s input gap. The catch-up must see each (the probe's EVENT_FLUSH).
# gap (c40, D1): a 1.5 s input gap alone; the reading after it must not keep the gap. flush-held (c40, D3): outq held
# 0.6 s, then the flush into the sink below it, so what outq holds outlives the flush and must be played out.
FLUSH_SECS = {"devstall": 300, "flush": 150, "ready": 260, "ready-gap": 100, "gap": 150, "flush-held": 330}
_FLUSH_PROFILES = [v for v in os.environ.get("MR_302M_FLUSH_PROFILES",
                                             "devstall,flush,ready,ready-gap,gap,flush-held").split(",")
                   if v]
_FLUSH_SEEDS = [int(v) for v in os.environ.get("MR_302M_FLUSH_SEEDS", "7,8,9").split(",") if v]


def flush_plan(name, seed):
    """(the event's clock s, the feed's lateness ms)."""
    rng = random.Random(seed * 53)
    at = round(rng.uniform(25, 35) if name.startswith("ready") else rng.uniform(70, 90), 1)
    return at, rng.choice((70.0, 80.0, 90.0))


def gap_feeder(late, pause):
    """appsrc as late_feeder, `late` ms each buffer, holding while `pause` is set; after a hold (or READY: a new base
    time) the PTS goes on from the clock's running time, as a live source's."""
    def feed(p, clk, stop):
        src, i, nxt = p.get_by_name("src"), 0, None
        while not stop.is_set():
            base = p.get_base_time()
            if pause.is_set() or base == 0:
                nxt = None
                time.sleep(0.005)
                continue
            if nxt is None:
                nxt = max(0, clk.get_time() - base)
            Gst.Clock.id_wait(clk.new_single_shot_id(base + nxt + int(late * MS)))
            if stop.is_set() or pause.is_set() or p.get_base_time() != base:
                nxt = None
                continue
            b = Gst.Buffer.new_wrapped(_TONE[i % len(_TONE)])
            b.pts, b.duration = nxt, 10 * MS
            src.emit("push-buffer", b)
            i += 1
            nxt += 10 * MS
    return feed


def flush_run(name, seed):
    at, late = flush_plan(name, seed)
    secs = FLUSH_SECS[name]
    pause, marks = threading.Event(), {}

    def act(p, clk, t0):
        def wait_s(t):
            while t0[0] is None:
                time.sleep(0.01)
            Gst.Clock.id_wait(clk.new_single_shot_id(t0[0] + int(t * S)))

        def go():
            wait_s(at)
            outq = p.get_by_name("outq")
            if name == "devstall":
                p.get_by_name("sink").set_property("stall-ms", 3000)
                marks["own"] = at + 3 + 5
            elif name in ("flush", "flush-held"):
                hold = None
                if name == "flush-held":
                    hold = outq.get_static_pad("src").add_probe(Gst.PadProbeType.BLOCK | Gst.PadProbeType.BUFFER,
                                                                lambda *_: Gst.PadProbeReturn.OK)
                    time.sleep(0.6)
                    marks["held"] = outq.get_property("current-level-time") / MS

                def once(pad, _info):
                    seg = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
                    pad.push_event(Gst.Event.new_flush_start())
                    pad.push_event(Gst.Event.new_flush_stop(False))
                    if seg:
                        pad.push_event(seg)
                    return Gst.PadProbeReturn.REMOVE
                outq.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, once)
                if hold is not None:
                    outq.get_static_pad("src").remove_probe(hold)
                marks["own"] = at + 3
            elif name == "gap":
                pause.set()
                time.sleep(1.5)
                pause.clear()
                marks["own"] = at + 1.5 + 5
            else:
                pad = outq.get_static_pad("src")
                pid = pad.add_probe(Gst.PadProbeType.BLOCK | Gst.PadProbeType.BUFFER, lambda *_: Gst.PadProbeReturn.OK)
                time.sleep(0.6)
                marks["held"] = outq.get_property("current-level-time") / MS
                pause.set()
                old = p.get_base_time()
                p.set_state(Gst.State.READY)
                pad.remove_probe(pid)
                p.get_state(5 * S)
                p.set_state(Gst.State.PLAYING)
                while p.get_base_time() in (0, old):   # the feed goes on from the new base time's running time
                    time.sleep(0.005)
                marks["back"] = (clk.get_time() - t0[0]) / S
                pause.clear()
                marks["own"] = marks["back"] + 5
                if name == "ready-gap":
                    wait_s(at + 20)
                    pause.set()
                    time.sleep(1.5)
                    pause.clear()
                    marks["own"] = at + 20 + 1.5 + 5
        threading.Thread(target=go, daemon=True).start()

    wait_quiet()
    l0 = os.getloadavg()[0]
    sk, st, lv, err = run(SRC + _c39, secs, feed=gap_feeder(late, pause), setup=act)
    own = marks.get("own", secs)
    h, _ = holes_from(lv, sk, own)
    ref = [s.get("margin-refills", 0) for t, s in st if t >= own]
    after = [s.get("catch-up-state") for t, s in st if (at + 5 if name == "devstall" else at + 1) <= t <= at + 50]
    before = [s.get("catch-up-state") for t, s in st if at - 6 <= t < at]
    tail = [s.get("render-lateness-ns", 0) / MS for t, s in st if t >= secs - 10 and s.get("render-lateness-ns", 0)]
    pre = [s.get("render-lateness-ns", 0) / MS for t, s in st if at - 10 <= t < at and s.get("render-lateness-ns", 0)]
    last = st[-1][1] if st else {}
    trace, nxt = [], 0.0
    for t, x in st:
        if t >= nxt:
            nxt = t + 10
            trace.append((round(t), round(x.get("render-lateness-ns", 0) / MS, 1), x.get("catch-up-state"),
                          round(x.get("catch-up-excess-ns", 0) / MS, 1), round(x.get("catch-up-removed-ns", 0) / MS, 1),
                          x.get("margin-refills", 0), round(x.get("device-ppb", 0) / 1000, 1)))
    return {"name": name, "seed": seed, "at": at, "trace": trace, "late": late, "own": own, "holes": h, "holes_all": sk["holes"],
            "refills_after": (ref[-1] - ref[0]) if ref else -1, "refills": last.get("margin-refills", 0),
            "after": after, "before": before, "end": sum(tail) / len(tail) if tail else None, "err": err,
            "pre": sum(pre) / len(pre) if pre else None,
            "stalls": last.get("device-stalls", 0), "cu_end": last.get("catch-up-state", "none"),
            "removed": last.get("catch-up-removed-ns", 0) / MS, "held": marks.get("held"), "back": marks.get("back"),
            "gaps": max((b - a for (a, _), (b, _) in zip(st, st[1:])), default=0),
            "load": (l0, os.getloadavg()[0]), "posts": len(st)}


FLUSH_TABLE = []
if "flushes" in PARTS:
    print(f"\n--- flushes with the catch-up on: {_FLUSH_PROFILES}, seeds {_FLUSH_SEEDS}, the test sink ---")
    for _name in _FLUSH_PROFILES:
        for _seed in _FLUSH_SEEDS:
            _r = flush_run(_name, _seed)
            if _r["err"] and max(_r["load"]) >= LOAD_MAX:
                _r = flush_run(_name, _seed)
            FLUSH_TABLE.append(_r)
            # The target as the catch-up's (the feed, the device, two segments, the margin, a buffer) and the 20 ms
            # under which it does not start; below the feed, the device and the margin the margin was played out.
            _lo, _hi = _r["late"] + 40 + MARGIN_MS, _r["late"] + 40 + 20 + MARGIN_MS + 10 + 20
            # An input gap resets nothing: the catch-up's window goes on across it.
            _watch = _name == "gap" or (bool(_r["after"]) and all(a == "watching" for a in _r["after"]))
            # Past the first window before the event, so `watching` after it is a reset.
            _past = bool(_r["before"]) and all(b != "watching" for b in _r["before"]) \
                if _name in ("devstall", "flush", "flush-held") \
                else True
            # A stats post at least every 8 s: the feed never waited out a stale base time.
            _stall_ok = _r["stalls"] == (1 if _name == "devstall" else 0) and _r["gaps"] < 8
            # Every end held (c40): the creep after a flush from outq's src pad was the sink clock's step fit as a rate
            # (D3); after an input gap alone also at most 20 ms over the reading before it (D1).
            _held = True
            _at_target = not _held or (_r["end"] is not None and _lo <= _r["end"] <= _hi)
            if _name == "gap":
                _at_target = _at_target and _r["pre"] is not None and _r["end"] <= _r["pre"] + 20
            _ok = (not _r["err"] and _r["holes"] == 0 and _r["refills_after"] == 0 and _watch and _past and _stall_ok
                   and _at_target and (not _held or _r["cu_end"] != "catching-up"))
            _ev = {"devstall": "a 3 s device stall", "flush": "a flush into the sink",
                   "flush-held": f"outq held {_r['held'] or 0:.0f} ms, then a flush into the sink below it",
                   "ready": f"outq held {_r['held'] or 0:.0f} ms, READY and back (playing again "
                            f"{(_r['back'] or 0) - _r['at']:.1f} s on)",
                   "ready-gap": f"outq held {_r['held'] or 0:.0f} ms, READY and back, a 1.5 s input gap 20 s on",
                   "gap": f"a 1.5 s input gap, the reading {(_r['pre'] or 0):.1f} ms before it"}[_name]
            _end = f"{_r['end']:.1f}" if _r["end"] is not None else "none"
            check(f"{_name} seed {_seed} ({_ev} at {_r['at']} s, a {_r['late']:.0f} ms feed, load {_r['load'][0]:.1f}/"
                  f"{_r['load'][1]:.1f}): {_r['holes']} holes and {_r['refills_after']} refills after {_r['own']:.1f} s "
                  f"({_r['holes_all']} holes, {_r['refills']} refills in all); catch-up after it {sorted(set(_r['after']))}, "
                  f"before {sorted(set(_r['before']))}; device-stalls {_r['stalls']}; posts at most {_r['gaps']:.1f} s "
                  f"apart; end {_end} ms (target {_lo:.0f}-{_hi:.0f}{'' if _held else ', not held'}); removed "
                  f"{_r['removed']:.1f} ms ({_r['cu_end']} at the end)"
                  f"{', errors ' + str(_r['err']) if _r['err'] else ''}", _ok)
            print(f"   each 10 s (s, render lateness ms, catch-up state, excess ms, removed ms, refills, device ppm): "
                  f"{_r['trace']}")
    print("\n--- the flush table: profile x seed x holes after x refills after x end x removed ---")
    for _r in FLUSH_TABLE:
        print(f"  {_r['name']:9} seed {_r['seed']}: holes {_r['holes']}, refills {_r['refills_after']}, end "
              f"{(_r['end'] or 0):.1f} ms (feed {_r['late']:.0f}), removed {_r['removed']:.1f} ms, device-stalls "
              f"{_r['stalls']}")

print("\n--- the table: profile x runs x holes after the start x lost ---")
print(f"{'tail':5} {'profile':7} {'runs':>4} {'holes':>18} {'lost ms':>30}")
for _tail in ("c39", "c38", "v101"):
    for _name in PROFILES:
        _rs = [r for t, r in TABLE if t == _tail and r["name"] == _name]
        if _rs:
            print(f"{_tail:5} {_name:7} {len(_rs):>4} {str([r['holes'] for r in _rs]):>18} "
                  f"{str([round(r['lost'] / 48, 1) for r in _rs]):>30}")
if CU_TABLE:
    print("\n--- the catch-up table: profile x seed x holes x lost x render lateness before -> after (by) x removed ---")
    for _name, _seed, _r, _x in CU_TABLE:
        if _name == "field-long":
            print(f"  {_name:10} seed {_seed}: holes {_r['holes']} (none: {_x['holes']}), lost {_r['lost'] / 48:.2f} ms "
                  f"(none: {_x['lost'] / 48:.2f}), removed {_r['removed']:.0f} ms")
        else:
            _lv = f"{_x[0]:.0f} -> {_x[1]:.0f} ms (by {_x[2]:.0f} s)" if _x else "none"
            print(f"  {_name:10} seed {_seed}: holes {_r['holes']}, lost {_r['lost'] / 48:.2f} ms, {_lv}, removed "
                  f"{_r['removed']:.0f} ms")



def print_stall_table(rows):
    print("\n--- the stall table: sink x tail x seed x holes x lost x lateness before -> peak -> end x growth a "
          "stall x back after the last stall ---")
    for sink, what, seed, m, h, hms, lost, rm in rows:
        print(f"  {sink:5} {what:7} seed {seed}: holes {h} ({hms:.0f} ms), lost {lost:.2f} ms, "
              f"{m['base'] or 0:.0f} -> {m['peak'] or 0:.0f} -> {m['end'] or 0:.0f} ms, growth {m['growth']} ms, "
              f"back {m['recovery'] or 0:.0f} s, removed {rm:.0f} ms")


if STALL_TABLE:
    print_stall_table(STALL_TABLE)

# --- a real pulsesink (MR_302M_PULSE_SINK) ----------------------------------------------------------------------
_PULSE = os.environ.get("MR_302M_PULSE_SINK", "")
_PULSE_SECS = int(os.environ.get("MR_302M_PULSE_SECS", "600"))
# The monitor's latency-time: PipeWire runs the graph at its clients' smallest latency (10 ms: a 512-frame
# quantum on the dev Pi; 40 ms: 1024, as with no monitor).
_PULSE_MON_US = int(os.environ.get("MR_302M_PULSE_MON_US", "10000"))


class MonitorCount:
    """pulsesrc on `<sink>.monitor` into an appsink: frames that sound and all-zero runs of 1 ms or more between."""

    def __init__(self, sink):
        self.p = Gst.parse_launch(f"pulsesrc device={sink}.monitor buffer-time=200000 latency-time={_PULSE_MON_US} ! "
                                  f"audio/x-raw,format=F32LE,rate=48000,channels=2 ! appsink name=a emit-signals=true sync=false")
        self.sounded = self.holes = self.hole_frames = self.run = 0
        self.seen = False
        self.last_sound = None
        self.hole_at = []
        self.t0 = time.monotonic()
        self.p.get_by_name("a").connect("new-sample", self._sample)

    def _sample(self, sink):
        s = sink.emit("pull-sample")
        b = s.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        if ok:
            data = memoryview(m.data).cast("f")
            for k in range(0, len(data) - 1, 2):
                if data[k] == 0.0 and data[k + 1] == 0.0:
                    self.run += 1
                    continue
                if self.seen and self.run >= 48:
                    self.holes += 1
                    self.hole_frames += self.run
                    self.hole_at.append(time.monotonic() - self.t0)
                self.seen = True
                self.sounded += 1
                self.run = 0
                self.last_sound = time.monotonic()
            b.unmap(m)
        return Gst.FlowReturn.OK

    def start(self):
        self.p.set_state(Gst.State.PLAYING)

    def stop(self):
        self.p.set_state(Gst.State.NULL)


EDGE_STEPS = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]
_EDGE_HOLD = int(os.environ.get("MR_302M_PULSE_EDGE_HOLD", "30"))
_EDGE_SEEDS = [int(v) for v in os.environ.get("MR_302M_PULSE_EDGE_SEEDS", "7,8,9").split(",") if v]
_PULSE_PROFILES = [v for v in os.environ.get("MR_302M_PULSE_PROFILES",
                                             "edge,dec-edge,flush,field,rising,late,spike,stalls,dec-stalls,"
                                             "outage,dec-outage").split(",") if v]
FLUSH_AT_S = (10, 20)                      # the flush profile: two flushes into the sink, 30 s at 30 ms
REFILL_MAX_MS = 3000                       # mrts::ASRC_SINK_REFILL_MAX_MS
# dec-edge: the Audio Decoder's sink end, 20 steps of 3 s each 2 ms ahead of the clock, a 10-buffer burst before each.
_DEC_SEEDS = [int(v) for v in os.environ.get("MR_302M_PULSE_DEC_SEEDS", "7,8").split(",") if v]
DEC_STEPS, DEC_HOLD, DEC_BURST = [2] * 20, 3, 10
# The writer stalls on a server: as on the test sink, longer (its start may come up 0.3-2 s late on top).
_PULSE_STALL_SECS = int(os.environ.get("MR_302M_PULSE_STALL_SECS", "600"))
# The Audio Decoder's longer: what waits past decq comes back a window a queue's worth (B-249 fix round 3).
_PULSE_DEC_STALL_SECS = int(os.environ.get("MR_302M_PULSE_DEC_STALL_SECS", "900"))
# An outage: the feed stops for each gap at OUTAGE_AT_S, then comes that much later; OUTAGE_FEED_S of content.
OUTAGE_AT_S, OUTAGE_FEED_S = 10, 22
_OUTAGE_GAPS = [float(v) for v in os.environ.get("MR_302M_PULSE_OUTAGES", "2.5,6.5,10").split(",") if v]
_PULSESINK = Gst.ElementFactory.find("pulsesink")
PULSESINK_VERSION = _PULSESINK.get_plugin().get_version() if _PULSESINK else ""


def pulsesink_moves_segdone():
    """1.28 and later set the ring's segment count from the server's read index (pulsesink.c); 1.22 does not."""
    try:
        major, minor = (int(v) for v in PULSESINK_VERSION.split(".")[:2])
    except ValueError:
        return False
    return (major, minor) >= (1, 28)


def outage_allowed_ms(gap_s):
    """What an outage may lose: on a pulsesink whose segment count is still, the refill's silence must cross the whole
    gap (plus the guard and margin) in writes of at most the cap, and the buffer after each capped one is behind the
    server's read index: one 10 ms buffer a cap crossed. Where the count follows the read index, nothing."""
    if pulsesink_moves_segdone():
        return 1.0
    return 10.0 * max(0, -(-(gap_s * 1000 + 100) // REFILL_MAX_MS) - 1) + 1.0


def edge_steps(seed):
    """The edge profile's steps (ms ahead of the device clock), each `_EDGE_HOLD` s: 0-30 in 3 ms steps, shuffled."""
    steps = EDGE_STEPS[:]
    random.Random(seed).shuffle(steps)
    return steps


def pulse_run(name, secs, seed=7, gap=0.0):
    """The module's sink end into a real pulsesink, its monitor counting. `edge`: 10 s at 30 ms, then each step
    x of edge_steps(seed): the feed's lateness becomes the render lateness less x (never earlier than it was), so
    each write lands x ms ahead of the device clock, inside the server's read-ahead for small x (blocking 1).
    `dec-edge`: the Audio Decoder's sink end on DEC_STEPS, the DEC_BURST buffers before each step pushed at once."""
    dec = name in ("dec-edge", "dec-stalls", "dec-outage")
    edge, flush = name in ("edge", "dec-edge"), name == "flush"
    stalls, outage = name in ("stalls", "dec-stalls"), name in ("outage", "dec-outage")
    steps = DEC_STEPS[:] if dec else (edge_steps(seed) if edge else [])
    hold = DEC_HOLD if dec else _EDGE_HOLD
    if edge:
        secs = 10 + hold * len(steps)
    if flush:
        secs = 30
    if name in CATCH:
        secs = PULSE_CATCH_SECS[name]
    if stalls:
        secs = _PULSE_DEC_STALL_SECS if dec else _PULSE_STALL_SECS
    if outage:
        secs = OUTAGE_FEED_S
    n = secs * 100
    gen = CATCH[name][0] if name in CATCH else PROFILES.get(name)
    if outage:   # the feed stops `gap` s at OUTAGE_AT_S, then comes that much later
        late = [30.0 + (gap * 1000 if i >= OUTAGE_AT_S * 100 else 0) for i in range(n)]
    else:
        late = [30.0] * n if (flush or stalls) else (gen(n, seed) if not edge else None)
    state = {"late": 30.0, "rl": None, "step": -1, "set": []}

    def edge_late(i):
        k = (i - 1000) // (hold * 100) if i >= 1000 else -1
        if k != state["step"]:
            state["step"] = k
            if k >= 0 and state["rl"] is not None:
                state["late"] = max(state["late"], state["rl"] - steps[k] - random.Random(seed * 31 + k).uniform(0, 1))
            state["set"].append(round(state["late"], 1))
        nb = 1000 + (k + 1) * hold * 100       # the next step's first buffer
        if dec and k + 1 < len(steps) and nb - DEC_BURST <= i < nb:
            return state["late"] - (i - (nb - DEC_BURST)) * 10   # the burst: pushed with its first buffer
        return state["late"]

    import gc
    gc.disable()   # as run(): a collection pause would stall the probes' threads
    mon = MonitorCount(_PULSE)
    mon.start()
    time.sleep(1.0)
    p = Gst.parse_launch(SRC + tail_for(DEC_TAIL if dec else MODULE_TAIL, sink=f"pulsesink name=sink device={_PULSE}",
                                        device=""))
    stop = threading.Event()
    flushed, fired = [], []
    plan = stall_plan(seed) if stalls else []
    if stalls:
        stall_probe(p, dec, plan, fired, lambda: time.monotonic() - mon.t0 - 1.0)
    if flush:
        # As mrasrc's device flush does, from the queue's thread: FLUSH_START, FLUSH_STOP and the segment into the
        # sink, then the buffer that was due (minor 3: pulsesink's next write after a flush).
        due = [k * S for k in FLUSH_AT_S]

        def flusher(pad, info):
            b = info.get_buffer()
            if due and b.pts != Gst.CLOCK_TIME_NONE and b.pts >= due[0]:
                due.pop(0)
                seg = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
                pad.push_event(Gst.Event.new_flush_start())
                pad.push_event(Gst.Event.new_flush_stop(False))
                if seg:
                    pad.push_event(seg)
                flushed.append(time.monotonic() - mon.t0)
            return Gst.PadProbeReturn.OK

        p.get_by_name("outq").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, flusher)
    p.set_state(Gst.State.PLAYING)
    # Each refill's silence as it reaches the sink (minor 3: each, not a mean): a PTS-less write less its buffer.
    sil_max = [0.0]

    def sizes(_pad, info):
        b = info.get_buffer()
        if b is not None and b.pts == Gst.CLOCK_TIME_NONE:
            sil_max[0] = max(sil_max[0], (b.get_size() // 8 - BUF * 1.006) / 48)
        return Gst.PadProbeReturn.OK

    if flush or outage:
        p.get_by_name("sink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, sizes)
    feed = late_feeder([edge_late] * n if edge else late, eos=True)
    th = threading.Thread(target=feed, args=(p, p.get_pipeline_clock(), stop), daemon=True)
    th.start()
    bus, t0, stats, errors = p.get_bus(), mon.t0, [], []
    # Until the feed's last push has played out: its render lateness and 1.5 s more after it (the drain at least).
    ended, played, trace = None, None, []
    while ended is None or time.monotonic() - ended < max(DRAIN_S, (state["rl"] or 0) / 1000 + 1.5):
        if ended is None and not th.is_alive():
            ended = time.monotonic()
        if played is None and p.get_base_time():   # the feed runs from here (a start can take minutes, rarely)
            played = time.monotonic() - t0 - 1.0
        m = bus.timed_pop(100 * Gst.MSECOND)
        if m is None:
            continue
        if m.type == Gst.MessageType.ERROR:
            errors.append(m.parse_error()[0].message)
            break
        if m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-stats":
            st = sdict(m.get_structure())
            stats.append((time.monotonic() - t0, st))
            if stalls and (not trace or stats[-1][0] - 1.0 - trace[-1][0] >= 10):
                q = p.get_by_name("decq") if dec else p.get_by_name("outq")
                trace.append((round(stats[-1][0] - 1.0), round(st.get("render-lateness-ns", 0) / MS),
                              st.get("catch-up-state", "-"), round(st.get("catch-up-excess-ns", 0) / MS),
                              round(st.get("catch-up-removed-ns", 0) / MS),
                              round(q.get_property("current-level-time") / MS) if q else -1))
            if st.get("render-lateness-ns", 0):
                state["rl"] = st["render-lateness-ns"] / MS
    stop.set()
    th.join(2)
    time.sleep(1.0)
    final = sdict(p.get_by_name("asrc" if dec else "outasrc").get_property("stats"))
    p.set_state(Gst.State.NULL)
    time.sleep(0.5)
    mon.stop()
    gc.enable()
    start_s = 1.0 + START_S + 1.0              # the monitor's second before the pipeline, then the start window
    if edge:
        t_max = 0.0
    else:
        imax = next(i for i, l in enumerate(late) if l >= max(late))
        t_max = 1.0 + imax / 100 + late[imax] / 1000 + 1.0
    # Each hole after the start against a refill seen within 3 s of it (stats post every 2 s): one refill each.
    refill_at, prev, refill_ms = [], None, []
    for t, st in stats:
        r, sil = st.get("margin-refills", 0), st.get("margin-silence-ns", 0) / MS
        if prev is not None and r > prev[0]:
            refill_at += [t] * (r - prev[0])
            refill_ms.append(round((sil - prev[1]) / (r - prev[0]), 1))
        prev = (r, sil)
    holes = [t for t in mon.hole_at if t > start_s]
    free = [t for t in refill_at if t > start_s - 3]
    orphans = []
    for h in holes:
        m = next((r for r in free if abs(r - h) <= 3.0), None)
        if m is None:
            orphans.append(round(h, 1))
        else:
            free.remove(m)
    after = [t for t in holes if t > (t_max if name == "rising" else start_s) + 1.5]
    lat = [s.get("render-lateness-ns", 0) / MS for t, s in stats if t > 20 and s.get("render-lateness-ns", 0)]
    last = stats[-1][1] if stats else {}
    fed = n * BUF
    # What mrasrc made of what it took (its EOS post: exact), the device term's ratio and the catch-up in it; lost is
    # what it never took and what it made that was not heard (its 32-frame tail leaves after the post: heard too).
    took, want = final.get("in-frames", 0), final.get("out-frames", 0)
    ppb = (want / max(1, took) - 1) * 1e9
    return {"holes": mon.holes, "hole_ms": mon.hole_frames / 48, "after": after, "orphans": orphans, "fed": fed,
            "sounded": mon.sounded, "want": want, "lost": (fed - took) + (want - mon.sounded), "ppb": ppb, "lat": lat,
            "refills": last.get("margin-refills", 0), "guard": last.get("margin-guard-ns", 0) / MS, "err": errors,
            "t_max": t_max, "steps": steps, "set": state["set"][1:], "holes_after_start": len(holes),
            "flushed": [round(t, 1) for t in flushed], "refill_ms": refill_ms, "secs": secs,
            "raw": [(t - 1.0, s.get("render-lateness-ns", 0) / MS) for t, s in stats if s.get("render-lateness-ns", 0)],
            "begins": [round(t - 1.0, 1) for (_, a), (t, b) in zip(stats, stats[1:])
                       if b.get("catch-up-state") == "catching-up" and a.get("catch-up-state") != "catching-up"],
            "removed": final.get("catch-up-removed-ns", 0) / MS, "cu_end": final.get("catch-up-state", "none"),
            "last_sound": mon.last_sound - mon.t0 if mon.last_sound else 0, "end": time.monotonic() - t0,
            "plan": plan, "fired": fired, "sil_max": sil_max[0], "played": played or 0.0, "trace": trace,
            "hole_times": [round(t - 1.0, 1) for t in holes]}


# The pulse pass: every frame fed taken, and the frames heard within the 1 ms allowance (the resampler's 32 frames) of
# what mrasrc made of them (the device term's ratio and the catch-up's).
def pulse_lost_ok(r):
    return abs(r["lost"]) <= 48


PULSE_TABLE = []
PULSE_TARGET_MAX = 30 + 40 + MARGIN_MS + 10 + 30
if _PULSE and "pulse" in PARTS:
    print(f"\n(pulsesink {PULSESINK_VERSION}: its segment count "
          f"{'follows the read index' if pulsesink_moves_segdone() else 'does not move'})")
    for _name in _PULSE_PROFILES:
        _outage = _name in ("outage", "dec-outage")
        for _seed in (_EDGE_SEEDS if _name == "edge" else _DEC_SEEDS if _name == "dec-edge" else _STALL_SEEDS
                      if _name in ("stalls", "dec-stalls") else _OUTAGE_GAPS if _outage else [7]):
            _secs = (10 + _EDGE_HOLD * len(EDGE_STEPS) if _name == "edge" else 10 + DEC_HOLD * len(DEC_STEPS)
                     if _name == "dec-edge" else 30 if _name == "flush" else PULSE_CATCH_SECS[_name] if _name in CATCH
                     else _PULSE_STALL_SECS if _name == "stalls" else _PULSE_DEC_STALL_SECS if _name == "dec-stalls"
                     else OUTAGE_FEED_S if _outage
                     else _PULSE_SECS)
            _label = (f" seed {_seed}" if _name in ("edge", "dec-edge", "stalls", "dec-stalls") else
                      f" gap {_seed} s" if _outage else "")
            print(f"\n--- a real pulsesink on {_PULSE}: the {_name} profile{_label}, {_secs} s, holes on its "
                  f"monitor ---")
            wait_quiet()
            _r = pulse_run(_name, _PULSE_SECS, 7 if _outage else _seed, gap=_seed if _outage else 0.0)
            PULSE_TABLE.append((_name, _seed, _r))
            _lat = f"{min(_r['lat']):.0f}..{max(_r['lat']):.0f}" if _r["lat"] else "none"
            _what = (f"{_r['holes']} holes ({_r['hole_ms']:.0f} ms) on the monitor, {_r['holes_after_start']} after the "
                     f"start, {len(_r['orphans'])} with no refill {_r['orphans']}; fed {_r['fed']}, sounded "
                     f"{_r['sounded']}, mrasrc's ratio {_r['ppb'] / 1000:+.2f} ppm made {_r['want']:.0f}: lost "
                     f"{_r['lost'] / 48:.2f} ms; render lateness {_lat} ms; {_r['refills']} refills; guard "
                     f"{_r['guard']:.1f} ms; errors {_r['err']}")
            if _name in ("stalls", "dec-stalls"):
                _end = _r["played"] + _r["secs"]
                _m = stall_metrics(_r["raw"], _r["fired"], _r["plan"], _end)
                _m["fired"] = _r["fired"]
                _what_t = "decoder" if _name == "dec-stalls" else "302M"
                STALL_TABLE.append(("pulse", _what_t, _seed, _m, _r["holes_after_start"], _r["hole_ms"],
                                    _r["lost"] / 48, _r["removed"]))
                # The decoder's backlog past decq (here in appsrc) is seen as decq drains: a window a queue's worth.
                _q = DECQ_MS if _name == "dec-stalls" else 0
                _ok = (_m["base"] is not None and not _r["orphans"] and
                       stall_ok(_m, _r["plan"], _r["holes_after_start"], abs(_r["lost"]), PULSE_TARGET_MAX, _r["err"],
                                _end, _r["cu_end"], _q))
                _d = (describe_stall(_m, _r["plan"], _r["holes_after_start"], _r["hole_ms"], _r["lost"], _r["removed"],
                                     _r["refills"], _q) if _m["base"] is not None else str(_m))
                check(f"pulse {_what_t} writer stalls seed {_seed} (playing from {_r['played']:.1f} s): {_d}; holes at "
                      f"{_r['hole_times']} s, {len(_r['orphans'])} with no refill; target at most {PULSE_TARGET_MAX} ms; "
                      f"errors {_r['err']}", _ok)
                print(f"   each 10 s (s, render lateness ms, catch-up state, excess ms, removed ms, queue ms): "
                      f"{_r['trace']}")
            elif _outage:
                _allow = outage_allowed_ms(_seed)
                check(f"pulse {_name} gap {_seed} s: {_what}; refills of at most {_r['sil_max']:.0f} ms each (cap "
                      f"{REFILL_MAX_MS}); lost at most {_allow:.0f} ms on pulsesink {PULSESINK_VERSION}; sound until "
                      f"{_r['last_sound']:.1f} s (the feed's end plays from {OUTAGE_FEED_S + _seed:.1f})",
                      not _r["err"] and _r["holes_after_start"] <= 1 and _r["sil_max"] <= REFILL_MAX_MS + 1
                      and -48 <= _r["lost"] <= _allow * 48 and _r["last_sound"] >= OUTAGE_FEED_S + _seed)
            elif _name in ("edge", "dec-edge"):
                check(f"pulse {_name} seed {_seed} (steps {_r['steps']} ms ahead, lateness set {_r['set']}): {_what}",
                      not _r["err"] and not _r["orphans"] and pulse_lost_ok(_r))
            elif _name == "flush":
                # A flush discards what the server held (pa_stream_flush): at most 200 ms each; one hole each, sound
                # to the end. The silence runs from where the sink writes: frame 0 on a pulsesink whose segdone is
                # still (1.22), so the stream's run, crossed by refills of at most the cap (one a 3 s, plus one).
                _most = 1 + sum(-(-t * 1000 // REFILL_MAX_MS) + 1 for t in FLUSH_AT_S)
                check(f"pulse flush (flushed at {_r['flushed']} s): {_what}; refills of at most {_r['sil_max']:.0f} ms "
                      f"each as they reached the sink (cap {REFILL_MAX_MS}; {_r['refills']} of at most {_most}); sound "
                      f"until {_r['last_sound']:.1f} s of {_r['end']:.1f}",
                      not _r["err"] and len(_r["flushed"]) == len(FLUSH_AT_S) and not _r["orphans"]
                      and 1 + len(FLUSH_AT_S) <= _r["refills"] <= _most
                      and 0 < _r["sil_max"] <= REFILL_MAX_MS + 1
                      and _r["holes_after_start"] <= len(FLUSH_AT_S) and 0 <= _r["lost"] <= 48 + 9600 * len(FLUSH_AT_S)
                      and _r["last_sound"] >= _r["end"] - 5.0)   # the drain and teardown take 3-4 s
            elif _name in CATCH:
                # The catch-up on a real sink: no hole but the spike's (each with a refill), nothing lost, back to
                # the server's target (the feed, the guard's 40 ms, the margin, a buffer and the clock's steps).
                _rec = recovery(_r, {"late": 0.83, "spike": 11.4}[_name])
                _ok = not _r["err"] and not _r["orphans"] and pulse_lost_ok(_r) and _rec is not None
                _ok = _ok and _rec[1] <= PULSE_TARGET_MAX and len(_r["begins"]) >= 1
                if _name == "late":
                    _want = WINDOW_S + (_rec[0] - _rec[1]) / 1000 / RATE if _rec else 0
                    _ok = _ok and _r["holes_after_start"] == 0 and _rec[0] - _rec[1] >= 600 and \
                        abs(_rec[2] - _want) <= 0.2 * _want
                    _x = f"back by {_rec[2]:.0f} s, a window and 0.5 % imply {_want:.0f} s (+-20 %)" if _rec else ""
                else:
                    _ok = _ok and _r["holes_after_start"] <= 2
                    _x = "holes only at the spike"
                _lv = f"{_rec[0]:.0f} -> {_rec[1]:.0f} ms" if _rec else "none"
                check(f"pulse {_name}: {_what}; render lateness {_lv} (target at most {PULSE_TARGET_MAX}), catch-up "
                      f"from {_r['begins']} s, removed {_r['removed']:.0f} ms ({_r['cu_end']}); {_x}", _ok)
            else:
                check(f"pulse {_name}: {_what}; {len(_r['after'])} holes after "
                      f"{'the walk reached its max' if _name == 'rising' else 'the start'} "
                      f"{[round(t, 1) for t in _r['after']]} (max at {_r['t_max']:.1f} s); load {os.getloadavg()[0]:.1f}",
                      not _r["err"] and not _r["after"] and not _r["orphans"] and pulse_lost_ok(_r))
    print("\n--- the pulse table: profile x seed x holes after the start x refills x lost ---")
    for _name, _seed, _r in PULSE_TABLE:
        print(f"  {_name:10} {'gap' if _name in ('outage', 'dec-outage') else 'seed'} {_seed}: holes "
              f"{_r['holes_after_start']}, no refill {len(_r['orphans'])}, refills {_r['refills']}, lost "
              f"{_r['lost'] / 48:.2f} ms")
    if any(t[0] == "pulse" for t in STALL_TABLE):
        print_stall_table([t for t in STALL_TABLE if t[0] == "pulse"])
elif "pulse" in PARTS:
    print("\n(no MR_302M_PULSE_SINK: the real pulsesink runs skipped)")

# --- drift: an hour each way, a house-rate tone -----------------------------------------------------------------
# The input waits on the device (the element suite's long device case), so a sped-up clock's scheduling cannot
# starve the ring; the sink end as the module's, its ring 2 s.
DRIFT = ("mrasrc name=outasrc device-sink=sink margin-ms=60 ! volume name=vol volume=1.00 ! "
         "queue name=outq leaky=0 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0 ! "
         "mrtestaudiosink name=sink sync=false provide-clock=false buffer-time=2000000 latency-time=20000 "
         "ppm={ppm} device-ns=1000000000")


def paced_feeder(p, clk, stop):
    """appsrc (block=true): a tone stamped at house rate, as fast as the device takes it."""
    src, i = p.get_by_name("src"), 0
    while not stop.is_set():
        b = Gst.Buffer.new_wrapped(_TONE[i % len(_TONE)])
        b.pts, b.duration = i * 10 * MS, 10 * MS
        if src.emit("push-buffer", b) != Gst.FlowReturn.OK:
            return
        i += 1


_DRIFT = int(os.environ.get("MR_302M_DRIFT_SECS", "3660"))
_SPEED = int(os.environ.get("MR_302M_DRIFT_SPEED", "6"))
_PPMS = [int(v) for v in os.environ.get("MR_302M_DRIFT_PPM", "100,-100").split(",") if v] if "drift" in PARTS else []
for _ppm in _PPMS:
    print(f"\n--- drift: a house-rate tone into a device {_ppm:+d} ppm, {_DRIFT} s on a {_SPEED}x clock ---")
    wait_quiet()
    _sk, _st, _lv, _err = run(
        f"appsrc name=src format=time block=true max-bytes=65536 caps={CAPS} ! " + DRIFT.format(ppm=_ppm),
        _DRIFT, speed=_SPEED, feed=paced_feeder)
    _h, _ = holes_from(_lv, _sk, START_S)
    _base = next((c for t, c in _lv if t >= START_S), None) or {"underruns": 0}
    _post = [(t, s) for t, s in _st if t >= 120]
    _late = [s.get("render-lateness-ns", 0) / MS for t, s in _post]
    _last = _st[-1][1] if _st else {}
    _span = (max(_late) - min(_late)) if _late else -1
    _v = sorted(_late)
    _spread = (_v[-1 - len(_v) // 100] - _v[len(_v) // 100]) if _v else -1

    def _median(xs):
        xs = sorted(xs)
        return xs[len(xs) // 2] if xs else 0

    # Creep is the level moving: the median of the first and of the last 5 min apart. A lone timer read
    # preempted between the device clock and house time reads high once (max-min shows it, 4-11 ms seen under load: held to a loose 20 ms).
    _creep = abs(_median([v for (t, _), v in zip(_post, _late) if t < 420]) -
                 _median([v for (t, _), v in zip(_post, _late) if t > _DRIFT - 300]))
    _ref = [s.get("margin-refills", 0) for t, s in _post]
    check(f"{_ppm:+d} ppm: from 2 s no hole ({_h}), no underrun ({_sk['underruns'] - _base['underruns']}), "
          f"no error {_err}", not _err and _h == 0 and _sk["underruns"] == _base["underruns"])
    check(f"... no creep: the render lateness's median over its first and its last 5 min from 120 s {_creep:.2f} ms "
          f"apart, p1-p99 {_spread:.2f} ms (max-min {_span:.2f}, within 20) over {len(_late)} posts; uncorrected "
          f"{abs(_ppm) * _DRIFT / 1000:.0f} ms", len(_late) > 50 and _creep < 1 and 0 <= _spread < 2 and 0 <= _span < 20)
    check(f"... no refill after the start: margin-refills {_ref[0] if _ref else None} -> {_ref[-1] if _ref else None}",
          bool(_ref) and _ref[0] == _ref[-1])
    check(f"... the device term locked at {_last.get('device-ppb', 0) / 1000:+.2f} ppm ({_ppm:+d})",
          _last.get("state") == "locked" and abs(_last.get("device-ppb", 0) - _ppm * 1000) <= 1000)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_302m_late_feed_test.py")
    sys.exit(1)
print("\nOK gst_302m_late_feed_test.py")
