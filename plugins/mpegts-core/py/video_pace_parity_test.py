#!/usr/bin/env python3
"""mrts::VideoPace against its reference (plan ch. 15.4 B-162; WI-P4-3): `mrts_cli pace` replays a
call sequence in video_pace.py's line format, and every decision, summary and display period it
prints must equal video_pace.py's, line for line, on

  - p4-3a's sequences: video_pace_test.py's cases as VIDEO_PACE_TRACE records them, case 11's
    feedback and returns and the replay case's runs, rebuilt with the suite's own helpers;
  - 120 random ones (seeded): cadences from 24 to 60 fps on a source clock within +-100 ppm,
    arrival stalls, decode spikes, content gaps and steps (flagged or not), GAPs, DISCONTs, held
    PTS, steps back and stamp jitter, missing durations, displays within +-1,000 ppm of the
    content or at another rate, measured, nominal or none and changed mid-run, through the suite's
    sink models; with their feedback (output off, MSC still or reset) and returns (jitter, a prior
    right or off).

Then each of the reference's 15 mutants (video_pace_test.MUTANTS) replays the same sequences, and
parity must tell every one from mrts_cli. Skips (exit 0) without the built mrts_cli (make native).

Run:  python3 video_pace_parity_test.py
"""
import io
import os
import subprocess
import sys
import tempfile

import video_pace as vp
import video_pace_test as vt

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
SEC, MS, US = vp.SEC, vp.MS, vt.US
RANDOM_RUNS = 120

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


# --- p4-3a's sequences beyond the trace ---------------------------------------------------------

def feedback_op(pairs):
    return vp.line({"op": "feedback", "pairs": [list(p) for p in pairs]}) + "\n"


def returns_op(times, prior=0):
    return vp.line({"op": "returns", "times": list(times), "prior": prior}) + "\n"


def case11_ops(out):
    """Case 11 calls the helpers directly, so the trace has none of them: the same inputs here."""
    t60 = 16666667
    out.write(feedback_op(vt._presented(t60, 2 * MS, vt.P50, 90)))
    out.write(feedback_op(vt._presented(t60, 2 * MS, vt.P50, 30)))
    full = vt._presented(t60, 2 * MS, vt.P50, 120)
    on = [x for x in full if not 40 * SEC <= x[0] < 70 * SEC]
    cut = next(i for i, x in enumerate(on) if x[0] >= 70 * SEC)
    still = on[:cut] + [(t, s - (on[cut][1] - on[cut - 1][1]) + 1) for t, s in on[cut:]]
    reset = full[:3000] + [(t, s - full[3000][1]) for t, s in full[3000:]]
    for pairs in (on, still, reset):
        out.write(feedback_op(pairs))
    kms = vt.Kms(t60, 2 * MS)
    rets = [kms.push(j * vt.P50)[0] for j in range(90 * 50)]
    out.write(returns_op(rets))
    rnd = vt._lcg(11)
    out.write(returns_op([t + next(rnd) % (400 * US) - 200 * US for t in rets[:3000]]))
    kms = vt.Kms(vt.SLOW, 0)
    slow25 = [kms.push(10 * MS + j * 40 * MS)[0] for j in range(90 * 25)]
    out.write(returns_op(slow25, vt.P50))
    out.write(returns_op(slow25))


def replay_case_ops(out):
    """The replay case's two runs, its feedback and its returns (it records them to itself)."""
    pace = vt.Recorded(out, None, "replay")
    pace.set_display(vt.P50, "measured")
    vt.drive(pace, vt.live(vt.cadence(120, 60, 1), 16666667), vt.Wayland(vt.P50, 0))
    pace.take()
    pace = vt.Recorded(out, None, "replay-gaps", 100 * MS)
    pace.set_display(vt.P50, "nominal")
    pts = [k * vt.P50 + (SEC if k >= 30 else 0) for k in range(60)]
    vt.drive(pace, [(p, 0, p + vt.LATENCY, i == 30, i == 30) for i, p in enumerate(pts)])
    pace.take()
    out.write(feedback_op(vt._presented(16666667, 0, vt.P50, 2)))
    out.write(returns_op([vt.Kms(16666667, 0).refresh_after(j * vt.P50) for j in range(100)], 16666667))


# --- random sequences ---------------------------------------------------------------------------

RATES = ((50, 1), (60, 1), (60000, 1001), (30, 1), (25, 1), (24000, 1001), (50, 1), (60, 1))
REFRESHES = (20000000, 16666667, 16683333, 33333333, 41708333)


class Rnd:
    def __init__(self, seed):
        self.g = vt._lcg(seed)

    def int(self, lo, hi):
        """lo..hi inclusive."""
        return lo + next(self.g) % (hi - lo + 1)

    def chance(self, percent):
        return next(self.g) % 100 < percent

    def pick(self, items):
        return items[next(self.g) % len(items)]


