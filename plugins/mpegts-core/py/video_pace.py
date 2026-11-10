#!/usr/bin/env python3
"""The Python reference of mrts::VideoPace (plan ch. 8 part 4.2 and WI-P4-3, ch. 15.4 B-161, B-175):
when each decoded frame leaves `mrvideopace`, and which frames go so that a display slower than the
content keeps up. Built first here (p4-3a; p4-3c the sink's pace); p4-3b ports it to
../native/mrts/video_pace.{h,cpp} with output parity, decision for decision. A reference only:
nothing loads it at runtime (ADR-0029 choice 1, plan OQ-1). video_pace_test.py is its suite, the
list the C++ ports.

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

The sink's back-pressure (p4-3c, B-175). The element passes `held` when a frame waited for its
own previous push to return: its arrival is then the sink's, not the input's. A held frame past
its slot leaves at once but does not move the cadence (r_k stays its slot for the next one) and
is not `late`: the cadence hold is the input's. kmssink holds a push a refresh past its flip, so
a frame behind it comes up to that much late with the display not behind at all; taken as
lateness, each such wait would raise the cadence for good (DEV-P4b on the Pi 5 box's DSI: 50p
decimated to kmssink's 30 fps there still fell 0.25 s behind every second).

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
kept release. While decimating, a held frame past its slot by h, more than a display period
max(T_d, w_k), shows the display h - grid behind its own pace (grid = max(T_d - w_k, 0), kmssink's
own wait): L takes that lag, so it and the frames after it drop until the display is back within
a period (`behind` counts the drops L had not foreseen). A display slower than T_d says stays
live (Q2: skip, resume live).

API:
    pace = VideoPace(gap_threshold_ns=250 ms)
    pace.on_frame(pts_ns, dur_ns, arrival_ns, discont, held=False) -> (release_ns, rate_drop)
    pace.on_gap()                         a GAP event: the next frame's delta collapses
    pace.set_display(period_ns, source)   source in SOURCES; period <= 0 reads as `none`
    pace.set_drain(ppb)                   the drain's rate (B-179), +-5,000,000 at most
    pace.take() -> Summary                counters since construction, mean hold since the last take
The element waits until release_ns and pushes the frame, or drops a rate_drop frame at once
(release_ns is then its slot). Untimed buffers are the element's to pass through unpaced.

The display period (p4-3c, B-175): DisplayRate below gives set_display the period the sink
achieves while it sets the pace, else S12's refresh, else the mode's (the prior).

The drain (B-179, WI-P4-18): set_drain(ppb) runs the cadence on Δ' = Δ·1e9 / (1e9 + δ) wherever the
rules above take a frame's delta or its nominal duration (the slot and the lag; the gap threshold
stays the content's). A display with headroom loses repeats only; one at the content rate
decimates δ of the frames, `drain_drops`: a shadow lag at δ = 0 runs beside the real one, and a drop
it would not make counts there, not in `rate_drops` (a later drop of the shadow's that the real one
does not make pays one back); at δ = 0 the shadow is the real lag. δ < 0 lengthens the slots. Each
frame leaves `last_late_by` (arrival - slot', None unless late) and `last_slack` (slot' - arrival,
None for a first, collapsed or sink-late frame) for the drain servo.

Display period helpers (plan S12): display_period_from_feedback(pairs) from
wp_presentation_feedback.presented samples (presented ns, MSC seq), and
display_period_from_returns(times, prior_ns) for a blocking sink without stats (kmssink: its
show_frame returns at the vblank). Both return (period_ns, short); short while the steps used
span under 60 s.

Run as a script it replays a recorded sequence (the format `mrts_cli pace` reads):
    video_pace.py seq.jsonl|-
one JSON object per line: {"op":"config","gap_threshold":ns} starts a new pace and display rate
(other keys, such as the suite's "case", are labels), {"op":"display","period":ns,"source":s},
{"op":"gap"}, {"op":"drain","ppb":n}, {"op":"frame","pts":ns,"dur":ns,"arrival":ns,"discont":0|1,"held":0|1} ("held"
may be left out: 0), {"op":"take"}, {"op":"feedback","pairs":[[ns,seq],...]},
{"op":"returns","times":[ns,...],"prior":ns}, and the display rate's {"op":"rate_prior",
"period":ns}, {"op":"rate_refresh","period":ns}, {"op":"rate_push","returned":ns,"pressed":0|1},
{"op":"rate_restart"} and {"op":"rate"}.
Out, one compact line per frame, take, feedback, returns and rate (keys in this order):
{"release":ns,"drop":0|1}; {"released":n,"late":n,"rate_drops":n,"gaps_collapsed":n,"behind":n,
"content_period":ns,"display_period":ns,"display_source":s,"mean_hold":ns,"drain_drops":n};
{"period":ns,"short":0|1}; {"rate":ns,"source":s,"achieved":ns}.
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
ACHIEVED_WINDOW_NS = 10 * SEC         # a window of the sink's own pace spans at least this
ACHIEVED_WINDOWS = 5                  # the last windows kept
ACHIEVED_NEED = 3                     # windows before the achieved period counts
HICCUP_DEN = 200                      # a window 0.5 % over the windows' median is a hiccup
RESTART_DEN = 100                     # the refresh or the prior moving 1 % measures again

Summary = namedtuple("Summary", "released late rate_drops gaps_collapsed behind content_period "
                                "display_period display_source mean_hold drain_drops")
DRAIN_MAX_PPB = 5000000               # the drain's clamp (B-179): 0.5 %


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
        self.released = self.late = self.rate_drops = self.gaps_collapsed = self.behind = 0
        self.hold_sum = self.hold_count = 0
        self.drain = 0                        # δ, ppb (B-179)
        self.shadow = 0                       # the lag at δ = 0
        self.owed = 0                         # shadow drops the real lag has not made
        self.drain_drops = 0
        self.last_late_by = None
        self.last_slack = None

    def set_drain(self, ppb):
        self.drain = max(-DRAIN_MAX_PPB, min(DRAIN_MAX_PPB, ppb))

    def _drained(self, d):
        """Δ' = Δ·1e9 / (1e9 + δ), to the nearest ns."""
        if not self.drain or d <= 0:
            return d
        den = SEC + self.drain
        return (2 * d * SEC + den) // (2 * den)

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

    def on_frame(self, pts_ns, dur_ns, arrival_ns, discont, held=False):
        tc = self.content_period()
        nominal = dur_ns if dur_ns > 0 else tc
        threshold = min(self.gap_threshold_ns, 4 * nominal) if nominal > 0 else self.gap_threshold_ns
        collapsed = sink_late = False
        self.last_late_by = self.last_slack = None
        delta0 = 0
        if self.prev_pts is None:
            delta = 0
            slot = arrival_ns
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
            delta0, delta = delta, self._drained(delta)
            slot = self.prev_release + delta
            # Past its slot behind the sink's own push: the sink's wait, not the input's lateness.
            sink_late = held and not collapsed and arrival_ns > slot
            if arrival_ns > slot and not collapsed and not sink_late:
                self.late += 1
                self.last_late_by = arrival_ns - slot
            if not collapsed and not sink_late:
                self.last_slack = slot - arrival_ns
        release = max(arrival_ns, slot)
        drop = behind = sdrop = False
        if not self._decimating(tc):
            self.lag = self.shadow = self.owed = 0
        else:
            if not self.drain:
                self.shadow, self.owed = self.lag, 0
            whole0 = nominal if nominal > 0 else delta0
            whole = self._drained(whole0)
            self.lag = max(self.lag - delta, 0 if collapsed else -whole)
            foreseen = whole > 0 and self.lag >= whole
            grid = max(self.display_period - whole, 0)     # the sink's own wait past a frame
            if sink_late and arrival_ns - slot > grid + whole:
                # A display period behind: the lag is what the sink shows, drop until within one.
                self.lag = max(self.lag, arrival_ns - slot - grid)
                behind = not foreseen
            drop = whole > 0 and self.lag >= whole
            if not drop:
                self.lag += self.display_period
            if self.drain:
                # The shadow: the same frame at δ = 0, the sink's wait as the real lag saw it.
                self.shadow = max(self.shadow - delta0, 0 if collapsed else -whole0)
                grid0 = max(self.display_period - whole0, 0)
                if sink_late and arrival_ns - slot > grid0 + whole0:
                    self.shadow = max(self.shadow, arrival_ns - slot - grid0)
                sdrop = whole0 > 0 and self.shadow >= whole0
                if not sdrop:
                    self.shadow += self.display_period
            else:
                sdrop = drop
                self.shadow = self.lag
        self.prev_pts = pts_ns
        self.prev_release = slot if sink_late else release   # the cadence the next frame follows
        self.gap_pending = False
        if drop and not behind and not sdrop and self.owed == 0:
            self.drain_drops += 1
        elif drop:
            self.rate_drops += 1
            self.behind += behind
            if not behind and not sdrop:
                self.owed -= 1
        elif sdrop:
            self.owed += 1
        if not drop:
            self.released += 1
            self.hold_sum += release - arrival_ns
            self.hold_count += 1
        return release, drop

    def take(self):
        mean_hold = self.hold_sum // self.hold_count if self.hold_count else 0
        self.hold_sum = self.hold_count = 0
        return Summary(self.released, self.late, self.rate_drops, self.gaps_collapsed, self.behind,
                       self.content_period(), self.display_period, self.display_source, mean_hold,
                       self.drain_drops)


