#!/usr/bin/env python3
"""asrc_device_ref.py's suite (plan ch. 15.4 B-165): the cases p4-4b ports one for one to
../native/mrts/tests/asrc_servo_test.cpp (the device term), same names, same order. Synthetic
clocks are built here, deterministically; the recorded ones are DEV-P4a's sink clocks
(../tests/fixtures/clock/sink-clock-*.jsonl). An output's path is modelled at 10 ms steps
(`Path`: a live input, mrasrc at the term's ratio, the 40 ms prefill, the sink's 100 ms ring and its
device), since a stopped device and a realigned ring show only through it.

With ASRC_DEVICE_TRACE=<file> every term's calls are recorded there in asrc_device_ref.py's replay
format, a config line per case, for p4-4b's parity test (`mrts_cli asrc-device`).

Run:  python3 asrc_device_ref_test.py              the suite
      python3 asrc_device_ref_test.py --case N     case N alone
      python3 asrc_device_ref_test.py --mutants    each mutant below must fail its case
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
from collections import deque

import asrc_device_ref as ad
import clock_lock as cl

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.environ.get("ASRC_DEVICE_FIXTURES") or os.path.join(HERE, "..", "tests", "fixtures", "clock")
TRACES = ("sink-clock-pi4-hdmi.jsonl", "sink-clock-pi4-kt.jsonl", "sink-clock-pi4-null.jsonl",
          "sink-clock-pi5-null.jsonl")
E9 = cl.E9
SEC = ad.SEC
MS = ad.MS
FS = 48000
TICK = 100 * MS

_failures = 0
_trace = None


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


class Recorded(ad.DeviceTerm):
    """A term that writes each call to the trace file in the replay format."""

    def __init__(self, case, cfg=None):
        super().__init__(cfg)
        if _trace is not None:
            _trace.write(json.dumps(self.cfg.to_op(case=case), separators=(",", ":")) + "\n")

    def _rec(self, obj):
        if _trace is not None:
            _trace.write(json.dumps(obj, separators=(",", ":")) + "\n")

    def start(self, mono):
        self._rec({"op": "start", "mono": mono})
        return super().start(mono)

    def stop(self, mono):
        self._rec({"op": "stop", "mono": mono})
        super().stop(mono)

    def sample(self, dev, mono, pushed=None, rendered=None):
        op = {"op": "sample", "dev": dev, "mono": mono}
        if pushed is not None:
            op.update(pushed=pushed, rendered=rendered)
        self._rec(op)
        return super().sample(dev, mono, pushed, rendered)


def term(case, **kw):
    return Recorded(case, ad.device_term_config(**kw) if kw else None)


def preempted(rnd):
    """A read pair's house read late by a preemption: under 0.2 ms in 9 reads of 10, under 5 ms
    in the tenth (the timer thread preempted between its two reads)."""
    return rnd.randrange(0, 200000) if rnd.random() < 0.9 else rnd.randrange(0, 5 * MS)


def uniform5(rnd):
    return rnd.randrange(0, 5 * MS)


def device_rate_ppm(term_):
    return ad.rate_of(term_.device_ppb()) / 1000


def feed_clock(t, seconds, ppm, jitter=None, seed=1, house0=1000 * SEC, step=None, on_sample=None):
    """Feed a synthetic device running `ppm` fast, read every 100 ms from house0; step = (at_s, ns):
    the device clock jumps by ns there. Returns the house time reached."""
    rnd = random.Random(seed)
    k1 = int(seconds * 10)
    for k in range(k1):
        h = k * TICK
        dev = h + h * ppm // 1000000
        if step is not None and h >= step[0] * SEC:
            dev += step[1]
        mono = house0 + h + (jitter(rnd) if jitter else 0)
        events, flush = t.sample(dev, mono)
        if on_sample is not None:
            on_sample(h, events)
    return house0 + k1 * TICK


# --- the recorded clocks ---------------------------------------------------------------------

def load_trace(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return [json.loads(x) for x in f if x.strip()]


def trace_slope_ppm(lines):
    """The trace's own long-run slope: device against house time by least squares, one intercept per
    stream (before and after the restart), 20 s after each start left out."""
    streams, cur = [], []
    for o in lines:
        if o.get("event") == "restart":
            streams.append(cur)
            cur = []
        elif "clock_ns" in o and o["next_sample"] >= 0:
            cur.append((o["mono_ns"], o["clock_ns"]))
    streams.append(cur)
    sxx = sxy = 0.0
    for st in streams:
        pts = [(m, d) for m, d in st if m - st[0][0] >= 20 * SEC]
        mx = sum(m for m, _ in pts) / len(pts)
        my = sum(d - m for m, d in pts) / len(pts)
        sxx += sum((m - mx) ** 2 for m, _ in pts)
        sxy += sum((m - mx) * ((d - m) - my) for m, d in pts)
    return sxy / sxx * 1e6


_replays = {}


def replay_trace(name):
    """The term on a recorded clock, as the element runs it: reads from the first rendered sample,
    stop() at the restart. Returns (term, rows, events, lines); rows: (s, device ppm, ratio ppm),
    s from the first rendered sample."""
    if name in _replays:
        return _replays[name]
    lines = load_trace(name)
    t = Recorded(name)
    rows, events, t0 = [], [], None
    for o in lines:
        if o.get("event") == "restart":
            t.stop(o["mono_ns"])
            events.append(("restart", (o["mono_ns"] - t0) / SEC))
            continue
        if "clock_ns" not in o or o["next_sample"] < 0:
            continue
        m = o["mono_ns"]
        t0 = m if t0 is None else t0
        if not t.rendering:
            events += [(e["event"], (m - t0) / SEC, e.get("reason")) for e in t.start(m)]
        evs, _ = t.sample(o["clock_ns"], m)
        events += [(e["event"], (m - t0) / SEC, e.get("reason")) for e in evs]
        rows.append(((m - t0) / SEC, device_rate_ppm(t), t.ratio_ppb() / 1000))
    _replays[name] = (t, rows, events, lines)
    return t, rows, events, lines


def trace_events(lines):
    """{kind: [(s, ms)]} of the trace's holes and restart, s from the first rendered sample."""
    t0, out = None, {}
    for o in lines:
        if "clock_ns" in o and o["next_sample"] >= 0 and t0 is None:
            t0 = o["mono_ns"]
        if o.get("event") in ("hole", "restart") and t0 is not None:
            out.setdefault(o["event"], []).append(((o["mono_ns"] - t0) / SEC, o.get("ms")))
    return out


