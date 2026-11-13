#!/usr/bin/env python3
"""mrts::TrustGate against its reference (ch. 15.4 B-226, p5-6b; WI-P5-6 + WI-P5-7, S5, S35):
`mrts_cli trust-replay --pes` reads trust_gate.py's event list, and every line it prints (each
transition, each PES's mapping, each program's summary) must equal trust_gate.py's, byte for byte, on

  - every event list trust_ref_test.py builds (its cases, from fixture_gen version-2 traces);
  - the five pinned trust-*.expect.jsonl specs;
  - 60 random ones (seeded): generated traces with mode flips, clock losses and re-epochs, L and
    tau moves, O and trims, natural gaps (a re-lock's of 0 too), a config line, over 30 to 120 s.

Then each of trust_ref_test.py's mutants replays its case's lists, and parity must tell it from
mrts_cli. Needs the built natives (make in native/mrts).

Run:  python3 trust_parity_test.py
"""
import json
import os
import random
import subprocess
import sys

import trust_gate as tg
import trust_ref_test as rt

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
RANDOM_RUNS = 60
MS, SEC = tg.MS, tg.SEC

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def ref_lines(evs):
    return [json.dumps(x, separators=(",", ":")) for x in tg.run(evs, True)]


def cli_lines(evs):
    text = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in evs)
    p = subprocess.run([CLI, "trust-replay", "-", "--pes"], input=text.encode(), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE)
    if p.returncode != 0:
        return ["rc=%d %s" % (p.returncode, p.stderr.decode().strip())]
    return p.stdout.decode().splitlines()


def first_diff(a, b):
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else "<end>"
        y = b[i] if i < len(b) else "<end>"
        if x != y:
            return "line %d\n    ref %s\n    cli %s" % (i + 1, x[:300], y[:300])
    return None


class Recorder:
    """trust_ref_test's lines() with every event list it is given kept, by case."""

    def __init__(self):
        self.lists, self.case = {}, None
        self.orig = rt.lines

    def __enter__(self):
        def lines(evs, pes=False):
            self.lists.setdefault(self.case, []).append([dict(e) for e in evs])
            return self.orig(evs, pes)
        rt.lines = lines
        return self

    def __exit__(self, *a):
        rt.lines = self.orig


def suite_lists():
    with Recorder() as r:
        for name, fn in rt.CASES.items():
            r.case = name
            fn()
    return r.lists


def random_list(rng, i):
    secs = rng.randint(30, 120)
    delay = rng.choice([5, 300, 1500, 1900, 2000, 2300]) if rng.random() < 0.4 else rng.choice([300, 1500])
    jitter = rng.choice([0, 1, 2, 10])
    decl = rng.choice(["200", "200:255", "120:4:0123456789abcdef", "200:10:0000000000000000:0x40", "50:31"])
    extra = []
    if rng.random() < 0.4:
        extra.append("--outage %d:%d" % (rng.randint(5, secs - 3), rng.choice([1200, 3000])))
    if rng.random() < 0.3:
        extra.append("--jump %d:%d:di" % (rng.randint(5, secs - 3), rng.choice([500, -100, -37000])))
    pids = rng.choice(["v,a2", "v", "v,a1,a2"])
    args = rt.base(seconds=secs, delay=delay, jitter=jitter, decl=decl, pids=pids, extra=" ".join(extra))
    mode = rng.choice(["trust", "trust", "restamp"])
    ev = rt.setup(l_ms=rng.choice([0, 2000, 2000]), mode=mode, e_ns=rt.E_RX + rng.choice([0, 0, 15 * MS, -30 * MS]))
    config = rng.random() < 0.5
    for _ in range(rng.randint(2, 10)):
        at = round(rng.uniform(0.5, secs - 0.5), 3)
        c = rng.random()
        if c < 0.18:
            ev.append({"kind": "mode", "atS": at, "mode": rng.choice(["trust", "restamp"])})
        elif c < 0.36:
            ev.append(rt.clock(at, disciplined=rng.random() < 0.6, e_ns=rt.E_RX + rng.choice([0, 0, 300 * MS, -300 * MS]),
                               error_us=rng.choice([None, 100, 5000]), seq=rng.randint(1, 3)))
        elif c < 0.5:
            ev.append({"kind": "natural-gap", "atS": at, "gapNs": rng.choice([5 * MS, 500 * MS, 3 * SEC])})
        elif c < 0.62:
            ev.append({"kind": rng.choice(["l", "tau"]), "atS": at, "ns": rng.choice([0, 200, 2000]) * MS})
        elif c < 0.74:
            ev.append({"kind": "offset", "atS": at, "ns": rng.choice([-200, 500]) * MS})
        elif c < 0.86:
            ev.append({"kind": "trim", "atS": at, "pid": 0x102, "ns": 40 * MS})
        else:
            ev.append({"kind": "natural-gap", "atS": at, "gapNs": 0})
    ev.sort(key=lambda x: x["atS"])
    evs = rt.gen(args, ev, rng.choice([0, 2100 * MS, 2200 * MS]))
    if config:   # a config line carries no "t"
        evs.insert(0, {"kind": "config", "qualifyNs": rng.choice([1, 2]) * SEC,
                       "returnGapWaitNs": rng.choice([5, 30]) * SEC})
    return evs


