#!/usr/bin/env python3
"""`mrts_cli dump` against ffprobe, PES for PES (WI-S0-6 acceptance). Test tooling only.

Per PID and in order, every PES must agree on PTS, DTS, payload length and zlib CRC-32.
Usage: python3 dump_vs_ffprobe.py [--cli PATH] [--chunk N] input.ts
Exit:  0 every PES agrees (a PES cut by end of file is noted), 1 differences, 2 a tool failed.
"""
import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict

WRAP = 1 << 33
CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "native", "mrts", "mrts_cli")


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def run(cmd):
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        fail(f"{cmd[0]}: not found")
    if res.returncode != 0:
        fail(f"{cmd[0]} failed ({res.returncode}): {res.stderr.strip()}")
    return res.stdout


def dump(cli, path, chunk):
    units, counters = defaultdict(list), {}
    for line in run([cli, "dump", "--chunk", str(chunk), path]).splitlines():
        rec = json.loads(line)
        if "pid" in rec:
            units[rec["pid"]].append(rec)
        counters = rec.get("counters", counters)
    return units, counters


def probe(path):
    # Parsers off: one packet per PES as demuxed. The packet cap is raised from 200 KiB
    # to PesAssembler's 32 MiB so a large unbounded PES is not cut in two.
    out = json.loads(run(["ffprobe", "-v", "error", "-fflags", "+noparse+nofillin",
                          "-max_packet_size", str(32 << 20), "-show_streams", "-show_packets",
                          "-show_data_hash", "CRC32", "-of", "json", path]))
    pid_of = {s["index"]: int(s["id"], 16) for s in out.get("streams", [])}
    packets = defaultdict(list)
    for p in out.get("packets", []):
        packets[pid_of[p["stream_index"]]].append(p)
    return packets


def compare(units, packets, counters):
    """Differences as text, explained ones, the PES that agree, and the unwrap offset."""
    # ffprobe wrap-corrects by whole 2^33 steps of its own choosing: unwrapped values
    # may differ from ours by one offset, fixed by the first PES with a PTS.
    problems, notes, offset, agreed = [], [], None, 0
    # A bounded PES the file ends inside: ffprobe returns the part, PesAssembler.flush
    # drops it as malformed. Explained when it is each PID's last and the counter covers all.
    tails = [pid for pid in packets if len(packets[pid]) == len(units.get(pid, [])) + 1]
    tails = tails if len(tails) <= counters.get("pesMalformed", 0) else []
    for pid in sorted(set(units) | set(packets)):
        ours, theirs = units.get(pid, []), packets.get(pid, [])
        if pid in tails:
            p = theirs[-1]
            notes.append(f"pid {pid}: last PES cut by end of file (pts {p.get('pts')}, "
                         f"{p['size']} bytes), ffprobe keeps it, the dump counts it malformed")
        elif len(ours) != len(theirs):
            problems.append(f"pid {pid}: {len(ours)} PES in the dump, {len(theirs)} from ffprobe")
        for u, p in zip(ours, theirs):
            diffs = []
            pts, dts = p.get("pts"), p.get("dts")
            if u["pts"] is None:
                if pts is not None:
                    diffs.append(f"pts null, ffprobe {pts}")
            else:
                if pts is None or pts % WRAP != u["pts"]:
                    diffs.append(f"pts {u['pts']}, ffprobe {pts}")
                elif offset is None:
                    offset = u["ptsUnwrapped"] - pts
                if offset is not None and pts is not None and u["ptsUnwrapped"] - pts != offset:
                    diffs.append(f"ptsUnwrapped {u['ptsUnwrapped']}, ffprobe {pts} + {offset}")
                # ffprobe gives a header without a DTS its PTS as the DTS.
                want_dts = u["dts"] if u["dts"] is not None else u["pts"]
                if dts is None or dts % WRAP != want_dts:
                    diffs.append(f"dts {u['dts']}, ffprobe {dts}")
                elif u["dts"] is not None and u["dtsUnwrapped"] != dts + (offset or 0):
                    diffs.append(f"dtsUnwrapped {u['dtsUnwrapped']}, ffprobe {dts} + {offset}")
            if int(p["size"]) != u["len"]:
                diffs.append(f"len {u['len']}, ffprobe {p['size']}")
            if p.get("data_hash") != "CRC32:" + u["crc32"]:
                diffs.append(f"crc32 {u['crc32']}, ffprobe {p.get('data_hash')}")
            if diffs:
                problems.append(f"pid {pid} seq {u['seq']}: " + "; ".join(diffs))
            else:
                agreed += 1
    if offset is not None and offset % WRAP:
        problems.append(f"unwrap offset {offset} is not a whole number of 2^33 wraps")
    return problems, notes, agreed, offset


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cli", default=CLI, help="mrts_cli binary (built by native/build-host.sh)")
    ap.add_argument("--chunk", type=int, default=1316)
    ap.add_argument("input")
    args = ap.parse_args()
    if not os.access(args.cli, os.X_OK):
        fail(f"{args.cli}: not built (run plugins/mpegts-core/native/build-host.sh)")
    (units, counters), packets = dump(args.cli, args.input, args.chunk), probe(args.input)
    problems, notes, agreed, offset = compare(units, packets, counters)
    for line in notes + problems:
        print(line)
    total = sum(len(v) for v in units.values())
    print(f"{agreed} of {total} PES on {len(units)} PID(s) agree with ffprobe on pts, dts, len and "
          f"crc32 (unwrap offset {offset})")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