def _moved(old, new):
    """`new` more than 1 % off `old`, a period already known."""
    return old > 0 and abs(new - old) * RESTART_DEN > old


class DisplayRate:
    """The display period the decimation uses (p4-3c, B-175): the period of the presentations the
    sink achieves while it sets the pace; until that is measured, S12's refresh (presentation
    feedback, or a blocking sink's returns), else the mode's refresh (the prior, nominal), else
    none. A measurement always wins over the prior.

    The sink sets the pace when a kept frame left at once on the return of the kept push before it
    (`pressed`: it waited for that push, past its slot). The interval between those returns is
    then one presentation of a display that had a frame waiting: 0008's push returns at the
    previous frame's presentation, kmssink's a refresh after its own flip. A display that keeps up,
    or one paced below what it can take, shows the content's own period instead, and every drop
    would lengthen it (the decimation confirming itself): those intervals are not counted.

    A window is a run of consecutive pressed pushes spanning at least 10 s, read as its span over
    its pushes. With 3 of the last 5 windows, the period is the span over the pushes of those within
    0.5 % of the windows' median: one window lengthened by a hiccup does not move the rate, and the
    pooled span averages out one window's quantisation to whole presentations. A caps change
    (restart()), or the refresh or the prior moving more than 1 % (a mode change), measures again."""

    def __init__(self):
        self.prior = 0
        self.refresh = 0
        self.prev_return = None
        self.run_from = 0
        self.run_pushes = 0
        self.windows = deque()                # (span, pushes) of the last ACHIEVED_WINDOWS windows

    def set_prior(self, period_ns):
        period_ns = max(period_ns, 0)
        if _moved(self.prior, period_ns):
            self.restart()
        self.prior = period_ns

    def set_refresh(self, period_ns):
        """S12's measured refresh; 0 (not measured now) leaves the last one."""
        if period_ns <= 0:
            return
        if _moved(self.refresh, period_ns):
            self.restart()
        self.refresh = period_ns

    def restart(self):
        self.windows.clear()
        self.prev_return = None
        self.run_pushes = 0

    def on_push(self, returned_ns, pressed):
        """A kept push returned at returned_ns; pressed: it left at once on the last one's return."""
        if pressed and self.prev_return is not None and returned_ns > self.prev_return:
            if self.run_pushes == 0:
                self.run_from = self.prev_return
            self.run_pushes += 1
            span = returned_ns - self.run_from
            if span >= ACHIEVED_WINDOW_NS:
                self.windows.append((span, self.run_pushes))
                if len(self.windows) > ACHIEVED_WINDOWS:
                    self.windows.popleft()
                self.run_pushes = 0
        else:
            self.run_pushes = 0
        self.prev_return = returned_ns

    def achieved(self):
        """The achieved period, 0 before ACHIEVED_NEED windows."""
        if len(self.windows) < ACHIEVED_NEED:
            return 0
        readings = sorted(_round_div(s, n) for s, n in self.windows)
        median = readings[len(readings) // 2]
        span = pushes = 0
        for s, n in self.windows:
            if _round_div(s, n) * HICCUP_DEN <= median * (HICCUP_DEN + 1):
                span += s
                pushes += n
        return _round_div(span, pushes)

    def period(self):
        """(period_ns, source) for VideoPace.set_display."""
        achieved = self.achieved()
        if achieved:
            return achieved, "measured"
        if self.refresh:
            return self.refresh, "measured"
        if self.prior:
            return self.prior, "nominal"
        return 0, "none"


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
                 "gaps_collapsed": s.gaps_collapsed, "behind": s.behind,
                 "content_period": s.content_period, "display_period": s.display_period,
                 "display_source": s.display_source, "mean_hold": s.mean_hold,
                 "drain_drops": s.drain_drops})


