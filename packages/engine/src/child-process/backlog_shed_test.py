#!/usr/bin/env python3
"""Self-checking tests for BacklogShedPolicy (backlog_shed.py).

Pure arithmetic, no GStreamer — the pad work it drives is covered by
gst_backlog_shed_test.py and the end-to-end ratchet by
gst_latency_ratchet_test.py.

What must hold, and why each one is load-bearing:
  * only SUSTAINED excess counts (a spike is an absorbed burst, not retention),
  * the streak is a FLOOR: one sample back inside tolerance resets it,
  * a shed cannot repeat inside the cooldown — the property that makes
    oscillation impossible, since a shed always ends at or below zero lateness,
  * an implausible reading is reported once and NEVER sheds; on that path the
    buffer timeline is not the pipeline clock's, and shedding to a target on a
    timeline you are not on drops the whole stream.

Run:  python3 backlog_shed_test.py
"""
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "backlog_shed", os.path.join(_HERE, "backlog_shed.py"))
bs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bs)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def feed(policy, lateness_ms, t0, ms, step=20.0):
    """Feed `lateness_ms` from t0 for `ms`, one sample every `step`. Returns
    (verdicts, next_t) — verdicts are the non-None returns, in order."""
    out = []
    t = t0
    end = t0 + ms
    while t <= end:
        v = policy.observe(lateness_ms, t)
        if v:
            out.append((v, t))
        t += step
    return out, t


# --- sustained excess, and only sustained excess -----------------------------
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=5_000, cooldown_ms=60_000)
verdicts, t = feed(p, 400.0, 0.0, 4_000)
check("4 s of excess is not yet a shed (hold is 5 s)", verdicts == [])
verdicts, t = feed(p, 400.0, t, 2_000)
check("excess past the hold window sheds", [v for v, _ in verdicts][:1] == ["shed"])
check("the shed is offered from the moment the hold expires",
      verdicts[0][1] - 0.0 >= 5_000)

# A SPIKE is what an absorbed IDR burst looks like: high for a moment, then
# handed back. It must never shed — this is the guarantee that the fix does not
# regress the field-measured burst absorption the ES queue exists for.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=5_000)
t = 0.0
for _ in range(20):
    verdicts, t = feed(p, 900.0, t, 400)       # a 400 ms spike
    check_spike = verdicts == []
    if not check_spike:
        break
    verdicts, t = feed(p, -280.0, t, 2_000)    # relaxed back below budget
    if verdicts:
        check_spike = False
        break
check("20 absorbed bursts (400 ms spikes, relaxing between) never shed", check_spike)

# The streak is a FLOOR: one sample back inside tolerance resets it, so 4.9 s of
# excess either side of a single good sample is not 9.8 s of excess.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=5_000)
verdicts, t = feed(p, 400.0, 0.0, 4_900)
check("just short of the hold window, nothing yet", verdicts == [])
check("one in-budget sample resets the streak", p.observe(100.0, t) is None)
t += 20
verdicts, t = feed(p, 400.0, t, 4_900)
check("the streak restarts from zero after it", verdicts == [])

# Exactly at tolerance is NOT excess (the comparison is strict).
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000)
verdicts, _ = feed(p, 250.0, 0.0, 5_000)
check("lateness exactly at tolerance never sheds", verdicts == [])

# --- nothing queued: a late timeline is refused, not shed ---------------------
# The 10.9.16.103 case (2026-09-08): every buffer ~500 ms over budget for
# seconds, queues empty. Dropping cannot return anything, so the policy must
# say "timeline" once, restart its hold, and never offer a shed while the
# queues stay empty — and offer one the moment they hold a backlog.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=5_000, cooldown_ms=60_000)
t = 0.0
out = []
while t <= 5_100:
    v = p.observe(500.0, t, queued_ms=0.0)
    if v:
        out.append((v, t))
    t += 20.0
check("a matured hold with nothing queued is reported as a late timeline, not shed",
      [v for v, _ in out] == ["timeline"])
check("the refusal is counted", p.timeline_refusals == 1)
verdicts, t = feed(p, 500.0, t, 4_000)
check("inside the restarted hold nothing is asked or reported", verdicts == [])
out = []
while t <= 10_400:
    v = p.observe(500.0, t, queued_ms=40.0)
    if v:
        out.append(v)
    t += 20.0
