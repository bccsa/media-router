#!/usr/bin/env python3
"""The Audio Output (302M)'s sink end plays late audio late, never drops it, and keeps a margin (B-217, B-249).

The module's own string from its live upstream on (plugins/audio-output-302m/tests/fixtures/sink-end.json, which
AudioOutput302mModule.test.ts holds the module to: the render tap, `mrasrc` with its 60 ms margin, the queue, the
sync=false sink), into mrtestaudiosink, whose device counts the frames it plays and the all-zero runs between them
(holes). A 1 kHz tone, 10 ms buffers, each fed late by a profile, then 2 s more so the queue and ring play out:

  - rising: 30 ms for 10 s, then a walk within 30-300 ms (8 ms steps); field: the walk within 30-70 ms from 30 ms
    (MR-057 on TECH01); step: 30 ms, 70 ms from 10 s, 30 ms at 25 s, 70 ms at 30 s; old: c38's walk from its
    300 ms max. Each MR_302M_RUNS times (5), a seed each, waiting for a load under 3 first.
  - pass: every frame fed sounds but at most 1 ms (the allowance: mrasrc's resampler holds 32 frames); no
    hole after 2 s, except in the rising walk, where the feed gets later than any margin: there holes come only
    until the walk first reached its maximum (each rebuilds the margin), none after, and their length is the
    rise less the margin plus a margin each; the delay from then on flat, nothing lost.
  - mutants: c38's sink end (a 40 ms min-threshold queue, no margin) fails that pass on every run: in the rising
    walk it plays holes to the end and loses audio, in the field walk it loses audio at the start and, on some
    runs, plays holes for good; v2.0.0.101's (sync=true, ts-offset 0: a budget of the ~110 ms its sink
    declares, most of it the ring's own) cuts the field walk into holes, as on TECH01, and the rising walk.
  - drift: an hour of a device 100 ppm fast, and an hour 100 ppm slow, a tone stamped at house rate: no hole, no
    underrun, no refill after the start, the render lateness's level the same at the end as after 2 min and its
    p1-p99 within 2 ms and max-min within 20 (B-166). `MR_302M_DRIFT_SECS`, `_SPEED` and `_PPM` set the run.
  - MR_302M_PULSE_SINK=<a null sink>: a real pulsesink on that sink, holes counted on its monitor: the edge
    profile (10 s at 30 ms, then the feed set to land its writes 0-30 ms ahead of the device clock in 3 ms steps,
    shuffled, 30 s each; seeds 7, 8, 9: inside the server's read-ahead, where c1a929b9 lost audio with no refill),
    the flush profile (two flushes into the sink, as mrasrc's device flush makes them), then the field and the
    rising profile for MR_302M_PULSE_SECS (600). Pass: every hole after the start has a refill within 3 s of it,
    the rising walk none once at its max, and the frames heard within 1 ms of what the device term's measured
    ratio (mrasrc's out/in frames) makes of the feed; a flush one hole and one or two refills, at most 200 ms
    lost, sound to the end. MR_302M_PULSE_MON_US sets the monitor's latency (so the graph quantum). Not in the chain
    (it needs a server). MR_302M_PARTS picks parts (sink, mutants, pulse, drift).

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
# Which parts run (all by default): sink (the profiles), mutants, pulse (MR_302M_PULSE_SINK), drift.
PARTS = set(os.environ.get("MR_302M_PARTS", "sink,mutants,pulse,drift").split(","))
SINK_KEYS = ("holes", "hole-frames", "hole-max", "underruns", "renders", "sounded-frames")

with open(os.path.join(_PLUGINS, "audio-output-302m", "tests", "fixtures", "sink-end.json"), encoding="utf-8") as _fh:
    MODULE_TAIL = json.load(_fh)["tail"]
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


# --- the harness ---------------------------------------------------------------------------------------------

def wait_quiet(limit_s=900):
    """Wait (up to limit_s) for a 1-minute load under LOAD_MAX: the dev Pi is shared. The load at the end."""
    t0 = time.monotonic()
    while os.getloadavg()[0] >= LOAD_MAX and time.monotonic() - t0 < limit_s:
        time.sleep(5)
    return os.getloadavg()[0]


LAST_LATENCY_NS = None   # the pipeline's min latency, read 3 s into the last run


def run(desc, secs, speed=1, feed=None):
    """`desc` on MrTestClock at `speed` for `secs` of clock time: the sink's counters, the mrasrc-stats posts,
    the sink's counters per second, errors."""
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
    p.set_state(Gst.State.NULL)
    gc.enable()
    return sink, stats, levels, errors


