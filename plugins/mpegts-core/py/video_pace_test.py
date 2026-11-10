#!/usr/bin/env python3
"""video_pace.py's suite (plan ch. 15.4 B-161, B-175): the cases the C++ ports one for one to
../native/mrts/tests/video_pace_test.cpp, same names, same order (the last, the replay format,
is the reference's own). The sequences are built here, deterministically; no fixture file. The
element's streaming thread and the sink are modelled (`drive`, `drive_rate`, `Wayland`, `Kms`,
`Capped`, `KmsWait`), since a display slower than the content shows only through its
back-pressure on the releases.

With VIDEO_PACE_TRACE=<file> every call of every case is recorded there in video_pace.py's
replay format, a config line per case, for p4-3b's parity test.

Run:  python3 video_pace_test.py              the suite
      python3 video_pace_test.py --case N     case N alone
      python3 video_pace_test.py --mutants    each mutant below must fail its case
"""
import io
import os
import shutil
import subprocess
import sys
import tempfile

import video_pace as vp

SEC = vp.SEC
MS = vp.MS
US = 1000
P50 = 20 * MS                                    # 50p
P60 = 16666667                                   # 60p
LATENCY = 100 * MS                               # the input's lateness at the element
SLOW = 20000800                                  # a 50 Hz display 40 ppm slow
DSI = 16656184                                   # the Pi 5 box's DSI panel, 60.038 Hz (DEV-P4b)
WRAP_NS = (1 << 33) * 100000 // 9                # the 33-bit point in house ns

_failures = 0
_trace = None


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


class Recorded(vp.VideoPace):
    """A pace that writes each call to `sink` in the replay format, and each output to `outputs`
    as the script prints it."""

    def __init__(self, sink, outputs, case, gap_threshold_ns=vp.GAP_THRESHOLD_NS):
        super().__init__(gap_threshold_ns)
        self.sink, self.outputs = sink, outputs
        sink.write(vp.line({"op": "config", "case": case, "gap_threshold": gap_threshold_ns}) + "\n")

    def set_display(self, period_ns, source):
        self.sink.write(vp.line({"op": "display", "period": period_ns, "source": source}) + "\n")
        super().set_display(period_ns, source)

    def on_gap(self):
        self.sink.write('{"op":"gap"}\n')
        super().on_gap()

    def set_drain(self, ppb):
        self.sink.write(vp.line({"op": "drain", "ppb": ppb}) + "\n")
        super().set_drain(ppb)

    def on_frame(self, pts_ns, dur_ns, arrival_ns, discont, held=False):
        self.sink.write(vp.line({"op": "frame", "pts": pts_ns, "dur": dur_ns, "arrival": arrival_ns,
                                  "discont": int(discont), "held": int(held)}) + "\n")
        release, drop = super().on_frame(pts_ns, dur_ns, arrival_ns, discont, held)
        if self.outputs is not None:
            self.outputs.append(vp.frame_line(release, drop))
        return release, drop

    def take(self):
        self.sink.write('{"op":"take"}\n')
        s = super().take()
        if self.outputs is not None:
            self.outputs.append(vp.summary_line(s))
        return s


def new_pace(case, gap_threshold_ns=vp.GAP_THRESHOLD_NS):
    global _trace
    path = os.environ.get("VIDEO_PACE_TRACE")
    if not path:
        return vp.VideoPace(gap_threshold_ns)
    if _trace is None:
        _trace = open(path, "w")
    return Recorded(_trace, None, case, gap_threshold_ns)


class RecordedRate(vp.DisplayRate):
    """A display rate that writes each call to `sink` after its pace's config line (which starts
    a new rate too), and each period it gives to `outputs`."""

    def __init__(self, sink, outputs):
        super().__init__()
        self.sink, self.outputs = sink, outputs

    def set_prior(self, period_ns):
        self.sink.write(vp.line({"op": "rate_prior", "period": period_ns}) + "\n")
        super().set_prior(period_ns)

    def set_refresh(self, period_ns):
        self.sink.write(vp.line({"op": "rate_refresh", "period": period_ns}) + "\n")
        super().set_refresh(period_ns)

    def restart(self):
        self.sink.write('{"op":"rate_restart"}\n')
        super().restart()

    def on_push(self, returned_ns, pressed):
        self.sink.write(vp.line({"op": "rate_push", "returned": returned_ns,
                                  "pressed": int(pressed)}) + "\n")
        super().on_push(returned_ns, pressed)

    def period(self):
        self.sink.write('{"op":"rate"}\n')
        if self.outputs is not None:
            self.outputs.append(vp.line({"rate": super().period()[0], "source": super().period()[1],
                                         "achieved": self.achieved()}))
        return super().period()


def new_rate(pace):
    """The display rate beside `pace`, recorded into the same trace when the pace is."""
    if isinstance(pace, Recorded):
        return RecordedRate(pace.sink, pace.outputs)
    return vp.DisplayRate()


