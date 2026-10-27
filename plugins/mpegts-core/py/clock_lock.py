#!/usr/bin/env python3
"""mrts::ClockLock (../native/mrts/ts_stc.{h,cpp}) in Python, integer for integer: the lock the
device term's reference runs (asrc_device_ref.py, plan ch. 8 WI-P4-4, ch. 15.4 B-165). A
reference only: nothing loads it at runtime (ADR-0029 choice 1, plan OQ-1).

Lower-envelope lock of remote time to arrival time: per bucket of house time the sample with the
least delay (arrival - remote), a least-squares rate fit on those minima (refit without the points
more than rate_refit_mads MADs above the first line), a first-order loop on the fits, the line's
offset slewed to the minimum of the last offset_buckets buckets, levels and an envelope step past
step_ns held step_hold_ns. C++ int64 semantics throughout (truncating `/` and `%`, floor_div,
saturation), so a replay agrees with the C++ class exactly. Only the paths a configuration without
the backlog rule reaches are here (backlog_ns = 0 and step_fall_hold_ns = 0, as every ASRC lock
runs): a configuration with it is refused. The method names follow the C++ class.
"""
from collections import deque

E9 = 1000000000
Q16 = 65536
I64_MAX = (1 << 63) - 1
I64_MIN = -(1 << 63)
DELTA_LIM = 1 << 60     # |sigma - sigma_ref| a mapping evaluates
FIT_X_LIM = 1 << 40     # fit points within 1100 s of the newest
FIT_Y_LIM = 1 << 30     # fit delays within +-1.07 s of the newest
SCATTERED_DEN = 2       # ClockLockConfig::kScatteredDen (B-100)
FIT, CANDIDATE, OUT = 0, 1, 2


# --- C++ int64 semantics -----------------------------------------------------------------------

def tdiv(a, b):
    """C++ `/`: truncation toward zero."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def tmod(a, b):
    """C++ `%`: the dividend's sign."""
    return a - b * tdiv(a, b)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def sat_add(a, b):
    return clamp(a + b, I64_MIN, I64_MAX)


def sat_sub(a, b):
    return clamp(a - b, I64_MIN, I64_MAX)


def mul_ppb(x, ppb):
    """floor(x * ppb / 1e9) without forming the product, as ts_stc.cpp does."""
    x = clamp(x, -DELTA_LIM, DELTA_LIM)
    ppb = clamp(ppb, -E9, E9)
    q = x // E9
    return q * ppb + ((x - q * E9) * ppb) // E9


