#!/usr/bin/env python3
"""The Python reference of mrts::VideoPace (plan ch. 8 part 4.2 and WI-P4-3, ch. 15.4 B-161): when
each decoded frame leaves `mrvideopace`, and which frames go so that a display slower than the
content keeps up. Built first here (p4-3a); p4-3b ports it to ../native/mrts/video_pace.{h,cpp}
with output parity, decision for decision. A reference only: nothing loads it at runtime
(ADR-0029 choice 1, plan OQ-1). video_pace_test.py is its suite, the list p4-3b ports.

Arrivals and releases are the element clock's ns (house time, base time 0): the arrival is
the clock when the frame enters. PTS are only differenced, in ns as Phase 3's formula demux
gives them, unwrapped, so the 33-bit wrap does not exist here. Integer arithmetic throughout,
so the C++ agrees exactly.

Cadence. Frame k has PTS p_k, arrival a_k and nominal duration n_k: `dur_ns` when > 0 (the
buffer's duration, else the caps' frame period, as the element gives it), else the content
period T_c below, else 0. The gap threshold is g_k = min(gap_threshold_ns, 4 n_k)
(gap_threshold_ns alone while n_k is 0). Δ_k = p_k - p_(k-1) when 0 < Δ_k <= g_k and neither a
GAP nor a DISCONT came since frame k-1: a clean delta. Otherwise Δ_k = n_k: a GAP, a DISCONT,
a step back or a step past g_k is collapsed (`gaps_collapsed`), so the backlog drains into the
gap; a repeated PTS (Δ = 0: a decoder holding a decreasing PTS, B-160 F7) takes n_k uncounted.
    r_0 = a_0,   r_k = max(a_k, r_(k-1) + Δ_k)
A frame is never released before it arrives nor faster than the content's own cadence (the
cadence hold, plan ch. 13.6: after a stall the backlog plays at content rate and lateness stays
raised until a gap). A frame not collapsed with a_k > r_(k-1) + Δ_k counts `late`: its lateness
stepped up there. A collapsed frame released at its arrival is a fall, not a step, so it is not.

Content period. T_c is the median (index n // 2 of the sorted values) of the last 120 clean
deltas, 0 before the first; T_c at frame k is that of the deltas before it. It is reported, it is
n_k's fallback and the nominal band's reference; the accumulator does not use it (below).

Rate match. set_display gives the display period T_d and its source: `measured` (presentation
feedback or a blocking sink's returns, the helpers below), `nominal` (the mode's refresh) or
`none`. Decimation runs on `measured` always (no dead band: a Pi's pixel clock is not the house
clock), on `nominal` only while 2000 (T_d - T_c) > T_c (0.05 %), never on `none`; while it does
not run the accumulator is 0. The accumulator L is the display's lag behind the content in ns:
    L = max(L - Δ_k, -w_k)           the content advanced Δ_k; a display ahead banks one frame
                                     (0 for a collapsed frame: the content restarts, no credit)
    drop if L >= w_k > 0             still a whole frame behind: this one could only be replaced
    else keep, L += T_d
w_k is n_k (Δ_k while n_k is 0). With every Δ_k and n_k equal to T_c and T_d > T_c this is
the plan's (T_d - T_c) / T_c per kept frame, a drop each time it reaches 1. Each frame's own
delta keeps a source's clock, which the median of 90 kHz deltas loses; the window of one frame
either side, measured by n_k, lets PTS jittered by up to half a frame drop nothing and lose no
deficit, and a display faster than the content banks no more than a frame (B-161). It reads
content time only, never a release: a blocking sink feeds its own slowness into the releases.
A dropped frame keeps its slot in the cadence (r_k advances through it), so a drop never moves a
kept release.

API:
    pace = VideoPace(gap_threshold_ns=250 ms)
    pace.on_frame(pts_ns, dur_ns, arrival_ns, discont) -> (release_ns, rate_drop)
    pace.on_gap()                         a GAP event: the next frame's delta collapses
    pace.set_display(period_ns, source)   source in SOURCES; period <= 0 reads as `none`
    pace.take() -> Summary                counters since construction, mean hold since the last take
The element waits until release_ns and pushes the frame, or drops a rate_drop frame at once
(release_ns is then its slot). Untimed buffers are the element's to pass through unpaced.

Display period helpers (plan S12): display_period_from_feedback(pairs) from
wp_presentation_feedback.presented samples (presented ns, MSC seq), and
display_period_from_returns(times, prior_ns) for a blocking sink without stats (kmssink: its
show_frame returns at the vblank). Both return (period_ns, short); short while the steps used
span under 60 s.

Run as a script it replays a recorded sequence (the format p4-3b's `mrts_cli pace` reads):
    video_pace.py seq.jsonl|-
one JSON object per line: {"op":"config","gap_threshold":ns} starts a new pace (other keys,
such as the suite's "case", are labels), {"op":"display","period":ns,"source":s}, {"op":"gap"},
{"op":"frame","pts":ns,"dur":ns,"arrival":ns,"discont":0|1}, {"op":"take"},
{"op":"feedback","pairs":[[ns,seq],...]}, {"op":"returns","times":[ns,...],"prior":ns}.
Out, one compact line per frame, take, feedback and returns (keys in this order):
{"release":ns,"drop":0|1}; {"released":n,"late":n,"rate_drops":n,"gaps_collapsed":n,
"content_period":ns,"display_period":ns,"display_source":s,"mean_hold":ns};
{"period":ns,"short":0|1}.
"""
import bisect
import json
import sys
from collections import deque, namedtuple