check("a second matured hold with the queues still empty refuses again, silently",
      out == [] and p.timeline_refusals == 2)
# The callable form: evaluated only when a hold matures, so the steady state
# never pays for the queue walk.
calls = []
def _walk():
    calls.append(1)
    return 600.0
verdicts, t = feed(p, 500.0, t, 4_000)
check("the callable is not evaluated inside the hold", calls == [])
out = []
while t <= 15_800 and not out:
    v = p.observe(500.0, t, queued_ms=_walk)
    if v:
        out.append(v)
    t += 20.0
check("with a real backlog queued the same excess sheds", out == ["shed"] and len(calls) == 1)
p.shed_finished(t)
check("the shed counter is separate from the refusals",
      p.sheds == 1 and p.timeline_refusals == 2)
# Back inside tolerance clears the latch, so the NEXT late-timeline episode is
# reported again.
p2 = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000, cooldown_ms=0)
t = 0.0
seen = []
for _ in range(60):
    v = p2.observe(500.0, t, queued_ms=0.0); t += 20.0
    if v: seen.append(v)
p2.observe(0.0, t, queued_ms=0.0); t += 20.0
for _ in range(60):
    v = p2.observe(500.0, t, queued_ms=0.0); t += 20.0
    if v: seen.append(v)
check("each late-timeline episode is reported once", seen == ["timeline", "timeline"])
check("None for queued_ms keeps the old behaviour (unknown = shed)",
      bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=0, cooldown_ms=0).observe(500.0, 0.0) is None
      and bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=0, cooldown_ms=0)._above_since is None)

# --- rate limiting -----------------------------------------------------------
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000, cooldown_ms=60_000)
verdicts, t = feed(p, 800.0, 0.0, 1_100)
check("first shed fires", [v for v, _ in verdicts][:1] == ["shed"])
p.shed_finished(t)
check("shed_finished counts the episode", p.sheds == 1)
verdicts, t = feed(p, 800.0, t, 30_000)
check("a still-excessive leg cannot shed again inside the cooldown", verdicts == [])
verdicts, t = feed(p, 800.0, t, 31_000)
check("once the cooldown expires it sheds again", [v for v, _ in verdicts][:1] == ["shed"])
# The streak is NOT paid twice: the cooldown gate holds a shed back, it does not
# reset the hold, so a leg over budget the whole time sheds the moment it can.
check("the post-cooldown shed is immediate, not another hold window later",
      verdicts[0][1] - t < 31_000)

# The one-shed-per-cooldown bound, stated as a count: 10 minutes of unbroken,
# extreme excess with every shed reported finished as it happens.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=5_000, cooldown_ms=60_000)
t = 0.0
sheds = 0
while t < 600_000:
    if p.observe(2_000.0, t) == "shed":
        sheds += 1
        p.shed_finished(t)
    t += 20
check("10 min of unbroken excess is bounded to one shed per cooldown",
      sheds == 10)

# --- the sanity ceiling ------------------------------------------------------
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000, sanity_ms=10_000)
check("an implausible sample is reported", p.observe(85_000.0, 0.0) == "implausible")
check("and reported only once per episode", p.observe(85_000.0, 20.0) is None)
verdicts, t = feed(p, 85_000.0, 40.0, 60_000)
check("an implausible timeline NEVER sheds, however long it lasts", verdicts == [])
check("a plausible sample re-arms the report",
      p.observe(300.0, t) is None and p.observe(85_000.0, t + 20) == "implausible")
# Symmetric: a wildly NEGATIVE reading is the same mismatch seen from the other
# side (buffers stamped far in the future), and equally must not be trusted.
p = bs.BacklogShedPolicy(sanity_ms=10_000)
check("a wildly early reading is implausible too", p.observe(-85_000.0, 0.0) == "implausible")
# NaN can only come from arithmetic on a missing timestamp; swallow it.
check("NaN is ignored", bs.BacklogShedPolicy().observe(float("nan"), 0.0) is None)
check("None is ignored", bs.BacklogShedPolicy().observe(None, 0.0) is None)

