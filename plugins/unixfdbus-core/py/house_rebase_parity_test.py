#!/usr/bin/env python3
"""C++ output parity of house_rebase.py, the Python reference of mrfanout::HouseRebase (plan
ch. 15.4 B-55).

1. The two suites: ../native/mr-bus-fanout/tests/house_rebase_test and house_rebase_test.py pass
   with the same checks in the same order, and with HOUSE_REBASE_TRACE they record the same
   bytes: every chunk, its house time and its rebase. The Python cases are the C++ cases.
2. The same input through both rebases, tests/house_rebase_ref and house_rebase.py run as a
   script: those cases; hls-pipe's inline-AV output across EXT-X-DISCONTINUITY
   (house_rebase_parity_fixture.py: no hls-pipe recording exists in the tree or the captures);
   random programs for the edges no recording reaches (the same module); and the conformance
   recordings (mpegts-core/tests/fixtures/*.ts) at an LCG's cuts and house times. Every output
   PES PTS and DTS, every PCR and every discontinuity_indicator must agree, then every byte and
   each rebase's stats.

The C++ side is built here as `make test` builds it. Run:  python3 house_rebase_parity_test.py
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

import house_rebase as hr
import house_rebase_parity_fixture as fixture

HERE = os.path.dirname(os.path.abspath(__file__))
FANOUT = os.path.normpath(os.path.join(HERE, "..", "native", "mr-bus-fanout"))
CPP_TEST = os.path.join(FANOUT, "tests", "house_rebase_test")
CPP_REF = os.path.join(FANOUT, "tests", "house_rebase_ref")
RECORDINGS = os.path.normpath(os.path.join(HERE, "..", "..", "mpegts-core", "tests", "fixtures"))
PKT = hr.PKT
SEC = 1000000000

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def build():
    """The C++ suite and reference, as the plugin's `make test` builds them; '' when done, else
    make's output. MR_PLUGINS_DIR would point the Makefile at another tree: these are this one's."""
    made = subprocess.run(["make", "-s", "-C", FANOUT, "tests/house_rebase_test", "tests/house_rebase_ref"],
                          capture_output=True, text=True,
                          env={k: v for k, v in os.environ.items() if k != "MR_PLUGINS_DIR"})
    if made.returncode != 0 or not (os.path.exists(CPP_TEST) and os.path.exists(CPP_REF)):
        return made.stdout + made.stderr or "tests/house_rebase_test or tests/house_rebase_ref missing"
    return ""


def suite_checks(stdout):
    """(the check names a suite printed, in order, whether every one passed)."""
    lines = [line for line in stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]
    return [line[5:] for line in lines], all(line.startswith("PASS ") for line in lines)


def trace_summary(path):
    """(rebases, chunks, bytes) of a trace in house_rebase_ref's records."""
    data = open(path, "rb").read()
    rebases, chunks, total, off = set(), 0, 0, 0
    while off + 17 <= len(data):
        rebase, _, n = struct.unpack_from("<IqI", data, off + 1)
        rebases.add(rebase)
        chunks += 1
        total += n
        off += 17 + n
    return len(rebases), chunks, total


