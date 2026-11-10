#!/usr/bin/env python3
"""Cases for asrc_bypass_ref.py, the reference of mrasrc's servo (WI-P3-5, B-125), which
tests/asrc_servo_test.cpp ports with the same scenarios; then the reference and `mrts_cli asrc`
(the C++) replay the same call sequences and print the same lines (parity, S30).

A source runs at a known rate: frame n's content time is t0 + n / (fs (1 + p)) house seconds;
its PTS is that floored to 90 kHz ticks (the producer's mux) and ceil'd back to ns (the demux,
S12). A driver runs mrasrc's per-buffer flow on the servo with the C++ test's model of
GstAudioResampler's frame accounting (gst-plugins-base 1.28.2; Kaiser quality 4, 64 taps).
Also: Phase 1's capture runs reproduce the C++ test's printed checksums bit for bit.
Run:  python3 asrc_bypass_ref_test.py  (the parity half builds mrts_cli; it skips off Linux only)"""
import collections
import os
import random
import subprocess
import sys
import types
from math import gcd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asrc_bypass_ref as ar  # noqa: E402

S, MS, US = 10**9, 10**6, 10**3
H0 = 1000 * S
SUB = 1 << 14
M64 = (1 << 64) - 1
MRTS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "native", "mrts"))

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def ceil_div(a, b):
    return -((-a) // b)


def formula_pts(t_ns):
    """Content time through a producer's mux (floor to ticks) and the formula demux (ceil)."""
    return ceil_div((t_ns * 9 // 100000) * 100000, 9)


# --- the C++ test's models ---------------------------------------------------------------------

class Lcg:
    def __init__(self, seed):
        self.s = (seed * 0x9E3779B97F4A7C15 + 1) & M64

    def next(self):
        self.s = (self.s * 6364136223846793005 + 1442695040888963407) & M64
        return self.s >> 32


class Fnv:
    def __init__(self):
        self.h = 1469598103934665603

    def add(self, v):
        for i in range(8):
            self.h ^= (v >> (8 * i)) & 0xff
            self.h = (self.h * 1099511628211) & M64


class ModelResampler:
    """GstAudioResampler's frame accounting as tests/asrc_servo_test.cpp models it."""
    TAPS, OVERSAMPLE = 64, 8
    DELAY = 32

    def __init__(self, in_rate, out_rate):
        self.full = out_rate
        self.in_ = self.out = self.phase = 0
        self.avail = self.TAPS // 2 - 1
        self.hist0 = -(self.TAPS // 2 - 1)
        self.updates = 0
        self.update(in_rate, out_rate)

    def update(self, in_rate, out_rate):
        ph = self.phase * out_rate // self.out if self.out > 0 else 0
        g = gcd(in_rate, out_rate)
        while g > 1 and 20 * (ph % g) >= out_rate:
            f = 2
            while g % f:
                f += 1
            g //= f
        self.phase, self.in_, self.out = ph // g, in_rate // g, out_rate // g
        self.updates += 1

    def out_frames(self, in_frames):
        a = self.avail + in_frames
        if a < self.TAPS or (a - self.TAPS) * self.out < self.phase:
            return 0
        return ((a - self.TAPS) * self.out - self.phase) // self.in_ + 1

    def resample(self, in_frames, k):
        self.avail += in_frames
        if self.avail < self.TAPS or k == 0:
            return True
        t = self.phase + k * self.in_
        self.avail -= t // self.out
        self.hist0 += t // self.out
        self.phase = t % self.out
        return self.avail > 0

    def position(self):
        """Input position of the next output since the last reset, 1/SUB frames."""
        if self.in_ == self.out:
            return self.hist0 * SUB
        return ((self.hist0 + self.TAPS // 2 - 1) * SUB - SUB // self.OVERSAMPLE
                + self.phase * (self.full // self.out) * SUB // self.full)


class Device:
    """The C++ test's capture: input frame i at house H0 + i / (fs (1 + ppb))."""

    def __init__(self, fs, ppb):
        self.fs, self.ppb = fs, ppb
        self.gap_x, self.gap_ns = ar.I64_MAX, 0

    def fast_by(self, nom):
        d = S + self.ppb
        a = nom // S
        b = nom - a * S
        c = a * self.ppb
        qc = c // d
        return qc * S + ((c - qc * d) * S + b * self.ppb) // d

    def house(self, x):
        d = SUB * self.fs
        q = x // d
        nom = q * S + (x - q * d) * S // d
        return H0 + nom - self.fast_by(nom) + (self.gap_ns if x >= self.gap_x else 0)


def capture_run(ppb=0, secs=3600, jitter=MS, buf=1024, gap_s=-1, gap_ns=20 * MS, seed=1, in_hz=48000):
    """The C++ test's run() on the reference, to its checksum."""
    sv = ar.AsrcServo(in_hz, 48000)
    dev = Device(in_hz, ppb)
    gap_frame = gap_s * in_hz if gap_s >= 0 else ar.I64_MAX
    if gap_s >= 0:
        dev.gap_x, dev.gap_ns = gap_frame * SUB, gap_ns
    g, f, near = Lcg(seed), Fnv(), 2 * ModelResampler.TAPS * SUB
    n = n_res = cur = 0
    rs, drops = None, []

    def captured(x):
        d = 0
        for q in drops:
            if x >= q[0] * SUB:
                d = q[1]
        return x + d * SUB

    while n < secs * in_hz:
        b = buf if buf > 0 else 256 + g.next() % 1793
        if n < gap_frame < n + b:
            b = gap_frame - n
        j = g.next() % jitter if jitter > 0 else 0
        t = dev.house(n * SUB) - H0
        c = sv.push(H0 + t + j, b, n == 0 or n == gap_frame)
        if n == 0:
            rs = ModelResampler(c.in_rate, c.out_rate)
            sv.set_delay(ModelResampler.DELAY)
            cur = c.in_rate
        if c.in_rate != cur:
            rs.update(c.in_rate, c.out_rate)
            cur = c.in_rate
        fed = b - c.skip
        if c.skip > 0:
            if not drops or drops[-1][0] != n_res:
                drops.append([n_res, (drops[-1][1] if drops else 0) + c.skip])
            else:
                drops[-1][1] += c.skip
        k, label, x = rs.out_frames(fed), sv.next_pts(), rs.position()
        xc = captured(x)
        rs.resample(fed, k)
        n_res += fed
        sv.produced(k)
        if (k > 0 and (gap_s < 0 or xc < dev.gap_x - near or xc > dev.gap_x + near)
                and not any(abs(x - q[0] * SUB) < near for q in drops)):
            f.add(label - dev.house(xc))
        st = sv.stats()
        for e in sv.take_events():
            f.add({"relock": 0, "ratio-out-of-bounds": 1}[e.kind])
            f.add(e.house_ns)
            f.add(e.value)
            if e.kind == "relock" and e.dropped_ns:
                f.add(e.dropped_ns)
        f.add(c.in_rate)
        if c.skip:
            f.add(c.skip)
        f.add(label)
        f.add(k)
        f.add(st["phase-err-ns"])
        n += b
    f.add(sv.next_pts() - dev.house(captured(rs.position())))
    f.add(sv.stats()["out-frames"])
    return f.h


# --- mrasrc's per-buffer flow on the servo -----------------------------------------------------

class Out:
    __slots__ = ("label", "frames", "discont", "pos", "buf", "end", "content")

    def __init__(self, label, frames, discont, pos, buf, content=None):
        # pos: the input position of the first frame, 1/SUB frames of the global input index;
        # buf: the push it came from (-1: a drained tail); end: the counter's label after it;
        # content: its label on the house-rate counter (next_content_pts, B-166).
        self.label, self.frames, self.discont, self.pos, self.buf = label, frames, discont, pos, buf
        self.end = None
        self.content = content


class Driver:
    """The element's flow (gstmrasrc.cpp) on the servo and the resampler model; records every
    call as a replay line, and each output buffer as an Out."""
    HISTORY = 64

    def __init__(self, in_hz, out_hz, bypass_ppb=0, device=False, first_fit=None):
        self.in_hz, self.out_hz = in_hz, out_hz
        self.seq = [f"cfg {in_hz} {out_hz} {bypass_ppb} {int(device)} {ModelResampler.DELAY}"
                    + (f" {first_fit}" if first_fit else "")]
        lockcfg = ar.asrc_decode_lock_config() if bypass_ppb > 0 else ar.asrc_lock_config()
        if first_fit:
            lockcfg.rate_buckets_min = first_fit
        self.sv = ar.AsrcServo(in_hz, out_hz, ar.AsrcServoConfig(lock=lockcfg, bypass_ppb=bypass_ppb,
                                                                   device=device))
        self.sv.set_delay(ModelResampler.DELAY)
        self.term = ar.DeviceTerm()   # the device sink's clock on a 100 ms timer (B-166)
        self.rs = None
        self.base = 0          # global input index of the resampler's position 0
        self.cur = 0
        self.n = 0             # input frames pushed
        self.passed = 0        # frames passed since the epoch began: the priming history
        self.discard = 0
        self.events = []       # (push index, event)
        self.outputs = []
        self.cmds = []
        self.pts = []
        self.dppbs = []
        self.ratios = []
        self.locked_at = None  # the PTS of the first buffer the lock was locked after
        self.drain = 0         # the drain each push carries (B-179)

    def device_sample(self, dev, mono):
        """A timer read of the device sink's clock; a relock-device tells the servo (B-148's A1)."""
        self.seq.append(f"s {dev} {mono}")
        ar.device_sample(self.term, self.sv, dev, mono)

    def device_restart(self, mono):
        """The sink's ring released and acquired again: the term relocks, the servo told."""
        self.seq.append(f"r {mono}")
        ar.device_restart(self.term, self.sv, mono)

    def _drain(self):
        if self.rs is not None:
            k = self.rs.out_frames(ModelResampler.DELAY)
            pos = self.base * SUB + self.rs.position()
            self.rs.resample(ModelResampler.DELAY, k)
            if k:
                self.outputs.append(Out(self.sv.tail_pts_at(0), k, False, pos, -1))
            self.seq.append(f"t {k}")
            self.sv.tail_produced(k)
            if k:
                self.outputs[-1].end = self.sv.tail_pts_at(0)
        self.rs = None

    def gap(self):
        self.seq.append("g")
        if self.sv.end_epoch():
            self._drain()

    def push(self, pts, frames, discont):
        if discont and self.cmds:   # the element ends the epoch before a DISCONT buffer
            self.gap()
        dppb = self.term.device_ppb() if self.sv.cfg.device else 0
        self.seq.append(f"b {pts} {frames} {int(discont)} {dppb}" + (f" {self.drain}" if self.drain else ""))
        c = self.sv.push(pts, frames, discont, dppb, self.drain)
        i = len(self.cmds)
        self.cmds.append(c)
        self.pts.append(pts)
        self.dppbs.append(dppb)
        self.events.extend((i, e) for e in self.sv.take_events())
        self.ratios.append(self.sv._ratio_ppb())
        if self.locked_at is None and self.sv.lock.phase() == ar.ClockLock.LOCKED:
            self.locked_at = pts
        if c.drain:
            self._drain()
        if c.relock:
            self.passed = 0
        if c.engage:
            h = min(self.passed, self.HISTORY)
            self.rs = ModelResampler(c.in_rate, c.out_rate)
            self.base = self.n - h
            self.cur = c.in_rate
            k0 = self.rs.out_frames(h)
            self.rs.resample(h, k0)
            self.discard = h - k0
        if c.pass_:
            self.outputs.append(Out(pts, frames, discont, self.n * SUB, i))
            self.seq.append(f"o {frames}")
            self.sv.produced(frames)
            self.passed += frames
            self.n += frames
            return c
        if self.rs is None:
            self.rs = ModelResampler(c.in_rate, c.out_rate)
            self.base = self.n
            self.cur = c.in_rate
        if c.in_rate != self.cur:
            self.rs.update(c.in_rate, c.out_rate)
            self.cur = c.in_rate
        fed = frames - c.skip
        k = self.rs.out_frames(fed)
        pos = self.base * SUB + self.rs.position()
        self.rs.resample(fed, k)
        d = min(self.discard, k)
        self.discard -= d
        pos += d * SUB * self.rs.in_ // self.rs.out   # the first kept output: d outputs on
        if k - d:
            self.outputs.append(Out(self.sv.next_pts(), k - d, c.relock or c.gap, pos, i,
                                    self.sv._house_pts()))
        self.seq.append(f"o {k - d}")
        self.sv.produced(k - d)
        if k - d:
            self.outputs[-1].end = self.sv.next_pts()
        self.n += frames
        return c

    def stats(self):
        self.seq.append("p")
        return self.sv.stats()

    def engages(self):
        return [(i, e) for i, e in self.events if e.kind == "engaged"]

    def relocks(self):
        return [(i, e) for i, e in self.events if e.kind == "relock"]


T0 = H0 + 7 * US


def source_time(t0, fs, ppb, n):
    """Content time of input frame n of a source fast by ppb (fs (1 + ppb) frames per house second)."""
    return t0 + n * S * S // (fs * (S + ppb))


def content_of(pos, fs, ppb, t0=T0):
    """Content time of input position pos (1/SUB frames)."""
    return t0 + pos * S * S // (SUB * fs * (S + ppb))


def feed(drv, fs, frame, ppb, secs, t0=T0, start=0, every=0, stop=None, pairs=None):
    """Frames of `frame` samples from frame index `start`, the first DISCONT; `pairs(drv, t)` feeds
    the device lock before each buffer; `stop(drv)` ends the run; the stats every `every` buffers."""
    k = start // frame
    while k * frame < start + secs * fs:
        t = source_time(t0, fs, ppb, k * frame)
        if pairs:
            pairs(drv, t)
        drv.push(formula_pts(t), frame, k * frame == start)
        k += 1
        if every and k % every == 0:
            drv.stats()
        if stop and stop(drv):
            break
    return k * frame


TICK = 100 * MS   # the device term's timer


class DeviceClock:
    """A device sink's clock fast by ppb, read on the term's timer every 100 ms of house time from
    `start`, each house read up to jitter_us late at random; after a restart it counts from 0. `step`:
    (house time, ns) from which the clock reads that much further on (a device that skipped)."""

    def __init__(self, ppb, jitter_us=0, seed=1, start=T0, step=None):
        self.ppb, self.jitter_us, self.step = ppb, jitter_us, step
        self.rnd = random.Random(seed)
        self.next = self.origin = start

    def __call__(self, drv, t):
        """The reads due by house time t."""
        while self.next <= t:
            e = self.next - self.origin
            late = self.rnd.randrange(self.jitter_us * US) if self.jitter_us else 0
            jump = self.step[1] if self.step and self.next >= self.step[0] else 0
            drv.device_sample(e + e * self.ppb // S + jump, self.next + late)
            self.next += TICK

    def restart(self, drv, t):
        """The sink's ring acquired again at house time t: its clock from 0."""
        self(drv, t)
        drv.device_restart(t)
        self.origin = t


def engaged_at(drv, t0=T0):
    e = drv.engages()
    return (e[0][1].house_ns - t0, e[0][1].reason, e[0][1]) if e else (None, None, None)


# --- cases ----------------------------------------------------------------------------------------

def test_capture_parity():
    print("--- Phase 1's capture servo, bit for bit (the C++ test's printed run checksums) ---")
    for name, kw, want in (
            ("xrun +50 ppm, clean PTS, 1200 s", dict(ppb=50000, secs=1200, gap_s=600, jitter=0),
             0x5f92626ce9450615),
            ("determinism: -500 ppm, 900 s, random buffers, an xrun at 300 s",
             dict(ppb=-500000, secs=900, gap_s=300, buf=0), 0x4fdc9574e46ffa60)):
        h = capture_run(**kw)
        check(f"capture {name}: checksum {h:016x} = the C++ run's {want:016x}", h == want)


def test_constants():
    print("\n--- constants ---")
    d, c = ar.asrc_decode_lock_config(), ar.asrc_lock_config()
    same = all(getattr(d, k) == getattr(c, k) for k in vars(c) if k != "rate_buckets_min")
    check(f"decode lock: the capture lock with a {d.rate_buckets_min}-bucket first fit (S16; capture "
          f"{c.rate_buckets_min})", same and d.rate_buckets_min == 10 and c.rate_buckets_min == 30)
    cfg = ar.decode_servo_config(500)
    check("decode servo: phase bound 1 ms, hold 10 s, on the decode lock (C-7)",
          cfg.bypass_phase_ns == MS and cfg.bypass_hold_ns == 10 * S and cfg.lock.rate_buckets_min == 10)
    check("rate_of: a lock's eps to its clock's rate, positive fast, rounded",
          ar.rate_of(0) == 0 and ar.rate_of(-40000) == 40002 and ar.rate_of(40000) == -39998
          and ar.rate_of(-1) == 1)
    modes = {(b, d): ar.AsrcServo(48000, 48000, ar.AsrcServoConfig(
        lock=ar.asrc_decode_lock_config(), bypass_ppb=b, device=d)).mode() for b in (0, 500) for d in (False, True)}
    check(f"modes before any buffer: {modes} (S17: bypass 0 without device-sink is capture, with it the device "
          "term alone)", modes == {(0, False): "capture", (0, True): "device", (500, False): "bypass",
                                    (500, True): "device"})


def test_house_rate():
    print("\n--- house-rate streams never engage, 1 h simulated (0.5 ppm bound) ---")
    for name, fs, frame in (("48 kHz AAC, exact 1,920-tick frames", 48000, 1024),
                            ("44.1 kHz AAC, PTS quantised to ticks (+-5.5 us)", 44100, 1024)):
        drv = Driver(fs, fs, 500)
        worst = [0]

        def watch(d):
            if d.sv.lock.phase() == ar.ClockLock.LOCKED:
                worst[0] = max(worst[0], abs(d.sv.lock.ppb()))
            return False

        feed(drv, fs, frame, 0, 3600, stop=watch)
        st = drv.stats()
        check(f"{name}: never engages ({len(drv.engages())} engages, mode {st['mode']}), every buffer passed "
              f"unchanged, max |eps| once locked {worst[0]} ppb, phase {st['phase-err-ns'] / US:+.1f} us at 1 h",
              not drv.engages() and st["mode"] == "bypass" and all(c.pass_ for c in drv.cmds)
              and worst[0] < 100 and st["out-frames"] == st["in-frames"] and st["relocks"] == 0
              and abs(st["phase-err-ns"]) < 50 * US)


def test_foreign_engage():
    print("\n--- a source on its own clock engages ---")
    for ppb in (3000, -3000):
        drv = Driver(48000, 48000, 500)
        feed(drv, 48000, 1024, ppb, 60, stop=lambda d: bool(d.engages()))
        at, why, e = engaged_at(drv)
        held = at - (drv.locked_at - T0) if at is not None and drv.locked_at is not None else -1
        check(f"{ppb / 1000:+.0f} ppm: engages within 30 s on the ratio rule, held 10 s of lock first "
              f"({at / S if at else 0:.3f} s, {held / S:.3f} s after the lock, {why}; source "
              f"{e.value / 1000 if e else 0:+.3f} ppm, phase {e.phase_ns / US if e else 0:+.1f} us)",
              at is not None and at <= 30 * S and held >= 10 * S and why == "ratio" and abs(e.value - ppb) <= 500)
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 300, 3600, stop=lambda d: bool(d.engages()))
    at, why, e = engaged_at(drv)
    check(f"+0.3 ppm: inside the ratio bound, engages when the phase passes 1 ms "
          f"({at / S / 60 if at else 0:.2f} min, {why}, phase {e.phase_ns / US if e else 0:+.1f} us; 1 ms at "
          "0.3 ppm is 55.6 min)",
          at is not None and why == "phase" and 54 * 60 * S <= at <= 57 * 60 * S and abs(e.phase_ns) > MS)


def test_engaged_counter():
    print("\n--- engaged: a house-rate counter (+40 ppm source, 10 min after the engage) ---")
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 40000, 690)
    at, why, e = engaged_at(drv)
    st = drv.stats()
    late = [o for o in drv.outputs if at is not None and o.label - T0 >= at + 60 * S]
    errs = [o.label - content_of(o.pos, 48000, 40000) for o in late]
    check(f"+40 ppm: engaged at {at / S if at else 0:.2f} s ({why}); from 60 s after it every output labelled "
          f"within 1 frame of its content time ({min(errs) / US:+.2f} .. {max(errs) / US:+.2f} us)",
          at is not None and at <= 30 * S and bool(errs) and max(abs(x) for x in errs) * 48000 < S
          and st["mode"] == "decode")
    span = content_of(late[-1].pos, 48000, 40000) - content_of(late[0].pos, 48000, 40000)
    frames = sum(o.frames for o in late[:-1])
    check(f"... {frames} frames over {span / S:.6f} s of content (house) time: 48,000 per house second +-1 "
          f"({(frames * S - span * 48000) / S:+.3f} frames)", span >= 600 * S and abs(frames * S - span * 48000) <= S)
    i_late = next(i for i, p in enumerate(drv.pts) if p - T0 >= at + 60 * S)
    mean = sum(r for r in drv.ratios[i_late:]) / len(drv.ratios[i_late:])
    check(f"... the ratio follows the source: out/in - 1 averages {mean / 1000:+.4f} ppm from 60 s after the "
          f"engage (-39.998 for +40 ppm, +-0.02), each buffer within 3 ppm of it",
          abs(mean + 39998) <= 20 and all(abs(r + 39998) <= 3000 for r in drv.ratios[i_late:]))
    eng = [o for o in drv.outputs if o.buf >= drv.engages()[0][0]] if drv.engages() else []
    check("... no relock, no DISCONT after the first output, the counter contiguous from the engage",
          st["relocks"] == 0 and not any(o.discont for o in drv.outputs[1:])
          and all(a.end == b.label for a, b in zip(eng, eng[1:])))


def test_engage_seamless():
    print("\n--- the engage is seamless (from pass-through) ---")
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 40000, 40, stop=lambda d: bool(d.engages()) and len(d.cmds) > d.engages()[0][0] + 2)
    i0 = drv.engages()[0][0]
    c0 = drv.cmds[i0]
    last = [o for o in drv.outputs if o.buf == i0 - 1][0]
    first = [o for o in drv.outputs if o.buf == i0][0]
    pos = first.pos / SUB - i0 * 1024
    check(f"the engaging buffer is primed (engage, not passed) and its first output labelled with its PTS "
          f"({first.label - T0} ns = {drv.pts[i0] - T0} ns), no DISCONT",
          c0.engage and not c0.pass_ and first.label == drv.pts[i0] and not first.discont)
    check(f"... that output is the engaging buffer's first frame: nothing dropped or repeated (position "
          f"{pos:+.4f} frames from it; GStreamer centres 1/8 frame early)", abs(pos + 0.125) < 0.1)
    check(f"... after the last passed buffer, which ended on that frame ({last.pos // SUB + last.frames} = "
          f"{i0 * 1024}); the engaging buffer gives its frames less the lookahead ({first.frames}: 1024 - 32 +-1)",
          last.pos // SUB + last.frames == i0 * 1024 and abs(first.frames - (1024 - ModelResampler.DELAY)) <= 1)


def test_breaks():
    print("\n--- engaged until a DISCONT or GAP, then measured afresh ---")
    for kind in ("discont", "gap"):
        drv = Driver(48000, 48000, 500)
        n = feed(drv, 48000, 1024, 40000, 40)
        before = drv.sv.mode()
        end = drv.sv.next_pts()
        nout = len(drv.outputs)
        if kind == "gap":
            drv.gap()
        t = source_time(T0, 48000, 40000, n) + 300 * MS
        c = drv.push(formula_pts(t), 1024, kind == "discont")
        new = drv.outputs[nout:]
        rel = drv.relocks()
        st = drv.stats()
        check(f"{kind}: engaged before ({before}); the resampler's tail leaves first on the old counter "
              f"({new[0].frames if new else 0} frames at {(new[0].label - end) if new else 0} ns from its end), then "
              f"the buffer passes unchanged: mode {st['mode']}, one relock {[(e.reason, e.value) for _, e in rel]}",
              before == "decode" and len(new) == 2 and new[0].buf == -1 and new[0].label == end
              and abs(new[0].frames - ModelResampler.DELAY) <= 1 and c.pass_ and new[1].label == formula_pts(t)
              and st["mode"] == "bypass" and len(rel) == 1 and rel[0][1].reason == kind and not c.drain)
        check(f"{kind}: the lock measured afresh (source {st['source-ppb']} ppb, {st['state']}), the jump against "
              f"the tail's end {rel[0][1].value / MS if rel else 0:.3f} ms",
              st["source-ppb"] == 0 and st["state"] == "acquiring"
              and rel[0][1].value == formula_pts(t) - drv.sv.tail_pts_at(0))


def test_composite():
    print("\n--- one resampler: the commanded ratio is the decode term times the device term ---")
    for src, dev in ((500000, -300000), (-500000, 300000), (40000, -40000), (-800000, -150000)):
        drv = Driver(48000, 48000, 500, device=True)
        feed(drv, 48000, 1024, src, 60, pairs=DeviceClock(dev))
        sv = drv.sv
        dppb = sv.dev_ppb
        exact = ((S + sv.eps_cmd) * S + (S + dppb) // 2) // (S + dppb) - S
        product = ((S + sv.eps_cmd) / (S + dppb) - 1) * S
        total = drv.stats()["ratio-ppb"]
        check(f"source {src / 1000:+.0f} ppm, device {dev / 1000:+.0f} ppm: mode {sv.mode()}, ratio "
              f"{total / 1000:+.4f} ppm = (1 + decode {sv.eps_cmd / 1000:+.4f}) / (1 + device eps {dppb / 1000:+.4f}) "
              f"- 1 within 0.01 ppm (a sum is {(sv.eps_cmd - dppb - total) / 1000:+.4f} ppm off)",
              sv.mode() == "decode+device" and total == exact and abs(total - product) <= 10
              and (abs(src) < 100000 or abs(sv.eps_cmd - dppb - total) > 10) and abs(ar.rate_of(dppb) - dev) <= 1000)
        rate = drv.cmds[-1].in_rate
        want = round(48000 * 1000 * (S + dppb) / (S + sv.eps_cmd))
        check(f"... in_rate {rate} = round(48,000,000 x (1 + device eps) / (1 + decode eps)) = {want}",
              abs(rate - want) <= 1)


def test_device_only():
    print("\n--- bypass-below-ppm 0 with device-sink: the device term alone (S17) ---")
    drv = Driver(48000, 48000, 0, device=True)
    pairs = DeviceClock(40000)
    rnd = random.Random(5)
    for k in range(6000):   # PTS with 1 ms of jitter: nothing locks to them
        t = T0 + k * 1024 * S // 48000
        pairs(drv, t)
        if k == 4500:   # 96 s: 51 s past the device term's first fit (its 15 s settle and 30 buckets)
            drv.gap()
        drv.push(t + rnd.randrange(MS), 1024, k == 0)
    st = drv.stats()
    want = [round(48000 * 1000 * (S + d) / S) for d in drv.dppbs]
    want = [w + (-1 if w == 48000000 else 0) for w in want]
    got = [c.in_rate for c in drv.cmds]
    dppb = drv.dppbs[-1]
    check(f"mode device, no source lock (source {st['source-ppb']} ppb), every buffer's ratio the device term "
          f"alone (in_rate = round(48,000,000 x (1 + device eps)), {sum(a == b for a, b in zip(got, want))} of "
          f"{len(got)}; at the end {got[-1]} for eps {dppb} ppb); jittered PTS steer nothing",
          st["mode"] == "device" and st["source-ppb"] == 0 and got == want
          and abs(st["ratio-ppb"] - ar.rate_of(dppb)) <= 1 and abs(ar.rate_of(dppb) - 40000) <= 200)
    epochs, cur = [], []
    for o in drv.outputs:
        if o.discont and cur:
            epochs.append(cur)
            cur = []
        cur.append(o)
    epochs.append(cur)
    contiguous = all(a.end == b.label for e in epochs for a, b in zip(e, e[1:]))
    rel = [(e.reason) for _, e in drv.relocks()]
    # B-148: what the first epoch's outputs ran up on the device timeline, each frame -eps_dev / 48 kHz.
    ran = sum(o.frames * -(drv.dppbs[o.buf if o.buf >= 0 else 4499]) for o in epochs[0]) // 48000
    off = epochs[1][0].label - drv.pts[4500] if len(epochs) == 2 else 0
    check(f"labels: a contiguous counter from the first PTS, relocked at the GAP alone ({rel}; {len(epochs)} "
          f"epochs), the second on the device timeline: the GAP buffer's PTS {off / MS:+.3f} ms, what the first "
          f"epoch's outputs ran up ({ran / MS:+.3f} ms: 40 ppm from the device term's first fit) within 1 us",
          rel == ["gap"] and len(epochs) == 2 and contiguous and epochs[0][0].label == drv.pts[0]
          and abs(off - ran) <= US and off > MS)


# --- B-148: the device timeline across a break, lost time, the decode bound, the engage's rate --------

HOLE = 1024   # a lost PipeWire cycle at 48 kHz: 21.333 ms


def continuity_run(dev_ppb, secs, breaks_s, kind="discont", jitter_us=0, seed=1, lost=HOLE, recal_s=None):
    """A house-rate source into decode + device (bypassed), the device dev_ppb fast, its clock read on the
    term's timer exact or up to jitter_us late; at each of breaks_s it loses `lost` frames, then a DISCONT
    buffer or a GAP; the sink's ring acquired again at recal_s (the term relocks, the servo told). Returns
    the driver, the PTS, the content gaps and the output the restart meets."""
    drv = Driver(48000, 48000, 500, device=True)
    clock = DeviceClock(dev_ppb, jitter_us, seed)
    n, pts, gaps, recal_out, bi = 0, [], [], None, 0
    while n * S // 48000 < secs * S:
        brk = bi < len(breaks_s) and n * S // 48000 >= breaks_s[bi] * S
        if brk:
            gaps.append(lost * S // 48000)
            n += lost
            bi += 1
            if kind == "gap":
                drv.gap()
        t = T0 + n * S // 48000
        if recal_s is not None and recal_out is None and t - T0 >= recal_s * S:
            clock.restart(drv, t)
            recal_out = len(drv.outputs)
        clock(drv, t)
        drv.push(t, 1024, n == 0 or (brk and kind == "discont"))
        pts.append(t)
        n += 1024
    return drv, pts, gaps, recal_out


def playout(drv, pts, dev_ppb, recal_out=None, frames=1024):
    """Each output against a sink that never skews (C-6): from its calibration (the first output, or the first after
    a recalibration) label L plays at house L_cal + (L - L_cal) / (1 + device rate). (content time - T0, playout
    less content time) per output, those within 2 filter lengths of a break left out."""
    near = 2 * ModelResampler.TAPS * SUB
    breaks = [b * frames * SUB for b in range(1, len(pts)) if pts[b] - pts[b - 1] != frames * S // 48000
              and abs(pts[b] - pts[b - 1] - frames * S // 48000) > 1]
    out, cal = [], drv.outputs[0].label if drv.outputs else 0
    for j, o in enumerate(drv.outputs):
        if j == recal_out:
            cal = o.label
        if o.pos < near or any(abs(o.pos - x) < near for x in breaks):
            continue
        b = min(o.pos // (SUB * frames), len(pts) - 1)
        c = pts[b] + (o.pos - b * frames * SUB) * S // (SUB * 48000)
        out.append((c - T0, cal + (o.label - cal) * S // (S + dev_ppb) - c))
    return out


def test_device_continuity():
    print("\n--- B-148: the labels stay on the device timeline across a DISCONT or a GAP ---")
    rows = (("-136 ppm, a DISCONT every 300 s, exact reads", -136000, "discont", 0),
            ("+136 ppm, a DISCONT every 300 s, reads 2 ms late at random", 136000, "discont", 2000),
            ("-136 ppm, a GAP every 300 s, reads 2 ms late at random", -136000, "gap", 2000),
            ("+136 ppm, a GAP every 300 s, exact reads", 136000, "gap", 0))
    for name, dev, kind, jit in rows:
        drv, pts, gaps, _ = continuity_run(dev, 1800, list(range(300, 1800, 300)), kind, jit)
        rel = [e for _, e in drv.relocks()]
        jumps = [e.value - g for e, g in zip(rel, gaps)]
        p = [d for t, d in playout(drv, pts, dev) if t >= 60 * S]
        ref = p[0] if p else 0
        check(f"{name}, 30 min: {len(rel)} relocks ({kind}), each jump the content gap within 0.1 ms "
              f"({min(jumps, default=0) / US:+.3f} .. {max(jumps, default=0) / US:+.3f} us off it); the playout "
              f"less its content time within 1 ms of its value at 60 s ({(min(p) - ref) / MS:+.3f} .. "
              f"{(max(p) - ref) / MS:+.3f} ms; before B-148 each relock added 40.8 ms)",
              len(rel) == 5 and all(e.reason == kind for e in rel) and all(abs(j) <= 100 * US for j in jumps)
              and bool(p) and max(abs(d - ref) for d in p) <= MS)
    drv, pts, gaps, _ = continuity_run(-136000, 600, [300], lost=60 * 48000)
    rel = [e for _, e in drv.relocks()]
    dev_gap = gaps[0] + gaps[0] * -136000 // S   # the outage in device time
    p = [d for t, d in playout(drv, pts, -136000) if t >= 60 * S]
    check(f"a 60 s outage at -136 ppm: the jump {rel[0].value / S if rel else 0:.6f} s, the outage in device time "
          f"({dev_gap / S:.6f} s; {(rel[0].value - dev_gap) / US if rel else 0:+.3f} us off it, the house span "
          f"{gaps[0] / S:.0f} s 8.16 ms more); the playout flat ({(min(p) - p[0]) / MS:+.3f} .. {(max(p) - p[0]) / MS:+.3f} ms)",
          len(rel) == 1 and abs(rel[0].value - dev_gap) <= 100 * US and max(abs(d - p[0]) for d in p) <= MS)
    drv, pts, gaps, at = continuity_run(-136000, 450, [300], recal_s=150)
    p = playout(drv, pts, -136000, recal_out=at)
    mid = [d for t, d in p if 155 * S <= t < 300 * S]
    late = [d for t, d in p if t >= 305 * S]
    check(f"the sink's ring acquired again at 150 s (a relock-device restart): the open epoch keeps its labels "
          f"({min(mid) / MS:+.3f} .. {max(mid) / MS:+.3f} ms against the restarted sink), and the next epoch carries only what ran up "
          f"since: the playout on its content time again after the DISCONT ({min(late) / MS:+.3f} .. "
          f"{max(late) / MS:+.3f} ms)",
          at is not None and max(mid) - min(mid) <= MS and min(mid) < -10 * MS
          and max(abs(d) for d in late) <= MS)


def decode_ticks_run(secs, holes=(), back=(), device=False, dev_ppb=-136000, frames=960, ppb=0):
    """A house-rate decode as opusdec gives it: `frames`-frame buffers whose PTS are 90 kHz ticks
    (1800 per 960 frames) ceil'd to ns; `holes` and `back`: (s, ticks) unflagged steps forward and back.
    With `device`, the device term at dev_ppb from exact timer reads. Returns the driver."""
    drv = Driver(48000, 48000, 500, device=device)
    clock = DeviceClock(dev_ppb, start=ceil_div(450000 * 90000 * 100000, 9)) if device else None
    per = frames * 90000 // 48000
    steps = sorted([(s * 48000 // frames, tk) for s, tk in holes] + [(s * 48000 // frames, -tk) for s, tk in back])
    tick, si = 450000 * 90000, 0
    for k in range(secs * 48000 // frames):
        while si < len(steps) and k >= steps[si][0]:
            tick += steps[si][1]
            si += 1
        t = ceil_div(tick * 100000, 9)
        if clock:
            clock(drv, t)
        drv.push(t, frames, k == 0)
        tick += per
    return drv


def gaps_of(drv):
    return [e for _, e in drv.events if e.kind == "gap"]


def test_lost_time():
    print("\n--- B-148: decode modes, an unflagged hole is lost time, a step back a break ---")
    for device in (False, True):
        mode = "decode + device" if device else "decode"
        res, labels = [], []
        for at in (15, 30, 60, 120, 300):
            drv = decode_ticks_run(900, holes=[(at, 1920)], device=device)
            st = drv.stats()
            g = gaps_of(drv)
            res.append((at, len(drv.engages()), [(e.reason, e.lost_frames, round(e.value / MS, 3)) for e in g],
                        st["source-ppb"], st["relocks"]))
            # The labels jump the PTS hole less the device's drift over it (the review's M9).
            for i, e in drv.events:
                if e.kind == "gap":
                    d = drv.pts[i] - drv.pts[i - 1] - 960 * S // 48000
                    labels.append((at, drv.dppbs[i], e.value - (d - ar.drift_over(d, drv.dppbs[i]))))
        check(f"{mode}: one 21.333 ms hole at 15/30/60/120/300 s of 900 s: no engage, one lost-time gap of 1024 "
              f"frames each, the source at house rate within 0.5 ppm, no relock "
              f"({[(a, e, g, s) for a, e, g, s, _ in res]})",
              all(e == 0 and len(g) == 1 and g[0][0] == "lost-time" and g[0][1] == 1024 and abs(s) <= 500 and r == 0
                  for _, e, g, s, r in res))
        check(f"{mode}: each gap's labels jump the hole less the device's drift over it within 1 us ((s, device "
              f"eps ppb, ns off): {labels})", len(labels) == 5 and all(abs(x) <= US for _, _, x in labels)
              and (not device or all(dv != 0 for at, dv, _ in labels if at >= 60)))
    drv = decode_ticks_run(900, holes=[(15, 1920), (30, 1920), (60, 1920)], device=True)
    out = [o for o in drv.outputs[1:] if o.discont]
    check(f"decode + device, three holes at 15/30/60 s: no engage, three gaps, each its next output DISCONT "
          f"({len(drv.engages())}, {len(gaps_of(drv))}, {len(out)}), mode {drv.sv.mode()}",
          not drv.engages() and len(gaps_of(drv)) == 3 and len(out) == 3 and drv.sv.mode() == "device")
    res = []
    for ticks in (120, 480, 900):   # 1.333, 5.333, 10 ms
        drv = decode_ticks_run(600, holes=[(120, ticks)])
        g = gaps_of(drv)
        res.append((round(ticks / 90, 3), len(drv.engages()), [e.lost_frames for e in g]))
    check(f"holes of 1.333/5.333/10 ms at 120 s: no engage, one gap of their frames each ({res})",
          [r[1:] for r in res] == [(0, [64]), (0, [256]), (0, [480])])
    res = []
    for ticks in (1919, 1921):   # a tick off 1024 frames, 10 s into the epoch
        drv = decode_ticks_run(120, holes=[(10, ticks)])
        g = gaps_of(drv)
        res.append((ticks, len(drv.engages()), [(e.lost_frames, e.value) for e in g], drv.stats()["phase-err-ns"]))
    check(f"holes a tick off 1024 frames 10 s into the epoch: no engage, the labels jump the PTS hole to the ns and "
          f"the phase stays ({res}; on whole frames alone 9.7 us reached the lock, a ratio engage at 0.55 ppm)",
          all(e == 0 and len(g) == 1 and abs(g[0][1] - tk * 100000 / 9) <= 2 and abs(ph) <= 2 for tk, e, g, ph in res))
    drv = decode_ticks_run(600, holes=[(120, 45)])
    eng = drv.engages()
    check(f"a 0.5 ms hole stays the lock's (inside the bound; the known limit): no gap, "
          f"{'engaged ' + eng[0][1].reason + f' at {eng[0][1].value / 1000:+.2f} ppm' if eng else 'never engaged'}",
          not gaps_of(drv))
    drv = decode_ticks_run(600, back=[(120, 1890)])
    rel = [e for _, e in drv.relocks()]
    st = drv.stats()
    check(f"a 21 ms step back at 120 s: one relock 'jump' ({[(e.reason, round(e.value / MS, 3)) for e in rel]}), "
          f"measured afresh, no engage, mode {st['mode']}",
          len(rel) == 1 and rel[0].reason == "jump" and not drv.engages() and st["mode"] == "bypass")
    res = []
    for ppb in (88000000, -50000000):   # 44.1 kHz content labelled 48 kHz; 5 % slow
        drv = Driver(48000, 48000, 500)
        feed(drv, 48000, 1024, ppb, 60)
        st = drv.stats()
        res.append((ppb // 1000000, st["gaps"], st["relocks"]))
    check(f"a source past the bound on every buffer (8.8 % fast, 5 % slow: {res} % / gaps / relocks): its steps are "
          f"a rate, the lock's, as before B-148: no lost time, no break",
          all(g == 0 and r == 0 for _, g, r in res))


# The DEV-P3a v7dec sequence (house-engage-replay/replay.cpp): v5hx's Opus egress, AU 0 at these ticks,
# +1920/+1919-tick steps where Mic A lost a cycle (rec/v5ana.txt; the fifth from mA's journal).
V5HX_AU0 = 40562937132
V5HX_STEPS = ((5526, 1920), (6037, 1920), (17084, 1920), (93796, 1919), (125956, 1920))


def v7dec_run(first, last, device=True, dev_ppb=-140000):
    drv = Driver(48000, 48000, 500, device=device)
    clock = None
    for k in range(first, last + 1):
        tick = V5HX_AU0 + k * 1800 + sum(tk for au, tk in V5HX_STEPS if k >= au)
        t = ceil_div(tick * 100000, 9)
        if device:
            clock = clock or DeviceClock(dev_ppb, start=t)
            clock(drv, t)
        drv.push(t, 960, k == first)
    return drv


def test_v7dec_replay():
    print("\n--- B-148: DEV-P3a's v7dec, replayed (the five lost Mic A cycles behind the Opus hop) ---")
    for device in (True, False):
        drv = v7dec_run(-690, 128000, device)
        g = gaps_of(drv)
        check(f"{'decode + device' if device else 'decode'}: AUs -690..128000, {len(drv.engages())} engages "
              f"(before B-148: one, ratio -65.0 ppm at AU 6908), {len(g)} gaps of {[e.lost_frames for e in g]} frames, "
              f"{drv.stats()['relocks']} relocks, mode {drv.sv.mode()}",
              not drv.engages() and [e.lost_frames for e in g] == [1024, 1024, 1024, 1023, 1024]
              and drv.stats()["relocks"] == 0)


def foreign_pes_run(ppm, per_pes, secs, slew_ppb=0, slew_s=0):
    """A foreign AAC decode: PES of per_pes AUs, each PES PTS on a source clock ppm fast through the mux's ticks,
    the AUs inside interpolated at the nominal rate (aacparse, GstAudioDecoder tolerance 0); an upstream mapping
    slewing slew_ppb for the first slew_s s."""
    drv = Driver(48000, 48000, 500)
    for k in range(secs * 48000 // 1024):
        p = (k // per_pes) * per_pes
        c = p * 1024 * S // 48000
        h = c * S // (S + ppm) + slew_ppb * min(c, slew_s * S) // S
        pts = ceil_div(((T0 + h) * 9 // 100000) * 100000, 9) + (k - p) * 1024 * S // 48000
        drv.push(pts, 1024, k == 0)
    return drv


def test_foreign_pes():
    print("\n--- B-148: a foreign source in PES of several AUs still engages at its rate ---")
    drv = foreign_pes_run(40000, 8, 60)
    at, why, e = engaged_at(drv)
    check(f"+40 ppm, 8 AUs per PES: engages within 30 s ({at / S if at else 0:.2f} s, {why}, source "
          f"{e.value / 1000 if e else 0:+.2f} ppm), no lost time ({len(gaps_of(drv))} gaps)",
          at is not None and at <= 30 * S and not gaps_of(drv) and abs(drv.stats()["source-ppb"] - 40000) <= 2000)


def oob_run(fn, secs):
    drv = Driver(48000, 48000, 500)
    first = None
    for k in range(secs * 48000 // 1024):
        drv.push(formula_pts(fn(k * 1024)), 1024, k == 0)
        if first is None and drv.sv.lock.has_fit():
            first = drv.sv.lock.fit_ppb()
    return drv, first, [e for _, e in drv.events if e.kind == "ratio-out-of-bounds"]


def test_decode_bounds():
    print("\n--- B-148: decode ratio-out-of-bounds: locked, past the bound for 30 s of PTS ---")

    def compressed(n):   # the first 10 s 1800 ppm short, then house rate
        c = n * S // 48000
        return T0 + (c * (1000000 - 1800) // 1000000 if c < 10 * S else 10 * S * (1000000 - 1800) // 1000000 + c - 10 * S)

    def stretched(n):    # the first 20 s 2000 ppm long (an upstream acquisition slew), then house rate
        c = n * S // 48000
        return T0 + (c * (1000000 + 2000) // 1000000 if c < 20 * S else 20 * S * (1000000 + 2000) // 1000000 + c - 20 * S)

    for name, fn in (("a first 10-bucket fit at -1800 ppm (the PTS 1800 ppm short for 10 s)", compressed),
                     ("a 20 s 2000 ppm excursion from the start", stretched)):
        drv, first, oob = oob_run(fn, 120)
        check(f"{name}: no out-of-bounds (the first fit {first / 1000 if first else 0:+.1f} ppm; before B-148 raised "
              f"at once)", first is not None and abs(first) > 1000000 and not oob)
    rows = []
    for ppb in (1500000, 5000000):
        drv, first, oob = oob_run(lambda n, ppb=ppb: source_time(T0, 48000, ppb, n), 120)
        rows.append((ppb, [((e.house_ns - T0) / S, e.value / 1000) for e in oob]))
    check(f"sources 1500 and 5000 ppm fast: out of bounds within 60 s ({rows}; the 5000 ppm one steps its envelope "
          f"every 22 s, so no 30-bucket fit ever forms)",
          all(len(o) == 1 and o[0][0] <= 60 and abs(o[0][1] * 1000 + ppb) <= ppb // 50 for ppb, o in rows))


def test_engage_rate_known():
    print("\n--- B-148: an engage says whether the lock had measured the rate ---")
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 300000, 20, stop=lambda d: bool(d.engages()))
    at, why, e = engaged_at(drv)
    st = drv.stats()
    check(f"+300 ppm: a phase engage at {at / S if at else 0:.2f} s before the first fit: rate not measured "
          f"({e.rate_known if e else None}; source {e.value / 1000 if e else 0:+.1f} ppm), stats rate-known "
          f"{st['rate-known']}", e is not None and why == "phase" and not e.rate_known and st["rate-known"] == 0)
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 3000, 60, stop=lambda d: bool(d.engages()))
    at, why, e = engaged_at(drv)
    check(f"+3 ppm: a ratio engage ({at / S if at else 0:.2f} s): rate measured ({e.rate_known if e else None}), "
          f"stats rate-known {drv.stats()['rate-known']}",
          e is not None and why == "ratio" and e.rate_known and drv.stats()["rate-known"] == 1)


# --- B-148's sweep: the lost-time bound (`python3 asrc_bypass_ref_test.py --sweep-lost`) ----------------

def sweep_lost():
    """The bound's cases: house sources with holes (lost time wanted), foreign sources in PES of several AUs
    under an upstream acquisition slew (rate wanted), gross rates and jitter (neither)."""
    rows = []
    for ticks in (45, 90, 120, 240, 480, 900, 1920, 3840):
        drv = decode_ticks_run(300, holes=[(120, ticks)])
        rows.append((f"house, one {ticks / 90:.3f} ms hole at 120 s", drv))
    drv = decode_ticks_run(300, back=[(120, 120)])
    rows.append(("house, a 1.333 ms step back at 120 s", drv))
    for per_pes, slew in ((1, 0), (8, 0), (8, 2000), (24, 2000), (32, 2000), (48, 2000), (8, -2000), (24, -2000)):
        drv = foreign_pes_run(40000, per_pes, 120, slew_ppb=slew * 1000, slew_s=60)
        rows.append((f"foreign +40 ppm, {per_pes} AU/PES, {slew:+d} ppm slew for 60 s", drv))
    for ppb in (47000000, 88000000, -88000000):
        drv = Driver(48000, 48000, 500)
        feed(drv, 48000, 1024, ppb, 60)
        rows.append((f"a source {ppb / 1e7:+.1f} % off (every buffer past the bound)", drv))
    for jit in (250, 500, 1000):
        drv = Driver(48000, 48000, 500)
        rnd = random.Random(9)
        for k in range(120 * 48000 // 1024):
            drv.push(formula_pts(T0 + k * 1024 * S // 48000 + rnd.randrange(-jit * US, jit * US + 1)), 1024, k == 0)
        rows.append((f"house, PTS jitter +-{jit} us", drv))
    return rows


def sweep_lost_print():
    """The sweep under the bound, and with the rule off (the servo before B-148) beside it."""
    real = ar.AsrcServo._content_step
    print("B-148 lost-time bound sweep: max(1 ms, 2000 ppm of the last buffer's span); each row before -> after")
    ar.AsrcServo._content_step = lambda self, pts_ns: 0
    before = sweep_lost()
    ar.AsrcServo._content_step = real
    after = sweep_lost()

    def row(drv):
        e = drv.engages()
        st = drv.stats()
        rel = collections.Counter(x.reason for _, x in drv.relocks())
        return (f"engage {[(x.reason, round(x.value / 1000, 1)) for _, x in e][:1]} gaps {st['gaps']} relocks "
                f"{dict(rel)} source {st['source-ppb'] / 1000:+.2f} ppm")
    for (name, b), (_, a) in zip(before, after):
        print(f"  {name}\n      before: {row(b)}\n      after:  {row(a)}")


# --- B-179: the drain at +-0.5 % ------------------------------------------------------------------------

def drain_run(drain, bypass=0, src_ppb=0):
    """A source fast by src_ppb into a device mode at `drain` for 60 s, the device 40 ppm fast: (input per
    output over 10..60 s minus 1 in ppm, the worst content label's error from 2 s, the stats)."""
    drv = Driver(48000, 48000, bypass, device=True)
    drv.drain = drain
    clock = DeviceClock(40000)
    n, mark = 0, None
    while n < 60 * 48000:
        t = source_time(T0, 48000, src_ppb, n)
        clock(drv, t)
        drv.push(formula_pts(t) if bypass else t, 1024, n == 0)
        if mark is None and t - T0 >= 10 * S:
            st = drv.sv.stats()
            mark = (st["in-frames"], st["out-frames"])
        n += 1024
    st = drv.sv.stats()
    used = ((st["in-frames"] - mark[0]) / (st["out-frames"] - mark[1]) - 1) * 1e6
    err = max(abs(o.content - content_of(o.pos, 48000, src_ppb)) for o in drv.outputs
              if o.content is not None and o.content - T0 >= 2 * S)
    return used, err, st


def test_drain():
    """B-179: the drain carries (1 + drain) into in_rate and the house-rate counter in device modes:
    input consumed 0.5 % faster or slower to 1 ppm, content labels within a frame, ratio_ppb the
    clock terms alone."""
    print("\n--- B-179: the drain at +-5,000 ppm ---")
    base, _e, st0 = drain_run(0)
    for drain in (5000000, -5000000):
        used, err, st = drain_run(drain)
        faster = ((1 + used / 1e6) / (1 + base / 1e6) - 1) * 1e6
        check(f"drain {drain // 1000:+d} ppm: input consumed {faster:+.3f} ppm faster (to 1 ppm)",
              abs(faster - drain / 1000) <= 1)
        check(f"drain {drain // 1000:+d} ppm: content labels within a frame ({err / 1e3:.2f} us)",
              err <= S // 48000 + 1)
        check(f"drain {drain // 1000:+d} ppm: ratio-ppb the device term alone",
              st["ratio-ppb"] == st0["ratio-ppb"] and st["drain-ppb"] == drain)

# --- parity with the C++ ----------------------------------------------------------------------------

def parity_sequences():
    """Short sequences, each a list of replay lines: every mode, both engage rules, a GAP, a DISCONT,
    an envelope step engaged and passing, a device relock."""
    out = []
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 40000, 45, every=200)
    out.append(("decode +40 ppm, engage and 20 s engaged", drv.seq))
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 3000, 40, every=200)
    out.append(("decode +3 ppm, the ratio rule", drv.seq))
    drv = Driver(44100, 44100, 500)
    n = feed(drv, 44100, 1024, 0, 30, every=300)
    drv.gap()
    n = feed(drv, 44100, 1024, 0, 20, start=n + 44100, every=300)
    drv.push(formula_pts(H0 + 60 * S), 1024, True)
    feed(drv, 44100, 1024, -40000, 30, t0=H0 + 60 * S, every=300)
    out.append(("44.1 kHz house, a GAP, a DISCONT, then -40 ppm", drv.seq))
    drv = Driver(44100, 48000, 500)
    feed(drv, 44100, 1024, 25000, 40, every=300)
    out.append(("44.1 -> 48 kHz conversion, +25 ppm", drv.seq))
    drv = Driver(48000, 48000, 500, device=True)
    clock = DeviceClock(40000, jitter_us=400, seed=3, start=H0)
    for k in range(4000):   # 85 s: the device term's first fit at 45 s, its ring acquired again at 64 s
        t = source_time(H0, 48000, -60000, k * 1024)
        if k == 3000:
            clock.restart(drv, t)
        clock(drv, t)
        drv.push(formula_pts(t), 1024, k == 0)
        if k % 300 == 0:
            drv.stats()
    out.append(("decode + device, -60 ppm source, +40 ppm device, a restart", drv.seq))
    drv = Driver(48000, 48000, 0, device=True)
    clock = DeviceClock(-30000, jitter_us=300, seed=4, start=H0)
    for k in range(3500):
        clock(drv, H0 + k * 21333333)
        if k == 2700:
            drv.gap()
        drv.push(H0 + k * 21333333 + (k * 37 % 50) * US, 1024, k == 0 or k == 3100)
        if k % 250 == 0:
            drv.stats()
    out.append(("device alone, -30 ppm device, a GAP and a DISCONT", drv.seq))
    # An envelope step: 60 ms over 67 buffers, each step inside the lost-time bound (B-148).
    for name, ppb, step in (("decode +40 ppm engaged, a +60 ms PTS drift without DISCONT", 40000, 900 * US),
                            ("decode house rate passing, a -60 ms PTS drift without DISCONT", 0, -900 * US)):
        drv = Driver(48000, 48000, 500)
        for k in range(2400):
            t = source_time(T0, 48000, ppb, k * 1024) + step * min(max(k - 1650, 0), 67)
            drv.push(formula_pts(t), 1024, k == 0)
            if k % 300 == 0:
                drv.stats()
        out.append((name, drv.seq))
    drv = Driver(48000, 48000, 0)
    g = Lcg(3)
    for k in range(1800):
        drv.push(H0 + k * 1024 * S // 48000 + g.next() % MS + (60 * MS if k > 1300 else 0), 1024, k == 0)
        if k % 300 == 0:
            drv.stats()
    out.append(("capture, 1 ms jitter, a +60 ms step", drv.seq))
    drv = Driver(48000, 48000, 0, device=True)
    clock = DeviceClock(-30000, jitter_us=300, seed=5, start=H0)
    for k in range(3000):   # B-179: the drain ramped up and down, and down past its clamp
        clock(drv, H0 + k * 21333333)
        drv.drain = min(k, 3000 - k) * 5000 if k < 2800 else -9000000
        if k == 2200:
            drv.gap()
        drv.push(H0 + k * 21333333, 1024, k in (0, 1500))
        if k % 250 == 0:
            drv.stats()
    out.append(("device alone, a drain ramp to +-0.5 % and past the clamp, a DISCONT, a GAP", drv.seq))
    out.extend(b148_sequences())
    return out


def b148_sequences():
    """B-148's rules: the device timeline across breaks and the device term's relocks, lost time, a
    step back, the out-of-bounds hold, an engage before the rate is measured."""
    out = []
    drv = Driver(48000, 48000, 500, device=True)
    clock = DeviceClock(-136000)
    n = 0
    for k in range(7000):   # 149 s, a device 136 ppm slow (the term's first fit at 45 s)
        disc = k == 0
        if k in (3000, 5000):   # lost cycles, DISCONT after
            n += 1024
            disc = True
        if k == 4000:          # a lost cycle, a GAP
            n += 1024
            drv.gap()
        if k in (3500, 5500):  # unflagged 1.333 ms: lost time
            n += 64
        h = T0 + n * S // 48000
        if k == 4500:          # the sink's ring acquired again: a relock-device restart
            clock.restart(drv, h)
        clock(drv, h)
        drv.push(h + 900 * US * min(max(k - 6000, 0), 67), 1024, disc)   # a +60 ms drift: an envelope step
        n += 1024
        if k % 300 == 0:
            drv.stats()
    out.append(("B-148 decode + device, 136 ppm slow: DISCONTs, a GAP, lost time, an envelope step, a restart",
                drv.seq))
    drv = Driver(48000, 48000, 0, device=True)
    clock = DeviceClock(136000, step=(T0 + 90 * S, 100 * MS))
    n = 0
    for k in range(5600):   # 119 s, the device term alone
        disc = k == 0
        if k in (2400, 3600, 5000):
            n += 1024
            disc = True
        h = T0 + n * S // 48000
        if k == 3000:   # past the term's first fit: an offset to keep
            clock.restart(drv, h)
        clock(drv, h)   # from 90 s the device clock 100 ms on: a relock-device step
        drv.push(h, 1024, disc)
        n += 1024
        if k % 250 == 0:
            drv.stats()
    out.append(("B-148 device alone, 136 ppm fast: DISCONTs, a restart, a device clock step", drv.seq))
    drv = Driver(48000, 48000, 500)
    tick = 450000 * 90000
    for k in range(3000):   # 60 s of 960-frame buffers on 90 kHz ticks
        tick += {300: 1919, 500: 1920, 900: 120, 1100: 1921, 1300: 45, 1700: -1890}.get(k, 0)
        drv.push(ceil_div(tick * 100000, 9), 960, k == 0)
        tick += 1800
        if k % 250 == 0:
            drv.stats()
    out.append(("B-148 decode house: holes of 21.333 ms, a tick either side, 1.333 and 0.5 ms, a 21 ms step back",
                drv.seq))
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 1500000, 70, every=300)
    out.append(("B-148 decode +1500 ppm: out of bounds after the hold", drv.seq))
    drv = Driver(48000, 48000, 500)
    for k in range(3300):   # +1500 ppm, a +60 ms drift from 20 s: the fit cut back to its new level
        drv.push(formula_pts(source_time(T0, 48000, 1500000, k * 1024) + 900 * US * min(max(k - 940, 0), 67)),
                 1024, k == 0)
        if k % 300 == 0:
            drv.stats()
    out.append(("B-148 decode +1500 ppm, a +60 ms drift in the hold", drv.seq))
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 300000, 12, every=100)
    out.append(("B-148 decode +300 ppm: a phase engage before the rate is measured", drv.seq))
    drv = Driver(48000, 48000, 500)
    feed(drv, 48000, 1024, 50000000, 15, every=100)
    out.append(("B-148 decode 5 % fast: every buffer 1.02 ms short, the lock's", drv.seq))
    return out


def cli():
    """`mrts_cli` as `make test` builds it, or MRTS_CLI's; None when it cannot be built."""
    if os.environ.get("MRTS_CLI"):
        return os.environ["MRTS_CLI"]
    made = subprocess.run(["make", "-s", "-C", MRTS, "mrts_cli"], capture_output=True, text=True,
                          env={k: v for k, v in os.environ.items() if k != "MR_PLUGINS_DIR"})
    path = os.path.join(MRTS, "mrts_cli")
    return path if made.returncode == 0 and os.path.exists(path) else None


# The reference's mutants, one exact replacement each, which the parity must catch: each rule of
# this item reached by the sequences, and the C++ held to it.
REF_MUTANTS = [
    ("the hold 9 s", "        self.bypass_hold_ns = 10000000000\n", "        self.bypass_hold_ns = 9000000000\n"),
    ("the phase bound 2 ms", "        self.bypass_phase_ns = 1000000\n", "        self.bypass_phase_ns = 2000000\n"),
    ("the ratio as a sum", "        d = E9 + self.dev_ppb\n        return ((E9 + self.eps_cmd) * E9 + d // 2) // d - E9\n",
     "        return self.eps_cmd - self.dev_ppb\n"),
    ("a break keeps the lock's rate", "            self.lock.relock(False)\n", "            self.lock.relock(True)\n"),
    ("an envelope step disengages", "        self.over_since = None\n        self.relocks += 1\n        self.events.append("
     "AsrcEvent(AsrcEvent.RELOCK, \"envelope-step\"", "        self.over_since = None\n        self.engaged = False\n"
     "        self.relocks += 1\n        self.events.append(AsrcEvent(AsrcEvent.RELOCK, \"envelope-step\""),
    ("the engage keeps T0", "            self.t0 = pts\n            self.m = self.mh = self.mh_frac = 0\n            self.start2 = 2",
     "            self.m = self.mh = self.mh_frac = 0\n            self.start2 = 2"),
    ("passing at a rate conversion", "        self.engaged = False\n        self.passing = self.decode and not self.cfg.device and "
     "self.in_hz == self.out_hz\n", "        self.engaged = False\n        self.passing = self.decode and not self.cfg.device\n"),
    ("rate_of truncates", "    return floor_div(-2 * e * E9 + E9 + e, 2 * (E9 + e))\n", "    return floor_div(-e * E9, E9 + e)\n"),
    # B-148's rules.
    ("the gap at the house ratio", "    return floor_div(g * eps_ppb, E9 + eps_ppb)\n", "    return 0\n"),
    ("labels re-anchored at the PTS", "        if not self.cfg.device:\n            return 0\n        hend",
     "        if True:\n            return 0\n        hend"),
    ("a recalibration keeps the offset", "            self.cal_off = sat_sub(self._label_next(), self._house_pts())\n",
     "            pass\n"),
    ("the drained tail not in the house end", "        if self.ended:   # drained", "        if False:   # drained"),
    ("the lost-time bound 2 ms", "        bound = max(self.cfg.bypass_phase_ns, span // 500)\n",
     "        bound = max(2 * self.cfg.bypass_phase_ns, span // 500)\n"),
    ("a step back no break", "        return d if cont and (bound < d <= self.LOST_MAX_NS or d < -bound) else 0\n",
     "        return d if cont and bound < d <= self.LOST_MAX_NS else 0\n"),
    ("lost time at the house ratio", "        if self.cfg.device:\n            dr = drift_over",
     "        if False:\n            dr = drift_over"),
    ("lost frames off the input position", "        self.lost += frames\n        self.lost_res += res\n",
     "        self.lost_res += res\n"),
    ("lost time to the frame", "                    self._lose(lost, step - span)\n",
     "                    self._lose(lost)\n"),
    ("the out-of-bounds hold 20 s", "    OOB_HOLD_NS = 30 * E9", "    OOB_HOLD_NS = 20 * E9"),
    ("a step judged after a step", "        return d if cont and (bound", "        return d if (bound"),
    ("an engage says the rate is known", "phase_ns=phase, rate_known=self.lock.rate_known))",
     "phase_ns=phase, rate_known=True))"),
    # B-166: the device term on its timer tells the servo of each relock-device.
    ("a relock-device leaves the servo's offset", "    if term.take_recalibrated():\n        sv.device_recalibrated()\n",
     "    if term.take_recalibrated():\n        pass\n"),
    ("a restart not stopped first", "    term.stop(mono)\n    term.start(mono)\n", "    term.start(mono)\n"),
    # B-179: the drain in the house-rate counter and in its clamp.
    ("house_advance without the drain", "        f = self.mh_frac + frames * self.run_ppb\n",
     "        f = self.mh_frac + frames * self.dev_ppb\n"),
    ("the drain unclamped", "clamp(drain_ppb, -DRAIN_MAX_PPB, DRAIN_MAX_PPB) if", "drain_ppb if"),
]


def ref_mutant(src, old, new):
    """The reference with one exact replacement, as a module."""
    m = types.ModuleType("asrc_bypass_ref_mutant")
    m.__file__ = ar.__file__
    exec(compile(src.replace(old, new), ar.__file__, "exec"), m.__dict__)
    return m


def test_parity():
    print("\n--- parity: the reference and mrts_cli asrc on the same call sequences ---")
    if not sys.platform.startswith("linux"):
        print("SKIP parity: mrts_cli builds on Linux only")
        return
    CLI = cli()
    check("mrts_cli builds (make -C ../native/mrts mrts_cli)", CLI is not None)
    if CLI is None:
        return
    total = 0
    runs = []
    for name, seq in parity_sequences():
        ref = ar.replay(seq)
        p = subprocess.run([CLI, "asrc", "-"], input="\n".join(seq) + "\n", capture_output=True, text=True)
        cxx = p.stdout.splitlines()
        runs.append((seq, cxx))
        diff = next((i for i, (a, b) in enumerate(zip(ref, cxx)) if a != b), None)
        engages = sum(1 for x in ref if x.startswith("e engaged"))
        check(f"parity {name}: {len(ref)} lines, {engages} engage(s), equal"
              + (f" (first difference at line {diff}: ref {ref[diff]!r} c++ {cxx[diff]!r})" if diff is not None else
                 "" if len(ref) == len(cxx) else f" ({len(cxx)} lines from the C++, rc {p.returncode})"),
              p.returncode == 0 and ref == cxx)
        total += len(ref)
    print(f"  {total} lines compared")
    src = open(ar.__file__).read()
    caught, bad = [], []
    for name, old, new in REF_MUTANTS:
        if src.count(old) != 1:
            bad.append(name)
            continue
        m = ref_mutant(src, old, new)
        if any(m.replay(seq) != cxx for seq, cxx in runs):
            caught.append(name)
    missed = [n for n, _, _ in REF_MUTANTS if n not in caught and n not in bad]
    check(f"mutants: the parity catches {len(caught)} of {len(REF_MUTANTS)} of the reference's mutants"
          + (f" (missed: {'; '.join(missed)})" if missed else "") + (f" (not applied: {'; '.join(bad)})" if bad else ""),
          not missed and not bad)


if __name__ == "__main__":
    if sys.argv[1:] == ["--sweep-lost"]:
        sweep_lost_print()
        sys.exit(0)
    test_capture_parity()
    test_constants()
    test_house_rate()
    test_foreign_engage()
    test_engaged_counter()
    test_engage_seamless()
    test_breaks()
    test_composite()
    test_device_only()
    test_device_continuity()
    test_lost_time()
    test_v7dec_replay()
    test_foreign_pes()
    test_decode_bounds()
    test_engage_rate_known()
    test_drain()
    test_parity()
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S) in asrc_bypass_ref_test.py")
        for f in _failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nALL asrc_bypass_ref TESTS PASSED")
