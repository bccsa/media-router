#!/usr/bin/env python3
"""Cuts a full `pw-dump` to what pipeWireLatency.ts reads: the `settings` metadata, the core's
CORE_PROPS, the MR_PW_* and mr-gst-runner nodes (params cut to `Latency`) and the other nodes in
an MR_PW node's driver group (n1-mixer loopbacks, props cut to PEER_PROPS). The Links between
kept nodes (LINK_INFO only) stay for reading the topology; the module does not read them.
pw-dump-fleet.json was cut from pw-dump-10.9.16.22.json: `pw-dump` on 10.9.16.22 (Pi 5, PipeWire
1.6.3: audio-decoder, audio-encoder, n1-mixer), 2026-10-13 12:42, 1826560 bytes, sha256
f84535d8cb97871cc4fc6c5ca35d2fd2b6c29cfcb58dd938f94ff3f48edc9b4a.  Usage: IN OUT."""
import json
import sys

CORE_PROPS = ("clock.power-of-two-quantum",)
PEER_PROPS = ("node.name", "media.class", "node.driver-id", "node.latency", "node.rate",
              "target.object")
LINK_INFO = ("output-node-id", "input-node-id", "output-port-id", "input-port-id", "state")


def props(obj):
    return obj.get("info", {}).get("props", {})


def is_node(obj):
    return obj["type"] == "PipeWire:Interface:Node"


def is_mr_pw(obj):
    return str(props(obj).get("node.name", "")).startswith("MR_PW_")


def driver(obj):
    """A node's driver group: `node.driver-id`, or its own id for the driver itself."""
    return props(obj).get("node.driver-id", obj["id"])


def subject(obj):
    if obj["type"] == "PipeWire:Interface:Metadata":
        return obj.get("props", {}).get("metadata.name") == "settings"
    return is_node(obj) and (is_mr_pw(obj)
                             or props(obj).get("application.name") == "mr-gst-runner")


def ends(link):
    return link["info"]["output-node-id"], link["info"]["input-node-id"]


def main(src, dst):
    dump = json.load(open(src))
    nodes = [obj for obj in dump if is_node(obj)]
    groups = {driver(obj) for obj in nodes if is_mr_pw(obj)}
    peers = {obj["id"] for obj in nodes if driver(obj) in groups and not subject(obj)}
    kept = peers | {obj["id"] for obj in nodes if subject(obj)}
    out = []
    for obj in dump:
        if obj["type"] == "PipeWire:Interface:Core":
            cut = {k: v for k, v in props(obj).items() if k in CORE_PROPS}
            obj = {"id": obj["id"], "type": obj["type"], "info": {"props": cut}}
        elif obj["id"] in peers:
            cut = {k: v for k, v in props(obj).items() if k in PEER_PROPS}
            obj = {"id": obj["id"], "type": obj["type"], "info": {"props": cut}}
        elif obj["type"] == "PipeWire:Interface:Link":
            if not set(ends(obj)) <= kept:
                continue
            info = {k: obj["info"][k] for k in LINK_INFO}
            obj = {"id": obj["id"], "type": obj["type"], "info": info}
        elif subject(obj):
            params = obj.get("info", {}).get("params")
            if params is not None:
                obj["info"]["params"] = {k: v for k, v in params.items() if k == "Latency"}
        else:
            continue
        out.append(obj)
    with open(dst, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print(f"{len(out)} objects -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