class Wayland:
    """waylandsink present-every-frame=true (Yocto 0008) on a compositor refreshing every `period`
    ns from `phase`: a frame pushed while the previous commit's frame callback is pending waits
    for it, is committed, and the push returns; a commit is presented at the first refresh after
    it, where its callback fires."""

    def __init__(self, period, phase=0):
        self.period, self.phase, self.callback = period, phase, None

    def refresh_after(self, t):
        return self.phase + ((t - self.phase) // self.period + 1) * self.period

    def push(self, t):
        commit = t if self.callback is None or t >= self.callback else self.callback
        self.callback = self.refresh_after(commit)
        return commit, self.callback


class Kms(Wayland):
    """kmssink sync=false: show_frame flips at the first vblank after the push and returns then."""

    def push(self, t):
        shown = self.refresh_after(t)
        return shown, shown


class Capped(Wayland):
    """Wayland on a compositor that presents at most `cap_mhz` frames a second (in mHz): refresh n
    can show a new frame only when the count floor(n x period x cap / 10^12) steps there, so a
    frame committed before a refresh that cannot waits for the next one (Weston on the Pi 5 box's
    DSI with HEVC 1080p60: about 56.6 fps on a 60.038 Hz panel, DEV-P4b)."""

    def __init__(self, period, phase, cap_mhz):
        super().__init__(period, phase)
        self.cap = cap_mhz

    def usable(self, n):
        k = self.period * self.cap
        return (n + 1) * k // 10 ** 12 > n * k // 10 ** 12

    def refresh_after(self, t):
        n = (t - self.phase) // self.period + 1
        while not self.usable(n):
            n += 1
        return self.phase + n * self.period


class KmsWait(Kms):
    """kmssink as DEV-P4a and DEV-P4b measured it on both boxes: the flip at the first vblank after
    the push, and the return at the vblank after that (drmWaitVBlank), so it shows at most one
    frame per two refreshes."""

    def push(self, t):
        shown = self.refresh_after(t)
        return shown + self.period, shown


def drive(pace, frames, display=None):
    """mrvideopace's streaming thread over `frames`, [(pts, dur, ready, discont, gap)]: a frame
    enters when it is ready (out of the decoder) and the previous push has returned, `held` when
    it waited for that push; a kept frame is pushed at its release, a dropped one frees the thread
    at once. Returns [(pts, arrival, release, drop, shown)]: shown is the presentation, the push's
    return without a display (a fakesink), None for a dropped frame."""
    out = []
    free = None
    for pts, dur, ready, discont, gap in frames:
        if gap:
            pace.on_gap()
        held = free is not None and ready < free
        arrival = free if held else ready
        release, drop = pace.on_frame(pts, dur, arrival, discont, held)
        if drop:
            free, shown = arrival, None
        elif display is None:
            free = shown = release
        else:
            free, shown = display.push(release)
        out.append((pts, arrival, release, drop, shown))
    return out


def s12_refresh(display, returns, prior):
    """S12's refresh as the element reads it once a second (B-162): 0008's from its presentation
    feedback (the model's refresh, once a frame has gone), else the last 4,096 returns counted in
    the prior or, without one, in their 25th-percentile interval (F2); 0 before that."""
    if not returns:
        return 0
    if not isinstance(display, Kms):
        return display.period
    times = returns[-4096:]
    ivs = sorted(b - a for a, b in zip(times, times[1:]) if b > a)
    if not ivs:
        return 0
    return vp.display_period_from_returns(times, prior if prior > 0 else ivs[len(ivs) // 4])[0]


def drive_rate(pace, rate, frames, display, prior=0):
    """drive with mrvideopace's display rate (p4-3c): at the first frame and then once a second of
    arrivals the rate takes the prior (refresh-mhz) and S12's refresh and the pace the rate's
    period; every kept push's return goes to the rate, pressed when the frame left at once on the
    last push's return. Returns drive's records."""
    out, returns = [], []
    free = update = None
    for pts, dur, ready, discont, gap in frames:
        if gap:
            pace.on_gap()
        held = free is not None and ready < free
        arrival = free if held else ready
        if update is None or arrival >= update:
            rate.set_prior(prior)
            rate.set_refresh(s12_refresh(display, returns, prior))
            pace.set_display(*rate.period())
            update = arrival + SEC
        release, drop = pace.on_frame(pts, dur, arrival, discont, held)
        if drop:
            free, shown = arrival, None
        else:
            free, shown = display.push(release)
            returns.append(free)
            rate.on_push(free, held and release == arrival)
        out.append((pts, arrival, release, drop, shown))
    return out


def cadence(n, num, den, start=0):
    """n PTS at num/den fps from `start`, floored to ns as the demux floors 90 kHz ticks."""
    return [start + k * den * SEC // num for k in range(n)]


def live(pts, dur, latency=LATENCY):
    """Frames ready `latency` after their PTS, no flags."""
    return [(p, dur, p + latency, False, False) for p in pts]


def kept(rec):
    return [r for r in rec if not r[3]]


def drop_indices(rec):
    return [i for i, r in enumerate(rec) if r[3]]


def spacings(idx):
    return [b - a for a, b in zip(idx, idx[1:])]


def release_lateness(rec):
    return [r[2] - r[0] for r in rec if not r[3]]


def shown_lateness(rec):
    return [r[4] - r[0] for r in rec if not r[3]]


def spread(values):
    return max(values) - min(values)


def expected_drops(rec, period):
    """The display's deficit over `rec` in frames: the display time all of them would take less
    the content time they span, over one refresh."""
    n = len(rec)
    return ((n - 1) * period - (rec[-1][0] - rec[0][0])) / period


# --- 1 to 6: the rate match -----------------------------------------------------------------

def test_50p_on_60hz():
    pace = new_pace("50p-on-60hz")
    pace.set_display(16666667, "measured")
    rec = drive(pace, live(cadence(500, 50, 1), P50), Wayland(16666667, 3700 * US))
    k = kept(rec)
    check("1 50p on a measured 60 Hz: 0 drops", len(k) == 500 and pace.take().rate_drops == 0)
    check("1 50p on a measured 60 Hz: releases on the content cadence to 1 us",
          all(abs((b[2] - a[2]) - (b[0] - a[0])) <= US for a, b in zip(k, k[1:])))
    check("1 50p on a measured 60 Hz: every frame released at its input lateness",
          set(release_lateness(rec)) == {LATENCY})


def test_60p_on_50hz():
    pace = new_pace("60p-on-50hz")
    pace.set_display(P50, "measured")
    rec = drive(pace, live(cadence(3600, 60, 1), 16666667), Wayland(P50, 3700 * US))
    idx = drop_indices(rec)
    check("2 60p on a measured 50 Hz: exactly 1 in 6 dropped",
          len(idx) == 600 and set(spacings(idx)) == {6} and pace.take().rate_drops == 600)
    check("2 60p on a measured 50 Hz: release lateness flat, the display within a frame and a refresh",
          spread(release_lateness(rec)) == 0
          and spread(shown_lateness(rec)) <= 16666667 + P50)
    # kmssink blocks to the vblank, so it feeds its pace back into the releases.
    pace = new_pace("60p-on-50hz-kms")
    pace.set_display(P50, "measured")
    rec = drive(pace, live(cadence(3600, 60, 1), 16666667), Kms(P50, 3700 * US))
    late = release_lateness(rec)
    check("2 60p on a measured 50 Hz through kmssink: 1 in 6, lateness up once by under a frame",
          len(drop_indices(rec)) == 600 and spread(late) < 16666667
          and spread(late[len(late) // 2:]) == 0)


def test_60_on_5994():
    pace = new_pace("60-on-5994")
    pace.set_display(16683333, "measured")        # 60000/1001 Hz
    rec = drive(pace, live(cadence(36000, 60, 1), 16666667), Wayland(16683333, 1100 * US))
    idx = drop_indices(rec)
    check("3 60.000 fps on a measured 59.940 Hz: 1 drop per 1,001 +- 1",
          len(idx) >= 35 and all(abs(s - 1001) <= 1 for s in spacings(idx))
          and abs(len(idx) - 36000 / 1001) <= 1)
    check("3 60.000 fps on a measured 59.940 Hz: release lateness flat within a frame",
          spread(release_lateness(rec)) <= 16666667)


def test_50p_on_slow_display_measured():
    pace = new_pace("50p-on-slow-measured")
    pace.set_display(SLOW, "measured")
    rec = drive(pace, live(cadence(180000, 50, 1), P50), Wayland(SLOW, 1300 * US))
    idx = drop_indices(rec)
    check("4 50.000p on a measured 49.998 Hz (-40 ppm): 1 drop per 25,000 +- 1",
          len(idx) == 7 and all(abs(s - 25000) <= 1 for s in spacings(idx))
          and abs(len(idx) - expected_drops(rec, SLOW)) <= 1)
    check("4 50.000p on a measured 49.998 Hz: release lateness flat within one frame over 1 h",
          spread(release_lateness(rec)) <= P50 and spread(shown_lateness(rec)) <= 2 * P50)


def test_50p_on_matched_display():
    pace = new_pace("50p-on-matched")
    pace.set_display(P50, "measured")
    rec = drive(pace, live(cadence(180000, 50, 1), P50), Wayland(P50, 1300 * US))
    check("5 50.000p on a measured 50.000 Hz: 0 drops in 1 h",
          not drop_indices(rec) and pace.take().rate_drops == 0)
    check("5 50.000p on a measured 50.000 Hz: release lateness flat",
          spread(release_lateness(rec)) == 0)


def test_slow_display_nominal():
    for period, label in ((P50, "the mode's 50.000 Hz"), (SLOW, "its true period inside the band")):
        pace = new_pace("slow-display-nominal")
        pace.set_display(period, "nominal")
        rec = drive(pace, live(cadence(180000, 50, 1), P50), Wayland(SLOW, 1300 * US))
        shown, late = shown_lateness(rec), release_lateness(rec)
        growth, follows = shown[-1] - shown[0], late[-1] - late[0]
        check("6 the -40 ppm display given as nominal (%s): no drops" % label, not drop_indices(rec))
        # The releases follow once the display is a frame behind: a frame and a refresh later.
        check("6 the -40 ppm display given as nominal (%s): lateness +144 ms/h (%.1f ms at the "
              "display, %.1f ms at release)" % (label, growth / MS, follows / MS),
              abs(growth - 144 * MS) <= MS and 0 <= growth - follows <= P50 + SLOW)


# --- 7 to 10: the cadence ---------------------------------------------------------------------

def test_stall_then_gap():
    pace = new_pace("stall-then-gap")
    pace.set_display(P50, "measured")
    pts = cadence(1250, 50, 1)
    pts = pts[:1000] + [p + 3 * SEC for p in pts[1000:]]             # a 3 s content gap at 20 s
    frames = live(pts, P50)
    stall_end = pts[500] + LATENCY + 2 * SEC                        # an arrival stall at 10 s
    frames = [(p, d, max(r, stall_end) if 500 <= i < 600 else r, dc, g)
              for i, (p, d, r, dc, g) in enumerate(frames)]
    rec = drive(pace, frames)
    s = pace.take()
    backlog = rec[500:600]
    check("7 a 2 s arrival stall: the backlog leaves on the content cadence, not faster",
          all(b[2] - a[2] == b[0] - a[0] for a, b in zip(backlog, backlog[1:])))
    check("7 a 2 s arrival stall: lateness +2 s, 0 drops",
          set(release_lateness(rec[500:1000])) == {LATENCY + 2 * SEC} and s.rate_drops == 0)
    check("7 then a 3 s content gap: lateness after it = the input's",
          set(release_lateness(rec[1000:])) == {LATENCY})
    check("7 one collapse; late counts the stall's first frame only, not the gap's",
          s.gaps_collapsed == 1 and s.late == 1)


def _collapse_run(name, step_ns, discont, gap):
    """50p with a backlog (a 2 s stall at frame 100), then from frame 300 the PTS step on by
    `step_ns` more than one frame, flagged as asked. (lateness before, after, summary)."""
    pace = new_pace(name)
    pts = [k * P50 + (step_ns if k >= 300 else 0) for k in range(400)]
    frames = live(pts, P50)
    stall_end = pts[100] + LATENCY + 2 * SEC
    frames = [(p, d, max(r, stall_end) if 100 <= i < 200 else r, discont and i == 300, gap and i == 300)
              for i, (p, d, r, dc, g) in enumerate(frames)]
    rec = drive(pace, frames)
    late = release_lateness(rec)
    return late[299], late[300], pace.take()


def test_discont_and_gap_collapse():
    before, after, s = _collapse_run("discont", 40 * MS, True, False)
    check("8 DISCONT collapses like a gap: a 60 ms step inside the threshold takes one frame",
          after == before - 40 * MS and s.gaps_collapsed == 1)
    before, after, s = _collapse_run("gap", 40 * MS, False, True)
    check("8 on_gap() the same", after == before - 40 * MS and s.gaps_collapsed == 1)
    before, after, s = _collapse_run("gap-and-discont", 3 * SEC, True, True)
    check("8 a GAP and a DISCONT on one 3 s step: one collapse",
          after == LATENCY and s.gaps_collapsed == 1)
    before, after, s = _collapse_run("unflagged", 40 * MS, False, False)
    check("8 unflagged, the same 60 ms step is a clean delta and stays",
          after == before and s.gaps_collapsed == 0)
    # A decoder holding a decreasing PTS (B-160 F7): one PTS for 50 frames after a step back.
    pace = new_pace("held-pts")
    pts = [k * P50 for k in range(100)] + [99 * P50] * 50 + [99 * P50 + k * P50 for k in range(1, 51)]
    frames = [(p, P50, i * P50 + LATENCY, i == 100, i == 100) for i, p in enumerate(pts)]
    rec = drive(pace, frames)
    s = pace.take()
    check("8 a held PTS (F7) leaves on the nominal cadence, one collapse for its step",
          all(b[2] - a[2] == P50 for a, b in zip(rec, rec[1:])) and s.gaps_collapsed == 1
          and s.late == 0)


def test_idr_spikes():
    pace = new_pace("idr-spikes")
    frames = [(p, P50, p + LATENCY + (80 * MS if i % 50 == 0 and i else 0), False, False)
              for i, p in enumerate(cadence(500, 50, 1))]
    rec = drive(pace, frames)
    late = release_lateness(rec)
    check("9 IDR decode spikes (+80 ms every 50th frame): lateness rises once and stays",
          set(late[:50]) == {LATENCY} and set(late[50:]) == {LATENCY + 80 * MS})
    check("9 IDR decode spikes: late counts the first spike only", pace.take().late == 1)


def test_wrap_point():
    ok = True
    for num, wraps in ((50, 1), (60, 2)):
        pace = new_pace("wrap-%d" % num)
        pts = cadence(600, num, 1, wraps * WRAP_NS - 5 * SEC)
        rec = drive(pace, live(pts, SEC // num))
        s = pace.take()
        ok = ok and all(b[2] - a[2] == b[0] - a[0] for a, b in zip(rec, rec[1:]))
        ok = ok and s.gaps_collapsed == 0 and s.late == 0 and pts[0] < wraps * WRAP_NS < pts[-1]
    check("10 ns PTS across the 2^33-tick point (and the second): no step", ok)


# --- 11: the display period -----------------------------------------------------------------

def _presented(period, phase, frame_ns, seconds, seq0=0):
    """(presented ns, MSC) of content every `frame_ns` shown at the first refresh after its
    release on a display of `period`: one or two refreshes per frame when the content is slower."""
    samples, last = [], None
    for j in range(seconds * SEC // frame_ns):
        n = (j * frame_ns - phase) // period + 1
        if n != last:
            samples.append((phase + n * period, seq0 + n))
            last = n
    return samples


def _lcg(seed):
    while True:
        seed = (seed * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        yield seed >> 33


def test_display_period():
    t60 = 16666667
    fb = _presented(t60, 2 * MS, P50, 90)
    mean_delta = (fb[-1][0] - fb[0][0]) // (len(fb) - 1)
    check("11 feedback at 50p on 60 Hz: the refresh, not the content period (%d, mean delta %d)"
          % (vp.display_period_from_feedback(fb)[0], mean_delta),
          vp.display_period_from_feedback(fb) == (t60, False) and abs(mean_delta - P50) * 1000 < P50)
    check("11 feedback from 30 s: the refresh, flagged short",
          vp.display_period_from_feedback(_presented(t60, 2 * MS, P50, 30)) == (t60, True))
    # An output off for 30 s inside 120 s: its MSC either counted on or stood still.
    full = _presented(t60, 2 * MS, P50, 120)
    on = [x for x in full if not 40 * SEC <= x[0] < 70 * SEC]
    cut = next(i for i, x in enumerate(on) if x[0] >= 70 * SEC)
    still = on[:cut] + [(t, s - (on[cut][1] - on[cut - 1][1]) + 1) for t, s in on[cut:]]
    reset = full[:3000] + [(t, s - full[3000][1]) for t, s in full[3000:]]
    check("11 feedback across an output off 30 s (MSC on or still) and an MSC reset: the refresh",
          vp.display_period_from_feedback(on)[0] == t60
          and vp.display_period_from_feedback(still)[0] == t60
          and vp.display_period_from_feedback(reset)[0] == t60)
    kms = Kms(t60, 2 * MS)
    returns = [kms.push(j * P50)[0] for j in range(90 * 50)]
    check("11 returns at 50p on 60 Hz: the refresh, not the content period",
          vp.display_period_from_returns(returns) == (t60, False))
    rnd = _lcg(11)
    jittered = [t + next(rnd) % (400 * US) - 200 * US for t in returns[:3000]]
    period = vp.display_period_from_returns(jittered)[0]
    check("11 returns jittered +-200 us over 60 s: within 10 ppm (%d)" % period,
          abs(period - t60) * 100000 <= t60)
    kms = Kms(SLOW, 0)
    slow25 = [kms.push(10 * MS + j * 40 * MS)[0] for j in range(90 * 25)]
    check("11 returns at 25p on 50 Hz: the refresh with the mode's prior, twice it without",
          vp.display_period_from_returns(slow25, P50)[0] == SLOW
          and vp.display_period_from_returns(slow25)[0] == 2 * SLOW)


# --- 12 to 15: what the rate match keeps (beyond the brief's list) ----------------------------

def test_60p_on_slow_50hz():
    pace = new_pace("60p-on-slow-50hz")
    pace.set_display(SLOW, "measured")
    rec = drive(pace, live(cadence(216000, 60, 1), 16666667), Wayland(SLOW, 4100 * US))
    want = expected_drops(rec, SLOW)
    got = len(drop_indices(rec))
    check("12 60p on a measured 50 Hz at -40 ppm: 1 in 6 and the 40 ppm, %d drops (want %.1f)"
          % (got, want), abs(got - want) <= 1)
    check("12 60p on a measured 50 Hz at -40 ppm: release lateness flat within a frame over 1 h",
          spread(release_lateness(rec)) <= 16666667 and spread(shown_lateness(rec)) <= 16666667 + SLOW)


def test_foreign_clock_source():
    # A source 30 ppm fast, on house time with its rate, as 90 kHz ticks on the bus.
    pts = [(k * 1800 * 999970 // 1000000) * 100000 // 9 for k in range(180006)]
    pace = new_pace("foreign-clock")
    pace.set_display(SLOW, "measured")
    rec = drive(pace, live(pts, P50), Wayland(SLOW, 1300 * US))
    want = expected_drops(rec, SLOW)
    got = len(drop_indices(rec))
    check("13 50p from a source 30 ppm fast on a -40 ppm display: the 70 ppm, %d drops (want %.1f)"
          % (got, want), abs(got - want) <= 1 and pace.take().content_period == P50)
    check("13 50p from a source 30 ppm fast: release lateness flat within a frame over 1 h",
          spread(release_lateness(rec)) <= P50)


def test_faster_display_banks_one_frame():
    t60 = 16667333                                    # a 60 Hz display 40 ppm slow
    pace = new_pace("banks-one-frame")
    pace.set_display(t60, "measured")
    p50 = cadence(30000, 50, 1)
    p60 = cadence(216000, 60, 1, p50[-1] + P50)
    frames = live(p50, P50) + [(p, 16666667, p + LATENCY, i == 0, False) for i, p in enumerate(p60)]
    rec = drive(pace, frames, Wayland(t60, 900 * US))
    after = rec[30000:]
    want = expected_drops(after, t60)
    got = len(drop_indices(after))
    check("14 10 min of 50p on a 60 Hz display bank a frame at most: no drops then",
          not drop_indices(rec[:30000]))
    check("14 then 60p: the 40 ppm from the switch, %d drops in 1 h (want %.1f)" % (got, want),
          abs(got - want) <= 1 and spread(release_lateness(after)) <= 16666667)


def test_stamp_jitter():
    # Capture stamps off by up to 8 ms either way: the frames arrive on time, their PTS do not.
    rnd = _lcg(15)
    real = cadence(180000, 50, 1)
    pts = [t + next(rnd) % (16 * MS + 1) - 8 * MS for t in real]
    frames = [(p, P50, t + LATENCY, False, False) for p, t in zip(pts, real)]
    for period, label in ((P50, "a measured 50.000 Hz"), (SLOW, "a measured -40 ppm")):
        pace = new_pace("stamp-jitter")
        pace.set_display(period, "measured")
        rec = drive(pace, frames, Wayland(period, 1300 * US))
        want = max(expected_drops(rec, period), 0)
        got = len(drop_indices(rec))
        late = release_lateness(rec)
        check("15 PTS jittered +-8 ms on %s display: the deficit only, %d drops in 1 h (want %.1f)"
              % (label, got, want), abs(got - want) <= 1)
        check("15 PTS jittered +-8 ms on %s display: release lateness flat after the first minute"
              % label, spread(late[3000:]) <= P50)


# --- 16 to 20: the rate the sink achieves (p4-3c, B-175) --------------------------------------

def test_slow_presenting_display():
    # Weston on the Pi 5 box's 60.038 Hz DSI presents HEVC 1080p60 at about 56.6 fps (DEV-P4b).
    pace = new_pace("slow-presenting")
    rate = new_rate(pace)
    achieved = 10 ** 12 // 56600
    rec = drive_rate(pace, rate, live(cadence(36000, 60, 1), P60), Capped(DSI, 3700 * US, 56600),
                     prior=DSI)
    s = pace.take()
    want = expected_drops(rec, achieved)
    got = len(drop_indices(rec))
    late = release_lateness(rec[3600:])
    check("16 60p on a 60.038 Hz display presenting at most 56.6 fps: drops = the presentation "
          "deficit +- 1 %% over 10 min, %d (want %.1f)" % (got, want), abs(got - want) * 100 <= want)
    check("16 the decimation runs on the achieved period, not the refresh (%d ns, %.3f %% off)"
          % (s.display_period, 100 * (s.display_period - achieved) / achieved),
          s.display_source == "measured" and abs(s.display_period - achieved) * 200 <= achieved)
    check("16 release lateness flat within one of the display's frames after the first minute "
          "(%.2f ms)" % (spread(late) / MS), spread(late) <= s.display_period)
    check("16 the rate foresaw the drops: %d of %d were the sink's a period behind" % (s.behind, got),
          s.behind * 10 <= got)


def test_kms_every_other_refresh():
    # kmssink on that DSI shows one frame per two refreshes (DEV-P4a, DEV-P4b).
    for num, per_second in ((50, 20), (60, 30)):
        pace = new_pace("kms-wait-%dp" % num)
        rate = new_rate(pace)
        rec = drive_rate(pace, rate, live(cadence(600 * num, num, 1), SEC // num),
                         KmsWait(DSI, 3700 * US), prior=DSI)
        s = pace.take()
        got = len(drop_indices(rec)) / 600
        late = release_lateness(rec[60 * num:])
        check("17 %dp into kmssink presenting every second refresh at 60.038 Hz: %d drops a "
              "second +- 1 %% (%.3f)" % (num, per_second, got), abs(got - per_second) * 100 <= per_second)
        check("17 %dp into that kmssink: release lateness flat within a frame after the first "
              "minute (%.2f ms), the period two refreshes" % (num, spread(late) / MS),
              spread(late) <= SEC // num and s.display_period == 2 * DSI)
        check("17 %dp into that kmssink: the rate foresaw the drops once measured (%d of %d the "
              "sink's)" % (num, s.behind, len(drop_indices(rec))), s.behind * 10 <= len(drop_indices(rec)))


def test_display_rate():
    rate = vp.DisplayRate()
    rate.set_prior(DSI)
    rate.set_refresh(DSI)
    for k in range(2001):                                # 40 s of a sink taking 50 a second
        rate.on_push(k * P50, k > 0)
    check("18 the prior given and the measurement slower: the measurement rules",
          rate.period() == (P50, "measured") and rate.achieved() == P50)
    paced = vp.DisplayRate()
    paced.set_refresh(DSI)
    for k in range(2001):
        paced.on_push(k * P50, False)
    check("18 pushes the element paced (none left at once on the last return): the refresh stays",
          paced.period() == (DSI, "measured") and paced.achieved() == 0)
    early = vp.DisplayRate()
    for k in range(1001):                                # two windows only
        early.on_push(k * P50, k > 0)
    check("18 two windows do not make a rate yet", early.achieved() == 0 and early.period() == (0, "none"))
    for k in range(1, 501):                              # a fifth window, each presentation 1 % long
        rate.on_push(2000 * P50 + k * (P50 + P50 // 100), True)
    check("18 a window 1 %% long among five does not move the rate (%d)" % rate.achieved(),
          len(rate.windows) == 5 and rate.achieved() == P50)
    rate.set_refresh(DSI * 101 // 100 + 1)
    check("18 the refresh moving more than 1 %: measured again", rate.achieved() == 0 and not rate.windows)
    for k in range(1501):
        rate.on_push(k * 2 * DSI, k > 0)
    rate.restart()
    check("18 a restart (new caps): measured again", rate.achieved() == 0 and not rate.windows)


def test_keeps_up_as_before():
    pace = new_pace("keeps-up")
    rate = new_rate(pace)
    rec = drive_rate(pace, rate, live(cadence(6000, 50, 1), P50), Wayland(DSI, 3700 * US), prior=DSI)
    s = pace.take()
    check("19 50p on a 60.038 Hz display that presents every frame: no drop, nothing measured, the "
          "refresh kept", not drop_indices(rec) and rate.achieved() == 0 and s.display_period == DSI
          and set(release_lateness(rec)) == {LATENCY})
    pace = new_pace("every-refresh")
    rate = new_rate(pace)
    rec = drive_rate(pace, rate, live(cadence(36000, 60, 1), P60), Wayland(P50, 3700 * US))
    s = pace.take()
    idx = drop_indices(rec)
    check("19 60p on a 50 Hz display, no prior: its every refresh is its achieved period, 1 in 6 "
          "after the first second (%d drops)" % len(idx),
          s.display_period == P50 and set(spacings([i for i in idx if i > 120])) == {6}
          and abs(len(idx) - expected_drops(rec, P50)) <= 2)


def test_hiccup_window():
    class Hiccup(Capped):
        """Capped, frozen 300 ms from 35 s: inside the third window, the one that makes the rate."""

        def refresh_after(self, t):
            v = super().refresh_after(t)
            while 35 * SEC <= v < 35 * SEC + 300 * MS:
                v = super().refresh_after(v)
            return v

    pace = new_pace("hiccup")
    rate = new_rate(pace)
    achieved = 10 ** 12 // 56600
    rec = drive_rate(pace, rate, live(cadence(18000, 60, 1), P60), Hiccup(DSI, 3700 * US, 56600),
                     prior=DSI)
    s = pace.take()
    want = expected_drops(rec, achieved) + 300 * MS / achieved      # and the frozen 300 ms
    check("20 a 300 ms freeze inside a window of the measurement does not move the rate (%d ns), "
          "drops the deficit and the freeze +- 1 %% (%d, want %.1f)"
          % (s.display_period, len(drop_indices(rec)), want),
          abs(s.display_period - achieved) * 200 <= achieved
          and abs(len(drop_indices(rec)) - want) * 100 <= want)



# --- 21: the drain (B-179) -----------------------------------------------------------------

def test_drain():
    """B-179: the drain at +-5,000 ppm on a backlog (every frame ready at once, as from vp_esq):
    50p on a measured 60 Hz loses repeats only, no drop; on a measured 50 Hz it decimates 1 frame
    in 200 (+-1), counted as drain drops, rate_drops 0; at -5,000 ppm nothing drops and the
    lateness grows; the servo's fields: a late frame's lateness past its slot, a frame's slack."""
    n = 4000
    for name, period, drain in (("50p on 60 Hz, +0.5 %", 16666667, 5000000),
                                ("50p on 50 Hz, +0.5 %", P50, 5000000),
                                ("50p on 50 Hz, -0.5 %", P50, -5000000),
                                ("50p on 60 Hz, -0.5 %", 16666667, -5000000)):
        pace = new_pace("drain " + name)
        pace.set_display(period, "measured")
        pace.set_drain(drain)
        rec = drive(pace, [(p, P50, 0, False, False) for p in cadence(n, 50, 1)],
                    Wayland(period, 3700 * US))
        s = pace.take()
        moved = shown_lateness(rec)[-1] - shown_lateness(rec)[100]
        want = -drain * (rec[-1][0] - rec[100][0]) // SEC
        decimates = period == P50 and drain > 0
        check("drain %s: %d drain drops (%s), rate drops %d, behind %d" %
              (name, s.drain_drops, "n / 200 +-1" if decimates else "none", s.rate_drops, s.behind),
              s.rate_drops == 0 and s.behind == 0 and
              (abs(s.drain_drops - n // 200) <= 1 if decimates else s.drain_drops == 0))
        check("drain %s: the shown lateness moves %+.1f ms (0.5 %% of the content: %+.1f, +-10 %%)" %
              (name, moved / MS, want / MS), abs(moved - want) <= abs(want) // 10)
    pace = new_pace("drain fields")
    pace.set_display(P50, "measured")
    pace.on_frame(0, P50, 100 * MS, False)
    pace.on_frame(P50, P50, 105 * MS, False)
    early = pace.last_slack
    pace.on_frame(2 * P50, P50, 180 * MS, False)
    check("drain fields: a frame's slack is its slot less its arrival (15 ms), a late frame's lateness"
          " past it (40 ms, its slack -40 ms)",
          early == 15 * MS and pace.last_late_by == 40 * MS and pace.last_slack == -40 * MS)

# --- the replay format (the reference's own) ------------------------------------------------

def test_replay_format():
    calls, outputs = io.StringIO(), []
    pace = Recorded(calls, outputs, "replay")
    pace.set_display(P50, "measured")
    drive(pace, live(cadence(120, 60, 1), 16666667), Wayland(P50, 0))
    pace.take()
    pace = Recorded(calls, outputs, "replay-gaps", 100 * MS)
    pace.set_display(P50, "nominal")
    pts = [k * P50 + (SEC if k >= 30 else 0) for k in range(60)]
    drive(pace, [(p, 0, p + LATENCY, i == 30, i == 30) for i, p in enumerate(pts)])
    pace.take()
    pace = Recorded(calls, outputs, "replay-rate")              # held frames and the display rate
    rate = RecordedRate(calls, outputs)
    drive_rate(pace, rate, live(cadence(2100, 60, 1), P60), KmsWait(DSI, 0), prior=DSI)
    rate.restart()
    rate.period()
    pace.take()
    fb = _presented(16666667, 0, P50, 2)
    calls.write(vp.line({"op": "feedback", "pairs": [list(x) for x in fb]}) + "\n")
    outputs.append(vp.period_line(*vp.display_period_from_feedback(fb)))
    times = [Kms(16666667, 0).refresh_after(j * P50) for j in range(100)]
    calls.write(vp.line({"op": "returns", "times": times, "prior": 16666667}) + "\n")
    outputs.append(vp.period_line(*vp.display_period_from_returns(times, 16666667)))
    done = subprocess.run([sys.executable, os.path.join(HERE, "video_pace.py"), "-"],
                          input=calls.getvalue(), capture_output=True, text=True)
    check("replay format: a recorded run through video_pace.py gives the same lines",
          done.returncode == 0 and done.stdout.splitlines() == outputs)


HERE = os.path.dirname(os.path.abspath(__file__))
CASES = (test_50p_on_60hz, test_60p_on_50hz, test_60_on_5994, test_50p_on_slow_display_measured,
         test_50p_on_matched_display, test_slow_display_nominal, test_stall_then_gap,
         test_discont_and_gap_collapse, test_idr_spikes, test_wrap_point, test_display_period,
         test_60p_on_slow_50hz, test_foreign_clock_source, test_faster_display_banks_one_frame,
         test_stamp_jitter, test_slow_presenting_display, test_kms_every_other_refresh,
         test_display_rate, test_keeps_up_as_before, test_hiccup_window, test_drain,
         test_replay_format)

# (name, the case it must fail, video_pace.py text, its replacement). The first six are the
# brief's (p4-3a), the next nine B-161's, the last seven p4-3c's (B-175).
LAG_LINE = "self.lag = max(self.lag - delta, 0 if collapsed else -whole)"
ACHIEVED_FIRST = '        achieved = self.achieved()\n        if achieved:\n            return achieved, "measured"\n'
MUTANTS = (
    ("a dead band on measured", 4,
     'if self.display_source == "measured":\n            return True',
     'if self.display_source == "measured":\n            return (td - tc) * NOMINAL_BAND_DEN > tc'),
    ("the hold removed", 7, "release = max(arrival_ns, slot)", "release = arrival_ns"),
    ("the gap not collapsed", 7,
     "                delta = nominal\n                self.gaps_collapsed += 1",
     "                delta = d if d > 0 else nominal\n                self.gaps_collapsed += 1"),
    ("DISCONT ignored", 8, "collapsed = self.gap_pending or discont or d < 0",
     "collapsed = self.gap_pending or d < 0"),
    ("T_d from the mean of presented deltas", 11, "             if t1 > t0 and s1 > s0]\n",
     "             if t1 > t0 and s1 > s0]\n    steps = [(dt, 1) for dt, ds in steps]\n"),
    ("the accumulator reset to 0 at a drop", 3, "        elif drop:\n            self.rate_drops += 1",
     "        elif drop:\n            self.lag = 0\n            self.rate_drops += 1"),
    ("the residue lost at a drop", 12, "        elif drop:\n            self.rate_drops += 1",
     "        elif drop:\n            self.lag = whole\n            self.rate_drops += 1"),
    ("the median in the accumulator", 13, LAG_LINE,
     "self.lag = max(self.lag - (tc or delta), 0 if collapsed else -whole)"),
    ("no floor: a faster display banks", 14, LAG_LINE,
     "self.lag = self.lag - delta"),
    ("the floor at 0: jitter ratchets the lag", 15, LAG_LINE,
     "self.lag = max(self.lag - delta, 0)"),
    ("a whole frame by the frame's own delta", 15, "whole0 = nominal if nominal > 0 else delta0",
     "whole0 = delta0"),
    ("the credit kept across a collapse", 14, "0 if collapsed else -whole)", "-whole)"),
    ("late counts a collapsed frame", 7, "if arrival_ns > slot and not collapsed and not sink_late:",
     "if arrival_ns > slot and not sink_late:"),
    ("a held PTS collapses", 8, "or d < 0 or d > threshold", "or d <= 0 or d > threshold"),
    ("the lag on release intervals", 2, LAG_LINE,
     "self.lag = max(self.lag - (release - self.prev_release), 0 if collapsed else -whole)"),
    ("pace to the mode's refresh", 16, ACHIEVED_FIRST, "        achieved = self.achieved()\n"),
    ("the prior overriding a measurement", 17, ACHIEVED_FIRST,
     '        achieved = self.achieved()\n        if self.prior:\n            return self.prior, "nominal"\n'
     '        if achieved:\n            return achieved, "measured"\n'),
    ("one hiccup window taken as the rate", 20, "        return _round_div(span, pushes)",
     "        return _round_div(*self.windows[-1])"),
    ("the sink's wait moves the cadence", 17, "self.prev_release = slot if sink_late else release",
     "self.prev_release = release"),
    ("no skip a display period behind", 17, "if sink_late and arrival_ns - slot > grid + whole:",
     "if False:"),
    ("the skip leaves the lag", 16, "self.lag = max(self.lag, arrival_ns - slot - grid)",
     "self.lag = max(self.lag, whole)"),
    ("delta' in the slot only, not the lag", 21,
     "            whole = self._drained(whole0)\n            self.lag = max(self.lag - delta, 0 if collapsed",
     "            whole = whole0\n            self.lag = max(self.lag - delta0, 0 if collapsed"),
    ("every push read as the sink's pace", 19,
     "if pressed and self.prev_return is not None and returned_ns > self.prev_return:",
     "if self.prev_return is not None and returned_ns > self.prev_return:"),
)


def run_mutants():
    with open(os.path.join(HERE, "video_pace.py")) as f:
        src = f.read()
    for name, case, old, new in MUTANTS:
        if src.count(old) != 1:
            check("mutant %r applies once" % name, False)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "video_pace.py"), "w") as f:
                f.write(src.replace(old, new))
            shutil.copy(os.path.join(HERE, "video_pace_test.py"), tmp)
            env = {k: v for k, v in os.environ.items() if k != "VIDEO_PACE_TRACE"}
            done = subprocess.run([sys.executable, os.path.join(tmp, "video_pace_test.py"),
                                   "--case", str(case)], capture_output=True, text=True, env=env)
        failed = [line for line in done.stdout.splitlines() if line.startswith("FAIL ")]
        check("mutant %r fails case %d (%d checks)" % (name, case, len(failed)),
              done.returncode != 0 and failed)
    return 1 if _failures else 0


def main(argv):
    if argv[1:] == ["--mutants"]:
        return run_mutants()
    if len(argv) == 3 and argv[1] == "--case":
        CASES[int(argv[2]) - 1]()
    else:
        for case in CASES:
            case()
    if _trace is not None:
        _trace.close()
    if _failures:
        print("\n%d FAILURE(S) in video_pace" % _failures)
        return 1
    print("\nALL video_pace TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