SEC = 1000000000
MS = 1000000
GAP_THRESHOLD_NS = 250 * MS
PERIOD_WINDOW = 120                   # clean deltas in the content period's median
NOMINAL_BAND_DEN = 2000               # the 0.05 % band on a nominal refresh
MIN_SPAN_NS = 60 * SEC                # a display period from less is flagged short
STEP_TOLERANCE_DEN = 10               # 10 %: a step or interval near its refresh multiple
SOURCES = ("none", "nominal", "measured")

Summary = namedtuple("Summary", "released late rate_drops gaps_collapsed content_period "
                                "display_period display_source mean_hold")


class VideoPace:
    def __init__(self, gap_threshold_ns=GAP_THRESHOLD_NS):
        self.gap_threshold_ns = gap_threshold_ns
        self.prev_pts = None                  # the previous frame's PTS, kept or dropped
        self.prev_release = 0
        self.gap_pending = False
        self.window = deque()                 # the last PERIOD_WINDOW clean deltas, in order
        self.ordered = []                     # the same, sorted
        self.display_period = 0
        self.display_source = "none"
        self.lag = 0                          # L: the display's lag behind the content, ns
        self.released = self.late = self.rate_drops = self.gaps_collapsed = 0
        self.hold_sum = self.hold_count = 0

    def set_display(self, period_ns, source):
        if source not in SOURCES:
            raise ValueError("display source must be one of %s, not %r" % (SOURCES, source))
        if period_ns <= 0 or source == "none":
            period_ns, source = 0, "none"
        self.display_period, self.display_source = period_ns, source

    def on_gap(self):
        self.gap_pending = True

    def content_period(self):
        return self.ordered[len(self.ordered) // 2] if self.ordered else 0

    def _add_clean(self, delta):
        self.window.append(delta)
        bisect.insort(self.ordered, delta)
        if len(self.window) > PERIOD_WINDOW:
            del self.ordered[bisect.bisect_left(self.ordered, self.window.popleft())]

    def _decimating(self, tc):
        td = self.display_period
        if self.display_source == "measured":
            return True
        return self.display_source == "nominal" and tc > 0 and (td - tc) * NOMINAL_BAND_DEN > tc

    def on_frame(self, pts_ns, dur_ns, arrival_ns, discont):
        tc = self.content_period()
        nominal = dur_ns if dur_ns > 0 else tc
        threshold = min(self.gap_threshold_ns, 4 * nominal) if nominal > 0 else self.gap_threshold_ns
        collapsed = False
        if self.prev_pts is None:
            delta = 0
            release = arrival_ns
        else:
            d = pts_ns - self.prev_pts
            collapsed = self.gap_pending or discont or d < 0 or d > threshold
            if collapsed:
                delta = nominal
                self.gaps_collapsed += 1
            elif d == 0:
                delta = nominal
            else:
                delta = d
                self._add_clean(d)
            slot = self.prev_release + delta
            release = max(arrival_ns, slot)
            if arrival_ns > slot and not collapsed:
                self.late += 1
        drop = False
        if not self._decimating(tc):
            self.lag = 0
        else:
            whole = nominal if nominal > 0 else delta
            self.lag = max(self.lag - delta, 0 if collapsed else -whole)
            drop = whole > 0 and self.lag >= whole
            if not drop:
                self.lag += self.display_period
        self.prev_pts = pts_ns
        self.prev_release = release
        self.gap_pending = False
        if drop:
            self.rate_drops += 1
        else:
            self.released += 1
            self.hold_sum += release - arrival_ns
            self.hold_count += 1
        return release, drop

    def take(self):
        mean_hold = self.hold_sum // self.hold_count if self.hold_count else 0
        self.hold_sum = self.hold_count = 0
        return Summary(self.released, self.late, self.rate_drops, self.gaps_collapsed,
                       self.content_period(), self.display_period, self.display_source, mean_hold)


def _round_div(num, den):
    """num / den to the nearest integer, halves up (num >= 0, den > 0)."""
    return (2 * num + den) // (2 * den)


def display_period_from_feedback(pairs):
    """(period_ns, short) from wp_presentation_feedback.presented samples [(presented_ns, seq)],
    oldest first: Δt/Δseq summed over the steps between consecutive samples whose own Δt/Δseq is
    within 10 % of the median step's. A frame shown for one refresh or two is one step of Δseq 1
    or 2, so this is the refresh even when the content is slower (50p on 60 Hz), where presented
    time deltas give the content's period. A step across an output switched off whose MSC stood
    still, a seq reset or a step back are left out. (0, True) without a step."""
    steps = [(t1 - t0, s1 - s0) for (t0, s0), (t1, s1) in zip(pairs, pairs[1:])
             if t1 > t0 and s1 > s0]
    if not steps:
        return 0, True
    median = sorted(dt // ds for dt, ds in steps)[len(steps) // 2]
    t_sum = s_sum = 0
    for dt, ds in steps:
        if abs(dt - ds * median) * STEP_TOLERANCE_DEN <= ds * median:
            t_sum += dt
            s_sum += ds
    if s_sum == 0:
        return 0, True
    return _round_div(t_sum, s_sum), t_sum < MIN_SPAN_NS


def display_period_from_returns(times, prior_ns=0):
    """(period_ns, short) of a blocking sink without stats from the times its pushes returned,
    oldest first. Each interval is a whole number of refreshes, round(interval / base): base is
    prior_ns (the mode's refresh) when given and any interval lies within 10 % of a multiple of
    it, else the mean of the intervals within 10 % of the smallest. Intervals off every multiple
    by more than 10 % of the base are left out; the period is their sum over their refreshes,
    so the span, not one interval, sets the precision. Without a prior, content slower than half
    the refresh (every interval two refreshes or more) reads as a multiple of it."""
    ivs = [b - a for a, b in zip(times, times[1:]) if b > a]
    if not ivs:
        return 0, True

    def fit(base):
        t_sum = n_sum = 0
        for iv in ivs:
            n = _round_div(iv, base)
            if n >= 1 and abs(iv - n * base) * STEP_TOLERANCE_DEN <= base:
                t_sum += iv
                n_sum += n
        return t_sum, n_sum

    t_sum = n_sum = 0
    if prior_ns > 0:
        t_sum, n_sum = fit(prior_ns)
    if n_sum == 0:
        smallest = min(ivs)
        near = [iv for iv in ivs if (iv - smallest) * STEP_TOLERANCE_DEN <= smallest]
        t_sum, n_sum = fit(sum(near) // len(near))
    return _round_div(t_sum, n_sum), t_sum < MIN_SPAN_NS


def line(obj):
    """One line of the replay format: compact JSON, keys in the order given."""
    return json.dumps(obj, separators=(",", ":"))


def frame_line(release, drop):
    return line({"release": release, "drop": int(drop)})


def summary_line(s):
    return line({"released": s.released, "late": s.late, "rate_drops": s.rate_drops,
                 "gaps_collapsed": s.gaps_collapsed, "content_period": s.content_period,
                 "display_period": s.display_period, "display_source": s.display_source,
                 "mean_hold": s.mean_hold})


def period_line(period, short):
    return line({"period": period, "short": int(short)})


def replay(lines, out):
    """The script's replay: each op of `lines` (JSON text) through a pace, outputs to `out`."""
    pace = VideoPace()
    for text in lines:
        text = text.strip()
        if not text:
            continue
        op = json.loads(text)
        kind = op["op"]
        if kind == "config":
            pace = VideoPace(op.get("gap_threshold", GAP_THRESHOLD_NS))
        elif kind == "display":
            pace.set_display(op["period"], op["source"])
        elif kind == "gap":
            pace.on_gap()
        elif kind == "frame":
            release, drop = pace.on_frame(op["pts"], op["dur"], op["arrival"], bool(op["discont"]))
            out.write(frame_line(release, drop) + "\n")
        elif kind == "take":
            out.write(summary_line(pace.take()) + "\n")
        elif kind == "feedback":
            period = display_period_from_feedback([tuple(p) for p in op["pairs"]])
            out.write(period_line(*period) + "\n")
        elif kind == "returns":
            period = display_period_from_returns(op["times"], op.get("prior", 0))
            out.write(period_line(*period) + "\n")
        else:
            raise ValueError("unknown op %r" % kind)


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: video_pace.py seq.jsonl|-\n")
        return 2
    src = sys.stdin if argv[1] == "-" else open(argv[1])
    with src:
        replay(src, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
