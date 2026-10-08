#!/usr/bin/env python3
"""The time-sync contract's latency RATCHET, and the shedder that cures it.

Promoted from the diagnosis reproduction (2026-08-13/14, .42). The fault:

    `pipelines.ts` sized the video leg's leaky queues on the assumption that
    "latency is unaffected in steady state — a leaky queue only holds data
    while downstream is stalled". True for the sink that sentence was written
    for (`sync=false`, presents on arrival): a backlog is consumed as fast as
    it can be and drains itself. The contract turns the same sink `sync=true`,
    which drains at exactly MEDIA rate — so a backlog created by any downstream
    stall is never given back. Retained latency ratchets up one hiccup at a
    time until frames start being dropped for lateness. Field: 50 fps decoded,
    2.5 fps on the glass, after ~16 h.

Four arms of the SAME chain, in compressed time, with brief stalls injected.
The first two isolate the ONE-WAY property on a chain with spare rate; the last
two are the field condition, a presentation chain with almost none:

    A  legacy   `sync=false`, spare rate    → keeps its whole playout budget
    B  contract `sync=true`,  spare rate    → gives the budget up, for ever
    C  contract `sync=true`,  media-rate    → the ratchet, unfixed (control)
    D  contract `sync=true`,  media-rate, shedder ON → sheds, returns to D
    E  as D in re-anchor mode, the test applying each raise → back inside D, zero drops
    F  as E with raises capped at +200 ms → refused past the cap, never shed

Arms A and B are the mechanism: the only difference between them is that a
`sync=true` sink WAITS for each buffer's slot, so it can never claw back the
part of a stall that leaves it merely on time — it hands its playout budget over
one stall at a time and never takes it back, while the arrival-driven sink gives
up nothing. Arms C and D add what a real presentation chain does not have: spare
rate. waylandsink is paced by the compositor's frame callbacks and a DAC by its
sample rate, so retention past the budget is not drained either, and THAT is the
condition the shedder exists for. Arm C is the control that keeps D honest —
without it, a passing D would be equally consistent with a fixture that never
reproduced the fault.

The legacy path is guarded here by arm A and, more directly, by the runner
property that nothing is armed at all when no `backlogShed` config is sent (the
contract-off case) — see gst_backlog_shed_test.py.

Measured INDEPENDENTLY of the shedder's own arithmetic: the probe below sits on
the SINK pad and computes lateness from the pipeline clock, the buffer PTS and
the sink's `ts-offset` — the shedder's numbers are never consulted, only its
events are counted.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_latency_ratchet_test.py
"""
import importlib.util
import math
import os
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_latency_ratchet_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# See gst_backlog_shed_test.py: `MR_SHED_RUNNER` aims the suite at a mutated
# runner copy, which is how the shedder is falsified.
_RUNNER = os.environ.get("MR_SHED_RUNNER") or os.path.join(_HERE, "gst-pipeline-runner.py")
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(_RUNNER)))
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

_failures = []

