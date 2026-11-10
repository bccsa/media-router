#!/usr/bin/env python3
"""drain_servo.py's suite (B-179, WI-P4-18; design part 12 item 1): a model of a live source's
arrivals into a queue before a device, the servo on the device element's 100 ms tick, run on
synthetic time; the cases one for one in ../native/mrts/tests/drain_servo_test.cpp (whose
sequences drain_servo_parity_test.py replays through both), then the mutants, each failing its
case. Run: python3 drain_servo_test.py [-v]."""
import math
import sys

import drain_servo as ds
from drain_servo import MS, SEC, DrainServo

TICK = 100 * MS
SLEW_STEP = TICK // ds.SLEW_DEN      # 500 ppm/s over a tick, fixed before any mutant
CAP_PPB = ds.DMAX_PPB
MIN = 60 * SEC
HOUR = 3600 * SEC
VERBOSE = "-v" in sys.argv
M60 = 60 * MS                        # the cases built on r3's 60 ms start (the default is the floor now)


def source(period_at, start=0, stalls=(), dip_every=0, dip_ns=0, until=None):
    """A live source: content up to t delivered at t, each `period_at(t)` (bursts); a stall
    (start, length) holds every arrival in it to its end; every `dip_every` the next arrival
    comes `dip_ns` late (the content arrives late, none is lost)."""
    t, last = start, start
    while until is None or t < until:
        p = period_at(t)
        t += p
        at = t
        for s, n in stalls:
            if s < at < s + n:
                at = s + n
        if dip_every and t // dip_every != (t - p) // dip_every:
            at += dip_ns
        at = max(at, last)
        last = at
        yield at, t


class Link:
    """The source's content into a queue, a device playing it at (1 + device)(1 + delta): the
    servo's slack is the fill, its lowest just before each arrival or at the tick; its render
    lateness the content time at the device against now, plus `base` (the path's structure)."""

    def __init__(self, servo, arrivals, fill_ns=0, base_ns=0, dev_ppb=0, start=0):
        self.s = servo
        self.arr = arrivals
        self.nxt = next(self.arr)
        self.now = start
        self.avail = start
        self.pos = start - fill_ns
        self.base = base_ns
        self.dev = dev_ppb
        self.starved = False
        self.starved_ns = 0
        self.lost = 0

    def _play(self, t):
        dt = t - self.now
        want = dt * (SEC + self.dev) // SEC * (SEC + self.s.ppb) // SEC
        fill = self.avail - self.pos
        if want > fill:
            self.starved = True
            self.starved_ns += want - fill
            self.pos = self.avail
        else:
            self.pos += want
        self.now = t

    def render(self):
        return self.now - self.pos + self.base

    def tick(self, to, can=True):
        lo = None
        while self.nxt is not None and self.nxt[0] <= to:
            at, av = self.nxt
            self._play(at)
            f = self.avail - self.pos
            lo = f if lo is None else min(lo, f)
            self.avail = max(self.avail, av)
            self.nxt = next(self.arr, None)
        self._play(to)
        f = self.avail - self.pos
        lo = f if lo is None else min(lo, f)
        self.s.starve(to, self.starved)
        self.starved = False
        self.s.sample(to, lo)
        self.s.update(to, self.render(), can)


class Run:
    """Ticks links on one clock; records each update."""

    def __init__(self, links, start=0):
        self.links = links
        self.t = start
        self.log = [[] for _ in links]
        self.slew_ok = True
        self.cap_ok = True

    def until(self, t_end, each=None):
        while self.t < t_end:
            self.t += TICK
            for i, ln in enumerate(self.links):
                was = ln.s.ppb
                brk = ln.s.brk
                ln.tick(self.t)
                if not brk and abs(ln.s.ppb - was) > SLEW_STEP:
                    self.slew_ok = False
                if abs(ln.s.ppb) > CAP_PPB:
                    self.cap_ok = False
                ev = ln.s.take_events()
                self.log[i].append((self.t, ln.s.ppb, ln.s.excess, ln.s.margin, ln.render(),
                                    ln.s.target, ev))
            if each:
                each(self.t)


def steady(period):
    return lambda t: period


