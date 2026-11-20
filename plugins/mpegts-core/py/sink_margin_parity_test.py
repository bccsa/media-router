#!/usr/bin/env python3
"""mrts::asrc_sink_silence against its reference (plan ch. 15.4 B-249): `mrts_cli sink-margin` reads
sink_margin_ref.py's line format, and its silence must equal the reference's, line for line, on

  - the rule's edges: every next_sample from none to three segments past segdone + 2, every segdone
    0-5, with and without a device clock before, at and past the segment in flight, margins 0, 1 frame,
    60 ms and 300 ms, guards 0, a segment and 2.5 margins (60 ms), at 10 ms and 20 ms segments (48 kHz)
    and 7 ms at 44.1 kHz;
  - 5,000 random cases (seeded): writes behind, into and past the segment in flight, long-running rings
    (segdone up to 2^40), clocks behind and ahead, guards 0 to 500 ms, caps none, 3 s and smaller;
  - the guard (mrts::AsrcSinkGuard against SinkGuard): 300 seeded runs of 60 events (a new guard, then
    segdone seen against the clock), the guard after each;
  - whether the guard holds a write (asrc_sink_guard_applies against guard_applies): every residence, push
    and since around a segment and the 2 ms block, and 3,000 random ones;
  - whether a write is held to segdone alone (asrc_sink_stream_full against stream_full) and the push before a
    write from a queue's thread (asrc_sink_queued_push against queued_push), c41: every value around their
    edges, and 3,000 random ones each.

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
                        for guard in (0, sps, 5 * margin // 2):
                            c = {"next": nxt, "segdone": segdone, "sps": sps, "margin": margin, "guard": guard}
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
        if r.random() < 0.7:
            c["guard"] = r.choice((0, 1920, 3840, r.randrange(24000)))

        if r.random() < 0.6:
            c["play"] = max(0, base + r.randrange(-10 * sps, 10 * sps))
        if r.random() < 0.5:
            c["cap"] = r.choice((0, sm.REFILL_MAX_MS * 48, r.randrange(1, 4000)))
        out.append(c)
    return out


def applies_cases(seed=17):
    seg, out = 10_000_000, []
    edges = (0, 1, sm.BLOCKED_NS - 1, sm.BLOCKED_NS, seg - 1, seg, seg + 1, 5 * seg)
    for res in edges:
        for push in edges:
            for since in edges:
                out.append({"res": res, "push": push, "since": since, "segns": seg})
    r = random.Random(seed)
    for _ in range(3000):
        segns = r.choice((seg, 20_000_000, 7_000_000))
        out.append({"res": r.randrange(3 * segns), "push": r.choice((0, r.randrange(4 * sm.BLOCKED_NS), r.randrange(10**8))),
                    "since": r.choice((r.randrange(2 * segns), r.randrange(10**10))), "segns": segns})
    return out


def full_cases(seed=19):
    seg, out = 10_000_000, []
    edges = (0, 1, sm.BLOCKED_NS - 1, sm.BLOCKED_NS, seg - 1, seg, seg + 1, 330_000_000)
    for push in edges:
        for since in edges:
            out.append({"push": push, "since": since, "segns": seg})
    r = random.Random(seed)
    for _ in range(3000):
        segns = r.choice((seg, 20_000_000, 7_000_000))
        out.append({"push": r.choice((0, r.randrange(4 * sm.BLOCKED_NS), r.randrange(10**9))),
                    "since": r.choice((r.randrange(2 * segns), r.randrange(10**10))), "segns": segns})
    return out


def queued_cases(seed=23):
    out = []
    edges = (-1, 0, 1, 9_999_999, 10_000_000, 330_000_000, 912_000_000)
    for gap in edges:
        for res in edges:
            for wait in edges:
                out.append({"gap": gap, "res": res, "busy": wait})
    r = random.Random(seed)
    for _ in range(3000):
        gap = r.choice((0, r.randrange(30_000_000), r.randrange(10**9)))
        out.append({"gap": gap, "res": r.choice((r.randrange(gap + 1) if gap else 0, gap + r.randrange(10**9))),
                    "busy": r.choice((-1, 0, r.randrange(gap + 1) if gap else 0, r.randrange(10**8)))})
    return out


def ref(cases, rule=None):
    rule = rule or sm.silence_frames
    return [rule(c["next"], c["segdone"], c["sps"], c["margin"], c.get("play"), c.get("guard", 0), c.get("cap", 0))
            for c in cases]


def guard_events(seed=13, runs=300, n=60):
    r, out = random.Random(seed), []
    for _ in range(runs):
        sps = r.choice((480, 441, 960))
        out.append({"base": r.choice((0, 4 * sps, r.randrange(10000))), "cap": r.choice((24000, 22050, r.randrange(30000)))})
        seg = 0
        for _ in range(n):
            seg += r.choice((0, 0, 1, r.randrange(200)))
            out.append({"seg": seg, "sps": sps, "play": max(0, seg * sps + r.randrange(-4000, 4000))})
    return out


def ref_guard(events):
    g, res = sm.SinkGuard(), []
    for e in events:
        if "base" in e:
            g = sm.SinkGuard(e["base"], e["cap"])
        else:
            g.segdone_seen(e["seg"], e["sps"], e["play"])
        res.append(g.frames())
    return res


def cli(cases, key="silence"):
    text = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in cases)
    r = subprocess.run([CLI, "sink-margin", "-"], input=text, capture_output=True, text=True, check=False)
    if r.returncode != 0:
        print(r.stderr)
        return None
    return [json.loads(l)[key] for l in r.stdout.splitlines() if l.strip()]


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
    ev = guard_events()
    gg, gw = cli(ev, "guard"), ref_guard(ev)
    check(f"mrts_cli sink-margin ran {len(ev)} guard events", gg is not None and len(gg) == len(ev))
    if gg is not None:
        diff = [i for i, (a, b) in enumerate(zip(gg, gw)) if a != b]
        check(f"... every guard equals the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first at ' + str(diff[0]) + f' cli {gg[diff[0]]} ref {gw[diff[0]]}'})", not diff)
        check(f"... the events move it: {len(set(gw))} distinct guards, {sum(1 for v in gw if v == 0)} at 0",
              len(set(gw)) > 50)
    ac = applies_cases()
    ga, gw = cli(ac, "applies"), [int(sm.guard_applies(c["res"], c["push"], c["since"], c["segns"])) for c in ac]
    check(f"mrts_cli sink-margin ran {len(ac)} guard tests", ga is not None and len(ga) == len(ac))
    if ga is not None:
        diff = [i for i, (a, b) in enumerate(zip(ga, gw)) if a != b]
        check(f"... every answer equals the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first: ' + json.dumps(ac[diff[0]])}), {sum(gw)} hold, {len(gw) - sum(gw)} not",
              not diff and 0 < sum(gw) < len(gw))
        for name, fn in st.GATE_MUTANTS.items():
            n = sum(1 for c, a in zip(ac, ga) if int(fn(c["res"], c["push"], c["since"], c["segns"])) != a)
            check(f"mutant {name}: told from mrts_cli ({n} cases differ)", n > 0)
    fc = full_cases()
    gf, wf = cli(fc, "full"), [int(sm.stream_full(c["push"], c["since"], c["segns"])) for c in fc]
    check(f"mrts_cli sink-margin ran {len(fc)} full-stream tests", gf is not None and len(gf) == len(fc))
    if gf is not None:
        diff = [i for i, (a, b) in enumerate(zip(gf, wf)) if a != b]
        check(f"... every answer equals the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first: ' + json.dumps(fc[diff[0]])}), {sum(wf)} full, {len(wf) - sum(wf)} not",
              not diff and 0 < sum(wf) < len(wf))
        for name, fn in st.FULL_MUTANTS.items():
            n = sum(1 for c, a in zip(fc, gf) if int(fn(c["push"], c["since"], c["segns"])) != a)
            check(f"mutant {name}: told from mrts_cli ({n} cases differ)", n > 0)
    qc = queued_cases()
    text = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in qc)
    rq = subprocess.run([CLI, "sink-margin", "-"], input=text, capture_output=True, text=True, check=False)
    gq = [tuple(json.loads(l)[k] for k in ("push", "since")) for l in rq.stdout.splitlines() if l.strip()] \
        if rq.returncode == 0 else None
    wq = [sm.queued_push(c["gap"], c["res"], c["busy"]) for c in qc]
    check(f"mrts_cli sink-margin ran {len(qc)} queued-push reads", gq is not None and len(gq) == len(qc))
    if gq is not None:
        diff = [i for i, (a, b) in enumerate(zip(gq, wq)) if tuple(a) != tuple(b)]
        check(f"... every (push, since) equals the reference's ({len(diff)} differ"
              f"{'' if not diff else ', first: ' + json.dumps(qc[diff[0]]) + f' cli {gq[diff[0]]} ref {wq[diff[0]]}'})"
              f", {sum(1 for p, _ in wq if p >= sm.BLOCKED_NS)} a blocked push", not diff and any(p for p, _ in wq))
        for name, fn in st.QUEUED_MUTANTS.items():
            n = sum(1 for c, a in zip(qc, gq) if tuple(fn(c["gap"], c["res"], c["busy"])) != tuple(a))
            check(f"mutant {name}: told from mrts_cli ({n} cases differ)", n > 0)
    r = subprocess.run([CLI, "sink-margin", "-"], input='{"seg":3}\n', capture_output=True, text=True, check=False)
    check(f"a malformed event is refused (exit {r.returncode}: {r.stderr.strip()})", r.returncode == 1 and "sps" in r.stderr)
    print(f"\n{'ALL PASS' if not _failures else f'{_failures} FAILED'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