# An implausible reading also has to drop any streak built before it — otherwise
# a leg that ratchets and then loses its timeline would shed on the strength of
# samples from a timeline it is no longer on.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000, sanity_ms=10_000)
verdicts, t = feed(p, 800.0, 0.0, 900)
check("streak building, no shed yet", verdicts == [])
p.observe(85_000.0, t)
t += 20
verdicts, t = feed(p, 800.0, t, 900)
check("an implausible sample mid-streak resets it", verdicts == [])

# --- reset -------------------------------------------------------------------
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000)
verdicts, t = feed(p, 800.0, 0.0, 900)
p.reset()                                  # a SEGMENT event: times incomparable
verdicts, t = feed(p, 800.0, t, 900)
check("reset() drops the streak (a new segment is a new timeline)", verdicts == [])
verdicts, t = feed(p, 800.0, t, 1_100)
check("and the streak rebuilds normally after it",
      [v for v, _ in verdicts][:1] == ["shed"])

# --- the post-shed stall watch -----------------------------------------------
# The other half of an episode: a shed that ENDED correctly (on an IRAP, back
# inside budget) still wedged a Pi 400's stateless V4L2 decoder for 12 h. What
# must hold:
#   * one buffer out of the decoder ends the watch — the normal case costs a
#     single probe callback and nothing else,
#   * silence past the grace flushes ONCE, and only escalates if the flush did
#     not help (a restart is seconds of black; the flush is free),
#   * repeat sheds RESET the watch, they never stack a second flush/escalation,
#   * an audio leg is never watched: it sheds whole PCM buffers at the sink,
#     which has no decoder state to wedge.
GRACE = 10_000.0

w = bs.PostShedStallWatch(grace_ms=GRACE)
check("a fresh watch is idle", not w.armed and w.tick(0.0) is None)
check("a video shed arms it", w.arm(0.0) is True and w.armed)
check("inside the grace, nothing happens", w.tick(GRACE - 1) is None)
check("a buffer out of the decoder disarms it", w.saw_output() is True and not w.armed)
check("and disarming is idempotent", w.saw_output() is False)
check("a disarmed watch never fires, however long it waits",
      w.tick(GRACE * 100) is None and w.flushes == 0 and w.escalations == 0)

# Stage 1 → stage 2, the wedge case.
w = bs.PostShedStallWatch(grace_ms=GRACE)
w.arm(0.0)
check("the grace is not paid early", w.tick(GRACE - 0.1) is None)
check("silence past the grace flushes the decoder", w.tick(GRACE) == "flush")
check("the flush is counted once", w.flushes == 1)
check("the flush re-arms rather than escalating immediately",
      w.armed and w.tick(GRACE + 1) is None)
check("it does not flush twice — the second grace escalates",
      w.tick(2 * GRACE) == "error")
check("the escalation is counted, and the watch is then over",
      w.escalations == 1 and w.flushes == 1 and not w.armed)
check("and it cannot escalate again on a later tick", w.tick(10 * GRACE) is None)

# A decoder the FLUSH revived: stage 2 must never run.
w = bs.PostShedStallWatch(grace_ms=GRACE)
w.arm(0.0)
check("stage 1 runs", w.tick(GRACE) == "flush")
check("a buffer after the flush ends it", w.saw_output() is True)
check("so no error is ever posted", w.tick(3 * GRACE) is None and w.escalations == 0)

# Repeat sheds: the cooldown means minutes apart, but the watch must be safe
# whatever the spacing — a re-arm restarts the grace from stage 1, so two sheds
# can never leave two flushes (or an escalation the first shed's silence owns).
w = bs.PostShedStallWatch(grace_ms=GRACE)
w.arm(0.0)
w.tick(GRACE)                                  # flushed, stage 2 pending
w.arm(GRACE + 500)                             # a second shed lands
check("a re-arm resets to stage 1", w.armed and w.tick(2 * GRACE) is None)
check("so the first shed's pending escalation is gone",
      w.escalations == 0 and w.flushes == 1)
check("the new watch flushes on its OWN grace",
      w.tick(GRACE + 500 + GRACE) == "flush" and w.flushes == 2)
