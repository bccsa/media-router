#!/usr/bin/env python3
"""record-bus.py <edge socket> <seconds> <stem> [--demux select[=CAPS]|media[=MEDIA]] [--plugin SO]

A bus recording (plan ch. 7 WI-P3-3): a second unixfdsrc client on an existing bus edge, the
DEV taps' method, on the box with the image's python3-gi. Writes <stem>.ts (the bytes of every
buffer, in order) and <stem>.bus.jsonl (one line per buffer: off, len, pts, dts, dur in ns or
null, flags = its GstBufferFlags, GAP 2048 and DISCONT 64 among them, less TAG_MEMORY, which
unixfdsrc sets on its memfd memory; mrts_cli rebase's form). unixfdsrc flags its first buffer
DISCONT. Each buffer is written and released in the callback (B-91: an edge's memfds go back
at once), unbuffered, so a killed recorder leaves whole lines. Stops after <seconds> or at
SIGTERM/SIGINT.

--demux also runs mrtsdemux on the same buffers (select mode, CAPS audio/x-smpte-302m by
default; media: the demux mode, MEDIA its media mask, every pad by default) and writes
<stem>.pads.jsonl: per output buffer its pad, pts, dts, dur, flags, len and zlib crc32, for
tools/align-check/pes_formula.sh. The plugin is libgstmrtshouse.so from --plugin, else the one
the engine loads: under $MR_ROOT (/opt/media-router)/plugins, then $MR_LIBEXEC_DIR
(/usr/libexec/media-router), then this checkout's build.

House time on the bus is CLOCK_MONOTONIC with base time 0, so the PTS read here are house ns.
Exit 0 when it ran its time, 1 on a pipeline error (stderr says which)."""
import json
import os
import signal
import sys
import zlib

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

NONE = Gst.CLOCK_TIME_NONE


def usage():
    sys.stderr.write(__doc__.split("\n\n")[0] + "\n")
    sys.exit(2)


def args(argv):
    pos, demux, plugin = [], None, None
    it = iter(argv)
    for a in it:
        if a == "--demux":
            demux = next(it, None)
            if not demux or demux.split("=", 1)[0] not in ("select", "media"):
                usage()
        elif a == "--plugin":
            plugin = next(it, None) or usage()
        elif a.startswith("-"):
            usage()
        else:
            pos.append(a)
    if len(pos) != 3:
        usage()
    try:
        secs = float(pos[1])
    except ValueError:
        usage()
    return pos[0], secs, pos[2], demux, plugin


def plugin_path(given):
    here = os.path.dirname(os.path.abspath(__file__))
    tried = [given] if given else [
        os.path.join(os.environ.get("MR_ROOT") or "/opt/media-router", "plugins", "mpegts-core", "native",
                     "mrtshouse", "libgstmrtshouse.so"),
        os.path.join(os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router", "mpegts-core",
                     "libgstmrtshouse.so"),
        os.path.join(here, "..", "..", "plugins", "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")]
    for p in tried:
        if os.path.exists(p):
            return p
    sys.stderr.write(f"record-bus: libgstmrtshouse.so not found, tried {', '.join(tried)}\n")
    sys.exit(1)


def stamp(t):
    return None if t == NONE else t


def main(argv):
    sock, secs, stem, demux, plugin = args(argv)
    Gst.init([])
    head = f"unixfdsrc socket-path={sock} ! "
    if demux:
        Gst.Plugin.load_file(plugin_path(plugin))
        mode, _, value = demux.partition("=")
        prop = f"select={value or 'audio/x-smpte-302m'}" if mode == "select" else (f"media={value}" if value else "")
        # No queue: the demux pushes from the source's thread, so every line lands in order.
        launch = (head + "tee name=t t. ! appsink name=rec sync=false async=false emit-signals=true "
                  f"t. ! mrtsdemux name=d {prop}")
    else:
        launch = head + "appsink name=rec sync=false async=false emit-signals=true"
    pipe = Gst.parse_launch(launch)
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(NONE)
    pipe.set_base_time(0)

    ts = open(stem + ".ts", "wb", buffering=0)
    bus = open(stem + ".bus.jsonl", "w", buffering=1)
    pads = open(stem + ".pads.jsonl", "w", buffering=1) if demux else None
    tag = int(Gst.BufferFlags.TAG_MEMORY)
    state = {"off": 0, "buffers": 0, "gaps": 0, "out": 0, "error": None}

    def on_sample(sink):
        sample = sink.emit("pull-sample")
        b = sample.get_buffer()
        ok, m = b.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.ERROR
        try:
            ts.write(m.data)
            n = m.size
        finally:
            b.unmap(m)
        flags = int(b.get_flags()) & ~tag
        bus.write(json.dumps({"off": state["off"], "len": n, "pts": stamp(b.pts), "dts": stamp(b.dts),
                              "dur": stamp(b.duration), "flags": flags}, separators=(",", ":")) + "\n")
        state["off"] += n
        state["buffers"] += 1
        state["gaps"] += bool(flags & Gst.BufferFlags.GAP)
        return Gst.FlowReturn.OK

    def pad_sink(name):
        def on_pad_sample(sink):
            b = sink.emit("pull-sample").get_buffer()
            ok, m = b.map(Gst.MapFlags.READ)
            if not ok:
                return Gst.FlowReturn.ERROR
            try:
                line = {"pad": name, "pts": stamp(b.pts), "dts": stamp(b.dts), "dur": stamp(b.duration),
                        "flags": int(b.get_flags()) & ~tag, "len": m.size, "crc32": f"{zlib.crc32(m.data):08x}"}
            finally:
                b.unmap(m)
            pads.write(json.dumps(line, separators=(",", ":")) + "\n")
            state["out"] += 1
            return Gst.FlowReturn.OK

        s = Gst.ElementFactory.make("appsink")
        for k, v in (("sync", False), ("async", False), ("emit-signals", True)):
            s.set_property(k, v)
        s.connect("new-sample", on_pad_sample)
        return s

    pipe.get_by_name("rec").connect("new-sample", on_sample)
    if demux:
        d = pipe.get_by_name("d")

        def on_pad(_el, pad):
            s = pad_sink(pad.get_name())
            pipe.add(s)
            s.sync_state_with_parent()
            pad.link(s.get_static_pad("sink"))

        d.connect("pad-added", on_pad)
        for pad in d.srcpads:            # select mode's ALWAYS pad
            on_pad(d, pad)

    loop = GLib.MainLoop()

    def on_msg(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            state["error"] = f"{err.message} ({dbg})"
            loop.quit()
        elif msg.type == Gst.MessageType.EOS:
            loop.quit()

    gbus = pipe.get_bus()
    gbus.add_signal_watch()
    gbus.connect("message", on_msg)
    for sig in (signal.SIGTERM, signal.SIGINT):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, lambda: (loop.quit(), False)[1])
    GLib.timeout_add(int(secs * 1000), lambda: (loop.quit(), False)[1])
    if pipe.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        state["error"] = "the pipeline would not start"
    else:
        loop.run()
    pipe.set_state(Gst.State.NULL)
    for f in (ts, bus, pads):
        if f:
            f.close()
    if state["error"]:
        sys.stderr.write(f"record-bus: {state['error']}\n")
        return 1
    print(f"record-bus: {state['buffers']} buffers, {state['off']} bytes, {state['gaps']} GAP from {sock} -> "
          f"{stem}.ts" + (f", {state['out']} demux buffers" if demux else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
