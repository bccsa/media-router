#!/usr/bin/env python3
"""Bus egress stamper for the gst runner, the twin of mr-gst-runner's stamper.cpp: every
`busout_*` egress gets an `mrtsstamp` that stamps its buffers by identity, PES − 1 h (plan
ch. 6 WI-P2-3, ADR-0029). With base_time 0 that stamp is what unixfdsink puts on the wire as
house time; under a natural base (`liveCaptureClock`) the element maps it back through it.

Split three ways, because they change for unrelated reasons:

  `gst_stamp_native`  — loading the `mrtsstamp` plugin and splicing one in front of each
                        `busout_*` tee.
  `gst_stamp_events`  — what the element's bus messages become (the identity log line, the
                        segment warning).
  this file           — the lifecycle the runner drives: enable at start, which egresses are
                        armed. It owns all the mutable state, so a caller (and a test) has one
                        place to read or pin it.

Stampers arm LAZILY — on a tee's first consumer edge, disarmed on its last
(`arm` / `release`, driven from the runner's bus_attach and teardown paths). A
tee with no edges has nothing to stamp for, and paying a per-buffer TS scan for
it was 83% of the contract's measured CPU cost. The tee to arm is the one
`bus_attach` names (busHelpers.busTeeName), the same string the fan-out branch
is addressed by, so the two can no longer drift apart.

ONE backend. A box without the plugin runs its egress unstamped and the module carries the
rule-6 alarm (plan ch. 3 part 4.5): there is no python probe to fall back to.
"""
import gst_native_plugins
import gst_stamp_events as events
import gst_stamp_native as native

# Re-exported so the runner and the suites keep addressing ONE module (the
# subsystem's public surface is this file, whatever it is split into inside).
from gst_stamp_events import (  # noqa: F401
    ELEMENT_PREFIX, handle_message, is_stamper_message, segment_warning_event, set_emitter)
from gst_stamp_native import insert_elements, so_paths  # noqa: F401

enabled = False         # set by `enable` at pipeline start, cleared on stop
pipeline = None         # pipeline the armed elements belong to
armed = []              # tee names armed — one per tee that HAS consumers
skip = set()            # armed tees whose next egress window is dropped (B-26)
elements = native.elements   # tee name -> inserted `mrtsstamp` element
native_loaded = None    # None = not tried, True/False = load outcome

# Bus-egress lateness taps are `lat_<tee>`, `lat_busout_<port>` (busHelpers.latOutName).
EGRESS_TAP_PREFIX = "lat_busout_"


def emit(obj):
    events.emit(obj)


def _log(tee, line):
    events.log_line(tee, line)


def load_native():
    """Load the stamper plugin ONCE per process (a test re-tries by assigning `native_loaded`).
    A miss is rule 6: the alarm (`warning`, kind `timing_plugin`), no fallback."""
    global native_loaded
    if native_loaded is None:
        detail = native.load_plugin()
        native_loaded = detail is None
        if detail is not None:
            emit(gst_native_plugins.alarm("warning", detail))
    return native_loaded


def missing():
    """The plugin was tried and could not be loaded: a start reporting `timingPlugin` must not
    clear the alarm then."""
    return native_loaded is False


def clear():
    """Disarm every stamper and forget the pipeline (stop / re-start)."""
    global armed, enabled, pipeline, skip
    for name in armed:
        el = elements.get(name)
        if el is not None:
            native.deactivate(el)
    armed = []
    skip = set()
    enabled = False
    pipeline = None
    # The elements belong to the pipeline being torn down / replaced; they go
    # with it. The LOADED plugin is process-global and stays loaded.
    elements.clear()


def enable(pipe):
    """Enable stamping for `pipe` (every pipeline): when it has a `busout_*` tee, load the
    plugin and splice an inactive element at the head of each egress. Before PLAYING, because
    an attach can land the moment the pipeline starts, and splicing is a graph change that is
    only safe in NULL. Arming stays lazy: `arm` sets `active` on a tee's first consumer edge."""
    global enabled, pipeline
    clear()
    enabled = True
    pipeline = pipe
    tees = native.busout_tees(pipe)
    # No bus egress, nothing to stamp: the plugin is neither loaded nor missed.
    if tees and load_native():
        insert_elements(pipe, tees)


def arm(tee, name):
    """Arm the egress stamper on one `busout_*` tee. Idempotent, and a no-op before `enable`
    or where nothing was spliced (the plugin missing, or the splice failed)."""
    if not enabled or tee is None or name in armed:
        return None
    el = elements.get(name)
    if el is None:
        return None
    native.activate(el, name)
    armed.append(name)
    skip.add(name)
    return el


def release(tee_name):
    """Disarm `tee_name`'s stamper — the runner calls this once that tee's LAST consumer edge
    is gone. The element forgets the stream: a tee that gets a consumer again stamps afresh."""
    if tee_name not in armed:
        return
    el = elements.get(tee_name)
    if el is not None:
        native.deactivate(el)
    armed.remove(tee_name)
    skip.discard(tee_name)
    extra = native.copy_count_note(el) if el is not None else ""
    _log(tee_name, f"last consumer edge detached — stamper disarmed{extra}")


def take_egress_window(tap):
    """Whether egress tap `tap`'s `mrlateness` window goes to the engine: only while its tee is
    armed, since an unarmed egress carries the mux's own PTS, and not the first window after each
    arm, which holds samples from before it (B-26)."""
    tee = tap[len("lat_"):]
    if tee not in armed:
        return False
    if tee in skip:
        skip.discard(tee)
        return False
    return True
