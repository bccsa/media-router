#!/usr/bin/env python3
"""
GStreamer net-clock authority for cross-pipeline A/V sync.

Separate GStreamer pipelines (the demuxer-fed video-player and the
audio-decoder) each pick their own clock and base-time, so even with sync=true
they drift apart. To lock them, every participating pipeline must slave to ONE
clock and share ONE base-time.

Crucially, that clock must be the **audio** clock. Audio plays out through
PipeWire on the sound-card (DAC) clock, which you cannot rate-change without
artifacts — so video has to follow audio, not the other way round (this is what
v1's single pipeline did: the audio sink mastered, video chased it). A plain
system clock is the WRONG master — it ticks at a different rate than the DAC, so
video locked to it still creeps ahead of audio over time.

So this daemon sources the **PipeWire graph clock** via a `pulsesrc` (which
exposes a `GstAudioClock`) and serves it over TCP via `GstNet.NetTimeProvider`.
Every sync-enabled pipeline attaches a `GstNet.NetClientClock` to it (see
`_apply_net_clock` in `gst-pipeline-runner.py`), so they all present on the real
audio timeline. Falls back to the system clock (with a warning) only if no audio
source is available — better an unsynced run than no clock at all.

Stdout contract: one `GST_JSON:{"event":"clock_ready","port":N}` line once the
provider is up. We do NOT advertise a base-time: each runner anchors base-time
naturally at PLAYING against this shared clock (see `_apply_net_clock` in
`gst-pipeline-runner.py`). Sharing the *clock* removes the drift; the residual
is a small constant per-pipeline start offset (trim with a sink ts-offset),
which is simpler and more robust than round-tripping a base-time across
processes in this clock's time domain.
"""
import sys
import json
import signal
import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstNet", "1.0")
from gi.repository import Gst, GstNet, GLib

Gst.init(None)


def _audio_clock():
    """Obtain the PipeWire graph clock via a running pulsesrc, or None.

    A `pulsesrc ! fakesink sync=true` connects to the default PipeWire source
    and its `GstAudioClock` tracks the graph driver — the same clock every
    audio node (and thus the real playout) follows. The captured samples are
    discarded by the fakesink; we only want the clock. Returns (clock, pipeline)
    so the caller keeps the pipeline alive (the clock dies with it).
    """
    try:
        pipe = Gst.parse_launch("pulsesrc ! fakesink sync=true name=fs")
        pipe.set_state(Gst.State.PLAYING)
        pipe.get_state(5 * Gst.SECOND)
        clock = pipe.get_clock()
        if clock is not None:
            return clock, pipe
        pipe.set_state(Gst.State.NULL)
    except GLib.Error:
        pass
    return None, None


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    clock, holder = _audio_clock()
    if clock is None:
        # No audio source — fall back to the system clock so the daemon still
        # serves SOMETHING, but warn: video locked to this will still drift
        # from audio (the exact failure this daemon exists to fix).
        clock = Gst.SystemClock.obtain()
        sys.stderr.write(
            "GST_JSON:" + json.dumps({
                "event": "warning",
                "message": "no PipeWire audio clock available — serving system clock; A/V may still drift",
            }) + "\n")
        sys.stderr.flush()

    provider = GstNet.NetTimeProvider.new(clock, None, port)
    bound = provider.get_property("port")

    sys.stdout.write("GST_JSON:" + json.dumps({"event": "clock_ready", "port": bound}) + "\n")
    sys.stdout.flush()

    loop = GLib.MainLoop()
    signal.signal(signal.SIGTERM, lambda *_: loop.quit())
    signal.signal(signal.SIGINT, lambda *_: loop.quit())
    try:
        loop.run()
    finally:
        del provider
        if holder is not None:
            holder.set_state(Gst.State.NULL)


if __name__ == "__main__":
    main()
