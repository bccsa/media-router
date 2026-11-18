#!/usr/bin/env python3
"""mrts::AsrcCatchUp against its reference (plan ch. 15.4 B-249, the catch-up): `mrts_cli catch-up` reads
catch_up_ref.py's line format, and every answer (the command, the excess, the state; what was removed) must equal
the reference's, line for line, on

  - the event streams of catch_up_ref_test.py's model: the late start, a field walk, rising then falling, two
    spikes, a device 100 ppm fast, an early feed and the Audio Decoder's bursts; and the default start threshold;
  - 200 seeded random runs of 400 events: new catch-ups (margins, rates, the rate past its cap, windows 0 to 60 s,
    start thresholds), resets, samples with and without `due`, totals behind and far past the point of no return
    (up to 2^50), and output under a command;

then each mutant of catch_up_ref_test.MUTANTS must differ from mrts_cli on the model's streams. Skips (exit 0)
without mrts_cli (make native).

Run:  python3 catch_up_parity_test.py
"""
import json
import os
import random
import subprocess
import sys

import catch_up_ref as cu
import catch_up_ref_test as ct

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def replay(events, cls=cu.CatchUp):
    """The reference's answer to each event, as `mrts_cli catch-up` prints it."""
    c, out = cls(0, 48000), []
    for e in events:
        if "margin" in e:
            kw = {k: e[v] for k, v in (("ppb", "ppb"), ("window_ns", "window"), ("start_frames", "start")) if v in e}
            c = cls(e["margin"], e["hz"], **kw)
            out.append({"ok": 1})
        elif "reset" in e:
            c.reset(e["reset"])
            out.append({"ok": 1})
        elif "produced" in e:
            c.produced(e["produced"], e["ppb"])
            out.append({"removed": c.removed()})
        else:
            cmd = c.sample(e["t"], e["total"], e["consumed"], e.get("due"))
            out.append({"cmd": cmd, "excess": c.excess, "state": c.state()})
    return out


def cli(events):
    text = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events)
    r = subprocess.run([CLI, "catch-up", "-"], input=text, capture_output=True, text=True, check=False)
    if r.returncode != 0:
        print(r.stderr)
        return None
    return [json.loads(l) for l in r.stdout.splitlines() if l.strip()]


def model_streams():
    streams = {}
    runs = {
        "late start": dict(late_ms=[30.0] * 29000, sink_delay_ms=800),
        "field": dict(late_ms=ct.walk(20000, 30.0, 70.0, 30.0, 0, 7)),
        "rise-fall": dict(late_ms=[30.0 if i < 1000 else min(200.0, 30 + (i - 1000) * 0.17) if i < 4000 else 30.0
                                   for i in range(15000)]),
        "spikes": dict(late_ms=[400.0 if (1000 <= i < 1100 or 20000 <= i < 20100) else 30.0 for i in range(38000)]),
        "drift": dict(late_ms=[30.0] * 20000, ppm=100),
        "early": dict(late_ms=[-200.0] * 8000),
        "decoder": dict(late_ms=[30.0] * 12000, sink_delay_ms=300, shape="upq", burst=15),
    }
    for name, kw in runs.items():
        tr = []
        ct.simulate(trace=tr, **kw)
        streams[name] = tr
    # The default start (20 ms at 48 kHz: 960 frames): a window at 959 past the margin, then at 960 (review 4).
    th = []
    for over in (959, 960):
        th += [{"margin": 2880, "hz": 48000, "window": 10 ** 10}]
        th += [{"t": k * 10 ** 9, "total": 1000 + 2880 + over, "consumed": 1000} for k in range(12)]
    streams["start threshold"] = th
    return streams


def random_events(seed=23, runs=200, n=400):
    r, out = random.Random(seed), []
    for _ in range(runs):
        hz = r.choice((48000, 44100, 96000))
        e = {"margin": r.choice((0, 2880, r.randrange(20000))), "hz": hz}
        if r.random() < 0.7:
            e["ppb"] = r.choice((cu.RATE_PPM * 1000, 0, 7_000_000, r.randrange(6_000_000)))
        if r.random() < 0.7:
            e["window"] = r.choice((0, 1, 10 ** 9, cu.WINDOW_MS * cu.MS, r.randrange(60 * 10 ** 9)))
        if r.random() < 0.5:
            e["start"] = r.choice((1, 960, r.randrange(5000)))
        out.append(e)
        t, consumed = r.randrange(10 ** 12), r.randrange(1 << 40)
        for _ in range(n):
            x = r.random()
            if x < 0.03:
                t += r.randrange(10 ** 9)
                out.append({"reset": t})
            elif x < 0.35:
                out.append({"produced": r.choice((0, 480, r.randrange(1, 100000))),
                            "ppb": r.choice((0, cu.RATE_PPM * 1000, r.randrange(6_000_000)))})
            else:
                t += r.choice((10 ** 7, r.randrange(10 ** 9), r.randrange(10 ** 11)))
                consumed += r.randrange(1000)
                s = {"t": t, "total": consumed + r.choice((r.randrange(-5000, 50000), r.randrange(1 << 50))),
                     "consumed": consumed}
                if r.random() < 0.5:
                    s["due"] = r.randrange(-10000, 60000)
                out.append(s)
    return out


def main():
    if not os.access(CLI, os.X_OK):
        print(f"SKIP catch_up_parity_test.py: {CLI} not built (make native)")
        return 0
    streams = model_streams()
    for name, ev in streams.items():
        got, want = cli(ev), replay(ev)
        ok = got is not None and len(got) == len(ev)
        diff = [i for i, (a, b) in enumerate(zip(got or [], want)) if a != b]
        cmds = sum(1 for w in want if w.get("cmd"))
        check(f"the model's {name}: {len(ev)} events, every answer the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first: ' + json.dumps(ev[diff[0]]) + f' cli {got[diff[0]]} ref {want[diff[0]]}'}"
              f"; {cmds} samples catching up)", ok and not diff)
    ev = random_events()
    got, want = cli(ev), replay(ev)
    diff = [i for i, (a, b) in enumerate(zip(got or [], want)) if a != b]
    states = {w.get("state") for w in want if "state" in w}
    check(f"{len(ev)} random events: every answer the reference's ({len(diff)} differ"
          f"{'' if not diff else ', first: ' + json.dumps(ev[diff[0]]) + f' cli {got[diff[0]]} ref {want[diff[0]]}'}"
          f"; states {sorted(states)})", got is not None and len(got) == len(ev) and not diff and len(states) == 3)
    for name, cls in ct.MUTANTS.items():
        n = 0
        for ev in streams.values():
            got = cli(ev) or []
            n += sum(1 for a, b in zip(got, replay(ev, cls)) if a != b)
        check(f"mutant {name}: told from mrts_cli ({n} answers differ)", n > 0)
    r = subprocess.run([CLI, "catch-up", "-"], input='{"t":3}\n', capture_output=True, text=True, check=False)
    check(f"a malformed event is refused (exit {r.returncode}: {r.stderr.strip()})", r.returncode == 1 and "total" in r.stderr)
    print(f"\n{'ALL PASS' if not _failures else f'{_failures} FAILED'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
