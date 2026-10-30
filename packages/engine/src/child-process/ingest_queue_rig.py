#!/usr/bin/env python3
"""A network ingest's chain under a high-bitrate feed (B-182; a rig the module tests run, not a
suite). The chain is what the module builds between its transport source and its bus sink (the
restamp and the ingest queue); an appsrc feeds it 1,316-byte buffers of null TS packets at a
bitrate in real time, stamped as srtsrc stamps them (smooth send times), and the queue's output
is held once: for stall_ms, and until a stall_ms of the feed has reached it, however late that is.
Prints one JSON object per case, or {"skip": why}.

usage: ingest_queue_rig.py '<chain>' <rate_mbps>:<stall_ms>[:<step_ms>] ...
  step_ms: the stamps step forward this far 10 ms into the hold, while the queue holds data (a
  sender's pause read on send-time stamps). Fields per case: pushed, rendered, lost (pushed less
  what reached the sink), overruns (buffers that met the queue full), heldLevelBytes (the queue's
  level as the hold ends), maxLevelBytes, maxSrcLevelBytes (the appsrc's own queue: it grows only
  while the chain holds the transport's thread), heldMs, maxInGapMs and lagMaxMs (how far the feed
  fell behind its schedule)."""
import json
import os
import struct
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(sys.argv[:1])
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(json.dumps({"skip": f"GStreamer unavailable ({exc})"}))
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", "..", ".."))
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.join(_ROOT, "plugins")
_SO = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
PKT, PKTS = 188, 7
BUF = PKT * PKTS
LEAD_S, TAIL_S, STEP_AT_S = 0.3, 0.3, 0.01


def null_packets():
    """Seven null packets (PID 0x1FFF, payload only): the restamp passes them as they are."""
    one = bytes([0x47, 0x1F, 0xFF, 0x10]) + bytes(PKT - 4)
    return bytearray(one * PKTS)


def first_queue(pipe):
    """The chain's queue (the bin iterator, without gst-python's overrides)."""
    it = pipe.iterate_recurse()
    while True:
        ok, el = it.next()
        if ok != Gst.IteratorResult.OK:
            raise LookupError("no queue in the chain")
        if el.get_factory() and el.get_factory().get_name() == "queue":
            return el


def run_case(chain, rate_mbps, stall_ms, step_ms):
    pipe = Gst.parse_launch(
        f'appsrc name=src is-live=true format=time max-bytes=0 block=false caps="{TS_CAPS}" '
        f"! {chain} ! fakesink name=sink sync=false async=false")
    src, sink = pipe.get_by_name("src"), pipe.get_by_name("sink")
    queue = first_queue(pipe)
    res = {"rateMbps": rate_mbps, "stallMs": stall_ms, "stepMs": step_ms, "overruns": 0,
           "heldLevelBytes": 0, "maxLevelBytes": 0, "maxSrcLevelBytes": 0, "heldMs": 0.0,
           "maxInGapMs": 0.0, "lagMaxMs": 0.0}
    lock = threading.Lock()
    interval = BUF * 8 / (rate_mbps * 1e6)
    hold = {"arrived": 0, "need": round(stall_ms / 1e3 / interval), "done_at": None}

    def on_overrun(_q):
        with lock:
            res["overruns"] += 1

    queue.connect("overrun", on_overrun)
    gap = {"last": None}

    def on_in(_pad, info):
        now = time.monotonic()
        with lock:
            hold["arrived"] += (info.get_buffer_list().length()
                                if info.type & Gst.PadProbeType.BUFFER_LIST else 1)
            if gap["last"] is not None:
                res["maxInGapMs"] = max(res["maxInGapMs"], (now - gap["last"]) * 1e3)
            gap["last"] = now
        return Gst.PadProbeReturn.OK

    def on_stall(_pad, _info):
        t0 = time.monotonic()
        give_up = t0 + 5 * stall_ms / 1e3 + 2
        while time.monotonic() < give_up and (time.monotonic() - t0 < stall_ms / 1e3
                                              or hold["arrived"] < hold["need"]):
            time.sleep(0.001)
        res["heldMs"] = round((time.monotonic() - t0) * 1e3, 1)
        res["heldLevelBytes"] = queue.get_property("current-level-bytes")
        hold["done_at"] = time.monotonic()
        return Gst.PadProbeReturn.REMOVE

    pipe.set_state(Gst.State.PLAYING)
    i_stall = int(LEAD_S / interval)
    i_step = i_stall + int(STEP_AT_S / interval)
    tmpl = null_packets()
    in_probe = None
    t0 = time.monotonic()
    i = 0
    while hold["done_at"] is None or time.monotonic() - hold["done_at"] < TAIL_S:
        now = time.monotonic() - t0
        due = int(now / interval) + 1
        if due > i:
            res["lagMaxMs"] = max(res["lagMaxMs"], (now - i * interval) * 1e3)
        while i < due:
            if i == i_stall:
                in_probe = queue.get_static_pad("sink").add_probe(
                    Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, on_in)
                queue.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, on_stall)
            struct.pack_into(">Q", tmpl, 4, i)
            b = Gst.Buffer.new_wrapped(bytes(tmpl))
            b.pts = int(i * interval * 1e9) + (step_ms * 1_000_000 if step_ms and i >= i_step else 0)
            src.emit("push-buffer", b)
            i += 1
        if in_probe is not None and hold["done_at"] and time.monotonic() - hold["done_at"] >= 0.1:
            queue.get_static_pad("sink").remove_probe(in_probe)
            in_probe = None
        res["maxLevelBytes"] = max(res["maxLevelBytes"], queue.get_property("current-level-bytes"))
        res["maxSrcLevelBytes"] = max(res["maxSrcLevelBytes"], src.get_property("current-level-bytes"))
        time.sleep(0.0005)
    if in_probe is not None:
        queue.get_static_pad("sink").remove_probe(in_probe)
    # The queue drains before the EOS: it flushes on EOS (flush-on-eos), which is no loss here.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and (queue.get_property("current-level-buffers")
                                           or src.get_property("current-level-buffers")):
        time.sleep(0.01)
    time.sleep(0.05)
    res["pushed"] = i
    res["rendered"] = sink.get_property("stats").get_value("rendered")
    res["lost"] = i - res["rendered"]
    msg = pipe.get_bus().pop_filtered(Gst.MessageType.ERROR)
    res["error"] = msg.parse_error()[0].message if msg else None
    pipe.set_state(Gst.State.NULL)
    res["maxInGapMs"] = round(res["maxInGapMs"], 1)
    res["lagMaxMs"] = round(res["lagMaxMs"], 1)
    return res


def main():
    chain, cases = sys.argv[1], sys.argv[2:]
    if "mrtsrestamp" in chain:
        if not os.path.exists(_SO):
            print(json.dumps({"skip": f"{_SO} not built (make native)"}))
            return
        Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure
    for case in cases:
        parts = [int(x) for x in case.split(":")]
        rate, stall, step = parts[0], parts[1], parts[2] if len(parts) > 2 else 0
        print(json.dumps(run_case(chain, rate, stall, step)), flush=True)


if __name__ == "__main__":
    main()