# --- the modelled path -----------------------------------------------------------------------

def dev_of(pos):
    """The clock reading (ns) of a position read: the least ns that floors back to it."""
    return (pos * E9 + FS - 1) // FS


class Path:
    """An output's path at 10 ms steps: a live input at house rate (PTS = arrival - LAT), mrasrc
    at the term's ratio, the prefill (40 ms min threshold, 1 s max), the sink's ring (100 ms) and
    its device, which reads the ring at its own rate. The sink writes each buffer at the base
    sink's next position, realigned to the next playable one when behind; the device's server
    drops what lands behind its read index. Its clock is the position read, `lag` behind the read
    index (a device's own latency)."""
    STEP = 10 * MS
    N_IN = 480
    LAT = 100 * MS

    def __init__(self, t, ppm=0, jitter=None, seed=1, lag_ms=0, ahead_ms=15, stale=None):
        self.term, self.ppm, self.jitter = t, ppm, jitter
        self.rnd = random.Random(seed)
        self.house0 = 1000 * SEC
        self.k = 0
        self.upstream = deque()      # (pts, n) waiting for mrasrc
        self.delayed = []            # held by an input stall
        self.carry = 0               # mrasrc's fractional output, in 1e-9 samples
        self.prefill = deque()       # [pts, n]
        self.prefill_level = 0
        self.pushed = self.taken = 0
        self.segs = deque()          # [w, n, pts, lost_below]: written in the ring
        self.next_sample = -1
        self.read_pos = 0
        self.read_frac = 0
        self.running = False         # the device reads from the first write
        self.lag = lag_ms * FS // 1000
        self.ahead = ahead_ms * FS // 1000
        self.stale = stale           # (stale_ms, resync_ms): the Pi 5's realign after an underflow
        self.read_hist = deque()     # (house, read_pos)
        self.uf_at = None            # an underflow, no write since
        self.resync_at = None
        self.flushed = 0
        self.heard_ours = 0
        self.produced = 0
        self.holes, self.istalls, self.dstalls, self.steps = [], [], [], []
        self.clock_pos = 0
        self.clock_held = None
        self.acc = ad.RenderLateness(FS)
        self.log = []                # per tick: (s, truth lateness, accounting, ratio ppb, flush)
        self.events = []

    def house(self):
        return self.house0 + self.k * self.STEP

    def _in(self, spans, t):
        return next((s for s in spans if s[0] <= t < s[0] + s[1]), None)

    def _sink_read(self, now):
        """The read index as the base sink knows it: stale after an underflow on the Pi 5."""
        if self.stale is None or self.uf_at is None and self.resync_at is None:
            return self.read_pos
        if self.resync_at is not None and now >= self.resync_at:
            self.resync_at = None
            return self.read_pos
        want = now - self.stale[0] * MS
        old = self.read_pos
        for h, p in reversed(self.read_hist):
            if h <= want:
                old = p
                break
        return old

    def _write(self, pts, n, now):
        w = self.next_sample
        sink_read = self._sink_read(now)
        if w < 0 or w < sink_read:
            w = sink_read + self.ahead   # the next playable position
        if self.uf_at is not None and self.stale is not None:
            self.resync_at = now + self.stale[1] * MS
        self.uf_at = None
        self.segs.append([w, n, pts, self.read_pos])
        self.next_sample = w + n
        self.acc.rendered(w, n, pts, heard_pos=self.clock_pos)
        if not self.running:
            self.running = True

    def flush(self):
        """FLUSH_START/STOP from mrasrc: the prefill and the ring's unread part discarded."""
        self.flushed += self.prefill_level
        self.prefill.clear()
        self.prefill_level = 0
        keep = deque()
        for s in self.segs:
            w, n, pts, lost = s
            lo = max(w, lost, self.read_pos)
            self.flushed += max(w + n - lo, 0)
            if w < self.read_pos:
                s[1] = min(n, self.read_pos - w)
                keep.append(s)
        self.segs = keep
        self.next_sample = -1
        self.acc.flush()

    def queued(self):
        """Ours not yet read: the prefill and the ring ahead of the read index."""
        return self.prefill_level + sum(max(w + n - max(w, lost, self.read_pos), 0) for w, n, _, lost in self.segs)

    def heard(self, pos):
        for w, n, pts, lost in self.segs:
            if w <= pos < w + n:
                return None if pos < lost else pts + (pos - w) * E9 // FS
        return None

    def run(self, seconds):
        for _ in range(int(seconds * SEC // self.STEP)):
            self.step()

    def step(self):
        now = self.house()
        ts = self.k * self.STEP / SEC
        # input: a hole loses its content upstream; a stall holds it and delivers it at once after
        arrival = (now - self.LAT, self.N_IN)
        if self._in(self.holes, ts):
            pass
        elif self._in(self.istalls, ts):
            self.delayed.append(arrival)
        else:
            self.upstream.extend(self.delayed)
            self.delayed.clear()
            self.upstream.append(arrival)
        # mrasrc
        r = self.term.ratio_ppb() if self.term.rendering else 0
        while self.upstream:
            pts, n = self.upstream[0]
            total = n * (E9 + r) + self.carry
            out = total // E9
            if self.prefill_level + out > FS:
                break    # the prefill is full: the push blocks
            self.upstream.popleft()
            self.carry = total - out * E9
            self.prefill.append([pts, out])
            self.prefill_level += out
            self.pushed += out
            self.produced += out
        # the prefill to the sink, while the ring has room
        while self.prefill and self.prefill_level >= FS * 40 // 1000:
            pts, n = self.prefill[0]
            end = self.next_sample if self.next_sample >= 0 else self.read_pos
            if self.running and end + n - self.read_pos > FS // 10:
                break
            self.prefill.popleft()
            self.prefill_level -= n
            self.taken += n
            if not self.term.rendering:
                self.events += [(e["event"], ts) for e in self.term.start(now)]
            self._write(pts, n, now)
        # the device
        dstall = self._in(self.dstalls, ts)
        if self.running and not dstall:
            total = self.N_IN * (1000000 + self.ppm) + self.read_frac
            adv = total // 1000000
            self.read_frac = total - adv * 1000000
            for w, n, pts, lost in self.segs:
                lo, hi = max(w, lost, self.read_pos), min(w + n, self.read_pos + adv)
                if hi > lo:
                    self.heard_ours += hi - lo
            if self.next_sample >= 0 and self.read_pos <= self.next_sample < self.read_pos + adv:
                self.uf_at = now   # the ring runs dry
            self.read_pos += adv
            while self.segs and self.segs[0][0] + self.segs[0][1] <= self.read_pos - FS:
                self.segs.popleft()
        self.read_hist.append((now, self.read_pos))
        while self.read_hist and self.read_hist[0][0] < now - SEC:
            self.read_hist.popleft()
        # the device clock: the position read, lag behind; held after a stall it ran through
        truth = max(self.read_pos - self.lag, 0) if self.running else 0
        if dstall and dstall[2] == "running":
            self.clock_pos += self.N_IN * (1000000 + self.ppm) // 1000000
            self.clock_held = self.clock_pos
        elif self.clock_held is not None and truth < self.clock_held:
            self.clock_pos = self.clock_held
        else:
            self.clock_held = None
            self.clock_pos = truth
        self.k += 1
        if self.k % 10 == 0 and self.term.rendering:
            self.tick(now + self.STEP, ts + self.STEP / SEC)

    def tick(self, now, ts):
        step_ns = sum(s[1] for s in self.steps if s[0] <= ts)
        dev = dev_of(self.clock_pos) + step_ns
        mono = now + (self.jitter(self.rnd) if self.jitter else 0)
        events, flush = self.term.sample(dev, mono, self.pushed, self.taken)
        self.events += [(e["event"], ts, e.get("reason")) for e in events]
        if flush:
            self.flush()
        pos = self.read_pos - self.lag
        truth_pts = self.heard(pos) if self.running else None
        truth = None if truth_pts is None else now - truth_pts
        acc = self.acc.at(now, dev_of(self.clock_pos))
        self.log.append((ts, truth, acc, self.term.ratio_ppb(), flush))


def lateness_at(path, a, b):
    v = [x[1] for x in path.log if a <= x[0] < b and x[1] is not None]
    return (min(v), max(v)) if v else (None, None)


# --- the cases ---------------------------------------------------------------------------------

def test_lock_port():
    """1. The lock is ClockLock (clock_lock.py, its exact port), under the device configuration."""
    c = ad.device_lock_config()
    a = cl.asrc_lock_config()
    check("1: device lock = the capture lock's 50 ms two-sided step, no backlog rule, the window at "
          "its clamp (1000 buckets), a 1200 s loop, a fit taken at once only past the ratio clamp",
          (c.step_ns, c.step_falls, c.backlog_ns, c.step_fall_hold_ns) == (50 * MS, True, 0, 0)
          and (c.rate_buckets_max, c.rate_tau_ns, c.slew_track_ppm) == (1000, 1200 * SEC, 1000)
          and (c.bucket_ns, c.rate_buckets_min, c.offset_buckets, c.rate_max_ppm, c.step_hold_ns)
          == (a.bucket_ns, a.rate_buckets_min, a.offset_buckets, a.rate_max_ppm, a.step_hold_ns))
    try:
        cl.ClockLock(cl.ClockLockConfig())
        refused = False
    except ValueError:
        refused = True
    check("1: the port refuses a configuration with the backlog rule (it holds the ASRC's paths)", refused)
    d = ad.device_term_config()
    check("1: term constants: 100 ms reads, 15 s settle, 50 ms x 2 relock, flat under 1/10, stall 1 s "
          "with 100 ms waiting, probe 500 ms, resume past 200 ms, +-1000 ppm",
          (d.sample_ns, d.settle_ns, d.relock_ns, d.relock_samples, d.flat_den, d.stall_ns, d.waiting_ns,
           d.probe_ns, d.resume_ns, d.ratio_max_ppm)
          == (100 * MS, 15 * SEC, 50 * MS, 2, 10, SEC, 100 * MS, 500 * MS, 200 * MS, 1000))
    t = term("1-clean")
    t.start(0)
    feed_clock(t, 600, 80)
    check("1: a clean +80 ppm clock: the lock's eps -80 ppm to 0.01 ppm in 600 s (device rate +80)",
          abs(device_rate_ppm(t) - 80) < 0.01 and t.lock.phase() == cl.ClockLock.LOCKED)


def test_ratio():
    """2. ratio = (1 + eps_in) / (1 + eps_dev) - 1, rounded, clamped +-1000 ppm."""
    check("2: house-rate input on a device 135 ppm slow (eps_dev +135.018 ppm): -135 ppm",
          ad.ratio_of(0, 135018, 1000) == -135000)
    check("2: the product with a foreign input clock: (1 + 50e-6) / (1 - 30e-6) - 1 = +80.0024 ppm",
          ad.ratio_of(50000, -30000, 1000) == 80002)
    check("2: clamped at +-1000 ppm", ad.ratio_of(0, -1500000, 1000) == 1000000
          and ad.ratio_of(0, 1500000, 1000) == -1000000)
    check("2: rate_of: the device's own rate from eps (eps +135.018 ppm -> -135 ppm)",
          ad.rate_of(135018) == -135000 and ad.rate_of(0) == 0)
    t = term("2-no-rate")
    t.start(0)
    feed_clock(t, 20, 300)
    check("2: eps_dev 0 until the lock has a rate (20 s in: settling and acquiring)",
          t.device_ppb() == 0 and t.ratio_ppb(40000) == 40000)
    t = term("2-eps-in-series")
    t.start(0)
    feed_clock(t, 300, 80, preempted, 2)
    series = (-50000, -1000, 0, 2500, 50000)
    got = [t.ratio_ppb(e) for e in series]
    want = [((1 + e * 1e-9) * (1 + 80e-6) - 1) * 1e9 for e in series]
    check("2: eps_in as a series on a device 80 ppm fast: each ratio the product to 0.05 ppm (%s ppb)" %
          [g for g in got], all(abs(g - w) < 50 for g, w in zip(got, want))
          and got == [ad.ratio_of(e, t.device_ppb(), 1000) for e in series])


def test_jitter():
    """3. A device +80 ppm read with jitter: the ratio within 1 ppm of the device in 120 s."""
    worst_p, worst_u120, worst_u200 = 0, 0, 0
    for seed in range(10):
        errs = {}
        t = term("3-jitter-pre-%d" % seed)
        t.start(0)
        feed_clock(t, 200, 80, preempted, seed,
                   on_sample=lambda h, ev: errs.__setitem__(h // SEC, t.ratio_ppb() / 1000 - 80))
        worst_p = max(worst_p, max(abs(errs[s]) for s in range(120, 200)))
        t = term("3-jitter-uniform-%d" % seed)
        t.start(0)
        errs = {}
        feed_clock(t, 300, 80, uniform5, seed,
                   on_sample=lambda h, ev: errs.__setitem__(h // SEC, t.ratio_ppb() / 1000 - 80))
        worst_u120 = max(worst_u120, max(abs(errs[s]) for s in range(120, 300)))
        worst_u200 = max(worst_u200, max(abs(errs[s]) for s in range(200, 300)))
    check("3: +80 ppm, reads preempted up to 5 ms (9 in 10 under 0.2 ms), 10 seeds: the ratio within "
          "1 ppm of the device from 120 s (worst %.3f ppm)" % worst_p, worst_p < 1.0)
    check("3: reads late by U[0, 5 ms), 10 seeds: within 3 ppm from 120 s (worst %.2f), 1 ppm from 200 s "
          "(worst %.2f): 105 fitted buckets after the settle hold 1.3 ppm sd there" % (worst_u120, worst_u200),
          worst_u120 < 3.0 and worst_u200 < 1.0)


def test_fill_1h():
    """4. The same device for 1 h: the fill moves by the ratio's error integrated, under 5 ms."""
    worst = 0.0
    for seed in range(2):
        t = term("4-fill-%d" % seed)
        t.start(0)
        fill = [0.0]
        lo_hi = [0.0, 0.0]

        def acc(h, ev):
            fill[0] += (t.ratio_ppb() / 1000 - 80) * 1e-6 * TICK / MS   # ms
            lo_hi[0], lo_hi[1] = min(lo_hi[0], fill[0]), max(lo_hi[1], fill[0])
        feed_clock(t, 3600, 80, preempted, seed, on_sample=acc)
        worst = max(worst, lo_hi[1] - lo_hi[0])
    check("4: +80 ppm, 1 h, 2 seeds: fill excursion %.2f ms < 5 ms (the 45 s at eps 0 hold 3.6 of it)"
          % worst, worst < 5.0)


def test_input_stall():
    """5. A 2 s input stall (the ring runs dry, the clock runs on): the ratio moves < 0.5 ppm."""
    for kind in ("stall", "hole"):
        t = term("5-input-" + kind)
        p = Path(t, ppm=80, jitter=preempted, seed=5)
        (p.istalls if kind == "stall" else p.holes).append((300.0, 2.0))
        p.run(300)
        lo, hi = lateness_at(p, 290, 300)
        p.run(62)
        at = [x[3] for x in p.log if x[0] < 300 - 1e-6][-1]
        moved = max(abs(x[3] - at) for x in p.log if x[0] >= 300 - 1e-6)
        check("5: a 2 s input %s at 300 s: the ratio moves %.3f ppm over it and the minute after (< 0.5)"
              % (kind, moved / 1000), moved < 500)
        check("5: ... no relock, no device stall, no flush: the ring ran dry for the input, not the device",
              not p.events and not any(x[4] for x in p.log))
        lo2, hi2 = lateness_at(p, 310, 362)
        want = 2000 * MS if kind == "stall" else 0
        check("5: ... render lateness %+.1f ms after it (%.1f..%.1f, before %.1f..%.1f): %s" %
              ((hi2 - hi) / MS, lo2 / MS, hi2 / MS, lo / MS, hi / MS,
               "the backlog stays until a gap" if kind == "stall" else "the content after the hole plays live"),
              abs(hi2 - hi - want) < 30 * MS and abs(lo2 - lo - want) < 30 * MS)


def test_device_step():
    """6. A 100 ms device-clock step, forward and back: one relock each, the rate kept."""
    for step in (100 * MS, -100 * MS):
        t = term("6-step%+d" % (step // MS))
        t.start(0)
        evs = []
        feed_clock(t, 400, 80, preempted, 6, step=(300, step), on_sample=lambda h, e: evs.extend(e))
        t2 = term("6-step-none%+d" % (step // MS))
        t2.start(0)
        feed_clock(t2, 400, 80, preempted, 6)
        relocks = [e for e in evs if e["event"] == "relock-device"]
        check("6: a %+d ms step at 300 s: one relock-device, reason step, %s" %
              (step // MS, "at 300.1-300.3 s" if relocks else "none"),
              len(relocks) == 1 and relocks[0]["reason"] == "step" and
              300 * SEC <= relocks[0]["at"] - 1000 * SEC <= 300 * SEC + 3 * TICK)
        check("6: ... the rate kept: %.3f ppm from the run without the step (< 0.5)" %
              abs(device_rate_ppm(t) - device_rate_ppm(t2)), abs(device_rate_ppm(t) - device_rate_ppm(t2)) < 0.5)


def test_traces():
    """7. Each recorded clock: no relock but the restart's, from 1000 s within 1 ppm of its own slope."""
    for name in TRACES:
        t, rows, events, lines = replay_trace(name)
        slope = trace_slope_ppm(lines)
        relocks = [e for e in events if e[0] == "relock-device"]
        restart_at = [e[1] for e in events if e[0] == "restart"]
        check("7: %s: one relock-device, reason restart, at the restart; no step, no flat sample"
              % name, len(relocks) == 1 and relocks[0][2] == "restart" and t.flat_ns == 0
              and abs(relocks[0][1] - restart_at[0]) < 1.0)
        late = [abs(dev - slope) for s, dev, _ in rows if s >= 1000]
        check("7: %s: from 1000 s the device rate within 1 ppm of the trace's own slope %+.3f ppm "
              "(worst %.2f)" % (name, slope, max(late)), max(late) < 1.0)
        fill, prev, lo, hi = 0.0, None, 0.0, 0.0
        for s, dev, ratio in rows:
            if prev is not None:
                fill += (ratio - slope) * 1e-6 * (s - prev) * 1000
                lo, hi = min(lo, fill), max(hi, fill)
            prev = s
        check("7: %s: the fill drifts %.1f ms (the ratio's error against the slope, integrated; < 8)"
              % (name, hi - lo), hi - lo < 8.0)


def test_trace_underrun():
    """8. The recorded hole and underrun: the clock runs on, the lock fed through, the ratio unmoved."""
    for name in TRACES:
        t, rows, events, lines = replay_trace(name)
        holes = trace_events(lines).get("hole", [])
        ok_fed = True
        for at, ms in holes:
            near = [r for r in rows if at - 5 <= r[0] <= at + ms / 1000 + 5]
            ok_fed &= len(near) >= int((10 + ms / 1000) * 10) - 2
        under = [h for h in holes if h[1] == 1000][0][0]
        at_u = [r for r in rows if r[0] >= under][0]
        move = max(abs(r[2] - at_u[2]) for r in rows if under <= r[0] <= under + 30)
        check("8: %s: through the 300 ms hole and the 1 s underrun every sample read, no relock, no "
              "flat sample; the ratio moves %.3f ppm in the 30 s after the underrun (< 0.5)" % (name, move),
              ok_fed and t.flat_ns == 0 and not [e for e in events if e[0] == "relock-device"
                                                 and e[2] == "step"] and move < 0.5)


def test_clock_stall_underrun():
    """9. A clock that did stall in an underrun does not read as a slow device."""
    for shape in ("catches up", "resumes behind"):
        t = term("9-clock-stall-" + shape.replace(" ", "-"))
        t.start(0)
        evs = []
        rnd = random.Random(9)
        for k in range(4000):
            h = k * TICK
            dev = h + h * 80 // 1000000
            # stalls 1 s at each minute from 120 s on
            frozen = 0
            for m in range(120, 400, 60):
                if h >= m * SEC:
                    frozen += SEC if h >= (m + 1) * SEC else h - m * SEC
                    if shape == "catches up" and h >= (m + 1) * SEC:
                        frozen -= SEC
            ev, _ = t.sample(dev - frozen, 1000 * SEC + h + preempted(rnd))
            evs += ev
        t2 = term("9-clock-stall-none-" + shape.replace(" ", "-"))
        t2.start(0)
        feed_clock(t2, 400, 80, preempted, 9)
        relocks = [e for e in evs if e["event"] == "relock-device"]
        want = 0 if shape == "catches up" else 5
        check("9: a clock flat 1 s in each of 5 underruns, then it %s: %d relocks (want %d), the rate "
              "%.3f ppm from the clean run (< 0.5), flat %.1f s never fed" %
              (shape, len(relocks), want, abs(device_rate_ppm(t) - device_rate_ppm(t2)), t.flat_ns / SEC),
              len(relocks) == want and abs(device_rate_ppm(t) - device_rate_ppm(t2)) < 0.5
              and t.flat_ns >= 4 * SEC)


def test_start_and_restart():
    """10. Reads only between start() and stop(); the settle; a restart: one relock, the rate kept."""
    t = term("10-before-start")
    try:
        t.sample(0, 1000 * SEC)
        raised = False
    except RuntimeError:
        raised = True
    check("10: no read before the first rendered buffer (sample() before start() is refused)", raised)
    lines = load_trace(TRACES[0])
    out = ad.replay(json.dumps(o) for o in lines)
    samples = [json.loads(x) for x in out if x.startswith('{"mono"')]
    rendered = [o for o in lines if "clock_ns" in o and o["next_sample"] >= 0]
    check("10: the replay reads only rendered samples (%d of %d lines; none with next_sample -1)" %
          (len(samples), len([o for o in lines if "clock_ns" in o])), len(samples) == len(rendered))
    states = []
    t = term("10-settle")
    t.start(1000 * SEC)

    def note(h, ev):
        states.append((h / SEC, t.lock_state()))
    feed_clock(t, 40, 0, on_sample=note)
    first_moved = next(s for s, st in states if st != "idle")
    first_fed = next(s for s, st in states if st not in ("idle", "settle"))
    check("10: the lock begins 15 s after the clock first moves (moved %.1f s, fed %.1f s)" %
          (first_moved, first_fed), abs(first_fed - first_moved - 15.0) < 0.15)
    t = term("10-restart-from-0")
    t.start(1000 * SEC)
    end = feed_clock(t, 300, -135, preempted, 10)
    kept = t.device_ppb()
    t.stop(end)
    evs = t.start(end + 300 * MS)
    rnd = random.Random(11)
    for k in range(3000):   # the stream's clock from 0 again, 300 ms later
        h = k * TICK
        t.sample(h - h * 135 // 1000000, end + 300 * MS + h + preempted(rnd))
    check("10: a restart (the clock from 0): one relock-device, reason restart, the rate kept "
          "(%.3f ppm after 300 s)" % (abs(t.device_ppb() - kept) / 1000),
          len(evs) == 1 and evs[0]["reason"] == "restart" and t.relocks == {"restart": 1, "step": 0}
          and abs(t.device_ppb() - kept) < 500)
    # Restarts along a recorded clock: the post-restart short fits (up to 410 ppm off on the
    # recorded noise at 30 buckets) never replace the rate kept.
    samples = []
    for o in load_trace("sink-clock-pi4-kt.jsonl"):
        if o.get("event") == "restart":
            break
        if "clock_ns" in o and o["next_sample"] >= 0:
            samples.append((o["mono_ns"], o["clock_ns"]))
    m0 = samples[0][0]

    def run(restart_at, case, until):
        tr = term(case)
        tr.start(m0)
        out, done = [], restart_at is None
        for m, d in samples:
            if m - m0 >= until * SEC:
                break
            if not done and m - m0 >= restart_at * SEC:
                tr.stop(m)
                tr.start(m)
                done = True
            tr.sample(d, m)
            out.append(((m - m0) / SEC, device_rate_ppm(tr)))
        return out
    base = run(None, "10-kt-no-restart", 1500)
    for at in (120, 1200):
        rows = run(at, "10-kt-restart-%d" % at, at + 300)
        worst = max(abs(a[1] - b[1]) for a, b in zip(rows, base) if at <= a[0] < at + 300)
        check("10: a restart at %d s on the recorded KT USB clock: the rate within %d ppm of the run "
              "without it for the 300 s after (worst %.2f)" % (at, 50 if at == 120 else 2, worst),
              worst < (50 if at == 120 else 2))


def stall_case(case, shape):
    t = term(case)
    p = Path(t, ppm=-135, jitter=preempted, seed=12)
    p.dstalls.append((300.0, 3.0, shape))
    p.run(300)
    lo0, hi0 = lateness_at(p, 280, 300)
    produced0, heard0, queued0 = p.produced, p.heard_ours, p.queued()
    p.run(60)
    ev = [e for e in p.events if e[1] >= 300]
    stalled = [e for e in ev if e[0] == "device-stalled"]
    resumed = [e for e in ev if e[0] == "device-resumed"]
    lost = (p.produced - produced0) + queued0 - (p.heard_ours - heard0) - p.queued()
    lo1, hi1 = lateness_at(p, 305, 360)
    return t, p, ev, stalled, resumed, lost, (lo0, hi0), (lo1, hi1)


def test_device_stall_clock_stopped():
    """11. A 3 s device stall, its clock stopped: input dropped for its length, resume live."""
    t, p, ev, st, rs, lost, before, after = stall_case("11-stall-clock-stopped", "stopped")
    check("11: device-stalled once, 1.0-1.4 s after the device stopped (%s): the ring fills, then 1 s "
          "with samples waiting" % [round(e[1] - 300, 2) for e in st],
          len(st) == 1 and 1.0 <= st[0][1] - 300 <= 1.4)
    check("11: device-resumed once, within 0.6 s of its return (%s)" % [round(e[1] - 303, 2) for e in rs],
          len(rs) == 1 and 0 <= rs[0][1] - 303 <= 0.6)
    check("11: input dropped for the stall's length: %.2f s of content never played (3.0-3.6)" % (lost / FS),
          3.0 * FS <= lost <= 3.6 * FS)
    check("11: ... counted: dropped %.2f s, within the two ring contents the element cannot see"
          % (t.dropped / FS), abs(t.dropped - lost) <= FS // 4)
    check("11: resume live: render lateness after it %.1f..%.1f ms, before %.1f..%.1f" %
          (after[0] / MS, after[1] / MS, before[0] / MS, before[1] / MS),
          abs(after[1] - before[1]) < 30 * MS and abs(after[0] - before[0]) < 30 * MS)
    check("11: the clock stopped with it: flat samples never fed, one relock-device (step) on its "
          "return, the rate kept (%.2f ppm)" % device_rate_ppm(t),
          t.flat_ns >= 2 * SEC and t.relocks["step"] == 1 and abs(device_rate_ppm(t) + 135) < 1.0)


def test_device_stall_clock_running():
    """12. The same with the clock running on (a removed PipeWire node): the render shows the stall."""
    t, p, ev, st, rs, lost, before, after = stall_case("12-stall-clock-running", "running")
    flat_during = t.flat_ns
    check("12: device-stalled once while the clock ran on, 1.0-1.4 s in (%s)" % [round(e[1] - 300, 2) for e in st],
          len(st) == 1 and 1.0 <= st[0][1] - 300 <= 1.4)
    check("12: device-resumed once, within 0.6 s of its return (%s)" % [round(e[1] - 303, 2) for e in rs],
          len(rs) == 1 and 0 <= rs[0][1] - 303 <= 0.6)
    check("12: input dropped for the stall's length: %.2f s never played (3.0-3.6); counted %.2f s" %
          (lost / FS, t.dropped / FS), 3.0 * FS <= lost <= 3.6 * FS and abs(t.dropped - lost) <= FS // 4)
    check("12: resume live: render lateness after it %.1f..%.1f ms, before %.1f..%.1f" %
          (after[0] / MS, after[1] / MS, before[0] / MS, before[1] / MS),
          abs(after[1] - before[1]) < 30 * MS and abs(after[0] - before[0]) < 30 * MS)
    check("12: the clock held after the return (it ran ahead): one relock-device (step), the rate "
          "kept (%.2f ppm; flat %.1f s)" % (device_rate_ppm(t), flat_during / SEC),
          t.relocks["step"] == 1 and abs(device_rate_ppm(t) + 135) < 1.0)
    t2 = term("12-no-stall")
    p2 = Path(t2, ppm=-135, jitter=preempted, seed=12)
    p2.run(330)
    check("12: a device that keeps reading (a suspended null sink runs on a timer): no stall, no flush",
          not [e for e in p2.events if e[0] in ("device-stalled", "device-resumed")] and
          not any(x[4] for x in p2.log))


def test_render_lateness_ring():
    """13. Render lateness against the modelled ring within 1 ms; a realigned ring (case 6)."""
    t = term("13-steady")
    p = Path(t, ppm=-135, seed=13)
    p.run(120)
    errs = [abs(x[2] - x[1]) for x in p.log if x[1] is not None and x[2] is not None and x[0] > 2]
    check("13: steady: the accounting within 1 ms of the ring at every read (worst %.3f ms)" %
          (max(errs) / MS), max(errs) < MS)
    for name, kw, hole in (("13-hole-fresh", {}, (60.0, 0.3)),
                           ("13-hole-stale", {"stale": (44, 120)}, (60.0, 0.3))):
        t = term(name)
        p = Path(t, ppm=-135, seed=13, **kw)
        p.holes.append(hole)
        p.run(70)
        rows = [x for x in p.log if x[0] > 2]
        both = [abs(x[2] - x[1]) for x in rows if x[1] is not None and x[2] is not None]
        wrong = [x for x in rows if (x[1] is None) != (x[2] is None)]
        silent = sum(1 for x in rows if x[1] is None)
        check("13: %s: within 1 ms wherever a sample is heard (worst %.3f ms), silence where the ring "
              "plays none (%d reads silent, %d disagree)" % (name, max(both) / MS, silent, len(wrong)),
              max(both) < MS and not wrong)
    t = term("13-stale-loss")
    p = Path(t, ppm=0, seed=13, stale=(44, 120))
    p.holes.append((60.0, 0.3))
    p.run(70)
    lost_ms = (p.produced - p.heard_ours - p.queued() - p.flushed) * 1000 / FS
    check("13: the modelled realign on a read index 44 ms stale drops %.0f ms of writes after a 300 ms hole "
          "(DEV-P4a case 6 on the Pi 5: 100-127 ms)" % lost_ms, 90 <= lost_ms <= 130)
    lag = term("13-device-latency")
    p = Path(lag, ppm=0, seed=13, stale=(44, 120), lag_ms=40)
    p.holes.append((60.0, 0.3))
    p.run(70)
    rows = [x for x in p.log if x[0] > 2]
    wrong = [x[0] for x in rows if (x[1] is None) != (x[2] is None) or
             (x[1] is not None and abs(x[2] - x[1]) >= MS)]
    check("13: with the clock 40 ms behind the read index (the Pi 5's configured sink latency), the "
          "writes the server dropped between the two read as heard at %d reads, all in the 0.3 s after "
          "the hole (%s): the limit no clock can see" % (len(wrong), [round(w, 2) for w in wrong[:4]]),
          wrong and all(60.3 <= w <= 60.6 for w in wrong))


def test_replay_format():
    """14. The replay format: ops in, compact lines out."""
    seq = [ad.device_term_config(settle_ns=SEC).to_op(case="14"), {"op": "start", "mono": 0}]
    for k in range(40):
        seq.append({"op": "sample", "dev": k * TICK, "mono": 10 * SEC + k * TICK, "pushed": 0, "rendered": 0,
                    "in_ppb": 1000 * k})
    seq.append({"op": "stop", "mono": 5 * SEC})
    seq.append({"op": "start", "mono": 6 * SEC})
    out = ad.replay(json.dumps(x) for x in seq)
    first = json.loads(out[0])
    check("14: one line per sample, keys in order", list(first) == ["mono", "lock", "dev_ppb", "ratio_ppb",
                                                                  "stalled", "flush"] and first["lock"] == "idle")
    check("14: the restart's event line, then the summary", json.loads(out[-2]) == {
        "event": "relock-device", "reason": "restart", "at": 6 * SEC} and "summary" in json.loads(out[-1]))
    check("14: compact separators", all(", " not in x and ": " not in x for x in out))
    ratios = [json.loads(x)["ratio_ppb"] for x in out if x.startswith('{"mono"')]
    check("14: a sample's in_ppb is the ratio's eps_in (no device rate yet: the ratio is eps_in)",
          ratios == [1000 * k for k in range(40)])


CASES = (test_lock_port, test_ratio, test_jitter, test_fill_1h, test_input_stall, test_device_step,
         test_traces, test_trace_underrun, test_clock_stall_underrun, test_start_and_restart,
         test_device_stall_clock_stopped, test_device_stall_clock_running, test_render_lateness_ring,
         test_replay_format)

# (name, the case it must fail, file, [(text, its replacement), ...]). The first four are the brief's.
MUTANTS = (
    ("the fill read into the ratio", 5, "asrc_device_ref.py",
     [("        self._clock(dev, mono, events)\n",
       "        self._clock(dev, mono, events)\n"
       "        if pushed is not None:\n"
       "            self.fill = pushed - self.discarded - dev * self.cfg.rate_hz // E9\n"
       "            self.fill0 = getattr(self, 'fill0', None) or self.fill\n"),
      ("        return ratio_of(eps_in_ppb, self.device_ppb(), self.cfg.ratio_max_ppm)",
       "        f = getattr(self, 'fill', 0) - getattr(self, 'fill0', 0)\n"
       "        return ratio_of(eps_in_ppb, self.device_ppb() + f * 1000 // 48, self.cfg.ratio_max_ppm)")]),
    ("no min-filter", 3, "clock_lock.py",
     [("        elif sat_sub(h, sigma) < sat_sub(self.cur.house, self.cur.sigma):",
       "        elif True:")]),
    ("the stall's input kept", 11, "asrc_device_ref.py",
     [("        if flush:\n            self.dropped += pending", "        if flush and False:\n            self.dropped += pending"),
      ("        return flush\n\n    def sample", "        return False\n\n    def sample")]),
    ("a 5 ms relock threshold", 7, "asrc_device_ref.py",
     [("        self.relock_ns = 50 * MS ", "        self.relock_ns = 5 * MS  ")]),
    ("flat samples fed", 9, "asrc_device_ref.py",
     [("        if dm <= 0 or dd * c.flat_den <= dm:", "        if dm <= 0:")]),
    ("no settle", 7, "asrc_device_ref.py",
     [("        self.settle_ns = 15 * SEC", "        self.settle_ns = 0      ")]),
    ("the stall read on the clock alone (the plan's 'clock not advancing')", 12, "asrc_device_ref.py",
     [("        dd, dm = dev - prev[0], mono - prev[1]\n",
       "        dd, dm = dev - prev[0], mono - prev[1]\n        self.clock_moved = dm > 0 and dd * c.flat_den > dm\n"),
      ("            if prev is None or taken > prev or pending <= self.wait_samples:",
       "            if prev is None or getattr(self, 'clock_moved', True) or pending <= self.wait_samples:")]),
    ("no flush at the resume", 11, "asrc_device_ref.py",
     [("            events.append({\"event\": \"device-resumed\", \"at\": mono, \"dropped\": self.dropped + pending})\n"
       "            flush = True",
       "            events.append({\"event\": \"device-resumed\", \"at\": mono, \"dropped\": self.dropped + pending})\n"
       "            return False")]),
    ("the capture lock's 20 ppm fit acceptance", 10, "asrc_device_ref.py",
     [("rate_tau_ns=1200 * SEC, slew_track_ppm=1000)", "rate_tau_ns=1200 * SEC, slew_track_ppm=20)")]),
    ("a 300-bucket window, a 60 s loop", 7, "asrc_device_ref.py",
     [("rate_buckets_max=1000, rate_tau_ns=1200 * SEC", "rate_buckets_max=300, rate_tau_ns=60 * SEC")]),
    ("reads before the first rendered buffer", 10, "asrc_device_ref.py",
     [("        if not self.rendering:\n            raise RuntimeError", "        if False:\n            raise RuntimeError")]),
    ("render lateness from the pushed count (the plan's out_pushed - fill)", 13, "asrc_device_ref.py",
     [("        self.map.append((write_pos, n, pts_ns))",
       "        self.count = getattr(self, 'count', write_pos)\n"
       "        self.map.append((self.count, n, pts_ns))\n"
       "        self.count += n")]),
)


def run_mutants():
    for name, case, fname, edits in MUTANTS:
        with open(os.path.join(HERE, fname)) as f:
            src = f.read()
        if not all(src.count(old) == 1 for old, _ in edits):
            check("mutant %r applies once" % name, False)
            continue
        for old, new in edits:
            src = src.replace(old, new)
        with tempfile.TemporaryDirectory() as tmp:
            for other in ("asrc_device_ref.py", "clock_lock.py", "asrc_device_ref_test.py"):
                shutil.copy(os.path.join(HERE, other), tmp)
            with open(os.path.join(tmp, fname), "w") as f:
                f.write(src)
            env = {k: v for k, v in os.environ.items() if k != "ASRC_DEVICE_TRACE"}
            env["ASRC_DEVICE_FIXTURES"] = FIXTURES
            done = subprocess.run([sys.executable, os.path.join(tmp, "asrc_device_ref_test.py"),
                                   "--case", str(case)], capture_output=True, text=True, env=env)
        failed = [line for line in done.stdout.splitlines() if line.startswith("FAIL ")]
        check("mutant %r fails case %d (%d checks; first: %s)" % (name, case, len(failed), failed[0][5:110] if failed
              else "none"), done.returncode != 0 and failed)
    return 1 if _failures else 0


def main(argv):
    global _trace
    if argv[1:] == ["--mutants"]:
        return run_mutants()
    path = os.environ.get("ASRC_DEVICE_TRACE")
    if path:
        _trace = open(path, "w")
    if len(argv) == 3 and argv[1] == "--case":
        CASES[int(argv[2]) - 1]()
    else:
        for case in CASES:
            case()
    if _trace is not None:
        _trace.close()
    if _failures:
        print("\n%d FAILURE(S) in asrc_device_ref" % _failures)
        return 1
    print("\nALL asrc_device_ref TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
