#!/usr/bin/env python3
"""The fixture tools (plan ch. 7 WI-P3-3) on the dev Pi, no box:

  - record-bus.py against a local unixfdsink playing syn-gap-marker (rebased to now + 200 ms
    with its sidecar, as tests replay recordings): the bytes, every buffer's PTS and flags (its
    two GAP|DISCONT markers among them) as played; it stops at SIGTERM and at its duration;
    --demux select on the 302M mixer trim: one pad line per PES, each joined by pes_formula.sh;
  - trim.sh: a capture cut from a PAT before a keyframe, <= 2 MB; a recording cut with its
    sidecar on whole buffers; no PAT before any random access point refused;
  - record-bus.sh refuses too few arguments; every shell tool parses (sh -n).

Run from anywhere; skips (exit 0) without GStreamer's unixfdsink/unixfdsrc or a built mrts_cli."""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # tools/fixtures
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
FIX = os.path.join(ROOT, "plugins", "mpegts-core", "tests", "fixtures")
CLI = os.path.join(ROOT, "plugins", "mpegts-core", "native", "mrts", "mrts_cli")
SO = os.path.join(ROOT, "plugins", "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP fixture_tools_test.py: GStreamer unavailable ({exc})")
    sys.exit(0)
Gst.init([])
if not (Gst.ElementFactory.find("unixfdsink") and Gst.ElementFactory.find("unixfdsrc") and os.path.exists(CLI)):
    print("SKIP fixture_tools_test.py: no unixfdsink/unixfdsrc or no built mrts_cli (make native)")
    sys.exit(0)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def run(*cmd, **kw):
    return subprocess.run(list(cmd), capture_output=True, text=True, **kw)


def lines(path):
    with open(path) as f:
        return [json.loads(x) for x in f if x.strip()]


def rebased(tmp, name, to_ns, bus=True):
    """A fixture moved onto house time to_ns: (ts path, sidecar path or None)."""
    out = os.path.join(tmp, name + ".ts")
    args = [CLI, "rebase", os.path.join(FIX, name + ".ts"), out, "--to-ns", str(to_ns)]
    side = None
    if bus:
        side = os.path.join(tmp, name + ".bus.jsonl")
        args += ["--bus", os.path.join(FIX, name + ".bus.jsonl"), side]
    r = run(*args)
    assert r.returncode == 0, r.stderr
    return out, side


def now_ns():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


