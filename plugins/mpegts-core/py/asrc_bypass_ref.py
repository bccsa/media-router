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
    An unflagged PTS hole past the bound is lost time, a step back past it a break (B-148).
  - device (`device`): the commanded ratio is the decode term times the device term
    (1 + eps_dev, from asrc_device_ref.DeviceTerm on the device sink's clock read on a timer,
    B-166); the output counter is contiguous from the first PTS and stays on the device timeline
    across a break: a new epoch starts at the last content's label end plus the gap at the device
    ratio (B-148), the offset taken afresh at each relock-device.
  - bypass_ppb = 0 with the device term: the device term alone, no lock (S17).

asrc_bypass_ref_test.py holds the cases tests/asrc_servo_test.cpp ports, and replays this module
against `mrts_cli asrc` (the C++) on the same call sequences (`replay`).
"""
import sys

from asrc_device_ref import DeviceTerm
from clock_lock import E9, I64_MAX, I64_MIN, ClockLock, asrc_lock_config, clamp, sat_add, sat_sub  # noqa: F401


# --- integer helpers: C++ int64 semantics (the lock's own are clock_lock.py's) ----------------------

def floor_div(a, b):
    return a // b


def half_frames_ns(h, hz):
    """floor(h * 1e9 / (2 * hz)): a position in half frames as ns."""
    d = 2 * hz
    q = floor_div(h, d)
    return q * E9 + (h - q * d) * E9 // d


# The decode lock's first fit (S16; B-125 has the prototype's sweep over 3 to 30).
DECODE_FIRST_FIT_BUCKETS = 10


def asrc_decode_lock_config():
    """The capture lock with a short first fit: a demux's PTS carry no arrival jitter."""
    return asrc_lock_config().copy(rate_buckets_min=DECODE_FIRST_FIT_BUCKETS)


# --- the servo ---------------------------------------------------------------------------------

