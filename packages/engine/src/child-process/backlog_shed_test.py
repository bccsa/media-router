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
    timeline you are not on drops the whole stream,
  * an ARMED leg re-anchors only a STEADY implausible run (a pad offset fixes a
    constant, nothing else) and undoes the move once its own stamps are back.

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


def feed(policy, lateness_ms, t0, ms, step=20.0, budget_ms=0.0):
    """Feed `lateness_ms` (a number, or a function of t) from t0 for `ms`, one
    sample every `step`. Returns (verdicts, next_t) — verdicts are the non-None
    returns, in order."""
    out = []
    t = t0
    end = t0 + ms
    while t <= end:
        late = lateness_ms(t) if callable(lateness_ms) else lateness_ms
        v = policy.observe(late, t, budget_ms=budget_ms)
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

# --- the in-place re-anchor (armed sink-point legs) -----------------------------
# .24, 2026-10-04: after its source came back from a reboot on an earlier PTS
# epoch, the decoder leg's running tsdemux timestamped nothing and avdec_aac
# carried the pre-outage timeline on — 588 s late at the sink, silence, for
# good. On an ARMED leg a reading held steadily past the ceiling is a lost
# timeline: re-anchor.
# (Samples fed after a re-anchor are what the runner then reads: the leg as
# moved. In the runner the moved peer re-sends its SEGMENT, which resets.)
LOST = 587_803.0
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
check("an armed leg still reports the first implausible sample",
      p.observe(LOST, 0.0) == "implausible")
verdicts, t = feed(p, LOST, 20.0, 2_960)
check("held under 3 s: nothing yet (a producer re-anchor gets the first go)", verdicts == [])
check("held 3 s: one re-anchor, the moment the hold matures",
      t == 3_000.0 and p.observe(LOST, t) == "reanchor")
check("...by the run's floor, counted, and that is the leg's net move",
      p.reanchor_ms == LOST and p.reanchors == 1 and p.offset_ms == LOST)
# The floor is an AGE (lateness + budget, the buffer's distance from now), so
# the correction puts the floor buffer ON ARRIVAL: a full budget ahead of its
# deadline, where a fresh start would place it — never at the deadline itself.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
feed(p, LOST, 0.0, 2_980, budget_ms=160.0)
check("with a 160 ms budget the correction is the excess plus that budget",
      p.observe(LOST, 3_000.0, budget_ms=160.0) == "reanchor" and p.reanchor_ms == LOST + 160.0)
# The FLOOR, not the worst: a spike cannot move it.
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
for late, at in ((30_000.0, 0.0), (30_180.0, 100.0), (29_950.0, 200.0)):
    p.observe(late, at)
check("the correction is the run's least-late reading",
      p.observe(30_010.0, 1_000.0) == "reanchor" and p.reanchor_ms == 29_950.0)

# STEADY: a pad offset is a constant, so only a timeline off by a constant is
# one it can fix. Arrival jitter is not movement (.24's backward-epoch runs
# moved 88-190 ms over their hold): a ±400 ms wobble still matures on time.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
verdicts, t = feed(p, lambda t: 40_000.0 + (400.0 if int(t / 100) % 2 else -400.0), 0.0, 3_000)
check("jitter inside REANCHOR_STEADY_MS still re-anchors when the hold matures",
      [v for v, _ in verdicts] == ["implausible", "reanchor"] and verdicts[1][1] == 3_000.0
      and p.reanchor_ms == 39_600.0)
check("REANCHOR_STEADY_MS is 1 s", bs.REANCHOR_STEADY_MS == 1_000.0)
# A reading that STEPS is a new level: the hold starts over, and it is the new
# level that gets corrected — never the old one, which would overshoot by 15 s.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
feed(p, 40_000.0, 0.0, 1_000)
verdicts, t = feed(p, 25_000.0, 1_020.0, 2_960)
check("a reading that steps inside the hold starts it over", verdicts == [])
verdicts, t = feed(p, 25_000.0, t, 100)
check("...and the new level matures 3 s after the step, corrected by itself",
      verdicts[:1] == [("reanchor", 4_020.0)] and p.reanchor_ms == 25_000.0)
