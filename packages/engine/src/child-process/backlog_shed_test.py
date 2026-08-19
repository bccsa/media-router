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

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All backlog shed policy tests passed.")
