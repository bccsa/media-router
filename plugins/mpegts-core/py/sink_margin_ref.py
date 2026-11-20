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
GstAudioSink's thread is handing to the device, which it then clears: lost (pulsesink: the server
drops writes behind its read index; see the guard). A queue's min-threshold before the sink holds delay, not margin: it releases as it is fed.

Rule. Before each buffer reaches the sink's render, `consumed` is the first sample the device can
still play: the end of the segment in flight, (segdone + 1) x samples_per_seg, or the device clock's
position plus the guard if that is further. If the next write is at or past it, nothing: the buffer
plays contiguously, however small the margin left. Otherwise (the ring ran dry: a hole is already
playing; or the first write after a start or a flush) the buffer is prefixed with silence so its
first sample lands `margin` frames past `consumed`: the hole grows by at most the margin, no sample
is written where it cannot play, and from there a feed may get up to `margin` later again without a
hole. The silence starts where the base sink will write, which is segdone + 1 when it realigns.
Delay never shrinks (nothing is dropped); it grows only at a hole. The first write after a start or
a flush lands the margin plus the larger of the margin and the guard past `consumed`: a device that
starts takes its own buffer out of it at once (the test sink's 40 ms, pulsesink's server its
read-ahead). After a flush the clock is read once the sink has rendered (fix round 1). The silence
starts where the base sink writes, which after a flush on a pulsesink whose segdone is still (1.22)
is frame 0, so it would span the stream's run (10 and 20 s at flushes 10 and 20 s in, measured);
moving next_sample past it instead (tried) left the stream silent after a flush in 4 of 16 runs on
the dev Pi. On the image's pulsesink (1.28) segdone follows the read index: at most its staleness
(1.5 s). A refill is capped at REFILL_MAX_MS (fix round 2): a longer gap is crossed by several
writes, each capped, the ones still behind the read index dropped by the server, so a refill never
allocates more than the cap however long the stream ran.

