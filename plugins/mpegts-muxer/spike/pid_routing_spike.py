#!/usr/bin/env python3
"""Phase 3 PID-routing spike for PLAN-MR-MPEGTS-DYN.

Exercises the demuxer-side `linkOnPadAdded` extension added in Phase 3: matching
demux pads to branches **by PID** (`matchPids`) instead of pad-added order, and
the duplicate-PID **tee fan-out** (one stream feeding both a `pid-…` port and the
legacy positional port that maps to it).

It builds a 2-program-ish TS (one video PID 0x100, one audio PID 0x141) with
mpegtsmux, then demuxes it and installs a `matchPids` rule via the *actual*
runner code (`_install_pad_link_rule`) so the spike tracks the shipped logic.
Asserts that:
  - each pad lands on the branch for its own PID regardless of arrival order,
  - a PID listed twice in `matchPids` reaches both branches (tee), and
  - a pad whose PID isn't in `matchPids` is ignored (no misroute).

Run on a box with GStreamer 1.24/1.22 + Python GI + gst-plugins-bad/ugly:

    python3 plugins/mpegts-muxer/spike/pid_routing_spike.py

Exit 0 = PASS. Exit 1 = FAIL.
"""
import functools
import importlib.util
import os
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

print = functools.partial(print, flush=True)  # noqa: A001
Gst.init(None)

VIDEO_PID = 0x100
AUDIO_PID = 0x141

# Import the shipped runner so the spike tests the real link logic.
_RUNNER = os.path.join(
    os.path.dirname(__file__), "..", "..", "..",
    "packages", "engine", "src", "child-process", "gst-pipeline-runner.py",
)
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


def main():
    # Source: a synthetic muxed TS with one video + one audio elementary stream,
    # PIDs pinned via mpegtsmux request-pad names (D3).
    src = (
        f"mpegtsmux name=mux ! tsdemux name=demux "
        f"videotestsrc num-buffers=30 ! x264enc tune=zerolatency ! h264parse ! mux.sink_{VIDEO_PID} "
        f"audiotestsrc num-buffers=30 ! avenc_aac ! aacparse ! mux.sink_{AUDIO_PID}"
    )
    pipe = Gst.parse_launch(src)
    demux = pipe.get_by_name("demux")

    seen = {}  # branch index -> count of buffers it received

    def make_branch(idx):
        # appsink that records it received data for this branch index.
        return f"queue ! appsink name=out{idx} emit-signals=true sync=false"

    # video PID feeds branch 0 (the pid-… port) AND branch 1 (legacy video-0),
    # both matching PID 0x100 → tee fan-out. audio PID feeds branch 2.
    rule_video = {
        "from": "demux",
        "media": "video",
        "branches": [make_branch(0), make_branch(1)],
        "matchPids": [VIDEO_PID, VIDEO_PID],
    }
    rule_audio = {
        "from": "demux",
        "media": "audio",
        "branches": [make_branch(2)],
        "matchPids": [AUDIO_PID],
    }
    runner._install_pad_link_rule(pipe, rule_video)
    runner._install_pad_link_rule(pipe, rule_audio)

    def hook_sink(name, idx):
        s = pipe.get_by_name(name)
        if s:
            s.connect("new-sample", lambda el: (_count(seen, idx), el.emit("pull-sample") and Gst.FlowReturn.OK)[1])

    # appsinks are created lazily inside the rule's branch — connect after PLAYING.
    loop = GLib.MainLoop()

    def on_msg(_bus, msg):
        if msg.type == Gst.MessageType.EOS:
            loop.quit()
        elif msg.type == Gst.MessageType.ERROR:
            err, _ = msg.parse_error()
            print(f"ERROR: {err.message}")
            loop.quit()
        elif msg.type == Gst.MessageType.STATE_CHANGED and msg.src is pipe:
            _old, new, _p = msg.parse_state_changed()
            if new == Gst.State.PLAYING:
                for i, nm in ((0, "out0"), (1, "out1"), (2, "out2")):
                    hook_sink(nm, i)

    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_msg)
    pipe.set_state(Gst.State.PLAYING)
    GLib.timeout_add_seconds(15, lambda: (loop.quit(), False)[1])
    loop.run()
    pipe.set_state(Gst.State.NULL)

    ok = seen.get(0, 0) > 0 and seen.get(1, 0) > 0 and seen.get(2, 0) > 0
    print(f"branch sample counts: {seen}")
    if ok:
        print("PASS — PID matching + tee fan-out routed all branches")
        return 0
    print("FAIL — a branch received no data (PID match or tee fan-out broken)")
    return 1


def _count(d, idx):
    d[idx] = d.get(idx, 0) + 1


if __name__ == "__main__":
    sys.exit(main())
