#!/usr/bin/env python3
"""sink_margin_ref.py's suite (plan ch. 15.4 B-249): the rule's cases, then a model of the 302M
output's sink end (a sync=false GstAudioSink: 10 ms segments, a 100 ms ring read one segment each
10 ms once a device that takes 40 ms at its start began, the base sink's realign and the segment in
flight lost) fed a 1 kHz tone's buffers late by
each profile of gst_302m_late_feed_test.py, five seeds each:

  - the margin (60 ms, mrasrc margin-ms): no hole after the start in the field walk (30-70 ms from
    30), a clean step 30 -> 70 ms and the old walk (from its 300 ms max); in the rising walk (30 ms
    for 10 s, then 30-300 ms) holes only while the lateness reaches past every earlier value by
    more than the margin, none once it reached its maximum; never a frame lost in any;
  - c38's sink end (a 40 ms min-threshold queue, no margin) plays holes and loses frames in the
    field walk and the rising walk; it is the model's mutant.

Then each mutant below must fail a case. Run:  python3 sink_margin_ref_test.py [--mutants]
"""
import random
import sys

import sink_margin_ref as sm

FS = 48000
SPS = 480               # 10 ms segments
SEGTOTAL = 10           # the 100 ms ring
MARGIN = 60 * FS // 1000
BUF = 480
HOLE_MIN = FS // 1000   # an all-zero run of 1 ms or more between sounding frames
DEVICE_MS = 40          # what the device takes when it starts (gst_302m_late_feed_test.py's device-ns)
START_S = 2.0

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


# --- the profiles (gst_302m_late_feed_test.py's, lateness in ms per 10 ms buffer) -------------------

def walk(n, lo, hi, first, start_i, seed):
    rng, out, cur = random.Random(seed), [], float(first)
    for i in range(n):
        out.append(cur)
        if i >= start_i:
            cur = min(hi, max(lo, cur + rng.gauss(0, 8)))
    return out


PROFILES = {
    "rising": lambda n, s: walk(n, 30.0, 300.0, 30.0, 1000, s),
    "field": lambda n, s: walk(n, 30.0, 70.0, 30.0, 0, s),
    "step": lambda n, s: [30.0 if (i < 1000 or 2500 <= i < 3000) else 70.0 for i in range(n)],
    "old": lambda n, s: walk(n, 30.0, 300.0, 300.0, 0, s),
}


# --- the sink end ----------------------------------------------------------------------------------

