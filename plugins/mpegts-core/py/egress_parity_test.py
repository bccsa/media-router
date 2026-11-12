#!/usr/bin/env python3
"""mrts::EgressCore against its reference (ch. 15.4 B-222, WI-P5-2, p5-2b): `mrts_cli egress`
replays a recording as egress_core.py's CLI does, and its output bytes and every line it prints
(events, stats, counters, the output's digest) must equal egress_core.py's, on

  - every tests/fixtures/egress case with its clock file (a bus sidecar where it names one), and
    the non-sidecar ones again in 188- and 1000-byte buffers (a packet split across buffers);
  - generated streams (fixture_gen --ts egress): a D_e ramp, its max, audio-only (sparse PCR),
    no PCR PID, both, the error class's hold, a timeline change, the PCR PID moved to the audio
    (video PCRs on a non-PCR PID), a re-epoch moving E alone, lateness below 0 and past 60 s,
    unknown E with a PTP grandmaster, a bus silence, and syn-wrap-33bit with the wire's 2^33
    wrap mid-file, re-epoched back across it and forward again (both directions of the wrap).

Then each of egress_ref_test.py's mutants replays the cases, and parity must tell it from
mrts_cli. Skips (exit 0) without the built mrts_cli (make native).

Run:  python3 egress_parity_test.py
"""
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile

import egress_core as ec
import egress_ref_test as rt

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "native", "mrts", "mrts_cli")
FIX, EGRESS, MS, SEC, PKT = rt.FIX, rt.EGRESS, ec.MS, ec.SEC, ec.PKT

_failures = 0
_tmp = tempfile.mkdtemp(prefix="egress-parity-")
atexit.register(shutil.rmtree, _tmp, True)


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def _write(name, data, mode="wb"):
    path = os.path.join(_tmp, name)
    with open(path, mode) as f:
        f.write(data)
    return path


class Case:
    def __init__(self, name, ts_path, spec, bus=None, chunk=None):
        self.name, self.ts_path, self.spec, self.bus, self.chunk = name, ts_path, spec, bus, chunk
        with open(ts_path, "rb") as f:
            self.data = f.read()
        self.spec_path = _write(name + ".clock.json", json.dumps(spec), "w")
        self.bus_path = None
        if bus is not None:
            self.bus_path = _write(name + ".bus.jsonl", "".join(json.dumps(b) + "\n" for b in bus), "w")

    def ref(self):
        out, lines = ec.replay(self.data, self.spec, self.bus, self.chunk)
        return out, [ec.dump_line(x) for x in lines]

    def native(self):
        out_path = os.path.join(_tmp, self.name + ".out.ts")
        cmd = [CLI, "egress", self.ts_path, "--clock", self.spec_path, "--out", out_path]
        if self.bus_path:
            cmd += ["--bus", self.bus_path]
        if self.chunk:
            cmd += ["--chunk", str(self.chunk)]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            return None, ["rc %d: %s" % (p.returncode, p.stderr.strip())]
        with open(out_path, "rb") as f:
            return f.read(), p.stdout.splitlines()


def _gen(name, *args):
    return _write(name + ".ts", rt.gen(*args))


def _silence_bus(data, chunk=1316, lost_s=2):
    """Buffers of `chunk` bytes with about `lost_s` s of the middle never sent: a bus silence."""
    cut = len(data) // 2 // PKT * PKT
    skip = int(lost_s * len(data) / 8 / chunk) * chunk     # the stream is 8 s long
    return [{"off": o, "len": min(chunk, len(data) - o), "pts": None, "dts": None, "dur": None,
             "flags": 0} for o in range(0, len(data), chunk) if not cut - skip <= o < cut]