FPS = 50
BUDGET_MS = 300                 # the route's playout offset D
# The leg's TOTAL retention capacity, not one queue: the field chain holds its
# backlog across the jitter queue, the 1 s ES queue and the decoder. Sized so
# this fixture never LEAKS — a leak drops the oldest data by itself, which is
# the very thing under test and would confound every measurement here.
QUEUE_MS = 2_000
GOP = 25                        # a keyframe every 0.5 s, as a broadcast feed
STALLS = 3
STALL_MS = 400                  # each stall stands in for one field hiccup
GAP_S = 2.0
# The presentation chain's real drain ceiling. A `fakesink` renders a late
# buffer for FREE, so it silently gives any backlog back the moment it stops
# waiting — no real presentation sink can: waylandsink is paced by the
# compositor's frame callbacks and a DAC by its sample rate, so the surplus over
# media rate is a few percent at best. Without this the fixture cannot reproduce
# retention at all (measured: an unlimited fakesink returns to exactly D and
# sits there, which is why the fault needed 16 h of field time to be seen).
GLASS_US = 19_000               # 19 ms/frame ⇒ ~52 fps ceiling against 50 fps
# Test-scale policy. The SHIPPED numbers (250 / 5000 / 60000) are pinned by
# backlog_shed_test.py and by the TS constants in backlogShed.ts; what this
# suite has to fit into a few seconds is the hold and the cooldown, so only
# those are compressed. The tolerance — the thing being decided — is the real
# one.
HOLD_MS = 800
COOLDOWN_MS = 2_500
# Re-anchor arms (E/F), same compression: the real 40 ms tolerance, a short hold
# and retry. The test plays the ENGINE: a raise request is applied to ts-offset.
REANCHOR = {"onLateness": "reanchor", "reanchorToleranceMs": 40, "reanchorHoldMs": HOLD_MS,
            "reanchorRetryMs": 1_500, "rebaseHoldMs": 3_000, "rebaseCooldownMs": 60_000}


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def run(sync, shed, glass_us=0, engine=None, stalls=STALLS, stall_ms=STALL_MS, settle_s=GAP_S):
    """One arm. Returns (samples, shed_events, sink_dropped, extra).

    `samples` are (t_s, lateness_ms) at the SINK pad — positive means the buffer
    reached the sink past its scheduled playout slot, i.e. retained latency over
    the budget (the LIVE one: a re-anchor arm's raises move it).

    `engine` (arms E/F) = {"cap_ms": None | ms}: every raise request is applied
    to `ts-offset` up to the cap; past it the request is refused.
    """
    pipe = Gst.parse_launch(
        "appsrc name=src is-live=true format=time do-timestamp=false "
        'caps="video/x-raw,format=GRAY8,width=64,height=64,framerate=50/1" ! '
        # The video leg's ES queue, verbatim in shape: leaky, 1 s of time.
        f"queue name=q leaky=2 max-size-time={QUEUE_MS * 1000000} "
        "max-size-buffers=0 max-size-bytes=0 ! "
        # Stall injector — stands in for a decode hiccup / compositor stall.
        "identity name=stall sleep-time=0 ! "
        # The shed point: the video leg names its DECODER here.
        "identity name=vdec ! "
        # The glass: what the presentation chain can actually drain at. 0 = a
        # chain with unlimited spare rate (arms A/B, where the mechanism is
        # isolated); GLASS_US = a real one (arms C/D).
        f"identity name=glass sleep-time={glass_us} ! "
        # `max-lateness=-1` (the audio leg's real setting) so the SINK's own
        # late-drop path cannot drain the backlog either — dropping a late
        # buffer lets a fakesink pull the next one immediately, which would
        # again hide retention behind a mechanism the field does not have.
        f"fakesink name=sink sync={'true' if sync else 'false'} "
        f"ts-offset={BUDGET_MS * 1000000} max-lateness=-1 qos=true async=false")

    # The contract's clock, exactly as the runner applies it.
    runner._apply_contract_clock(pipe)
    clock = pipe.get_pipeline_clock()

    events = []
    extra = {"raises": [], "refused": 0, "overruns": 0}
    if shed:
        assert runner._start_backlog_shedder(pipe, {
            "element": "vdec", "sink": "sink", "keyframeAligned": True,
            "toleranceMs": 250, "holdMs": HOLD_MS, "cooldownMs": COOLDOWN_MS,
            "sanityMs": 10_000, **(REANCHOR if engine is not None else {})})
    else:
        runner._start_backlog_shedder(pipe, None)
    runner.pipeline = pipe

    src = pipe.get_by_name("src")
    stall = pipe.get_by_name("stall")
    sink = pipe.get_by_name("sink")
    # A leaky queue signals `overrun` before it leaks: 0 means nothing was lost there.
    pipe.get_by_name("q").connect(
        "overrun", lambda _q: extra.__setitem__("overruns", extra["overruns"] + 1))
    # Buffers into vs out of the shed point: the shedder's own drops, which the
    # sink's `dropped` counter (downstream of it) can never see.
    flow = {"in": 0, "out": 0}

    def _count(key):
        def _probe(_pad, _info):
            flow[key] += 1
            return Gst.PadProbeReturn.OK
        return _probe

    stall.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, _count("in"))
    pipe.get_by_name("vdec").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, _count("out"))

    samples = []
    state = {"t0": None, "stop": False, "budget_ns": BUDGET_MS * 1000000, "raise_ms": 0}

    def on_event(ch, payload):
        events.append((ch, payload))
        if engine is None or ch != "playout_reanchor" or payload.get("kind") != "raise":
            return
        cap = engine.get("cap_ms")
        if cap is not None and state["raise_ms"] >= cap:
            extra["refused"] += 1
            return
        raised = state["raise_ms"] + 20 * math.ceil((payload["excessMs"] + 40) / 20)
        state["raise_ms"] = raised if cap is None else min(cap, raised)
        extra["raises"].append(state["raise_ms"])
        state["budget_ns"] = (BUDGET_MS + state["raise_ms"]) * 1000000
        sink.set_property("ts-offset", state["budget_ns"])

    runner.emit_plugin_event = on_event

    def on_sink_buffer(_pad, info):
        buf = info.get_buffer()
        if buf is None or buf.pts == Gst.CLOCK_TIME_NONE:
            return Gst.PadProbeReturn.OK
        # base_time is 0 under the contract, so the clock IS running time.
        late = clock.get_time() - (buf.pts + state["budget_ns"])
        samples.append(((buf.pts - state["t0"]) / Gst.SECOND, late / 1e6))
        return Gst.PadProbeReturn.OK

    sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_sink_buffer)

    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(Gst.CLOCK_TIME_NONE)
    state["t0"] = clock.get_time()

    def push():
        blob = b"\x80" * (64 * 64)
        n = 0
        while not state["stop"]:
            # A live producer: one frame per frame period, stamped with house
            # time — the contract's producer-stamped bus PTS.
            buf = Gst.Buffer.new_wrapped(blob)
            buf.pts = clock.get_time()
            buf.duration = Gst.SECOND // FPS
            if n % GOP:
                buf.set_flags(Gst.BufferFlags.DELTA_UNIT)
            src.emit("push-buffer", buf)
            n += 1
            time.sleep(1.0 / FPS)

    def stall_cycle():
        for _ in range(stalls):
            time.sleep(GAP_S)
            if state["stop"]:
                return
            # Every buffer takes `stall_ms` extra for one stall's worth of
            # buffers, so ~stall_ms of data backs up behind the sink.
            stall.set_property("sleep-time", stall_ms * 1000)
            time.sleep(stall_ms / 1000.0)
            stall.set_property("sleep-time", 0)
        time.sleep(settle_s)         # settle: the recovery has to be observable
        state["stop"] = True

    threading.Thread(target=push, daemon=True).start()
    threading.Thread(target=stall_cycle, daemon=True).start()

    loop = GLib.MainLoop()
    GLib.timeout_add(200, lambda: loop.quit() if state["stop"] else True)
    loop.run()
    state["stop"] = True
    time.sleep(0.3)
    try:
        stats = sink.get_property("stats")
        dropped = stats.get_value("dropped")
    except Exception:  # noqa: BLE001
        dropped = 0
    runner._stop_backlog_shedder()
    pipe.set_state(Gst.State.NULL)
    runner.pipeline = None
    extra["reanchor"] = [p for ch, p in events if ch == "playout_reanchor"]
    extra["shed_point_drops"] = flow["in"] - flow["out"]
    return samples, [p for ch, p in events if ch == "backlog_shed"], dropped, extra


