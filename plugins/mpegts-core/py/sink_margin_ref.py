#!/usr/bin/env python3
"""The Python reference of mrasrc's sink margin (plan ch. 15.4 B-249, MR-057): how an audio output
whose sink runs sync=false keeps a real margin in the sink's ring, so that audio arriving later than
before plays late, never cut, and a hole (a real outage) is followed by a margin again. Ported into
mrts::AsrcSinkMargin (asrc_servo.h) for mrasrc's probe on its sink's pad, held to it by
sink_margin_parity_test.py. A reference only: nothing loads it at runtime (ADR-0029 choice 1).

Evidence (GStreamer 1.28 source, the c38 review's harness). A sync=false GstAudioBaseSink writes each
buffer at next_sample, the end of the last; only when that lies in a segment the ring has already
read (writeseg < segdone) does it realign, to segdone + 1. So once the ring runs dry it rebuilds at
most one segment (10 ms) of margin, and a write into segment segdone itself goes into the segment
GstAudioSink's thread is handing to the device, which it then clears: lost (pulsesink: its segdone
follows the server's read index every 100 ms, and the server drops writes behind that index). A
queue's min-threshold before the sink holds delay, not margin: it releases as it is fed.

Rule. Before each buffer reaches the sink's render, `consumed` is the first sample the device can
still play: the end of the segment in flight, (segdone + 1) x samples_per_seg, or the device clock's
position if that is further (pulsesink's segdone can be 100 ms stale). If the next write is at or
past it, nothing: the buffer plays contiguously, however small the margin left. Otherwise (the ring
ran dry: a hole is already playing; or the first write after a start or a flush) the buffer is
prefixed with silence so its first sample lands `margin` frames past `consumed`: the hole grows by
at most the margin, no sample is written where it cannot play, and from there a feed may get up to
`margin` later again without a hole. The silence starts where the base sink will write, which is
segdone + 1 when it realigns. Delay never shrinks (nothing is dropped); it grows only at a hole.
The first write after a start or a flush gets twice the margin: a device that starts takes its own
buffer out of the ring at once (the test sink's 40 ms, pulsesink about a quantum), so one margin
there would leave the feed less than a margin before its first hole.

API:
    m = SinkMargin(margin_frames)
    m.silence(next_sample, segdone, sps, play_pos=None) -> frames of silence to put first
        next_sample: the base sink's next write (-1: none yet), segdone: segments read since
        segbase, sps: samples per segment, play_pos: the device clock's position in the same
        frames, or None when it must not be read (before the first render: pulsesink dies of it)
    m.stats() -> {"refills", "silence"}
Run as a script it reads one JSON object per line ({"next", "segdone", "sps", "play"?, "margin"})
and prints {"silence": n} per line, the format `mrts_cli sink-margin` reads:
    sink_margin_ref.py cases.jsonl|-
"""
import json
import sys


def consumed_frames(segdone, sps, play_pos=None):
    """The first frame the device can still play: past the segment in flight, or the clock's position."""
    c = (segdone + 1) * sps
    if play_pos is not None and play_pos > c:
        c = play_pos
    return c


def base_write_pos(next_sample, segdone, sps):
    """Where the base sink writes the next buffer's first frame (gst_audio_base_sink_get_offset)."""
    p = 0 if next_sample < 0 else next_sample
    if p // sps < segdone:
        p = (segdone + 1) * sps
    return p


def silence_frames(next_sample, segdone, sps, margin, play_pos=None):
    """Frames of silence before the next buffer: 0 while the write is contiguous and playable."""
    if sps <= 0 or margin < 0:
        return 0
    c = consumed_frames(segdone, sps, play_pos)
    if next_sample >= 0 and next_sample >= c:
        return 0
    want = margin if next_sample >= 0 else 2 * margin   # a start: the device takes its own buffer out of it
    return max(0, c + want - base_write_pos(next_sample, segdone, sps))


class SinkMargin:
    def __init__(self, margin_frames):
        self.margin = max(0, int(margin_frames))
        self.refills = 0
        self.silence_total = 0

    def silence(self, next_sample, segdone, sps, play_pos=None):
        n = silence_frames(next_sample, segdone, sps, self.margin, play_pos) if self.margin else 0
        if n:
            self.refills += 1
            self.silence_total += n
        return n

    def stats(self):
        return {"refills": self.refills, "silence": self.silence_total}


def main(argv):
    if len(argv) != 2:
        print("usage: sink_margin_ref.py cases.jsonl|-", file=sys.stderr)
        return 2
    f = sys.stdin if argv[1] == "-" else open(argv[1])
    for raw in f:
        raw = raw.strip()
        if not raw:
            continue
        c = json.loads(raw)
        n = silence_frames(c["next"], c["segdone"], c["sps"], c["margin"], c.get("play"))
        print(json.dumps({"silence": n}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
