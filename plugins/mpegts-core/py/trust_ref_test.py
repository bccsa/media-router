#!/usr/bin/env python3
"""trust_gate.py's suite (p5-6a, register B-225; plan ch. 9 WI-P5-6 and WI-P5-7 acceptance): event
lists from `mrts_cli trace2jsonl` of `fixture_gen --trace --decl ... --sender-epoch ...` version-2
traces (the built natives; rebuild them first), with the clock, L, mode and gap events and each
PES's STC value (net_to_bus + K: the transit floor + D_e) added here; the pinned expectations
../tests/fixtures/restamp/trust-*.expect.jsonl (a header line naming the trace and the added events,
then the reference's lines); then the mutants, each failing its case.
Run: python3 trust_ref_test.py [case...] [--update] (rewrites the expectations' lines)."""
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile

import trust_gate as tg
from trust_gate import MS, SEC, PTS_WRAP, fold33, net_to_bus, ns_to_pts90k

HERE = os.path.dirname(os.path.abspath(__file__))
NATIVE = os.path.join(HERE, "..", "native", "mrts")
FIXTURES = os.path.join(HERE, "..", "tests", "fixtures", "restamp")
FG = os.path.join(NATIVE, "tests", "fixture_gen")
CLI = os.path.join(NATIVE, "mrts_cli")
UPDATE = "--update" in sys.argv

HOUSE0 = 1000 * SEC                   # fixture_gen's default --house0
EPOCH_S = 1800000000                  # the sender's house (TAI-scale) time at the first send
E_RX = EPOCH_S * SEC - HOUSE0         # the receiver's E: the transit is the path's delay
TMP = tempfile.mkdtemp(prefix="trust-ref-", dir="/dev/shm" if os.path.isdir("/dev/shm") else None)
atexit.register(shutil.rmtree, TMP, True)   # this run's traces only


def clock(at_s=0, e_ns=E_RX, disciplined=True, error_us=100, seq=1):
    return {"kind": "clock", "atS": at_s, "eNs": e_ns, "seq": seq, "disciplined": disciplined, "errorUs": error_us}


def setup(l_ms=2000, mode="trust", **kw):
    return [clock(**kw), {"kind": "l", "atS": 0, "ns": l_ms * MS}, {"kind": "mode", "atS": 0, "mode": mode}]


_cache = {}


def trace(args):
    """trace2jsonl's lines of `fixture_gen --trace ARGS`."""
    key = " ".join(args)
    if key not in _cache:
        for tool in (FG, CLI):
            if not os.access(tool, os.X_OK):
                raise SystemExit("FAIL %s not built: run make in native/mrts first" % tool)
        path = os.path.join(TMP, "t%d.stct" % len(_cache))
        subprocess.run([FG, "--trace", "-o", path] + args, check=True, stdout=subprocess.DEVNULL)
        out = subprocess.run([CLI, "trace2jsonl", path], check=True, stdout=subprocess.PIPE).stdout
        _cache[key] = [json.loads(line) for line in out.decode().splitlines() if line.strip()]
    return [dict(e) for e in _cache[key]]


def build(spec):
    """An event list from a spec: {"source": fixture_gen arguments after --trace, "events": added
    events at "atS" seconds of house time after --house0, "stcNs": K, "declEdits": [{"fromS",
    field: value}] changing every decl line from then}."""
    src = spec["source"].split()
    assert src[:2] == ["fixture_gen", "--trace"], spec["source"]
    evs = trace(src[2:])
    for ed in spec.get("declEdits", []):
        for e in evs:
            if e["kind"] == "decl" and e["t"] >= HOUSE0 + int(ed["fromS"] * SEC):
                e.update({k: v for k, v in ed.items() if k != "fromS"})
    k90 = ns_to_pts90k(spec.get("stcNs", 0))
    e_rx = next((x["eNs"] for x in spec["events"] if x["kind"] == "clock"), E_RX)
    for e in evs:
        if e["kind"] == "pes":
            e["stc"] = (net_to_bus(e["pts"], e_rx) + k90) % PTS_WRAP
    added = []
    for x in spec["events"]:
        y = {k: v for k, v in x.items() if k != "atS"}
        y["t"] = HOUSE0 + int(round(x["atS"] * SEC))
        added.append(y)
    out, i = [], 0
    for e in evs:
        while i < len(added) and added[i]["t"] <= e["t"]:
            out.append(added[i])
            i += 1
        out.append(e)
    return out + added[i:]