def floor_of(samples, lo_s, hi_s):
    """The per-window MINIMUM lateness — the latency FLOOR.

    Lateness spikes during a stall and relaxes; what matters is the level it
    relaxes back TO, because that is retained buffering the pipeline will never
    give back on its own. A floor that climbs IS the ratchet.
    """
    win = [v for t, v in samples if lo_s <= t < hi_s]
    return min(win) if win else None


def span(samples):
    return samples[-1][0] if samples else 0.0


# --- arm A: the legacy leg keeps its whole budget ----------------------------
samples, events, dropped, _ = run(sync=False, shed=False)
check("legacy arm produced a usable trace", len(samples) > 200)
a_start, a_end = floor_of(samples, 0, 2.0), floor_of(samples, span(samples) - 2.0,
                                                     span(samples) + 1)
print(f"    A legacy   floor {a_start:+.0f} → {a_end:+.0f} ms, {len(events)} shed events")
check("legacy (sync=false) never accumulates retained latency",
      a_end is not None and a_end - a_start < 100)
check("a legacy leg keeps its whole playout budget in hand", a_end < -0.5 * BUDGET_MS)
check("nothing is shed on a leg that has no shedder", events == [])

# --- arm B: the one-way property, on the same chain --------------------------
samples, events, dropped, _ = run(sync=True, shed=False)
check("paced arm produced a usable trace", len(samples) > 200)
b_start, b_end = floor_of(samples, 0, 2.0), floor_of(samples, span(samples) - 2.0,
                                                     span(samples) + 1)
print(f"    B paced    floor {b_start:+.0f} → {b_end:+.0f} ms, {len(events)} shed events")
check("a clock-paced sink hands its playout budget over, one stall at a time",
      b_end - b_start > 0.8 * BUDGET_MS)
check("and never takes it back — the leg ends with none of D in hand",
      b_end is not None and b_end > -0.2 * BUDGET_MS)
check("the SAME chain gave the legacy sink its budget back and this one not",
      b_end - a_end > 0.7 * BUDGET_MS)

# --- arm C: the ratchet, unfixed, on a real presentation chain ---------------
samples, events, dropped, _ = run(sync=True, shed=False, glass_us=GLASS_US)
check("unfixed contract arm produced a usable trace", len(samples) > 200)
c_start, c_end = floor_of(samples, 0, 2.0), floor_of(samples, span(samples) - 2.0,
                                                     span(samples) + 1)
print(f"    C unfixed  floor {c_start:+.0f} → {c_end:+.0f} ms, {len(events)} shed events, "
      f"{dropped} sink drops")
