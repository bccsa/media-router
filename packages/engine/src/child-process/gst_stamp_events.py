#!/usr/bin/env python3
"""What the bus egress stamper reports: the identity log line (once per arm, the first timing
PES) and the warning for a segment the stamp cannot be mapped through, the twin of
mr-gst-runner's `stamper::handle_message`. The emitter is indirected (`set_emitter`) so this
module never imports the runner back.
"""
import sys

# Element name = this prefix + the tee name, so a bus message's source name
# alone identifies the egress it belongs to (no second registry to drift).
ELEMENT_PREFIX = "mrstamp_"

# The runner installs its own `emit_event` here (`set_emitter`).
_emit = None


def set_emitter(fn):
    """Register the engine-event sink (the runner's `emit_event`)."""
    global _emit
    _emit = fn


def emit(obj):
    if _emit is not None:
        _emit(obj)


def log_line(tee, line):
    """One line on the runner's stderr, tagged with the egress it came from."""
    sys.stderr.write(f"[gst-runner.py] busStamp {tee}: {line}\n")
    sys.stderr.flush()


def segment_warning_event(tee, why):
    """The `warning` engine event for a segment the stamp cannot be mapped through. Not
    `event: error`, which would restart a producer whose data is fine."""
    return {"event": "warning",
            "message": (f"egress {tee}: {why} — the house-clock stamp cannot be "
                        f"mapped onto running time, so consumers may see shifted "
                        f"timing (time-sync contract, ADR-0005)")}


def is_stamper_message(name):
    """True for the element's bus message names (`mrtsstamp-*`)."""
    return bool(name) and name.startswith("mrtsstamp-")


def handle_message(src_name, kind, structure):
    """One `mrtsstamp` bus message (runner `on_bus_message`, ELEMENT)."""
    if not src_name or not src_name.startswith(ELEMENT_PREFIX) or structure is None:
        return
    tee = src_name[len(ELEMENT_PREFIX):]
    if kind == "mrtsstamp-identity":
        log_line(tee, f"identity egress: first PES pid=0x{structure.get_value('pid'):x} "
                      f"stamp={structure.get_value('stamp')} pts={structure.get_value('pts')}")
        return
    if kind in ("mrtsstamp-segment-warning", "mrtsstamp-map-failed"):
        why = structure.get_value("why")
        emit(segment_warning_event(tee, why))
        log_line(tee, f"{why} — " + ("buffer passed through with source timing"
                                     if kind == "mrtsstamp-map-failed" else "stamp written unmapped"))
