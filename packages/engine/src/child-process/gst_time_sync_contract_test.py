#!/usr/bin/env python3
"""Self-checking tests for the time-sync contract clock in gst-pipeline-runner.py.

Runs REAL GStreamer pipelines through `_apply_contract_clock`, because the
properties under test are ones only GStreamer itself can confirm: that the
pinned timeline SURVIVES the state change. GstPipeline recomputes base-time on
PAUSED→PLAYING unless the pipeline's start-time is CLOCK_TIME_NONE, so a
`set_base_time(0)` in the wrong place looks perfectly correct in the source and
is silently thrown away the moment the pipeline plays — leaving every pipeline
on its own per-start base-time, which is the drift the contract exists to
remove (ADR-0005: running-time ≡ house-clock time).

Also pins the two halves of the contract's "never blocks playback" promise:
the clock is the monotonic system clock (no daemon to reach), and applying it
never pulls in GstNet.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_time_sync_contract_test.py
"""
import importlib.util
import os
import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_time_sync_contract_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def build():
    """A live pipeline, cheap enough to actually reach PLAYING."""
    return Gst.parse_launch("fakesrc is-live=true ! fakesink sync=false name=sink")


print("\n--- the contract clock is a monotonic system clock ---")
pipe = build()
runner._apply_contract_clock(pipe)
# get_clock() is only populated by the state change; the SELECTED clock is
# readable straight away via the pipeline accessor.
clock = pipe.get_pipeline_clock()
check("a clock is selected before any state change", clock is not None)
check(
    "it is the system clock, not an element-provided one",
    isinstance(clock, Gst.SystemClock),
)
check(
    "its clock-type is MONOTONIC (no wall-clock steps mid-stream)",
    clock.get_property("clock-type") == Gst.ClockType.MONOTONIC,
)
# use_clock() (not set_clock()) is what pins it: auto-selection is off, so a
# pulsesink or a source providing its own clock can never displace it.
check(
    "the clock is FIXED — auto-selection is off",
    bool(pipe.flags & Gst.PipelineFlags.FIXED_CLOCK),
)
check(
    "GstNet was never imported — nothing external is contacted",
    runner._GstNet is None,
)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(2 * Gst.SECOND)
check("the pipeline actually runs on it", pipe.get_clock() == clock)
pipe.set_state(Gst.State.NULL)


print("\n--- the pinned timeline survives the state change ---")
pipe = build()
runner._apply_contract_clock(pipe)
check("start-time is CLOCK_TIME_NONE before PLAYING", pipe.get_start_time() == Gst.CLOCK_TIME_NONE)
check("base-time is 0 before PLAYING", pipe.get_base_time() == 0)

pipe.set_state(Gst.State.PLAYING)
pipe.get_state(2 * Gst.SECOND)
# THE regression guard: GstPipeline resets base-time to (now - start_time) on
# PAUSED→PLAYING for any start-time that is not CLOCK_TIME_NONE.
check("base-time is STILL 0 after PLAYING", pipe.get_base_time() == 0)
check("start-time is still CLOCK_TIME_NONE after PLAYING", pipe.get_start_time() == Gst.CLOCK_TIME_NONE)

# Running-time ≡ clock time is the whole contract: a consumer's stamped PTS
# means the same instant here as in the producer's process.
clock_time = pipe.get_clock().get_time()
running_time = clock_time - pipe.get_base_time()
check("running-time equals clock time", running_time == clock_time)

# A pause/play cycle is where a non-NONE start-time would latch a new
# base-time (the runner's restart loop re-enters PLAYING).
pipe.set_state(Gst.State.PAUSED)
pipe.get_state(2 * Gst.SECOND)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(2 * Gst.SECOND)
check("base-time is still 0 after a PAUSED→PLAYING cycle", pipe.get_base_time() == 0)
pipe.set_state(Gst.State.NULL)


print("\n--- the legacy path is untouched ---")
pipe = build()
# _apply_net_clock with no config is the no-clock case every non-sync pipeline
# takes: it must leave the pipeline on its own auto-selected clock.
runner._apply_net_clock(pipe, None)
check(
    "no clock config → the clock is NOT pinned (auto-selection intact)",
    not (pipe.flags & Gst.PipelineFlags.FIXED_CLOCK),
)
check(
    "no clock config → start-time untouched (0, not NONE)",
    pipe.get_start_time() == 0,
)
pipe.set_state(Gst.State.NULL)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst time-sync contract tests passed.")
