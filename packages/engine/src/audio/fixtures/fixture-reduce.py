#!/usr/bin/env python3
"""Cuts a full `pw-dump` to what pipeWireLatency.ts reads: the `settings` metadata, the MR_PW_*
nodes and the mr-gst-runner stream nodes, params cut to `Latency`. pw-dump-fleet.json came from
10.9.16.22 (Pi 5, PipeWire 1.6.3: audio-decoder, audio-encoder, n1-mixer).  Usage: IN OUT."""
import json
import sys


def keep(obj):
    if obj["type"] == "PipeWire:Interface:Metadata":
        return obj.get("props", {}).get("metadata.name") == "settings"
    if obj["type"] != "PipeWire:Interface:Node":
        return False
    props = obj.get("info", {}).get("props", {})
    return (str(props.get("node.name", "")).startswith("MR_PW_")
            or props.get("application.name") == "mr-gst-runner")


def main(src, dst):
    out = []
    for obj in json.load(open(src)):
        if not keep(obj):
            continue
        params = obj.get("info", {}).get("params")
        if params is not None:
            obj["info"]["params"] = {k: v for k, v in params.items() if k == "Latency"}
        out.append(obj)
    with open(dst, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"{len(out)} objects -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
