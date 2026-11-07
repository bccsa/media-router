#!/usr/bin/env python3
"""mrts::AsrcDeviceTerm and mrts::AsrcRenderLateness against their reference (plan ch. 15.4 B-166;
WI-P4-4): `mrts_cli asrc-device` replays a call sequence in asrc_device_ref.py's line format, and
every event, recalibration, read, render lateness and summary it prints must equal
asrc_device_ref.py's, line for line, on

  - 24 random sequences (seeded): devices within +-2,000 ppm, reads exact, preempted, late by up to
    70 ms or with pulsesink's +-6 ms interpolation corrections, clock steps, flat stretches that
    catch up or resume behind, restarts from 0, a sink that stops taking frames while they are
    pushed, eps_in series and render-lateness maps with realigned writes, under the device term's
    configuration or a neighbour of it;
  - one sink clock DEV-P4a recorded, in its own line format (the four are among the cases);
  - p4-4a's cases: asrc_device_ref_test.py's terms and render-lateness maps as ASRC_DEVICE_TRACE
    records them (synthetic clocks, the modelled output path, stalls, restarts, holes, the four
    recorded clocks).

Exact lines hold the plan's behavioural parity (the ratio within 0.1 ppm, relock and stall events
at the same reads) and more: the lock is mrts::ClockLock itself, which clock_lock.py ports integer
for integer. Then each of the reference's mutants (asrc_device_ref_test.MUTANTS) replays the same
sequences, and parity must tell every one from mrts_cli. Skips (exit 0) without mrts_cli (make native).

Run:  python3 asrc_device_parity_test.py
"""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

import asrc_device_ref as ad
import asrc_device_ref_test as at

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
SEC, MS = ad.SEC, ad.MS
TICK = 100 * MS
RANDOM_RUNS = 24

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def line(obj):
    return json.dumps(obj, separators=(",", ":")) + "\n"


# --- random sequences ---------------------------------------------------------------------------

