#!/usr/bin/env python3
"""The Python reference of mrasrc's servo (plan ch. 7 part 4.4, WI-P3-5; register B-125): the
decode bypass, the device term and the product ratio, prototyped first and kept as the reference
mrts::AsrcServo ports rule for rule (OQ-1, ADR-0029 S0 choice 1, S30). Nothing loads it at runtime.

It ports what the servo runs on: mrts::ClockLock (ts_stc) under the ASRC's configurations (no
backlog rule, no window rule: both are 0 there), and Phase 1's capture servo (asrc_servo), whose
behaviour it keeps bit for bit. Phase 3 adds, by configuration:
  - decode (`bypass_ppb` > 0): the lock runs on input frame index against buffer PTS, which a
    formula demux makes content time. Bypassed while |eps| <= the bound and |phase| <= 1 ms: at
    equal rates without a device term each buffer passes unchanged. Engaged once |eps| has stayed
    past the bound for 10 s of lock, or |phase| > 1 ms: Phase 1's servo from that buffer on, its
    counter from the buffer's PTS when it was passing (the element primes its resampler with the
    passed history). Engaged until a DISCONT or a GAP: then measured afresh, the resampler's tail
    drained first. An envelope step moves the timeline, not the content: labels re-anchored.
  - device (`device`): the commanded ratio is the decode term times the device term
    (1 + eps_dev, from AsrcDeviceLock on the sink's (itime, etime) pairs); the output counter is
    contiguous from the first PTS, re-anchored where the content breaks (device-time labels).
  - bypass_ppb = 0 with the device term: the device term alone, no lock (S17).

asrc_bypass_ref_test.py holds the cases tests/asrc_servo_test.cpp ports, and replays this module
against `mrts_cli asrc` (the C++) on the same call sequences (`replay`).
"""
import sys
from collections import deque

E9 = 1000000000
Q16 = 65536
DELTA_LIM = 1 << 60
FIT_X_LIM = 1 << 40
FIT_Y_LIM = 1 << 30
I64_MAX = (1 << 63) - 1
I64_MIN = -(1 << 63)


# --- integer helpers: C++ int64 semantics ------------------------------------------------------

def floor_div(a, b):
    return a // b


def tdiv(a, b):
    """C++ `/`: truncation toward zero."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def tmod(a, b):
    return a - b * tdiv(a, b)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def sat_add(a, b):
    return clamp(a + b, I64_MIN, I64_MAX)


def sat_sub(a, b):
    return clamp(a - b, I64_MIN, I64_MAX)


def mul_ppb(x, ppb):
    """floor(x * ppb / 1e9), x and ppb clamped as ts_stc.cpp does."""
    x = clamp(x, -DELTA_LIM, DELTA_LIM)
    ppb = clamp(ppb, -E9, E9)
    q = floor_div(x, E9)
    return q * ppb + floor_div((x - q * E9) * ppb, E9)


def half_frames_ns(h, hz):
    """floor(h * 1e9 / (2 * hz)): a position in half frames as ns."""
    d = 2 * hz
    q = floor_div(h, d)
    return q * E9 + (h - q * d) * E9 // d


# --- ClockLock (ts_stc.cpp), the ASRC's subset ------------------------------------------------

class ClockLockConfig:
    def __init__(self, **kw):
        self.bucket_ns = 1000000000
        self.rate_buckets_min = 30
        self.rate_buckets_max = 300
        self.rate_tau_ns = 120000000000
        self.rate_warn_ppm = 100
        self.rate_max_ppm = 1000
        self.rate_refit_mads = 2
        self.offset_buckets = 10
        self.slew_acquire_ppm = 2000
        self.acquire_ns = 5000000000
        self.slew_track_ppm = 20
        self.step_ns = 20000000
        self.step_hold_ns = 10000000000
        self.step_falls = False
        self.backlog_ns = 490000000
        self.step_fall_hold_ns = 300000000000
        self.lost_ns = 5000000000
        for k, v in kw.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)

    def copy(self):
        return ClockLockConfig(**vars(self))


K_SCATTERED_DEN = 2

# The decode lock's first fit (S16; B-125 has the prototype's sweep over 3 to 30).
DECODE_FIRST_FIT_BUCKETS = 10


def asrc_lock_config():
    """The capture lock: the STC's constants, a 50 ms two-sided step, no backlog rule."""
    c = ClockLockConfig()
    c.step_ns = 50000000
    c.step_falls = True
    c.backlog_ns = 0
    c.step_fall_hold_ns = 0
    return c


def asrc_decode_lock_config():
    """The capture lock with a short first fit: a demux's PTS carry no arrival jitter."""
    c = asrc_lock_config()
    c.rate_buckets_min = DECODE_FIRST_FIT_BUCKETS
    return c


FIT, CANDIDATE, OUT = 0, 1, 2
AGREE, RISE, FALL = 0, 1, 2