check("remaining_ms counts down the live grace",
      w.remaining_ms(GRACE + 500 + GRACE) == GRACE
      and w.remaining_ms(GRACE + 500 + 2 * GRACE) == 0.0)
check("and is None once disarmed",
      w.saw_output() and w.remaining_ms(0.0) is None)

# The audio leg. Its shed drops whole decoded buffers at `pulsesink`'s own pad:
# no decoder state, nothing to flush, and a bus error there would restart a
# pipeline that is working.
w = bs.PostShedStallWatch(grace_ms=GRACE, enabled=False)
check("an audio shed does not arm the watch", w.arm(0.0) is False and not w.armed)
check("and nothing it is asked afterwards fires",
      w.tick(100 * GRACE) is None and w.flushes == 0 and w.escalations == 0)

# The knob. Generous by default — the grace has to cover the stream's next IRAP
# arriving AND decoding, and only a typo-proof override may change it.
check("the default grace is 10 s", bs.DEFAULT_STALL_GRACE_MS == 10_000.0)
check("an unset env leaves the default", bs.stall_grace_ms() == 10_000.0)
os.environ[bs.STALL_GRACE_ENV] = "25"
check("the env overrides it, in SECONDS", bs.stall_grace_ms() == 25_000.0)
os.environ[bs.STALL_GRACE_ENV] = "nonsense"
check("garbage keeps the default", bs.stall_grace_ms() == 10_000.0)
os.environ[bs.STALL_GRACE_ENV] = "0"
check("and 0 cannot disable the watch", bs.stall_grace_ms() == 10_000.0)
del os.environ[bs.STALL_GRACE_ENV]

# --- re-anchor mode (onLateness "reanchor", ADR-0005 2026-10-08) -------------
# The leg never drops: a FLOOR past 40 ms for 15 s asks the engine to raise the
# route's D ("reanchor"), and an implausible timeline re-anchors the leg itself
# ("rebase"). Absent the mode, every path above is the shed path, unchanged.
check("the default mode is shed — onLateness absent changes nothing",
      bs.BacklogShedPolicy().mode == "shed"
      and bs.BacklogShedPolicy(mode="nonsense").mode == "shed")


def rp(**kw):
    args = dict(mode="reanchor", reanchor_tolerance_ms=40, reanchor_hold_ms=15_000,
                retry_ms=30_000, rebase_hold_ms=3_000, rebase_cooldown_ms=60_000)
    args.update(kw)
    return bs.BacklogShedPolicy(**args)


def feed_r(policy, lateness, t0, ms, step=20.0, queued_ms=0.0):
    """Like `feed`, with `lateness` a number or f(t) and a queue level."""
    out = []
    t = t0
    while t <= t0 + ms:
        v = policy.observe(lateness(t) if callable(lateness) else lateness, t,
                           queued_ms=queued_ms)
        if v:
            out.append((v, t))
        t += step
    return out, t


# A floor of 41 ms (one past tolerance) under a lateness that wanders above it.
wobble = lambda t: 41.0 + (t % 700) / 10.0              # 41 … 110.9 ms
p = rp()
verdicts, t = feed_r(p, wobble, 0.0, 14_900)
check("re-anchor: 15 s is the hold — nothing inside it", verdicts == [])
verdicts, t = feed_r(p, wobble, t, 400)
check("re-anchor: a 41 ms floor held 15 s asks once",
      [v for v, _ in verdicts] == ["reanchor"] and verdicts[0][1] >= 15_000)
check("re-anchor: the level asked for is the FLOOR — the minimum sample",
      p.level_ms == 41.0 and p.worst_ms > 100.0)
check("re-anchor: nothing queued means the cause is a late timeline",
      p.cause == "timeline" and p.queued_ms == 0.0)

# One sample back inside tolerance resets the streak, like the shed rule.
p = rp()
verdicts, t = feed_r(p, 60.0, 0.0, 14_900)
check("re-anchor: one sample at tolerance resets the hold",
      p.observe(40.0, t) is None)
verdicts, t = feed_r(p, 60.0, t + 20, 14_900)
check("re-anchor: and the hold restarts from zero", verdicts == [])

# The cause comes from the queue walk at maturity (lazily, once).
calls = []
def _q():
    calls.append(1)
    return 180.0