check("with no spare rate the backlog is never given back — the floor climbs",
      c_end - c_start > 400)
check("and it climbs past the shed threshold and stays there", c_end > 250)
check("nothing else drained it — the sink never dropped a buffer", dropped == 0)

# --- arm D: the shedder returns the leg to D ---------------------------------
samples, events, dropped, _ = run(sync=True, shed=True, glass_us=GLASS_US)
check("fixed contract arm produced a usable trace", len(samples) > 200)
d_start, d_end = floor_of(samples, 0, 2.0), floor_of(samples, span(samples) - 2.0,
                                                     span(samples) + 1)
print(f"    D fixed    floor {d_start:+.0f} → {d_end:+.0f} ms, {len(events)} shed events")
check("the shedder fired", len(events) >= 1)
check("and is BOUNDED — one episode per cooldown, not a drop storm",
      len(events) <= 1 + int((span(samples) * 1000) // COOLDOWN_MS))
check("every episode ended by recovering, not by giving up",
      all(e.get("outcome") == "recovered" for e in events))
check("retained latency is back inside the playout budget",
      d_end is not None and d_end <= 50)
# The comparison that matters is against the SAME chain unfixed (arm C), not
# against the arm's own start: a shed lands the leg at or just inside D, which
# may be tighter than it began.
check("the same leg that ratcheted unfixed ends back inside its budget",
      d_end <= 0 and c_end - d_end > 500)
# The episodes' own numbers have to agree with the independent trace: each one
# claims to have taken the leg from over-budget back to at-or-under budget.
check("every episode reports a real reduction",
      all(e["retainedBeforeMs"] > e["retainedAfterMs"] for e in events))
check("every episode reports ending at or inside the budget",
      all(e["retainedAfterMs"] <= BUDGET_MS + 50 for e in events))
# "Within seconds": from the first sample over threshold to back inside budget.
over = [t for t, v in samples if v > 250]
if over:
    back = [t for t, v in samples if t > over[0] and v <= 0]
    check("recovery lands within seconds of the excess appearing",
          bool(back) and back[0] - over[0] < 5.0)
else:
    check("recovery lands within seconds of the excess appearing", False)

# --- arm E: re-anchor mode — the same chain raised, never shed ---------------
samples, events, dropped, extra = run(sync=True, shed=True, glass_us=GLASS_US,
                                      engine={"cap_ms": None})
check("re-anchor arm produced a usable trace", len(samples) > 200)
e_end = floor_of(samples, span(samples) - 2.0, span(samples) + 1)
print(f"    E reanchor floor → {e_end:+.0f} ms vs the raised D, raises {extra['raises']}, "
      f"{len(events)} shed events, {dropped} sink drops, {extra['overruns']} queue overruns")
check("the leg asked for a raise, and asked again after a second stall",
      len(extra["raises"]) >= 2 and extra["raises"] == sorted(extra["raises"]))
check("every request is a raise request, cause and level attached",
      all(p.get("kind") == "raise" and p.get("excessMs", 0) > 40 and p.get("cause") in ("backlog", "timeline")
          for p in extra["reanchor"]))
check("the floor is back inside the (raised) budget by raising alone",
      e_end is not None and e_end <= 50)
check("ZERO drops: no shed episode, none at the shed point, no sink drop, no queue leak",
      events == [] and extra["shed_point_drops"] == 0 and dropped == 0 and extra["overruns"] == 0)
check("and the latency it now holds is what the stalls cost, not more",
      0 < extra["raises"][-1] <= STALLS * (STALL_MS + 100) if extra["raises"] else False)

# --- arm F: the ceiling — raises refused past +200 ms, nothing shed ----------
# One long stall that +200 ms cannot cover. At the ceiling the engine stops
# raising and warns; the leg never sheds (ADR-0005 2026-10-08).
samples, events, dropped, extra = run(sync=True, shed=True, glass_us=GLASS_US,
                                      engine={"cap_ms": 200}, stalls=1, stall_ms=700,
                                      settle_s=4.0)
f_end = floor_of(samples, span(samples) - 1.0, span(samples) + 1)
print(f"    F ceiling  floor → {f_end:+.0f} ms, raises {extra['raises']}, refused "
      f"{extra['refused']}, {len(events)} shed events")
check("the raise stops at the +200 ms cap and a later request is refused",
      extra["raises"] == [200] and extra["refused"] >= 1)
check("ZERO drops at the ceiling: no shed episode, none at the shed point, no sink drop",
      events == [] and extra["shed_point_drops"] == 0 and dropped == 0)
check("the leg stays over the capped budget (nothing gave it back)",
      f_end is not None and f_end > 50)

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst latency ratchet tests passed.")