def gen(args, events, stc_ns=0, edits=()):
    return build({"source": "fixture_gen --trace " + args, "events": events, "stcNs": stc_ns,
                  "declEdits": list(edits)})


def lines(evs, pes=False):
    return tg.run(evs, pes)


def transitions(out):
    return [x for x in out if "decision" in x]


def summary(out):
    return [x for x in out if "digest" in x][-1]


def rel(t):
    return (t - HOUSE0) / SEC


def base(extra="", seconds=60, delay=1900, jitter=2, pcr=35, decl="200", pids="v,a2", epoch=EPOCH_S):
    a = "--duration %d --pids %s --pcr-ms %s --delay-ms %s --jitter-ms %s --sender-epoch %s" % (
        seconds, pids, pcr, delay, jitter, epoch)
    if decl is not None:
        a += " --decl " + decl
    return a + (" " + extra if extra else "")


def pcrs_of(evs):
    return [e for e in evs if e["kind"] == "pcr"]


def transit_ms(e, de90k=18000, e_rx=E_RX):
    return fold33(ns_to_pts90k(e["t"] + e_rx) - (e["pcr"] // 300 + de90k)) / 90.0


def per_pid_monotonic(out, mappings=("trust", "converging")):
    """Every PID's DTS (PTS without one) strictly rising over its mapped rows."""
    last = {}
    for r in out:
        if r.get("mapping") in mappings:
            v = r["dts"] if r["dts"] is not None else r["pts"]
            if r["pid"] in last and fold33(v - last[r["pid"]]) <= 0:
                return False
            last[r["pid"]] = v
    return True


# --- WI-P5-6's acceptance, as event lists -----------------------------------------------------
def case_qualify():
    evs = gen(base(seconds=10), setup())
    out = lines(evs, True)
    tr = transitions(out)
    pcr = [e for e in pcrs_of(evs)]
    trust_rows = [r for r in out if r.get("mapping") == "trust"]
    pes = [e for e in evs if e["kind"] == "pes"]
    exact = all(r["pts"] == net_to_bus(e["pts"], E_RX) for r, e in zip(trust_rows, pes))
    return [
        ("ok at transit 1.9 s with L = 2 s: deciding -> trust", [(x["from"], x["state"]) for x in tr] ==
         [("deciding", "trust")] and tr[0]["decision"] == "release-trust"),
        ("deciding releases on the fifth good PCR", tr[0]["t"] == pcr[4]["t"]),
        ("every PES mapped to net_to_bus exactly (held ones too)", len(trust_rows) == len(pes) and exact),
        ("the transit's median is the path's 1.9 s", 1900 <= summary(out)["transit"]["medianNs"] / MS < 1925),
    ]


def case_transit_high():
    evs = gen(base(seconds=20, jitter=0, delay="1900,2300@10"), setup())
    out = lines(evs)
    tr = transitions(out)
    bad = [e for e in pcrs_of(evs) if transit_ms(e) > 2200]
    fb = [x for x in tr if x["decision"] == "switch-to-restamp"]
    return [
        ("2.3 s falls back after exactly 3 PCRs: transit-high", len(fb) == 1 and fb[0]["t"] == bad[2]["t"] and
         fb[0]["failed"] == "transit-high" and fb[0]["state"] == "fallback"),
        ("two bad PCRs alone keep trust", not any(x["t"] < bad[2]["t"] and x["state"] != "trust" and
                                                  x["from"] == "trust" for x in tr)),
    ]


def first_decision(evs):
    tr = transitions(lines(evs))
    return tr[0] if tr else None


def case_failed_names():
    rows = []
    d = first_decision(gen(base(seconds=5, epoch=EPOCH_S - 37), setup()))
    rows.append(("the sender's TAI offset unset (+37 s) -> transit-high", d["decision"] == "release-restamp" and
                 d["failed"] == "transit-high"))
    d = first_decision(gen(base(seconds=5), setup(e_ns=E_RX - 37 * SEC)))
    rows.append(("the receiver's TAI offset unset (-37 s) -> transit-negative", d["failed"] == "transit-negative"))
    evs = gen(base(seconds=5, decl=None), setup())
    d = first_decision(evs)
    start = evs[[e["kind"] for e in evs].index("psi")]["t"]
    rows.append(("descriptor absent -> no-descriptor after 1 s", d["failed"] == "no-descriptor" and
                 0 <= d["t"] - start - SEC < 50 * MS and d["state"] == "fallback"))
    d = first_decision(gen(base(seconds=5, decl="200:10:0000000000000000:0x80"), setup()))
    rows.append(("sender disciplined = 0 -> sender-undisciplined", d["failed"] == "sender-undisciplined"))
    d = first_decision(gen(base(seconds=5, decl="200:10:0000000000000000:0x40"), setup()))
    rows.append(("house_time_tai = 0 -> not-house-time", d["failed"] == "not-house-time"))
    d = first_decision(gen(base(seconds=5), setup(e_ns=0)))
    rows.append(("local E unknown -> local-undisciplined", d["failed"] == "local-undisciplined"))
    d = first_decision(gen(base(seconds=5), setup(disciplined=False)))
    rows.append(("local clock undisciplined -> local-undisciplined", d["failed"] == "local-undisciplined"))
    return rows


def case_lo_bound():
    # Class 10 (1.024 ms) + local 100 us: lo = -21.12 ms. A path of 5 ms with E 20 ms low: -15 ms.
    ok = first_decision(gen(base(seconds=5, delay=5, jitter=0), setup(e_ns=E_RX - 20 * MS)))
    bad = first_decision(gen(base(seconds=5, delay=5, jitter=0), setup(e_ns=E_RX - 30 * MS)))
    unk = first_decision(gen(base(seconds=5, delay=5, jitter=0, decl="200:255"), setup(e_ns=E_RX - 60 * MS)))
    return [
        ("transit -15 ms inside lo = -(20 ms + 2^10 us + 100 us) qualifies", ok["decision"] == "release-trust"),
        ("transit -25 ms below it -> transit-negative", bad["failed"] == "transit-negative"),
        ("class 0xFF widens lo by 50 ms: -55 ms qualifies", unk["decision"] == "release-trust"),
    ]


def case_deciding_timeout():
    evs = gen(base(seconds=20, pcr=400), setup())
    tr = transitions(lines(evs))
    start = evs[[e["kind"] for e in evs].index("psi")]["t"]
    return [("a 400 ms PCR: deciding ends at 1 s -> fallback", tr[0]["decision"] == "release-restamp" and
             0 <= tr[0]["t"] - start - SEC < 450 * MS),
            ("then 10 s qualified -> returning", any(x["state"] == "returning" for x in tr))]


def drop_clock(at_s, back_s):
    return [clock(at_s, disciplined=False), clock(back_s)]


def case_return_timing():
    q = 20.5
    with_gap = transitions(lines(gen(base(seconds=70), setup() + drop_clock(20, q) +
                                     [{"kind": "natural-gap", "atS": q + 12, "gapNs": 5 * MS}], 2100 * MS)))
    without = transitions(lines(gen(base(seconds=70), setup() + drop_clock(20, q), 2100 * MS)))
    sw = [x for x in with_gap if x["decision"] == "switch-to-trust"]
    sw2 = [x for x in without if x["decision"] == "switch-to-trust"]
    ret = [x for x in without if x["state"] == "returning"]
    return [
        ("the clock lost: fallback at once", any(x["decision"] == "switch-to-restamp" and
                                                 x["failed"] == "local-undisciplined" for x in without)),
        ("10 s qualified -> returning", ret and 10 <= rel(ret[0]["t"]) - q < 10.05),
        ("return at a natural gap at 12 s", len(sw) == 1 and abs(rel(sw[0]["t"]) - (q + 12)) < 1e-9),
        ("or at once at 40 s without one", len(sw2) == 1 and 40 <= rel(sw2[0]["t"]) - q < 40.1),
    ]


def case_operator():
    t0 = 10
    qual = transitions(lines(gen(base(seconds=60), setup(mode="restamp") + [
        {"kind": "mode", "atS": t0, "mode": "trust"}, {"kind": "natural-gap", "atS": t0 + 10, "gapNs": 5 * MS}],
        2100 * MS)))
    qual2 = transitions(lines(gen(base(seconds=60), setup(mode="restamp") + [
        {"kind": "mode", "atS": t0, "mode": "trust"}], 2100 * MS)))
    back = transitions(lines(gen(base(seconds=40), setup() + [
        {"kind": "mode", "atS": t0, "mode": "restamp"}, {"kind": "natural-gap", "atS": t0 + 5, "gapNs": 5 * MS}])))
    back2 = transitions(lines(gen(base(seconds=50), setup() + [{"kind": "mode", "atS": t0, "mode": "restamp"}])))
    s1 = [x for x in qual if x["decision"] == "switch-to-trust"]
    s2 = [x for x in qual2 if x["decision"] == "switch-to-trust"]
    r1 = [x for x in back if x["decision"] == "switch-to-restamp"]
    r2 = [x for x in back2 if x["decision"] == "switch-to-restamp"]
    return [
        ("Trust selected mid-stream -> qualifying", qual[0]["state"] == "qualifying" and rel(qual[0]["t"]) == t0),
        ("taken at a natural gap within 30 s", len(s1) == 1 and rel(s1[0]["t"]) == t0 + 10),
        ("else at once 30 s after 2 s qualified", len(s2) == 1 and 32 <= rel(s2[0]["t"]) - t0 < 32.1),
        ("Restamp selected from trust: at a natural gap", len(r1) == 1 and rel(r1[0]["t"]) == t0 + 5 and
         r1[0]["state"] == "restamp"),
        ("else at once after 30 s", len(r2) == 1 and 30 <= rel(r2[0]["t"]) - t0 < 30.1),
    ]


def wrap_epoch():
    """--sender-epoch seconds that put the network timeline's 33-bit wrap 10 s into the trace."""
    m = (EPOCH_S * 9 // 100000 * SEC) // PTS_WRAP + 1
    return (-(-m * PTS_WRAP * 100000 // 9)) // SEC - 10


def case_wrap():
    ep = wrap_epoch()
    e_rx = ep * SEC - HOUSE0
    evs = gen(base(seconds=20, epoch=ep), setup(e_ns=e_rx), 2100 * MS)
    out = lines(evs, True)
    tr = [transit_ms(e, e_rx=e_rx) for e in pcrs_of(evs)]
    a = [ns_to_pts90k(e["t"] + e_rx) % PTS_WRAP for e in pcrs_of(evs)]
    wrapped = any(a[i + 1] < a[i] for i in range(len(a) - 1))
    rows = [r for r in out if r.get("mapping") == "trust"]
    pes = [e for e in evs if e["kind"] == "pes"]
    return [
        ("the network time wraps inside the trace", wrapped),
        ("the transit is the path's on both sides of the wrap", all(1900 <= x < 1925 for x in tr)),
        ("trust throughout, nothing switched", [x["state"] for x in transitions(out)] == ["trust"]),
        ("PES mapped by net_to_bus across it", all(r["pts"] == net_to_bus(e["pts"], e_rx) for r, e in zip(rows, pes))),
    ]


# --- WI-P5-7's cases and Q1's converging, on generated traces ---------------------------------
K22 = 2200 * MS                       # the STC value's lead on Trust: transit 2 s + D_e 200 ms


def converge_spec(extra_events=(), extra="", seconds=540):
    return gen(base(seconds=seconds, delay=2000, jitter=1, extra=extra), setup(l_ms=2000) +
               drop_clock(20, 21) + list(extra_events), K22)


def case_converge():
    evs = converge_spec()
    out = lines(evs, True)
    tr = transitions(out)
    sw = [x for x in tr if x["decision"] == "switch-to-trust"]
    end = [x for x in tr if x["from"] == "converging" and x["state"] == "trust"]
    conv = [r for r in out if r.get("mapping") == "converging"]
    dur = (end[0]["t"] - sw[0]["t"]) / SEC if sw and end else 0
    ks = [r["k90k"] for r in conv]
    return [
        ("the return converges with k = 2.2 s", len(sw) == 1 and sw[0]["state"] == "converging" and
         abs(sw[0]["kNs"] - K22) < 2 * MS),
        ("in 440 s +- 1 %", abs(dur - 440) <= 4.4),
        ("k never rises while converging", all(ks[i + 1] <= ks[i] or conv[i + 1]["pid"] != conv[i]["pid"]
                                               for i in range(len(ks) - 1))),
        ("the first converging PES continues each PID's STC timeline", first_rows_continue(out)),
        ("mapped DTS/PTS strictly monotonic per PID through it", per_pid_monotonic(out, ("stc", "converging",
                                                                                          "trust"))),
        ("nothing dropped: every PES mapped once", len([r for r in out if "mapping" in r]) ==
         len([e for e in evs if e["kind"] == "pes"])),
    ]


def first_rows_continue(out):
    """Around the switch each PID moves on by about its own PES spacing (no jump of k)."""
    prev, seen = {}, set()
    for r in out:
        if "mapping" not in r:
            continue
        v = r["dts"] if r["dts"] is not None else r["pts"]
        if r["mapping"] == "converging" and r["pid"] not in seen:
            seen.add(r["pid"])
            if not 0 < fold33(v - prev[r["pid"]]) <= 4000:
                return False
        prev[r["pid"]] = v
    return len(seen) == 2


def case_converge_gap():
    out = transitions(lines(converge_spec(extra="--outage 100:3000", seconds=200)))
    end = [x for x in out if x["from"] == "converging" and x["state"] == "trust"]
    return [("a 3 s natural gap during converging ends it at once", len(end) == 1 and
             100 < rel(end[0]["t"]) < 106 and end[0]["gapNs"] > 900 * MS)]


def case_converge_partial_gap():
    out = transitions(lines(converge_spec([{"kind": "natural-gap", "atS": 100, "gapNs": 500 * MS}], seconds=150)))
    x = [y for y in out if y["from"] == "converging" and y["state"] == "converging"]
    return [("a 0.5 s gap takes 0.5 s off k", len(x) == 1 and abs(x[0]["kNs"] - (K22 - 500 * MS -
                                                                                  (100 - 61) * 5 * MS)) < 30 * MS)]


def case_converge_fallback():
    out = transitions(lines(converge_spec(drop_clock(200, 201), seconds=220)))
    fb = [x for x in out if x["decision"] == "switch-to-restamp"]
    return [("a fallback mid-converging is at once", len(fb) == 2 and fb[1]["from"] == "converging" and
             rel(fb[1]["t"]) == 200 and fb[1]["state"] == "fallback")]


def case_receiver_reepoch():
    rows = []
    for d_ms, want in ((300, "converging"), (-300, "trust")):
        evs = gen(base(seconds=100, delay=1500), setup() + [clock(30, e_ns=E_RX + d_ms * MS, seq=2)])
        out = lines(evs, True)
        tr = [x for x in transitions(out) if rel(x["t"]) == 30]
        ok = len(tr) == 1 and tr[0]["decision"] == "switch-to-trust" and tr[0]["state"] == want
        if want == "converging":
            ok = ok and abs(tr[0]["kNs"] - 300 * MS) < 1 * MS and per_pid_monotonic(out)
            end = [x for x in transitions(out) if x["from"] == "converging"]
            ok = ok and len(end) == 1 and abs(rel(end[0]["t"]) - 90) < 1.5
        else:
            ok = ok and abs(tr[0]["gapNs"] - 300 * MS) < 1 * MS
        rows.append(("a receiver re-epoch of %+d ms: %s" % (d_ms, "converging" if d_ms > 0 else "a gap"), ok))
    return rows


def case_sender_reepoch():
    rows = []
    for d_ms in (500, -100):
        evs = gen(base(seconds=60, jitter=0, extra="--jump 30:%d:di" % d_ms), setup(),
                  edits=[{"fromS": 31.9, "epochSeq": 2}])
        out = lines(evs, True)
        tr = transitions(out)
        v = [r for r in out if r.get("pid") == 0x102]
        steps = [fold33(v[i + 1]["pts"] - v[i]["pts"]) for i in range(len(v) - 1)]
        odd = [s for s in steps if s != 1920]
        rows.append(("a sender re-epoch of %+d ms passes as one %s" % (d_ms, "gap" if d_ms > 0 else "overlap"),
                     [x["state"] for x in tr] == ["trust"] and odd == [1920 + ns_to_pts90k(d_ms * MS)] and
                     summary(out)["epochSeq"] == 2))
    return rows


def case_tai_unset():
    evs = gen(base(seconds=40, jitter=0, extra="--jump 30:-37000:di"), setup(), 2100 * MS)
    out = lines(evs, True)
    fb = [x for x in transitions(out) if x["decision"] == "switch-to-restamp"]
    v = [r for r in out if r.get("pid") == 0x102 and r["mapping"] == "trust"]
    back = [r for i, r in enumerate(v[1:]) if fold33(r["pts"] - v[i]["pts"]) < 0]
    span = (fb[0]["t"] - back[0]["t"]) / MS if back and fb else 1e9
    return [("the sender's TAI lost mid-trust: fallback with transit-high", len(fb) == 1 and
             fb[0]["failed"] == "transit-high"),
            ("only the content of 3 PCRs went out stepped back", span <= 3 * 35 + 1)]


def case_offset_ignored():
    o = [{"kind": "offset", "atS": 0, "ns": 500 * MS}, {"kind": "trim", "atS": 0, "pid": 0x102, "ns": 40 * MS}]
    out = lines(gen(base(seconds=40), setup() + o + drop_clock(10, 11), 2100 * MS), True)
    fb = [r for r in out if r.get("mapping") == "stc"]
    trust_rows = [r for r in out if r.get("mapping") == "trust"]
    rest = lines(gen(base(seconds=5), setup(mode="restamp") + o, 2100 * MS), True)
    rr = [r for r in rest if r.get("mapping") == "restamp"]
    ev = {(e["t"], e["pid"]): e for e in gen(base(seconds=40), setup() + o, 2100 * MS) if e["kind"] == "pes"}
    k = ns_to_pts90k(2100 * MS)
    stc_ok = all(r["pts"] == ev[(r["t"], r["pid"])]["stc"] for r in fb)
    trust_ok = all(r["pts"] == (ev[(r["t"], r["pid"])]["stc"] - k) % PTS_WRAP for r in trust_rows
                   if (r["t"], r["pid"]) in ev)
    add = {0x100: ns_to_pts90k(500 * MS), 0x102: ns_to_pts90k(540 * MS)}
    ev5 = {(e["t"], e["pid"]): e for e in gen(base(seconds=5), setup(mode="restamp") + o, 2100 * MS)
           if e["kind"] == "pes"}
    rest_ok = all(r["pts"] == (ev5[(r["t"], r["pid"])]["stc"] + add[r["pid"]]) % PTS_WRAP for r in rr)
    return [
        ("O and a trim are not applied in fallback (Trust selected)", fb and stc_ok),
        ("nor in trust", trust_rows and trust_ok),
        ("in Restamp mode they are", rr and rest_ok),
    ]


def case_restamp_display():
    out = lines(gen(base(seconds=10, decl="200:10:0123456789abcdef"), setup(mode="restamp"), 2100 * MS))
    s = summary(out)
    return [("Restamp mode with a descriptor: the gate runs for display only", transitions(out) == [] and
             s["state"] == "restamp" and s["failed"] is None and s["transit"] is not None),
            ("the declaration's timeline_id is in the stats", s["timelineId"] == "0123456789abcdef")]


def case_pmt_stale():
    # An outage restarts the PMT's age: Trust holds across a 2 s silence.
    out = lines(gen(base(seconds=20, extra="--outage 10:2000"), setup()))
    return [("a 2 s outage keeps trust (the gap restarts the PMT's age)",
             [x["state"] for x in transitions(out)] == ["trust"])]


def case_silence():
    # A silence just under 1 s ages the PMT 40 ms only: no spurious no-descriptor fallback (B-226).
    # 990 ms arrives as 1.006 s between buffers, an outage, as does 1100 ms (OUTAGE rules).
    rows = []
    for ms, outage in ((900, False), (950, False), (990, True), (1100, True)):
        evs = gen(base(seconds=30, extra="--outage 20:%d" % ms), setup())
        out = lines(evs, True)
        pes = [r for r in out if "mapping" in r]
        s = summary(out)
        rows.append(("a %d ms silence keeps trust, every PES on the Trust mapping%s" % (
            ms, ", an outage there" if outage else ""),
            [(x["decision"], x["state"]) for x in transitions(out)] == [("release-trust", "trust")] and
            s["failed"] is None and s["switches"] == 0 and len(pes) == s["pes"]["trust"] > 1400 and
            any(e["kind"] == "outage" for e in evs) == outage))
    # Inputs keep coming without a PMT: the age still runs out at 1 s; 100 ms apart, 40 ms each.
    for gap_ms, stale_s in ((10, 1.0), (100, 2.5)):
        g = tg.TrustGate(1, tg.Config(), tg.Clock(E_RX, 1, True, 100), True, 0, 0, 0)
        g.on_input(0)
        g.on_pmt({"present": True, "houseTimeTai": True, "disciplined": True, "de90k": 18000,
                  "clockErrorClass": 10}, 0)
        g.judged = True
        t = 0
        while g.failed(t) is None and t < 10 * SEC:
            t += gap_ms * MS
            g.on_input(t)
        rows.append(("no PMT, inputs %d ms apart: no-descriptor at %.1f s" % (gap_ms, stale_s),
                     g.failed(t) == "no-descriptor" and abs(t - stale_s * SEC) <= gap_ms * MS))
    g.on_input(20 * SEC)
    g.on_pmt(g.decl, 20 * SEC)
    rows.append(("a step inside a silence judges the PMT as of the silence's first 40 ms",
                 g.failed(20 * SEC + 990 * MS) is None and g.failed(20 * SEC + 5 * SEC) is None))
    return rows


# --- the pinned expectations ------------------------------------------------------------------
def expect_files():
    return sorted(f for f in os.listdir(FIXTURES) if f.startswith("trust-") and f.endswith(".expect.jsonl"))


def case_expectations():
    rows = []
    files = expect_files()
    rows.append(("five pinned trust-*.expect.jsonl", len(files) == 5))
    for f in files:
        path = os.path.join(FIXTURES, f)
        with open(path) as fh:
            all_lines = [line for line in fh.read().splitlines() if line.strip()]
        spec = json.loads(all_lines[0])
        got = [json.dumps(x, separators=(",", ":")) for x in lines(build(spec))]
        if UPDATE:
            with open(path, "w") as fh:
                fh.write("\n".join([all_lines[0]] + got) + "\n")
            all_lines = [all_lines[0]] + got
        rows.append(("%s replays as pinned" % f, got == all_lines[1:]))
    return rows


CASES = {
    "qualify": case_qualify, "transit_high": case_transit_high, "failed_names": case_failed_names,
    "lo_bound": case_lo_bound, "deciding_timeout": case_deciding_timeout, "return_timing": case_return_timing,
    "operator": case_operator, "wrap": case_wrap, "converge": case_converge, "converge_gap": case_converge_gap,
    "converge_partial_gap": case_converge_partial_gap, "converge_fallback": case_converge_fallback,
    "receiver_reepoch": case_receiver_reepoch, "sender_reepoch": case_sender_reepoch, "tai_unset": case_tai_unset,
    "offset_ignored": case_offset_ignored, "restamp_display": case_restamp_display, "pmt_stale": case_pmt_stale,
    "silence": case_silence,
    "expectations": case_expectations,
}


# --- mutants ----------------------------------------------------------------------------------
def _patch(obj, name, value):
    old = getattr(obj, name)
    setattr(obj, name, value)
    return lambda: setattr(obj, name, old)


def m_hysteresis():
    orig = tg.Config.__init__

    def init(self):
        orig(self)
        self.bad_pcrs = 1
    return _patch(tg.Config, "__init__", init)


def m_lo_without_base():
    orig = tg.Config.__init__

    def init(self):
        orig(self)
        self.neg_base_ns = 0
    return _patch(tg.Config, "__init__", init)


def m_k_transit_only():
    orig = tg.TrustGate._switch_trust

    def sw(self, k, now):
        return orig(self, k - (self.decl["de90k"] if self.decl and k > 0 else 0), now)
    return _patch(tg.TrustGate, "_switch_trust", sw)


def m_o_in_fallback():
    orig = tg.TrustGate._emit

    def emit(self, pid, pts, dmp, stc, now):
        if self.state == "fallback" and stc is not None:
            stc = (stc + ns_to_pts90k(self.offset_ns)) % PTS_WRAP
        return orig(self, pid, pts, dmp, stc, now)
    return _patch(tg.TrustGate, "_emit", emit)


def m_drop_on_switch():
    orig = tg.TrustGate._switch_trust

    def sw(self, k, now):
        return orig(self, 0, now)
    return _patch(tg.TrustGate, "_switch_trust", sw)


def m_no_gap_wait():
    orig = tg.Config.__init__

    def init(self):
        orig(self)
        self.return_gap_wait_ns = 0
    return _patch(tg.Config, "__init__", init)


MUTANTS = [
    ("the hysteresis count 1, not 3", m_hysteresis, "transit_high"),
    ("lo without its 20 ms base", m_lo_without_base, "lo_bound"),
    ("the converging rate doubled", lambda: _patch(tg, "CONVERGE_DIV", 100), "converge"),
    ("k taken as the transit alone", m_k_transit_only, "converge"),
    ("O applied in fallback", m_o_in_fallback, "offset_ignored"),
    ("a switch into Trust that drops (chapter 9's blend)", m_drop_on_switch, "converge"),
    ("no wait for a natural gap", m_no_gap_wait, "return_timing"),
    ("a silence ages the PMT in full", lambda: _patch(tg, "SILENCE_NS", 10 * SEC), "silence"),
]


def main():
    failures = 0
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    for name, fn in CASES.items():
        if only and name not in only:
            continue
        for label, ok in fn():
            print("%s %s" % ("PASS" if ok else "FAIL", label))
            failures += not ok
    if not only or "mutants" in only:
        for label, patch, case in MUTANTS:
            undo = patch()
            try:
                caught = not all(ok for _l, ok in CASES[case]())
            finally:
                undo()
            print("%s mutant caught: %s (%s)" % ("PASS" if caught else "FAIL", label, case))
            failures += not caught
    if failures:
        print("\n%d FAILURE(S) in trust_ref_test" % failures)
        return 1
    print("\nALL trust_ref_test TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