class Feeder:
    """A bus producer: appsrc -> unixfdsink on the bus's clock (monotonic, base time 0), paced: the
    dev Pi's stock unixfdsink can block a burst's sends and the client's releases on each other
    (B-68's stall); the image's carries meta-custom's patch."""

    def __init__(self, sock):
        self.sock = sock
        self.pipe = Gst.parse_launch(f"appsrc name=src format=time caps={TS_CAPS} ! "
                                     f"unixfdsink socket-path={sock} sync=false")
        clock = Gst.SystemClock.obtain()
        clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        self.pipe.use_clock(clock)
        self.pipe.set_start_time(Gst.CLOCK_TIME_NONE)
        self.pipe.set_base_time(0)
        self.src = self.pipe.get_by_name("src")
        self.pipe.set_state(Gst.State.PLAYING)

    def clients(self):
        with open("/proc/net/unix") as f:
            return sum(1 for x in f if x.rstrip().endswith(self.sock)) - 1

    def wait_client(self, timeout=15.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.clients() >= 1:
                time.sleep(0.2)
                return True
            time.sleep(0.05)
        return False

    def play(self, ts_path, side):
        data = open(ts_path, "rb").read()
        for b in side:
            buf = Gst.Buffer.new_wrapped(data[b["off"]:b["off"] + b["len"]])
            if b["pts"] is not None:
                buf.pts = b["pts"]
            buf.set_flags(Gst.BufferFlags(b["flags"]))
            self.src.emit("push-buffer", buf)
            time.sleep(0.002)

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


def wait_size(path, size, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if os.path.exists(path) and os.path.getsize(path) >= size:
            return True
        time.sleep(0.05)
    return False


def recorder(sock, secs, stem, *extra):
    return subprocess.Popen([sys.executable, os.path.join(HERE, "record-bus.py"), sock, str(secs), stem, *extra],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def test_record(tmp):
    ts, side = rebased(tmp, "syn-gap-marker", now_ns() + 200_000_000)
    want = lines(side)
    sock = os.path.join(tmp, "edge-a.sock")
    feeder = Feeder(sock)
    stem = os.path.join(tmp, "rec-a")
    rec = recorder(sock, 60, stem)
    ok = feeder.wait_client()
    check("record-bus: connects to the edge as a client", ok)
    if ok:
        feeder.play(ts, want)
    got_all = wait_size(stem + ".ts", os.path.getsize(ts))
    rec.send_signal(signal.SIGTERM)
    out, err = rec.communicate(timeout=20)
    feeder.stop()
    check(f"record-bus: SIGTERM ends it whole (exit {rec.returncode}: {out.strip()} {err.strip()})",
          got_all and rec.returncode == 0 and "buffers" in out)
    got = lines(stem + ".bus.jsonl") if os.path.exists(stem + ".bus.jsonl") else []
    check("record-bus: the recording's bytes are the bytes played",
          os.path.exists(stem + ".ts") and open(stem + ".ts", "rb").read() == open(ts, "rb").read())
    keys = lambda b: (b["off"], b["len"], b["pts"], b["flags"])
    # unixfdsrc flags the first buffer it receives DISCONT.
    first = dict(want[0], flags=want[0]["flags"] | 64) if want else {}
    check(f"record-bus: every buffer's offset, length, PTS and flags as played ({len(got)} of {len(want)})",
          [keys(b) for b in got] == [keys(b) for b in [first] + want[1:]])
    gaps = [b for b in got if b["flags"] & 2048]
    check("record-bus: the two GAP|DISCONT markers survive, PTS the hole's end, no DTS",
          len(gaps) == 2 and all(b["flags"] & 64 and b["dts"] is None and b["pts"] == gaps[0]["pts"] for b in gaps))
    r = run(CLI, "rebase", stem + ".ts", os.path.join(tmp, "back.ts"), "--to-ns", "1000000000000",
            "--bus", stem + ".bus.jsonl", os.path.join(tmp, "back.bus.jsonl"))
    check("record-bus: its sidecar is mrts_cli rebase's form (the recording rebases with it)",
          r.returncode == 0 and json.loads(r.stdout or "{}").get("busLines") == len(want))


def test_duration(tmp):
    sock = os.path.join(tmp, "edge-b.sock")
    feeder = Feeder(sock)
    t0 = time.monotonic()
    rec = recorder(sock, 1, os.path.join(tmp, "rec-b"))
    out, err = rec.communicate(timeout=30)
    took = time.monotonic() - t0
    feeder.stop()
    check(f"record-bus: stops at its duration ({took:.1f} s for 1 s), nothing recorded, exit 0",
          rec.returncode == 0 and took < 15 and os.path.getsize(os.path.join(tmp, "rec-b.ts")) == 0)
    rec = recorder(os.path.join(tmp, "no-such.sock"), 5, os.path.join(tmp, "rec-c"))
    out, err = rec.communicate(timeout=30)
    check("record-bus: no edge at the socket: exit 1, said on stderr", rec.returncode == 1 and "record-bus:" in err)


def test_demux(tmp):
    if not os.path.exists(SO):
        print("SKIP record-bus --demux: mrtshouse not built")
        return
    # The mixer trim on house PES, on this clock: one buffer per 1316 bytes, stamped at the start.
    name = "cap-mixer-302m-house"
    ts, _ = rebased(tmp, name, now_ns() + 200_000_000, bus=False)
    size = os.path.getsize(ts)
    side = [{"off": o, "len": min(1316, size - o), "pts": now_ns(), "dts": None, "dur": None, "flags": 0}
            for o in range(0, size, 1316)]
    sock = os.path.join(tmp, "edge-d.sock")
    feeder = Feeder(sock)
    stem = os.path.join(tmp, "rec-d")
    rec = recorder(sock, 60, stem, "--demux", "select", "--plugin", SO)
    if feeder.wait_client():
        feeder.play(ts, side)
    wait_size(stem + ".ts", size)
    time.sleep(0.5)
    rec.send_signal(signal.SIGTERM)
    out, err = rec.communicate(timeout=20)
    feeder.stop()
    pads = lines(stem + ".pads.jsonl") if os.path.exists(stem + ".pads.jsonl") else []
    pes = [json.loads(x) for x in run(CLI, "dump", ts).stdout.splitlines() if x.startswith('{"pid"')]
    whole = [p for p in pes if p["pts"] is not None]           # the dump drops the one the trim cut
    check(f"record-bus --demux select: a pad line per whole 302M PES, its crc32 and length ({len(pads)} of {len(whole)})",
          rec.returncode == 0 and len(pads) >= len(whole) - 1 and all(p["pad"] == "src" for p in pads) and
          [(p["crc32"], p["len"] - 0) for p in pads] == [(u["crc32"], u["len"]) for u in whole][-len(pads):])
    r = run("sh", os.path.join(ROOT, "tools", "align-check", "pes_formula.sh"), stem)
    res = [json.loads(x) for x in r.stdout.splitlines()]
    pad = res[0] if res else {}
    # Phase 2's select mode floors the ns, Phase 3's ceils (S12): joined and one of the two exact.
    check(f"pes_formula.sh on the recording: every buffer joined, on one rounding ({pad})",
          pad.get("joined") == len(pads) > 0 and len(pads) in (pad.get("exact"), pad.get("floor")))


def test_trim(tmp):
    trim = os.path.join(HERE, "trim.sh")
    out = os.path.join(tmp, "cut.ts")
    cap = os.path.join(FIX, "cap-gate-mux-hevc-aac-opus.ts")
    r = run("sh", trim, cap, out, "--from", "2")
    data = open(out, "rb").read() if os.path.exists(out) else b""
    pid0 = len(data) >= 3 and data[0] == 0x47 and data[1] & 0x40 and ((data[1] & 0x1F) << 8 | data[2]) == 0
    check(f"trim.sh: a capture cut from a PAT before an HEVC IRAP 2 s in, whole packets ({r.stdout.strip()})",
          r.returncode == 0 and pid0 and 0 < len(data) <= 1999944 and len(data) % 188 == 0 and
          "random access point at" in r.stdout)
    src = open(cap, "rb").read()
    check("trim.sh: the cut is the source's bytes", len(data) > 0 and src.find(data) > 0)
    out = os.path.join(tmp, "cut2.ts")
    r = run("sh", trim, os.path.join(FIX, "syn-gap-marker.ts"), out, "--bus", "--from", "2.5")
    src = open(os.path.join(FIX, "syn-gap-marker.ts"), "rb").read()
    data = open(out, "rb").read() if r.returncode == 0 else b""
    got = lines(os.path.join(tmp, "cut2.bus.jsonl")) if r.returncode == 0 else []
    full = lines(os.path.join(FIX, "syn-gap-marker.bus.jsonl"))
    start = src.find(data) if data else -1
    want = [dict(b, off=b["off"] - start) for b in full if start <= b["off"] < start + len(data)]
    tiles = sum(b["len"] for b in got) == len(data) and all(b["off"] == sum(x["len"] for x in got[:i])
                                                             for i, b in enumerate(got))
    check(f"trim.sh --bus: TS and sidecar cut together on whole buffers, the markers kept ({len(got)} buffers)",
          r.returncode == 0 and start > 0 and got == want and tiles and sum(b["flags"] == 2112 for b in got) == 2)
    # A PAT only after every random access point: the PAT packets cut out.
    nopat = os.path.join(tmp, "nopat.ts")
    with open(nopat, "wb") as f:
        f.write(b"".join(src[i:i + 188] for i in range(0, len(src), 188)
                         if not ((src[i + 1] & 0x1F) << 8 | src[i + 2]) == 0))
    r = run("sh", trim, nopat, os.path.join(tmp, "x.ts"))
    check("trim.sh: no PAT before a random access point: exit 1, said", r.returncode == 1 and "no PAT" in r.stderr)


def test_scripts():
    r = run("sh", os.path.join(HERE, "record-bus.sh"), "a", "b")
    check("record-bus.sh: too few arguments exit 2 with its usage", r.returncode == 2 and "usage" in r.stderr)
    bad = [s for s in ("fixtures/record-bus.sh", "fixtures/trim.sh", "fixtures/gen-thirdparty.sh",
                       "align-check/pes_diff.sh", "align-check/pes_formula.sh")
           if run("sh", "-n", os.path.join(ROOT, "tools", s)).returncode]
    check(f"the shell tools parse (sh -n){': ' + ', '.join(bad) if bad else ''}", not bad)


def main():
    tmp = tempfile.mkdtemp(prefix="fixture_tools_test.")
    try:
        test_record(tmp)
        test_duration(tmp)
        test_demux(tmp)
        test_trim(tmp)
        test_scripts()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S) in fixture_tools")
        return 1
    print("\nALL fixture_tools TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