class Point:
    __slots__ = ("sigma", "house", "level", "eps")

    def __init__(self, sigma, house, level=FIT, eps=0):
        self.sigma, self.house, self.level, self.eps = sigma, house, level, eps


class StcLine:
    __slots__ = ("sigma_ref", "house_ref", "rate_ppb", "slew_ppb", "slew_ns")

    def __init__(self, sigma_ref=0, house_ref=0, rate_ppb=0, slew_ppb=0, slew_ns=0):
        self.sigma_ref, self.house_ref, self.rate_ppb = sigma_ref, house_ref, rate_ppb
        self.slew_ppb, self.slew_ns = slew_ppb, slew_ns

    def travel(self, sigma):
        if self.slew_ns == 0 or self.slew_ppb == 0:
            return 0
        d = sat_sub(sigma, self.sigma_ref)
        if d <= 0:
            return 0
        m = mul_ppb(d, self.slew_ppb)
        return min(m, self.slew_ns) if self.slew_ns > 0 else -min(m, -self.slew_ns)

    def house_of(self, sigma):
        d = clamp(sat_sub(sigma, self.sigma_ref), -DELTA_LIM, DELTA_LIM)
        return sat_add(sat_add(sat_add(self.house_ref, d), mul_ppb(d, self.rate_ppb)),
                       self.travel(sigma))


