#!/usr/bin/env python3
"""catch_up_ref.py's suite (plan ch. 15.4 B-249, the catch-up): the class's cases, then a model of an audio
output's sink end with the margin (sink_margin_ref's rule: a write behind the device's point of no return gets
silence so it lands 60 ms past it, the first twice that) and the catch-up driving the ratio, fed 10 ms buffers
late by a profile. The device's point of no return runs 40 ms ahead of its clock (the test sink's device-ns), the
ring takes 100 ms past it, and the device term is exact (output frames are content x (1 + ppm) / (1 + command)).
Two shapes: the 302M's (a queue after mrasrc: mrasrc takes each buffer as it comes) and the Audio Decoder's (the
queue before mrasrc: it takes a buffer when the sink has room, so the queue holds what the ring cannot).

  - late start: the sink starts 0.8 s after the first buffer (the backlog in the queue): no hole, no frame lost,
    back to the target delay (lateness + 40 + 60 ms, within a buffer) by a window (60 s) plus the excess at 0.5 %,
    +-20 %;
  - the field walk (30-70 ms, five seeds, 300 s): no more holes than with no catch-up (none); the excess the
    start left is played out and the delay's trough comes back to the margin, not into it; a walk wider than
    the margin (30-130 ms, three seeds): no more holes than with no catch-up (none; a catch-up without the
    trough window holes it);
  - the rising walk (30 ms, then 30-300 ms) for 600 s, two seeds: no more holes than with no catch-up (a 30 s
    window, a mutant, plays out the room between the walk's slow returns to its top);
  - rising then falling (30 ms, up to 200 ms over 10 s, held, back to 30 ms at 40 s): holes only on the rise,
    the excess played out after a window of proof, back to the target;
  - two spikes (400 ms for 1 s at 10 s and 200 s): a hole and a refill each, a catch-up run after each;
  - drift (a device 100 ppm fast and 100 ppm slow, 600 s): no hole, the delay flat once the start's excess is out,
    one run only;
  - an early feed (content 200 ms ahead, not yet due): nothing played out;
  - the Audio Decoder's shape, 150 ms bursts, a 0.3 s late start: no hole, back to the target.

Then each mutant below must fail a case. Run:  python3 catch_up_ref_test.py [--mutants]
"""
import collections
import random
import sys

import catch_up_ref as cu

FS = 48000
MS = 1_000_000
S = 1_000_000_000
BUF = 480
MARGIN = 60 * FS // 1000
P_MS = 40                   # the point of no return past the device clock
RING_MS = 100               # what the ring takes past it
RATE = cu.RATE_PPM / 1e6

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def walk(n, lo, hi, first, start_i, seed):
    rng, out, cur = random.Random(seed), [], float(first)
    for i in range(n):
        out.append(cur)
        if i >= start_i:
            cur = min(hi, max(lo, cur + rng.gauss(0, 8)))
    return out


