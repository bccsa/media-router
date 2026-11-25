"""Cue logic of the subtitle bridge: pure helpers plus the two thread-shared
states, each under one lock — `PayState` (producer: each cue and keepalive
stamped, packed and pushed under the lock, on one shared floor) and
`OverlayCues` (consumer: cues queued by start, promoted per video frame).
ADR-0016 amendments 2026-10-09 and 2026-11-25 (MR-062). Pure stdlib.
"""
import bisect
import threading
from collections import namedtuple

# A keepalive goes out once the source PES time is this far past the last send (MR-062).
KEEPALIVE_MS = 1000
FRAME_TIME_TOLERANCE_MS = 10_000
QUEUE_MAX = 16
SAME_START_MS = 1.0

# A cue: house times (ms) and text; the consumer adds its payload key, t0 source and arrival.
Cue = namedtuple("Cue", "start end text key src at", defaults=(None, None, None))


def make_cue(start_ms, text, hold_ms):
    """A live cue runs from start for hold_ms; a clear is a zero-length cue at start.
    The start stays as given, so the cue's PES PTS is its source PES's to the tick."""
    if not text:
        return Cue(start_ms, start_ms, "")
    return Cue(start_ms, start_ms + max(0, int(hold_ms)), text)


def cue_start(pts_ms, now_ms, floor_ms=None):
    """(start_ms, from_pts): the text buffer's PTS (its content time) when it
    is within FRAME_TIME_TOLERANCE_MS of house-now, else now; never below
    `floor_ms` (the last cue start or keepalive sent), so the KLV PES PTS never steps back."""
    if pts_ms is not None and now_ms is not None and abs(pts_ms - now_ms) <= FRAME_TIME_TOLERANCE_MS:
        start, from_pts = pts_ms, True
    else:
        start, from_pts = now_ms, False
    if start is not None and floor_ms is not None and start < floor_ms:
        start = floor_ms
    return start, from_pts


def relative_cue(cue, pes_ms):
    """A cue's times relative to a PES at house time `pes_ms` (never negative
    — a cue already running shows from +0). A clear cue stays (0, 0, '')."""
    rel_start = max(0.0, cue.start - pes_ms)
    rel_end = max(rel_start, cue.end - pes_ms)
    return (rel_start, rel_end, cue.text)


def wire_cue(cue):
    """(PES PTS ms, relative block) for the one send of `cue`: the PES sits on
    the cue's start and the block is `0 --> (end − start)`."""
    return cue.start, relative_cue(cue, cue.start)


def absolute_cue(rel, t0_ms):
    """A received cue (relative block) back on the consumer's own house
    timeline, anchored at `t0_ms` — the cue PES's house time."""
    start, end, text = rel
    return Cue(t0_ms + start, t0_ms + end, text)


def frame_time(pts_ms, now_ms):
    """House time to judge a frame by: its PTS when stamp-aligned, else now."""
    if pts_ms is None or now_ms is None:
        return now_ms
    return pts_ms if abs(pts_ms - now_ms) <= FRAME_TIME_TOLERANCE_MS else now_ms


def cue_t0(pts_ms, now_ms):
    """(t0_ms, source) a received cue anchors on: its demuxed PTS, its PES time
    on the house timeline ('pts'), when near house-now, else arrival ('now')."""
    t = frame_time(pts_ms, now_ms)
    if t is None:
        return None, "now"
    return t, ("pts" if pts_ms is not None and t == pts_ms else "now")


def decide(cue, shown, t_ms):
    """What the overlay should do for a frame at house time t_ms.
    Returns ("show", text), ("clear", None) or None (no change).
    `shown` is the text currently set on the overlay (None when blank)."""
    if cue is None or t_ms is None:
        return ("clear", None) if shown else None
    if t_ms < cue.start:
        return None
    if t_ms >= cue.end or not cue.text:
        return ("clear", None) if shown else None
    return ("show", cue.text) if shown != cue.text else None



class PayState:
    """One subtitle stream's producer state: the floor (the last PES time sent,
    cue or keepalive) and counters. `pack(cue)` / `pack_keepalive(pes_ms)` build
    a TS chunk (CCs, PCR advance); `push(pes_ms, chunk, cue)` sends it. Stamp,
    pack and push happen under one lock, so the wire never steps back (MR-062)."""

    def __init__(self, hold_ms, pack, pack_keepalive, push):
        self.lock = threading.Lock()
        self.hold_ms, self.pack, self.pack_keepalive, self.push = hold_ms, pack, pack_keepalive, push
        self.floor = None
        self.count = 0
        self.keepalives = 0
        self.fallback_warned = False

    def _warn_once(self, from_pts):
        warn = not from_pts and not self.fallback_warned
        self.fallback_warned = self.fallback_warned or warn
        return warn

    def new_cue(self, text, pts_ms, now_ms):
        """A fresh text sample, sent once → (cue, count, warn_fallback)."""
        with self.lock:
            start, from_pts = cue_start(pts_ms, now_ms, self.floor)
            warn = self._warn_once(from_pts)
            cue = make_cue(start, text, self.hold_ms)
            self.push(cue.start, self.pack(cue), cue)
            self.floor = cue.start
            self.count += 1
            return cue, self.count, warn

    def keepalive(self, pts_ms, now_ms):
        """A source PES at `pts_ms`: → (pes_ms, warn_fallback) when a keepalive
        went out (PES time >= KEEPALIVE_MS past the floor), else None."""
        with self.lock:
            t, from_pts = cue_start(pts_ms, now_ms, self.floor)
            if t is None or (self.floor is not None and t < self.floor + KEEPALIVE_MS):
                return None
            warn = self._warn_once(from_pts)
            self.push(t, self.pack_keepalive(t), None)
            self.floor = t
            self.keepalives += 1
            return t, warn


class OverlayCues:
    """Pending cues ordered by start + the one on screen (`current`)."""

    def __init__(self, max_pending=QUEUE_MAX):
        self.lock = threading.Lock()
        self.max_pending = max_pending
        self.pending = []
        self.current = None
        self.shown = None
        self.count = 0

    def add(self, cue):
        """Queue `cue` (a Cue); False for a copy of a held one (same payload and
        start: a duplicated PES), which never moves the held cue."""
        with self.lock:
            for held in [self.current] + self.pending:
                if held is not None and held.key == cue.key and abs(held.start - cue.start) < SAME_START_MS:
                    return False
            i = bisect.bisect_right([c.start for c in self.pending], cue.start)
            self.pending.insert(i, cue)
            if len(self.pending) > self.max_pending:
                self.pending.pop(0)
            self.count += 1
            return True

    def _promote(self, t_ms):
        while self.pending and self.pending[0].start <= t_ms:
            cue = self.pending.pop(0)
            if self.current is not None and cue.start < self.current.start:
                continue                    # older than the one shown: never back
            nxt = self.pending[0] if self.pending else None
            if nxt is not None and nxt.start <= t_ms and cue.end <= t_ms:
                continue                    # over and superseded: never on screen
            self.current = cue
            return

    def frame(self, t_ms):
        """For a frame at house time t_ms → (kind, text, cue) or None; `cue`
        is the one decided on (for the trace)."""
        with self.lock:
            if t_ms is not None:
                self._promote(t_ms)
            cue = self.current
            action = decide(cue, self.shown, t_ms)
            if action is None:
                return None
            kind, text = action
            if kind == "show":
                self.shown = text
            else:
                self.shown = None
                if cue is not None and (not cue.text or (t_ms is not None and t_ms >= cue.end)):
                    self.current = None
            return kind, text, cue
