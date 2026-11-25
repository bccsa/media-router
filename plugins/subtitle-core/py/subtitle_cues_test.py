#!/usr/bin/env python3
"""`subtitle_cues`: cue helpers (construction, wire form, frame time, t0,
show/clear decision), the consumer queue (order, dedupe, bound), the producer
state (cues sent once, keepalives on the source PES time, one floor) and both
locks under forced interleaving (MR-062).
Run: python3 subtitle_cues_test.py
"""
import inspect
import threading

import subtitle_cues as sc
import subtitle_klv as klv
from subtitle_testlib import check

check("live cue, its start as given (WI-P3-8: the PES PTS is the source's)",
      sc.make_cue(1000.4, "x", 8000) == sc.Cue(1000.4, 9000.4, "x"))
check("clear cue", sc.make_cue(1000, "", 8000) == sc.Cue(1000, 1000, ""))
check("negative hold clamps", sc.make_cue(1000, "x", -5) == sc.Cue(1000, 1000, "x"))

# Wire times are relative to the carrying PES (sent at `now`).
check("relative: running cue shows from +0 with its remaining span",
      sc.relative_cue(sc.Cue(1000, 4800, "Hi"), 2000) == (0, 2800, "Hi"))
check("relative: future cue keeps its lead", sc.relative_cue(sc.Cue(3000, 4000, "Hi"), 2000) == (1000, 2000, "Hi"))
check("relative: past end never goes negative", sc.relative_cue(sc.Cue(1000, 1500, "Hi"), 2000) == (0, 0, "Hi"))
check("relative: clear cue stays (0, 0, '')", sc.relative_cue(sc.Cue(2000, 2000, ""), 2000) == (0, 0, ""))
check("absolute: anchors on the receiver's own time", sc.absolute_cue((0, 2800, "Hi"), 90_000) == sc.Cue(90_000, 92_800, "Hi"))
check("round trip on another clock lands the same span",
      sc.absolute_cue(sc.relative_cue(sc.Cue(1000, 4800, "Hi"), 2000), 500_000) == sc.Cue(500_000, 502_800, "Hi"))
check("frame time trusts aligned pts", sc.frame_time(5000, 5300) == 5000)
check("frame time falls back to now", sc.frame_time(5000, 90_000) == 90_000)
check("frame time no pts", sc.frame_time(None, 42) == 42)

cue = sc.Cue(1000, 4000, "Hi")
check("before start: nothing", sc.decide(cue, None, 999) is None)
check("at start: show", sc.decide(cue, None, 1000) == ("show", "Hi"))
check("in range, already shown: nothing", sc.decide(cue, "Hi", 2500) is None)
check("in range, other text shown: show new", sc.decide(cue, "old", 2500) == ("show", "Hi"))
check("at end: clear", sc.decide(cue, "Hi", 4000) == ("clear", None))
check("past end, blank: nothing", sc.decide(cue, None, 5000) is None)
check("clear cue clears", sc.decide(sc.Cue(3000, 3000, ""), "Hi", 3000) == ("clear", None))
check("clear cue before start waits", sc.decide(sc.Cue(3000, 3000, ""), "Hi", 2999) is None)
check("no cue, blank: nothing", sc.decide(None, None, 10) is None)
check("no cue, shown: clear", sc.decide(None, "Hi", 10) == ("clear", None))
check("no time: clear if shown", sc.decide(cue, "Hi", None) == ("clear", None))


# Content-timed cues (ADR-0016 2026-10-09)
check("start from buffer pts", sc.cue_start(4000, 5050) == (4000, True))
check("start falls back to now when pts is far", sc.cue_start(4000, 90_000) == (90_000, False))
check("start falls back to now without pts", sc.cue_start(None, 5050) == (5050, False))
check("start never below the last one", sc.cue_start(4000, 5050, 4500) == (4500, True))
live = sc.make_cue(4000, "Hi", 3000)
check("wire: PES on the start, block 0 --> hold", sc.wire_cue(live) == (4000, (0, 3000, "Hi")))
first = klv.encode_cue(*sc.wire_cue(live)[1])
check("wire: the block is the cue's alone, byte for byte",
      sc.wire_cue(live) == sc.wire_cue(sc.Cue(*live)) and klv.encode_cue(*sc.wire_cue(live)[1]) == first)
check("clear stamped at its own content time", sc.wire_cue(sc.make_cue(6100.4, "", 3000)) == (6100.4, (0, 0, "")))
sub_ms = sc.make_cue(15_960_771.755556, "Hi", 8000)     # an OCC teletext PES time, 68 ticks past a ms
check("wire: a sub-ms start keeps its block 0 --> hold, byte for byte",
      sc.wire_cue(sub_ms) == (15_960_771.755556, (0, 8000, "Hi"))
      and klv.encode_cue(*sc.wire_cue(sub_ms)[1]) == klv.encode_cue(0, 8000, "Hi"))