class Scan:
    """One rebase's output, chunk by chunk: per packet its discontinuity_indicator and its PCR, per
    PES its PTS and DTS, a header split over two packets joined on its PID."""

    def __init__(self):
        self.partial = {}

    def events(self, out):
        ev = []
        for i in range(len(out) // PKT):
            p = bytearray(out[i * PKT:(i + 1) * PKT])
            v = hr.parse_packet(p)
            if v is None:
                ev.append((i, "no sync"))
                continue
            if v.af_discontinuity:
                ev.append((i, "di", v.pid))
            if v.af_pcr:
                ev.append((i, "pcr", v.pid, hr.read_pcr(p)))
            if v.payload_off >= PKT:
                continue
            if v.pusi:
                self.partial.pop(v.pid, None)
                head = bytes(p[v.payload_off:])
            elif v.pid in self.partial:
                head = self.partial.pop(v.pid) + bytes(p[v.payload_off:])
            else:
                continue
            h = hr.parse_pes_header(head, 0, len(head))
            if h is not None and not h.complete and v.pusi:
                self.partial[v.pid] = head
            elif h is not None and h.complete and h.pts >= 0:
                ev.append((i, "pes", v.pid, h.pts, h.dts))
        return ev


def replay(argv):
    done = subprocess.run(argv, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr.strip()


def compare(label, trace):
    """Both replays of `trace`; the C++ one's stats by rebase (None when it did not run)."""
    rc_c, out_c, err_c = replay([CPP_REF, trace])
    rc_p, out_p, err_p = replay([sys.executable, os.path.join(HERE, "house_rebase.py"), trace])
    if rc_c or rc_p:
        check(f"{label}: both replays run (C++ rc {rc_c} {err_c[:200]}, Python rc {rc_p} {err_p[:200]})",
              False)
        return None
    lines_c, lines_p = out_c.splitlines(), out_p.splitlines()
    scans_c, scans_p, chunk_no = {}, {}, {}
    counts = {"pes": 0, "pcr": 0, "di": 0}
    stats, first = {}, None
    for n in range(max(len(lines_c), len(lines_p))):
        c = json.loads(lines_c[n]) if n < len(lines_c) else {}
        p = json.loads(lines_p[n]) if n < len(lines_p) else {}
        if c.keys() != p.keys() or c.get("rebase") != p.get("rebase"):
            first = (f"line {n + 1}: C++ {sorted(c)} of rebase {c.get('rebase')}, "
                     f"Python {sorted(p)} of {p.get('rebase')}")
            break
        rebase = c["rebase"]
        if "stats" in c:
            stats[rebase] = c["stats"]
            if c["stats"] != p["stats"] and first is None:
                first = f"rebase {rebase}'s stats: C++ {c['stats']}, Python {p['stats']}"
            continue
        k = chunk_no[rebase] = chunk_no.get(rebase, -1) + 1
        ec = scans_c.setdefault(rebase, Scan()).events(bytes.fromhex(c["out"]))
        ep = scans_p.setdefault(rebase, Scan()).events(bytes.fromhex(p["out"]))
        for e in ec:
            if e[1] in counts:
                counts[e[1]] += 1
        if ec != ep and first is None:
            j = 0
            while j < len(ec) and j < len(ep) and ec[j] == ep[j]:
                j += 1
            first = (f"rebase {rebase} chunk {k}: C++ {ec[j] if j < len(ec) else 'nothing'}, "
                     f"Python {ep[j] if j < len(ep) else 'nothing'}")
    chunks = sum(v + 1 for v in chunk_no.values())
    check(f"{label}: {chunks} chunks of {len(stats)} rebases, {counts['pes']} PES PTS and DTS, "
          f"{counts['pcr']} PCR, {counts['di']} discontinuity_indicator, the same"
          + (f" (first difference: {first})" if first else ""), first is None and chunks > 0)
    check(f"{label}: every byte out and every rebase's stats the same", out_c == out_p)
    return stats


def recording_trace(path, data, seed):
    """A recording at an LCG's cuts (whole 1316 and 24,064-byte chunks, packet runs, any bytes)
    and house times (0 to 8 ms a chunk, now and then a 2.5 s pause)."""
    lcg = fixture.Lcg(seed)
    now, off, recs = 9000 * SEC, 0, []
    while off < len(data):
        k = (1316, 24064, PKT * (1 + lcg.next(40)), 1 + lcg.next(3000))[lcg.next(4)]
        recs.append((0, now, data[off:off + k]))
        off += k
        now += lcg.next(8000000) + (2500000000 if lcg.next(300) == 0 else 0)
    fixture.write_trace(path, recs)


def main():
    if not sys.platform.startswith("linux"):
        print("SKIP house_rebase_parity_test.py: mr-bus-fanout's tools build on Linux only")
        return 0
    made = build()
    if made:
        print(f"FAIL the C++ suite and tests/house_rebase_ref build:\n{made}")
        return 1
    tmp = tempfile.mkdtemp(prefix="house-rebase-parity.")
    try:
        traces = {}
        suites = (("C++", [CPP_TEST]), ("Python", [sys.executable, os.path.join(HERE, "house_rebase_test.py")]))
        for side, argv in suites:
            traces[side] = os.path.join(tmp, f"cases-{side}.bin")
            done = subprocess.run(argv, capture_output=True, text=True, cwd=HERE,
                                  env=dict(os.environ, HOUSE_REBASE_TRACE=traces[side]))
            names, passed = suite_checks(done.stdout)
            check(f"suites: the {side} suite passes ({len(names)} checks)", done.returncode == 0 and passed)
            traces[side + " checks"] = names
        check(f"suites: the same {len(traces['C++ checks'])} checks in the same order",
              traces["C++ checks"] == traces["Python checks"] and traces["C++ checks"])
        same = (os.path.exists(traces["C++"]) and os.path.exists(traces["Python"])
                and open(traces["C++"], "rb").read() == open(traces["Python"], "rb").read())
        rebases, chunks, total = trace_summary(traces["C++"]) if same else (0, 0, 0)
        check(f"suites: the same input, {rebases} rebases, {chunks} chunks, {total} bytes and their house "
              "times", same and chunks > 0)

        compare("the suites' cases", traces["C++"])

        hls = os.path.join(tmp, "hls.bin")
        fixture.write_trace(hls, fixture.records())
        stats = compare("hls-pipe across EXT-X-DISCONTINUITY", hls)
        if stats is not None:
            s = stats.get(0, {})
            check(f"hls-pipe: the inline audio kept while the video re-anchors ({s.get('reanchors')} "
                  f"re-anchors, {s.get('kept')} kept, {s.get('dropped')} dropped before the anchor)",
                  s.get("reanchors", 0) >= 2 and s.get("kept", 0) >= 2 and s.get("dropped", 0) >= 1)
            check("hls-pipe: cut anywhere (rebase 1), the same stats as the ingest's chunks",
                  stats.get(1) == s)

        fuzz = os.path.join(tmp, "fuzz.bin")
        fixture.write_trace(fuzz, fixture.fuzz_records())
        stats = compare("random programs", fuzz)
        if stats is not None:
            total = {k: sum(int(v[k]) for v in stats.values())
                     for k in ("anchored", "reanchors", "kept", "dropped", "desync_bytes")}
            check(f"random programs: {len(stats)} programs, {total['anchored']} anchored, "
                  f"{total['reanchors']} re-anchors, {total['kept']} kept, {total['dropped']} dropped, "
                  f"{total['desync_bytes']} bytes resynced",
                  all(total[k] > 0 for k in total))

        names = sorted(f for f in os.listdir(RECORDINGS) if f.endswith(".ts"))
        for seed, name in enumerate(names, 1):
            path = os.path.join(tmp, name + ".bin")
            with open(os.path.join(RECORDINGS, name), "rb") as f:
                recording_trace(path, f.read(), seed)
            compare(f"recording {name}", path)
        check(f"recordings: {len(names)} of mpegts-core/tests/fixtures", len(names) >= 10)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{_failures} FAILURE(S) in house_rebase_parity")
        return 1
    print("\nALL house_rebase_parity TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
