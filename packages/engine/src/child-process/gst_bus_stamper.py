#!/usr/bin/env python3
"""Bus egress stamper for the gst runner (time-sync contract) — the PRODUCER
stamps the timeline.

ADR-0005 decision 2: a producer maps its source's PES timeline onto the house
clock once and stamps its bus buffer PTS with the result, so every consumer
inherits identical timing BY CONSTRUCTION instead of re-deriving it from its
own arrival (the per-consumer anchor behind every recurring lipsync incident).
This is the stamping half; the runner's `_apply_contract_clock` is the clock
half, and the two only work together: with base_time=0 and an identity segment,
buffer PTS IS running-time IS house-clock time, which is exactly what
unixfdsink puts on the wire (it transmits running_time + base_time, translated
to MONOTONIC).

THE MATHS IS NOT HERE. `ts_timeline.TimelineStamper` (plugins/mpegts-core/py)
is the one python definition of the contract's arithmetic — anchor, per-PID
unwrap, discontinuity watch, re-anchor, monotone staircase — shared with the
`unixfd-fanout.py` sidecar and ported to `mrts::TimelineStamper` for the native
ones. What lives in this subsystem is only the GStreamer parts around it, split
three ways because they change for unrelated reasons:

  `gst_stamp_probe`   — the python probe: where the stamp lands on a pad, and
                        the segment mapping it has to survive.
  `gst_stamp_native`  — the preferred backend: loading the `mrtsstamp` plugin
                        and splicing one in front of each `busout_*` tee.
  `gst_stamp_events`  — what the engine is told, in ONE builder per event so
                        the two backends are indistinguishable downstream.

THIS file is the lifecycle the runner drives: the contract flag, which egresses
are armed, on which backend, and the periodic drift report. It owns all the
mutable state, so a caller (and a test) has one place to read or pin it.

Stampers arm LAZILY — on a tee's first consumer edge, disarmed on its last
(`arm` / `release`, driven from the runner's bus_attach and teardown paths). A
tee with no edges has nothing to stamp for, and paying a per-buffer TS scan for
it was 83% of the contract's measured CPU cost. That also removes the old
tree-walk for `busout_`-prefixed elements: the tee to arm is the one
`bus_attach` names (busHelpers.busTeeName), the same string the fan-out branch
is addressed by, so the two can no longer drift apart.

TWO BACKENDS, one contract. The native `mrtsstamp` element is preferred and the
python probe stays as the reference implementation AND the fallback for a box
where the plugin is missing. What forced that split is measurement, not taste —
see `gst_stamp_native`.
"""
import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib  # noqa: E402

import gst_stamp_events as events              # noqa: E402
import gst_stamp_native as native              # noqa: E402
import gst_stamp_probe as probe                # noqa: E402

# Re-exported so the runner and the suites keep addressing ONE module (the
# subsystem's public surface is this file, whatever it is split into inside).
from gst_stamp_events import (                 # noqa: E402,F401
    ELEMENT_PREFIX, anchor_event, drift_event, handle_message, reanchor_event,
    segment_warning_event, set_emitter)
from gst_stamp_native import insert_elements, so_paths   # noqa: E402,F401
from gst_stamp_probe import _segment_warn                # noqa: E402,F401

enabled = False         # the start payload's `timeSyncContract` flag
pipeline = None         # pipeline the armed probes belong to
armed = []              # armed stampers — one per tee that HAS consumers
elements = native.elements   # tee name -> inserted `mrtsstamp` element
native_loaded = None    # None = not tried, True/False = load outcome
drift_timer_id = None   # GLib source id of the periodic drift report

# How often each armed egress reports its drift loop. 30 s is a compromise:
# the loop's own estimator window is 32 s, so anything faster reports the same
# number twice, and a burn-in chart wants points at a cadence a drift of
# 1-4 s/day actually moves at.
DRIFT_REPORT_MS = 30_000


def emit(obj):
    events.emit(obj)


def _log(tee, line):
    events.log_line(tee, line)


def load_native():
    """Load the native stamper plugin ONCE per process; the outcome is cached
    here, which is also what a test pins by assigning `native_loaded`."""
    global native_loaded
    if native_loaded is None:
        native_loaded = native.load_plugin()
    return native_loaded


# ---------------------------------------------------------------------------
# Drift reporting — one periodic event per armed egress
# ---------------------------------------------------------------------------
def drift_stats_of(st):
    """One armed egress's drift state, from whichever backend it runs.

    None while the loop is still filling its first estimator window — there is
    nothing to report yet and an event saying `0 ppm` would read as `measured,
    no drift` rather than `not measured`.
    """
    el = st.get("element")
    d = native.drift_stats(el) if el is not None else probe.drift_stats(st)
    if d is None or d["samples"] < d["window"]:
        return None
    return d