def cases():
    out = []
    for fn in sorted(os.listdir(EGRESS)):
        if not fn.endswith(".clock.json"):
            continue
        name = fn[:-len(".clock.json")]
        with open(os.path.join(EGRESS, fn)) as f:
            sp = json.load(f)
        ts = os.path.join(FIX, sp["input"])
        bus = ec.read_bus(os.path.join(FIX, sp["bus"])) if sp.get("bus") else None
        out.append(Case("fx-" + name, ts, sp, bus))
        if bus is None:
            out.append(Case("fx-" + name + "-c188", ts, sp, None, 188))
            out.append(Case("fx-" + name + "-c1000", ts, sp, None, 1000))
    ramp = ((0, 200), (20000, 1000))
    g20 = _gen("g20", "--duration", "20")
    out.append(Case("gen-ramp", g20, rt.spec(lateness=ramp)))
    out.append(Case("gen-ramp-max", g20, rt.spec(lateness=ramp, config={"maxMs": 500})))
    out.append(Case("gen-audio-only", _gen("ga", "--audio-only"), rt.spec(), None, 376))
    out.append(Case("gen-no-pcr-pid", _gen("gn", "--pcr-pid", "none"), rt.spec()))
    out.append(Case("gen-audio-no-pcr", _gen("gan", "--audio-only", "--pcr-pid", "none"), rt.spec(), None, 564))
    out.append(Case("gen-error-hold", _gen("g16", "--duration", "16"), rt.spec(changes=[
        {"atMs": 2000, "clock": {"errorUs": 5000}}, {"atMs": 4000, "clock": {"errorUs": 1300}},
        {"atMs": 4500, "clock": {"errorUs": 5000}}])))
    g5 = _gen("g5", "--duration", "5")
    out.append(Case("gen-timeline", g5, rt.spec(changes=[
        {"atMs": 2500, "clock": {"timelineId": "0123456789abcdef"}}])))
    out.append(Case("gen-pcr-on-audio", _write("gpa.ts", rt.pcr_on_audio(rt.gen("--duration", "5"))[0]),
                    rt.spec()))
    out.append(Case("gen-reepoch-e-only", g5, rt.spec(changes=[
        {"atMs": 2500, "clock": {"eNs": str(rt.E1 + 2500 * MS)}}])))
    g10 = _gen("g10")
    out.append(Case("gen-lateness-cut", g10, rt.spec(lateness=(
        (0, 100), (2000, -500), (3000, -500), (4000, 61000), (6000, 61000), (7000, 100)))))
    out.append(Case("gen-unknown-e-ptp", g10, rt.spec(
        known=False, ptpDomain=0, gm="2ccf67.fffe.76e669", source=3, errorUs=None, changes=[
            {"atMs": 3000, "clock": {"known": True, "seq": 4}},
            {"atMs": 6000, "clock": {"gm": "2C-CF-67-FF-FE-76-E6-6A", "taiOffsetS": 300}}])))
    g8 = rt.gen("--duration", "8")
    out.append(Case("gen-silence", _gen("g8", "--duration", "8"), rt.spec(lateness=((0, 1100), (4000, 200))),
                    _silence_bus(g8)))
    wrap = os.path.join(FIX, "syn-wrap-33bit.ts")
    with open(wrap, "rb") as f:
        wd = f.read()
    pes = rt.Walk(wd).of("pes")
    e2 = rt.e_wrapping_at(pes[len(pes) // 2][2]["pts"])
    out.append(Case("wrap-mid", wrap, rt.spec(eNs=str(e2))))
    out.append(Case("wrap-back-forward", wrap, rt.spec(eNs=str(e2), changes=[
        {"atMs": 2000, "clock": {"eNs": str(e2 + 3 * SEC), "seq": 4}},
        {"atMs": 6000, "clock": {"eNs": str(e2 - 1 * SEC), "seq": 5}},
        {"atMs": 8000, "clock": {"eNs": str(e2 + 2 * SEC), "seq": 6}}]), None, 1000))
    return out


def main():
    if not os.path.exists(CLI):
        print("SKIP egress_parity_test: %s not built (make native)" % CLI)
        return 0
    cs = cases()
    refs = {}
    for c in cs:
        ro, rl = c.ref()
        no, nl = c.native()
        refs[c.name] = (no, nl)
        nbytes = -1 if no is None else sum(1 for a, b in zip(ro, no) if a != b) + abs(len(ro) - len(no))
        same_lines = rl == nl
        if not same_lines:
            k = next((i for i, (a, b) in enumerate(zip(rl + [""] * len(nl), nl + [""] * len(rl))) if a != b), 0)
            print("  %s line %d:\n    py  %s\n    cpp %s" % (c.name, k + 1, (rl + [""])[min(k, len(rl))],
                                                         (nl + [""])[min(k, len(nl))]))
        check("parity %s: 0 differing bytes (%d bytes), identical lines (%d)" % (c.name, len(ro), len(rl)),
              nbytes == 0 and same_lines)
    check("parity: at least 40 cases", len(cs) >= 40)
    for label, patch, _case in rt.MUTANTS:
        undo = patch()
        told = False
        try:
            for c in cs:
                try:
                    ro, rl = c.ref()
                except Exception:                 # a mutant that breaks the run is told too
                    told = True
                    break
                no, nl = refs[c.name]
                if ro != no or rl != nl:
                    told = True
                    break
        finally:
            undo()
        check("parity tells the mutant from mrts_cli: %s" % label, told)
    if _failures:
        print("\n%d FAILURE(S) in egress_parity_test" % _failures)
        return 1
    print("\nALL egress_parity_test TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