The guard (c39 review, blocking 1). A GstAudioSink hands each segment to the device itself, so its
segdone is the device's read: guard 0. pulsesink's ring is a server's stream: the server reads ahead
of the clock (pa_stream_get_time: its read index less the sink's latency, interpolated between timing
updates) and drops a write behind its read index, while pulsesink's segdone stays 0 (1.22) or
follows the read index only at timing updates (1.28; 1.5 s apart on the dev Pi). Measured on the dev
Pi's PipeWire null sink (module tail into pulsesink, 2026-11-16): the server reads a graph quantum
at a time (512 frames with the test's 10 ms monitor, 1024 with a 40 ms one or none: the smallest
node latency of its clients, so it moves at run time; a forced quantum overrides it, as the Device
Manager's 2048-frame buffer does), and writes 6-12 ms ahead of the clock were lost at 512 with no
refill. The guard is the sum of two bounds:
  - the quantum's: the server's configured latency for the stream, tlength less two minreq (pulse's
    ADJUST_LATENCY split, pipewire-pulse's node.latency, the quantum the stream asks for: 40 ms for
    the module's buffer-time 100 ms, 1920 frames), read from the ring once acquired. A forced
    quantum can pass it (2048 frames: 2.7 ms past; the c39 re-review's edge runs there lost
    nothing, its writer stalls did: B-249's Limits);
  - the sink's latency, learned where segdone moves (1.28): the largest segdone x sps less the
    clock's position, less one segment (segdone is the read index's ceiling); 0 where it does not.
The clock's own forward steps at timing updates (up to 5 ms at quantum 512, 27 ms at 1024: how far
it had fallen behind the read index) fit inside the quantum's bound and are not added. The learned
term only grows; the sum is capped at GUARD_MAX_MS.

The guard holds a write only while the stream may have run dry (guard_applies). The server holds
only tlength, so a backpressured sink writes at most tlength ahead of the read index: on the dev Pi
47 ms or more ahead of the clock, 60 at the median. A guard past that, applied to every write, calls
each one unplayable and refills without end (measured: a guard of 85-93 ms refilled every 100 ms and
played 12 % of the feed); in the model a 40 ms guard does it at quantum 1024. A write cannot be
behind the read index when the stream was full at the write before: when its buffer waited in the
queue before the sink (the sink was blocked: residence of a segment or more; a stalled queue thread
reads the same, so the write after the stall is unguarded: B-249's Limits), or the
push before it blocked in the sink and this write follows it within a segment (no queue between:
the Audio Decoder). The push is the sink's own time on it, measured in the thread that pushes into
the sink; a push that blocked before an outage says nothing about the write after it (fix round 2:
counted however long ago, it dropped that write's head on the Audio Decoder).

The clock is not read for a write the stream was full at (c41, B-249's D4 and MR-059). On the Pi 4
at load the server at times takes nothing for about 0.3 s (313-368 ms measured): the push blocks while
libpulse's clock runs on at house rate, so the next write reads 196-245 ms behind a clock that has
passed the read index (segdone at the next update: 268 ms short of it), and every write after it
reads behind again until a timing update (1.5 s apart) corrects the clock: a refill each write, the
heard storm, seconds of delay. A write right after a push that blocked (stream_full) is held to
segdone, the server's own read index, alone: within two segments of it, since a full stream holds
tlength, two minreq past the server's configured latency (the Audio Decoder's thread resamples
and pushes its next buffer 10-15 ms after its push at load; one segment read the clock there). The push before a write from a queue's thread (the
302M's outq) is read from that thread's gaps (queued_push): when the write's buffer waited through
the whole gap since the thread's last write, the time the thread slept in that gap (the gap less its
time on and waiting for a CPU) was the push, blocked in the sink; a writer held up on the CPU while
the stream ran dry is not a full stream. A writer asleep anywhere else with its buffer waiting would
read as a full sink: the device check's writer-stall stand-in spins for that reason.

API:
    m = SinkMargin(margin_frames, cap_frames)    cap: REFILL_MAX_MS in frames (0: none)
    m.silence(next_sample, segdone, sps, play_pos=None, guard=0) -> frames of silence to put first
        next_sample: the base sink's next write (-1: none yet), segdone: segments read since
        segbase, sps: samples per segment, play_pos: the device clock's position in the same
        frames, or None when it must not be read (before the first render: pulsesink dies of it),
        guard: SinkGuard.frames() for a sink that is not a GstAudioSink, else 0
    m.stats() -> {"refills", "silence"}
    g = SinkGuard(base_frames, cap_frames)    base: server_latency_frames(buffer, sps)
    g.segdone_seen(segdone, sps, play_pos); g.frames() -> the guard
    guard_applies(residence_ns, push_ns, since_push_ns, seg_ns) -> whether the guard holds this write
    stream_full(push_ns, since_push_ns, seg_ns) -> whether the write is held to segdone alone (play_pos None)
    queued_push(gap_ns, residence_ns, busy_ns) -> (push_ns, since_push_ns) from a queue thread's gaps
Run as a script it reads one JSON object per line and prints one per line, the format `mrts_cli
sink-margin` reads: {"next", "segdone", "sps", "play"?, "margin", "guard"?, "cap"?} -> {"silence": n},
the guard's events {"base", "cap"} (a new guard), {"seg", "sps", "play"} -> {"guard": n}, and
{"res", "push", "since", "segns"} -> {"applies": 0|1}, {"push", "since", "segns"} -> {"full": 0|1} and
{"gap", "res", "busy"} -> {"push", "since"}:
    sink_margin_ref.py cases.jsonl|-
"""
import json
import sys


GUARD_MAX_MS = 500
REFILL_MAX_MS = 3000          # a refill's silence at most (twice the 1.5 s a 1.28 pulsesink's segdone lags)


def consumed_frames(segdone, sps, play_pos=None, guard=0):
    """The first frame the device can still play: past the segment in flight, or the clock's position plus the guard."""
    c = (segdone + 1) * sps
    if play_pos is not None and play_pos + guard > c:
        c = play_pos + guard
    return c


def base_write_pos(next_sample, segdone, sps):
    """Where the base sink writes the next buffer's first frame (gst_audio_base_sink_get_offset)."""
    p = 0 if next_sample < 0 else next_sample
    if p // sps < segdone:
        p = (segdone + 1) * sps
    return p


def silence_frames(next_sample, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """Frames of silence before the next buffer: 0 while the write is contiguous and playable; at most
    `cap` (> 0), the rest left to the writes after it."""
    if sps <= 0 or margin < 0:
        return 0
    guard = max(0, guard)
    c = consumed_frames(segdone, sps, play_pos, guard)
    if next_sample >= 0 and next_sample >= c:
        return 0
    # A start or a flush: the device (a server: its read-ahead) takes its own buffer out of it.
    want = margin if next_sample >= 0 else margin + max(margin, guard)
    n = max(0, c + want - base_write_pos(next_sample, segdone, sps))
    return min(n, cap) if cap > 0 else n


def server_latency_frames(buffer_frames, sps):
    """A pulse server's configured latency for a stream of tlength `buffer_frames`, minreq `sps`."""
    return max(0, buffer_frames - 2 * sps)


BLOCKED_NS = 2_000_000        # a push that took this long waited in the sink: the stream was full


def guard_applies(residence_ns, push_ns, since_push_ns, seg_ns):
    """The guard holds a write unless the stream was full at the write before: its buffer waited a
    segment or more in the queue before the sink, or the push before it blocked in the sink and
    ended less than a segment before this write."""
    return residence_ns < seg_ns and not (push_ns >= BLOCKED_NS and since_push_ns < seg_ns)


FULL_SEGS = 2                 # a full stream holds tlength: two minreq past the server's configured latency


def stream_full(push_ns, since_push_ns, seg_ns):
    """The push before this write blocked in the sink and ended less than FULL_SEGS segments before it: the server
    holds what it was given, so the write is not behind its read index whatever the clock reads (c41)."""
    return push_ns >= BLOCKED_NS and since_push_ns < FULL_SEGS * seg_ns


def queued_push(gap_ns, residence_ns, busy_ns):
    """The push before a write from a queue's thread, from that thread's gap since its last write: when the
    write's buffer waited in the queue through the whole gap, the thread slept only in the sink, so the gap less
    its time on and waiting for a CPU (busy) was that push, and it ended at most `busy` ago. Else (the thread
    waited for data, or busy is unknown: < 0) nothing: (0, gap)."""
    if gap_ns <= 0 or residence_ns < gap_ns or busy_ns < 0:
        return 0, max(0, gap_ns)
    return max(0, gap_ns - busy_ns), busy_ns


class SinkGuard:
    """How far ahead of the device clock a server may already have read (none for a GstAudioSink)."""

    def __init__(self, base_frames=0, cap_frames=0):
        self.base = max(0, int(base_frames))
        self.cap = max(0, int(cap_frames))
        self.sink_lat = 0

    def segdone_seen(self, segdone, sps, play_pos):
        """segdone (the read index's ceiling at the last timing update) against the clock now."""
        if segdone > 0 and sps > 0 and play_pos is not None and play_pos >= 0:
            self.sink_lat = max(self.sink_lat, (segdone - 1) * sps - play_pos)

    def frames(self):
        return min(self.cap, self.base + self.sink_lat)


class SinkMargin:
    def __init__(self, margin_frames, cap_frames=0):
        self.margin = max(0, int(margin_frames))
        self.cap = max(0, int(cap_frames))
        self.refills = 0
        self.silence_total = 0

    def silence(self, next_sample, segdone, sps, play_pos=None, guard=0):
        n = silence_frames(next_sample, segdone, sps, self.margin, play_pos, guard, self.cap) if self.margin else 0
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
    g = SinkGuard()
    for raw in f:
        raw = raw.strip()
        if not raw:
            continue
        c = json.loads(raw)
        if "next" in c:
            n = silence_frames(c["next"], c["segdone"], c["sps"], c["margin"], c.get("play"), c.get("guard", 0),
                               c.get("cap", 0))
            print(json.dumps({"silence": n}, separators=(",", ":")))
            continue
        if "gap" in c:
            push, since = queued_push(c["gap"], c["res"], c["busy"])
            print(json.dumps({"push": push, "since": since}, separators=(",", ":")))
            continue
        if "res" in c:
            a = guard_applies(c["res"], c["push"], c["since"], c["segns"])
            print(json.dumps({"applies": int(a)}, separators=(",", ":")))
            continue
        if "push" in c:
            print(json.dumps({"full": int(stream_full(c["push"], c["since"], c["segns"]))}, separators=(",", ":")))
            continue
        if "base" in c:
            g = SinkGuard(c["base"], c["cap"])
        else:
            g.segdone_seen(c["seg"], c["sps"], c["play"])
        print(json.dumps({"guard": g.frames()}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
