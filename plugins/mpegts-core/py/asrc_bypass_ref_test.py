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
    __slots__ = ("label", "frames", "discont", "pos", "buf", "end")

    def __init__(self, label, frames, discont, pos, buf):
        # pos: the input position of the first frame, 1/SUB frames of the global input index;
        # buf: the push it came from (-1: a drained tail); end: the counter's label after it.
        self.label, self.frames, self.discont, self.pos, self.buf = label, frames, discont, pos, buf
        self.end = None


class Driver:
    """The element's flow (gstmrasrc.cpp) on the servo and the resampler model; records every
    call as a replay line, and each output buffer as an Out."""
    HISTORY = 64

    def __init__(self, in_hz, out_hz, bypass_ppb=0, device=False, first_fit=None):
        self.in_hz, self.out_hz = in_hz, out_hz
        self.seq = [f"cfg {in_hz} {out_hz} {bypass_ppb} {int(device)} {ModelResampler.DELAY}"
                    + (f" {first_fit}" if first_fit else "")]
        lockcfg = ar.asrc_decode_lock_config() if bypass_ppb > 0 else ar.asrc_lock_config()
        devcfg = ar.asrc_decode_lock_config()
        if first_fit:
            lockcfg.rate_buckets_min = devcfg.rate_buckets_min = first_fit
        self.sv = ar.AsrcServo(in_hz, out_hz, ar.AsrcServoConfig(lock=lockcfg, bypass_ppb=bypass_ppb,
                                                                   device=device))
        self.sv.set_delay(ModelResampler.DELAY)
        self.dev = ar.AsrcDeviceLock(devcfg)
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

    def device_pair(self, itime, etime, read_ns=0):
        self.seq.append(f"d {itime} {etime} {read_ns}")
        self.dev.feed(itime, etime, read_ns)

    def device_discont(self):
        self.seq.append("x")
        self.dev.discont()

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
        dppb = self.dev.ppb() if self.sv.cfg.device else 0
        self.seq.append(f"b {pts} {frames} {int(discont)} {dppb}")
        c = self.sv.push(pts, frames, discont, dppb)
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
            self.outputs.append(Out(self.sv.next_pts(), k - d, c.relock, pos, i))
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


