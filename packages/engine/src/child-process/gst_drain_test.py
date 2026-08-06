#!/usr/bin/env python3
"""Self-checking tests for the EOS drain in gst-pipeline-runner.py.

Runs REAL GStreamer pipelines (videotestsrc → fakesink) through the runner's
own teardown helpers, because the property under test is an ordering one:
EOS must reach the sink BEFORE the pipeline goes to NULL. Stopping a pipeline
mid-decode is what wedges the Pi's stateless HEVC decoder (rpi-hevc-dec,
kernel 6.12) in an uninterruptible kernel wait and takes the box down.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_drain_test.py
"""
import importlib.util
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_drain_test.py — GStreamer unavailable ({exc})")
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


def build(drop_eos=False):
    """A live pipeline plus a downstream-event probe on the sink pad.

    Returns (pipeline, seen) where `seen` collects one entry per EOS event that
    reached the sink: the pipeline state at that moment. `drop_eos=True` makes
    the sink swallow EOS, so the pipeline can never post EOS on the bus — the
    stand-in for a decoder that refuses to drain.
    """
    pipe = Gst.parse_launch("videotestsrc is-live=true ! fakesink sync=false name=sink")
    seen = []

    def on_event(_pad, info):
        event = info.get_event()
        if event and event.type == Gst.EventType.EOS:
            _ret, state, _pending = pipe.get_state(0)
            seen.append(state)
            if drop_eos:
                return Gst.PadProbeReturn.DROP
        return Gst.PadProbeReturn.OK

    pad = pipe.get_by_name("sink").get_static_pad("sink")
    pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, on_event)
    return pipe, seen


def play(pipe):
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * Gst.SECOND)


def state_of(pipe):
    _ret, state, _pending = pipe.get_state(0)
    return state


def collect_events():
    """Swap the runner's event emitter for a collector; returns the list."""
    events = []
    runner.emit_event = lambda obj: events.append(obj)
    return events


# --- a playing pipeline is drained: EOS reaches the sink BEFORE NULL --------
pipe, seen = build()
play(pipe)
check("fixture reaches PLAYING", state_of(pipe) == Gst.State.PLAYING)

started = time.monotonic()
runner._teardown_pipeline(pipe)
elapsed_ms = (time.monotonic() - started) * 1000

check("sink saw exactly one EOS during teardown", len(seen) == 1)
check(
    "pipeline was still PLAYING when EOS reached the sink (EOS before NULL)",
    seen == [Gst.State.PLAYING],
)
check("pipeline ends in NULL", state_of(pipe) == Gst.State.NULL)
check(
    "a draining pipeline does not burn the whole timeout",
    elapsed_ms < runner.EOS_DRAIN_TIMEOUT_MS,
)

# --- drain=False skips the EOS entirely (bus-EOS handler path) --------------
pipe, seen = build()
play(pipe)
runner._teardown_pipeline(pipe, drain=False)
check("drain=False sends no EOS", seen == [])
check("drain=False still ends in NULL", state_of(pipe) == Gst.State.NULL)

# --- nothing in flight: NULL/READY pipelines skip the drain ----------------
pipe, seen = build()
started = time.monotonic()
check("_eos_drain reports success on a NULL pipeline", runner._eos_drain(pipe) is True)
check("_eos_drain sends no EOS to a NULL pipeline", seen == [])
check(
    "_eos_drain returns immediately on a NULL pipeline",
    (time.monotonic() - started) * 1000 < 100,
)
pipe.set_state(Gst.State.NULL)

# --- a pipeline that never drains is forced to NULL after the timeout ------
real_timeout = runner.EOS_DRAIN_TIMEOUT_MS
runner.EOS_DRAIN_TIMEOUT_MS = 300  # keep the test fast; ordering is unchanged
events = collect_events()
pipe, seen = build(drop_eos=True)
play(pipe)
started = time.monotonic()
runner._teardown_pipeline(pipe)
elapsed_ms = (time.monotonic() - started) * 1000
runner.EOS_DRAIN_TIMEOUT_MS = real_timeout

check("a swallowed EOS still reached the sink", len(seen) == 1)
check("teardown waits for the bounded timeout", 250 < elapsed_ms < 3000)
check("teardown reaches NULL anyway after the timeout", state_of(pipe) == Gst.State.NULL)
check(
    "the timeout is reported as a warning",
    any(e.get("event") == "warning" and "EOS drain timed out" in e.get("message", "")
        for e in events),
)

