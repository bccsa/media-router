#!/usr/bin/env python3
"""Input stall watch (`PipelineDescription.inputStallWatch`) — the `watchdog`
element's contract without its per-buffer cost.

What it replaces: `buildBusSrc({stallTimeoutMs})` splices a GStreamer
`watchdog` element after the unixfdsrc. That element destroys and re-creates
a GLib timeout source on EVERY buffer, on its own thread (~900 wakeups/s and
~2 % of a core per video input at 1316-byte bus chunks — 10.9.16.108,
2026-09-02, the one measurement every other comment on this topic points at).

Same question, asked once a second: a ONE-SHOT buffer probe on the source's
src pad flips a progress flag (the single-writer protocol of the runner's
`_arm_bus_progress_probe` — the callback never writes `probe_id`), a shared
tick re-arms it, and once `timeoutMs` has passed with no progress the pipeline
fails exactly as the element's bus ERROR did: `kind: "bus_stall"`, `element`
carrying the `buswd_` prefix the runner's ERROR path tags by, then the runner's
errored teardown + loop quit → the parent's restartOnError. Armed on the first
PLAYING transition, as the element was (it fed itself on PAUSED→PLAYING).

UNLIKE the element, an input that has NEVER delivered a buffer does not trip
it. Only a source that flowed and then went dark is a stall worth a restart;
one that never delivered (producer up, nothing behind it — an SRT listener
with no caller, a RIST peer with no media) gains nothing from a rebuild and
would restart-loop every timeout, taking every downstream consumer with it
(10.9.16.46, 2026-09-03: two muxers on dark inputs flapped the whole graph
on/off every 5 s). Such an input is reported once as a warning and then
waited for — tsdemux links its pads whenever the data finally arrives.

The runner wires the two things this module cannot own itself through
`configure()`: how to emit an engine event, and how to fail the pipeline.
"""
import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

TICK_MS = 1000
ELEMENT_PREFIX = "buswd_"     # what the runner's ERROR path recognises

_state = None                 # {"entries": [...], "timer_id": int|None, "armed": bool}
_emit = None                  # callable(dict) — engine event out
_fail = None                  # callable() — errored teardown + loop quit
_alive = None                 # callable() -> bool — is there a pipeline to fail


def configure(emit_event, fail_pipeline, pipeline_alive):
    global _emit, _fail, _alive
    _emit, _fail, _alive = emit_event, fail_pipeline, pipeline_alive


def state():
    return _state


def start(pipe, cfg):
    """cfg = [{"element": "busin_0", "timeoutMs": 5000}, ...] — one entry per
    bus source to watch; the probe sits on its src pad, so downstream
    back-pressure cannot fake a stall (what the element saw, this sees)."""
    global _state
    stop()
    entries = []
    for item in cfg or []:
        if not isinstance(item, dict):
            continue
        name = item.get("element")
        try:
            timeout_ms = int(item.get("timeoutMs") or 0)
        except (TypeError, ValueError):
            timeout_ms = 0
        if not name or timeout_ms <= 0:
            continue
        el = pipe.get_by_name(name)
        pad = el.get_static_pad("src") if el is not None else None
        if pad is None:
            _emit({"event": "warning",
                   "message": f"inputStallWatch: element '{name}' has no src pad — not watched"})
            continue
        entries.append({"name": name, "pad": pad, "timeout_ms": timeout_ms,
                        "progressed": False, "probe_id": None, "last_us": None,
                        "seen": False, "warned": False})
    if entries:
        _state = {"entries": entries, "timer_id": None, "armed": False}


def _arm_probe(entry):
    """One-shot probe: sets the flag and removes itself. Never writes
    `probe_id` (only the tick does)."""
    if entry["probe_id"] is not None:
        return

    def _cb(_pad, _info):
        entry["progressed"] = True
        return Gst.PadProbeReturn.REMOVE

    entry["probe_id"] = entry["pad"].add_probe(
        Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, _cb)


def arm():
    """First PLAYING: start every entry's clock and the shared tick."""
    st = _state
    if not st or st["armed"]:
        return
    st["armed"] = True
    now_us = GLib.get_monotonic_time()
    for e in st["entries"]:
        e["last_us"] = now_us
        _arm_probe(e)
    st["timer_id"] = GLib.timeout_add(TICK_MS, _tick)


def _tick():
    st = _state
    if not st or not _alive():
        return False
    now_us = GLib.get_monotonic_time()
    for e in st["entries"]:
        if e["progressed"]:
            e["progressed"] = False
            e["seen"] = True
            e["last_us"] = now_us
            e["probe_id"] = None          # the one-shot fired: its id is dead
            _arm_probe(e)
        elif (now_us - e["last_us"]) // 1000 >= e["timeout_ms"]:
            name, timeout_ms = e["name"], e["timeout_ms"]
            if not e["seen"]:
                if not e["warned"]:
                    e["warned"] = True
                    _emit({"event": "warning", "kind": "input_silent", "element": name,
                           "message": f"Input {name} has delivered no data since start "
                                      f"({timeout_ms} ms) — waiting for the source, not restarting"})
                continue
            stop()
            _emit({"event": "error", "kind": "bus_stall",
                   "message": f"Input stall: no data from {name} for {timeout_ms} ms",
                   "debug": "", "element": ELEMENT_PREFIX + name})
            _fail()
            return False
    return True


def stop():
    global _state
    st = _state
    _state = None
    if not st:
        return
    if st["timer_id"] is not None:
        GLib.source_remove(st["timer_id"])
    for e in st["entries"]:
        # A one-shot that has fired (`progressed`) already removed itself; its
        # stored id is dead and removing it again is a GStreamer warning.
        if e["probe_id"] is not None and not e["progressed"]:
            e["pad"].remove_probe(e["probe_id"])