def report_drift():
    """Emit one `timeline_drift` event per armed egress that has a loop
    running. Called from the periodic timer, and directly by the tests (which
    have no main loop to run it)."""
    for st in list(armed):
        d = drift_stats_of(st)
        if d is None:
            continue
        emit(events.drift_event(st["tee"], d))
        events.drift_log(st["tee"], d)
    return True     # GLib: stay armed


def _start_drift_timer():
    global drift_timer_id
    if drift_timer_id is None:
        drift_timer_id = GLib.timeout_add(DRIFT_REPORT_MS, report_drift)


def _stop_drift_timer():
    global drift_timer_id
    if drift_timer_id is not None:
        try:
            GLib.source_remove(drift_timer_id)
        except (ValueError, TypeError):     # already fired away / no main loop
            pass
        drift_timer_id = None


# ---------------------------------------------------------------------------
# Arm / disarm — driven by the runner's consumer-edge bookkeeping
# ---------------------------------------------------------------------------
def _disarm(st):
    """Stop stamping for one egress — `active=False` on the native element, or
    the probe removed. Both drop the whole latch state, which is the same
    contract either way (see `release`)."""
    el = st.get("element")
    if el is not None:
        native.deactivate(el)
        return
    probe.remove(st)


def clear():
    """Disarm every stamper and forget the flag (pipeline stop / re-start)."""
    global armed, enabled, pipeline
    _stop_drift_timer()
    for st in armed:
        _disarm(st)
    armed = []
    enabled = False
    pipeline = None
    # The elements belong to the pipeline being torn down / replaced; they go
    # with it. The LOADED plugin is process-global and stays loaded.
    elements.clear()


def enable(pipe, on):
    """Record the contract flag. Stampers arm LAZILY, per tee, on that tee's
    FIRST consumer edge (`arm`, from the runner's bus_attach path).

    `on` is the start payload's `timeSyncContract` flag. Off → nothing is
    imported, no probe is ever installed and the dataflow is byte-identical;
    this function's whole cost is one falsy test.

    Arming eagerly here — one probe per `busout_*` tee at start, as the first
    cut did — made every producer pay a per-buffer TS scan for consumers it may
    not have: measured on .42 (2026-08-12) an idle-but-flowing rist-input whose
    egress tee had NO edges attached burned 2492 ticks/min, 83% of the whole
    contract's CPU cost, stamping buffers that went nowhere. A tee with no
    consumer has nothing to stamp FOR, so the probe follows the edges.

    The flag itself must still be recorded before PLAYING: an attach can land
    the moment the pipeline starts, and an unstamped leading buffer would sail
    onto the wire carrying an arrival time.

    The native `mrtsstamp` elements ARE spliced in here, before PLAYING, because
    splicing is a graph change and the graph is only safely mutable while the
    pipeline is still in NULL. Inactive they are basetransform passthrough that
    only counts bytes (`bytes-total`, one atomic add per buffer — the runner's
    throughput source for the tee), so lazy arming is unaffected: what arms
    per consumer edge is the `active` property, not the element's existence.
    """
    global enabled, pipeline
    clear()
    enabled = bool(on)
    pipeline = pipe if enabled else None
    if enabled and load_native():
        insert_elements(pipe)


def stamper_for(tee_name):
    for st in armed:
        if st["tee"] == tee_name:
            return st
    return None


def arm(tee, name):
    """Arm the egress stamper on one `busout_*` tee. Idempotent, and a no-op
    unless the contract flag is on.

    Native element where one was spliced in (`insert_elements`), python probe
    otherwise — same arm point, same semantics, same events.
    """
    if not enabled or tee is None:
        return None
    if stamper_for(name) is not None:
        return None

    el = elements.get(name)
    if el is not None:
        native.activate(el, name)
        st = {"tee": name, "element": el, "pad": None, "probe_id": None}
    else:
        st = probe.install(tee, name, pipeline)
        if st is None:
            return None
        sys.stderr.write("[gst-runner.py] busStamp: producer-stamped timeline "
                         f"armed on {name} (first consumer edge)\n")
        sys.stderr.flush()
    armed.append(st)
    _start_drift_timer()
    return st


def release(tee_name):
    """Disarm `tee_name`'s stamper — the runner calls this once that tee's LAST
    consumer edge is gone.

    The whole latch state goes with the probe: a tee that gets a consumer again
    later re-anchors from that moment, which is the established re-anchor
    semantics (an anchor is only ever meaningful to the consumers that were
    there when it was taken).
    """
    st = stamper_for(tee_name)
    if st is None:
        return
    _disarm(st)
    armed.remove(st)
    if not armed:
        _stop_drift_timer()
    el = st.get("element")
    extra = native.copy_count_note(el) if el is not None else ""
    _log(tee_name, f"last consumer edge detached — stamper disarmed{extra}")