def random_display(r, period):
    """(T_d, source, the sink model's true period) for content of `period` ns."""
    if r.chance(80):
        true = period * (1000000 + r.int(-1000, 1000)) // 1000000
    else:
        true = r.pick(REFRESHES) * (1000000 + r.int(-100, 100)) // 1000000
    source = r.pick(("measured", "measured", "nominal", "nominal", "none"))
    given = true if source == "measured" or r.chance(50) else r.pick(REFRESHES)
    if source == "measured" and r.chance(20):
        given = true + r.int(-3000, 3000)          # a measurement a few us off
    return given, source, true


def random_frames(r, n, num, den):
    """[(pts, dur, ready, discont, gap)] of one random run."""
    ppm = r.int(-100, 100)
    ticks = r.chance(50)
    start = r.int(0, 10 ** 13)
    latency = r.int(0, 500) * MS
    period = den * SEC // num
    frames, shift, ashift = [], 0, 0
    events = sorted(r.int(1, n - 1) for _ in range(r.int(3, 14)))
    stall_until, stall_end = -1, 0
    held = jitter_until = 0
    for k in range(n):
        t = k * den * SEC * (1000000 + ppm) // (num * 1000000)
        pts = start + shift + t
        if ticks:
            pts = (pts * 9 // 100000) * 100000 // 9      # floored to 90 kHz ticks, as the demux
        discont = gap = False
        while events and events[0] == k:
            events.pop(0)
            kind = r.int(0, 9)
            if kind == 0:                                # an arrival stall
                stall_until = k + r.int(1, 200)
                stall_end = start + ashift + t + latency + r.int(100, 3000) * MS
            elif kind == 1:                              # a content gap, the source paused or not
                g = r.int(300, 5000) * MS
                shift += g
                pts += g
                ashift += g if r.chance(50) else 0
                discont, gap = r.chance(50), r.chance(40)
            elif kind == 2:                              # a step inside the threshold
                shift += r.int(1, 3) * period
                pts += r.int(1, 3) * period
                discont, gap = r.chance(40), r.chance(40)
            elif kind == 3:                              # a step back
                shift -= r.int(1, 100) * period
                discont = r.chance(30)
            elif kind == 4:                              # a decoder holding a decreasing PTS
                held = r.int(1, 60)
            elif kind == 5:
                jitter_until = k + r.int(50, 2000)
            elif kind == 6:
                gap = True
            elif kind == 7:
                discont = True
        if held > 0 and frames:
            pts = frames[-1][0]
            held -= 1
        if k < jitter_until:
            pts += r.int(-period // 4, period // 4)
        ready = (start + ashift + t + latency + (r.int(1, 100) * MS if r.chance(2) else 0)
                 + r.int(0, 2000) * US)
        if k < stall_until:
            ready = max(ready, stall_end)
        dur = 0 if r.chance(5) else period
        frames.append((pts, dur, ready, discont, gap))
    return frames


def random_feedback(r, period):
    """Presented samples as the element reads them (once a second) or per frame, with an
    output off (MSC on or still), an MSC reset, repeats and a step back."""
    true = period * (1000000 + r.int(-1000, 1000)) // 1000000
    phase, seq0 = r.int(0, 10 ** 13), r.int(0, 10 ** 6)
    every = r.pick((1, 1, 2, 50, 60))
    samples, off, msc_still = [], None, r.chance(50)
    for n in range(0, r.int(2, 6000), every):
        if r.chance(1) and off is None:
            off = (n, n + r.int(10, 3000))
        if off and off[0] <= n < off[1]:
            continue
        seq = seq0 + n
        if off and n >= off[1] and msc_still:
            seq -= off[1] - off[0]
        samples.append((phase + n * true + r.int(-50, 50) * US // 10, seq))
        if r.chance(1):
            samples.append(samples[-1])                   # the same sample read twice
    if r.chance(10) and len(samples) > 4:
        samples[len(samples) // 2] = (samples[len(samples) // 2][0], 0)   # an MSC reset
    if r.chance(10) and len(samples) > 4:
        samples.insert(len(samples) // 3, (samples[0][0], samples[0][1]))  # a step back
    return samples


def random_returns(r, period, frame_ns):
    """A blocking sink's returns: each push from a frame's release waits to the next vblank."""
    true = period * (1000000 + r.int(-1000, 1000)) // 1000000
    phase = r.int(0, 10 ** 12)
    times = []
    for j in range(r.int(2, 4000)):
        t = phase + j * frame_ns
        v = phase + ((t - phase) // true + 1) * true
        if r.chance(3):
            v += r.int(1, true)                          # a return off the grid
        times.append(v + r.int(0, 300) * US)
    prior = r.pick((0, 0, true, period, period * (1000000 + r.int(-2000, 2000)) // 1000000))
    return times, prior


def random_ops(out):
    for i in range(RANDOM_RUNS):
        r = Rnd(1000 + i)
        num, den = r.pick(RATES)
        period = den * SEC // num
        gap_threshold = r.pick((vp.GAP_THRESHOLD_NS, 100 * MS, 60 * MS, SEC))
        pace = vt.Recorded(out, None, "random-%d" % i, gap_threshold)
        frames = random_frames(r, r.int(1500, 5000), num, den)
        given, source, true = random_display(r, period)
        sink = r.pick((None, "wayland", "wayland", "kms"))
        display = None if sink is None else (vt.Wayland if sink == "wayland" else vt.Kms)(
            true, r.int(0, true - 1))
        at = 0
        while at < len(frames):
            pace.set_display(given, source)
            chunk = frames[at:at + r.int(200, len(frames))]
            vt.drive(pace, chunk, display)
            at += len(chunk)
            pace.take()
            if r.chance(30):
                given, source, _ = random_display(r, period)
        out.write(feedback_op(random_feedback(r, r.pick(REFRESHES))))
        times, prior = random_returns(r, r.pick(REFRESHES), period)
        out.write(returns_op(times, prior))
    out.write(feedback_op([]))
    out.write(feedback_op([(5, 1)]))
    out.write(returns_op([]))
    out.write(returns_op([7, 7, 7]))


# --- the comparison -----------------------------------------------------------------------------

def cpp(path, out_path):
    with open(out_path, "w") as f:
        done = subprocess.run([CLI, "pace", path], stdout=f, stderr=subprocess.PIPE, text=True)
    return done.returncode, done.stderr.strip()


def first_difference(script, paths, expected):
    """Replay `paths` through `script` (a video_pace.py), streaming, against the `expected` output
    files: (lines compared, the first differing line number or None, its two lines)."""
    n = 0
    for path, want in zip(paths, expected):
        proc = subprocess.Popen([sys.executable, script, path], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
        with open(want) as w:
            for got in proc.stdout:
                n += 1
                line = w.readline()
                if got != line:
                    proc.kill()
                    proc.wait()
                    return n, n, (got.strip(), line.strip())
            proc.wait()
            rest = w.readline()
            if proc.returncode != 0 or rest:
                return n, n + 1, ("exit %d" % proc.returncode, rest.strip())
    return n, None, None


def count(path):
    frames = drops = takes = periods = 0
    with open(path) as f:
        for line in f:
            if line.startswith('{"release"'):
                frames += 1
                drops += line.endswith('"drop":1}\n')
            elif line.startswith('{"released"'):
                takes += 1
            else:
                periods += 1
    return frames, drops, takes, periods


def main():
    if not os.access(CLI, os.X_OK):
        print("SKIP video_pace_parity_test.py — %s not built (make native)" % CLI)
        return 0
    with tempfile.TemporaryDirectory(prefix="video_pace_parity_") as tmp:
        cases = os.path.join(tmp, "cases.jsonl")
        env = dict(os.environ, VIDEO_PACE_TRACE=cases)
        done = subprocess.run([sys.executable, os.path.join(HERE, "video_pace_test.py")],
                              cwd=HERE, env=env, capture_output=True, text=True)
        check("the reference's suite passes while VIDEO_PACE_TRACE records its cases",
              done.returncode == 0 and "ALL video_pace TESTS PASSED" in done.stdout)
        extra = os.path.join(tmp, "extra.jsonl")
        with open(extra, "w") as f:
            buf = io.StringIO()
            case11_ops(buf)
            replay_case_ops(buf)
            f.write(buf.getvalue())
        rnd = os.path.join(tmp, "random.jsonl")
        with open(rnd, "w") as f:
            random_ops(f)
        paths = [rnd, extra, cases]          # the random runs first: they tell most mutants apart
        outs = [p + ".cpp" for p in paths]
        for name, path, out in zip(("the random runs", "case 11 and the replay case", "the cases"),
                                   paths, outs):
            rc, err = cpp(path, out)
            frames, drops, takes, periods = count(out)
            check("mrts_cli pace replays %s: %d frames (%d dropped), %d takes, %d periods%s"
                  % (name, frames, drops, takes, periods,
                     "" if rc == 0 else " (exit %d: %s)" % (rc, err)),
                  rc == 0 and frames + takes + periods > 0)
            n, at, lines = first_difference(os.path.join(HERE, "video_pace.py"), [path], [out])
            check("every line of %s equals video_pace.py's (%d compared%s)"
                  % (name, n, "" if at is None else "; line %d: %s vs %s" % (at, lines[0], lines[1])),
                  at is None and n == frames + takes + periods)
        with open(os.path.join(HERE, "video_pace.py")) as f:
            src = f.read()
        caught = 0
        for name, _case, old, new in vt.MUTANTS:
            mdir = os.path.join(tmp, "mutant")
            os.makedirs(mdir, exist_ok=True)
            with open(os.path.join(mdir, "video_pace.py"), "w") as f:
                f.write(src.replace(old, new))
            n, at, _lines = first_difference(os.path.join(mdir, "video_pace.py"), paths, outs)
            told = src.count(old) == 1 and at is not None
            caught += told
            print("  mutant %r: %s"
                  % (name, "line %d of %d differs" % (at, n) if at else "no difference"))
        check("parity tells the reference's mutants from mrts_cli: %d of %d" % (caught, len(vt.MUTANTS)),
              caught == len(vt.MUTANTS))
    if _failures:
        print("\n%d FAILURE(S) in video_pace_parity" % _failures)
        return 1
    print("\nALL video_pace_parity TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
