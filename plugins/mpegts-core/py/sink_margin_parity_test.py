#!/usr/bin/env python3
"""mrts::asrc_sink_silence against its reference (plan ch. 15.4 B-249): `mrts_cli sink-margin` reads
sink_margin_ref.py's line format, and its silence must equal the reference's, line for line, on

  - the rule's edges: every next_sample from none to three segments past segdone + 2, every segdone
    0-5, with and without a device clock before, at and past the segment in flight, margins 0, 1 frame,
    60 ms and 300 ms, at 10 ms and 20 ms segments (48 kHz) and 7 ms at 44.1 kHz;
  - 5,000 random cases (seeded): writes behind, into and past the segment in flight, long-running rings
    (segdone up to 2^40), clocks behind and ahead.

Then each of the reference suite's mutants (sink_margin_ref_test.MUTANTS) must differ from mrts_cli on
these cases. Skips (exit 0) without mrts_cli (make native).

Run:  python3 sink_margin_parity_test.py
"""
import json
import os
import random
import subprocess
import sys

import sink_margin_ref as sm
import sink_margin_ref_test as st

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
RANDOM_CASES = 5000

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def edge_cases():
    out = []
    for sps in (480, 960, 309):
        for margin in (0, 1, 60 * 48, 300 * 48):
            for segdone in range(6):
                for nxt in [-1] + list(range(0, (segdone + 5) * sps, max(1, sps // 4))):
                    for play in (None, segdone * sps, (segdone + 1) * sps, (segdone + 3) * sps + 17):
                        c = {"next": nxt, "segdone": segdone, "sps": sps, "margin": margin}
                        if play is not None:
                            c["play"] = play
                        out.append(c)
    return out


def random_cases(seed=11):
    r, out = random.Random(seed), []
    for _ in range(RANDOM_CASES):
        sps = r.choice((480, 960, 441, 240))
        segdone = r.choice((0, 1, r.randrange(1000), r.randrange(1 << 40)))
        base = segdone * sps
        nxt = r.choice((-1, max(0, base + r.randrange(-50 * sps, 5 * sps)), base + r.randrange(sps)))
        c = {"next": nxt, "segdone": segdone, "sps": sps, "margin": r.choice((0, 2880, r.randrange(20000)))}
        if r.random() < 0.6:
            c["play"] = max(0, base + r.randrange(-10 * sps, 10 * sps))
        out.append(c)
    return out


def ref(cases, rule=None):
    rule = rule or sm.silence_frames
    return [rule(c["next"], c["segdone"], c["sps"], c["margin"], c.get("play")) for c in cases]


def cli(cases):
    text = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in cases)
    r = subprocess.run([CLI, "sink-margin", "-"], input=text, capture_output=True, text=True, check=False)
    if r.returncode != 0:
        print(r.stderr)
        return None
    return [json.loads(l)["silence"] for l in r.stdout.splitlines() if l.strip()]


def main():
    if not os.access(CLI, os.X_OK):
        print(f"SKIP sink_margin_parity_test.py: {CLI} not built (make native)")
        return 0
    cases = edge_cases() + random_cases()
    got = cli(cases)
    want = ref(cases)
    check(f"mrts_cli sink-margin ran on {len(cases)} cases", got is not None and len(got) == len(cases))
    if got is not None:
        diff = [i for i, (a, b) in enumerate(zip(got, want)) if a != b]
        check(f"... every silence equals the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first: ' + json.dumps(cases[diff[0]]) + f' cli {got[diff[0]]} ref {want[diff[0]]}'})",
              not diff)
        check(f"... the cases exercise it: {sum(1 for w in want if w)} with silence, "
              f"{sum(1 for w in want if not w)} without", 0 < sum(1 for w in want if w) < len(want))
        for name, fn in st.MUTANTS.items():
            m = ref(cases, fn)
            n = sum(1 for a, b in zip(got, m) if a != b)
            check(f"mutant {name}: told from mrts_cli ({n} cases differ)", n > 0)
    print(f"\n{'ALL PASS' if not _failures else f'{_failures} FAILED'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