last, ptses = None, []
for pts, now in [(1000, 1900), (2500, 3400), (None, 3500), (2600, 4400), (5000, 5900)]:
    start, _ = sc.cue_start(pts, now, last)
    cue = sc.make_cue(start, "x", 8000)
    last = cue.start
    ptses.append(sc.wire_cue(cue)[0])
check("PES PTS monotone across cues (fallback then content time)",
      ptses == sorted(ptses) and ptses[-1] == 5000)
# A received cue anchors on its demuxed PTS, its PES time on the house timeline (WI-P3-7).
check("t0: the pts near now", sc.cue_t0(4900, 5000) == (4900, "pts") and sc.cue_t0(5400, 5000) == (5400, "pts"))
check("t0: the pts at the tolerance's edge", sc.cue_t0(15_000, 5000) == (15_000, "pts"))
check("t0: a far pts -> now", sc.cue_t0(90_000, 5000) == (5000, "now") and sc.cue_t0(15_001, 5000) == (5000, "now"))
check("t0: no pts -> now", sc.cue_t0(None, 5000) == (5000, "now"))
check("t0: nothing at all", sc.cue_t0(None, None) == (None, "now"))
check("t0: the pts and now only, no chunk stamp",
      list(inspect.signature(sc.cue_t0).parameters) == ["pts_ms", "now_ms"])
check("t0 + span: the cue lands on its window",
      sc.absolute_cue((0, 3000, "Hi"), sc.cue_t0(4000, 6000)[0]) == sc.Cue(4000, 7000, "Hi"))
check("no re-send machinery left (MR-062)",
      not any(hasattr(sc, n) for n in ("RESEND_MS", "RESEND_GAP_MS", "is_resend", "StartGate"))
      and not hasattr(sc.PayState, "resend")
      and list(inspect.signature(sc.OverlayCues.add).parameters) == ["self", "cue"])


def run_frames(q, t_from, t_to, step=40):
    out = []
    for t in range(t_from, t_to + 1, step):
        r = q.frame(float(t))
        if r:
            out.append((t, r[0], r[1]))
    return out


q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "pts"))
q.add(sc.Cue(1100.0, 4100.0, "B", b"b", "pts"))          # both queued ~1.4 s before their frames
check("queue: two cues 100 ms apart both draw, in order",
      run_frames(q, 960, 1200) == [(1000, "show", "A"), (1120, "show", "B")])
q = sc.OverlayCues()
for c in (sc.Cue(1000.0, 9000.0, "A", b"a", "pts"), sc.Cue(2000.0, 2000.0, "", b"c", "pts"),
          sc.Cue(2120.0, 9120.0, "B", b"b", "pts")):
    q.add(c)
check("queue: cue, clear, next cue all applied on their frames",
      run_frames(q, 960, 2200) == [(1000, "show", "A"), (2000, "clear", None), (2120, "show", "B")])
q = sc.OverlayCues()
check("queue: a duplicated PES (same key + start) is not queued twice",
      q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "pts")) and not q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "pts"))
      and len(q.pending) == 1)
run_frames(q, 1000, 1000)
check("queue: nor once it is on screen", not q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "pts")) and not q.pending)
# Test 10 (K6, no gap rule): an identical cue on a new start is a new cue, however soon.
q = sc.OverlayCues()
check("queue: an identical cue 500 ms or 2.4 s later (new start) is queued, any t0 source",
      q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "now")) and q.add(sc.Cue(1500.0, 9500.0, "A", b"a", "now"))
      and q.add(sc.Cue(3400.0, 11400.0, "A", b"a", "pts")) and len(q.pending) == 3)
q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 3000.0, "A", b"a", "pts"))
q.add(sc.Cue(3000.0, 3000.0, "", b"c", "pts"))
q.add(sc.Cue(4000.0, 6000.0, "A", b"a", "pts"))          # the same text again, 3 s on (2 s after its clear)
check("queue: the same text after a clear shows again on its own frame",
      run_frames(q, 960, 6100) == [(1000, "show", "A"), (3000, "clear", None), (4000, "show", "A"),
                                   (6000, "clear", None)])
# Test 11 (K6): cue streams never cross versions, so a v104 re-send is out of scope; its
# same-PES copies are still caught by the same-start dedupe.
q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "pts"))
check("queue: a v104 re-send (the same PES again) never stretches the cue",
      not q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "pts")) and not q.add(sc.Cue(1000.4, 9000.4, "A", b"a", "pts"))
      and run_frames(q, 960, 9100, 20) == [(1000, "show", "A"), (9000, "clear", None)])
q = sc.OverlayCues()
check("queue: identical clears 2.4 s apart both apply",
      q.add(sc.Cue(1000.0, 1000.0, "", b"c", "pts"))
      and q.add(sc.Cue(3400.0, 3400.0, "", b"c", "pts")) and len(q.pending) == 2)
