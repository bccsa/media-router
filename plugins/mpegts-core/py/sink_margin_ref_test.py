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
    field walk and the rising walk; it is the model's mutant;
  - a model of pulsesink on a server (the c39 review's blocking 1): the server reads a quantum ahead
    (512, 1024 frames: the dev Pi's) plus the sink's latency (0; 20 ms where segdone moves), drops a
    write behind its read index, holds 60 ms, and its clock is interpolated from timing updates 1.5 s
    apart; the feed steps to land 0-30 ms ahead of the clock (the edge profile, five seeds): with the
    guard nothing is lost, every hole has a refill, at most one a step; with no guard frames are
    lost; a guard past what the stream holds refills without end.

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

def case_rule(rule=None):
    print("\n--- the rule ---")
    f = rule or sm.silence_frames
    check("a contiguous write past the segment in flight: no silence",
          f(5 * SPS, 3, SPS, MARGIN) == 0)
    check("... with a frame of margin left, still none (a hole of our own otherwise)",
          f(4 * SPS, 3, SPS, MARGIN) == 0)
    check("a write into the segment in flight: silence to margin past it",
          f(3 * SPS + 100, 3, SPS, MARGIN) == 4 * SPS + MARGIN - (3 * SPS + 100))
    check("a write behind the read (the base sink realigns to segdone + 1): silence = the margin",
          f(1 * SPS, 7, SPS, MARGIN) == MARGIN)
    check("the first write (next -1): twice the margin past the segment in flight",
          f(-1, 0, SPS, MARGIN) == SPS + 2 * MARGIN and f(-1, 9, SPS, MARGIN) == 2 * MARGIN)
    check("the device clock past a stale segdone moves `consumed`",
          f(5 * SPS, 3, SPS, MARGIN, play_pos=6 * SPS) == 6 * SPS + MARGIN - 5 * SPS)
    check("... a clock behind it does not",
          f(5 * SPS, 3, SPS, MARGIN, play_pos=2 * SPS) == 0)
    check("the guard moves `consumed` past the clock: a write less than the guard ahead gets silence",
          f(6 * SPS, 3, SPS, MARGIN, play_pos=5 * SPS, guard=2 * SPS) == 7 * SPS + MARGIN - 6 * SPS
          and f(7 * SPS, 3, SPS, MARGIN, play_pos=5 * SPS, guard=2 * SPS) == 0)
    check("... no guard without a clock (before the first render)",
          f(5 * SPS, 3, SPS, MARGIN, guard=10 * SPS) == 0)
    check("a start: the margin plus the larger of the margin and the guard",
          f(-1, 0, SPS, MARGIN, guard=SPS) == SPS + 2 * MARGIN
          and f(-1, 0, SPS, MARGIN, guard=2 * MARGIN) == SPS + 3 * MARGIN)
    check("after a flush while the device plays (next -1, a clock): the start's silence past the clock and guard, "
          "from where the base sink writes (pulsesink 1.22: frame 0)",
          f(-1, 0, SPS, MARGIN, play_pos=3_000_000, guard=SPS) == 3_000_000 + SPS + 2 * MARGIN
          and f(-1, 7, SPS, MARGIN, play_pos=2 * SPS) == 2 * MARGIN)
    if rule is not None:
        return
    check("the server's configured latency: tlength less two minreq (60 ms, 10 ms: 40 ms)",
          sm.server_latency_frames(6 * SPS, SPS) == 4 * SPS and sm.server_latency_frames(SPS, SPS) == 0)
    g = sm.SinkGuard(4 * SPS, 500 * FS // 1000)
    g.segdone_seen(0, SPS, 100)
    check("while segdone has not moved (1.22): the configured latency", g.frames() == 4 * SPS)
    g.segdone_seen(12, SPS, 11 * SPS + 100)
    check("... a read index's ceiling within a segment of the clock: still that", g.frames() == 4 * SPS)
    g.segdone_seen(12, SPS, 12 * SPS - 900)
    g.segdone_seen(12, SPS, 12 * SPS - 600)
    check(f"... ahead by more: the sink's latency learned, its largest less the ceiling's segment ({g.frames()})",
          g.frames() == 4 * SPS + 900 - SPS)
    g.segdone_seen(1 << 30, SPS, 0)
    check("... capped (500 ms)", g.frames() == 500 * FS // 1000)
    check("the guard holds a write that came straight through, not one that waited a segment in the queue or "
          "followed a push that blocked",
          sm.guard_applies(0, 0, 10 * 10**6) and sm.guard_applies(9_999_999, 1_999_999, 10 * 10**6)
          and not sm.guard_applies(10 * 10**6, 0, 10 * 10**6) and not sm.guard_applies(0, 2 * 10**6, 10 * 10**6))
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


# --- pulsesink on a server ------------------------------------------------------------------------

TLENGTH = 6 * SPS                      # the module's buffer-time 100 ms: the server grants 60 ms
UPDATE = 72000                         # timing updates 1.5 s apart (the dev Pi's pipewire-pulse)


def simulate_pulse(steps_ms, quantum, sink_lat_ms, segdone_moves, rule=None, seed=7, hold_s=6.0, guard_extra=0,
                   gated=True):
    """The module's sink end into pulsesink on a server, in frames of the device's time t. The server reads
    `quantum` frames a cycle, one cycle ahead, plus the sink's latency: read index R(t); a write behind R is
    dropped there. Its clock is libpulse's: at a timing update R less the reported sink latency less up to a
    quantum (measured: the clock steps forward by up to about a quantum at an update), then run on in
    house time, never backwards. segdone: the read index at the last update (1.28) or 0 (1.22). The
    feed: 30 ms late for 6 s, then for each x in steps_ms the lateness that lands its writes x ms ahead of
    the clock (the render lateness less x, read at the step), each `hold_s`. Returns frames fed, sounded,
    holes after 2 s, refills after 2 s, holes with no refill since the last sounding frame."""
    rule = rule or sm.silence_frames
    rng = random.Random(seed)
    lat = sink_lat_ms * FS // 1000
    phase = rng.randrange(quantum)
    t0 = None
    upd_phase = rng.randrange(UPDATE)

    def read_index(t):
        if t0 is None:
            return 0
        k = (t - t0 + phase) // quantum
        return max(0, (k + 1) * quantum - phase) + lat

    def last_update(t):
        return t0 + max(0, (t - t0 - upd_phase) // UPDATE * UPDATE + upd_phase) if t0 is not None else 0

    clock_state = {"last": 0}

    def clock(t):
        if t0 is None:
            return 0
        tu = last_update(t)
        lag = random.Random(seed * 100003 + tu).randrange(quantum)
        c = read_index(tu) - lat - lag + (t - tu)
        c = max(clock_state["last"], c)
        clock_state["last"] = c
        return c

    def segdone_at(t):
        return -(-read_index(last_update(t)) // SPS) if segdone_moves and t0 is not None else 0

    guard = sm.SinkGuard(sm.server_latency_frames(TLENGTH, SPS), 500 * FS // 1000)
    margin = sm.SinkMargin(MARGIN)
    kept = []                 # (start, end) frames that sound
    nxt, t, i = -1, 0, 0
    delta = None              # write position less content position since the last refill
    refill_at = []
    late = 30.0
    blocked = 0               # the module's queue: the producer's push never waits on the sink
    plan = [(START_S * 3, None)] + [(hold_s, x) for x in steps_ms]
    total_s = sum(h for h, _ in plan)
    n = int(total_s * 100)
    edges, acc = [], 0.0
    for h, x in plan:
        acc += h
        edges.append((int(acc * 100), x))
    seg_k = 0
    lateness_now = 30.0
    for i in range(n):
        while seg_k < len(edges) and i >= edges[seg_k][0]:
            seg_k += 1
            if seg_k < len(edges) and t0 is not None and delta is not None:
                x = edges[seg_k][1]
                # the render lateness now: house time less the content at the clock's position
                rl_ms = (t - (clock(t) - delta) - t0) * 1000 / FS
                lateness_now = max(lateness_now, rl_ms - x - rng.uniform(0, 2))
        arrive = int((i * 10 + lateness_now) * FS / 1000)
        waited = t - arrive          # in the queue while the sink was blocked (frames; < 0: it came later)
        t = max(t, arrive)
        play = clock(t) if t0 is not None else None
        sd = segdone_at(t)
        if play is not None:
            guard.segdone_seen(sd, SPS, play)
        g = guard.frames() + guard_extra
        if gated and not sm.guard_applies(max(0, waited) * 10**9 // FS, blocked * 10**9 // FS, SPS * 10**9 // FS):
            g = 0
        sil = rule(nxt, sd, SPS, MARGIN, play, g)
        if sil:
            refill_at.append(t)
        start = sm.base_write_pos(nxt, sd, SPS) + sil
        end = start + BUF
        if t0 is None:
            t0 = t
        # a full stream (tlength) blocks the write until the server has read enough
        while end - read_index(t) > TLENGTH:
            t = t + quantum
        r = read_index(t)
        if end > r:
            kept.append((max(start, r), end))
        delta = start - i * BUF
        nxt = end
    fed = n * BUF
    sounded = sum(e - s for s, e in kept)
    # every gap in what sounds: a refill's silence (one each, the start's leaves none) or a write cut
    gaps = sum(1 for (s0, e0), (s1, e1) in zip(kept, kept[1:]) if s1 > e0)
    return {"fed": fed, "sounded": sounded, "refills": len(refill_at), "no_refill": max(0, gaps - (len(refill_at) - 1))}


EDGE_STEPS = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]


def case_pulse(rule=None, verbose=True):
    print("\n--- pulsesink on a server: the edge profile (writes 0-30 ms ahead of the clock), five seeds ---")
    for quantum, lat_ms, moves in ((512, 0, False), (1024, 0, False), (512, 0, True), (1024, 0, True),
                                   (512, 20, True), (1024, 20, True)):
        rows, rows0 = [], []
        for seed in range(7, 12):
            steps = EDGE_STEPS[:]
            random.Random(seed).shuffle(steps)
            rows.append(simulate_pulse(steps, quantum, lat_ms, moves, rule=rule, seed=seed))
            if rule is None:
                rows0.append(simulate_pulse(steps, quantum, lat_ms, moves, rule=_m_guard_zero, seed=seed))
        lost = [r["fed"] - r["sounded"] for r in rows]
        what = f"quantum {quantum}, sink latency {lat_ms} ms, segdone {'moving' if moves else 'still'}"
        check(f"{what}: the guard: nothing lost ({lost} frames), every gap a refill's "
              f"({[r['no_refill'] for r in rows]} without), at most a refill a step ({[r['refills'] for r in rows]})",
              all(v == 0 for v in lost) and all(r["no_refill"] == 0 for r in rows)
              and all(r["refills"] <= len(EDGE_STEPS) + 1 for r in rows))
        if rows0 and verbose:
            print(f"  no guard: lost {[r['fed'] - r['sounded'] for r in rows0]} frames, "
                  f"gaps without a refill {[r['no_refill'] for r in rows0]}")
        if rows0 and (lat_ms or quantum == 1024):
            check(f"{what}: with no guard (c1a929b9) frames are lost", sum(r["fed"] - r["sounded"] for r in rows0) > 0)
    if rule is None:
        steps = EDGE_STEPS[:]
        big = 40 * FS // 1000
        r0 = simulate_pulse(steps, 1024, 0, False, seed=7, guard_extra=big, gated=False)
        r1 = simulate_pulse(steps, 1024, 0, False, seed=7, guard_extra=big)
        check(f"a guard past what the stream holds (40 ms over), held to every write, refills without end "
              f"({r0['refills']} refills); held only while the stream may run dry, a refill a step at most "
              f"({r1['refills']}), nothing lost ({r1['fed'] - r1['sounded']})",
              r0["refills"] > 100 and r1["refills"] <= len(steps) + 1 and r1["fed"] == r1["sounded"])


# --- mutants: each must fail a case ----------------------------------------------------------------

def _m_inflight_ok(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """The segment in flight counted as playable (the base sink's own test)."""
    c = segdone * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_start_only(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """The margin at the first write only: no re-prefill after a hole."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard) if nxt < 0 else 0


def _m_eager(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """Silence whenever less than the margin is left: holes of its own."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c + margin:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_from_next(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """The silence counted from next_sample, not where the base sink realigns: the margin lost."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - max(nxt, 0)) if nxt >= 0 and nxt // sps >= segdone else 0


def _m_start_single(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """One margin at a start: the device's own buffer comes out of it."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard) if nxt >= 0 else \
        max(0, (segdone + 1) * sps + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_guard_zero(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """The clock's position alone (c1a929b9): a server's read-ahead counted as playable."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, 0)


def _m_start_no_guard(nxt, segdone, sps, margin, play_pos=None, guard=0):
    """A start lands twice the margin past `consumed` whatever the guard."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard) if nxt >= 0 else \
        sm.silence_frames(nxt, segdone, sps, margin, play_pos, 0)


MUTANTS = {"guard-zero": _m_guard_zero, "start-no-guard": _m_start_no_guard, "start-single": _m_start_single, "inflight-ok": _m_inflight_ok, "start-only": _m_start_only, "eager": _m_eager,
           "from-next": _m_from_next}


def run_suite(rule=None):
    global _failures
    _failures = 0
    case_rule(rule)
    case_profiles(rule, verbose=rule is None)
    case_pulse(rule, verbose=rule is None)
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
