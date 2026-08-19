#!/usr/bin/env python3
"""Source-timeline latch for the runner's preserveSourceTimeline feature, plus
the producer-side egress stamper of the time-sync contract (`TimelineStamper`,
bottom of the file — ADR-0005 decision 2).

Pure logic, no GStreamer (the ts_split.py pattern): the runner feeds it the
raw TS bytes seen on a tsdemux SINK pad; it records the FIRST PES PTS per PID.
`offset_ns()` then converts a demuxed src pad's first buffer PTS into the
`GstPad.set_offset()` value that shifts that branch's running time onto the
source timeline — valid because tsdemux emits identity segments
(running_time == buffer pts).

WRAP HANDLING: the PES PTS is a 33-bit 90 kHz counter that wraps every
~26.5 h. Latching is EPOCH-CONSISTENT: the first PID to latch defines the
epoch, and every later PID's first PTS is unwrapped to the 2^33 period
nearest that reference — so an incarnation that starts astride the boundary
(some PIDs latching just before the wrap, some just after) still shifts all
branches onto ONE timeline instead of two epochs 26.5 h apart (the 2026-07-16
failure mode). A near-boundary unwrap can land a few frames NEGATIVE for the
lagging side; downstream tolerates a sub-second negative-running-time sliver
far better than a 26.5 h split. Mid-stream discontinuities still stale the
offset — the runner's post-latch watch handles those by restarting the
pipeline (fresh latch).

FILE SIZE, deliberately over the repo's ~250-line guideline (CLAUDE.md): this
file is ONE cohesive domain — the contract's timeline maths — and it is
maintained in LINE-FOR-LINE parity with `native/mrts/ts_timeline.cpp`, which is
what lets one fixture assert the same integers out of both languages. Splitting
it would mean splitting the C++ side identically to keep that parity readable,
so the cost is paid twice and the parity surface that guards against timeline
bugs multiplies. Keep it one file per language.
"""
from ts_psi import iter_packets, read_pes_pts, ts_pid

PTS_WRAP = 1 << 33

# 90 kHz ticks -> nanoseconds, exact in integers: ns = pts * 1e9 / 90e3.
_NS_NUM = 100000
_NS_DEN = 9


def pts90k_to_ns(pts: int) -> int:
    return pts * _NS_NUM // _NS_DEN


def iter_pes(data):
    """`(pid, PES PTS)` for every PES header in `data`, in wire order.

    ONE parse pass for callers that need the same headers more than once — the
    stamper wants them three times over (discontinuity watch, first-PES latch,
    stamp) and it is the parse, not the arithmetic, that costs. Pass a
    `memoryview` and the per-packet slices below stay views instead of 188-byte
    copies.

    PUSI is the quick-reject: a PES header can only start on a payload-unit
    boundary, so non-PUSI packets are skipped on one byte test, and PSI
    sections fall out of `read_pes_pts` on the start-code check.
    """
    for pkt in iter_packets(data):
        if not (pkt[1] & 0x40):
            continue
        pts = read_pes_pts(pkt)
        if pts is None:
            continue
        yield ts_pid(pkt), pts


def unwrap_near(pts: int, ref: int) -> int:
    """`pts` shifted by the 2^33 period that lands it nearest `ref`.

    `ref` may itself be unwrapped (outside 33 bits). Real interleave skew is
    seconds at most, so the nearest-period candidate is always unambiguous.
    """
    base = ref - ((ref - pts) % PTS_WRAP)
    return base if (ref - base) <= PTS_WRAP // 2 else base + PTS_WRAP