def rate_of(eps_ppb):
    """A clock's rate against house time in ppb, positive when it runs fast, from its lock's eps
    (house = (1 + eps) x its time): round(-eps / (1 + eps))."""
    e = clamp(eps_ppb, -E9 // 2, E9 // 2)
    return floor_div(-2 * e * E9 + E9 + e, 2 * (E9 + e))


def drift_over(g, eps_ppb):
    """g ns of house time on a clock whose lock reads eps (house = (1 + eps) x its time): how far
    that clock's time falls behind house time, floor(g eps / (1 + eps)) (B-148)."""
    return floor_div(g * eps_ppb, E9 + eps_ppb)


DRAIN_MAX_PPB = 5000000   # the drain's own clamp (B-179): 0.5 %


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
    RELOCK, OUT_OF_BOUNDS, ENGAGED, GAP = "relock", "ratio-out-of-bounds", "engaged", "gap"

    def __init__(self, kind, reason, house_ns, value, dropped_ns=0, phase_ns=0, lost_frames=0,
                 rate_known=False):
        self.kind, self.reason, self.house_ns, self.value = kind, reason, house_ns, value
        self.dropped_ns, self.phase_ns = dropped_ns, phase_ns
        self.lost_frames = lost_frames   # gap: input frames lost
        self.rate_known = rate_known     # engaged: the lock had a measured rate (B-148)


class Command:
    __slots__ = ("in_rate", "out_rate", "relock", "skip", "pass_", "engage", "drain", "gap")

    def __init__(self, in_rate, out_rate, relock=False, skip=0):
        self.in_rate, self.out_rate, self.relock, self.skip = in_rate, out_rate, relock, skip
        self.pass_ = self.engage = self.drain = self.gap = False


class AsrcServo:
    DROP_MAX_NS = E9
    LOST_MAX_NS = 1000 * E9   # the longest hole the output jumps at once
    OOB_HOLD_NS = 30 * E9     # decode: a fit past the bound this long while locked, before the event (B-148)
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
        self.lost = 0          # input frames lost between buffers: counted on the input position
        self.lost_res = 0      # decode modes: lost time's remainder under a frame (ns), on it too (B-148)
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
        self.drain_ppb = 0     # the drain it carried (B-179, device modes): input consumed (1 + drain) faster
        self.run_ppb = 0       # (1 + eps_dev)(1 + drain) - 1: house-rate frames per output frame
        self.phase_err = 0
        self.relocks = self.discont_in = self.gaps = 0
        self.oob = False
        self.events = []
        # Phase 3: decode and device modes.
        self.engaged = False
        self.passing = self.decode and not self.cfg.device and self.in_hz == self.out_hz
        self.over_since = None
        self.ended = False     # end_epoch(): the next push opens an epoch
        self.tail_t0 = self.tail_m = 0
        self.last_pts = self.last_frames = 0   # the last buffer: its PTS and frames
        # B-148: device mode, labels minus house time at T0, and that offset at the sink's last
        # calibration; decode, the PTS since which the fit has been past the bound while locked, and
        # whether the last buffer continued its predecessor within the lost-time bound.
        self.t0_dev = self.cal_off = 0
        self.oob_since = None
        self.cont = False

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
        return self.t0 - self.t0_dev + half_frames_ns(2 * self.mh, self.out_hz) + self.mh_frac // self.out_hz

    def _pos_ns(self, h2):
        """An input position in half frames as the lock's time: with lost time's remainder."""
        return half_frames_ns(h2, self.in_hz) + self.lost_res

    def _next_pos2(self):
        if self.passing:
            return 2 * (self.n_in + self.lost)
        return max(2 * (self.n_in + self.lost + self.drop_left - self.delay) - 1, self.start2)

    def _frames_over(self, ns):
        return clamp(ns, 0, self.DROP_MAX_NS) * self.in_hz // (E9 + self.lock.ppb())

    def _measure_phase(self):
        if not self.has_lock:
            return 0
        return sat_sub(self.lock.house_of(self._pos_ns(self._next_pos2())), self._house_pts())

    def _in_rate(self):
        num = self.in_hz * 1000 * (E9 + self.run_ppb)
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
        """Judged on the device rate fit, not on eps_cmd. Decode modes (B-148): past the bound while
        locked for OOB_HOLD_NS of PTS; no fit length, as a source past the clamp keeps cutting it."""
        if not self.lock.has_fit():
            return
        f = self.lock.fit_ppb()
        af = -f if f < 0 else f
        lim = self.cfg.ratio_max_ppm * 1000
        past = af > lim
        if self.decode:
            if past and self.lock.phase() == ClockLock.LOCKED:
                if self.oob_since is None:
                    self.oob_since = h
            else:
                self.oob_since = None
            past = self.oob_since is not None and h - self.oob_since >= self.OOB_HOLD_NS
        if not self.oob and past:
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
        if self.ended:   # drained before the next push: the house end counts it (B-148)
            self._house_advance(frames)

    def device_recalibrated(self):
        """The device term relocked (its ring acquired again, or its clock stepped: DeviceTerm's
        take_recalibrated): the device offset a new epoch carries restarts from the next output
        (B-148); the open epoch keeps its labels."""
        if self.cfg.device:
            self.cal_off = sat_sub(self._label_next(), self._house_pts())

    def _label_next(self):
        return self.tail_pts_at(0) if self.ended else self.next_pts()

    def _offset_at(self, h):
        """Device mode: labels minus house time for an epoch whose first output's content is at
        house time h: what ran up since the sink's calibration, less the device's drift over the
        gap from the last content's end (B-148). 0 without the device term."""
        if not self.cfg.device:
            return 0
        hend = self._house_pts()
        off = sat_sub(sat_sub(self._label_next(), hend), self.cal_off)
        return sat_sub(off, drift_over(sat_sub(h, hend), self.dev_ppb))

    def _new_epoch(self, pts, why):
        """Decode and device modes: measured afresh from this buffer, labels from its PTS (on the device
        timeline with the device term); the jump against the end of what left, the drained tail included."""
        end = self.tail_pts_at(0)
        off = self._offset_at(pts)
        self.engaged = False
        self.over_since = None
        self.oob_since = None
        self.cont = False
        self.passing = self.decode and not self.cfg.device and self.in_hz == self.out_hz
        self.start2 = 2 * (self.n_in + self.lost)
        self.m = self.mh = self.mh_frac = 0
        self.t0_dev, self.cal_off = off, 0
        self.t0 = sat_add(pts, off)
        self.drop_left = 0
        if self.has_lock:
            self.lock.relock(False)
        self.relocks += 1
        self.events.append(AsrcEvent(AsrcEvent.RELOCK, why, self.t0, self.t0 - end))

    def _step_epoch(self, pts):
        """Decode modes, an envelope step: labels from where the lock now puts the next output
        (passing: this PTS), the bypass or engaged state kept, nothing drained."""
        end = self.next_pts()
        start2 = self._next_pos2()
        h = pts if self.passing else self.lock.house_of(self._pos_ns(start2))
        off = self._offset_at(h)
        self.start2 = start2
        self.m = self.mh = self.mh_frac = 0
        self.t0_dev, self.cal_off = off, 0
        self.t0 = sat_add(h, off)
        self.over_since = None
        self.relocks += 1
        self.events.append(AsrcEvent(AsrcEvent.RELOCK, "envelope-step", self.t0, self.t0 - end))

    def _engage(self, pts, why, phase, cmd):
        self.engaged = True
        self.over_since = None
        self.events.append(AsrcEvent(AsrcEvent.ENGAGED, why, pts, rate_of(self.lock.ppb()),
                                     phase_ns=phase, rate_known=self.lock.rate_known))
        if self.passing:
            # The caller primes its resampler with what passed: its next output is this
            # buffer's first frame, labelled with its PTS.
            self.passing = False
            cmd.engage = True
            self.t0 = pts
            self.m = self.mh = self.mh_frac = 0
            self.start2 = 2 * (self.n_in + self.lost)

    def _frames_in(self, ns):
        """Lost time in input frames, to the nearest at the nominal rate."""
        return (2 * clamp(ns, 0, self.LOST_MAX_NS) * self.in_hz + E9) // (2 * E9)

    def _lose(self, frames, res=0):
        """Decode modes, lost time (B-148): the input position moves on by its frames and its part under a
        frame (res, ns), so the lock sees no step; the labels jump them, at the device ratio with the device term."""
        self.lost += frames
        self.lost_res += res
        frm = self.next_pts()
        jump = (2 * frames * self.out_hz + self.in_hz) // (2 * self.in_hz)
        self.m += jump
        self.mh += jump
        self.t0 += res
        if self.cfg.device:
            dr = drift_over(half_frames_ns(2 * jump, self.out_hz) + res, self.dev_ppb)
            self.t0 -= dr
            self.t0_dev -= dr
        self.gaps += 1
        nxt = self.next_pts()
        self.events.append(AsrcEvent(AsrcEvent.GAP, "lost-time", nxt, nxt - frm, lost_frames=frames))

    def _content_step(self, pts_ns):
        """Decode modes (B-148): this buffer's PTS against the last one's end past the bound (1 ms, or an
        upstream acquire slew's 2000 ppm of the last span), after a buffer that continued its own: up
        to LOST_MAX_NS lost time, back a break, else 0. A source off its rate steps every buffer."""
        if not self.decode or self.last_frames == 0:
            return 0
        span = half_frames_ns(2 * self.last_frames, self.in_hz)
        d = sat_sub(pts_ns, sat_add(self.last_pts, span))
        bound = max(self.cfg.bypass_phase_ns, span // 500)
        cont, self.cont = self.cont, -bound <= d <= bound
        return d if cont and (bound < d <= self.LOST_MAX_NS or d < -bound) else 0

    def push(self, pts_ns, frames, discont, device_ppb=0, drain_ppb=0):
        """Per buffer, before resampling: the command. `device_ppb`: the device lock's eps,
        read by the caller from the device term (DeviceTerm.device_ppb; 0 without one).
        `drain_ppb`: drain_servo's rate (B-179), device modes only, clamped to +-0.5 %."""
        lim = self.cfg.ratio_max_ppm * 1000
        self.dev_ppb = clamp(device_ppb, -lim, lim) if self.cfg.device else 0
        self.drain_ppb = clamp(drain_ppb, -DRAIN_MAX_PPB, DRAIN_MAX_PPB) if self.cfg.device else 0
        self.run_ppb = ((E9 + self.dev_ppb) * (E9 + self.drain_ppb) + E9 // 2) // E9 - E9
        sigma = self._pos_ns(2 * (self.n_in + self.lost))
        relocked = drain = gapped = False
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
            step = self._content_step(pts_ns) if self.started and not (discont or self.ended) else 0
            if not self.started:
                self.started = True
                self.t0 = pts_ns
                self.start2 = 2 * (self.n_in + self.lost)
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
            elif step < 0:
                # B-148: the content time stepped back past the bound, unflagged: a break.
                drain = self.end_epoch()
                self._new_epoch(pts_ns, "jump")
                self.lock.feed(sigma, pts_ns)
                relocked = True
            elif self.has_lock:
                if step > 0:
                    # B-148: a hole past the bound, unflagged: lost content time, the output
                    # jumping it (DISCONT on resampled output, same epoch), its part under a frame too.
                    lost = self._frames_in(step)
                    span = (half_frames_ns(2 * (self.n_in + self.lost + lost), self.in_hz)
                            - half_frames_ns(2 * (self.n_in + self.lost), self.in_hz))
                    self._lose(lost, step - span)
                    gapped = True
                self.lock.feed(self._pos_ns(2 * (self.n_in + self.lost)), pts_ns)
                if self.lock.envelope_step():
                    # The timeline stepped, the content did not: the lock onto the new floor,
                    # the labels re-anchored on it, the resampler kept.
                    self.lock.step_to_floor()
                    self._step_epoch(pts_ns)
                    relocked = True
            self.ended = False
        if frames > 0:
            self.last_pts, self.last_frames = pts_ns, frames
        if self.has_lock:
            self._check_bounds(pts_ns)
        self.phase_err = self._measure_phase()
        cmd = Command(0, self.out_hz * 1000, relocked, 0)
        cmd.drain = drain
        cmd.gap = gapped and not relocked
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

    def _house_advance(self, frames):
        """House-rate frames: each output frame is (1 + eps_dev)(1 + drain) of them (B-179)."""
        f = self.mh_frac + frames * self.run_ppb
        self.mh += frames + floor_div(f, E9)
        self.mh_frac = f - floor_div(f, E9) * E9

    def produced(self, frames):
        self.n_out += frames
        self.m += frames
        self._house_advance(frames)
        self.phase_err = self._measure_phase()

    def stats(self):
        return {
            "state": self.state(), "ratio-ppb": self._ratio_ppb(), "phase-err-ns": self.phase_err,
            "relocks": self.relocks, "in-frames": self.n_in, "out-frames": self.n_out,
            "discont-in": self.discont_in, "dropped-frames": self.dropped, "mode": self.mode(),
            "source-ppb": rate_of(self.lock.ppb()) if self.has_lock else 0,
            "gaps": self.gaps, "lost-frames": self.lost,
            "rate-known": int(self.has_lock and self.lock.rate_known),
            "drain-ppb": self.drain_ppb,
        }

    def take_events(self):
        ev, self.events = self.events, []
        return ev


# --- the device term on its timer, as mrasrc runs it (asrc_device_ref.DeviceTerm, B-166) ---------

def device_sample(term, sv, dev, mono):
    """One timer read of the device sink's clock, the term started at the first (the first rendered
    buffer); a relock-device it reports tells the servo before its next push (B-148's A1)."""
    if not term.rendering:
        term.start(mono)
    term.sample(dev, mono)
    _recalibrate(term, sv)


def device_restart(term, sv, mono):
    """The sink's ring released and acquired again (a caps change, a restart): its clock starts again."""
    term.stop(mono)
    term.start(mono)
    _recalibrate(term, sv)


def _recalibrate(term, sv):
    if term.take_recalibrated():
        sv.device_recalibrated()


# --- replay: the call sequences asrc_bypass_ref_test.py runs against `mrts_cli asrc` -----------

def _cmd_line(i, sv, c):
    return (f"b {i} {sv.mode()} in={c.in_rate} out={c.out_rate} relock={int(c.relock)} "
            f"skip={c.skip} pass={int(c.pass_)} engage={int(c.engage)} drain={int(c.drain)} "
            f"gap={int(c.gap)} t0={sv.t0} m={sv.m} phase={sv.phase_err} ratio={sv._ratio_ppb()} "
            f"src={rate_of(sv.lock.ppb()) if sv.has_lock else 0}")


def _event_lines(sv):
    out = []
    for e in sv.take_events():
        out.append(f"e {e.kind} {e.reason or '-'} {e.house_ns} {e.value} {e.dropped_ns} {e.phase_ns} "
                   f"{e.lost_frames} {int(e.rate_known)}")
    return out


def replay(lines):
    """Runs a call sequence; returns the output lines `mrts_cli asrc` prints for it.
      cfg IN OUT BYPASS_PPB DEVICE DELAY [FIRST_FIT]   the servo (DEVICE 0/1)
      b PTS FRAMES DISCONT DEV_PPB [DRAIN_PPB]         push(); prints the command
      o K / t K                                        produced(K) / tail_produced(K)
      g                                                end_epoch(); prints its result
      s DEV MONO                                       a timer read of the device sink's clock
      r MONO                                           the sink's ring acquired again (device_restart)
      p                                                prints the stats and the device term"""
    out, sv, term, n = [], None, None, 0
    for raw in lines:
        f = raw.split()
        if not f or f[0].startswith("#"):
            continue
        if f[0] == "cfg":
            in_hz, out_hz, bppb, device, delay = (int(x) for x in f[1:6])
            lockcfg = asrc_decode_lock_config() if bppb > 0 else asrc_lock_config()
            if len(f) > 6:
                lockcfg.rate_buckets_min = int(f[6])
            cfg = AsrcServoConfig(lock=lockcfg, bypass_ppb=bppb, device=bool(device))
            sv = AsrcServo(in_hz, out_hz, cfg)
            sv.set_delay(delay)
            term = DeviceTerm()
        elif f[0] == "b":
            c = sv.push(int(f[1]), int(f[2]), f[3] == "1", int(f[4]), int(f[5]) if len(f) > 5 else 0)
            out.append(_cmd_line(n, sv, c))
            out.extend(_event_lines(sv))
            n += 1
        elif f[0] == "o":
            sv.produced(int(f[1]))
        elif f[0] == "t":
            sv.tail_produced(int(f[1]))
        elif f[0] == "g":
            out.append(f"g {int(sv.end_epoch())} {sv.tail_pts_at(0)}")
        elif f[0] == "s":
            device_sample(term, sv, int(f[1]), int(f[2]))
        elif f[0] == "r":
            device_restart(term, sv, int(f[1]))
        elif f[0] == "p":
            s = sv.stats()
            out.append("p " + " ".join(f"{k}={s[k]}" for k in s)
                       + f" dev-ppb={term.device_ppb()} dev-rate={rate_of(term.device_ppb())}"
                       + f" dev-lock={term.lock_state()} dev-relocks={sum(term.relocks.values())}")
        else:
            raise ValueError(f"unknown line: {raw!r}")
    return out


if __name__ == "__main__":
    for line in replay(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin):
        print(line)