q = sc.OverlayCues()
for n in range(20):
    q.add(sc.Cue(1000.0 + n, 2000.0 + n, f"c{n}", bytes([n]), "pts"))
check("queue: bounded at 16, oldest dropped", len(q.pending) == 16 and q.pending[0].text == "c4")
q = sc.OverlayCues()
q.add(sc.Cue(2000.0, 9000.0, "B", b"b", "pts"))
run_frames(q, 2000, 2000)
q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "pts"))          # an older cue arriving late
check("queue: an older cue arriving late never replaces the one shown",
      run_frames(q, 2040, 2200) == [] and q.current.text == "B")


def interleave(hold_inside, other):
    """Thread A parks inside a critical section (hold_inside(release) blocks);
    thread B runs `other`. → (B finished while A held the lock, B result)."""
    inside, release, done = threading.Event(), threading.Event(), threading.Event()
    res = {}
    ta = threading.Thread(target=hold_inside, args=(inside, release))
    ta.start()
    inside.wait(2)
    tb = threading.Thread(target=lambda: (res.setdefault("b", other()), done.set()))
    tb.start()
    early = done.wait(0.2)
    release.set()
    ta.join(2)
    tb.join(2)
    return early, res.get("b")


q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "pts"))
real_decide = sc.decide


def parked_decide(inside, release):
    def d(*a):
        inside.set()
        release.wait(2)
        return real_decide(*a)
    return d


def frame_parked(inside, release):
    sc.decide = parked_decide(inside, release)
    try:
        q.frame(1000.0)
    finally:
        sc.decide = real_decide


early, added = interleave(frame_parked, lambda: q.add(sc.Cue(1100.0, 4100.0, "B", b"b", "pts")))
check("lock: a cue arriving while a frame decides waits for it, then is queued",
      not early and added and q.current.text == "A" and [c.text for c in q.pending] == ["B"])

# --- producer: PayState (MR-062) ---------------------------------------------------
class Wire:
    """A PayState's packer and appsrc: every push in order, (pes_ms, kind, text)."""

    def __init__(self, hold=8000):
        self.out, self.park = [], None
        self.pay = sc.PayState(hold, self.pack, self.pack_keepalive, self.push)

    def pack(self, cue):
        if self.park:
            inside, release = self.park
            self.park = None
            inside.set()
            release.wait(2)
        return ("cue", cue.text)

    def pack_keepalive(self, pes_ms):
        return ("keepalive", None)

    def push(self, pes_ms, chunk, cue):
        assert (cue is None) == (chunk[0] == "keepalive")
        self.out.append((pes_ms, *chunk))

    def pes(self, t_ms, now_ms=None):
        """One source PES at t_ms (house now = t + 34 ms, the gate's cue path)."""
        return self.pay.keepalive(t_ms, t_ms + 34 if now_ms is None else now_ms)

    def cue(self, text, t_ms, now_ms=None):
        return self.pay.new_cue(text, t_ms, t_ms + 34 if now_ms is None else now_ms)

    def kinds(self):
        return [k for _, k, _ in self.out]

    def times(self, kind=None):
        return [t for t, k, _ in self.out if kind in (None, k)]


def feed(w, t_from, t_to, step=40, cues=()):
    """PES every `step` ms in [t_from, t_to); a cue (t, text) is decoded off the PES at t,
    after the probe saw it (teletextdec runs behind its sink probe)."""
    at = dict(cues)
    for t in range(t_from, t_to, step):
        w.pes(float(t))
        if t in at:
            w.cue(at[t], float(t))


# Test 1: a held cue is sent once.
w = Wire(hold=30_000)
feed(w, 0, 30_000, cues=[(1000, "Held")])
check("pay: a cue held 30 s is sent once (no re-send)",
      [x for x in w.out if x[1] == "cue"] == [(1000.0, "cue", "Held")])
# Test 2: keepalives only while PES flow; about one per second of PES time.
gaps = [b - a for a, b in zip(w.times(), w.times()[1:])]
check("pay: keepalives about every 1 s while PES flow (1000-1040 ms at 25 PES/s), none closer",
      w.times("keepalive")[0] == 0.0 and all(1000 <= g <= 1040 for g in gaps[2:]) and min(gaps) >= 0
      and 28 <= w.pay.keepalives <= 30)
n = len(w.out)
w.cue("", 31_000.0)                                      # the source's last text, then no PES
check("pay: no PES, no keepalive (nothing is timer-driven)", len(w.out) == n + 1 and w.out[-1][1] == "cue"
      and not any(hasattr(sc.PayState, a) for a in ("resend", "tick", "timer")))