def median(values):
    """Upper median of a small list. Written out (not `statistics.median`) so
    the C++ port can be tick-for-tick identical: on an even count this takes
    the UPPER middle element rather than averaging the two, which keeps the
    result an exact sample instead of a rounded one."""
    return sorted(values)[len(values) // 2]


class TimelineLatch:
    """Per-PID first-PES-PTS recorder over a TS byte stream."""

    def __init__(self):
        self.first_pts = {}   # pid -> first PES PTS, epoch-unwrapped (see doc)
        self._epoch_ref = None

    def feed(self, data: bytes) -> None:
        """Latch from raw TS bytes. Keeps its own scan (rather than going via
        `iter_pes`) for the set-membership shortcut: a PID already latched
        costs one dict lookup and never a PES header parse, which is what makes
        this cheap on the steady-state 1-in-8 sampling of the runner's
        preserveSourceTimeline path. New PIDs (a PMT change mid-stream) are
        still picked up — the test is per packet, not once per stream."""
        for pkt in iter_packets(data):
            if not (pkt[1] & 0x40):        # PUSI quick-reject before PID parse
                continue
            pid = ts_pid(pkt)
            if pid in self.first_pts:      # cheap steady-state: latch once
                continue
            pts = read_pes_pts(pkt)
            if pts is not None:
                if self._epoch_ref is None:
                    self._epoch_ref = pts
                else:
                    pts = unwrap_near(pts, self._epoch_ref)
                self.first_pts[pid] = pts

    def feed_pes(self, pes) -> None:
        """Latch from PES headers a caller has already parsed out (`iter_pes`).

        Identical bookkeeping to `feed`, minus the parse the caller has paid
        for anyway — the already-latched shortcut is the same dict test.
        """
        for pid, pts in pes:
            if pid in self.first_pts:
                continue
            if self._epoch_ref is None:
                self._epoch_ref = pts
            else:
                pts = unwrap_near(pts, self._epoch_ref)
            self.first_pts[pid] = pts

    def latched(self, pid: int) -> bool:
        return pid in self.first_pts

    def offset_ns(self, pid: int, first_buffer_pts_ns: int):
        """set_offset() value moving a branch whose first buffer carried
        `first_buffer_pts_ns` onto the source timeline; None if not latched."""
        pts = self.first_pts.get(pid)
        if pts is None:
            return None
        return pts90k_to_ns(pts) - first_buffer_pts_ns


class TimelineStamper:
    """Producer-side egress stamper (ADR-0005 decision 2, time-sync contract).

    Maps a producer's PES timeline onto the house clock ONCE and stamps every
    outgoing bus buffer with `anchor + (payload PES - firstPES)`, so consumers
    inherit identical timing by construction instead of re-deriving it from
    their own arrival. THE definition of the contract in python: the
    unixfd-fanout.py sidecar and the gst runner's egress probe
    (`packages/engine/src/child-process/gst_bus_stamper.py`) both instantiate
    this class, and `mrts::TimelineStamper` is its line-for-line C++ port for
    the native sidecars and the `mrtsstamp` element.

    `house_now` is the caller's clock reading: on the sidecars the wire domain
    is absolute CLOCK_MONOTONIC (busproto.h), i.e. `time.monotonic_ns()`.

    ONE stamper serves a whole egress. A caller with several output streams
    (mr-tssplit's per-PID SPTS outputs) passes each as its own `stream`, so the
    branches share a single anchor + epoch reference — mutual A/V alignment is
    the whole point — while each keeps its own monotone floor.

    TWO independent ways back from a source discontinuity, because the freeze
    mode one of them misses is unbounded (the 2026-08-13 field failure): the
    per-PID discontinuity WATCH (`_scan_watch`) recognises the jump, and the
    bounded-staleness NET (`_scan_stale`) catches whatever the watch did not.

    THIRD, and continuous rather than event-driven: the drift SLEW (`_observe`
    / `_slew`). The two above answer steps; neither can answer a source whose
    crystal simply runs at a different rate from ours, which every source does
    (10-50 ppm typical, 1-4 s/day). The slew holds the arrival-vs-stamp margin
    where it was when the anchor was latched, at a bounded micro-rate.
    """

    _FWD_TICKS = 5 * 90000     # forward jump > 5 s
    _BACK_TICKS = 90000        # backward jump > 1 s
    _CONFIRM = 2               # consecutive anomalous buffers before we believe one

    # Bounded-staleness net (defense in depth). The watch is a DETECTOR, so it
    # can only answer discontinuities it recognises; what it misses costs an
    # unbounded freeze, because the monotone floor below holds the last
    # pre-jump stamp while house time runs away from it and every sync=true
    # consumer (max-lateness 1 s) drops the lot until the source's own timeline
    # catches back up — 43 minutes, on the looping VOD that found this. The net
    # makes that mode impossible for ANY detection gap, imagined or not.
    #
    # _STALE_NS is `_FWD_TICKS` in nanoseconds, deliberately the same number:
    # 5 s is already this module's definition of "further off the contract than
    # a legitimate media timeline ever goes". Steady state has no lag to speak
    # of — the anchor absorbs whatever constant producer latency exists when it
    # is latched — so media that sits 5 s behind house means the MAPPING is
    # wrong, not that the pipeline is deep. _STALE_HOLD_NS is what makes it a
    # persistent condition rather than a spike: 1 s is the consumers' own
    # max-lateness, past which lateness has stopped being something a sink can
    # absorb anyway.
    _STALE_NS = 5_000_000_000
    _STALE_HOLD_NS = 1_000_000_000

    # --- drift slewing (ADR-0005 decision 5's drift term) -------------------
    # The stamp is `anchor + (PES - ref)`: media time from the SOURCE's clock,
    # pinned to OUR clock once. Two crystals are never the same — 10-50 ppm
    # apart is ordinary, 1-4 s/day — so the margin between a buffer's arrival
    # and its own stamp WALKS for as long as the route runs: source fast means
    # buffers arrive further and further ahead of their stamps and the
    # consumer's queue grows without bound; source slow means further and
    # further behind, and a sync=true sink drops them. The staleness net above
    # is a 5 s backstop for step failures; a 24/7 route needs a continuous
    # micro-correction long before it, which is this.
    #
    # WHAT THIS LOOP MAY AND MAY NOT DO — the 2026-08-13 field lesson, learned
    # the expensive way. The first cut of this was a POSITION loop: it captured
    # a baseline margin and drove the margin back to it. That is wrong, and
    # visibly so within an hour of shipping. A producer's margin is not ours to
    # choose: an HLS player builds a ~2 s delivery lead over the first minutes
    # (and rebuilds it after every re-anchor), and a position loop reads that
    # healthy buildup as an error and spends its whole authority destroying it —
    # measured on .202: 125 ms of a 2.25 s video lead given away in 17 minutes,
    # at the clamp, still falling, with the sink dropping late frames.
    #
    # So this loop has NO SETPOINT. It cancels the TREND and nothing else:
    # whatever level the margin settles at is the producer's business, and the
    # only thing the slew removes is the SLOPE — the ppm the two clocks differ
    # by. Level changes (buffer buildup, a segment-size change, a route change)
    # pass through untouched, by construction rather than by tuning.
    #
    # ESTIMATOR — lower envelope, sub-window median, then a slope:
    #   The per-buffer margin (`house_now - stamp`) is the clock offset PLUS
    #   this buffer's delivery delay, and delivery delay is one-sided noise: a
    #   buffer can be handed to us late (a network burst, a segment fetch, a
    #   scheduler hiccup) but never earlier than the source produced it. So the
    #   MINIMUM over a window tracks the offset rather than the jitter — the
    #   min-filter of RTP/NTP skew estimation. `_DRIFT_BUCKET_NS` keeps the
    #   minimum of each 2 s bucket; `_SUBWINDOW_NS` of those buckets reduce to
    #   one MEDIAN level, which is robust the other way (one anomalously early
    #   bucket moves a minimum-of-minimums permanently and a median not at all);
    #   `_TREND_SLOTS` of those levels are the trend window. The slope is the
    #   median of the newest three levels minus the median of the oldest three,
    #   over the time between them — endpoints as medians, so no single level
    #   can tilt it.
    #
    # SERVO — a rate lock, not a position lock:
    #   `_rate_ppm` is an integrator on the RESIDUAL slope: every sub-window it
    #   moves by `_TREND_GAIN` of whatever slope is left, so it converges on the
    #   source's true ppm offset and then holds it, with the measured slope at
    #   zero. Nulling the slope directly (rate = -slope) would un-correct itself
    #   the moment it worked; nulling a LEVEL is what caused the field failure.
    #
    # GUARDS, each answering a way this can hurt a live route:
    #   `_SETTLE_NS`   nothing is measured for the first 5 minutes of an epoch.
    #                  A producer's startup transient — the buildup — is not
    #                  drift, and a re-anchor restarts the clock on this.
    #   `_TREND_MIN_PPM` a slope under 10 ppm (0.9 s/day) is left alone: at the
    #                  trend window's length that is ~12 ms of level change,
    #                  which is the same order as the envelope's own noise.
    #   two consecutive same-signed slopes before the rate moves at all, so a
    #                  one-off step in the level can never be read as a trend.
    #   `_SLEW_MAX_PPM` 200 ppm — ~5x the worst crystal pair, 720 ms/hour of
    #                  authority, and 200 µs per second is orders below lipsync.
    #   `_GIVEBACK_NS` the outcome watchdog, and the direct answer to the field
    #                  failure: if the scheduling margin ever falls 200 ms below
    #                  what it was when this loop engaged, the loop DISENGAGES,
    #                  drops its rate to zero and re-settles. Correcting a real
    #                  drift never does that (holding the slope at zero holds the
    #                  level too), so the only things it can catch are a
    #                  wrong-signed correction and a drift past our authority —
    #                  and in both cases doing nothing is better than what we
    #                  were doing.
    _SLEW_MAX_PPM = 200                 # bound on |d(anchor)/d(house)|
    _SETTLE_NS = 300_000_000_000        # 5 min of epoch before anything is measured
    _DRIFT_BUCKET_NS = 2_000_000_000    # lower-envelope bucket
    _SUBWINDOW_NS = 120_000_000_000     # ... reduced to one median level per 2 min
    _TREND_SLOTS = 10                   # ... x this = a 20 min trend window
    _TREND_EDGE = 3                     # levels averaged at each end of the slope
    _TREND_MIN_PPM = 10                 # below this the slope is noise, not drift
    _TREND_GAIN_NUM, _TREND_GAIN_DEN = 1, 10     # residual-slope integrator gain
    _GIVEBACK_NS = 200_000_000          # margin we will never be seen to cost

    def __init__(self, on_anchor=None, on_reanchor=None):
        self.latch = TimelineLatch()
        self.anchor = None      # house time (ns) latched at the first PES
        self.ref = None         # that first PES (90 kHz), the timeline's zero
        self.reanchors = 0
        self._unwrapped = {}    # pid -> last PES PTS, unwrapped past 2^33 wraps
        self._watch_last = {}   # pid -> last PES PTS (raw), discontinuity watch
        self._pending = {}      # pid -> the epoch its last anomaly proposed
        self._floors = {}       # stream -> last stamp emitted
        self._stale_since = {}  # stream -> house time its lag first went out of bound
        self._anom = 0
        self._on_anchor = on_anchor
        self._on_reanchor = on_reanchor
        self._reset_drift(None)

    # --- drift estimator + slew ---------------------------------------------

    def _reset_drift(self, house_now):
        """Fresh epoch for the drift servo. Construction and every re-anchor:
        the rate we had measured belonged to a mapping that no longer exists,
        and the settling period starts again because a fresh anchor means a
        fresh producer transient (an HLS player rebuilds its delivery lead from
        zero after every one)."""
        self._env_min = 0       # running minimum of the open 2 s bucket
        self._env_end = None    # house time that bucket closes at
        self._sub = []          # closed bucket minima of the open sub-window
        self._sub_end = None    # house time the sub-window closes at
        self._trend = []        # (house time, level) per closed sub-window
        self._level = None      # newest sub-window level, i.e. the margin now
        self._rate_ppm = 0      # the correction rate currently applied
        self._slope_sign = 0    # sign of the last qualifying slope (confirmation)
        self._engage_level = None    # margin level when the servo engaged
        self._epoch_start = house_now
        self._slew_last = house_now  # house time the last correction was applied
        self._slew_total = 0    # cumulative anchor correction, this epoch

    def drift_stats(self):
        """Current drift state, for the producers' periodic stats line.

        `ppm` is the correction rate the servo has locked onto — the source's
        clock offset from ours — and `slewNs` what applying it has cost (or
        given) the anchor this epoch. `marginNs` is the current envelope level
        (`house - stamp`; NEGATIVE means the producer is delivering ahead of its
        own stamps, which is a healthy delivery lead and not an error).
        `engageNs` is the level the servo engaged at and undertakes not to give
        away — 0 while it has not engaged.

        `samples` of `window` is how much of the trend window is filled: below a
        full window nothing is being corrected, which a reader has to be able to
        tell from a measured zero.
        """
        return {'ppm': self._rate_ppm, 'slewNs': self._slew_total,
                'marginNs': self._level if self._level is not None else 0,
                'engageNs': self._engage_level if self._engage_level is not None else 0,
                'samples': len(self._trend), 'window': self._TREND_SLOTS}

    def _observe(self, house_now, stamp):
        """Feed one buffer's arrival-vs-stamp margin into the estimator.

        Only ever called for a buffer that carried a PES header: a PES-less
        buffer repeats the previous stamp, so its "margin" is the age of that
        stamp and not a measurement of anything.
        """
        margin = house_now - stamp
        if self._epoch_start is None:
            self._epoch_start = house_now       # pre-anchor construction
        if house_now - self._epoch_start < self._SETTLE_NS:
            # Settling. A producer's opening transient — an HLS player building
            # its delivery lead — is not drift, and measuring through it is what
            # taught this loop the wrong target once already.
            return
        if self._env_end is None:
            self._env_end = house_now + self._DRIFT_BUCKET_NS
            self._sub_end = house_now + self._SUBWINDOW_NS
            self._env_min = margin
            return
        if house_now < self._env_end:
            if margin < self._env_min:
                self._env_min = margin
            return
        self._sub.append(self._env_min)         # the bucket's lower envelope
        self._env_end = house_now + self._DRIFT_BUCKET_NS
        self._env_min = margin
        if house_now < self._sub_end:
            return
        # Sub-window closed: one robust level, and a chance to re-estimate.
        self._level = median(self._sub)
        self._sub = []
        self._sub_end = house_now + self._SUBWINDOW_NS
        self._trend.append((house_now, self._level))
        if len(self._trend) > self._TREND_SLOTS:
            del self._trend[0]
        self._update_rate()

    def _slope_ppm(self):
        """Trend of the margin across the window, in ppm of house time, or None
        while the window is not full. Both endpoints are MEDIANS of `_TREND_EDGE`
        levels, so no single sub-window can tilt the answer."""
        if len(self._trend) < self._TREND_SLOTS:
            return None
        e = self._TREND_EDGE
        old, new = self._trend[:e], self._trend[-e:]
        dt = median([t for t, _ in new]) - median([t for t, _ in old])
        if dt <= 0:
            return None
        return (median([v for _, v in new]) - median([v for _, v in old])) * 1_000_000 // dt

    def _update_rate(self):
        """One servo step, per closed sub-window."""
        slope = self._slope_ppm()
        if slope is None:
            return
        if self._engage_level is None:
            self._engage_level = self._level
        elif self._level - self._engage_level > self._GIVEBACK_NS:
            # The outcome watchdog. `level` is `house - stamp`, so a level ABOVE
            # the engage level means the scheduling margin has SHRUNK by that
            # much since we started correcting — which is the one thing this loop
            # must never be responsible for. Stand down completely and re-settle;
            # the staleness net is what owns a margin this loop cannot hold.
            self._rate_ppm = 0
            self._slope_sign = 0
            self._trend = []
            self._engage_level = None
            self._epoch_start = self._trend_now()
            return
        sign = 1 if slope > 0 else (-1 if slope < 0 else 0)
        if abs(slope) < self._TREND_MIN_PPM:
            # Under a second a day. Not worth moving for, and small enough to be
            # the envelope's own noise. The rate we already hold stays held.
            self._slope_sign = 0
            return
        if sign != self._slope_sign:
            # First sighting of a slope this sign: wait for it to be confirmed
            # by the next sub-window before touching the rate at all, so a STEP
            # in the level (one segment longer than usual) can never read as a
            # trend.
            self._slope_sign = sign
            return
        # Integrate the RESIDUAL slope: the rate converges on the source's own
        # offset and then holds it with the slope at zero. (Setting the rate to
        # the slope instead would undo itself the moment it worked.)
        step = slope * self._TREND_GAIN_NUM // self._TREND_GAIN_DEN
        self._rate_ppm = max(-self._SLEW_MAX_PPM,
                             min(self._SLEW_MAX_PPM, self._rate_ppm + step))

    def _trend_now(self):
        """House time of the newest sub-window — the restart point after a
        stand-down (the servo has no other clock reading to hand)."""
        return self._trend[-1][0] if self._trend else self._epoch_start

    def _slew(self, house_now):
        """Apply the locked rate to the anchor for the elapsed house time.

        POSITIVE rate means media is running behind house (source slow), so the
        anchor moves FORWARD to keep the stamps up with it; negative moves it
        back, cancelling the growth of a fast source's lead. Either way it is
        `_rate_ppm` of real time and nothing else — no level term, so a healthy
        margin is never a target. Integer arithmetic in MICROseconds of elapsed
        house time, which is what keeps this identical in C++ and floors the
        same way in both languages for a negative rate.
        """
        if self._slew_last is None:
            self._slew_last = house_now
            return
        dt = house_now - self._slew_last
        if dt <= 0:
            return
        self._slew_last = house_now
        if not self._rate_ppm:
            return
        step = self._rate_ppm * (dt // 1000) // 1000
        if step:
            self.anchor += step
            self._slew_total += step

    def stamp(self, data: bytes, house_now: int, stream=0) -> int:
        """Map one outgoing buffer of `stream` onto the house timeline.

        EVERY buffer gets a valid stamp: one carrying no PES header at all
        (PSI/PCR-only or continuation packets) repeats the stream's last stamp,
        because a timestampless buffer leaves the time-bounded leaky queues on
        the bus unable to measure their own level.
        """
        # ONE parse pass, then three walks over its result: the watch, the latch
        # and the stamp all want the same PES headers, and re-parsing the buffer
        # for each was the whole per-buffer cost. Order and arithmetic are
        # unchanged — the watch still decides (and may re-anchor) before
        # anything is stamped. `memoryview` keeps ts_psi's per-packet slices as
        # views rather than 188-byte copies.
        pes = list(iter_pes(memoryview(data) if not isinstance(data, memoryview)
                            else data))
        if self.anchor is not None:
            self._scan_watch(pes, house_now)    # may re-anchor before we stamp
            self._scan_stale(pes, house_now, stream)      # ... and so may the net
            if pes:
                # ... and if neither did, the drift slew nudges the anchor the
                # few ns this buffer's share of the correction is worth. After
                # the two above, so a re-anchor's fresh baseline is never slewed
                # by the epoch it just replaced.
                self._slew(house_now)
        self.latch.feed_pes(pes)                # epoch-consistent first PES per PID
        stamp = self._scan_stamp(pes, house_now)
        if stamp is not None:
            # Closed loop: measure this buffer's MAPPED time against the house
            # time it arrived at — before the monotone floor below, which is a
            # guard on what leaves rather than a statement about the mapping.
            # (A clamped stamp would read as a source falling behind; the
            # staleness net owns that mode, and it reads the floor.) PES-less
            # buffers are not measured at all: they repeat the staircase, so
            # their margin is the previous stamp's age.
            self._observe(house_now, stamp)
        if stamp is None:
            # A stream whose FIRST buffer carries no PES (a PSI-only flush on a
            # freshly wired output) has no staircase to repeat: house time is
            # the same fallback the pre-anchor path takes, and it keeps a bogus
            # zero out of the floors — a zero floor reads to the staleness net
            # as a stream frozen since the epoch.
            stamp = self._floors.get(stream, house_now)
        floor = self._floors.get(stream, 0)
        if stamp < floor:
            stamp = floor                       # monotone non-decreasing staircase
        self._floors[stream] = stamp
        return stamp

    def _reanchor(self, pid, lastp, pts, d, house_now):
        # In place, NOT a restart (preserveSourceTimeline has to restart because
        # its offsets are baked into pad offsets): the anchor is two numbers, so
        # a re-anchor costs one PTS step and needs no consumer cooperation.
        # Every stream of this egress re-anchors together, so A/V pairing lives.
        self._anom = 0
        self.reanchors += 1
        self.anchor = house_now
        self.ref = pts
        self._unwrapped.clear()
        # The watch's references belong to the epoch we just left too, and one
        # of them is by now deliberately stale (see `_scan_watch`) — carried
        # over they would report the SAME jump again on the next buffer.
        self._watch_last.clear()
        self._pending.clear()
        self._stale_since.clear()
        # The drift estimate belongs to the old mapping too: its baseline was a
        # margin measured against an anchor that no longer exists, so carrying
        # it over would slew the fresh anchor by the dead epoch's error.
        self._reset_drift(house_now)
        # Fresh latch: the old first-PES map belongs to the epoch we just left.
        self.latch = TimelineLatch()
        # Drop the monotone floors with the anchor. A discontinuity is detected
        # at least one buffer LATE, so by now a floor holds a stamp derived from
        # the jumped payload — a source that skipped ten minutes forward would
        # otherwise pin the timeline ten minutes ahead and freeze every later
        # stamp against that floor until the house clock caught up.
        self._floors.clear()
        if self._on_reanchor:
            self._on_reanchor({'pid': pid, 'lastPts90k': lastp, 'refPts90k': pts,
                               'deltaTicks': d, 'anchorNs': self.anchor,
                               'count': self.reanchors})

    @classmethod
    def _delta(cls, pts, last):
        """Signed PES delta, wrap-folded — the watch's whole 33-bit immunity: a
        legal 2^33 crossing reads as the tiny step it really is."""
        d = (pts - last) % PTS_WRAP
        return d - PTS_WRAP if d > PTS_WRAP // 2 else d

    @classmethod
    def _coherent(cls, pts, last):
        """True when `pts` is a plausible continuation of `last`. Named because
        BOTH halves of the watch ask it: once of the pre-jump reference (is
        this a discontinuity at all?) and once of the proposed new epoch (is
        the stream continuing from it?)."""
        return -cls._BACK_TICKS <= cls._delta(pts, last) <= cls._FWD_TICKS

    def _scan_watch(self, pes, house_now):
        # Two ways to confirm a discontinuity, because ONE anomalous delta is
        # never enough — a single corrupt PTS must not re-anchor a healthy
        # timeline:
        #
        #   cross-PID  `_CONFIRM` consecutive anomalous BUFFERS, whichever PIDs
        #              reported them. On a muxed egress the second PID confirms
        #              a buffer later what the first reported. Unchanged.
        #   same-PID   the PID that reported the jump COMES BACK coherent from
        #              the epoch it proposed. This is the only path a
        #              single-PID egress has, and it is the fix for the
        #              2026-08-13 field failure: mr-tssplit stamps each of its
        #              per-PID SPTS outputs as its own single-PID buffer, so
        #              its watch saw exactly ONE anomaly per output at a source
        #              loop and the cross-PID rule could never be satisfied —
        #              the floor below then pinned every later stamp to the
        #              last pre-loop value for the rest of the 43-minute loop.
        #
        # Confirming against the PROPOSED epoch rather than just counting
        # anomalies is what keeps the same-PID path honest: a sparse PID whose
        # PES really are >5 s apart re-proposes a fresh epoch every time and
        # never confirms, while a VOD rewind proposes ~0 and the very next PES
        # is 40 ms past it. The pre-jump reference is deliberately NOT advanced
        # across an anomaly, so a PID that was merely glitched comes back
        # coherent against it and drops its proposal.
        for pid, pts in pes:
            lastp = self._watch_last.get(pid)
            if lastp is None:
                self._watch_last[pid] = pts
                continue
            if self._coherent(pts, lastp):
                self._watch_last[pid] = pts
                self._pending.pop(pid, None)
                continue
            self._anom += 1
            cand = self._pending.get(pid)
            self._pending[pid] = pts
            if ((cand is not None and self._coherent(pts, cand))
                    or self._anom >= self._CONFIRM):
                self._reanchor(pid, lastp, pts, self._delta(pts, lastp), house_now)
            return
        self._anom = 0

    def _scan_stale(self, pes, house_now, stream):
        """Force a re-anchor when `stream`'s stamps have fallen — and STAYED —
        further behind house time than `_STALE_NS`.

        Reads the stream's floor, i.e. the last stamp it emitted, which in the
        freeze mode IS the frozen value: no restamp is needed and the check
        costs one subtraction per buffer. A stream that is not being stamped
        cannot trip it, by construction — a producer that has stopped emitting
        altogether is a different failure, and the bus stall watchdogs own it.
        """
        floor = self._floors.get(stream)
        if floor is None or not pes:
            return
        lag = house_now - floor
        if lag <= self._STALE_NS:
            self._stale_since.pop(stream, None)
            return
        since = self._stale_since.setdefault(stream, house_now)
        if house_now - since < self._STALE_HOLD_NS:
            return
        pid, pts = pes[0]
        # `deltaTicks` carries the LAG that forced this (negative — media
        # behind house), so the event stream alone tells a net-forced re-anchor
        # from a watch-forced one.
        self._reanchor(pid, self._watch_last.get(pid, pts), pts,
                       -(lag * _NS_DEN // _NS_NUM), house_now)

    def _scan_stamp(self, pes, house_now):
        """Stamp for this buffer, or None when it carries no PES header.

        The stamp comes from the FIRST PES PTS in the buffer: that is where the
        buffer's media content starts, and taking the last one would drag the
        stamp forward by the mux's interleave depth.
        """
        stamp = None
        for pid, pts in pes:
            if self.anchor is None:
                self.anchor = house_now
                # The drift servo's t0: its settling period is measured from
                # the anchor, because what it must not measure through is the
                # producer transient that starts right here.
                self._slew_last = house_now
                self._epoch_start = house_now
                # The latch's epoch reference: the first PES it recorded, which
                # every other PID's first value was unwrapped against.
                self.ref = next(iter(self.latch.first_pts.values()), pts)
                if self._on_anchor:
                    self._on_anchor({'pid': pid, 'anchorNs': self.anchor,
                                     'refPts90k': self.ref})
            # Unwrap against this PID's own last value, or — first time we see
            # the PID — against the latch's epoch-consistent first PES for it.
            # Either way a legal 26.5 h wrap stays one continuous timeline.
            prev = self._unwrapped.get(pid)
            if prev is None:
                prev = self.latch.first_pts.get(pid, self.ref)
            u = unwrap_near(pts, prev)
            self._unwrapped[pid] = u
            if stamp is None:
                stamp = self.anchor + pts90k_to_ns(u - self.ref)
        return stamp
