#!/usr/bin/env python3
"""`subtitle_cues`: cue helpers (construction, wire form, frame time, t0,
show/clear decision), the consumer queue (order, dedupe, bound), the producer
state and both locks under forced interleaving, the stale re-send gate.
Run: python3 subtitle_cues_test.py
"""
import threading

import subtitle_cues as sc
import subtitle_klv as klv
from subtitle_testlib import check

check("live cue", sc.make_cue(1000.4, "x", 8000) == sc.Cue(1000, 9000, "x"))
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
check("re-send is a byte-identical repeat on the same PTS",
      sc.wire_cue(live) == sc.wire_cue(sc.Cue(*live)) and klv.encode_cue(*sc.wire_cue(live)[1]) == first)
check("clear stamped at its own content time", sc.wire_cue(sc.make_cue(6100.4, "", 3000)) == (6100, (0, 0, "")))
last, ptses = None, []
for pts, now in [(1000, 1900), (2500, 3400), (None, 3500), (2600, 4400), (5000, 5900)]:
    start, _ = sc.cue_start(pts, now, last)
    cue = sc.make_cue(start, "x", 8000)
    last = cue.start
    ptses += [sc.wire_cue(cue)[0]] * 2          # first send + one re-send
check("PES PTS monotone across cues (fallback then content time)",
      ptses == sorted(ptses) and ptses[-1] == 5000)
check("t0: chunk stamp wins", sc.cue_t0(4000, 7000, 5000) == (4000, "chunk"))
check("t0: far chunk stamp -> pts", sc.cue_t0(90_000, 4900, 5000) == (4900, "pts"))
check("t0: no chunk, far pts -> now", sc.cue_t0(None, 90_000, 5000) == (5000, "now"))
check("t0: nothing at all", sc.cue_t0(None, None, None) == (None, "now"))
check("t0 + span: re-sends land on one window",
      sc.absolute_cue((0, 3000, "Hi"), sc.cue_t0(4000, 4800, 6000)[0]) == sc.Cue(4000, 7000, "Hi"))
check("is_resend: a copy of the last payload within the gap", sc.is_resend(b"k", b"k", 2000))


def run_frames(q, t_from, t_to, step=40):
    out = []
    for t in range(t_from, t_to + 1, step):
        r = q.frame(float(t))
        if r:
            out.append((t, r[0], r[1]))
    return out


q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "chunk"))
q.add(sc.Cue(1100.0, 4100.0, "B", b"b", "chunk"))          # both queued ~1.4 s before their frames
check("queue: two cues 100 ms apart both draw, in order",
      run_frames(q, 960, 1200) == [(1000, "show", "A"), (1120, "show", "B")])
q = sc.OverlayCues()
for c in (sc.Cue(1000.0, 9000.0, "A", b"a", "chunk"), sc.Cue(2000.0, 2000.0, "", b"c", "chunk"),
          sc.Cue(2120.0, 9120.0, "B", b"b", "chunk")):
    q.add(c)
check("queue: cue, clear, next cue all applied on their frames",
      run_frames(q, 960, 2200) == [(1000, "show", "A"), (2000, "clear", None), (2120, "show", "B")])
q = sc.OverlayCues()
check("queue: a re-send (same key + start) is not queued twice",
      q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "chunk")) and not q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "chunk"))
      and len(q.pending) == 1)
check("queue: an arrival-anchored re-send within the gap is not re-queued",
      q.add(sc.Cue(1000.0, 4000.0, "Z", b"z", "now"), 1000.0)
      and not q.add(sc.Cue(1500.0, 4500.0, "Z", b"z", "now"), 1500.0) and len(q.pending) == 2)
q.pending.pop()
run_frames(q, 1000, 1000)
check("queue: nor once it is on screen", not q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "chunk")) and not q.pending)
q = sc.OverlayCues()
check("queue: arrival-anchored re-send 2 s after the last copy is deduped",
      q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "now"), 1000.0)
      and not q.add(sc.Cue(3000.0, 11000.0, "A", b"a", "now"), 3000.0))