def events(log, kind):
    return [(t, v) for (t, _p, _e, _m, _r, _tg, ev) in log for (k, at, v) in ev if k == kind]


def predicted_ns(e0):
    """Part 5: (E0 - 150 ms) / 5 ms/s + 30 s ln(150 / 20)."""
    return (e0 - 150 * MS) / 5e6 * SEC + 30 * SEC * math.log(150 / 20)


# --- the cases ------------------------------------------------------------------------------------

def case_backlog():
    """1. A 2 s backlog drains to within 20 ms of the target in part 5's time +-10 %, within the
    cap and the slew."""
    s = DrainServo()
    ln = Link(s, source(steady(20 * MS)), fill_ns=2 * SEC)
    r = Run([ln])
    r.until(15 * MIN)
    start = events(r.log[0], "drain-start")
    near = [t for (t, p, e, m, *_r) in r.log[0] if start and t > start[0][0] and e <= 20 * MS]
    took = near[0] - start[0][0] if start and near else None
    pred = predicted_ns(start[0][1]) if start else 0
    return [
        ("backlog: a drain starts after the 30 s warm-up", bool(start) and start[0][0] >= 30 * SEC),
        ("backlog: within 20 ms of the target in part 5's time +-10 %",
         took is not None and abs(took - pred) <= pred / 10),
        ("backlog: delta never over 0.5 %", r.cap_ok),
        ("backlog: |d delta/dt| never over 500 ppm/s", r.slew_ok),
        ("backlog: reaches 0.5 %", max(p for (_t, p, *_x) in r.log[0]) == ds.DMAX_PPB),
        ("backlog: no underrun", s.underruns == 0 and s.outages == 0),
    ]