def late_feeder(late):
    """appsrc: buffer i stamped i x 10 ms (running time), pushed when the clock reads it + late[i] (a callable: its
    value for i); then nothing."""
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
    n = SECS * 100
    late = PROFILES[name](n, seed)
    load0 = wait_quiet()
    sk, st, lv, err = run(SRC + tail, SECS + DRAIN_S, feed=late_feeder(late))
    fed = n * BUF
    h2, hf2 = holes_from(lv, sk, START_S)
    imax = next(i for i, l in enumerate(late) if l >= max(late))
    t_max = imax / 100 + late[imax] / 1000
    lat = [(t, s.get("render-lateness-ns", 0) / MS) for t, s in st if s.get("render-lateness-ns", 0)]
    steady = [v for t, v in lat if t >= max(START_S + 3, t_max + 3) and t <= SECS]
    return {"name": name, "seed": seed, "fed": fed, "lost": fed - sk["sounded-frames"], "holes": h2,
            "hole_ms": hf2 / 48, "holes_all": sk["holes"], "last_hole": last_hole_s(lv), "t_max": t_max,
            "rise": max(late) - late[0], "lat": steady, "first_late": late[0], "err": err,
            "refills": (st[-1][1].get("margin-refills", 0) if st else 0), "load": (load0, os.getloadavg()[0]),
            "latency": LAST_LATENCY_NS}


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

print("\n--- the table: profile x runs x holes after the start x lost ---")
print(f"{'tail':5} {'profile':7} {'runs':>4} {'holes':>18} {'lost ms':>30}")
for _tail in ("c39", "c38", "v101"):
    for _name in PROFILES:
        _rs = [r for t, r in TABLE if t == _tail and r["name"] == _name]
        if _rs:
            print(f"{_tail:5} {_name:7} {len(_rs):>4} {str([r['holes'] for r in _rs]):>18} "
                  f"{str([round(r['lost'] / 48, 1) for r in _rs]):>30}")

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
_PULSE_PROFILES = [v for v in os.environ.get("MR_302M_PULSE_PROFILES", "edge,flush,field,rising").split(",") if v]
FLUSH_AT_S = (10, 20)                      # the flush profile: two flushes into the sink, 30 s at 30 ms


def edge_steps(seed):
    """The edge profile's steps (ms ahead of the device clock), each `_EDGE_HOLD` s: 0-30 in 3 ms steps, shuffled."""
    steps = EDGE_STEPS[:]
    random.Random(seed).shuffle(steps)
    return steps


def pulse_run(name, secs, seed=7):
    """The module's sink end into a real pulsesink, its monitor counting. `edge`: 10 s at 30 ms, then each step
    x of edge_steps(seed): the feed's lateness becomes the render lateness less x (never earlier than it was), so
    each write lands x ms ahead of the device clock, inside the server's read-ahead for small x (blocking 1)."""
    edge, flush = name == "edge", name == "flush"
    steps = edge_steps(seed) if edge else []
    if edge:
        secs = 10 + _EDGE_HOLD * len(steps)
    if flush:
        secs = 30
    n = secs * 100
    late = [30.0] * n if flush else (PROFILES[name](n, seed) if not edge else None)
    state = {"late": 30.0, "rl": None, "step": -1, "set": []}

    def edge_late(i):
        k = (i - 1000) // (_EDGE_HOLD * 100) if i >= 1000 else -1
        if k != state["step"]:
            state["step"] = k
            if k >= 0 and state["rl"] is not None:
                state["late"] = max(state["late"], state["rl"] - steps[k] - random.Random(seed * 31 + k).uniform(0, 1))
            state["set"].append(round(state["late"], 1))
        return state["late"]

    mon = MonitorCount(_PULSE)
    mon.start()
    time.sleep(1.0)
    p = Gst.parse_launch(SRC + tail_for(MODULE_TAIL, sink=f"pulsesink name=sink device={_PULSE}", device=""))
    stop = threading.Event()
    flushed = []
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
    feed = late_feeder([edge_late] * n if edge else late)
    th = threading.Thread(target=feed, args=(p, p.get_pipeline_clock(), stop), daemon=True)
    th.start()
    bus, t0, stats, errors = p.get_bus(), mon.t0, [], []
    # Until the feed's last push has played out: its render lateness and 1.5 s more after it (the drain at least).
    ended = None
    while ended is None or time.monotonic() - ended < max(DRAIN_S, (state["rl"] or 0) / 1000 + 1.5):
        if ended is None and not th.is_alive():
            ended = time.monotonic()
        m = bus.timed_pop(100 * Gst.MSECOND)
        if m is None:
            continue
        if m.type == Gst.MessageType.ERROR:
            errors.append(m.parse_error()[0].message)
            break
        if m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-stats":
            st = sdict(m.get_structure())
            stats.append((time.monotonic() - t0, st))
            if st.get("render-lateness-ns", 0):
                state["rl"] = st["render-lateness-ns"] / MS
    stop.set()
    th.join(2)
    time.sleep(1.0)
    final = sdict(p.get_by_name("outasrc").get_property("stats"))
    p.set_state(Gst.State.NULL)
    time.sleep(0.5)
    mon.stop()
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
    # The device term's measured ratio: what mrasrc made of what it took (out/in frames, read at the end).
    ratio = final.get("out-frames", 0) / max(1, final.get("in-frames", 0))
    ppb = (ratio - 1) * 1e9
    want = fed * ratio
    return {"holes": mon.holes, "hole_ms": mon.hole_frames / 48, "after": after, "orphans": orphans, "fed": fed,
            "sounded": mon.sounded, "want": want, "lost": want - mon.sounded, "ppb": ppb, "lat": lat,
            "refills": last.get("margin-refills", 0), "guard": last.get("margin-guard-ns", 0) / MS, "err": errors,
            "t_max": t_max, "steps": steps, "set": state["set"][1:], "holes_after_start": len(holes),
            "flushed": [round(t, 1) for t in flushed], "refill_ms": refill_ms,
            "last_sound": mon.last_sound - mon.t0 if mon.last_sound else 0, "end": time.monotonic() - t0}