check("queue: an identical cue 9 s after the last copy is a NEW cue",
      q.add(sc.Cue(12000.0, 20000.0, "A", b"a", "now"), 12000.0) and len(q.pending) == 2)
check("is_resend: another key is never a re-send", not sc.is_resend(b"b", b"a", 100))
check("is_resend: nothing held is never a re-send", not sc.is_resend(b"a", None, 100))
check("is_resend: past the re-send gap is a new cue", not sc.is_resend(b"a", b"a", 2600)
      and sc.is_resend(b"a", b"a", 2400) and not sc.is_resend(b"a", b"a", None))
# A hop that re-stamps private PES at arrival: each re-send lands ~2 s later.
q = sc.OverlayCues()
q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "chunk"), 1000.0)
check("queue: restamped re-sends at +2 s / +4 s (drifting starts) are re-sends, any t0 source",
      not q.add(sc.Cue(3000.0, 11000.0, "A", b"a", "chunk"), 3000.0)
      and not q.add(sc.Cue(5020.0, 13020.0, "A", b"a", "pts"), 5020.0) and len(q.pending) == 1)
check("queue: ... so the cue keeps its original [start, end)",
      run_frames(q, 960, 13100, 20) == [(1000, "show", "A"), (9000, "clear", None)])
check("queue: the same payload after the gap is a new cue",
      q.add(sc.Cue(20000.0, 28000.0, "A", b"a", "chunk"), 20000.0) and len(q.pending) == 1)
q = sc.OverlayCues()
check("queue: clears are never re-sent — identical clears 2.4 s apart both apply",
      q.add(sc.Cue(1000.0, 1000.0, "", b"c", "chunk"), 1000.0)
      and q.add(sc.Cue(3400.0, 3400.0, "", b"c", "chunk"), 3400.0) and len(q.pending) == 2)
q = sc.OverlayCues()
for n in range(20):
    q.add(sc.Cue(1000.0 + n, 2000.0 + n, f"c{n}", bytes([n]), "chunk"))
check("queue: bounded at 16, oldest dropped", len(q.pending) == 16 and q.pending[0].text == "c4")
q = sc.OverlayCues()
q.add(sc.Cue(2000.0, 9000.0, "B", b"b", "chunk"))
run_frames(q, 2000, 2000)
q.add(sc.Cue(1000.0, 9000.0, "A", b"a", "chunk"))          # a late re-send of an older cue
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
q.add(sc.Cue(1000.0, 4000.0, "A", b"a", "chunk"))
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


early, added = interleave(frame_parked, lambda: q.add(sc.Cue(1100.0, 4100.0, "B", b"b", "chunk")))
check("lock: a cue arriving while a frame decides waits for it, then is queued",
      not early and added and q.current.text == "A" and [c.text for c in q.pending] == ["B"])

packed = []


def make_pay():
    gate = {}

    def pack(cue):
        if gate.get("park"):
            inside, release = gate.pop("park")
            inside.set()
            release.wait(2)
        packed.append(cue[0])
        return b"chunk"
    return sc.PayState(8000, pack), gate


pay, gate = make_pay()
pay.new_cue("old", 1000.0, 1100.0)


def resend_parked(inside, release):
    gate["park"] = (inside, release)
    pay.resend(1500.0)


early, made = interleave(resend_parked, lambda: pay.new_cue("new", 1400.0, 1500.0))
check("lock: a new cue waits while the re-send timer packs the old one; state ends on the new",
      not early and packed == [1000, 1000, 1400] and pay.current[2] == "new" and made[0][0] == 1400)
g = sc.StartGate()
check("gate: the re-send that lost its race (old start after a newer cue) is dropped",
      g.admit(1000) and g.admit(1400) and not g.admit(1000) and g.admit(1400) and g.dropped == 1)
print("all subtitle_cues tests passed")