def case_steady():
    """2. A bursty link (bursts every 100 and 200 ms in turn, 150 ms on average) for 2 h, starting
    30 ms under its margin: no underrun; with no L yet the margin decays to its 20 ms floor in about
    80 min; alone, delta is never negative."""
    s = DrainServo(False, M60)
    ln = Link(s, source(lambda t: 100 * MS if t // (150 * MS) % 2 else 200 * MS), fill_ns=230 * MS)
    r = Run([ln])
    floor_at = []
    r.until(2 * HOUR, lambda t: floor_at.append(t) if s.margin == 20 * MS and not floor_at else None)
    return [
        ("steady: no underrun", s.underruns == 0 and s.outages == 0 and ln.starved_ns == 0),
        ("steady: the margin decays to 20 ms in about 80 min",
         bool(floor_at) and 75 * MIN <= floor_at[0] <= 85 * MIN),
        ("steady: alone, delta never negative", min(p for (_t, p, *_x) in r.log[0]) >= 0),
    ]


def case_steady_raise():
    """2b. The same link with a 100 ms starvation at 90 min (the margin at its floor): one raise,
    then back to the 20 ms floor by 6 h (L decays to floor - 10 ms)."""
    s = DrainServo()
    ln = Link(s, source(steady(150 * MS), stalls=[(90 * MIN, 300 * MS)]), fill_ns=300 * MS)
    r = Run([ln])
    r.until(6 * HOUR)
    return [
        ("steady+raise: one raise", s.raises == 1),
        ("steady+raise: the margin back at 20 ms by 6 h", s.margin == 20 * MS),
    ]


def case_step():
    """3. The burst rhythm stepped from 150 to 300 ms at 10 min: exactly one underrun by 1 h, the
    margin back at L + 10 ms within 2 h of the raise; at most 4 underruns >= 1.75 h apart over
    8 h; the rhythm stepped back at 4 h: the margin <= 30 ms by 10 h."""
    s = DrainServo(False, M60)
    per = lambda t: 150 * MS if t < 10 * MIN or t >= 4 * HOUR else 300 * MS
    ln = Link(s, source(per), fill_ns=300 * MS)
    r = Run([ln])
    back = []
    r.until(10 * HOUR, lambda t: back.append(t)
            if s.raises and s.learned is not None and s.margin == s.learned + 10 * MS and not back
            else None)
    ur = events(r.log[0], "underrun")
    raise_t = events(r.log[0], "raise")
    gaps = [b[0] - a[0] for a, b in zip(ur, ur[1:])]
    return [
        ("step: exactly one underrun by 1 h", len([u for u in ur if u[0] <= HOUR]) == 1),
        ("step: the margin back at L + 10 ms within 2 h of the raise",
         bool(back) and bool(raise_t) and back[0] - raise_t[0][0] <= 2 * HOUR + 10 * MIN),
        ("step: at most 4 underruns over 8 h, >= 1.75 h apart",
         len([u for u in ur if u[0] <= 8 * HOUR]) <= 4 and all(g >= 105 * MIN for g in gaps)),
        ("step: stepped back, the margin <= 30 ms by 10 h", s.margin <= 30 * MS),
    ]


def case_starve():
    """4. A 200 ms starvation with delta 0 throughout raises once, at its end; a 2 s one is an
    outage and raises nothing."""
    out = []
    for length, raises in ((200 * MS, 1), (2 * SEC, 0)):
        s = DrainServo()
        ln = Link(s, source(steady(20 * MS), stalls=[(20 * SEC, length)]), fill_ns=30 * MS)
        r = Run([ln])
        r.until(25 * SEC)
        ur = events(r.log[0], "raise")
        end = 20 * SEC + length
        out.append(("starve %d ms: %d raise(s), at its end" % (length // MS, raises),
                    s.raises == raises and all(end <= t <= end + 2 * TICK for t, _v in ur)
                    and max(abs(p) for (_t, p, *_x) in r.log[0]) == 0))
    return out


def case_dip():
    """5. B3's rhythm: a trough of 100 ms, a 70 ms dip every 5 min, for 8 h: one dropout at the
    first dip after the drain, none in the 1.75 h after it, at most one per 2 h, never one per
    dip."""
    s = DrainServo(False, M60)
    ln = Link(s, source(steady(20 * MS), dip_every=5 * MIN, dip_ns=70 * MS), fill_ns=120 * MS)
    r = Run([ln])
    r.until(8 * HOUR)
    ur = [t for t, _v in events(r.log[0], "underrun")]
    first = ur[0] if ur else None
    return [
        ("dip: a dropout after the drain", first is not None and first <= 15 * MIN),
        ("dip: none in the 1.75 h after the first",
         first is not None and not [t for t in ur if first < t <= first + 105 * MIN]),
        ("dip: at most one per 2 h", len(ur) <= 8 * HOUR // (2 * HOUR) + 1),
        ("dip: never one per dip", len(ur) < 8 * HOUR // (5 * MIN) // 4),
    ]


def case_creep():
    """6. A 260 ppm creep (the device slower than the content): the excess stays <= 20 ms for 1 h
    (held near c x tau = 7.8 ms once engaged)."""
    s = DrainServo(False, M60)
    ln = Link(s, source(steady(20 * MS)), fill_ns=80 * MS, dev_ppb=-260000)
    r = Run([ln])
    r.until(HOUR)
    worst = max(e for (_t, _p, e, *_x) in r.log[0])
    held = max(e for (t, _p, e, *_x) in r.log[0] if t >= 5 * MIN)
    # The first engage overshoots by the window's bucket steps (a rising trough lags 10 s).
    return [("creep: the excess stays <= 20 ms from 5 min on, for 1 h", held <= 20 * MS),
            ("creep: at most 25 ms at the first engage", worst <= 25 * MS),
            ("creep: it drains (held by the servo)", len(events(r.log[0], "drain-start")) >= 1)]


def case_outage():
    """7. A 2 s outage: no raise; the window keeps its zeros, so no drain for 20-30 s after (the
    bucket they fell in leaves the window 20-30 s on); then the burst it left drains."""
    s = DrainServo()
    ln = Link(s, source(steady(20 * MS), stalls=[(60 * SEC, 2 * SEC)]), fill_ns=70 * MS)
    r = Run([ln])
    r.until(12 * MIN)
    st = [t for t, _v in events(r.log[0], "drain-start")]
    return [
        ("outage: no raise", s.raises == 0 and s.outages == 1),
        ("outage: no drain for 20 s after", not [t for t in st if 62 * SEC <= t < 82 * SEC]),
        ("outage: then it drains", bool([t for t in st if t >= 82 * SEC])),
        ("outage: back near its target", r.log[0][-1][2] <= 20 * MS),
    ]


def case_discont():
    """8. DISCONTs every 5 s on a backlogged link: the window is kept, it drains on time (M2)."""
    s = DrainServo()
    ln = Link(s, source(steady(20 * MS)), fill_ns=SEC)
    r = Run([ln])
    r.until(8 * MIN, lambda t: s.epoch_break() if t % (5 * SEC) == 0 else None)
    st = events(r.log[0], "drain-start")
    near = [t for (t, p, e, *_x) in r.log[0] if st and t > st[0][0] and e <= 20 * MS]
    took = near[0] - st[0][0] if st and near else None
    pred = predicted_ns(st[0][1]) if st else 0
    return [("discont: drains in part 5's time +-10 %",
             took is not None and abs(took - pred) <= pred / 10)]


def case_paced():
    """9. A ready-but-paced input (released 10 ms before it is needed): no drain below the pace and
    no underrun."""
    s = DrainServo()

    def paced():
        t = 0
        while True:
            t += 10 * MS
            yield t, t + 10 * MS

    ln = Link(s, paced(), fill_ns=10 * MS)
    r = Run([ln])
    r.until(10 * MIN)
    return [("paced: no drain", max(p for (_t, p, *_x) in r.log[0]) == 0),
            ("paced: no underrun", s.underruns == 0 and ln.starved_ns == 0)]


class Group:
    """The engine's role: every 2 s, P = the max of the members' published targets, to each."""

    def __init__(self, links, pick=max):
        self.links = links
        self.pick = pick
        self.p = 0

    def __call__(self, t):
        if t % (2 * SEC):
            return
        self.p = self.pick(ln.s.target for ln in self.links)
        for ln in self.links:
            ln.s.set_group(t, self.p)


def case_group():
    """10. A group of three (a video, two audio; different margins and structures) given the max
    of their targets every 2 s: after one audio's raise and a shared 2 s stall all end within 20 ms
    of P; a low member rises at <= 0.5 %, its published T held; a member restarted low rises to P."""
    stall = (8 * MIN, 2 * SEC)
    v = Link(DrainServo(True, 40 * MS, 20 * MS), source(steady(40 * MS), stalls=[stall]),
             fill_ns=200 * MS, base_ns=120 * MS)
    a = Link(DrainServo(), source(steady(20 * MS), stalls=[stall, (3 * MIN, 300 * MS)]),
             fill_ns=150 * MS, base_ns=60 * MS)
    b = Link(DrainServo(), source(steady(20 * MS), stalls=[stall]), fill_ns=300 * MS,
             base_ns=200 * MS)
    links = [v, a, b]
    g = Group(links)
    r = Run(links)
    held_ok = [True]
    prev = {}

    def each(t):
        g(t)
        for i, ln in enumerate(links):
            was = prev.get(i)
            if was and was[0] < 0 and ln.s.ppb < 0 and was[1] != ln.s.target:
                held_ok[0] = False
            prev[i] = (ln.s.ppb, ln.s.target)

    r.until(20 * MIN, each)
    spread = max(abs(ln.render() - g.p) for ln in links)
    rose = min(p for log in r.log for (_t, p, *_x) in log)
    # A restart: b's element anew (its catch-up skipped its stale content: 250 ms lower).
    b.s = DrainServo()
    b.pos += 250 * MS
    r.until(32 * MIN, each)
    spread2 = max(abs(ln.render() - g.p) for ln in links)
    return [
        ("group: a's raise", a.s.raises == 1),
        ("group: all within 20 ms of P after the stall", spread <= 20 * MS),
        ("group: a low member rose, at <= 0.5 %", -ds.DMAX_PPB <= rose < 0 and r.cap_ok),
        ("group: a rising member's published T held", held_ok[0]),
        ("group: a member restarted low rises to P", spread2 <= 20 * MS),
    ]


def case_group_cap():
    """10b. P held at T_own + 1.2 s: it rises to T_own + 1 s and sits there, steady: no sign change
    of delta in the 10 min after (M18, the clamp on the held T)."""
    s = DrainServo()
    ln = Link(s, source(steady(20 * MS)), fill_ns=80 * MS, base_ns=50 * MS)
    r = Run([ln])
    own = []

    def each(t):
        if t == 60 * SEC:
            own.append(s.target)
        if t >= 60 * SEC and t % (2 * SEC) == 0:
            s.set_group(t, own[0] + 1200 * MS)

    r.until(12 * MIN, each)
    t_at = [t for (t, p, e, m, rd, *_x) in r.log[0] if own and rd >= own[0] + 980 * MS]
    after = [p for (t, p, *_x) in r.log[0] if t_at and t >= t_at[0] + 20 * SEC]
    signs = {(p > 0) - (p < 0) for p in after if p}
    r.until(24 * MIN, each)
    final = ln.render()
    return [
        ("cap: rises to T_own + 1 s", bool(t_at)),
        ("cap: sits within 20 ms of T_own + 1 s", own and abs(final - own[0] - SEC) <= 20 * MS),
        ("cap: no sign change of delta in the 10 min after", len(signs) <= 1),
        ("cap: held there", s.capped),
    ]


def case_video_late():
    """10c. B4: a jittery video input (a late frame every 20 s) with the drain idle raises neither
    the margin nor P; the same late frame 10 s after a drain let go raises once."""
    s = DrainServo(True, 40 * MS, 20 * MS)
    ln = Link(s, source(steady(40 * MS)), fill_ns=40 * MS, base_ns=100 * MS)
    r = Run([ln])
    targets = []
    r.until(5 * MIN, lambda t: (s.late(t, 80 * MS) if t % (20 * SEC) == 0 else None,
                                targets.append(s.target) if t > 40 * SEC else None))
    idle_ok = s.raises == 0 and s.underruns >= 10 and max(targets) - min(targets) <= 40 * MS
    # A backlog drains, lets go; a late frame 10 s later raises once.
    s2 = DrainServo(True, 40 * MS, 20 * MS)
    ln2 = Link(s2, source(steady(40 * MS)), fill_ns=400 * MS, base_ns=100 * MS)
    r2 = Run([ln2])
    while not events(r2.log[0], "drain-done") and r2.t < 6 * MIN:
        r2.until(r2.t + TICK)
    done = events(r2.log[0], "drain-done")
    r2.until(r2.t + 10 * SEC)
    s2.late(r2.t, 80 * MS)
    r2.until(r2.t + 2 * SEC)
    return [("late: drain idle, no raise and P steady", idle_ok),
            ("late: 10 s after a drain let go, one raise", bool(done) and s2.raises == 1)]


def case_hysteresis():
    """11. A slack 10 ms above the margin never engages; a drain lets go at 5 ms and does not
    re-engage below 20 ms (under 10 min: no margin decay)."""
    s = DrainServo(False, M60)
    ln = Link(s, source(steady(10 * MS)), fill_ns=80 * MS)   # trough 70 ms: E = 10 ms
    r = Run([ln])
    r.until(9 * MIN)
    quiet = max(p for (_t, p, *_x) in r.log[0]) == 0
    s2 = DrainServo(False, M60)
    ln2 = Link(s2, source(steady(10 * MS)), fill_ns=200 * MS)
    r2 = Run([ln2])
    r2.until(9 * MIN)
    st = events(r2.log[0], "drain-start")
    done = events(r2.log[0], "drain-done")
    let = [e for (t, p, e, *_x) in r2.log[0] if done and t == done[0][0]]
    return [("hysteresis: 10 ms above the margin never engages", quiet),
            ("hysteresis: lets go at 5 ms", bool(let) and let[0] <= 5 * MS),
            ("hysteresis: one engage only", len(st) == 1)]


def case_live():
    """12. B-179 fix 1: a live link whose trough sits under the margin (the fill at the prefill's
    delay line, no ring margin) publishes its render lateness, never more, so a group of it and a
    member 85 ms behind ends at the higher of the two renders, not above it; no underrun."""
    a = Link(DrainServo(), source(steady(20 * MS)), fill_ns=25 * MS, base_ns=40 * MS)
    b = Link(DrainServo(), source(steady(20 * MS)), fill_ns=120 * MS, base_ns=-140 * MS)
    links = [a, b]
    g = Group(links)
    r = Run(links)
    over = [0]

    def each(t):
        g(t)
        if t >= 40 * SEC:
            over[0] = max(over[0], g.p - max(ln.render() for ln in links))

    r.until(10 * MIN, each)
    top = max(ln.render() for ln in links)
    return [
        ("live: the trough under the margin, no drain", a.s.excess < 0 and a.s.ppb == 0),
        ("live: it publishes its render lateness", a.s.target == a.render()),
        ("live: P never above the higher render", over[0] <= MS),
        ("live: both end at the higher render, none above it",
         all(abs(ln.render() - top) <= 20 * MS for ln in links) and top <= a.render() + MS),
        ("live: no underrun", all(ln.s.underruns == 0 and ln.starved_ns == 0 for ln in links)),
    ]


def case_hole():
    """13. B-179 fix 2: a 35 s hole in a video servo's samples (an input outage) empties its window;
    the next sample starts warm-up again, so nothing drains for 30 s on a one-sample window."""
    s = DrainServo(True, 40 * MS, 20 * MS)
    ppb = []
    for k in range(1, 1201):
        t = k * TICK
        if 40 * SEC < t < 75 * SEC:
            continue
        s.sample(t, 300 * MS)
        s.update(t, 500 * MS, True)
        ppb.append((t, s.ppb))
    before = [p for t, p in ppb if t <= 40 * SEC]
    quiet = [p for t, p in ppb if 75 * SEC <= t < 105 * SEC]
    after = [p for t, p in ppb if t >= 105 * SEC]
    return [("hole: it drained before the hole", max(before) > 0),
            ("hole: warm-up again after it, nothing drains for 30 s", max(quiet) == 0),
            ("hole: then it drains", max(after) > 0)]


CASES = {
    "backlog": case_backlog, "steady": case_steady, "steady_raise": case_steady_raise,
    "step": case_step, "starve": case_starve, "dip": case_dip, "creep": case_creep,
    "outage": case_outage, "discont": case_discont, "paced": case_paced, "group": case_group,
    "group_cap": case_group_cap, "video_late": case_video_late, "hysteresis": case_hysteresis,
    "live": case_live, "hole": case_hole,
}


# --- the mutants: each must fail its case ---------------------------------------------------------

def _patch(obj, name, value):
    old = getattr(obj, name)
    setattr(obj, name, value)
    return lambda: setattr(obj, name, old)


def m_mean():
    class MeanWindow(ds.Window):
        def clear(self, now):
            super().clear(now)
            self.acc = []

        def add(self, now, v):
            super().add(now, v)
            self.acc = (self.acc + [v])[-300:]

        def min(self, now):
            m = super().min(now)
            return None if m is None else sum(self.acc) // len(self.acc)
    return _patch(ds, "Window", MeanWindow)


def m_r1_filter():
    orig = DrainServo.starve

    def starve(self, now, on):
        if on and self.episode_at is None:
            self.r1_drain = self.ppb > 0
        if not on and self.episode_at is not None and not getattr(self, "r1_drain", False):
            self.episode_at = None
            return
        orig(self, now, on)
    return _patch(DrainServo, "starve", starve)


def m_bound_before_raise():
    return _patch(DrainServo, "_bound",
                  lambda self: self.floor + 10 * MS if self.learned is None
                  else max(self.floor, self.learned + 10 * MS))


def m_dead_m():
    orig = DrainServo._decay

    def decay(self, now):
        keep = self.margin
        orig(self, now)
        self.margin = keep
    return _patch(DrainServo, "_decay", decay)


def m_dead_l():
    return _patch(ds, "L_EVERY_NS", 10 ** 18)


def m_l_floor():
    return _patch(ds, "UNDER_FLOOR_NS", 0)


def m_clear_at_break():
    return _patch(DrainServo, "epoch_break", lambda self: self.clear(self.last))


def m_negative_alone():
    orig = DrainServo.update

    def update(self, now, render, can):
        if not self.group or self.group_at == getattr(self, "own_at", None):
            self.group, self.group_at, self.own_at = max(render - self.excess, 1), now, now
        return orig(self, now, render, can)
    return _patch(DrainServo, "update", update)


def m_negative_target():
    orig = DrainServo.update

    def update(self, now, render, can):
        ppb = orig(self, now, render, can)
        if self.ppb >= 0:
            self.held = self.target = render - self.excess
        return ppb
    return _patch(DrainServo, "update", update)


def m_warm_across_hole():
    orig = DrainServo.sample

    def sample(self, now, slack_ns):
        self.sampled = False
        return orig(self, now, slack_ns)
    return _patch(DrainServo, "sample", sample)


def m_no_hysteresis():
    a = _patch(ds, "ENGAGE_NS", 0)
    b = _patch(ds, "LETGO_NS", -1)
    return lambda: (a(), b())


def m_group_ignored():
    return _patch(DrainServo, "set_group", lambda self, now, t: None)


def m_p_min():
    return _patch(Group, "__init__",
                  lambda self, links, pick=max: (setattr(self, "links", links),
                                                 setattr(self, "pick", min),
                                                 setattr(self, "p", 0)) and None)


def m_t_not_held():
    orig = DrainServo.update

    def update(self, now, render, can):
        self.held = render - self.excess
        return orig(self, now, render, can)
    return _patch(DrainServo, "update", update)


def m_no_rise_cap():
    return _patch(ds, "RISE_CAP_NS", 10 ** 15)


def m_abandon():
    orig = DrainServo.update

    def update(self, now, render, can):
        if self.group > self.target + ds.RISE_CAP_NS:
            self.group = 0
        return orig(self, now, render, can)
    return _patch(DrainServo, "update", update)


def m_r2_video():
    orig = DrainServo.late

    def late(self, now, by):
        joins = self.late_at is not None and now - self.late_at <= ds.JOIN_NS
        orig(self, now, by)
        if not joins and self.raises == 0 and by <= ds.SHORT_NS:
            self._raise(now)
    return _patch(DrainServo, "late", late)


MUTANTS = [
    ("the trough as a mean", m_mean, "steady"),
    ("no slew", lambda: _patch(ds, "SLEW_DEN", 1), "backlog"),
    ("a dead decay of m", m_dead_m, "step"),
    ("a dead decay of L", m_dead_l, "step"),
    ("r1's drain-caused filter", m_r1_filter, "dip"),
    ("the L + 10 bound before any raise", m_bound_before_raise, "steady"),
    ("the cap removed", lambda: _patch(ds, "DMAX_PPB", 10 ** 9), "backlog"),
    ("the window cleared at DISCONT", m_clear_at_break, "discont"),
    ("the group target ignored", m_group_ignored, "group"),
    ("P as the min", m_p_min, "group"),
    ("T not held while rising", m_t_not_held, "group"),
    ("no rise cap", m_no_rise_cap, "group_cap"),
    ("the cap as abandon-and-rejoin", m_abandon, "group_cap"),
    ("r2's video rule", m_r2_video, "video_late"),
    ("L stopped at the floor", m_l_floor, "steady_raise"),
    ("a negative delta alone", m_negative_alone, "steady"),
    ("engage at 0 ms, no let-go band", m_no_hysteresis, "hysteresis"),
    ("the target carrying a negative excess (r3)", m_negative_target, "live"),
    ("warm across a hole (fix 2)", m_warm_across_hole, "hole"),
]


def main():
    failures = 0
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    for name, fn in CASES.items():
        if only and name not in only:
            continue
        for label, ok in fn():
            print("%s %s" % ("PASS" if ok else "FAIL", label))
            failures += not ok
    if not only or "mutants" in only:
        for label, patch, case in MUTANTS:
            undo = patch()
            try:
                caught = not all(ok for _l, ok in CASES[case]())
            finally:
                undo()
            print("%s mutant caught: %s (%s)" % ("PASS" if caught else "FAIL", label, case))
            failures += not caught
    if failures:
        print("\n%d FAILURE(S) in drain_servo_test" % failures)
        return 1
    print("\nALL drain_servo_test TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