p = rp()
verdicts, t = feed_r(p, 120.0, 0.0, 15_100, queued_ms=_q)
check("re-anchor: data parked upstream makes the cause a backlog",
      [v for v, _ in verdicts] == ["reanchor"] and p.cause == "backlog"
      and p.queued_ms == 180.0 and len(calls) == 1)
check("re-anchor: an unknown queue reads as a backlog (the shed rule's convention)",
      (lambda q: (feed_r(q, 120.0, 0.0, 15_100, queued_ms=None), q.cause)[1])(rp()) == "backlog")

# No second request until the retry gate opens or the budget moves.
p = rp()
verdicts, t = feed_r(p, 120.0, 0.0, 15_100)
first_at = verdicts[0][1]
p.request_sent(first_at, 60.0)
check("re-anchor: request_sent counts the request", p.requests == 1)
verdicts, t = feed_r(p, 120.0, t, first_at + 29_800 - t)
check("re-anchor: still late, but no re-ask inside the 30 s retry window", verdicts == [])
verdicts, t = feed_r(p, 120.0, t, 600)
check("re-anchor: the retry window over, a still-late leg asks again",
      [v for v, _ in verdicts] == ["reanchor"] and verdicts[0][1] >= first_at + 30_000)

# A budget change (the engine's raise landing) restarts both the streak and
# the gate, so a still-late leg re-asks after one fresh hold, not 30 s.
p = rp()
check("re-anchor: the first budget seen is a baseline, not a move",
      p.budget_moved(60.0) is False and p.budget_moved(60.2) is False)
verdicts, t = feed_r(p, 120.0, 0.0, 15_100)
p.request_sent(verdicts[0][1], 60.0)
moved_at = t
check("re-anchor: a raise landing is a budget move", p.budget_moved(220.0) is True)
check("re-anchor: the same budget again is not", p.budget_moved(220.0) is False)
verdicts, t = feed_r(p, 50.0, t, 14_800)
check("re-anchor: after the move the hold is paid again from scratch", verdicts == [])
verdicts, t = feed_r(p, 50.0, t, 400)
check("re-anchor: and a still-late leg re-asks then, the retry gate cleared",
      [v for v, _ in verdicts] == ["reanchor"] and verdicts[0][1] < moved_at + 16_000)

# Implausible readings: never a raise. A PAST one (buffers keep flowing) holds
# 3 s on in-range-free samples; one in-range sample cancels the hold.
p = rp()
check("re-anchor: an implausible reading is reported once",
      p.observe(21_000.0, 0.0) == "implausible" and p.implausible_since == 0.0
      and p.last_implausible_ms == 21_000.0)
verdicts, t = feed_r(p, 21_000.0, 20.0, 2_900)
check("re-anchor: and latched — nothing more inside the 3 s rebase hold", verdicts == [])
check("re-anchor: the first in-range sample clears it",
      p.observe(10.0, t) is None and p.implausible_since is None)
verdicts, t = feed_r(p, 21_000.0, t + 20, 2_900)
check("re-anchor: so a past-stamped hold restarts after a good sample",
      [v for v, _ in verdicts] == ["implausible"])
verdicts, t = feed_r(p, 21_000.0, t, 200)
check("re-anchor: 3 s of past-stamped samples are due a rebase",
      [v for v, _ in verdicts][:1] == ["rebase"])
p.rebased(t)
check("re-anchor: rebased() counts it and clears the episode",
      p.rebases == 1 and p.implausible_since is None)
# A FUTURE stamp parks a sync=true sink on its first buffer — no later sample
# can confirm it, so it is due at once.
p = rp()
check("re-anchor: a future-stamped reading is due a rebase at once",
      p.observe(-20_000.0, 0.0) == "rebase" and p.last_implausible_ms == -20_000.0)
p.rebased(0.0)
check("re-anchor: inside the rebase cooldown it is only reported",
      p.observe(-20_000.0, 30_000.0) == "implausible"
      and p.observe(-20_000.0, 30_020.0) is None)
check("re-anchor: and due again once the minute is up",
      p.observe(-20_000.0, 60_000.0) == "rebase")

