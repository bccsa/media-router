#!/usr/bin/env python3
"""Reference runner for the native-core parity test.

Drives ts_split.SplitterCore over a TS file with the exact CLI interface of
the native harness (native/mrts/mrts_cli.cpp): identical chunking, identical
per-PID output files, identical JSON event lines. The parity vitest runs both
and requires byte-identical outputs — this file is the executable spec side.

Usage: native_parity_ref.py --outputs 0x100[,0x140:0x0f,...] [--chunk 1316]
                            [--ts-id 1] --out-dir DIR input.ts
"""
import argparse
import json
import sys

import ts_split
import ts_video_info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outputs", required=True)
    ap.add_argument("--chunk", type=int, default=1316)
    ap.add_argument("--ts-id", type=int, default=1)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("input")
    args = ap.parse_args()

    outputs = []
    for tok in args.outputs.split(","):
        pid, _, stype = tok.partition(":")
        outputs.append((int(pid, 0), int(stype, 0) if stype else None))

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")

    def on_discovered(streams, pcr_pid, es_info):
        emit({"event": "discovered",
              "streams": [[p, t] for p, t in streams],
              "pcrPid": pcr_pid,
              "esInfo": [[p, es_info.get(p, b"").hex()] for p, _ in streams]})

    def on_videoinfo(pid, info):
        ev = {"event": "videoinfo", "pid": pid, "codec": info["codec"]}
        for k in ("width", "height", "interlaced", "fps"):
            if info.get(k) is not None:
                ev[k] = info[k]
        if info.get("scrambled"):
            ev["scrambled"] = True
        display = ts_video_info.format_video_info(info)
        if display:
            ev["display"] = display
        emit(ev)

    core = ts_split.SplitterCore(
        args.ts_id, outputs, on_discovered=on_discovered,
        on_desync=lambda dropped: emit({"event": "desync", "dropped": dropped}),
        on_videoinfo=on_videoinfo)

    files = {pid: open(f"{args.out_dir}/out_0x{pid:x}.ts", "wb")
             for pid, _ in outputs}
    with open(args.input, "rb") as f:
        data = f.read()
    for off in range(0, len(data), args.chunk):
        for pid, payload in core.feed(data[off:off + args.chunk]).items():
            files[pid].write(payload)
    for fh in files.values():
        fh.close()
    emit({"event": "done", "desyncBytes": core.desync_bytes})
    return 0


if __name__ == "__main__":
    sys.exit(main())