def period_line(period, short):
    return line({"period": period, "short": int(short)})


def rate_line(rate):
    period, source = rate.period()
    return line({"rate": period, "source": source, "achieved": rate.achieved()})


def replay(lines, out):
    """The script's replay: each op of `lines` (JSON text) through a pace and a display rate,
    outputs to `out`."""
    pace, rate = VideoPace(), DisplayRate()
    for text in lines:
        text = text.strip()
        if not text:
            continue
        op = json.loads(text)
        kind = op["op"]
        if kind == "config":
            pace, rate = VideoPace(op.get("gap_threshold", GAP_THRESHOLD_NS)), DisplayRate()
        elif kind == "display":
            pace.set_display(op["period"], op["source"])
        elif kind == "gap":
            pace.on_gap()
        elif kind == "drain":
            pace.set_drain(op["ppb"])
        elif kind == "frame":
            release, drop = pace.on_frame(op["pts"], op["dur"], op["arrival"], bool(op["discont"]),
                                          bool(op.get("held", 0)))
            out.write(frame_line(release, drop) + "\n")
        elif kind == "take":
            out.write(summary_line(pace.take()) + "\n")
        elif kind == "feedback":
            period = display_period_from_feedback([tuple(p) for p in op["pairs"]])
            out.write(period_line(*period) + "\n")
        elif kind == "returns":
            period = display_period_from_returns(op["times"], op.get("prior", 0))
            out.write(period_line(*period) + "\n")
        elif kind == "rate_prior":
            rate.set_prior(op["period"])
        elif kind == "rate_refresh":
            rate.set_refresh(op["period"])
        elif kind == "rate_push":
            rate.on_push(op["returned"], bool(op["pressed"]))
        elif kind == "rate_restart":
            rate.restart()
        elif kind == "rate":
            out.write(rate_line(rate) + "\n")
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