def random_config(r):
    """The config line: the device term's own, or a neighbour; only what differs is written, so a
    mutant's default reaches the runs that keep it."""
    op = {"op": "config"}
    if r.random() < 0.3:
        op["settle_ns"] = r.choice([0, 1, 5, 30]) * SEC
    if r.random() < 0.2:
        op["relock_samples"] = r.choice([1, 3])
    if r.random() < 0.15:
        op["relock_ns"] = r.choice([20, 80]) * MS
    if r.random() < 0.15:
        op["stall_ns"], op["probe_ns"] = r.choice([(2 * SEC, 300 * MS), (SEC // 2, SEC)])
    if r.random() < 0.15:
        op["rate_hz"] = r.choice([44100, 96000])
    if r.random() < 0.15:
        op["lock"] = {"rate_buckets_max": r.choice([300, 600]), "slew_track_ppm": r.choice([20, 100])}
    return op


def random_run(r, seed, out):
    """One term: a device clock read every 100 ms with its faults, the render counts beside it and a
    render-lateness map fed and read as the element does."""
    op = random_config(r)
    op["case"] = "random-%d" % seed
    out.write(line(op))
    rate = op.get("rate_hz", 48000)
    ppm = r.choice([0, 9, -135, 80, -500, 1000, 1500, -2000])
    shape = r.choice(["exact", "preempted", "uniform5", "late70", "corrections"])
    secs = r.randrange(60, 480)
    steps = sorted((r.randrange(20, secs), r.choice([-1, 1]) * r.randrange(20, 300) * MS)
                   for _ in range(r.randrange(0, 3)))
    flats = sorted((r.randrange(20, secs), r.randrange(3, 30) * TICK, r.random() < 0.5)
                   for _ in range(r.randrange(0, 3)))
    restarts = sorted(r.randrange(30, secs) for _ in range(r.randrange(0, 3)))
    stalls = sorted((r.randrange(20, secs), r.randrange(5, 40) * TICK) for _ in range(r.randrange(0, 3)))
    mono0 = r.randrange(1, 10**6) * SEC
    origin, started = 0, False
    pushed = rendered = write = 0
    for k in range(secs * 10):
        h = k * TICK
        if restarts and h >= restarts[0] * SEC:
            restarts.pop(0)
            out.write(line({"op": "stop", "mono": mono0 + h}))
            out.write(line({"op": "flush"}))
            started, origin = False, h
        if not started:
            out.write(line({"op": "start", "mono": mono0 + h}))
            started = True
        e = h - origin
        dev = e + e * ppm // 1000000 + sum(s for at_s, s in steps if h >= at_s * SEC)
        if shape == "corrections":   # pulsesink's interpolation: +-6 ms in turn about every 1.5 s
            dev += 6 * MS if (k // 15) % 2 else -6 * MS
        for at_s, ln, catch in flats:   # the clock held flat, then on again where it was or caught up
            if at_s * SEC <= h < at_s * SEC + ln:
                dev -= h - at_s * SEC
            elif h >= at_s * SEC + ln and not catch:
                dev -= ln
        late = {"exact": 0, "preempted": at.preempted(r), "uniform5": r.randrange(5 * MS),
                "late70": 70 * MS if r.random() < 0.01 else r.randrange(200000),
                "corrections": r.randrange(200000)}[shape]
        stalled = any(at_s * SEC <= h < at_s * SEC + ln for at_s, ln in stalls)
        pushed += rate // 10
        if not stalled:
            n = pushed - rendered
            if r.random() < 0.02:   # the base sink realigned its write: an underflow
                write += r.randrange(1, rate // 20)
            out.write(line({"op": "rendered", "write_pos": write, "n": n, "pts": mono0 + h - 150 * MS}))
            rendered, write = pushed, write + n
        op = {"op": "sample", "dev": max(dev, 0), "mono": mono0 + h + late}
        if r.random() < 0.95:
            op.update(pushed=pushed, rendered=rendered)
        if r.random() < 0.3:
            op["in_ppb"] = r.randrange(-60000, 60001)
        out.write(line(op))
        if r.random() < 0.5:
            out.write(line({"op": "lateness", "now": mono0 + h, "dev": max(dev, 0) * rate // 48000}))
    if r.random() < 0.3:   # a read after the ring's release: refused
        out.write(line({"op": "stop", "mono": mono0 + secs * SEC}))
        out.write(line({"op": "sample", "dev": 0, "mono": mono0 + secs * SEC + TICK}))


def random_ops(out):
    for seed in range(RANDOM_RUNS):
        random_run(random.Random(seed), seed, out)


# --- the comparison -----------------------------------------------------------------------------

def cpp(path, out_path):
    with open(out_path, "w") as f:
        done = subprocess.run([CLI, "asrc-device", path], stdout=f, stderr=subprocess.PIPE, text=True)
    return done.returncode, done.stderr.strip()


def first_difference(script, paths, expected):
    """Replay `paths` through `script` (an asrc_device_ref.py) against the `expected` output files:
    (lines compared, the first differing line number or None, its two lines)."""
    n = 0
    for path, want in zip(paths, expected):
        proc = subprocess.Popen([sys.executable, script, path], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, cwd=os.path.dirname(script))
        with open(want) as w:
            for got in proc.stdout:
                n += 1
                expect = w.readline()
                if got != expect:
                    proc.kill()
                    proc.wait()
                    return n, n, (got.strip(), expect.strip())
            proc.wait()
            rest = w.readline()
            if proc.returncode != 0 or rest:
                return n, n + 1, ("exit %d" % proc.returncode, rest.strip())
    return n, None, None


def same_lines(ref_path, cxx_path):
    """(lines compared, the first differing line number or None, its two lines)."""
    n = 0
    with open(ref_path) as a, open(cxx_path) as b:
        while True:
            x, y = a.readline(), b.readline()
            if not x and not y:
                return n, None, None
            n += 1
            if x != y:
                return n, n, (x.strip(), y.strip())


def behaviour(ref_path, cxx_path):
    """The plan's behavioural parity on the two outputs: the worst ratio difference (ppb) over the
    reads both print, and whether every event and recalibration sits at the same read."""
    def reads(path):
        rows, marks = [], []
        with open(path) as f:
            for raw in f:
                o = json.loads(raw)
                if "ratio_ppb" in o:
                    rows.append(o["ratio_ppb"])
                elif "event" in o or "recalibrated" in o:
                    marks.append((len(rows), o.get("event", "recalibrated"), o.get("reason")))
        return rows, marks
    a, ma = reads(ref_path)
    b, mb = reads(cxx_path)
    worst = max((abs(x - y) for x, y in zip(a, b)), default=0)
    return len(a) == len(b), worst, ma == mb, len(ma)


def count(path):
    reads = events = lateness = summaries = 0
    with open(path) as f:
        for raw in f:
            reads += raw.startswith('{"mono"')
            events += raw.startswith('{"event"')
            lateness += raw.startswith('{"lateness"')
            summaries += raw.startswith('{"summary"')
    return reads, events, lateness, summaries


def main():
    if not os.access(CLI, os.X_OK):
        print("SKIP asrc_device_parity_test.py — %s not built (make native)" % CLI)
        return 0
    with tempfile.TemporaryDirectory(prefix="asrc_device_parity_") as tmp:
        cases = os.path.join(tmp, "cases.jsonl")
        env = dict(os.environ, ASRC_DEVICE_TRACE=cases)
        done = subprocess.run([sys.executable, os.path.join(HERE, "asrc_device_ref_test.py")],
                              cwd=HERE, env=env, capture_output=True, text=True)
        check("the reference's suite passes while ASRC_DEVICE_TRACE records its calls",
              done.returncode == 0 and "ALL asrc_device_ref TESTS PASSED" in done.stdout)
        rnd = os.path.join(tmp, "random.jsonl")
        with open(rnd, "w") as f:
            random_ops(f)
        trace = os.path.join(at.FIXTURES, at.TRACES[1])
        paths = [rnd, trace, cases]   # the random runs first: they tell the mutants apart
        names = ["the random runs", "the recorded %s" % os.path.basename(trace), "the cases"]
        outs = [os.path.join(tmp, "out-%d.cxx" % i) for i in range(len(paths))]
        for name, path, out in zip(names, paths, outs):
            rc, err = cpp(path, out)
            reads, events, lateness, summaries = count(out)
            check("mrts_cli asrc-device replays %s: %d reads, %d events, %d lateness reads, %d terms%s"
                  % (name, reads, events, lateness, summaries, "" if rc == 0 else " (exit %d: %s)" % (rc, err)),
                  rc == 0 and reads > 0 and summaries > 0)
            ref = out + ".ref"
            with open(ref, "w") as f:
                subprocess.run([sys.executable, os.path.join(HERE, "asrc_device_ref.py"), path], stdout=f,
                               cwd=HERE, check=False)
            same_reads, worst, same_marks, marks = behaviour(ref, out)
            check("%s: behavioural parity: the ratio within 0.1 ppm at every read (worst %d ppb), %d events "
                  "and recalibrations at the same reads" % (name, worst, marks),
                  same_reads and worst <= 100 and same_marks)
            n, at_line, lines = same_lines(ref, out)
            check("%s: every line equals asrc_device_ref.py's (%d compared%s)"
                  % (name, n, "" if at_line is None else "; line %d: %s vs %s" % (at_line, lines[0], lines[1])),
                  at_line is None and n > 0)
        caught = 0
        for name, _case, fname, edits in at.MUTANTS:
            mdir = os.path.join(tmp, "mutant")
            shutil.rmtree(mdir, ignore_errors=True)
            os.makedirs(mdir)
            for other in ("asrc_device_ref.py", "clock_lock.py"):
                shutil.copy(os.path.join(HERE, other), mdir)
            with open(os.path.join(HERE, fname)) as f:
                src = f.read()
            applies = all(src.count(old) == 1 for old, _ in edits)
            for old, new in edits:
                src = src.replace(old, new)
            with open(os.path.join(mdir, fname), "w") as f:
                f.write(src)
            n, at_line, _lines = first_difference(os.path.join(mdir, "asrc_device_ref.py"), paths, outs)
            told = applies and at_line is not None
            caught += told
            print("  mutant %r: %s" % (name, "line %d of %d differs" % (at_line, n) if at_line else "no difference"))
        check("parity tells the reference's mutants from mrts_cli: %d of %d" % (caught, len(at.MUTANTS)),
              caught == len(at.MUTANTS))
    if _failures:
        print("\n%d FAILURE(S) in asrc_device_parity" % _failures)
        return 1
    print("\nALL asrc_device_parity TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