# --- an ERRORED pipeline is drained at the DECODER, not at the source -------
# The field failure this covers: every bus disconnect kills the consumer by
# `unixfdsrc` ERROR first, and a pipeline whose source has already failed can
# never carry a pipeline-level EOS (GstBaseSrc pushes a pending EOS from a
# streaming task that is stopped). The drain used to either return immediately
# or burn its whole budget, and NULL then landed MID-DECODE — `phase1_cb: Post
# wait: 0xffffffff`, the wedge that dirties the block for the next session.
# The decoder is reachable without the source: the keyframe gate already
# resolved its sink pad by name.
def build_branch(with_gate=True):
    """`front` swallows any pipeline-level EOS, so an EOS seen at `vpdec` can
    only have come from the decoder-branch drain."""
    pipe = Gst.parse_launch(
        "videotestsrc is-live=true ! identity name=front ! identity name=vpdec "
        "! fakesink sync=false name=sink")
    seen = {"front": 0, "vpdec": 0}

    def watch(name, swallow):
        def on_event(_pad, info):
            event = info.get_event()
            if event and event.type == Gst.EventType.EOS:
                seen[name] += 1
                if swallow:
                    return Gst.PadProbeReturn.DROP
            return Gst.PadProbeReturn.OK

        pipe.get_by_name(name).get_static_pad("sink").add_probe(
            Gst.PadProbeType.EVENT_DOWNSTREAM, on_event)

    watch("front", True)
    watch("vpdec", False)
    runner._stop_keyframe_gate()          # clear any gate a previous case left
    if with_gate:
        runner._start_keyframe_gate(pipe, {"decoder": "vpdec"})
    return pipe, seen


pipe, seen = build_branch()
play(pipe)
started = time.monotonic()
check("_eos_drain reports the errored pipeline drained", runner._eos_drain(pipe, errored=True) is True)
elapsed_ms = (time.monotonic() - started) * 1000
check("the decoder was handed EOS directly", seen["vpdec"] == 1)
check("no pipeline-level EOS was attempted on the dead source", seen["front"] == 0)
check("the errored drain does not burn the timeout", elapsed_ms < 1000)
pipe.set_state(Gst.State.NULL)
runner._stop_keyframe_gate()

# An ERROR arriving DURING an ordinary drain hands over to the same path —
# it used to be counted as "drained" and returned True with nothing drained.
pipe, seen = build_branch()
play(pipe)
gerror = GLib.Error.new_literal(
    Gst.stream_error_quark(), "synthetic failure", int(Gst.StreamError.FAILED))
pipe.get_bus().post(Gst.Message.new_error(pipe.get_by_name("front"), gerror, "test"))
started = time.monotonic()
check("a bus ERROR mid-drain is not mistaken for a drain", runner._eos_drain(pipe) is True)
check("the ERROR hands over to the decoder branch", seen["vpdec"] == 1)
check(
    "the whole drain still fits one budget",
    (time.monotonic() - started) * 1000 < runner.EOS_DRAIN_TIMEOUT_MS,
)
pipe.set_state(Gst.State.NULL)
runner._stop_keyframe_gate()

# No gated decoder (the decodebin3 bootstrap rung plugs its own): nothing is
# addressable, so the drain reports failure fast and the caller sets NULL —
# no worse than before, and it must not hang looking for a pad.
pipe, seen = build_branch(with_gate=False)
play(pipe)
started = time.monotonic()
check("an ungated errored pipeline reports NOT drained", runner._eos_drain(pipe, errored=True) is False)
check("and nothing was sent into the chain", seen["vpdec"] == 0 and seen["front"] == 0)
check("without waiting for anything", (time.monotonic() - started) * 1000 < 500)
pipe.set_state(Gst.State.NULL)

# `_teardown_pipeline` plumbs the flag through — the bus ERROR handler is the
# only caller that sets it.
pipe, seen = build_branch()
play(pipe)
runner._teardown_pipeline(pipe, errored=True)
check("_teardown_pipeline(errored=True) drains the decoder branch", seen["vpdec"] == 1)
check("and still ends in NULL", state_of(pipe) == Gst.State.NULL)
runner._stop_keyframe_gate()

# --- the timeout fits the parent's kill window, and is long enough to work ---
# Upper bound: PythonProcess.FORCE_KILL_TIMEOUT_MS is 8000 ms and must cover the
# drain plus the NULL transition (>= drain + 1000, pinned in
# eosDrainContract.test.ts). Lower bound: the bootstrap decodebin3 chain buffers
# seconds of data, so a shorter cap fires before EOS reaches the bus and NULL
# lands mid-decode — the Pi 400 STREAMOFF hang this drain exists to avoid.
check(
    "EOS_DRAIN_TIMEOUT_MS leaves room under the 8000 ms force-kill window",
    6000 <= real_timeout <= 7000,
)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst drain tests passed.")
