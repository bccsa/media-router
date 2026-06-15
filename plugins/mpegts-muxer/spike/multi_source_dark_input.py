#!/usr/bin/env python3
"""
Spike: does a multi-source mpegtsmux keep muxing its LIVE inputs when ONE
input goes dark?

Settles issue #1 of the dynamic-streams review: the muxer's per-input udpsrc
`timeout` turns a single dark source into a full-pipeline teardown+restart
(restartOnError), which on a multi-source broadcast mux disrupts every healthy
input and loops every ~5 s. Removing the timeout is only safe if mpegtsmux
continues delivering the surviving inputs rather than stalling the aggregate.

Setup (all on lo, no real network):
  - 2 synthetic MPEG-TS sources (videotestsrc/audiotestsrc → mpegtsmux → udpsink)
    on two multicast groups, mimicking two upstream encoders.
  - 1 consumer mux: 2× (udpsrc ! tsdemux) → mpegtsmux → appsink, counting output
    buffers.
  - Run both sources ~2 s, then KILL source B and keep going ~3 s.
  - PASS if the consumer mux keeps producing output buffers AFTER B dies
    (i.e. source A's data still flows through the aggregate).

Exit 0 = PASS. Run on the target box: python3 multi_source_dark_input.py
"""
import sys
import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib

Gst.init(None)

GRP_A = "239.200.0.1"
GRP_B = "239.200.0.2"
PORT_A = 47100
PORT_B = 47101


def make_source(group, port, kind):
    # kind: 'video' uses videotestsrc+x264enc, 'audio' uses audiotestsrc+avenc_aac
    if kind == "video":
        enc = ("videotestsrc is-live=true ! video/x-raw,width=160,height=120,framerate=15/1 "
               "! x264enc tune=zerolatency key-int-max=15 ! h264parse")
    else:
        enc = ("audiotestsrc is-live=true ! audioconvert ! avenc_aac ! aacparse")
    desc = (f"{enc} ! mpegtsmux alignment=7 ! "
            f"udpsink host={group} port={port} multicast-iface=lo auto-multicast=true sync=true")
    p = Gst.parse_launch(desc)
    p.set_state(Gst.State.PLAYING)
    return p


def main():
    # Two synthetic encoders → two multicast groups.
    src_a = make_source(GRP_A, PORT_A, "video")
    src_b = make_source(GRP_B, PORT_B, "audio")

    # Consumer mux: both inputs → one mpegtsmux → appsink (count output).
    consumer = Gst.parse_launch(
        f"udpsrc multicast-group={GRP_A} port={PORT_A} multicast-iface=lo auto-multicast=true "
        f"caps=\"video/mpegts,systemstream=(boolean)true,packetsize=(int)188\" "
        f"! tsdemux latency=0 name=da "
        f"udpsrc multicast-group={GRP_B} port={PORT_B} multicast-iface=lo auto-multicast=true "
        f"caps=\"video/mpegts,systemstream=(boolean)true,packetsize=(int)188\" "
        f"! tsdemux latency=0 name=db "
        f"mpegtsmux name=mux alignment=7 latency=0 ! appsink name=out emit-signals=true sync=false "
        f"da. ! queue ! h264parse ! mux. "
        f"db. ! queue ! aacparse ! mux."
    )

    counts = {"total": 0, "after_kill": 0}
    killed = {"done": False}

    def on_sample(sink):
        sink.emit("pull-sample")
        counts["total"] += 1
        if killed["done"]:
            counts["after_kill"] += 1
        return Gst.FlowReturn.OK

    consumer.get_by_name("out").connect("new-sample", on_sample)
    consumer.set_state(Gst.State.PLAYING)

    loop = GLib.MainLoop()

    def kill_b():
        src_b.set_state(Gst.State.NULL)
        killed["done"] = True
        sys.stderr.write("[spike] killed source B (audio) — watching A keep flowing\n")
        return False

    def finish():
        loop.quit()
        return False

    # Let both run, then kill B, then observe a long post-kill window so a true
    # stall is unambiguous (a mere slowdown would still accumulate dozens).
    GLib.timeout_add(2500, kill_b)
    GLib.timeout_add(9000, finish)  # ~6.5 s after the kill
    loop.run()

    for p in (src_a, consumer):
        p.set_state(Gst.State.NULL)

    print(f"total output buffers: {counts['total']}, after B died: {counts['after_kill']}")
    if counts["after_kill"] > 5:
        print("RESULT: PASS — aggregate keeps muxing the live input after one source dies")
        return 0
    print("RESULT: FAIL — output stalled after one source went dark")
    return 1


if __name__ == "__main__":
    sys.exit(main())