def simulate(late_ms, factory=cu.CatchUp, sink_delay_ms=0, ppm=0, shape="outq", burst=1, catch=True, trace=None):
    """Each 10 ms buffer i arrives at i x 10 ms + late_ms[i] (never before the one before; with `burst` > 1 a
    burst's buffers all at its last one's time). The model ticks 1 ms. The outcome: holes after the start, each
    buffer's delay (ms: when its first frame plays less its content time), the catch-up's runs and removed frames,
    its samples (t, frames). `trace` (a list) gets the catch-up's events in catch_up_ref.py's line format."""
    n = len(late_ms)
    arr, prev = [], 0
    for i, l in enumerate(late_ms):
        t = int(i * 10 * MS + l * MS)
        prev = max(prev, t)
        arr.append(prev)
    if burst > 1:
        arr = [arr[min(n - 1, (i // burst + 1) * burst - 1)] for i in range(n)]
    t0 = arr[0]
    start = t0 + sink_delay_ms * MS
    rate = FS * (1 + ppm * 1e-6)
    c = factory(MARGIN, FS) if catch else None
    if c:
        c.reset(start)
    if trace is not None:
        trace += [{"margin": MARGIN, "hz": FS}, {"reset": start}]

    def play(t):
        return int((t - start) * rate // S) if t >= start else 0

    p_fr, ring = P_MS * FS // 1000, RING_MS * FS // 1000
    upq = collections.deque()        # the Audio Decoder's queue before mrasrc: buffer indices
    outq = collections.deque()       # the 302M's queue after mrasrc: (i, frames)
    write = None                     # the ring's next write (frames), None before the first
    pos = [None] * n                 # where each buffer's first frame was written
    frac = 0.0
    holes, runs, was = 0, 0, False
    samples, segs = [], collections.deque()   # (write pos, content ns, frames) for `due`
    held = 0                         # frames mrasrc made, not yet in the ring
    last = [None]                    # the last sample's total

    def due_at(t, x):
        while segs and segs[0][0] + segs[0][2] <= x and len(segs) > 1:
            segs.popleft()
        if not segs or x >= segs[-1][0] + segs[-1][2]:
            return None
        p0, ct, fr = segs[0]
        content = ct + (x - p0) * S // FS        # before the first: the silence counts as lateness
        return (t - content) * FS // S

    def asrc(i, t):
        nonlocal frac, runs, was, held
        cmd = 0
        if c and t >= start and write is not None:
            consumed = play(t) + p_fr
            total = write + held + sum(BUF for _ in upq) + BUF
            due = due_at(t, consumed)
            cmd = c.sample(t, total, consumed, due)
            if trace is not None:
                trace.append({"t": t, "total": total, "consumed": consumed, **({} if due is None else {"due": due})})
            low = total if last[0] is None else min(total, last[0])
            last[0] = total
            samples.append((t, min(low - consumed, 10 ** 12 if due is None else due)))
            if cmd and not was:
                runs += 1
            was = cmd > 0
        x = BUF * (1 + ppm * 1e-6) / (1 + cmd / 1e9) + frac
        k = int(x)
        frac = x - k
        if c:
            c.produced(k, cmd)
            if trace is not None and cmd:
                trace.append({"produced": k, "ppb": cmd})
        held += k
        return k

    def to_ring(i, k, t):
        nonlocal write, holes, held
        consumed = play(t) + p_fr
        if write is None:
            write = consumed + 2 * MARGIN
        elif write < consumed:
            holes += 1
            write = consumed + MARGIN
        pos[i] = write
        segs.append((write, i * 10 * MS, k))
        write += k
        held -= k

    k_arr = 0
    end = arr[-1] + 2 * S
    t = (t0 // MS) * MS
    while t <= end:
        while k_arr < n and arr[k_arr] <= t:
            if shape == "outq":
                outq.append((k_arr, asrc(k_arr, t)))
            else:
                upq.append(k_arr)
            k_arr += 1
        if t >= start:
            if shape == "outq":
                while outq and (write is None or write - (play(t) + p_fr) < ring):
                    i, k = outq.popleft()
                    to_ring(i, k, t)
            else:
                while upq and (write is None or write - (play(t) + p_fr) < ring):
                    i = upq.popleft()
                    to_ring(i, asrc(i, t), t)
        t += MS
    delays = [((start + pos[i] * S / rate) - i * 10 * MS) / MS for i in range(n) if pos[i] is not None]
    return {"holes": holes, "delays": delays, "runs": runs, "removed": c.removed() if c else 0, "samples": samples,
            "start": start}


def target_ms(late):
    return late + P_MS + MARGIN * 1000 / FS


def reach_s(r, final, tol=5.0):
    """The content second from which the delay stays within tol of `final`."""
    d = r["delays"]
    k = len(d)
    while k > 0 and abs(d[k - 1] - final) <= tol:
        k -= 1
    return k / 100


# --- the class -------------------------------------------------------------------------------------------------

def case_class(factory=cu.CatchUp):
    c = factory(100, 1000, window_ns=10 * S, start_frames=20)
    c.reset(0)
    cmds = [c.sample(k * S, 1000 + 300, 1000) for k in range(10)]
    check("watching for a window after the reset: no command, no excess",
          not any(cmds) and c.excess == 0 and c.state() == "watching")
    cmd = c.sample(10 * S, 1300, 1000)
    check(f"after the window the trough (300) less the margin (100) is the excess: {c.excess}, command {cmd}",
          c.excess == 200 and cmd == cu.RATE_PPM * 1000 and c.state() == "catching-up")
    c.produced(10_000, cmd)
    check(f"what is removed counts frames x ppb: {c.removed()} of 10,000 frames at 0.5 %", c.removed() == 50)
    c.sample(11 * S, 1300 - 50, 1000)
    check(f"... and the removal's own fall is no rise: excess {c.excess} (200 less 50)", c.excess == 150)
    c.sample(12 * S, 1040, 1000)
    check(f"a new low (lateness rose) lowers the trough at once: excess {c.excess} (40 + 50 - 50 - 100)",
          c.excess == -60 and c.sample(12 * S + 1, 1040, 1000) == 0 and c.state() == "idle")
    c2 = factory(100, 1000, window_ns=10 * S, start_frames=20)
    c2.reset(0)
    for k in range(11):
        c2.sample(k * S, 1115, 1000)
    check(f"an excess under the start threshold (15 < 20) starts nothing: {c2.excess}, {c2.state()}",
          c2.excess == 15 and c2.state() == "idle")
    c3 = factory(100, 1000, window_ns=10 * S, start_frames=20)
    c3.reset(0)
    for k in range(11):
        c3.sample(k * S, 2000, 1000, due=150)
    check(f"audio not yet due is no excess: due 150 frames -> excess {c3.excess}", c3.excess == 50)
    c4 = factory(100, 1000, window_ns=10 * S, start_frames=20)
    c4.reset(0)
    c4.sample(0, 1500, 1000)
    c4.sample(S, 2500, 1000)       # more came in a queue before: the least since the last sample is 1500
    for k in range(2, 11):
        c4.sample(k * S, 2500, 1000)
    check(f"between samples the least in hand is the lesser of two totals: excess {c4.excess} (400)", c4.excess == 400)
    c4.reset(20 * S)
    check("a reset clears the window and the command", c4.state() == "watching" and
          c4.sample(21 * S, 5000, 1000) == 0)
    c5 = factory(0, 48000, ppb=50_000_000)
    check(f"the rate is held to 0.5 %: {c5.ppb} ppb", c5.ppb == cu.RATE_PPM * 1000)
    # The default start threshold, 20 ms at 48 kHz (960 frames; review 4 minor 4): 959 frames past the margin
    # starts nothing, 960 starts a run, which then goes on below 960 while above 0.
    got = {}
    for over in (959, 960):
        c6 = factory(2880, 48000, window_ns=10 * S)
        c6.reset(0)
        for k in range(11):
            c6.sample(k * S, 1000 + 2880 + over, 1000)
        got[over] = (c6.excess, c6.state())
        if over == 960:
            c6.produced(48_000, cu.RATE_PPM * 1000)
            c6.sample(11 * S, 1000 + 2880 + over - 240, 1000)
            got["on"] = (c6.excess, c6.state())
    check(f"the default start is 20 ms: 959 frames over the margin {got[959]}, 960 {got[960]}; once running, "
          f"below it {got.get('on')}", got[959] == (959, "idle") and got[960] == (960, "catching-up")
          and got.get("on") == (720, "catching-up"))


# --- the model -------------------------------------------------------------------------------------------------

def case_late_start(factory=cu.CatchUp, verbose=True):
    secs = 260
    r = simulate([30.0] * (secs * 100), factory, sink_delay_ms=800)
    d = r["delays"]
    final = sum(d[-1000:]) / 1000
    d0 = d[0]
    want = cu.WINDOW_MS / 1000 + (d0 - final) / 1000 / RATE
    got = reach_s(r, final)
    if verbose:
        print(f"  late start: delay {d0:.0f} -> {final:.1f} ms (target {target_ms(30):.0f}), back by {got:.0f} s "
              f"(a window + {d0 - final:.0f} ms at 0.5 %: {want:.0f} s), removed {r['removed'] / 48:.0f} ms, "
              f"{r['holes']} holes, {r['runs']} runs")
    check(f"late start 0.8 s: no hole ({r['holes']}), one run ({r['runs']})", r["holes"] == 0 and r["runs"] == 1)
    check(f"... back to the target: {final:.1f} ms against {target_ms(30):.0f} (within a buffer over)",
          target_ms(30) - 1 <= final <= target_ms(30) + 10)
    check(f"... in the time a window and 0.5 % imply: {got:.0f} s against {want:.0f} s (+-20 %)",
          abs(got - want) <= 0.2 * want)
    check(f"... what was removed is the delay given back: {r['removed'] / 48:.1f} ms against {d0 - final:.1f}",
          abs(r["removed"] / 48 - (d0 - final)) <= 2)


def case_field(factory=cu.CatchUp, verbose=True):
    secs, worse, troughs = 300, [], []
    for seed in range(7, 12):
        late = walk(secs * 100, 30.0, 70.0, 30.0, 0, seed)
        base = simulate(late, catch=False)
        r = simulate(late, factory)
        after = [s for t, s in r["samples"] if t > r["start"] + 60 * S]
        troughs.append(min(after) / 48 if after else 0)
        worse.append((seed, base["holes"], r["holes"], r["runs"], round(r["removed"] / 48, 1),
                      round(sum(r["delays"][-1000:]) / 1000, 1), round(sum(base["delays"][-1000:]) / 1000, 1)))
    if verbose:
        for w in worse:
            print(f"  field seed {w[0]}: holes {w[1]} without, {w[2]} with; {w[3]} runs, removed {w[4]} ms, delay "
                  f"{w[6]} -> {w[5]} ms")
    check(f"field walk: no more holes than with no catch-up ({[(w[1], w[2]) for w in worse]})",
          all(w[2] <= w[1] for w in worse))
    check(f"... the start's excess played out ({[w[4] for w in worse]} ms removed)", all(w[4] >= 15 for w in worse))
    check(f"... the trough back at the margin, not into it: {[round(t, 2) for t in troughs]} ms (60)",
          all(59 <= t <= 62 for t in troughs))
    # A walk wider than the margin (30-130 ms): the room its rises use is the trough's to keep.
    wide = []
    for seed in range(7, 10):
        late = walk(secs * 100, 30.0, 130.0, 30.0, 0, seed)
        wide.append((simulate(late, catch=False)["holes"], simulate(late, factory)["holes"]))
    if verbose:
        print(f"  field walk 30-130 ms, seeds 7-9: holes without, with: {wide}")
    check(f"a walk wider than the margin (30-130 ms): no more holes than with no catch-up ({wide})",
          all(w <= b for b, w in wide))


def case_rising_long(factory=cu.CatchUp, verbose=True):
    """The rising walk (30 ms for 10 s, then 30-300 ms) for 600 s, seeds 7 and 13: the walk's slow returns to its
    top are what the window is sized by (a 30 s one plays the room out between them: a hole more on each)."""
    out = []
    for seed in (7, 13):
        late = walk(60000, 30.0, 300.0, 30.0, 1000, seed)
        out.append((seed, simulate(late, catch=False)["holes"], simulate(late, factory)["holes"]))
    if verbose:
        print(f"  rising 600 s: (seed, holes without, with) {out}")
    check(f"the rising walk for 600 s: no more holes than with no catch-up ({out})", all(w <= b for _, b, w in out))


class Window30(cu.CatchUp):
    def __init__(self, m, hz, **kw):
        kw.pop("window_ns", None)
        super().__init__(m, hz, window_ns=30 * S, **kw)


def case_rise_fall(factory=cu.CatchUp, verbose=True):
    secs = 200
    late = [30.0 if i < 1000 else min(200.0, 30 + (i - 1000) * 0.17) if i < 4000 else 30.0 for i in range(secs * 100)]
    r = simulate(late, factory)
    final = sum(r["delays"][-1000:]) / 1000
    peak = max(r["delays"][2000:4000])
    got = reach_s(r, final)
    want = 40 + cu.WINDOW_MS / 1000 + (peak - final) / 1000 / RATE
    if verbose:
        print(f"  rising-falling: {r['holes']} holes, delay {peak:.0f} -> {final:.1f} ms, back by {got:.0f} s "
              f"(want {want:.0f}), {r['runs']} runs")
    check(f"rising then falling: holes only on the rise ({r['holes']}), back to the target ({final:.1f} ms)",
          r["holes"] > 0 and target_ms(30) - 1 <= final <= target_ms(30) + 10)
    check(f"... after the fall's window: {got:.0f} s against {want:.0f} (+-20 %)", abs(got - want) <= 0.2 * want)


def case_spikes(factory=cu.CatchUp, verbose=True):
    secs = 380
    late = [400.0 if (1000 <= i < 1100 or 20000 <= i < 20100) else 30.0 for i in range(secs * 100)]
    r = simulate(late, factory)
    final = sum(r["delays"][-1000:]) / 1000
    mid = sum(r["delays"][19000:19900]) / 900
    if verbose:
        print(f"  spikes: {r['holes']} holes, delay before the second {mid:.1f} ms, at the end {final:.1f} ms, "
              f"{r['runs']} runs, removed {r['removed'] / 48:.0f} ms")
    check(f"two spikes: a hole each ({r['holes']}), a run after each ({r['runs']})", r["holes"] == 2 and r["runs"] == 2)
    check(f"... recovered after each: {mid:.1f} and {final:.1f} ms (target {target_ms(30):.0f})",
          all(target_ms(30) - 1 <= v <= target_ms(30) + 10 for v in (mid, final)))


def case_drift(factory=cu.CatchUp, verbose=True):
    for ppm in (100, -100):
        r = simulate([30.0] * 60000, factory, ppm=ppm)
        tail = r["delays"][30000:]
        span = max(tail) - min(tail)
        if verbose:
            print(f"  drift {ppm:+d} ppm: {r['holes']} holes, {r['runs']} runs, delay {min(tail):.2f}..{max(tail):.2f} ms "
                  f"over the last 300 s")
        check(f"drift {ppm:+d} ppm: no hole, one run, no creep ({span:.2f} ms over 300 s)",
              r["holes"] == 0 and r["runs"] == 1 and span < 0.5)


def case_early(factory=cu.CatchUp, verbose=True):
    r = simulate([-200.0] * 12000, factory)
    final = sum(r["delays"][-1000:]) / 1000
    floor = P_MS + MARGIN * 1000 / FS
    if verbose:
        print(f"  early feed: removed {r['removed'] / 48:.1f} ms, {r['runs']} runs, delay {r['delays'][0]:.1f} -> "
              f"{final:.1f} ms")
    check(f"an early feed (200 ms of it not yet due): played out only down to the device's room plus the margin, "
          f"never early ({final:.1f} ms, {floor:.0f}; {r['removed'] / 48:.1f} ms removed)",
          floor - 1 <= final <= floor + 10)


def case_decoder(factory=cu.CatchUp, verbose=True):
    secs = 160
    r = simulate([30.0] * (secs * 100), factory, sink_delay_ms=300, shape="upq", burst=15)
    final = sum(r["delays"][-1500:]) / 1500
    if verbose:
        print(f"  decoder bursts: {r['holes']} holes, delay {r['delays'][0]:.0f} -> {final:.1f} ms, {r['runs']} runs, "
              f"removed {r['removed'] / 48:.0f} ms")
    check(f"the Audio Decoder's shape (150 ms bursts, queue before mrasrc), 0.3 s late start: no hole ({r['holes']}), "
          f"its excess played out ({r['removed'] / 48:.0f} ms)", r["holes"] == 0 and r["removed"] > 48 * 200)


# --- mutants ---------------------------------------------------------------------------------------------------

class NoWindow(cu.CatchUp):
    def __init__(self, m, hz, **kw):
        kw.pop("window_ns", None)
        super().__init__(m, hz, window_ns=1, **kw)


class Overshoot(cu.CatchUp):
    def sample(self, t, total, consumed, due=None):
        cmd = super().sample(t, total, consumed, due)
        if not cmd and self.excess > -MARGIN // 2 and self.state() != "watching" and self.removed() > 0:
            self.active = True
            return self.ppb
        return cmd


class NoAdjust(cu.CatchUp):
    def produced(self, frames, ppb):
        super().produced(frames, ppb)
        self._r = self.removed_frames

    def sample(self, t, total, consumed, due=None):
        keep = self.removed_frames
        self.removed_frames = 0
        cmd = super().sample(t, total, consumed, due)
        self.removed_frames = keep
        self.excess -= keep
        self.active = self.active and self.excess > 0
        return self.ppb if self.active else 0


class NoDue(cu.CatchUp):
    def sample(self, t, total, consumed, due=None):
        return super().sample(t, total, consumed, None)


class NoPrev(cu.CatchUp):
    def sample(self, t, total, consumed, due=None):
        self.prev = None
        return super().sample(t, total, consumed, due)


class StartHalf(cu.CatchUp):
    def __init__(self, m, hz, **kw):
        super().__init__(m, hz, **kw)
        self.start = max(1, self.start // 2)


class Fast(cu.CatchUp):
    def __init__(self, m, hz, **kw):
        super().__init__(m, hz, **kw)
        self.ppb = 20_000_000


MUTANTS = {"window-30s": Window30, "no-window": NoWindow, "overshoot": Overshoot, "no-adjust": NoAdjust, "no-due": NoDue, "no-prev": NoPrev,
           "fast": Fast, "start-half": StartHalf}


def run_suite(factory=cu.CatchUp):
    global _failures
    _failures = 0
    v = factory is cu.CatchUp
    case_class(factory)
    case_late_start(factory, v)
    case_field(factory, v)
    case_rise_fall(factory, v)
    case_rising_long(factory, v)
    case_spikes(factory, v)
    case_drift(factory, v)
    case_early(factory, v)
    case_decoder(factory, v)
    return _failures


def main(argv):
    if "--mutants" in argv:
        ok = True
        for name, fn in MUTANTS.items():
            fails = run_suite(fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        print("ALL MUTANTS CAUGHT" if ok else "A MUTANT SURVIVED")
        return 0 if ok else 1
    fails = run_suite()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