def median(v):
    """std::nth_element at (n - 1) / 2."""
    return sorted(v)[(len(v) - 1) // 2]


def ls_fit(X, Y, keep):
    """ts_stc.cpp's ls_fit, x in ms by y in ns: (mx, my, ppb), or None."""
    n = sx = sy = 0
    for i in range(len(X)):
        if keep is None or keep[i]:
            n += 1
            sx += X[i]
            sy += Y[i]
    if n < 3:
        return None
    mx, my = sx // n, sy // n
    cx = cy = sxx = sxy = 0
    for i in range(len(X)):
        if keep is None or keep[i]:
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


# --- the configuration -------------------------------------------------------------------------

class ClockLockConfig:
    """ClockLockConfig's fields and defaults (the STC's constants, ch. 5 part 4.3)."""

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
        self.residual_window_ns = 2000000000
        for k, v in kw.items():
            if not hasattr(self, k):
                raise AttributeError(k)
            setattr(self, k, v)

    def copy(self, **kw):
        c = ClockLockConfig(**vars(self))
        for k, v in kw.items():
            if not hasattr(c, k):
                raise AttributeError(k)
            setattr(c, k, v)
        return c


def asrc_lock_config():
    """asrc_servo.cpp's: the STC's constants, a 50 ms two-sided step, no backlog rule."""
    return ClockLockConfig(step_ns=50000000, step_falls=True, backlog_ns=0, step_fall_hold_ns=0)


# --- the lock ----------------------------------------------------------------------------------

class Point:
    __slots__ = ("sigma", "house", "level", "eps")

    def __init__(self, sigma, house, level=FIT, eps=0):
        self.sigma, self.house, self.level, self.eps = sigma, house, level, eps


class StcLine:
    """house(sigma) = house_ref + d + d * rate + the slew, d = sigma - sigma_ref."""
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
        return sat_add(sat_add(sat_add(self.house_ref, d), mul_ppb(d, self.rate_ppb)), self.travel(sigma))


class ClockLock:
    ACQUIRING, LOCKED, LOST = "acquiring", "locked", "lost"

    def __init__(self, cfg=None):
        c = (cfg or ClockLockConfig()).copy()
        if c.backlog_ns != 0 or c.step_fall_hold_ns != 0:
            raise ValueError("clock_lock.py holds ClockLock without the backlog rule only")
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
        self.fresh = True           # no relock yet
        self.floor_found = False
        self.after_step = False
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
        self.resid = deque()

    # --- the C++ class's public surface ----------------------------------------------------

    def eps_ppb(self):
        return (self.eps_q16 + Q16 // 2) // Q16

    def ppb(self):
        return self.eps_ppb()

    def fit_ppb(self):
        return self.fit_ppb_

    def has_fit(self):
        return self.fit_valid

    def envelope_step(self):
        return self.step_fired

    def house_of(self, sigma):
        return self.line.house_of(sigma)

    def offset_drift_ns(self):
        return self.travel_ns - self.travel_at_lock if self.locked else 0

    def phase(self):
        if self.started and sat_sub(self.last_seen_h, self.last_sample_h) >= self.cfg.lost_ns:
            return self.LOST
        return self.LOCKED if self.locked else self.ACQUIRING

    def tick(self, now):
        if now > self.last_seen_h:
            self.last_seen_h = now

    def feed(self, sigma, h):
        if not self.started:
            self.started = True
            self.line = StcLine(sigma, h, self.eps_ppb(), 0, 0)
            self.origin_h = self.epoch_h = h
            self.win_h = h
            self.bucket = 0
            self.cur = Point(sigma, h)
            self.last_sample_h = self.last_seen_h = h
            self.resid.append((h, 0))
            return
        self.last_sample_h = max(self.last_sample_h, h)
        self.last_seen_h = max(self.last_seen_h, h)
        self.resid.append((h, sat_sub(h, self.line.house_of(sigma))))
        while self.resid[0][0] < sat_sub(self.last_sample_h, self.cfg.residual_window_ns):
            self.resid.popleft()
        k = sat_sub(h, self.origin_h) // self.cfg.bucket_ns
        if k > self.bucket:
            self._close_bucket(sigma, h)
            self.bucket = k
            self.cur = Point(sigma, h)
        elif sat_sub(h, sigma) < sat_sub(self.cur.house, self.cur.sigma):
            self.cur = Point(sigma, h)

    def residual(self):
        """(min, p50, p99, max, count) of arrival - house(sigma) over residual_window_ns."""
        if not self.resid:
            return 0, 0, 0, 0, 0
        v = sorted(r for _, r in self.resid)
        n = len(v)
        return v[0], v[(n - 1) // 2], v[tdiv(99 * n + 99, 100) - 1], v[-1], n

    def relock(self, keep_rate, after_step=False):
        """A new epoch from the next sample; the rate stays as its starting guess with keep_rate."""
        self.started = False
        self.fresh = False
        self.after_step = after_step
        self.hist.clear()
        self.cand = False
        self.resid.clear()
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
        e = None
        for p in self.hist:
            r = sat_sub(p.house, self.line.house_of(p.sigma))
            e = r if e is None else min(e, r)
        if e is not None:
            e = clamp(e, -DELTA_LIM, DELTA_LIM)
            self.line.house_ref = sat_add(self.line.house_ref, e)
            self.travel_ns += e
        self.line.slew_ppb = self.line.slew_ns = 0
        self.resid.clear()
        self.fit_valid = False
        self.run = self.step_fired = False
        self.step_size = 0

    # --- ts_stc.cpp's private part ---------------------------------------------------------

    def _fit(self):
        """(ppb, n) of the fit level's last rate_buckets_max buckets, or None."""
        c = self.cfg
        zi = len(self.hist)
        while zi > 0 and self.hist[zi - 1].level != FIT:
            zi -= 1
        if zi == 0:
            return None
        z = self.hist[zi - 1]
        dz = sat_sub(z.house, z.sigma)
        span = min(c.rate_buckets_max * c.bucket_ns, FIT_X_LIM)
        X, Y = [], []
        i = zi
        while i > 0 and len(X) < c.rate_buckets_max:
            i -= 1
            p = self.hist[i]
            if p.level != FIT:
                continue
            if sat_sub(z.house, p.house) > span:
                break   # an outage must not stretch the window
            dx = sat_sub(p.sigma, z.sigma)
            if dx < -FIT_X_LIM or dx > FIT_X_LIM:
                continue
            X.append(dx // 1000000)
            Y.append(clamp(sat_sub(sat_sub(p.house, p.sigma), dz), -FIT_Y_LIM, FIT_Y_LIM))
        n = len(X)
        first = ls_fit(X, Y, None) if n >= c.rate_buckets_min else None
        if first is None:
            return None
        mx, my, f1 = first
        r = [(Y[j] - my) - tdiv(f1 * (X[j] - mx), 1000) for j in range(n)]
        mid = median(r)
        cut = c.rate_refit_mads * median([x - mid if x > mid else mid - x for x in r])
        second = ls_fit(X, Y, [x <= cut for x in r])
        return (second[2] if second is not None else f1), n

    def _set_level(self, frm, to):
        for p in self.hist:
            if p.level == frm:
                p.level = to

    def _classify(self, house_now):
        c = self.cfg
        b = self.hist[-1]
        step = c.step_ns
        drift = tdiv(2 * c.rate_max_ppm * c.bucket_ns, 1000000)   # per bucket
        lag = clamp(tdiv(step, max(drift, 1)), 1, c.rate_buckets_max)
        ref = None
        seen = 0
        i = len(self.hist) - 1
        while i > 0 and seen < lag:
            i -= 1
            if self.hist[i].level == FIT:
                ref = self.hist[i]
                seen += 1
        eps = ref.eps if ref is not None else 0

        def u(p):   # minimum delay at b's sigma along that rate
            return sat_sub(sat_sub(p.house, p.sigma), mul_ppb(sat_sub(p.sigma, b.sigma), eps))

        cmin, cmax = I64_MAX, I64_MIN
        for p in self.hist:
            if p.level == CANDIDATE:
                cmin = min(cmin, u(p))
                cmax = max(cmax, u(p))
        ub = u(b)
        if ref is None or (sat_sub(ub, u(ref)) <= step and sat_sub(u(ref), ub) <= step):
            b.level = FIT
            if ref is None:
                self.level_h = b.house
            if self.cand:
                self._set_level(CANDIDATE, OUT)
            self.cand = False
            return
        if not self.cand or sat_sub(ub, cmin) > step or sat_sub(cmax, ub) > step:
            self._set_level(CANDIDATE, OUT)
            self.cand = True
            self.cand_h = sat_add(self.origin_h, self.bucket * c.bucket_ns)
        b.level = CANDIDATE
        if sat_sub(house_now, self.cand_h) >= c.step_hold_ns:
            self._set_level(FIT, OUT)
            self._set_level(CANDIDATE, OUT)
            b.level = FIT
            self.level_h = b.house
            self.cand = False
            self.fit_valid = False

    def _level_share(self):
        on = since = 0
        for p in self.hist:
            if p.house >= self.level_h:
                since += 1
                on += p.level == FIT
        return on, since

    def _seed_densest(self):
        if len(self.hist) < 2:
            return
        eps = self.eps_ppb()
        z = self.hist[-1]
        us = [sat_sub(sat_sub(p.house, p.sigma), mul_ppb(sat_sub(p.sigma, z.sigma), eps)) for p in self.hist]

        def within(a, b):
            return sat_sub(a, b) <= self.cfg.step_ns and sat_sub(b, a) <= self.cfg.step_ns

        on, _ = self._level_share()
        best, centre = -1, 0
        for ci in us:
            cnt = sum(1 for uj in us if within(uj, ci))
            if cnt > best:
                best, centre = cnt, ci
        if best <= on:
            return
        oldest = I64_MAX
        for p, up in zip(self.hist, us):
            p.level = FIT if within(up, centre) else OUT
            if p.level == FIT:
                oldest = min(oldest, p.house)
        self.level_h = oldest
        self.cand = False

    def _seed_floor(self, below):
        a_p, b_p = self.hist[-2], self.hist[-1]
        a = sat_sub(a_p.house, self.line.house_of(a_p.sigma))
        b = sat_sub(b_p.house, self.line.house_of(b_p.sigma))
        if sat_sub(b, a) > self.cfg.step_ns:
            return "rise"
        if sat_sub(a, b) > self.cfg.step_ns:
            return "fall"
        if max(a, b) >= -below:
            return "agree"
        self.line.house_ref = sat_add(self.line.house_ref, clamp(min(a, b), -DELTA_LIM, DELTA_LIM))
        self.resid.clear()
        return "agree"

    def _close_bucket(self, sigma_now, house_now):
        c = self.cfg
        self.hist.append(self.cur)
        while len(self.hist) > max(c.rate_buckets_max, c.offset_buckets):
            self.hist.popleft()
        # Re-pivot where the source is now: the mapping stays continuous.
        self.travel_ns += self.line.travel(sigma_now)
        self.line.house_ref = self.line.house_of(sigma_now)
        self.line.sigma_ref = sigma_now
        self.line.slew_ppb = self.line.slew_ns = 0
        self.hist[-1].eps = self.eps_ppb()
        self._classify(house_now)
        wait = False
        on, since = self._level_share()
        scattered = on * SCATTERED_DEN < since
        if not self.rate_known and scattered:
            wait = sat_sub(house_now, self.win_h) < c.rate_buckets_max * c.bucket_ns
            if not wait:
                self._seed_densest()
        fitted = None if wait else self._fit()
        if fitted is not None:
            f, n = fitted
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
                self.eps_q16 += ((fc * Q16 - self.eps_q16) * g) // Q16
        self.line.rate_ppb = self.eps_ppb()
        if (not self.locked and self.rate_known
                and sat_sub(house_now, max(self.epoch_h, self.rate_known_h)) >= c.acquire_ns):
            self.locked = True
            self.travel_at_lock = self.travel_ns
        if len(self.hist) >= 2 and self.fresh and not self.floor_found and not self.locked:
            self.floor_found = self._seed_floor(c.step_ns) != "fall"
        # beta* - beta_applied: min over the last M buckets, against the line through the pivot.
        e = I64_MAX
        for i in range(len(self.hist) - min(len(self.hist), c.offset_buckets), len(self.hist)):
            p = self.hist[i]
            e = min(e, sat_sub(p.house, self.line.house_of(p.sigma)))
        e = clamp(e, -DELTA_LIM, DELTA_LIM)
        b = self.hist[-1]
        rb = sat_sub(b.house, self.line.house_of(b.sigma))
        cap_ppb = (c.slew_track_ppm if self.locked else c.slew_acquire_ppm) * 1000
        ae = -e if e < 0 else e
        self.line.slew_ppb = cap_ppb if ae >= tdiv(cap_ppb * c.bucket_ns, E9) else tdiv(ae * E9, c.bucket_ns)
        self.line.slew_ns = e
        if not self.locked or self.step_fired:
            self.run = False
            return
        fall = c.step_falls and rb < -c.step_ns
        if rb > c.step_ns or fall:
            if not self.run or self.run_fall != fall:   # a run keeps one direction
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
