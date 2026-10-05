#!/usr/bin/env python3
"""Self-checking tests for the python runner's live input branches:
`bus_input_add` / `bus_input_remove` (idempotent), the containment helpers
(`_live_branch_ancestor`, `_drop_live_branch`) and the source gate's view of
branch bins (`sources_by_factory` enters declared bins only,
`forget_sources_in` releases a leaving branch's heads).

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run:  python3 gst_live_inputs_test.py
"""
import importlib.util
import os
import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_live_inputs_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
import gst_source_gate as source_gate  # noqa: E402

Gst.init([])
_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


CAPS = "audio/x-raw,rate=48000,channels=2"
MIXER = ("audiomixer name=mixin force-live=true latency=100000000 min-upstream-latency=100000000"
         f" start-time-selection=first ! {CAPS} ! identity name=mixin_out sync=true ! fakesink sync=false"
         f"  ( name=mixin_in_a audiotestsrc is-live=true ! audioconvert ! {CAPS} ! queue ) ! mixin.sink_0")


class Capture:
    def __init__(self):
        self.events = []
        self.errors = []

    def event(self, ev):
        self.events.append(ev)

    def error(self, req_id, message):
        self.errors.append((req_id, message))

    def last(self, name):
        for ev in reversed(self.events):
            if ev.get("event") == name:
                return ev
        return None


def with_pipeline():
    cap = Capture()
    runner.emit_event = cap.event
    runner.emit_command_error = cap.error
    runner.pipeline = Gst.parse_launch(MIXER)
    runner._live_input_branches.clear()
    runner._live_input_branches.add("mixin_in_a")
    source_gate.live_branches = runner._live_input_branches
    runner.pipeline.set_state(Gst.State.PLAYING)
    runner.pipeline.get_state(2 * Gst.SECOND)
    return cap


def teardown():
    if runner.pipeline is not None:
        runner.pipeline.set_state(Gst.State.NULL)
        runner.pipeline = None


def test_add_remove():
    cap = with_pipeline()
    try:
        branch = f"audiotestsrc is-live=true freq=880 ! audioconvert ! {CAPS} ! queue"
        runner.handle_bus_input_add({"id": "a1", "element": "mixin", "name": "mixin_in_b", "description": branch})
        done = cap.last("bus_input_add_done")
        check("add -> bus_input_add_done", done is not None and done.get("id") == "a1")
        check("added bin is in the pipeline", runner.pipeline.get_by_name("mixin_in_b") is not None)
        check("added bin is tracked", "mixin_in_b" in runner._live_input_branches)
        mixer = runner.pipeline.get_by_name("mixin")
        check("mixer gained a request pad", mixer.get_static_pad("sink_1") is not None)

        runner.handle_bus_input_add({"id": "a2", "element": "mixin", "name": "mixin_in_b", "description": branch})
        check("duplicate add is a no-op done", cap.last("bus_input_add_done").get("id") == "a2" and not cap.errors)

        runner.handle_bus_input_add({"id": "a3", "element": "nope", "name": "mixin_in_c", "description": branch})
        check("unknown aggregator -> command_error", cap.errors and cap.errors[-1][0] == "a3")

        runner.handle_bus_input_remove({"id": "r1", "element": "mixin", "name": "mixin_in_b"})
        check("remove -> bus_input_remove_done", cap.last("bus_input_remove_done").get("id") == "r1")
        check("removed bin is gone", runner.pipeline.get_by_name("mixin_in_b") is None)
        check("removed bin is untracked", "mixin_in_b" not in runner._live_input_branches)
        check("mixer released the request pad", mixer.get_static_pad("sink_1") is None)

        runner.handle_bus_input_remove({"id": "r2", "element": "mixin", "name": "mixin_in_b"})
        check("removing a gone branch is a no-op done", cap.last("bus_input_remove_done").get("id") == "r2")

        _ret, state, _pending = runner.pipeline.get_state(0)
        check("pipeline still PLAYING after add/remove", state == Gst.State.PLAYING)
    finally:
        teardown()


def test_containment_helpers():
    cap = with_pipeline()
    try:
        bin_ = runner.pipeline.get_by_name("mixin_in_a")
        src = None
        it = bin_.iterate_sources()
        ok, src = it.next()
        check("live branch ancestor of an element inside the bin", runner._live_branch_ancestor(src) == "mixin_in_a")
        check("no ancestor for a top-level element", runner._live_branch_ancestor(runner.pipeline.get_by_name("mixin")) is None)
        check("drop_branch takes the bin out", runner._drop_live_branch("mixin_in_a") is True)
        check("dropped bin gone + untracked",
              runner.pipeline.get_by_name("mixin_in_a") is None and "mixin_in_a" not in runner._live_input_branches)
        check("drop of an unknown branch is False", runner._drop_live_branch("mixin_in_a") is False)
        _ret, state, _pending = runner.pipeline.get_state(0)
        check("pipeline still PLAYING with its only branch dropped (force-live silence)", state == Gst.State.PLAYING)
        check("no error event emitted by the drop", cap.last("error") is None)
    finally:
        teardown()


def test_gate_sees_declared_bins_only():
    pipe = Gst.parse_launch(
        "fakesink name=s1  ( name=live_in unixfdsrc socket-path=/tmp/mr-live-test-a.sock ! queue ! fakesink ) "
        " ( name=other_bin unixfdsrc socket-path=/tmp/mr-live-test-b.sock ! queue ! fakesink )"
    )
    source_gate.live_branches = {"live_in"}
    heads = source_gate.sources_by_factory(pipe, "unixfdsrc")
    names = sorted(h.get_property("socket-path") for h in heads)
    check("sources_by_factory enters the declared live bin only", names == ["/tmp/mr-live-test-a.sock"])

    # forget_sources_in releases a leaving branch's heads from the data wait.
    live_bin = pipe.get_by_name("live_in")
    head = heads[0]
    dw = {"pending": {id(head)}, "fired": False, "sockets": ["/tmp/mr-live-test-a.sock"],
          "identity": {"/tmp/mr-live-test-a.sock": None}, "probes": [], "warn_id": None, "poll_id": None,
          "warned": False, "timeout_ms": 10000}
    source_gate.data_wait = dw
    source_gate.forget_sources_in(live_bin)
    check("forget_sources_in clears the head from pending", not dw["pending"])
    check("forget_sources_in drops its socket from the poll", dw["sockets"] == [] and dw["identity"] == {})
    check("forget_sources_in fires data_arrived when the last head leaves", dw["fired"] is True)
    source_gate.data_wait = None
    source_gate.live_branches = set()


test_add_remove()
test_containment_helpers()
test_gate_sees_declared_bins_only()

if _failures:
    print(f"\n{len(_failures)} FAILED: {_failures}")
    sys.exit(1)
print("All live input branch tests passed.")