# A hold is evidence only while samples keep arriving (field 2026-10-09): a brief
# burst armed the past-stamped hold, an 88 s outage followed, and the first —
# stale — buffer after it was rebased on, the outage having "paid" the 3 s.
p = rp()
verdicts, t = feed_r(p, 26_600.0, 0.0, 2_000)
check("gap: a 2 s implausible burst is reported and held",
      [v for v, _ in verdicts] == ["implausible"])
check("gap: the first sample after an 88 s gap opens a NEW episode, no rebase",
      p.observe(114_300.0, t + 87_900.0) == "implausible")
check("gap: and the next, in-range, sample ends it",
      p.observe(-1_900.0, t + 87_927.0) is None and p.implausible_since is None)
verdicts, t = feed_r(p, 21_000.0, t + 90_000.0, 2_900)
check("gap: a fresh past-stamped run still needs its own 3 s",
      [v for v, _ in verdicts] == ["implausible"])
verdicts, _ = feed_r(p, 21_000.0, t, 200)
check("gap: and is rebased once it has them", [v for v, _ in verdicts][:1] == ["rebase"])
p = rp()
verdicts, t = feed_r(p, 21_000.0, 0.0, 1_500)
verdicts, _ = feed_r(p, 21_000.0, t + 900.0, 1_500)
check("gap: a pause under GAP_RESET_MS is jitter — the hold survives it",
      [v for v, _ in verdicts][:1] == ["rebase"])
p = rp()
feed_r(p, 120.0, 0.0, 14_000)
verdicts, _ = feed_r(p, 120.0, 15_000.0, 2_000)
check("gap: the raise hold restarts across a gap too", verdicts == [])

# Future stamps right after a rebase that moved the leg LATER: that rebase
# overshot. It is undone at once, cooldown or not — a minute of future stamps
# parks a video sink and, on pulsesink, overflows PipeWire's buffer for good.
p = rp()
verdicts, _ = feed_r(p, 25_000.0, 0.0, 2_980)
check("undo: a past-stamped run is reported, then rebased after its hold",
      [v for v, _ in verdicts] == ["implausible"] and p.observe(25_000.0, 3_000.0) == "rebase")
p.rebased(3_000.0)
check("undo: future stamps right after it are rebased at once, inside the cooldown",
      p.observe(-25_000.0, 3_020.0) == "rebase")
p.rebased(3_020.0)
check("undo: only once — future stamps after the undo are only reported",
      p.observe(-25_000.0, 3_040.0) == "implausible" and p.observe(-25_000.0, 3_060.0) is None)
p = rp()
feed_r(p, 25_000.0, 0.0, 2_980)
p.observe(25_000.0, 3_000.0)
p.rebased(3_000.0)
verdicts, _ = feed_r(p, 25_000.0, 3_020.0, 10_000)
check("undo: PAST stamps after a past rebase still wait out the cooldown",
      [v for v, _ in verdicts] == ["implausible"])

# Whatever it is fed, re-anchor mode never asks for a shed and never reports a
# shed-mode "timeline" refusal.
import random
rng = random.Random(7)
p = rp(reanchor_hold_ms=200, retry_ms=300, rebase_hold_ms=100, rebase_cooldown_ms=500)
seen = set()
t = 0.0
for _ in range(20_000):
    v = p.observe(rng.choice([-30_000.0, -500.0, 0.0, 39.0, 41.0, 900.0, 5_000.0, 30_000.0])
                  if rng.random() < 0.05 else rng.uniform(-100.0, 2_000.0), t,
                  queued_ms=rng.choice([0.0, 500.0]))
    if v == "rebase":
        p.rebased(t)
    if v:
        seen.add(v)
    t += 20.0
check("re-anchor: never 'shed', never 'timeline' — only its own verdicts",
      seen <= {"reanchor", "rebase", "implausible"} and "reanchor" in seen and "rebase" in seen)
# A SEGMENT (reset) drops the re-anchor streak too.
p = rp()
feed_r(p, 120.0, 0.0, 14_000)
p.reset()
verdicts, _ = feed_r(p, 120.0, 14_020, 14_000)
check("re-anchor: reset() drops the streak (a new segment is a new timeline)", verdicts == [])

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All backlog shed policy tests passed.")
