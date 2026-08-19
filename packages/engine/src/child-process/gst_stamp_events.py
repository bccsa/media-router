#!/usr/bin/env python3
"""Engine events for the bus egress stamper — ONE builder per event for BOTH
backends.

The stamper reports three moments and one condition: it anchored, it re-anchored
on a source discontinuity, it has a drift measurement to publish, and it saw a
segment its stamp cannot be mapped through. Those events reach the engine over
the runner's event fd; this module is where their SHAPE is decided.

`ev` is the payload each backend reports with. The python `TimelineStamper`
callbacks and the native `mrtsstamp` element's bus message carry the SAME field
names, so one builder serves both and nothing downstream can tell which backend
produced the stamp — two copies of these dicts would be the first place that
promise broke. `handle_message` at the bottom is the native half of that: it
translates an element bus message into the event the python probe would have
emitted for the identical moment.

Nothing here imports GStreamer or the runner: the emitter is INDIRECTED
(`set_emitter`) so this module never imports the runner back, and the bus
`structure` arrives as an argument.
"""
import sys

# Element name = this prefix + the tee name, so a bus message's source name
# alone identifies the egress it belongs to (no second registry to drift).
ELEMENT_PREFIX = "mrstamp_"

# The runner installs its own `emit_event` here (`set_emitter`). Indirected
# rather than imported so this module never imports the runner back.
_emit = None


def set_emitter(fn):
    """Register the engine-event sink (the runner's `emit_event`)."""
    global _emit
    _emit = fn


def emit(obj):
    if _emit is not None:
        _emit(obj)


def log_line(tee, line):
    """One line on the runner's stderr, tagged with the egress it came from.

    The engine events above go out on the event fd, which nothing on the box
    writes to a journal; a burn-in has to be able to read these moments back on
    the device and not only in an engine that happens to be listening.
    """
    sys.stderr.write(f"[gst-runner.py] busStamp {tee}: {line}\n")
    sys.stderr.flush()


def anchor_event(tee, ev):
    """The `timeline_restamped` engine event."""
    pid, anchor_ns, ref_pts = ev["pid"], ev["anchorNs"], ev["refPts90k"]
    return {"event": "timeline_restamped", "tee": tee, "pid": pid,
            "anchorNs": anchor_ns, "refPts90k": ref_pts,
            "message": (f"egress {tee} stamped onto the house timeline "
                        f"(anchor {anchor_ns} ns, first PES {ref_pts} "
                        f"on pid 0x{pid:x})")}


def reanchor_event(tee, ev):
    """The `timeline_reanchor` engine event (see `anchor_event`)."""
    pid, delta = ev["pid"], ev["deltaTicks"]
    return {"event": "timeline_reanchor", "tee": tee, "pid": pid,
            "anchorNs": ev["anchorNs"], "refPts90k": ev["refPts90k"],
            "count": ev["count"],
            "message": (f"source timeline discontinuity on pid 0x{pid:x}"
                        f" ({ev['lastPts90k']} -> {ev['refPts90k']}, "
                        f"{delta / 90000.0:+.2f}s) — "
                        f"re-anchored egress {tee} in place")}


def drift_event(tee, d):
    """The `timeline_drift` engine event — the drift loop's periodic report.

    `d` is the stamper's `drift_stats()` dict (python probe) or the identical
    field set read off the native element's `drift` property, so the event is
    the same whichever backend stamped. This is what a burn-in charts: `ppm` is
    the rate the servo has locked onto (the source's clock offset from ours),
    `slewNs` what applying it has cost or given the anchor this epoch, and
    `marginNs` the producer's own delivery margin, which this loop reports and
    never targets.
    """
    return {"event": "timeline_drift", "tee": tee, **d,
            "message": (f"egress {tee} drift {d['ppm']:+d} ppm, "
                        f"margin {d['marginNs'] / 1e6:+.2f} ms "
                        f"(engaged at {d['engageNs'] / 1e6:+.2f} ms), "
                        f"anchor slewed {d['slewNs'] / 1e6:+.3f} ms so far")}


def drift_log(tee, d):
    """`drift_event`'s line on the runner's log (see `log_line`)."""
    log_line(tee, f"drift {d['ppm']:+d} ppm, margin "
                  f"{d['marginNs'] / 1e6:+.2f} ms (engaged at "
                  f"{d['engageNs'] / 1e6:+.2f} ms), anchor slewed "
                  f"{d['slewNs'] / 1e6:+.3f} ms")


def segment_warning_event(tee, why):
    """The `warning` engine event for a segment the stamp cannot be mapped
    through (see `gst_stamp_probe._position_for`). ENGINE-visible, not stderr:
    this is the case that silently ships shifted timing. Not `event: error` —
    that is the pipeline-lifecycle event and would restart a producer whose data
    is fine and whose timing is merely unverifiable."""
    return {"event": "warning",
            "message": (f"egress {tee}: {why} — the house-clock stamp cannot be "
                        f"mapped onto running time, so consumers may see shifted "
                        f"timing (time-sync contract, ADR-0005)")}


def anchor_moment(tee, ev):
    """Report an anchor: engine event + runner log, in that order."""
    emit(anchor_event(tee, ev))
    log_line(tee, f"anchored: house={ev['anchorNs']} ns, "
                  f"firstPes={ev['refPts90k']} on pid 0x{ev['pid']:x}")


def reanchor_moment(tee, ev):
    """Report a re-anchor. IN PLACE, not a restart: preserveSourceTimeline has
    to restart to re-latch because its offsets are baked into pad offsets; here
    the anchor is just two numbers, so a re-anchor costs one PTS step and needs
    no cooperation from any consumer. Every branch of a producer re-anchors
    together (one anchor per egress), so A/V pairing survives — the 2026-07-19
    failure mode cannot recur."""
    emit(reanchor_event(tee, ev))
    log_line(tee, f"re-anchored on pid 0x{ev['pid']:x} "
                  f"({ev['deltaTicks'] / 90000.0:+.2f}s jump), "
                  f"anchor={ev['anchorNs']} ref={ev['refPts90k']} "
                  f"(#{ev['count']})")


def handle_message(src_name, kind, structure):
    """Turn one `mrtsstamp` bus message into the engine event the python probe
    would have emitted for the same moment (runner `on_bus_message`, ELEMENT)."""
    if not src_name or not src_name.startswith(ELEMENT_PREFIX):
        return
    tee = src_name[len(ELEMENT_PREFIX):]
    if kind == "mrtsstamp-segment-warning":
        why = structure.get_value("why")
        emit(segment_warning_event(tee, why))
        log_line(tee, f"{why} — stamp written unmapped")
        return
    ev = {"pid": structure.get_value("pid"),
          "anchorNs": structure.get_value("anchorNs"),
          "refPts90k": structure.get_value("refPts90k")}
    if kind == "mrtsstamp-anchor":
        anchor_moment(tee, ev)
        return
    ev["lastPts90k"] = structure.get_value("lastPts90k")
    ev["deltaTicks"] = structure.get_value("deltaTicks")
    ev["count"] = structure.get_value("count")
    reanchor_moment(tee, ev)