# The pulse pass: the frames heard within the 1 ms allowance (the resampler's 32 frames) of what the device term's
# measured ratio (mrasrc's out/in frames) makes of the feed.
def pulse_lost_ok(r):
    return abs(r["lost"]) <= 48


PULSE_TABLE = []
if _PULSE and "pulse" in PARTS:
    for _name in _PULSE_PROFILES:
        for _seed in (_EDGE_SEEDS if _name == "edge" else [7]):
            _secs = 10 + _EDGE_HOLD * len(EDGE_STEPS) if _name == "edge" else (30 if _name == "flush" else _PULSE_SECS)
            print(f"\n--- a real pulsesink on {_PULSE}: the {_name} profile{f' seed {_seed}' if _name == 'edge' else ''}, "
                  f"{_secs} s, holes on its monitor ---")
            wait_quiet()
            _r = pulse_run(_name, _PULSE_SECS, _seed)
            PULSE_TABLE.append((_name, _seed, _r))
            _lat = f"{min(_r['lat']):.0f}..{max(_r['lat']):.0f}" if _r["lat"] else "none"
            _what = (f"{_r['holes']} holes ({_r['hole_ms']:.0f} ms) on the monitor, {_r['holes_after_start']} after the "
                     f"start, {len(_r['orphans'])} with no refill {_r['orphans']}; fed {_r['fed']}, sounded "
                     f"{_r['sounded']}, the device term's ratio {_r['ppb'] / 1000:+.2f} ppm makes {_r['want']:.0f}: lost "
                     f"{_r['lost'] / 48:.2f} ms; render lateness {_lat} ms; {_r['refills']} refills; guard "
                     f"{_r['guard']:.1f} ms; errors {_r['err']}")
            if _name == "edge":
                check(f"pulse edge seed {_seed} (steps {_r['steps']} ms ahead, lateness set {_r['set']}): {_what}",
                      not _r["err"] and not _r["orphans"] and pulse_lost_ok(_r))
            elif _name == "flush":
                # A flush discards what the server held (pa_stream_flush): at most 200 ms each; one hole and one
                # or two refills each, sound to the end. The silence runs from where the sink writes: frame 0 on a
                # pulsesink whose segdone is still (1.22), so about the stream's run, reported.
                check(f"pulse flush (flushed at {_r['flushed']} s): {_what}; refills of {_r['refill_ms']} ms; sound "
                      f"until {_r['last_sound']:.1f} s of {_r['end']:.1f}",
                      not _r["err"] and len(_r["flushed"]) == len(FLUSH_AT_S) and not _r["orphans"]
                      and 1 + len(FLUSH_AT_S) <= _r["refills"] <= 1 + 2 * len(FLUSH_AT_S)
                      and _r["holes_after_start"] <= len(FLUSH_AT_S) and 0 <= _r["lost"] <= 48 + 9600 * len(FLUSH_AT_S)
                      and _r["last_sound"] >= _r["end"] - 5.0)   # the drain and teardown take 3-4 s
            else:
                check(f"pulse {_name}: {_what}; {len(_r['after'])} holes after "
                      f"{'the walk reached its max' if _name == 'rising' else 'the start'}",
                      not _r["err"] and not _r["after"] and not _r["orphans"] and pulse_lost_ok(_r))
    print("\n--- the pulse table: profile x seed x holes after the start x refills x lost ---")
    for _name, _seed, _r in PULSE_TABLE:
        print(f"  {_name:7} seed {_seed}: holes {_r['holes_after_start']}, no refill {len(_r['orphans'])}, refills "
              f"{_r['refills']}, lost {_r['lost'] / 48:.2f} ms")
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