def simulate(late_ms, margin=MARGIN, queue_ms=0, rule=None, device_ms=DEVICE_MS):
    """Buffer i (BUF frames, stamped i x 10 ms) reaches the sink end late[i] ms after its time. The ring
    starts at its first write, when the device takes `device_ms` of it at once, then a segment each 10 ms;
    a write into a segment taken is lost, and a write waits while the ring is full. `queue_ms`: c38's
    min-threshold queue releases a buffer once that much content follows it. Returns holes after START_S,
    frames lost, the delay at the end (ms), and the stamp (s) of the buffer after each hole."""
    rule = rule or sm.silence_frames
    n = len(late_ms)
    arrive, prev = [], 0
    for i, l in enumerate(late_ms):
        prev = max(prev, int((i * 10 + l) * FS / 1000))
        arrive.append(prev)
    k = queue_ms // 10
    release = [arrive[min(n - 1, i + k - 1)] if k else arrive[i] for i in range(n)]
    dev = device_ms * FS // 1000
    ring = {}                # ring frame -> buffer index (sounding frames written in time)
    nxt, t, t0 = -1, 0, None
    written_frames = 0

    def segdone_at(t):
        return 0 if t0 is None else (t - t0 + dev) // SPS

    for i in range(n - k):
        t = max(t, release[i])
        segdone = segdone_at(t)
        sil = rule(nxt, segdone, SPS, margin) if margin else 0
        start = sm.base_write_pos(nxt, segdone, SPS) + sil
        end = start + BUF
        if t0 is None:
            t0 = t
        while (end - 1) // SPS - segdone_at(t) >= SEGTOTAL:   # a full ring blocks the write
            t = t0 - dev + ((end - 1) // SPS - SEGTOTAL + 1) * SPS
        segdone = segdone_at(t)
        for f in range(start, end):
            if f // SPS > segdone:          # not yet taken: plays
                ring[f] = i
                written_frames += 1
        nxt = end
    fed = (n - k) * BUF
    lost = fed - written_frames
    # play the ring in order: holes between sounding frames after START_S
    holes, run, sounded = 0, 0, False
    last = max(ring) if ring else 0
    first_after = int(START_S * FS)
    hole_at = []
    for f in range(0, last + 1):
        if f in ring:
            if sounded and run >= HOLE_MIN and f >= first_after:
                holes += 1
                hole_at.append(ring[f] * BUF / FS)   # the stamp of the first buffer after it
            sounded, run = True, 0
        else:
            run += 1
    delay_ms = (last + (t0 or 0) - (n - k) * BUF) * 1000 / FS
    return {"holes": holes, "lost": lost, "delay_ms": delay_ms, "hole_at": hole_at}


def first_max_s(late_ms):
    m = max(late_ms)
    return next(i for i, l in enumerate(late_ms) if l >= m) * 10 / 1000


# --- cases -----------------------------------------------------------------------------------------

def case_rule():
    print("\n--- the rule ---")
    check("a contiguous write past the segment in flight: no silence",
          sm.silence_frames(5 * SPS, 3, SPS, MARGIN) == 0)
    check("... with a frame of margin left, still none (a hole of our own otherwise)",
          sm.silence_frames(4 * SPS, 3, SPS, MARGIN) == 0)
    check("a write into the segment in flight: silence to margin past it",
          sm.silence_frames(3 * SPS + 100, 3, SPS, MARGIN) == 4 * SPS + MARGIN - (3 * SPS + 100))
    check("a write behind the read (the base sink realigns to segdone + 1): silence = the margin",
          sm.silence_frames(1 * SPS, 7, SPS, MARGIN) == MARGIN)
    check("the first write (next -1): twice the margin past the segment in flight",
          sm.silence_frames(-1, 0, SPS, MARGIN) == SPS + 2 * MARGIN and sm.silence_frames(-1, 9, SPS, MARGIN) == 2 * MARGIN)
    check("the device clock past a stale segdone moves `consumed`",
          sm.silence_frames(5 * SPS, 3, SPS, MARGIN, play_pos=6 * SPS) == 6 * SPS + MARGIN - 5 * SPS)
    check("... a clock behind it does not",
          sm.silence_frames(5 * SPS, 3, SPS, MARGIN, play_pos=2 * SPS) == 0)
    z = sm.SinkMargin(0)
    check("margin 0 (mrasrc margin-ms 0): never, not even into the segment in flight",
          z.silence(3 * SPS + 100, 3, SPS) == 0 and z.silence(-1, 0, SPS) == 0)
    m = sm.SinkMargin(MARGIN)
    m.silence(-1, 0, SPS)
    m.silence(5 * SPS, 3, SPS)
    m.silence(1 * SPS, 7, SPS)
    check(f"stats count the refills and their silence: {m.stats()}",
          m.stats() == {"refills": 2, "silence": SPS + 2 * MARGIN + MARGIN})


def case_profiles(rule=None, verbose=True):
    print("\n--- the sink end, five seeds per profile (40 s) ---")
    n = 4000
    for name, gen in PROFILES.items():
        rows39, rows38 = [], []
        for seed in range(7, 12):
            late = gen(n, seed)
            r39 = simulate(late, rule=rule)
            r38 = simulate(late, margin=0, queue_ms=40)
            rows39.append(r39)
            rows38.append(r38)
            if name == "rising":
                tmax = first_max_s(late)
                after = [h for h in r39["hole_at"] if h > tmax]
                check(f"rising seed {seed}: margin: {r39['holes']} holes, all before the walk first reached "
                      f"its max at {tmax:.1f} s ({len(after)} after), 0 lost ({r39['lost']}), "
                      f"delay at the end {r39['delay_ms']:.0f} ms", not after and r39["lost"] == 0)
            else:
                check(f"{name} seed {seed}: margin: no hole after {START_S:.0f} s ({r39['holes']}), 0 lost "
                      f"({r39['lost']}), delay at the end {r39['delay_ms']:.0f} ms",
                      r39["holes"] == 0 and r39["lost"] == 0)
        if verbose:
            print(f"  {name}: c38 holes {[r['holes'] for r in rows38]}, lost ms "
                  f"{[round(r['lost'] * 1000 / FS) for r in rows38]}; margin holes {[r['holes'] for r in rows39]}")
        if name in ("field", "rising"):
            check(f"{name}: c38's sink end (40 ms queue, no margin) plays holes and loses frames "
                  f"({sum(r['holes'] for r in rows38)} holes, "
                  f"{sum(r['lost'] for r in rows38) * 1000 // FS} ms lost over five seeds)",
                  sum(r["holes"] for r in rows38) > 0 and sum(r["lost"] for r in rows38) > 0)


# --- mutants: each must fail a case ----------------------------------------------------------------

def _m_inflight_ok(nxt, segdone, sps, margin, play_pos=None):
    """The segment in flight counted as playable (the base sink's own test)."""
    c = segdone * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_start_only(nxt, segdone, sps, margin, play_pos=None):
    """The margin at the first write only: no re-prefill after a hole."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos) if nxt < 0 else 0


def _m_eager(nxt, segdone, sps, margin, play_pos=None):
    """Silence whenever less than the margin is left: holes of its own."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c + margin:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_from_next(nxt, segdone, sps, margin, play_pos=None):
    """The silence counted from next_sample, not where the base sink realigns: the margin lost."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - max(nxt, 0)) if nxt >= 0 and nxt // sps >= segdone else 0


def _m_start_single(nxt, segdone, sps, margin, play_pos=None):
    """One margin at a start: the device's own buffer comes out of it."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos) if nxt >= 0 else \
        max(0, (segdone + 1) * sps + margin - sm.base_write_pos(nxt, segdone, sps))


MUTANTS = {"start-single": _m_start_single, "inflight-ok": _m_inflight_ok, "start-only": _m_start_only, "eager": _m_eager,
           "from-next": _m_from_next}


def run_suite(rule=None):
    global _failures
    _failures = 0
    if rule is None:
        case_rule()
    case_profiles(rule, verbose=rule is None)
    return _failures


def main(argv):
    if "--mutants" in argv:
        ok = True
        for name, fn in MUTANTS.items():
            fails = run_suite(fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        print("ALL MUTANTS CAUGHT" if ok else "A MUTANT SURVIVED")
        return 0 if ok else 1
    fails = run_suite()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