def main():
    if not os.access(CLI, os.X_OK):
        print("FAIL %s not built: run make in native/mrts first" % CLI)
        return 1
    lists = suite_lists()
    n = sum(len(v) for v in lists.values())
    check("trust_ref_test's cases give %d event lists" % n, n >= 42)
    for case, evss in lists.items():
        bad = None
        for evs in evss:
            d = first_diff(ref_lines(evs), cli_lines(evs))
            if d:
                bad = d
                break
        check("case %s: %d list(s) replay identically" % (case, len(evss)), bad is None)
        if bad:
            print("  " + bad)
    rng = random.Random(20261112)
    worst = None
    switched = converged = 0
    for i in range(RANDOM_RUNS):
        evs = random_list(rng, i)
        ref = ref_lines(evs)
        d = first_diff(ref, cli_lines(evs))
        switched += any('"switch-to-' in x for x in ref)
        converged += any('"decision":"switch-to-trust"' in x and '"state":"converging"' in x for x in ref)
        if d and worst is None:
            worst = "random %d: %s" % (i, d)
    check("%d random event lists replay identically" % RANDOM_RUNS, worst is None)
    if worst:
        print("  " + worst)
    check("the random lists switch (%d of %d with a switch)" % (switched, RANDOM_RUNS), switched >= 15)
    check("and into converging (%d of %d)" % (converged, RANDOM_RUNS), converged >= 3)
    for label, patch, case in rt.MUTANTS:
        undo = patch()
        try:
            told = any(first_diff(ref_lines(evs), cli_lines(evs)) for evs in lists[case])
        finally:
            undo()
        check("mutant told from mrts_cli: %s (%s)" % (label, case), told)
    bad_lines = [('{"t":1,"kind":"nope"}', "unknown event kind"), ('{"t":1,"kind":"tick"}', "unknown event kind"),
                 ('{"kind":"config","zz":1}', "unknown config key"),
                 ('{"t":1,"kind":"pcr","pid":1}', '"pcr"'), ('{"t":1,"kind":"decl","program":1,"present":true}', '"')]
    ok = True
    for text, want in bad_lines:
        p = subprocess.run([CLI, "trust-replay", "-"], input=(text + "\n").encode(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE)
        ok = ok and p.returncode == 1 and want in p.stderr.decode() and ":1:" in p.stderr.decode()
    check("trust-replay refuses a bad line (a tick too: no gate steps in a silence) with its number (exit 1)", ok)
    p = subprocess.run([CLI, "trust-replay"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    check("trust-replay without input exits 2", p.returncode == 2)
    if _failures:
        print("\n%d FAILURE(S) in trust_parity_test" % _failures)
        return 1
    print("\nALL trust_parity_test TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
