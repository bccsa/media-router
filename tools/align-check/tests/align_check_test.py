#!/usr/bin/env python3
"""The gate tools of tools/align-check (plan ch. 7 WI-P3-3, WI-P3-20; ch. 6 WI-P2-16) on the
committed fixtures, no box:

  - pes_diff.sh: a capture against itself (0 ticks), its rebase (the shift on every PES), its
    40 ppm re-spacing (within 36 ticks), a copy with packets lost (PES gone), a re-encode's
    stand-in (payloads changed: crc32 joins nothing, --by pts pairs every PES), --map;
  - pes_formula.sh on demux logs made from a dump: Phase 3's ceil exact, Phase 2's floor and a
    one-tick error refused, a DTS checked on its own, 33-bit wraps and house times past 2^53 ns;
  - pcm_align.py on the 302M fixture: against itself, its PES moved 8 samples, PES silenced.

Skips (exit 0) without a built mrts_cli, gawk or numpy."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # tools/align-check
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
FIX = os.path.join(ROOT, "plugins", "mpegts-core", "tests", "fixtures")
CLI = os.path.join(ROOT, "plugins", "mpegts-core", "native", "mrts", "mrts_cli")
WRAP = 1 << 33
HOUR = 3600 * 90000

try:
    import numpy  # noqa: F401
except ImportError:  # pragma: no cover - environment gate
    print("SKIP align_check_test.py: numpy unavailable")
    sys.exit(0)
if not os.path.exists(CLI) or not shutil.which("gawk"):
    print("SKIP align_check_test.py: no built mrts_cli (make native) or no gawk")
    sys.exit(0)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def run(*cmd):
    return subprocess.run(list(cmd), capture_output=True, text=True)


def jl(text):
    return [json.loads(x) for x in text.splitlines() if x.startswith("{")]


def diff(a, b, *opt):
    r = run("sh", os.path.join(HERE, "pes_diff.sh"), a, b, *opt)
    return r.returncode, jl(r.stdout)


def dump(path):
    return [json.loads(x) for x in run(CLI, "dump", path).stdout.splitlines() if x.startswith('{"pid"')]


def edit_payloads(src, dst, pid):
    """A copy whose PES on `pid` carry other payload bytes (one flipped after each header): what a
    re-encode does to the crc32, the timestamps kept."""
    b = bytearray(open(src, "rb").read())
    for o in range(0, len(b) - 187, 188):
        p = b[o:o + 188]
        if ((p[1] & 0x1F) << 8 | p[2]) != pid or not p[1] & 0x40 or not p[3] & 0x10:
            continue
        off = 4 + (1 + p[4] if p[3] & 0x20 else 0)
        h = off + 9 + p[off + 8]
        if h < 188:
            b[o + h] ^= 0x5A
    open(dst, "wb").write(bytes(b))


def test_pes_diff(tmp):
    cap = os.path.join(FIX, "cap-mux-align7-aac-opus.ts")
    rc, out = diff(cap, cap)
    check("pes_diff: a capture against itself joins every PES by crc32, 0 ticks, passes",
          rc == 0 and out[-1]["pass"] and out[-1]["joined"] == 965 and
          all(p["pts"]["nonzero"] == 0 and p["onlyA"] == p["onlyB"] == 0 for p in out[:-1]))
    moved = os.path.join(tmp, "moved.ts")
    rep = json.loads(run(CLI, "rebase", cap, moved, "--to-ns", "9000000000000").stdout)
    shift = (rep["shift90k"] + WRAP // 2) % WRAP - WRAP // 2
    rc, out = diff(cap, moved)
    check(f"pes_diff: its rebase shows the shift on every PES ({shift} ticks) and fails at --tol 0",
          rc == 1 and not out[-1]["pass"] and all(p["pts"]["min"] == p["pts"]["max"] == shift and
                                                  p["pts"]["nonzero"] == p["joined"] for p in out[:-1]))
    rc, out = diff(cap, os.path.join(FIX, "syn-foreign-clock-aac.ts"), "--tol", "36")
    worst = max(max(abs(p["pts"]["min"]), abs(p["pts"]["max"])) for p in out[:-1]) if out else -1
    check(f"pes_diff: the 40 ppm re-spacing within 36 ticks over 10 s (worst {worst}), passes at --tol 36",
          rc == 0 and 30 <= worst <= 36)
    rc, out = diff(cap, os.path.join(FIX, "cap-cc-loss.ts"))
    gone = sum(p["onlyA"] for p in out[:-1])
    check(f"pes_diff: PES lost on the way are named (onlyA {gone}) and fail", rc == 1 and gone == 5)
    rc, out = diff(cap, moved, "--map", "264:264")
    check("pes_diff --map: one pair as asked", len(out) == 2 and out[0]["pidA"] == out[0]["pidB"] == 264)
    rc, out = diff(cap, cap, "--map", "264:256")
    check("pes_diff --map: PIDs that carry other payloads join nothing and fail", rc == 1 and out[0]["joined"] == 0)
    re = os.path.join(tmp, "reencoded.ts")
    edit_payloads(os.path.join(FIX, "syn-gap-500ms.ts"), re, 0x102)
    rc, out = diff(os.path.join(FIX, "syn-gap-500ms.ts"), re)
    aac = [p for p in out if p.get("pidA") == 0x102]
    check("pes_diff --by crc32: a re-encode's payloads join nothing on that PID",
          rc == 1 and aac and aac[0]["joined"] == 0)
    rc, out = diff(os.path.join(FIX, "syn-gap-500ms.ts"), re, "--by", "pts", "--lines")
    aac = [p for p in out if p.get("pidA") == 0x102 and "by" in p]
    pairs = [p for p in out if "dPts" in p]
    check(f"pes_diff --by pts: every AAC PES paired by PTS order across the 500 ms hole, 0 ticks ({aac[0]['joined'] if aac else 0})",
          rc == 0 and aac and aac[0]["joined"] == 351 and aac[0]["onlyA"] == aac[0]["onlyB"] == 0 and
          len(pairs) == 554 and all(p["dPts"] == 0 for p in pairs))
    rc, out = diff(cap, cap, "--by", "nope")
    check("pes_diff: a bad --by exits 2", rc == 2)


def ceil_ns(ticks):
    return -(-ticks * 100000 // 9)


def pads_from(path, mode, err=None, near_ns=0):
    """record-bus.py --demux's log of `path` as a demux would write it: select mode (`src`,
    DTS = PTS) or demux mode (one pad per PID, the PES DTS); the PTS by `mode`'s rounding, in
    the 2^33 period nearest house time near_ns."""
    def ns(unwrapped, ceil=True):
        t = unwrapped - HOUR
        t += round((near_ns * 9 / 100000 - t) / WRAP) * WRAP
        return ceil_ns(t) if ceil else t * 100000 // 9

    out = []
    for i, u in enumerate(dump(path)):
        if u["pts"] is None:
            continue
        pts = ns(u["ptsUnwrapped"], mode != "floor") + (11111 if i == err else 0)   # err: a tick late
        if mode == "demux":
            pad, dts = f"video_0_{u['pid']:04x}", ns(u["dtsUnwrapped"]) if u["dts"] is not None else None
        else:
            pad, dts = "src", pts
        out.append({"pad": pad, "pts": pts, "dts": dts, "dur": None, "flags": 0, "len": u["len"], "crc32": u["crc32"]})
    return out


def formula(tmp, src, pads, name="f"):
    stem = os.path.join(tmp, name)
    shutil.copy(src, stem + ".ts")
    with open(stem + ".pads.jsonl", "w") as f:
        f.write("".join(json.dumps(p) + "\n" for p in pads))
    r = run("sh", os.path.join(HERE, "pes_formula.sh"), stem)
    return r.returncode, jl(r.stdout)


def test_pes_formula(tmp):
    s302 = os.path.join(FIX, "cap-302m-bssd.ts")
    pads = pads_from(s302, "select")
    rc, out = formula(tmp, s302, pads)
    check(f"pes_formula: select mode on Phase 3's ceil, every buffer joined and exact ({len(pads)})",
          rc == 0 and out[0]["joined"] == out[0]["exact"] == len(pads) > 100 and out[-1]["pass"])
    rc, out = formula(tmp, s302, pads_from(s302, "floor"))
    check(f"pes_formula: Phase 2's floor named and refused (floor {out[0]['floor']}, exact {out[0]['exact']}, "
          f"maxDevNs {out[0]['maxDevNs']})",
          rc == 1 and out[0]["floor"] == len(pads) and out[0]["exact"] < len(pads) and out[0]["maxDevNs"] == -1)
    rc, out = formula(tmp, s302, pads_from(s302, "select", err=40))
    check("pes_formula: one buffer a tick late fails, its deviation named",
          rc == 1 and out[0]["exact"] == len(pads) - 1 and out[0]["maxDevNs"] == 11111)
    rc, out = formula(tmp, s302, pads[:50] + [dict(pads[50], crc32="00000000")] + pads[51:])
    check("pes_formula: a buffer whose payload is in no PES fails", rc == 1 and out[0]["joined"] == len(pads) - 1)
    rc, out = formula(tmp, s302, pads[10:])
    check("pes_formula: a log that starts later joins from there", rc == 0 and out[0]["joined"] == len(pads) - 10)
    # B-frame DTS across 2^33 in demux mode, one pad per PID; then the same at 200 days of uptime.
    wrap = os.path.join(FIX, "syn-wrap-33bit.ts")
    at = ceil_ns(dump(wrap)[0]["pts"] - HOUR)          # 25.5 h of house time, 5 s before the wrap
    pads = pads_from(wrap, "demux", near_ns=at)
    rc, out = formula(tmp, wrap, pads)
    check(f"pes_formula: demux pads per PID, PTS and B-frame DTS across 2^33 exact ({len(pads)})",
          rc == 0 and len(out) == 5 and sum(p["exact"] for p in out[:-1]) == len(pads))
    late = os.path.join(tmp, "late-src.ts")
    day200 = 200 * 86400 * 10 ** 9
    run(CLI, "rebase", wrap, late, "--to-ns", str(day200))
    pads = pads_from(late, "demux", near_ns=day200)
    rc, out = formula(tmp, late, pads, "late")
    check(f"pes_formula: at 200 days of uptime (ns past 2^53: {pads[0]['pts'] > 1 << 53}) still exact",
          rc == 0 and pads[0]["pts"] > 1 << 53 and sum(p["exact"] for p in out[:-1]) == len(pads))
    pads = pads_from(wrap, "demux", near_ns=at)
    bad = [dict(p, dts=p["dts"] + 11111) if p["dts"] is not None and p["dts"] != p["pts"] else p for p in pads]
    rc, out = formula(tmp, wrap, bad, "dts")
    check("pes_formula: a DTS a tick off fails on its own", rc == 1)


def shift_pes(src, dst, ticks):
    """A copy with every PES PTS moved by `ticks` (a 302M stream: no DTS)."""
    b = bytearray(open(src, "rb").read())
    for o in range(0, len(b) - 187, 188):
        p = b[o:o + 188]
        if not p[1] & 0x40 or not p[3] & 0x10:
            continue
        off = 4 + (1 + p[4] if p[3] & 0x20 else 0)
        q = p[off:]
        if q[:3] != b"\x00\x00\x01" or q[3] != 0xBD or not q[7] & 0x80:
            continue
        f = q[9:14]
        v = ((f[0] >> 1 & 7) << 30 | f[1] << 22 | (f[2] >> 1) << 15 | f[3] << 7 | f[4] >> 1) + ticks
        v %= WRAP
        b[o + off + 9:o + off + 14] = bytes([(f[0] & 0xF0) | (v >> 30 & 7) << 1 | 1, v >> 22 & 0xFF,
                                            (v >> 15 & 0x7F) << 1 | 1, v >> 7 & 0xFF, (v & 0x7F) << 1 | 1])
    open(dst, "wb").write(bytes(b))


def silence_pes(src, dst, first, count):
    """A copy whose PES first..first+count carry digital silence: their 302M data bytes zeroed."""
    b = bytearray(open(src, "rb").read())
    n = -1
    zero = False
    for o in range(0, len(b) - 187, 188):
        p = b[o:o + 188]
        if ((p[1] & 0x1F) << 8 | p[2]) != 0x41 or not p[3] & 0x10:
            continue
        off = 4 + (1 + p[4] if p[3] & 0x20 else 0)
        if p[1] & 0x40:
            n += 1
            zero = first <= n < first + count
            if zero:
                off += 9 + p[off + 8] + 4                  # past the PES header and the AES3 header
        if zero:
            b[o + off:o + 188] = bytes(188 - off)
    open(dst, "wb").write(bytes(b))


def align(a, b, *opt):
    r = run(sys.executable, os.path.join(HERE, "pcm_align.py"), a, b, "--window", "2", *opt)
    out = jl(r.stdout)
    return r.returncode, out[0] if out else {}


def test_pcm_align(tmp):
    cap = os.path.join(FIX, "cap-302m-bssd.ts")
    rc, out = align(cap, cap)
    check(f"pcm_align: a capture against itself: offset 0, fill 0 %, peak 1 ({out})",
          rc == 0 and out.get("offsetSamples") == 0 and out.get("fillPct") == 0 and out.get("peak", 0) > 0.999)
    later = os.path.join(tmp, "earlier.ts")
    shift_pes(cap, later, -15)                            # 15 ticks = 8 samples at 48 kHz
    rc, out = align(cap, later, "--want-offset", "-8")
    check(f"pcm_align: b's PES stamped 8 samples earlier: its content sits 8 samples earlier ({out.get('offsetSamples')})",
          rc == 0 and out.get("offsetSamples") == -8 and out.get("fillPct") == 0)
    rc, out = align(cap, later, "--want-offset", "0")
    check("pcm_align: --want-offset 0 against it exits 1", rc == 1 and not out.get("pass"))
    quiet = os.path.join(tmp, "quiet.ts")
    silence_pes(cap, quiet, 60, 5)                       # 5 of the 133 PES
    rc, out = align(cap, quiet, "--max-fill", "0")
    check(f"pcm_align: 5 PES silenced: the fill counted ({out.get('fillSamples')} samples, {out.get('fillPct')} %), "
          "--max-fill 0 exits 1",
          rc == 1 and out.get("offsetSamples") == 0 and 9000 <= out.get("fillSamples", 0) <= 10300 and
          3 < out.get("fillPct", 0) < 4.5)
    rc, out = align(cap, os.path.join(FIX, "cap-mux-align7-aac-opus.ts"))
    check("pcm_align: a capture with no 302M stream exits 2", rc == 2)
    if shutil.which("ffmpeg"):
        import importlib.util
        import numpy as np
        sys.dont_write_bytecode = True                # no __pycache__ beside the tool
        spec = importlib.util.spec_from_file_location("pcm_align", os.path.join(HERE, "pcm_align.py"))
        pa = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pa)
        mine = np.concatenate([pa.s302m(p) for _, p in pa.pes_units(cap, None)[0]])
        ref = subprocess.run(["ffmpeg", "-v", "error", "-i", cap, "-map", "0:a:0", "-c:a", "pcm_s32le", "-f", "s32le", "-"],
                             capture_output=True).stdout
        ref = np.frombuffer(ref, dtype=np.int32).reshape(-1, mine.shape[1])
        check(f"pcm_align: the 24-bit 302M decode is ffmpeg's, sample for sample ({len(mine)} frames)",
              len(ref) == len(mine) and np.array_equal(ref, mine))


def main():
    tmp = tempfile.mkdtemp(prefix="align_check_test.")
    try:
        test_pes_diff(tmp)
        test_pes_formula(tmp)
        test_pcm_align(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S) in align_check")
        return 1
    print("\nALL align_check TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