# A producer still MOVING its stamps is not a lost timeline. .24, 2026-10-05,
# replayed at its own numbers: ~190 s after a 200 s outage the Hall-audio
# transcoder's egress froze Headphone1's stamps 189 s in the past for 15.4 s —
# lateness climbing 1 s/s — then put them back. Three re-anchors chased it, none
# produced audio, and the last kept the leg silent 7.9 s past the producer's
# own return.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
verdicts, t = feed(p, lambda t: 189_264.5 + t, 0.0, 15_400, budget_ms=240.0)
verdicts2, t = feed(p, -57.0, t, 10_000, budget_ms=240.0)
check("frozen producer stamps (lateness climbing 1 s/s for 15 s) are never re-anchored",
      [v for v, _ in verdicts + verdicts2] == ["implausible"] and p.reanchors == 0)
check("...so the moment the producer puts them back the leg plays, unmoved",
      p.offset_ms == 0.0 and not p.holding_early)
# An INPUT GAP starts the hold over: what follows may be another timeline, and
# the hold is there so the producer's nets get the first second after a resume.
# (.24, 2026-10-05: an early run opened before a 40 s outage fired on the first
# buffer after it, on the pre-outage floor.)
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
verdicts, t = feed(p, -201_545.0, 0.0, 2_000)
verdicts2, t = feed(p, -201_545.0, 42_000.0, 2_960)
check("a run that spans an input gap does not mature on the buffers after it",
      [v for v, _ in verdicts + verdicts2] == ["implausible"] and p.holding_early)
verdicts, t = feed(p, -201_545.0, t, 40)
check("...3 s of post-gap readings do", [v for v, _ in verdicts][:1] == ["reanchor"])

# UNDONE the moment the leg's OWN stamps are back on time (its producer
# recovered, a pinned PCR let go): from then on the correction is the error.
# At once — every buffer held back would be silence the leg does not need.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
feed(p, 40_000.0, 0.0, 3_000, budget_ms=160.0)
check("re-anchored by +40 160 ms", p.offset_ms == 40_160.0)
verdicts, t = feed(p, -160.0, 3_020.0, 5_000, budget_ms=160.0)
check("a moved leg playing on arrival stays moved", verdicts == [] and p.offset_ms == 40_160.0)
check("its own stamps back on time: undone at once, by exactly the net move",
      p.observe(-40_100.0, t, budget_ms=160.0) == "restore"
      and p.reanchor_ms == -40_160.0 and p.offset_ms == 0.0)
verdicts, t = feed(p, -100.0, t + 20.0, 5_000, budget_ms=160.0)
check("...after which it is an ordinary on-time leg", verdicts == [] and p.reanchors == 1)
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
feed(p, 30_000.0, 0.0, 1_000)
check("...however soon after the re-anchor that happens",
      p.observe(-29_990.0, 1_020.0) == "restore" and p.offset_ms == 0.0)
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
feed(p, -50_000.0, 0.0, 1_000)
check("an EARLY move is undone the same way",
      p.offset_ms == -50_000.0 and p.observe(49_950.0, 1_020.0) == "restore"
      and p.offset_ms == 0.0)
# A timeline that comes back only PART way (its own stamps still 5 s late) is
# not undone — that would leave it silent below the ceiling — but re-anchored
# by the rest: the net move becomes what its own stamps are still off by.
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
feed(p, 30_000.0, 0.0, 1_000)
verdicts, t = feed(p, -25_000.0, 1_020.0, 1_000)
check("a partial return is re-anchored by the rest, not undone",
      [v for v, _ in verdicts] == ["implausible", "reanchor"] and p.reanchor_ms == -25_000.0
      and p.offset_ms == 5_000.0)
# Lost AGAIN while moved: moved again; the moves add up and one restore takes
# all of them back.
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
feed(p, 30_000.0, 0.0, 1_000)
feed(p, 20_000.0, 1_020.0, 1_000)
check("moves add up", p.reanchors == 2 and p.offset_ms == 50_000.0)
check("...and one restore takes them all back",
      p.observe(-49_900.0, 2_040.0) == "restore" and p.reanchor_ms == -50_000.0)

