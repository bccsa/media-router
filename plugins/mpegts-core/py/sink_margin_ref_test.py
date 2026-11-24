#!/usr/bin/env python3
"""sink_margin_ref.py's suite (plan ch. 15.4 B-249): the rule's cases, then a model of the 302M
output's sink end (a sync=false GstAudioSink: 10 ms segments, a 100 ms ring read one segment each
10 ms once a device that takes 40 ms at its start began, the base sink's realign and the segment in
flight lost) fed a 1 kHz tone's buffers late by
each profile of gst_302m_late_feed_test.py, five seeds each:

  - the margin (60 ms, mrasrc margin-ms): no hole after the start in the field walk (30-70 ms from
    30) and the old walk (from its 300 ms max); the step 30 -> 70 ms one hole at its first rise, the
    device's 40 ms start buffer taken from the start's one margin (M6b; none on a one-segment
    device); in the rising walk (30 ms
    for 10 s, then 30-300 ms) holes only while the lateness reaches past every earlier value by
    more than the margin, none once it reached its maximum; never a frame lost in any;
  - c38's sink end (a 40 ms min-threshold queue, no margin) plays holes and loses frames in the
    field walk and the rising walk; it is the model's mutant;
  - a model of pulsesink on a server (the c39 review's blocking 1): the server reads a quantum ahead
    (512, 1024 frames: the dev Pi's) plus the sink's latency (0; 20 ms where segdone moves), drops a
    write behind its read index, holds 60 ms, and its clock is interpolated from timing updates 1.5 s
    apart; the feed steps to land 0-30 ms ahead of the clock (the edge profile, five seeds): with the
    guard nothing is lost, every hole has a refill, at most one a step; with no guard frames are
    lost; a guard past what the stream holds refills without end. A witness at quanta 512 and 1024
    only: at 1536-2048 it loses frames and refills without end where the dev Pi's server at a forced
    2048 lost nothing with a refill a step (the c39 re-review), so nothing is asserted there;
  - the Audio Decoder's sink end on that server (no queue: the push into the sink blocks while the
    stream is full, then the feed pauses and its next write lands 0-30 ms ahead of the clock): the
    guard, held unless the push before blocked and ended less than a segment before, loses nothing;
    the blocked push counted however long ago (21eade5e, fix round 2's blocking 1) loses frames;
  - a refill is capped (REFILL_MAX_MS): a flush on a pulsesink whose segdone is still (1.22) after a
    long run is crossed by capped writes, none past the cap, the stream back with the margin;
  - the 302M's sink end at load (c41, D4): outq holds a backlog, the server takes nothing for 0.3 s
    while the clock runs on, no timing update until the next 1.5 s one: a write after a push that
    blocked is held to segdone, so no refill and nothing lost; a 1 s feed outage (outq runs dry) still
    gets its refill and loses nothing; the clock read for every write (4630f8d2) refills each write
    until the update, seconds of silence put in.

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
CAP = sm.REFILL_MAX_MS * FS // 1000
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
        sil = rule(nxt, segdone, SPS, margin, None, 0, CAP) if margin else 0
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
    check("the first write (next -1): one margin past the segment in flight, as a hole's write (M6b)",
          f(-1, 0, SPS, MARGIN) == SPS + MARGIN and f(-1, 9, SPS, MARGIN) == MARGIN)
    check("the device clock past a stale segdone moves `consumed`",
          f(5 * SPS, 3, SPS, MARGIN, play_pos=6 * SPS) == 6 * SPS + MARGIN - 5 * SPS)
    check("... a clock behind it does not",
          f(5 * SPS, 3, SPS, MARGIN, play_pos=2 * SPS) == 0)
    check("the guard moves `consumed` past the clock: a write less than the guard ahead gets silence",
          f(6 * SPS, 3, SPS, MARGIN, play_pos=5 * SPS, guard=2 * SPS) == 7 * SPS + MARGIN - 6 * SPS
          and f(7 * SPS, 3, SPS, MARGIN, play_pos=5 * SPS, guard=2 * SPS) == 0)
    check("... no guard without a clock (before the first render)",
          f(5 * SPS, 3, SPS, MARGIN, guard=10 * SPS) == 0)
    check("a start (no clock): the margin past the segment in flight and the guard, a server's read-ahead",
          f(-1, 0, SPS, MARGIN, guard=SPS) == 2 * SPS + MARGIN
          and f(-1, 0, SPS, MARGIN, guard=2 * MARGIN) == SPS + 3 * MARGIN)
    check("after a flush while the device plays (next -1, a clock): one margin past the clock and guard, "
          "from where the base sink writes (pulsesink 1.22: frame 0)",
          f(-1, 0, SPS, MARGIN, play_pos=3_000_000, guard=SPS) == 3_000_000 + SPS + MARGIN
          and f(-1, 7, SPS, MARGIN, play_pos=2 * SPS) == MARGIN)
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
    seg = 10 * 10**6
    check("the guard holds a write that came straight through, not one that waited a segment in the queue or "
          "followed a push that blocked less than a segment before",
          sm.guard_applies(0, 0, 0, seg) and sm.guard_applies(9_999_999, 1_999_999, 0, seg)
          and not sm.guard_applies(seg, 0, 0, seg) and not sm.guard_applies(0, 2 * 10**6, 0, seg)
          and not sm.guard_applies(0, 50 * 10**6, seg - 1, seg))
    check("... a push that blocked a segment or more before this write says nothing of it: the guard holds",
          sm.guard_applies(0, 2 * 10**6, seg, seg) and sm.guard_applies(0, 80 * 10**6, 5 * seg, seg)
          and not sm.guard_applies(seg, 80 * 10**6, 5 * seg, seg))
    check("a refill is capped: the silence at most the cap, none still none",
          sm.silence_frames(-1, 0, SPS, MARGIN, play_pos=20 * FS, guard=4 * SPS, cap=CAP) == CAP
          and sm.silence_frames(-1, 0, SPS, MARGIN, play_pos=20 * FS, guard=4 * SPS) > CAP
          and sm.silence_frames(5 * SPS, 3, SPS, MARGIN, cap=CAP) == 0
          and sm.silence_frames(3 * SPS + 100, 3, SPS, MARGIN, cap=CAP) == 4 * SPS + MARGIN - (3 * SPS + 100))
    z = sm.SinkMargin(0)
    check("margin 0 (mrasrc margin-ms 0): never, not even into the segment in flight",
          z.silence(3 * SPS + 100, 3, SPS) == 0 and z.silence(-1, 0, SPS) == 0)
    m = sm.SinkMargin(MARGIN)
    m.silence(-1, 0, SPS)
    m.silence(5 * SPS, 3, SPS)
    m.silence(1 * SPS, 7, SPS)
    check(f"stats count the refills and their silence: {m.stats()}",
          m.stats() == {"refills": 2, "silence": SPS + MARGIN + MARGIN})
    mc = sm.SinkMargin(MARGIN, CAP)
    mc.silence(-1, 0, SPS, 20 * FS, 4 * SPS)
    check(f"... a capped refill counts its capped silence: {mc.stats()}", mc.stats() == {"refills": 1, "silence": CAP})


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
            elif name == "step":
                # The start's one margin less the device's 40 ms start buffer: the first 40 ms step passes the
                # 20 ms left once, its refill lands the whole margin (M6b); a one-segment device keeps it.
                small = simulate(late, rule=rule, device_ms=SPS * 1000 // FS)
                check(f"step seed {seed}: margin: one hole after {START_S:.0f} s, at the first step at 10 s "
                      f"({r39['holes']} at {[round(h, 2) for h in r39['hole_at']]}), none with a one-segment device "
                      f"({small['holes']}), 0 lost ({r39['lost']}, {small['lost']}), delay at the end "
                      f"{r39['delay_ms']:.0f} ms",
                      r39["holes"] == 1 and 10.0 <= r39["hole_at"][0] <= 10.1 and small["holes"] == 0
                      and r39["lost"] == 0 and small["lost"] == 0)
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
                   gated=True, gate=None):
    """The module's sink end into pulsesink on a server, in frames of the device's time t. The server reads
    `quantum` frames a cycle, one cycle ahead, plus the sink's latency: read index R(t); a write behind R is
    dropped there. Its clock is libpulse's: at a timing update R less the reported sink latency less up to a
    quantum (measured: the clock steps forward by up to about a quantum at an update), then run on in
    house time, never backwards. segdone: the read index at the last update (1.28) or 0 (1.22). The
    feed: 30 ms late for 6 s, then for each x in steps_ms the lateness that lands its writes x ms ahead of
    the clock (the render lateness less x, read at the step), each `hold_s`. Returns frames fed, sounded,
    holes after 2 s, refills after 2 s, holes with no refill since the last sounding frame. The push into
    the sink is the queue's thread, which the guard does not time (`gate`: guard_applies or a mutant)."""
    rule = rule or sm.silence_frames
    gate = gate or sm.guard_applies
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
    blocked = 0               # the module's queue: the push into the sink is another thread's, not counted
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
        if gated and not gate(max(0, waited) * 10**9 // FS, blocked, 1 << 62, SPS * 10**9 // FS):
            g = 0
        sil = rule(nxt, sd, SPS, MARGIN, play, g, CAP)
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


def case_pulse(rule=None, verbose=True, gate=None):
    print("\n--- pulsesink on a server: the edge profile (writes 0-30 ms ahead of the clock), five seeds ---")
    for quantum, lat_ms, moves in ((512, 0, False), (1024, 0, False), (512, 0, True), (1024, 0, True),
                                   (512, 20, True), (1024, 20, True)):
        rows, rows0 = [], []
        for seed in range(7, 12):
            steps = EDGE_STEPS[:]
            random.Random(seed).shuffle(steps)
            rows.append(simulate_pulse(steps, quantum, lat_ms, moves, rule=rule, seed=seed, gate=gate))
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
    if rule is None and gate is None:
        steps = EDGE_STEPS[:]
        big = 40 * FS // 1000
        r0 = simulate_pulse(steps, 1024, 0, False, seed=7, guard_extra=big, gated=False)
        r1 = simulate_pulse(steps, 1024, 0, False, seed=7, guard_extra=big)
        check(f"a guard past what the stream holds (40 ms over), held to every write, refills without end "
              f"({r0['refills']} refills); held only while the stream may run dry, a refill a step at most "
              f"({r1['refills']}), nothing lost ({r1['fed'] - r1['sounded']})",
              r0["refills"] > 100 and r1["refills"] <= len(steps) + 1 and r1["fed"] == r1["sounded"])


# --- the Audio Decoder's sink end on a server: a blocked push, then an outage ---------------------------

def simulate_decoder(steps_ms, quantum, rule=None, gate=None, seed=7, burst=10, hold_s=1.0, last_push=False, full=None):
    """The Audio Decoder's sink end into pulsesink on a server (simulate_pulse's: read index R, the clock
    rebased each 1.5 s, writes behind R dropped, 60 ms held), with no queue: the push into the sink waits while
    the stream is full, in the thread the guard times. The feed comes 30 ms late; before each step `burst`
    buffers come at once (the stream fills, the last push waits), then nothing until the clock is x ms short
    of the next write (x the step), then on. The guard sees the last push that waited 2 ms or more and how
    long before this write it ended (`last_push`: the last push, whatever it waited, as 21eade5e timed it).
    Returns frames fed and sounded, refills, gaps with no refill."""
    rule, gate, full = rule or sm.silence_frames, gate or sm.guard_applies, full or sm.stream_full
    rng = random.Random(seed)
    phase, upd_phase = rng.randrange(quantum), rng.randrange(UPDATE)
    t0 = 0
    read_index = lambda t: (t - t0 + phase) // quantum * quantum + quantum - phase

    def clock(t, last=[0]):
        tu = t0 + max(0, (t - t0 - upd_phase) // UPDATE * UPDATE + upd_phase)
        c = max(last[0], read_index(tu) - random.Random(seed * 100003 + tu).randrange(quantum) + (t - tu))
        last[0] = c
        return c

    guard = sm.SinkGuard(sm.server_latency_frames(TLENGTH, SPS), 500 * FS // 1000).frames()
    seg_ns = SPS * 10**9 // FS
    margin = MARGIN
    kept, refills, nxt, t = [], 0, -1, 0
    block_ns, block_end = 0, -(1 << 40)           # the last push that waited 2 ms or more, and when it ended
    n_hold = int(hold_s * 100)
    i, k = 0, -1
    late = 30 * FS // 1000
    while k < len(steps_ms):
        arrive = i * BUF + late
        step_i = (i // n_hold) * n_hold
        if i >= 2 * n_hold and i % n_hold >= n_hold - burst and k + 1 < len(steps_ms):
            arrive = (step_i + n_hold - burst) * BUF + late           # the burst before the step
        if i >= 2 * n_hold and i % n_hold == 0:
            k += 1
            if k < len(steps_ms):
                # the next write lands x ms ahead of the clock: wait until the clock is that short of it
                x = steps_ms[k] * FS // 1000
                tt = max(t, arrive)
                while clock(tt) < nxt - x:
                    tt += 1 if nxt - x - clock(tt) < 16 else (nxt - x - clock(tt)) // 2
                late = max(late, tt - i * BUF)
                arrive = i * BUF + late
        if k >= len(steps_ms):
            break
        t = max(t, arrive)
        since = (t - block_end) * 10**9 // FS
        play = clock(t) if i and not (nxt >= 0 and full(block_ns, since, seg_ns)) else None
        g = guard if gate(0, block_ns, since, seg_ns) else 0
        sil = rule(nxt, 0, SPS, margin, play, g, CAP)
        refills += 1 if sil else 0
        start = sm.base_write_pos(nxt, 0, SPS) + sil
        end = start + BUF
        if i == 0:
            t0 = t - phase
        t_push = t
        while end - read_index(t) > TLENGTH:
            t += quantum - (t - t0 + phase) % quantum if (t - t0 + phase) % quantum else quantum
        if last_push or (t - t_push) * 10**9 // FS >= sm.BLOCKED_NS:
            block_ns, block_end = (t - t_push) * 10**9 // FS, t
        r = read_index(t)
        if end > r:
            kept.append((max(start, r), end))
        nxt = end
        i += 1
    fed = i * BUF
    sounded = sum(e - s for s, e in kept)
    gaps = sum(1 for (s0, e0), (s1, e1) in zip(kept, kept[1:]) if s1 > e0)
    return {"fed": fed, "sounded": sounded, "refills": refills, "no_refill": max(0, gaps - (refills - 1))}


def case_decoder(rule=None, gate=None, verbose=True, full=None):
    print("\n--- the Audio Decoder's sink end on a server (no queue): a burst, a blocked push, then an outage ---")
    for quantum in (512, 1024, 2048):
        rows, rows_u = [], []
        for seed in range(7, 12):
            steps = [2, 4, 6, 8, 10, 12, 14, 16, 20, 30] * 2
            random.Random(seed).shuffle(steps)
            rows.append(simulate_decoder(steps, quantum, rule=rule, gate=gate, seed=seed, full=full))
            if rule is None and gate is None and full is None:
                rows_u.append(simulate_decoder(steps, quantum, gate=_g_unaged, seed=seed, last_push=True))
        lost = [r["fed"] - r["sounded"] for r in rows]
        check(f"decoder, quantum {quantum}: nothing lost ({lost} frames), every gap a refill's "
              f"({[r['no_refill'] for r in rows]} without), a refill a step and at most two at the start "
              f"({[r['refills'] for r in rows]} for {len(steps)} steps)",
              all(v == 0 for v in lost) and all(r["no_refill"] == 0 for r in rows)
              and all(r["refills"] <= len(steps) + 2 for r in rows))
        if rows_u:
            lu = [r["fed"] - r["sounded"] for r in rows_u]
            if verbose:
                print(f"  a blocked push counted however long ago (21eade5e): lost {lu} frames, gaps without a "
                      f"refill {[r['no_refill'] for r in rows_u]}")
            check(f"decoder, quantum {quantum}: the last push's wait counted however long ago (21eade5e) loses "
                  f"frames ({sum(lu)})", sum(lu) > 0)


# --- a refill's cap: a flush on pulsesink 1.22 after a long run ----------------------------------------

def simulate_flush(run_s, rule=None, quantum=512):
    """A flush `run_s` into the stream on a pulsesink whose segdone is still: the base sink writes the next
    buffer from frame 0 while the server's read index R (a quantum past the clock, which runs at house
    time) is `run_s` on; the feed keeps coming each 10 ms. A write behind R is dropped. Returns each refill's
    silence, the writes until one sounds, and the refills in the 2 s after it."""
    rule = rule or sm.silence_frames
    guard = sm.server_latency_frames(TLENGTH, SPS)
    t, nxt, sils, behind, after, sounded_at = run_s * FS, -1, [], 0, 0, None
    for i in range(int(run_s * FS / CAP) + 300):
        t += BUF
        sil = rule(nxt, 0, SPS, MARGIN, t, guard, CAP)
        start = sm.base_write_pos(nxt, 0, SPS) + sil
        if sil:
            if sounded_at is None:
                sils.append(sil)
            else:
                after += 1
        end = start + BUF
        if sounded_at is None:
            if end <= t + quantum:
                behind += 1
            else:
                sounded_at = i
        nxt = end
    return {"sils": sils, "behind": behind, "after": after, "landed": sounded_at is not None}


def case_cap(rule=None):
    print("\n--- a refill's cap (REFILL_MAX_MS): a flush on pulsesink 1.22 after a long run ---")
    for run_s in (20, 3600):
        r = simulate_flush(run_s, rule)
        need = -(-(run_s * FS) // CAP) + 1          # each capped write gains the cap on the read index
        check(f"a flush {run_s} s in: refills {len(r['sils'])}, the largest {max(r['sils'] or [0]) * 1000 // FS} ms "
              f"(cap {sm.REFILL_MAX_MS}), {r['behind']} writes dropped behind the read index before one sounds "
              f"(at most {need}), {r['after']} refills after",
              r["landed"] and r["sils"] and max(r["sils"]) <= CAP and r["behind"] <= need and r["after"] == 0)


# --- the 302M's sink end at load: the server takes nothing for a while, the clock runs on (c41, D4) ----------

def simulate_stall(stalls_ms, quantum=1024, outage_ms=0, full=None, queued=None, busy_ns=0, seed=7, sleep_ns=0,
                   sleep_every=500):
    """The 302M's sink end into pulsesink on a server, its queue's thread writing a backlog (outq holds 0.6 s) as
    the stream takes it: the server reads `quantum` frames a cycle (read index R), holds TLENGTH, drops a write
    behind R. At 20 s and each 20 s after, for each of `stalls_ms` the server takes nothing that long (R still),
    while libpulse's clock runs on in house time from its last timing update (1.5 s apart, none in a stall),
    never backwards. outage_ms: at 10 s the feed stops that long (outq runs dry, a real hole). The writer's push
    is read from its gaps (`queued`: queued_push or a mutant); busy_ns: after every tenth push the writer is that
    long on or waiting for a CPU before its next write (the Audio Decoder's thread resamples its next buffer there).
    sleep_ns: after every `sleep_every`th push the writer sleeps that long outside the sink, its buffer waiting (c41b).
    The stream's fullness by `full` (stream_full or a mutant). Returns frames fed and sounded, refills and silence
    after the start, gaps with no refill."""
    full = full or sm.stream_full
    queued = queued or sm.queued_push
    rng = random.Random(seed)
    phase, upd_phase = rng.randrange(quantum), rng.randrange(UPDATE)
    seg_ns = SPS * 10**9 // FS
    ns = lambda f: f * 10**9 // FS
    stalls = [(int((20 + 20 * k) * FS), s * FS // 1000) for k, s in enumerate(stalls_ms)]
    n = int((20 + 20 * len(stalls_ms) + 10) * 100)

    def held(t):   # server time lost to stalls before t
        return sum(min(max(0, t - a), d) for a, d in stalls)

    def read_index(t):
        s = t - held(t)
        return max(0, (s + phase) // quantum * quantum + quantum - phase)

    def in_stall(t):
        return any(a <= t < a + d for a, d in stalls)

    last = {"c": 0, "tu": None, "base": 0}

    def clock(t):
        tu = max(0, (t - upd_phase) // UPDATE * UPDATE + upd_phase)
        while tu > 0 and in_stall(tu):
            tu -= UPDATE
        if tu != last["tu"]:
            last["tu"], last["base"] = tu, read_index(tu) - random.Random(seed * 7919 + tu).randrange(quantum)
        c = max(last["c"], last["base"] + (t - tu))
        last["c"] = c
        return c

    def segdone(t):
        tu = last["tu"] if last["tu"] is not None else 0
        return -(-read_index(tu) // SPS)

    guard = sm.SinkGuard(sm.server_latency_frames(TLENGTH, SPS), 500 * FS // 1000)
    kept, refills, silence = [], 0, 0
    nxt, t, t_probe, cpu = -1, 0, None, 0
    block_ns, block_end = 0, -(1 << 40)          # the last push that blocked, as the element keeps it
    backlog = 600 * FS // 1000
    out_at, out_len = 10 * FS, outage_ms * FS // 1000
    for i in range(n):
        arrive = i * BUF - backlog + (out_len if i * BUF - backlog >= out_at else 0)
        if out_at <= i * BUF - backlog < out_at + out_len:
            arrive = out_at + out_len
        t = max(t, arrive)
        play = clock(t)
        sd = segdone(t)
        guard.segdone_seen(sd, SPS, play)
        gap = ns(t - t_probe) if t_probe is not None else 0
        push, since = queued(gap, ns(t - arrive), cpu)
        if push >= sm.BLOCKED_NS:
            block_ns, block_end = push, t - since * FS // 10**9
        since = ns(t - block_end)
        is_full = nxt >= 0 and full(block_ns, since, seg_ns)
        g = guard.frames() if sm.guard_applies(ns(t - arrive), block_ns, since, seg_ns) else 0
        sil = sm.silence_frames(nxt, sd, SPS, MARGIN, None if is_full else play, g, CAP)
        if sil and i:
            refills += 1
            silence += sil
        start = sm.base_write_pos(nxt, sd, SPS) + sil
        end = start + BUF
        t_probe = t
        while end - read_index(t) > TLENGTH:
            t += quantum
        r = read_index(t)
        if end > r:
            kept.append((max(start, r), end))
        nxt = end
        cpu = busy_ns if busy_ns and i % 10 == 9 else 0
        t += cpu * FS // 10**9
        if sleep_ns and i % sleep_every == sleep_every - 1:
            t += sleep_ns * FS // 10**9
    sounded = sum(e - s for s, e in kept)
    gaps = sum(1 for (s0, e0), (s1, e1) in zip(kept, kept[1:]) if s1 > e0)
    return {"fed": n * BUF, "sounded": sounded, "refills": refills, "silence_ms": silence * 1000 // FS,
            "no_refill": max(0, gaps - refills)}


def _full_never(push_ns, since_push_ns, seg_ns):
    """4630f8d2: the clock read for every write."""
    return False


def case_stall(full=None, queued=None, verbose=True):
    print("\n--- the 302M at load: the server takes nothing for 0.3 s while the clock runs on (c41, D4) ---")
    for quantum in (512, 1024):
        rows = [simulate_stall([300, 350, 300], quantum, full=full, queued=queued, seed=s) for s in range(7, 12)]
        lost = [r["fed"] - r["sounded"] for r in rows]
        check(f"quantum {quantum}, three 0.3 s stalls: no refill ({[r['refills'] for r in rows]}), nothing lost "
              f"({lost} frames)", all(r["refills"] == 0 for r in rows) and all(v == 0 for v in lost))
        rows = [simulate_stall([300], quantum, outage_ms=1000, full=full, queued=queued, seed=s) for s in range(7, 12)]
        lost = [r["fed"] - r["sounded"] for r in rows]
        check(f"quantum {quantum}, a 1 s feed outage (outq's 0.6 s runs dry) and a stall: the outage's one refill "
              f"({[r['refills'] for r in rows]}), every gap a refill's ({[r['no_refill'] for r in rows]} without), "
              f"nothing lost ({lost} frames)",
              all(r["refills"] == 1 for r in rows) and all(r["no_refill"] == 0 for r in rows)
              and all(v == 0 for v in lost))
        rows = [simulate_stall([300, 350, 300], quantum, full=full, queued=queued, busy_ns=13 * 10**6, seed=s)
                for s in range(7, 12)]
        lost = [r["fed"] - r["sounded"] for r in rows]
        check(f"quantum {quantum}, three stalls, the writer 13 ms on or waiting for a CPU after every tenth push (the "
              f"Audio Decoder's thread at load): no refill ({[r['refills'] for r in rows]}), nothing lost ({lost})",
              all(r["refills"] == 0 for r in rows) and all(v == 0 for v in lost))
        rows = [simulate_stall([300], quantum, full=full, queued=queued, busy_ns=40 * 10**6, seed=s)
                for s in range(7, 12)]
        check(f"quantum {quantum}, a stall, the writer 40 ms on or waiting for a CPU after every tenth push: the clock read "
              f"again ({[r['refills'] for r in rows]} refills)", all(r["refills"] > 0 for r in rows))
        # The rule's known cost (c41b, Limits): a writer asleep outside the sink with its buffer waiting (a page
        # fault; a wait on libpulse's mainloop lock while its thread is off the CPU) reads as a blocked push.
        for sl in (60, 120, 200):
            rows = [simulate_stall([], quantum, full=full, queued=queued, sleep_ns=sl * 10**6, seed=s)
                    for s in range(7, 12)]
            per = [(r["fed"] - r["sounded"]) * 1000 / FS / 5 for r in rows]
            check(f"quantum {quantum}, no server stall, the writer asleep {sl} ms outside the sink every 5 s (5 times): "
                  f"read as a full stream, no storm ({[r['refills'] for r in rows]} refills, at most one a run); a "
                  f"sleep loses about itself less the stream's 45 ms, once, as c38 would (less where one lands as a "
                  f"refill: {[round(v) for v in per]} ms a sleep, {sl - 90}-{sl - 30} expected)",
                  all(r["refills"] <= 1 for r in rows) and all(sl - 90 <= v <= sl - 30 for v in per))
    if full is None and queued is None:
        rows = [simulate_stall([300, 350, 300], 1024, full=_full_never, seed=s) for s in range(7, 12)]
        if verbose:
            print(f"  the clock read for every write (4630f8d2): refills {[r['refills'] for r in rows]}, silence "
                  f"{[r['silence_ms'] for r in rows]} ms")
        check(f"the clock read for every write (4630f8d2) refills each stall more than once "
              f"({[r['refills'] for r in rows]} for 3)", all(r["refills"] > 3 for r in rows))


# --- mutants: each must fail a case ----------------------------------------------------------------

def _m_inflight_ok(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """The segment in flight counted as playable (the base sink's own test)."""
    c = segdone * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_start_only(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """The margin at the first write only: no re-prefill after a hole."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard, cap) if nxt < 0 else 0


def _m_eager(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """Silence whenever less than the margin is left: holes of its own."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c + margin:
        return 0
    return max(0, c + margin - sm.base_write_pos(nxt, segdone, sps))


def _m_from_next(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """The silence counted from next_sample, not where the base sink realigns: the margin lost."""
    c = (segdone + 1) * sps
    if nxt >= 0 and nxt >= c:
        return 0
    return max(0, c + margin - max(nxt, 0)) if nxt >= 0 and nxt // sps >= segdone else 0


def _m_start_twice(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """c39-c42's start: a second margin (or the guard), a margin later than a hole's write (M6b)."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard, cap) + (0 if nxt >= 0 else margin)


def _m_guard_zero(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """The clock's position alone (c1a929b9): a server's read-ahead counted as playable."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, 0, cap)


def _m_start_no_guard(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """A start lands one margin past the segment in flight whatever the guard."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard, cap) if nxt >= 0 else \
        sm.silence_frames(nxt, segdone, sps, margin, play_pos, 0, cap)


def _m_no_cap(nxt, segdone, sps, margin, play_pos=None, guard=0, cap=0):
    """No cap (21eade5e): a refill as long as the gap, an hour's silence in one buffer."""
    return sm.silence_frames(nxt, segdone, sps, margin, play_pos, guard)


def _g_unaged(residence_ns, push_ns, since_push_ns, seg_ns):
    """A blocked push counted however long before this write (21eade5e)."""
    return residence_ns < seg_ns and push_ns < sm.BLOCKED_NS


MUTANTS = {"no-cap": _m_no_cap, "guard-zero": _m_guard_zero, "start-no-guard": _m_start_no_guard, "start-twice": _m_start_twice, "inflight-ok": _m_inflight_ok, "start-only": _m_start_only, "eager": _m_eager,
           "from-next": _m_from_next}


def _f_one_seg(push_ns, since_push_ns, seg_ns):
    """982c3bb8's window, one segment: a writer 10-15 ms from its push reads the clock."""
    return push_ns >= sm.BLOCKED_NS and since_push_ns < seg_ns


def _f_unaged(push_ns, since_push_ns, seg_ns):
    """A blocked push counted however long before this write: the write after an outage held to segdone."""
    return push_ns >= sm.BLOCKED_NS


def _q_no_residence(gap_ns, residence_ns, busy_ns):
    """The writer's whole gap read as its push, whether or not the buffer waited through it (an outage)."""
    return max(0, gap_ns - max(0, busy_ns)), max(0, busy_ns)


def _q_no_busy(gap_ns, residence_ns, busy_ns):
    """The CPU time not taken off: a writer held up on the CPU read as a full stream."""
    return sm.queued_push(gap_ns, residence_ns, 0)


GATE_MUTANTS = {"push-unaged": _g_unaged}
FULL_MUTANTS = {"full-never": _full_never, "full-unaged": _f_unaged, "full-one-seg": _f_one_seg}
QUEUED_MUTANTS = {"queued-no-residence": _q_no_residence, "queued-no-busy": _q_no_busy}


def run_suite(rule=None, gate=None, full=None, queued=None):
    global _failures
    _failures = 0
    if full is None and queued is None:
        case_rule(rule)
        case_profiles(rule, verbose=rule is None)
        case_pulse(rule, verbose=rule is None and gate is None, gate=gate)
        case_cap(rule)
    case_decoder(rule, gate, verbose=rule is None and gate is None, full=full)
    if rule is None and gate is None:
        case_stall(full, queued, verbose=full is None and queued is None)
    return _failures


def main(argv):
    if "--mutants" in argv:
        ok = True
        for name, fn in MUTANTS.items():
            fails = run_suite(fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        for name, fn in GATE_MUTANTS.items():
            fails = run_suite(gate=fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        for name, fn in FULL_MUTANTS.items():
            fails = run_suite(full=fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        for name, fn in QUEUED_MUTANTS.items():
            fails = run_suite(queued=fn)
            print(f"MUTANT {name}: {'caught' if fails else 'NOT CAUGHT'} ({fails} failures)")
            ok = ok and fails > 0
        print("ALL MUTANTS CAUGHT" if ok else "A MUTANT SURVIVED")
        return 0 if ok else 1
    fails = run_suite()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAILED'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
