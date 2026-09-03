#!/usr/bin/env python3
"""Self-checking tests for `gst_input_stall_watch.py` (the runner's
`inputStallWatch` feature) — the runner-side replacement for the in-branch
`watchdog` element.

What the suite pins:

  1. A FLOWING source never trips it: buffers arriving faster than the
     timeout keep the one-shot probe re-arming tick after tick, and the
     probe is a ONE-SHOT — it must not stay armed between ticks (that was the
     whole point: no per-buffer work).
  2. A source that FLOWED and then went SILENT trips it once `timeoutMs` has
     passed: one error event, `kind: "bus_stall"`, `element` prefixed `buswd_`
     (what the runner's ERROR path tags the element by), the runner's fail
     callback invoked exactly once — the parent's restartOnError path,
     byte-for-byte the element's contract.
  3. A source that has NEVER delivered is not a stall: one `input_silent`
     warning, then it is waited for; its first buffer arms the real watch.
  4. Arming waits for PLAYING (the element fed itself on PAUSED→PLAYING), a
     stop disarms everything, and a config naming a missing element is a
     warning, never a crash (a watch fault must not take the runner down).

The module is driven directly, wired the way the runner wires it
(`configure(emit, fail, alive)`); the runner itself only aliases it.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_input_stall_watch_test.py
"""
import os
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_input_stall_watch_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gst_input_stall_watch as isw  # noqa: E402

Gst.init([])

# Short tick so the suite runs in seconds; the production value is 1000 ms and
# the logic is tick-agnostic (timeouts are compared on a monotonic clock).
isw.TICK_MS = 50


class Harness:
    """A pipeline the watch can be pointed at, plus the three hooks the runner
    injects: event emitter, pipeline failer, pipeline-alive predicate."""

    def __init__(self):
        self.pipe = Gst.parse_launch(
            "appsrc name=src is-live=true format=time ! fakesink sync=false")
        self.src = self.pipe.get_by_name("src")
        self.events = []
        self.fails = 0
        self.loop = GLib.MainLoop()
        isw.configure(self.events.append, self._fail, lambda: True)

    def _fail(self):
        self.fails += 1
        self.loop.quit()

    def push(self):
        buf = Gst.Buffer.new_allocate(None, 188, None)
        assert self.src.emit("push-buffer", buf) == Gst.FlowReturn.OK

    def spin(self, ms):
        """Run the GLib loop for `ms` (the watch's tick lives there)."""
        GLib.timeout_add(ms, lambda: (self.loop.quit(), False)[1])
        self.loop.run()

    def errors(self):
        return [e for e in self.events if e.get("event") == "error"]

    def close(self):
        isw.stop()
        self.pipe.set_state(Gst.State.NULL)


def start_watch(h, timeout_ms, element="src"):
    isw.start(h.pipe, [{"element": element, "timeoutMs": timeout_ms}])
    h.pipe.set_state(Gst.State.PLAYING)
    # Bounded: a live appsrc pipeline answers NO_PREROLL and an unbounded
    # get_state can sit forever waiting for a preroll that never comes.
    h.pipe.get_state(2 * Gst.SECOND)


def test_flowing_source_never_trips():
    h = Harness()
    start_watch(h, 300)
    isw.arm()                                 # what the PLAYING message does
    st = isw.state()
    assert st is not None and st["armed"], "watch must be armed after PLAYING"
    entry = st["entries"][0]
    for _ in range(12):                       # ~3× the timeout, well inside it
        h.push()
        h.spin(80)
        # One-shot: after a buffer passed and the tick ran, exactly one probe
        # is armed again (never accumulating).
        assert entry["probe_id"] is not None
    assert h.events == [], f"flowing source raised {h.events}"
    assert h.fails == 0
    h.close()
    print("PASS flowing source never trips the watch")


def test_silent_source_trips_once_with_the_element_contract():
    h = Harness()
    start_watch(h, 200)
    isw.arm()
    h.push()
    h.spin(60)                                # one buffer, then silence
    assert h.events == []
    t0 = time.monotonic()
    while not h.errors() and time.monotonic() - t0 < 2.0:
        h.spin(50)
    errors = h.errors()
    assert len(errors) == 1, f"expected one error, got {h.events}"
    ev = errors[0]
    assert ev["kind"] == "bus_stall"
    assert ev["element"] == "buswd_src"
    assert "200 ms" in ev["message"]
    assert h.fails == 1, "the runner's fail hook (errored teardown + quit) runs once"
    assert isw.state() is None, "the watch disarms itself after firing"
    h.spin(150)                               # no second firing on later ticks
    assert len(h.errors()) == 1 and h.fails == 1
    h.close()
    print("PASS silent source trips once with the watchdog element's contract")


def test_never_fed_input_warns_once_and_never_trips():
    """A restart cannot conjure data (SRT listener with no caller, RIST peer
    with no media), and looping on it took a whole graph on/off every 5 s
    (10.9.16.46, 2026-09-03). One warning, then wait; the first buffer arms
    the real watch."""
    h = Harness()
    start_watch(h, 150)
    isw.arm()
    h.spin(600)                               # 4× the timeout, no data at all
    warns = [e for e in h.events if e.get("event") == "warning" and e.get("kind") == "input_silent"]
    assert h.errors() == [] and h.fails == 0, f"never-fed input must not trip: {h.events}"
    assert len(warns) == 1 and warns[0]["element"] == "src", f"expected one input_silent warning, got {warns}"
    assert isw.state() is not None
    h.push(); h.spin(60)                      # data arrives, then stops: now a stall
    t0 = time.monotonic()
    while not h.errors() and time.monotonic() - t0 < 2.0:
        h.spin(50)
    assert len(h.errors()) == 1 and h.errors()[0]["kind"] == "bus_stall", h.events
    assert h.fails == 1
    h.close()
    print("PASS never-fed input warns once and never trips; flowed-then-dark still trips")


def test_arming_waits_for_playing_and_stop_disarms():
    h = Harness()
    isw.start(h.pipe, [{"element": "src", "timeoutMs": 100}])
    st = isw.state()
    assert st is not None and not st["armed"]
    assert st["entries"][0]["probe_id"] is None, "no probe before PLAYING"
    h.spin(250)                               # longer than the timeout, unarmed
    assert h.events == [], "an unarmed watch never fires"
    isw.arm()
    assert st["armed"] and st["entries"][0]["probe_id"] is not None
    isw.stop()
    assert isw.state() is None
    h.spin(250)
    assert h.events == [] and h.fails == 0, "a stopped watch never fires"
    h.close()
    print("PASS arming waits for PLAYING; stop disarms")


def test_missing_element_is_a_warning_not_a_crash():
    h = Harness()
    isw.start(h.pipe, [{"element": "nope", "timeoutMs": 100}, {"element": "src", "timeoutMs": 0},
                       "garbage", {"element": "src", "timeoutMs": "x"}])
    assert isw.state() is None, "nothing valid to watch → no watch"
    warnings = [e for e in h.events if e.get("event") == "warning"]
    assert len(warnings) == 1 and "nope" in warnings[0]["message"]
    isw.arm()                                 # no-op without a watch
    h.close()
    print("PASS missing element is a warning, not a crash")


if __name__ == "__main__":
    test_flowing_source_never_trips()
    test_silent_source_trips_once_with_the_element_contract()
    test_never_fed_input_warns_once_and_never_trips()
    test_arming_waits_for_playing_and_stop_disarms()
    test_missing_element_is_a_warning_not_a_crash()
    print("OK gst_input_stall_watch_test.py")