def device_pairs(ppb, jitter_us=0, seed=1):
    """A sink's custom-slaving readings: device time fast by ppb, up to jitter_us late."""
    rnd = random.Random(seed)

    def pairs(drv, t):
        e = t - T0
        if e >= 0:
            drv.device_pair(e + e * ppb // S - (rnd.randrange(jitter_us * US) if jitter_us else 0), e)
    return pairs


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
        feed(drv, 48000, 1024, src, 60, pairs=device_pairs(dev))
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
    pairs = device_pairs(40000)
    rnd = random.Random(5)
    for k in range(4000):   # PTS with 1 ms of jitter: nothing locks to them
        t = T0 + k * 1024 * S // 48000
        pairs(drv, t)
        if k == 2500:
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
    check(f"labels: a contiguous counter from the first PTS, re-anchored at the GAP alone ({rel}; {len(epochs)} "
          f"epochs from {[(e[0].label - T0) // US for e in epochs]} us = the PTS {[(drv.pts[0] - T0) // US, (drv.pts[2500] - T0) // US]})",
          rel == ["gap"] and len(epochs) == 2 and contiguous and epochs[0][0].label == drv.pts[0]
          and epochs[1][0].label == drv.pts[2500])


def device_readings(ppm, secs, seed, preempt=0, first_early_ns=0):
    """A sink's readings every 21 ms: etime, then itime read up to 2 us later, 1 in 50 after a
    preemption of up to `preempt` ns; read_ns the caller's re-read after them. The first reads
    the device `first_early_ns` early (the sink's ring not yet running)."""
    rnd = random.Random(seed)
    out, t = [], 0
    while t < secs * S:
        lag = rnd.randrange(2 * US) + (rnd.randrange(preempt) if preempt and rnd.randrange(50) == 0 else 0)
        ti = t + lag   # house time of itime's read
        itime = ti + ti * ppm // 1000000 + (first_early_ns if t == 0 else 0)
        out.append((itime, t, lag + rnd.randrange(2 * US)))
        t += 21333333
    return out


def test_device_lock():
    print("\n--- the device lock on (itime, etime) ---")
    for ppm in (40, -40):
        dl = ar.AsrcDeviceLock()
        first_fit = None
        for itime, etime, read in device_readings(ppm, 120, ppm, preempt=500 * US, first_early_ns=330 * US):
            dl.feed(itime, etime, read)
            if first_fit is None and dl.lock.has_fit():
                first_fit = etime
        check(f"device {ppm:+d} ppm, 1 in 50 readings preempted up to 0.5 ms, the first 0.33 ms early: first fit at "
              f"{first_fit / S:.1f} s, rate {dl.rate_ppb() / 1000:+.4f} ppm at 120 s (within 0.01 ppm), locked",
              abs(dl.rate_ppb() - ppm * 1000) <= 10 and dl.locked() and first_fit <= 12 * S)
        before = dl.ppb()
        dl.discont()
        check(f"device {ppm:+d} ppm: a sink discontinuity relocks it, keeping the rate ({before} -> {dl.ppb()} ppb)",
              dl.ppb() == before and dl.relocks == 1 and not dl.locked())
    # Each rule's own effect: the pairs at their etime (no re-read), and the first one kept.
    rows = []
    for name, use_read, settle in (("both", True, True), ("no re-read", False, True), ("first pair kept", True, False)):
        dl = ar.AsrcDeviceLock()
        if not settle:
            dl.SETTLE_NS = 0
        rates = []
        for itime, etime, read in device_readings(40, 30, 7, preempt=500 * US, first_early_ns=330 * US):
            dl.feed(itime, etime, read if use_read else 0)
            if etime >= 15 * S and dl.lock.has_fit():
                rates.append(dl.rate_ppb())
        rows.append((name, max(abs(r - 40000) for r in rates)))
    check(f"the re-read and the settle each matter: worst rate error 15-30 s {rows} ppb (the rules together within "
          "0.05 ppm, either alone left out past 0.1)",
          rows[0][1] <= 50 and rows[1][1] > 100 and rows[2][1] > 100)


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
    t = 0
    for k in range(2400):
        drv.device_pair(t + t * 40 // 1000000 - (k * 7919 % 400) * US, t, (k * 104729 % 9) * US)
        t += 21333333
        drv.push(formula_pts(source_time(H0, 48000, -60000, k * 1024)), 1024, k == 0)
        if k == 1200:
            drv.device_discont()
        if k % 300 == 0:
            drv.stats()
    out.append(("decode + device, -60 ppm source, +40 ppm device", drv.seq))
    drv = Driver(48000, 48000, 0, device=True)
    t = 0
    for k in range(1500):
        drv.device_pair(t - t * 30 // 1000000 + (300 * US if k % 97 == 0 else 0), t, 300 * US if k % 97 == 0 else 2 * US)
        t += 21333333
        if k == 700:
            drv.gap()
        drv.push(H0 + k * 21333333 + (k * 37 % 50) * US, 1024, k == 0 or k == 1100)
        if k % 250 == 0:
            drv.stats()
    out.append(("device alone, -30 ppm device, a GAP and a DISCONT", drv.seq))
    for name, ppb, step in (("decode +40 ppm engaged, a +60 ms PTS step without DISCONT", 40000, 60 * MS),
                            ("decode house rate passing, a -60 ms PTS step without DISCONT", 0, -60 * MS)):
        drv = Driver(48000, 48000, 500)
        for k in range(2400):
            t = source_time(T0, 48000, ppb, k * 1024) + (step if k > 1650 else 0)
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
    ("the device pair at etime", "        h = etime + max(read_ns, 0)\n", "        h = etime\n"),
    ("no settle", "        if h - self.first < self.SETTLE_NS:\n            return\n", "        if False:\n            return\n"),
    ("rate_of truncates", "    return floor_div(-2 * e * E9 + E9 + e, 2 * (E9 + e))\n", "    return floor_div(-e * E9, E9 + e)\n"),
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
    test_capture_parity()
    test_constants()
    test_house_rate()
    test_foreign_engage()
    test_engaged_counter()
    test_engage_seamless()
    test_breaks()
    test_composite()
    test_device_only()
    test_device_lock()
    test_parity()
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S) in asrc_bypass_ref_test.py")
        for f in _failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nALL asrc_bypass_ref TESTS PASSED")
