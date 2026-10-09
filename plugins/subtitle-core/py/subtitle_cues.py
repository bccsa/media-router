"""Cue logic of the subtitle bridge: pure helpers plus the two thread-shared
states, each under one lock — `PayState` (producer: the live cue, packed under
the lock; pushes outside it, `StartGate` drops a re-send that lost its race)
and `OverlayCues` (consumer: cues queued by start, promoted per video frame).
ADR-0016 amendment 2026-10-09. Pure stdlib.
"""
import bisect
import threading
from collections import OrderedDict, namedtuple

RESEND_MS = 2000
# An arrival-anchored copy of a held cue this soon after its last copy is a re-send.
RESEND_GAP_MS = RESEND_MS + 500
ARRIVALS_MAX = 64
FRAME_TIME_TOLERANCE_MS = 10_000
QUEUE_MAX = 16
SAME_START_MS = 1.0

# A cue: house times (ms) and text; the consumer adds its payload key and t0 source.
Cue = namedtuple("Cue", "start end text key src", defaults=(None, None))


def make_cue(start_ms, text, hold_ms):
    """A live cue runs from start for hold_ms; a clear is a zero-length cue at start."""
    start = int(round(start_ms))
    if not text:
        return Cue(start, start, "")
    return Cue(start, start + max(0, int(hold_ms)), text)


def cue_start(pts_ms, now_ms, floor_ms=None):
    """(start_ms, from_pts): the text buffer's PTS (its content time) when it
    is within FRAME_TIME_TOLERANCE_MS of house-now, else now; never below
    `floor_ms` (the previous cue's start), so the KLV PES PTS never steps back."""
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
    """(PES PTS ms, relative block) for EVERY send of `cue`: the PES sits on
    the cue's start and the block is `0 --> (end − start)`, so a re-send is a
    byte-identical repeat on the same PTS."""
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


def cue_t0(chunk_ms, pts_ms, now_ms):
    """(t0_ms, source) a received cue anchors on: the stamp of the bus chunk
    its PES started in ('chunk'), else its demuxed PTS ('pts'), else arrival
    ('now') — each only when near house-now."""
    if chunk_ms is not None and now_ms is not None and abs(chunk_ms - now_ms) <= FRAME_TIME_TOLERANCE_MS:
        return chunk_ms, "chunk"
    t = frame_time(pts_ms, now_ms)
    if t is None:
        return None, "now"
    return t, ("pts" if pts_ms is not None and t == pts_ms else "now")


def is_resend(key, last_key, gap_ms):
    """A copy of the last cue with this payload, within a re-send gap of it —
    whatever its t0 source (a restamping hop moves a re-send's start)."""
    return key is not None and key == last_key and gap_ms is not None and gap_ms <= RESEND_GAP_MS


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
    """One subtitle stream's producer state: the live cue, the last start (the
    floor), counters. `pack(cue)` builds its TS chunk (CCs advance)."""

    def __init__(self, hold_ms, pack):
        self.lock = threading.Lock()
        self.hold_ms, self.pack = hold_ms, pack
        self.current = None
        self.last_start = None
        self.count = 0
        self.fallback_warned = False

    def new_cue(self, text, pts_ms, now_ms):
        """→ (cue, chunk, count, warn_fallback) for a fresh text sample."""
        with self.lock:
            start, from_pts = cue_start(pts_ms, now_ms, self.last_start)
            warn = not from_pts and not self.fallback_warned
            self.fallback_warned = self.fallback_warned or warn
            cue = make_cue(start, text, self.hold_ms)
            self.last_start = cue.start
            self.current = cue if text else None
            self.count += 1
            return cue, self.pack(cue), self.count, warn

    def resend(self, now_ms):
        """→ (cue, chunk) to re-send, or None (no live cue / it has ended)."""
        with self.lock:
            cue = self.current
            if cue is None:
                return None
            if now_ms >= cue.end:
                self.current = None
                return None
            return cue, self.pack(cue)


class StartGate:
    """Cue starts leaving the appsrc never step back: a chunk older than one
    already out (a re-send that lost its race) is dropped."""

    def __init__(self):
        self.lock = threading.Lock()
        self.high = None
        self.dropped = 0

    def admit(self, start):
        with self.lock:
            if self.high is not None and start < self.high:
                self.dropped += 1
                return False
            self.high = start
            return True


class OverlayCues:
    """Pending cues ordered by start + the one on screen (`current`)."""

    def __init__(self, max_pending=QUEUE_MAX):
        self.lock = threading.Lock()
        self.max_pending = max_pending
        self.pending = []
        self.current = None
        self.shown = None
        self.count = 0
        self.arrivals = OrderedDict()       # key -> arrival (ms) of its last copy

    def add(self, cue, now_ms=None):
        """Queue `cue` (a Cue) arriving at `now_ms`; False for a re-send: the same
        start as a held copy, or (clears aside — they are never re-sent) a
        same-payload copy within a re-send gap. A re-send never moves the held cue."""
        with self.lock:
            last = self.arrivals.get(cue.key)
            gap = None if now_ms is None or last is None else now_ms - last
            if now_ms is not None:
                self.arrivals[cue.key] = now_ms
                self.arrivals.move_to_end(cue.key)
                while len(self.arrivals) > ARRIVALS_MAX:
                    self.arrivals.popitem(last=False)
            for held in [self.current] + self.pending:
                if held is not None and held.key == cue.key and abs(held.start - cue.start) < SAME_START_MS:
                    return False
            if cue.text and is_resend(cue.key, cue.key if last is not None else None, gap):
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
                continue                    # older than the one shown: late re-send
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