w2 = Wire()
feed(w2, 0, 5000)
feed(w2, 20_000, 23_000)                                 # PES again after 15 s without
check("pay: keepalives stop with the PES and resume on its first return",
      w2.times() == [0, 1000, 2000, 3000, 4000, 20_000, 21_000, 22_000])
# Test 3: a keepalive's PTS is the latest PES time and never steps back.
w3 = Wire()
for t in (0.0, 600.0, 1000.4, 1500.0, 900.0, 2000.0, 2000.4, 1800.0, 2500.0, 3100.7):
    w3.pes(t)
check("pay: a keepalive sits on the PES time that triggered it, never behind the last",
      w3.times() == [0.0, 1000.4, 2000.4, 3100.7])
# Test 4: a cue right after a keepalive is admitted and not below it.
w4 = Wire()
w4.pes(5000.0)
cue_a, count, warn = w4.cue("A", 5000.0)                 # the same PES the keepalive went out on
cue_b, _, _ = w4.cue("B", 4980.0)                        # text whose PTS lags the last keepalive
check("pay: a cue on the keepalive's PES time is sent on it; one stamped earlier lifts to the floor",
      w4.out == [(5000.0, "keepalive", None), (5000.0, "cue", "A"), (5000.0, "cue", "B")]
      and (cue_a.start, cue_b.start, count, warn) == (5000.0, 5000.0, 1, False))
w4.pes(5400.0)
w4.pes(6000.0)
check("pay: a cue resets the keepalive interval (the next is 1 s past the cue)",
      w4.times("keepalive") == [5000.0, 6000.0])
# Test 5: a keepalive is never below the last cue start, including under the fallback.
w5 = Wire()
w5.cue("A", None, 7000.0)                                # no PTS: the cue starts on house-now
check("pay: a cue without PTS falls back to now (warned once)",
      w5.out == [(7000.0, "cue", "A")] and w5.pay.fallback_warned)
w5.pes(6990.0, 7010.0)                                   # PES time below the cue's fallback start
w5.pes(None, 7500.0)                                     # no PTS, now 0.5 s on: too soon
w5.pes(50_000.0, 8020.0)                                 # PTS 42 s off house-now: now
w5.pes(8100.0, 8130.0)
w5.pes(9050.0, 9080.0)
check("pay: keepalives follow cue_start's fallback and never sit below the last cue start",
      w5.out == [(7000.0, "cue", "A"), (8020.0, "keepalive", None), (9050.0, "keepalive", None)])
w5b = Wire()
w5b.cue("A", 7000.0)
w5b.pes(None, 8100.0)
check("pay: a keepalive in the fallback warns once, sharing the cue's flag",
      w5b.out[-1] == (8100.0, "keepalive", None) and w5b.pay.fallback_warned
      and w5b.pes(None, 9200.0) == (9200.0, False))
# Test 6 is in subtitle_bridge_test.py (the real packer: wire PES PTS, PCR, CCs).
# Test 19 (status): while a cue is held, every send reads the cue path's lateness, not the cue's age.
w19 = Wire(hold=30_000)
feed(w19, 0, 40_000, cues=[(2000, "Held"), (32_000, "")])
check("status: while a cue is held 30 s, a keepalive each second on the current PES time (34 ms late, no 2-30 s ages)",
      w19.times("keepalive") == [float(t) for t in range(0, 40_000, 1000)]
      and [x for x in w19.out if x[1] == "cue"] == [(2000.0, "cue", "Held"), (32_000.0, "cue", "")])
# Test 18 (status, unit part): 5 min of PES and no cue keep a send every <= 1.04 s (the
# stop half: "no PES, no keepalive" above; the 6 s rule: latenessReporter.test.ts).
w18 = Wire()
feed(w18, 0, 300_000)
t18 = w18.times()
check("status: 5 min without cues keep the stream live (a send at least every 1.04 s, ~300 of them)",
      max(b - a for a, b in zip(t18, t18[1:])) <= 1040 and 290 <= len(t18) <= 300
      and t18[-1] >= 300_000 - 1040)


def keepalive_parked(inside, release):
    w6.park = (inside, release)
    w6.cue("old", 1000.0)


w6 = Wire()
early, made = interleave(keepalive_parked, lambda: w6.pes(2400.0))
check("lock: a keepalive waits while a cue packs and pushes; it then sits past the cue's floor",
      not early and made == (2400.0, False) and w6.out == [(1000.0, "cue", "old"), (2400.0, "keepalive", None)])
w6b = Wire()
early, made = interleave(lambda i, r: (setattr(w6b, "park", (i, r)), w6b.cue("A", 3000.0)),
                         lambda: w6b.pes(2500.0))
check("lock: a keepalive on an older PES racing a cue is held to the floor and not sent",
      not early and made is None and w6b.out == [(3000.0, "cue", "A")])
print("all subtitle_cues tests passed")