# THE CASE IT MUST NEVER ACT ON: every AAC decoder flushes its last pre-outage
# frame when the first post-outage one arrives, so every outage past the ceiling
# hands the sink ONE implausible buffer even when the producer is healthy.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
check("one stale buffer is reported", p.observe(LOST, 0.0) == "implausible")
verdicts, t = feed(p, -180.0, 20.0, 10_000)
check("...and a leg back on time never re-anchors", verdicts == [] and p.reanchors == 0)

# The 302M leg of the same outage: implausible for 1.06 s until its transcoder's
# egress net re-anchored the stamps, then on time. Inside the hold: untouched.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
verdicts, t = feed(p, 587_782.0, 0.0, 1_060)
verdicts2, t = feed(p, -200.0, t, 10_000)
check("a leg its producer recovers inside the hold is never re-anchored",
      [v for v, _ in verdicts + verdicts2] == ["implausible"] and p.reanchors == 0)

# Unarmed (the video decoder point, an older engine): the old contract exactly.
p = bs.BacklogShedPolicy()
verdicts, t = feed(p, LOST, 0.0, 60_000)
check("unarmed: an implausible run is only ever reported",
      [v for v, _ in verdicts] == ["implausible"] and not p.holding_early)
check("a zero hold is unarmed too", bs.BacklogShedPolicy(reanchor_hold_ms=0).reanchor_hold_ms is None)

# EARLY: a timeline far in the future. A sync=true audio sink parks its
# streaming thread on the first such buffer until its time comes, so the run is
# held as early (the runner drops) and then re-anchored backwards.
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
check("an early run is reported", p.observe(-587_000.0, 0.0) == "implausible")
check("...and held as early from its first sample", p.holding_early)
p.observe(-587_040.0, 20.0)
verdicts, t = feed(p, -587_000.0, 40.0, 2_940)
check("...held for the whole hold", verdicts == [] and p.holding_early)
check("...then re-anchored backwards by its floor (the earliest reading)",
      p.observe(-587_000.0, t) == "reanchor" and p.reanchor_ms == -587_040.0)
check("...after which nothing is held", not p.holding_early)
p = bs.BacklogShedPolicy(reanchor_hold_ms=3_000)
p.observe(25_000.0, 0.0)
check("a LATE run is never held as early", not p.holding_early)
# EARLY means stamped in the FUTURE (age < −ceiling), not "far ahead of its
# deadline": a healthy leg whose budget exceeds the ceiling (D at its 10 s
# maximum plus the sink's latency) reads lateness ≈ −budget on arrival, and must
# never be dropped or moved off the budget it is honouring.
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
verdicts, t = feed(p, -10_100.0, 0.0, 5_000, budget_ms=10_160.0)
check("a budget past the ceiling is not an early timeline",
      verdicts == [] and not p.holding_early and p.reanchors == 0)
check("an unarmed leg never holds an early run",
      bs.BacklogShedPolicy().observe(-25_000.0, 0.0) == "implausible"
      and not bs.BacklogShedPolicy().holding_early)

# A run that flips side is a different timeline (twice the ceiling apart, far
# past REANCHOR_STEADY_MS), so the hold restarts.
p = bs.BacklogShedPolicy(reanchor_hold_ms=1_000)
verdicts, t = feed(p, 40_000.0, 0.0, 900)
verdicts2, t = feed(p, -40_000.0, t, 900)
check("a run that flips side restarts the hold",
      [v for v, _ in verdicts + verdicts2] == ["implausible"])
verdicts, t = feed(p, -40_000.0, t, 200)
check("...and matures on its own side", [v for v, _ in verdicts][:1] == ["reanchor"]
      and p.reanchor_ms == -40_000.0)

# A re-anchor never feeds the shed streak: the leg comes back inside budget.
p = bs.BacklogShedPolicy(tolerance_ms=250, hold_ms=1_000, reanchor_hold_ms=1_000)
feed(p, 90_000.0, 0.0, 1_100)
verdicts, t = feed(p, 800.0, 1_120.0, 900)
check("the streak after a re-anchor starts from zero", verdicts == [])

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

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All backlog shed policy tests passed.")