def _median(v):
    return sorted(v)[(len(v) - 1) // 2]


def _ls_fit(X, Y, keep):
    """ts_stc.cpp ls_fit: (mx, my, ppb), or None."""
    n = sx = sy = 0
    for i in range(len(X)):
        if keep is not None and not keep[i]:
            continue
        n += 1
        sx += X[i]
        sy += Y[i]
    if n < 3:
        return None
    mx, my = floor_div(sx, n), floor_div(sy, n)
    cx = cy = sxx = sxy = 0
    for i in range(len(X)):
        if keep is not None and not keep[i]:
            continue
        x, y = X[i] - mx, Y[i] - my
        cx += x
        cy += y
        sxx += x * x
        sxy += x * y
    den = sxx - tdiv(cx * cx, n)
    num = sxy - tdiv(cx * cy, n)
    if den <= 0:
        return None
    q = clamp(tdiv(num, den), -1000000, 1000000)
    return mx, my, 1000 * q + tdiv(1000 * tmod(num, den), den)


class ClockLock:
    """Lower-envelope lock of remote time to arrival time, as mrts::ClockLock builds it; the
    backlog and window rules are left out, as the ASRC's configurations turn both off."""
    ACQUIRING, LOCKED, LOST = "acquiring", "locked", "lost"

    def __init__(self, cfg):
        c = cfg.copy()
        if c.backlog_ns != 0 or c.step_fall_hold_ns != 0:
            raise ValueError("this reference holds the ASRC's locks only (no backlog rule)")
        c.bucket_ns = clamp(c.bucket_ns, 1000000, 10 * E9)
        c.rate_buckets_min = clamp(c.rate_buckets_min, 3, 1000)
        c.rate_buckets_max = clamp(c.rate_buckets_max, c.rate_buckets_min, 1000)
        c.rate_tau_ns = clamp(c.rate_tau_ns, c.bucket_ns, 10000 * E9)
        c.rate_max_ppm = clamp(c.rate_max_ppm, 0, 100000)
        c.rate_warn_ppm = clamp(c.rate_warn_ppm, 0, 100000)
        c.rate_refit_mads = clamp(c.rate_refit_mads, 0, 1000)
        c.offset_buckets = clamp(c.offset_buckets, 1, 1000)
        c.slew_acquire_ppm = clamp(c.slew_acquire_ppm, 0, 100000)
        c.slew_track_ppm = clamp(c.slew_track_ppm, 0, 100000)
        self.cfg = c
        self.started = False
        self.fresh = True
        self.floor_found = False
        self.line = StcLine()
        self.origin_h = self.level_h = self.win_h = 0
        self.bucket = 0
        self.cur = Point(0, 0)
        self.hist = deque()
        self.cand = False
        self.cand_h = 0
        self.rate_known = False
        self.eps_q16 = 0
        self.rate_n = 0
        self.rate_known_h = 0
        self.fit_valid = False
        self.fit_ppb_ = 0
        self.epoch_h = 0
        self.locked = False
        self.run = self.run_fall = False
        self.run_start_h = self.run_min = 0
        self.step_fired = False
        self.step_size = 0
        self.travel_ns = self.travel_at_lock = 0
        self.last_sample_h = self.last_seen_h = 0

    def eps_ppb(self):
        return floor_div(self.eps_q16 + Q16 // 2, Q16)

    ppb = eps_ppb

    def fit_ppb(self):
        return self.fit_ppb_

    def has_fit(self):
        return self.fit_valid

    def envelope_step(self):
        return self.step_fired

    def house_of(self, sigma):
        return self.line.house_of(sigma)

    def phase(self):
        if self.started and sat_sub(self.last_seen_h, self.last_sample_h) >= self.cfg.lost_ns:
            return self.LOST
        return self.LOCKED if self.locked else self.ACQUIRING

    def tick(self, now):
        if now > self.last_seen_h:
            self.last_seen_h = now

    def feed(self, sigma, h):
        c = self.cfg
        if not self.started:
            self.started = True
            self.line = StcLine(sigma, h, self.eps_ppb(), 0, 0)
            self.origin_h = self.epoch_h = self.win_h = h
            self.bucket = 0
            self.cur = Point(sigma, h)
            self.last_sample_h = self.last_seen_h = h
            return
        self.last_sample_h = max(self.last_sample_h, h)
        self.last_seen_h = max(self.last_seen_h, h)
        k = floor_div(sat_sub(h, self.origin_h), c.bucket_ns)
        if k > self.bucket:
            self._close_bucket(sigma, h)
            self.bucket = k
            self.cur = Point(sigma, h)
        elif sat_sub(h, sigma) < sat_sub(self.cur.house, self.cur.sigma):
            self.cur = Point(sigma, h)

    def _fit(self):
        c, hist = self.cfg, self.hist
        zi = len(hist)
        while zi > 0 and hist[zi - 1].level != FIT:
            zi -= 1
        if zi == 0:
            return None
        z = hist[zi - 1]
        dz = sat_sub(z.house, z.sigma)
        span = min(c.rate_buckets_max * c.bucket_ns, FIT_X_LIM)
        X, Y = [], []
        i = zi
        while i > 0:
            i -= 1
            if len(X) >= c.rate_buckets_max:
                break
            p = hist[i]
            if p.level != FIT:
                continue
            if sat_sub(z.house, p.house) > span:
                break
            dx = sat_sub(p.sigma, z.sigma)
            if dx < -FIT_X_LIM or dx > FIT_X_LIM:
                continue
            X.append(floor_div(dx, 1000000))
            Y.append(clamp(sat_sub(sat_sub(p.house, p.sigma), dz), -FIT_Y_LIM, FIT_Y_LIM))
        n = len(X)
        if n < c.rate_buckets_min:
            return None
        r1 = _ls_fit(X, Y, None)
        if r1 is None:
            return None
        mx, my, first = r1
        r = [(Y[i] - my) - tdiv(first * (X[i] - mx), 1000) for i in range(n)]
        mid = _median(r)
        dev = [r[i] - mid if r[i] > mid else mid - r[i] for i in range(n)]
        cut = c.rate_refit_mads * _median(dev)
        keep = [r[i] <= cut for i in range(n)]
        r2 = _ls_fit(X, Y, keep)
        return (r2[2] if r2 is not None else first), n

    def _classify(self, house_now):
        c, hist = self.cfg, self.hist
        b = hist[-1]
        step = c.step_ns
        drift = tdiv(2 * c.rate_max_ppm * c.bucket_ns, 1000000)
        lag = clamp(tdiv(step, max(drift, 1)), 1, c.rate_buckets_max)
        ref, seen = None, 0
        i = len(hist) - 1
        while i > 0:
            i -= 1
            if seen >= lag:
                break
            if hist[i].level == FIT:
                ref = hist[i]
                seen += 1
        eps = ref.eps if ref is not None else 0

        def u(p):
            return sat_sub(sat_sub(p.house, p.sigma), mul_ppb(sat_sub(p.sigma, b.sigma), eps))

        def set_level(frm, to):
            for p in hist:
                if p.level == frm:
                    p.level = to

        cmin, cmax = I64_MAX, I64_MIN
        for p in hist:
            if p.level == CANDIDATE:
                cmin = min(cmin, u(p))
                cmax = max(cmax, u(p))
        ub = u(b)
        if ref is None or (sat_sub(ub, u(ref)) <= step and sat_sub(u(ref), ub) <= step):
            b.level = FIT
            if ref is None:
                self.level_h = b.house
            if self.cand:
                set_level(CANDIDATE, OUT)
            self.cand = False
            return
        if not self.cand or sat_sub(ub, cmin) > step or sat_sub(cmax, ub) > step:
            set_level(CANDIDATE, OUT)
            self.cand = True
            self.cand_h = sat_add(self.origin_h, self.bucket * c.bucket_ns)
        b.level = CANDIDATE
        if sat_sub(house_now, self.cand_h) >= c.step_hold_ns:
            set_level(FIT, OUT)
            set_level(CANDIDATE, OUT)
            b.level = FIT
            self.level_h = b.house
            self.cand = False
            self.fit_valid = False

    def _level_share(self):
        on = since = 0
        for p in self.hist:
            if p.house < self.level_h:
                continue
            since += 1
            if p.level == FIT:
                on += 1
        return on, since

    def _seed_densest(self):
        c, hist = self.cfg, self.hist
        n = len(hist)
        if n < 2:
            return
        eps = self.eps_ppb()
        z = hist[-1]
        us = [sat_sub(sat_sub(p.house, p.sigma), mul_ppb(sat_sub(p.sigma, z.sigma), eps))
              for p in hist]

        def within(a, b):
            return sat_sub(a, b) <= c.step_ns and sat_sub(b, a) <= c.step_ns

        on, _ = self._level_share()
        best, centre = -1, 0
        for i in range(n):
            cnt = sum(1 for j in range(n) if within(us[j], us[i]))
            if cnt > best:
                best, centre = cnt, us[i]
        if best <= on:
            return
        oldest = I64_MAX
        for p, up in zip(hist, us):
            p.level = FIT if within(up, centre) else OUT
            if p.level == FIT:
                oldest = min(oldest, p.house)
        self.level_h = oldest
        self.cand = False

    def _seed_floor(self, below):
        c, hist, line = self.cfg, self.hist, self.line
        a = sat_sub(hist[-2].house, line.house_of(hist[-2].sigma))
        b = sat_sub(hist[-1].house, line.house_of(hist[-1].sigma))
        if sat_sub(b, a) > c.step_ns:
            return RISE
        if sat_sub(a, b) > c.step_ns:
            return FALL
        lo, hi = min(a, b), max(a, b)
        if hi >= -below:
            return AGREE
        line.house_ref = sat_add(line.house_ref, clamp(lo, -DELTA_LIM, DELTA_LIM))
        return AGREE

    def _close_bucket(self, sigma_now, house_now):
        c, hist, line = self.cfg, self.hist, self.line
        hist.append(self.cur)
        cap = max(c.rate_buckets_max, c.offset_buckets)
        while len(hist) > cap:
            hist.popleft()
        self.travel_ns += line.travel(sigma_now)
        line.house_ref = line.house_of(sigma_now)
        line.sigma_ref = sigma_now
        line.slew_ppb = line.slew_ns = 0
        hist[-1].eps = self.eps_ppb()
        self._classify(house_now)
        wait = False
        on, since = self._level_share()
        scattered = on * K_SCATTERED_DEN < since
        if not self.rate_known and scattered:
            wait = sat_sub(house_now, self.win_h) < c.rate_buckets_max * c.bucket_ns
            if not wait:
                self._seed_densest()
        if not wait:
            r = self._fit()
            if r is not None:
                f, n = r
                self.fit_valid = True
                self.fit_ppb_ = f
                lim = c.rate_max_ppm * 1000
                fc = clamp(f, -lim, lim)
                gap = fc - self.eps_ppb()
                off = gap > c.slew_track_ppm * 1000 or gap < -c.slew_track_ppm * 1000
                if not self.rate_known or n > self.rate_n or (off and not scattered):
                    if not self.rate_known:
                        self.rate_known_h = house_now
                    self.rate_known = True
                    self.eps_q16 = fc * Q16
                    self.rate_n = n
                else:
                    g = min(Q16, tdiv(c.bucket_ns * n * Q16, c.rate_tau_ns * c.rate_buckets_max))
                    self.eps_q16 += floor_div((fc * Q16 - self.eps_q16) * g, Q16)
        line.rate_ppb = self.eps_ppb()
        if (not self.locked and self.rate_known
                and sat_sub(house_now, max(self.epoch_h, self.rate_known_h)) >= c.acquire_ns):
            self.locked = True
            self.travel_at_lock = self.travel_ns
        if len(hist) >= 2 and self.fresh and not self.floor_found and not self.locked:
            self.floor_found = self._seed_floor(c.step_ns) != FALL
        e = I64_MAX
        for i in range(len(hist) - min(len(hist), c.offset_buckets), len(hist)):
            e = min(e, sat_sub(hist[i].house, line.house_of(hist[i].sigma)))
        e = clamp(e, -DELTA_LIM, DELTA_LIM)
        b = hist[-1]
        rb = sat_sub(b.house, line.house_of(b.sigma))
        cap_ppb = (c.slew_track_ppm if self.locked else c.slew_acquire_ppm) * 1000
        ae = -e if e < 0 else e
        line.slew_ppb = cap_ppb if ae >= tdiv(cap_ppb * c.bucket_ns, E9) else tdiv(ae * E9, c.bucket_ns)
        line.slew_ns = e
        if not self.locked or self.step_fired:
            self.run = False
            return
        fall = c.step_falls and rb < -c.step_ns
        if rb > c.step_ns or fall:
            if not self.run or self.run_fall != fall:
                self.run = True
                self.run_fall = fall
                self.run_start_h = sat_add(self.origin_h, self.bucket * c.bucket_ns)
                self.run_min = rb
            self.run_min = min(self.run_min, rb)
            if sat_sub(house_now, self.run_start_h) >= c.step_hold_ns:
                self.step_fired = True
                self.step_size = self.run_min
        else:
            self.run = False

    def relock(self, keep_rate):
        self.started = False
        self.fresh = False
        self.hist.clear()
        self.cand = False
        self.fit_valid = False
        self.locked = False
        self.run = self.step_fired = False
        self.step_size = 0
        self.travel_ns = self.travel_at_lock = 0
        if not keep_rate:
            self.rate_known = False
            self.eps_q16 = 0
            self.rate_n = 0

    def step_to_floor(self):
        if not self.step_fired:
            return
        while self.hist and self.hist[0].house < self.run_start_h:
            self.hist.popleft()
        e = I64_MAX
        for p in self.hist:
            e = min(e, sat_sub(p.house, self.line.house_of(p.sigma)))
        if e != I64_MAX:
            e = clamp(e, -DELTA_LIM, DELTA_LIM)
            self.line.house_ref = sat_add(self.line.house_ref, e)
            self.travel_ns += e
        self.line.slew_ppb = self.line.slew_ns = 0
        self.fit_valid = False
        self.run = self.step_fired = False
        self.step_size = 0


# --- the servo ---------------------------------------------------------------------------------

def rate_of(eps_ppb):
    """A clock's rate against house time in ppb, positive when it runs fast, from its lock's eps
    (house = (1 + eps) x its time): round(-eps / (1 + eps))."""
    e = clamp(eps_ppb, -E9 // 2, E9 // 2)
    return floor_div(-2 * e * E9 + E9 + e, 2 * (E9 + e))


class AsrcServoConfig:
    def __init__(self, **kw):
        self.lock = asrc_lock_config()
        self.phase_tau_ns = 10000000000
        self.ratio_max_ppm = 1000
        self.bypass_ppb = 0           # > 0: decode mode, bypassed while |eps| <= this
        self.bypass_phase_ns = 1000000
        self.bypass_hold_ns = 10000000000
        self.device = False           # the commanded ratio carries a device term
        for k, v in kw.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)


def decode_servo_config(bypass_ppb, device=False):
    return AsrcServoConfig(lock=asrc_decode_lock_config(), bypass_ppb=bypass_ppb, device=device)


class AsrcEvent:
    RELOCK, OUT_OF_BOUNDS, ENGAGED = "relock", "ratio-out-of-bounds", "engaged"

    def __init__(self, kind, reason, house_ns, value, dropped_ns=0, phase_ns=0):
        self.kind, self.reason, self.house_ns, self.value = kind, reason, house_ns, value
        self.dropped_ns, self.phase_ns = dropped_ns, phase_ns


class Command:
    __slots__ = ("in_rate", "out_rate", "relock", "skip", "pass_", "engage", "drain")

    def __init__(self, in_rate, out_rate, relock=False, skip=0):
        self.in_rate, self.out_rate, self.relock, self.skip = in_rate, out_rate, relock, skip
        self.pass_ = self.engage = self.drain = False


class AsrcServo:
    DROP_MAX_NS = E9
    MODES = ("capture", "bypass", "decode", "device", "decode+device")

    def __init__(self, in_hz, out_hz, cfg=None):
        cfg = cfg or AsrcServoConfig()
        self.cfg = AsrcServoConfig(**vars(cfg))
        self.cfg.lock = cfg.lock.copy()
        self.cfg.phase_tau_ns = clamp(cfg.phase_tau_ns, E9, 1000 * E9)
        self.cfg.ratio_max_ppm = clamp(cfg.ratio_max_ppm, 1, 100000)
        self.cfg.bypass_ppb = clamp(cfg.bypass_ppb, 0, 1000 * 1000)
        self.in_hz, self.out_hz = clamp(in_hz, 1000, 768000), clamp(out_hz, 1000, 768000)
        self.decode = self.cfg.bypass_ppb > 0
        self.capture = not self.decode and not self.cfg.device
        self.has_lock = not (self.cfg.device and not self.decode)
        self.lock = ClockLock(self.cfg.lock)
        self.started = False
        self.delay = 0
        self.n_in = 0
        self.drop_left = 0
        self.dropped = 0
        self.n_out = 0
        self.t0 = 0
        self.m = 0
        self.mh = 0            # house-rate frames since T0 (m with the device term taken out)
        self.mh_frac = 0       # ... and its fraction, ppb of a frame, in [0, 1e9)
        self.start2 = 0
        self.eps_cmd = 0
        self.dev_ppb = 0       # the device eps the last command carried
        self.phase_err = 0
        self.relocks = self.discont_in = 0
        self.oob = False
        self.events = []
        # Phase 3: decode and device modes.
        self.engaged = False
        self.passing = self.decode and not self.cfg.device and self.in_hz == self.out_hz
        self.over_since = None
        self.ended = False     # end_epoch(): the next push opens an epoch
        self.tail_t0 = self.tail_m = 0

    # Phase 1's accounting ---------------------------------------------------------------------
    def set_delay(self, frames):
        self.delay = frames

    def pts_at(self, m):
        return self.t0 + half_frames_ns(2 * m, self.out_hz)

    def next_pts(self):
        return self.pts_at(self.m)

    def epoch_frames(self):
        return self.m

    def _house_pts(self):
        """The house-rate counter's label of the next output: next_pts() unless a device term
        moves the output off house rate."""
        return self.t0 + half_frames_ns(2 * self.mh, self.out_hz) + self.mh_frac // self.out_hz

    def _next_pos2(self):
        if self.passing:
            return 2 * self.n_in
        return max(2 * (self.n_in + self.drop_left - self.delay) - 1, self.start2)

    def _frames_over(self, ns):
        return clamp(ns, 0, self.DROP_MAX_NS) * self.in_hz // (E9 + self.lock.ppb())

    def _measure_phase(self):
        if not self.has_lock:
            return 0
        return sat_sub(self.lock.house_of(half_frames_ns(self._next_pos2(), self.in_hz)),
                       self._house_pts())

    def _in_rate(self):
        num = self.in_hz * 1000 * (E9 + self.dev_ppb)
        den = E9 + self.eps_cmd
        r = (2 * num + den) // (2 * den)
        if r == self.out_hz * 1000:
            r += 1 if self._ratio_ppb() < 0 else -1
        return r

    def _ratio_ppb(self):
        """The commanded out/in against nominal, minus 1: the decode term times the device term."""
        d = E9 + self.dev_ppb
        return ((E9 + self.eps_cmd) * E9 + d // 2) // d - E9

    def mode(self):
        if self.capture:
            return "capture"
        if not self.decode:
            return "device"
        if self.cfg.device:
            return "decode+device" if self.engaged else "device"
        return "decode" if self.engaged else "bypass"

    def state(self):
        return "locked" if self.lock.phase() == ClockLock.LOCKED else "acquiring"

    def _open_epoch(self, why):
        """Phase 1: a relock's epoch, never before the end of the last output."""
        end = self.next_pts()
        at = self.lock.house_of(half_frames_ns(self._next_pos2(), self.in_hz))
        if at < end:
            self.drop_left += self._frames_over(sat_sub(end, at))
        self.start2 = self._next_pos2()
        self.m = self.mh = self.mh_frac = 0
        first = self.lock.house_of(half_frames_ns(self.start2, self.in_hz))
        self.t0 = max(end, first)
        self.relocks += 1
        self.events.append(AsrcEvent(AsrcEvent.RELOCK, why, self.t0, self.t0 - end, first - at))

    def _check_bounds(self, h):
        if not self.lock.has_fit():
            return
        f = self.lock.fit_ppb()
        af = -f if f < 0 else f
        lim = self.cfg.ratio_max_ppm * 1000
        if not self.oob and af > lim:
            self.oob = True
            self.events.append(AsrcEvent(AsrcEvent.OUT_OF_BOUNDS, "", h, f))
        elif self.oob and af < lim - lim // 10:
            self.oob = False

    # Phase 3 ----------------------------------------------------------------------------------
    def end_epoch(self):
        """Decode and device modes: the content breaks here, at a GAP and before a DISCONT buffer
        (push ends it too, but then the tail leaves after the relock's jump was measured). The
        next push opens an epoch at its PTS. True when the resampler holds a tail the caller
        drains now on tail_pts_at() (then resets it); capture mode keeps Phase 1's relock."""
        if self.capture or not self.started or self.ended:
            return False
        self.ended = True
        self.tail_t0, self.tail_m = self.t0, self.m
        return not self.passing

    def tail_pts_at(self, k):
        return self.tail_t0 + half_frames_ns(2 * (self.tail_m + k), self.out_hz)

    def tail_produced(self, frames):
        self.tail_m += frames
        self.n_out += frames

    def _new_epoch(self, pts, why):
        """Decode and device modes: measured afresh from this buffer, labels from its PTS. The
        jump is against the end of what left, the drained tail included."""
        end = self.tail_pts_at(0)
        self.engaged = False
        self.over_since = None
        self.passing = self.decode and not self.cfg.device and self.in_hz == self.out_hz
        self.start2 = 2 * self.n_in
        self.m = self.mh = self.mh_frac = 0
        self.t0 = pts
        self.drop_left = 0
        if self.has_lock:
            self.lock.relock(False)
        self.relocks += 1
        self.events.append(AsrcEvent(AsrcEvent.RELOCK, why, self.t0, self.t0 - end))

    def _step_epoch(self, pts):
        """Decode modes, an envelope step: labels from where the lock now puts the next output
        (passing: this PTS), the bypass or engaged state kept, nothing drained."""
        end = self.next_pts()
        self.start2 = self._next_pos2()
        self.m = self.mh = self.mh_frac = 0
        self.t0 = pts if self.passing else self.lock.house_of(half_frames_ns(self.start2, self.in_hz))
        self.over_since = None
        self.relocks += 1
        self.events.append(AsrcEvent(AsrcEvent.RELOCK, "envelope-step", self.t0, self.t0 - end))

    def _engage(self, pts, why, phase, cmd):
        self.engaged = True
        self.over_since = None
        self.events.append(AsrcEvent(AsrcEvent.ENGAGED, why, pts, rate_of(self.lock.ppb()),
                                     phase_ns=phase))
        if self.passing:
            # The caller primes its resampler with what passed: its next output is this
            # buffer's first frame, labelled with its PTS.
            self.passing = False
            cmd.engage = True
            self.t0 = pts
            self.m = self.mh = self.mh_frac = 0
            self.start2 = 2 * self.n_in

    def push(self, pts_ns, frames, discont, device_ppb=0):
        """Per buffer, before resampling: the command. `device_ppb`: the device lock's eps,
        read by the caller from AsrcDeviceLock (0 without a device term)."""
        lim = self.cfg.ratio_max_ppm * 1000
        self.dev_ppb = clamp(device_ppb, -lim, lim) if self.cfg.device else 0
        sigma = half_frames_ns(2 * self.n_in, self.in_hz)
        relocked = drain = False
        if self.capture:
            if not self.started:
                self.started = True
                self.lock.feed(sigma, pts_ns)
                self.t0 = self.lock.house_of(sigma)
            else:
                why = None
                if discont:
                    self.discont_in += 1
                    self.lock.relock(True)
                    why = "discont"
                self.lock.feed(sigma, pts_ns)
                if why is None and self.lock.envelope_step():
                    self.lock.step_to_floor()
                    why = "envelope-step"
                if why is not None:
                    self._open_epoch(why)
                    relocked = True
        else:
            if not self.started:
                self.started = True
                self.t0 = pts_ns
                self.start2 = 2 * self.n_in
                if self.has_lock:
                    self.lock.feed(sigma, pts_ns)
            elif discont or self.ended:
                # The content breaks: measured afresh, labels from this PTS.
                if discont:
                    self.discont_in += 1
                drain = self.end_epoch()
                self._new_epoch(pts_ns, "discont" if discont else "gap")
                if self.has_lock:
                    self.lock.feed(sigma, pts_ns)
                relocked = True
            elif self.has_lock:
                self.lock.feed(sigma, pts_ns)
                if self.lock.envelope_step():
                    # The timeline stepped, the content did not: the lock onto the new floor,
                    # the labels re-anchored on it, the resampler kept.
                    self.lock.step_to_floor()
                    self._step_epoch(pts_ns)
                    relocked = True
            self.ended = False
        if self.has_lock:
            self._check_bounds(pts_ns)
        self.phase_err = self._measure_phase()
        cmd = Command(0, self.out_hz * 1000, relocked, 0)
        cmd.drain = drain
        if self.decode and not self.engaged:
            eps = self.lock.ppb()
            if self.lock.phase() == ClockLock.LOCKED and abs(eps) > self.cfg.bypass_ppb:
                if self.over_since is None:
                    self.over_since = pts_ns
                if pts_ns - self.over_since >= self.cfg.bypass_hold_ns:
                    self._engage(pts_ns, "ratio", self.phase_err, cmd)
            else:
                self.over_since = None
            if not self.engaged and abs(self.phase_err) > self.cfg.bypass_phase_ns:
                self._engage(pts_ns, "phase", self.phase_err, cmd)
            if self.engaged:
                self.phase_err = self._measure_phase()
        if self.capture or self.engaged:
            p = clamp(self.phase_err, -9 * E9, 9 * E9)
            self.eps_cmd = clamp(self.lock.ppb() + floor_div(p * E9, self.cfg.phase_tau_ns), -lim, lim)
        else:
            self.eps_cmd = 0
        skip = min(self.drop_left, frames)
        self.drop_left -= skip
        self.dropped += skip
        self.n_in += frames
        cmd.in_rate = self._in_rate()
        cmd.skip = skip
        cmd.pass_ = self.passing
        return cmd

    def produced(self, frames):
        self.n_out += frames
        self.m += frames
        f = self.mh_frac + frames * self.dev_ppb
        self.mh += frames + floor_div(f, E9)
        self.mh_frac = f - floor_div(f, E9) * E9
        self.phase_err = self._measure_phase()

    def stats(self):
        return {
            "state": self.state(), "ratio-ppb": self._ratio_ppb(), "phase-err-ns": self.phase_err,
            "relocks": self.relocks, "in-frames": self.n_in, "out-frames": self.n_out,
            "discont-in": self.discont_in, "dropped-frames": self.dropped, "mode": self.mode(),
            "source-ppb": rate_of(self.lock.ppb()) if self.has_lock else 0,
        }

    def take_events(self):
        ev, self.events = self.events, []
        return ev


class AsrcDeviceLock:
    """The device term: a ClockLock on the sink's custom-slaving (itime, etime) pairs, device
    time against house time. A sink discontinuity relocks it, keeping the rate. The sink reads
    etime, then itime, so a preemption between them makes a pair early, which the lower envelope
    would follow: read_ns, from etime's read to the caller's re-read after itime's, moves the pair
    to that re-read, the latest instant itime can have been read, so every pair is late. The
    sink's first callback after its calibration reads the device before its ring runs (measured
    up to 0.33 ms early): a (re)lock's first SETTLE_NS of pairs are left out."""
    SETTLE_NS = 100000000

    def __init__(self, cfg=None):
        self.lock = ClockLock(cfg or asrc_decode_lock_config())
        self.relocks = 0
        self.first = None   # the house time of the (re)lock's first pair

    def feed(self, itime, etime, read_ns=0):
        h = etime + max(read_ns, 0)
        if self.first is None:
            self.first = h
        if h - self.first < self.SETTLE_NS:
            return
        self.lock.feed(itime, h)
        if self.lock.envelope_step():
            self.lock.step_to_floor()

    def discont(self):
        self.lock.relock(True)
        self.relocks += 1
        self.first = None

    def ppb(self):
        return self.lock.ppb()

    def rate_ppb(self):
        return rate_of(self.lock.ppb())

    def locked(self):
        return self.lock.phase() == ClockLock.LOCKED


# --- replay: the call sequences asrc_bypass_ref_test.py runs against `mrts_cli asrc` -----------

def _cmd_line(i, sv, c):
    return (f"b {i} {sv.mode()} in={c.in_rate} out={c.out_rate} relock={int(c.relock)} "
            f"skip={c.skip} pass={int(c.pass_)} engage={int(c.engage)} drain={int(c.drain)} "
            f"t0={sv.t0} m={sv.m} phase={sv.phase_err} ratio={sv._ratio_ppb()} "
            f"src={rate_of(sv.lock.ppb()) if sv.has_lock else 0}")


def _event_lines(sv):
    out = []
    for e in sv.take_events():
        out.append(f"e {e.kind} {e.reason or '-'} {e.house_ns} {e.value} {e.dropped_ns} {e.phase_ns}")
    return out


def replay(lines):
    """Runs a call sequence; returns the output lines `mrts_cli asrc` prints for it.
      cfg IN OUT BYPASS_PPB DEVICE DELAY [FIRST_FIT]   the servo (DEVICE 0/1)
      b PTS FRAMES DISCONT DEV_PPB                     push(); prints the command
      o K / t K                                        produced(K) / tail_produced(K)
      g                                                end_epoch(); prints its result
      d ITIME ETIME [READ] / x                         the device lock: a pair / a discontinuity
      p                                                prints the stats and the device lock"""
    out, sv, dev, n = [], None, None, 0
    for raw in lines:
        f = raw.split()
        if not f or f[0].startswith("#"):
            continue
        if f[0] == "cfg":
            in_hz, out_hz, bppb, device, delay = (int(x) for x in f[1:6])
            lockcfg = asrc_decode_lock_config() if bppb > 0 else asrc_lock_config()
            devcfg = asrc_decode_lock_config()
            if len(f) > 6:
                lockcfg.rate_buckets_min = devcfg.rate_buckets_min = int(f[6])
            cfg = AsrcServoConfig(lock=lockcfg, bypass_ppb=bppb, device=bool(device))
            sv = AsrcServo(in_hz, out_hz, cfg)
            sv.set_delay(delay)
            dev = AsrcDeviceLock(devcfg)
        elif f[0] == "b":
            c = sv.push(int(f[1]), int(f[2]), f[3] == "1", int(f[4]))
            out.append(_cmd_line(n, sv, c))
            out.extend(_event_lines(sv))
            n += 1
        elif f[0] == "o":
            sv.produced(int(f[1]))
        elif f[0] == "t":
            sv.tail_produced(int(f[1]))
        elif f[0] == "g":
            out.append(f"g {int(sv.end_epoch())} {sv.tail_pts_at(0)}")
        elif f[0] == "d":
            dev.feed(int(f[1]), int(f[2]), int(f[3]) if len(f) > 3 else 0)
        elif f[0] == "x":
            dev.discont()
        elif f[0] == "p":
            s = sv.stats()
            out.append("p " + " ".join(f"{k}={s[k]}" for k in s)
                       + f" dev-ppb={dev.ppb()} dev-rate={dev.rate_ppb()} dev-locked={int(dev.locked())}")
        else:
            raise ValueError(f"unknown line: {raw!r}")
    return out


if __name__ == "__main__":
    for line in replay(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin):
        print(line)
