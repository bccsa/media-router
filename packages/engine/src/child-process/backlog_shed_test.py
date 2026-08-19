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

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All backlog shed policy tests passed.")
