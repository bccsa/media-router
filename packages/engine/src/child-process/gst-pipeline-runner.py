#!/usr/bin/env python3
"""
GStreamer Pipeline Runner for Media Router v2.

Replaces gst-launch-1.0 with a programmatic Python runner that provides:
- Live element property changes (set_property/get_property)
- Element stats extraction (get_stats)
- Structured VU data from level elements (no regex parsing)
- Structured state/error reporting via JSON

IPC Protocol:
  Commands: line-delimited JSON on stdin (bus-messages mode) or fd 3 (data-pipe mode)
  Events:   line-delimited JSON on stderr, prefixed with "GST_JSON:"
  Data:     stdin/stdout carry MPEG-TS binary in data-pipe mode

Usage:
  python3 gst-pipeline-runner.py
  Then send: {"cmd":"start","pipeline":"...","useStdioForData":false}
"""

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

import json
import math
import os
import signal
import sys
import threading

# Generic pre-`Gst.init` prgname hook. If a plugin's `PipelineDescription.env`
# carried `MR_GLIB_PRGNAME`, apply it now — the env is locked in at fork time
# so this runs before any GStreamer/GLib bookkeeping touches the prgname.
# Plugins decide what to do with this. Today the video-player plugin uses it
# to pin the Wayland surface app_id (waylandsink derives the surface app_id
# from GLib's program name; kiosk-shell uses per-output `app-ids=` whitelists
# in weston.ini to route fullscreen surfaces to a specific DRM connector).
# The engine intentionally does not know about app_ids or wayland — it's a
# generic "set prgname if asked" contract.
_prgname = os.environ.get('MR_GLIB_PRGNAME')
if _prgname:
    GLib.set_prgname(_prgname)

Gst.init(None)

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
pipeline = None
loop = None
cmd_fd = None       # File object for reading commands
event_fd = None     # File object for writing events
use_stdio_for_data = False
running = False

# VU throttle: only send when changed, heartbeat every 1s
last_vu = None
last_vu_time = 0
VU_HEARTBEAT_MS = 1000

# Throughput tracking per element (pad probes)
throughput_trackers = {}  # element_name → { bytes: int, last_bytes: int, last_time: float, bps: float }
throughput_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Event emission (JSON on stderr or fd 4, prefixed with GST_JSON:)
# ---------------------------------------------------------------------------
event_lock = threading.Lock()

def emit_event(obj):
    """Write a JSON event line to the event output."""
    with event_lock:
        try:
            line = "GST_JSON:" + json.dumps(obj) + "\n"
            if event_fd:
                event_fd.write(line)
                event_fd.flush()
            else:
                sys.stderr.write(line)
                sys.stderr.flush()
        except (BrokenPipeError, OSError):
            pass

# ---------------------------------------------------------------------------
# GstStructure → dict converter
# ---------------------------------------------------------------------------
def _safe_value(value):
    """Convert a GStreamer value to a JSON-safe Python type."""
    if value is None:
        return None
    if isinstance(value, Gst.Structure):
        return gst_structure_to_dict(value)
    if isinstance(value, (int, float, bool, str)):
        return value
    if hasattr(value, '__len__') and not isinstance(value, (str, bytes)):
        # GValueArray or list-like
        return [_safe_value(v) for v in value]
    # Fallback: convert unknown GObject types to string
    return str(value)

def gst_structure_to_dict(structure):
    """Recursively convert a GstStructure to a JSON-safe Python dict."""
    if structure is None:
        return {}
    result = {}
    for i in range(structure.n_fields()):
        name = structure.nth_field_name(i)
        try:
            value = structure.get_value(name)
            result[name] = _safe_value(value)
        except Exception:
            result[name] = "?"
    return result

# ---------------------------------------------------------------------------
# VU data extraction from level element
# ---------------------------------------------------------------------------
def db_to_blocks(db):
    """Convert dB value to 0-15 block scale (same formula as v1)."""
    clamped = max(-60.0, min(0.0, db))
    return round(0.25 * (60.0 + clamped))

def handle_level_message(structure):
    """Extract VU data from a GStreamer level element message."""
    global last_vu, last_vu_time

    # get_value() returns a plain Python list of floats
    try:
        decay_vals = structure.get_value('decay')
    except Exception:
        try:
            decay_vals = structure.get_value('peak')
        except Exception:
            return

    if not decay_vals or not isinstance(decay_vals, (list, tuple)):
        return

    peak_blocks = [db_to_blocks(v) if isinstance(v, (int, float)) else 0 for v in decay_vals]

    # Throttle: only send on change or heartbeat
    now_ms = GLib.get_monotonic_time() // 1000
    if peak_blocks == last_vu and (now_ms - last_vu_time) < VU_HEARTBEAT_MS:
        return

    last_vu = peak_blocks
    last_vu_time = now_ms
    emit_event({"event": "vu_data", "peak": peak_blocks})

# ---------------------------------------------------------------------------
# Bus message handler
# ---------------------------------------------------------------------------
def on_bus_message(bus, message):
    """Handle GStreamer bus messages."""
    t = message.type

    if t == Gst.MessageType.ERROR:
        err, debug = message.parse_error()
        emit_event({"event": "error", "message": str(err.message), "debug": debug or ""})
        # Stop the pipeline on error
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        if loop and loop.is_running():
            loop.quit()

    elif t == Gst.MessageType.EOS:
        emit_event({"event": "eos"})
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        if loop and loop.is_running():
            loop.quit()

    elif t == Gst.MessageType.STATE_CHANGED:
        if message.src == pipeline:
            old, new, pending = message.parse_state_changed()
            state_name = new.value_nick  # 'playing', 'paused', 'ready', 'null'
            emit_event({"event": "state_change", "state": state_name})

    elif t == Gst.MessageType.ELEMENT:
        structure = message.get_structure()
        name = structure.get_name() if structure else None
        if name == "level":
            handle_level_message(structure)
        elif name == "GstUDPSrcTimeout":
            # udpsrc has not received data within its configured timeout.
            # Surface this as an error so the gst-runner's restart path
            # triggers — udpsrc itself does not stop the pipeline on
            # timeout, it just posts the message.
            emit_event(
                {
                    "event": "error",
                    "message": "UDP source timeout (no data received)",
                }
            )
            if pipeline:
                pipeline.set_state(Gst.State.NULL)
            if loop and loop.is_running():
                loop.quit()

    return True

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Dynamic pad linking (tsdemux → branches with sometimes-pads)
# ---------------------------------------------------------------------------
# Per-rule counter of how many pads we've already linked, so `maxPads` works.
_pad_link_counts = {}

def _pad_caps_media(pad):
    """Return 'video' / 'audio' / None for a pad based on its current caps."""
    caps = pad.get_current_caps() or pad.query_caps(None)
    if not caps or caps.get_size() == 0:
        return None
    name = caps.get_structure(0).get_name() or ''
    if name.startswith('video/'):
        return 'video'
    if name.startswith('audio/'):
        return 'audio'
    return None

# Caps-name → parser element used between `tsdemux` and a downstream `mpegtsmux`.
# `mpegtsmux` rejects unparsed sink caps for AAC / AC-3 / MPEG-audio (no
# `codec_data`, framed=false) and surfaces upstream as `udpsrc` emitting
# "Internal data stream error". A per-pad parser is the load-bearing fix.
#
# `audio/mpeg` covers both AAC (mpegversion=2|4) and MPEG-1/2 audio (mpegversion=1).
# `_parser_for_caps` checks `mpegversion` to pick between aacparse and mpegaudioparse.
_PARSER_FOR_CAPS_NAME = {
    'video/x-h264': 'h264parse config-interval=1',
    'video/x-h265': 'h265parse config-interval=1',
    'video/x-av1':  'av1parse',
    'audio/x-ac3':  'ac3parse',
    'audio/x-eac3': 'ac3parse',
    'audio/mpeg':   None,  # disambiguated by mpegversion below
    'audio/x-opus': None,  # tsdemux already emits muxer-ready caps
}
# One-shot warning suppression so unknown-codec messages don't spam the log
# at the runner's pad-rate.
_unknown_codec_warned = set()

def _parser_for_caps(caps):
    """Pick the parser element to prepend to a dynamic branch for a pad's caps.

    Returns the parser element string (e.g. 'aacparse'), '' when the caps are
    a recognised codec that needs no parser (Opus), or None when the codec is
    not in our table — caller falls back to passthrough.
    """
    if not caps or caps.get_size() == 0:
        return None
    s = caps.get_structure(0)
    name = s.get_name() or ''
    if name == 'audio/mpeg':
        ok, mpegversion = s.get_int('mpegversion')
        if ok and mpegversion in (2, 4):
            return 'aacparse'
        if ok and mpegversion == 1:
            return 'mpegaudioparse'
        return None
    if name in _PARSER_FOR_CAPS_NAME:
        parser = _PARSER_FOR_CAPS_NAME[name]
        return parser if parser is not None else ''
    return None

def _install_pad_link_rule(pipe, rule):
    """
    Install one `linkOnPadAdded` rule.

    rule = {
      "from": "<element name>",         # listen for pad-added on this element
      "media": "video"|"audio",         # filter — only link pads of this media type
      "branches": ["<parse_launch fragment>", ...],  # one branch per matched pad,
                                                       in pad-added order
      "linkTo": "<element name>",       # optional — request a sink pad on this
                                        # outer-pipeline element and link the bin's
                                        # src ghost pad to it. Used to bridge bins
                                        # to an outer named muxer.
    }

    The Nth pad of the matching media type is connected to `branches[N]`.
    Branches beyond the supplied list are ignored — caller controls fan-out
    by choosing the list length.
    """
    src = pipe.get_by_name(rule.get("from", ""))
    if not src:
        emit_event({"event": "error",
                    "message": f"linkOnPadAdded: source element not found: {rule.get('from')}"})
        return

    branches = rule.get("branches") or []
    if not branches:
        return

    rule_id = f"{rule.get('from')}::{rule.get('media')}"
    _pad_link_counts[rule_id] = 0
    media_filter = rule.get("media")
    link_to_name = rule.get("linkTo")

    def on_pad_added(_element, pad):
        if media_filter and _pad_caps_media(pad) != media_filter:
            return
        index = _pad_link_counts[rule_id]
        if index >= len(branches):
            return
        _pad_link_counts[rule_id] = index + 1
        branch_str = branches[index]
        # Auto-prepend the right codec parser based on the pad's actual caps.
        # Centralising parser selection here means JS-side branches stay
        # codec-agnostic (`queue ! mpegtsmux ! udpsink`) and the same demuxer
        # can serve mixed-codec streams (e.g. one AAC pad + one Opus pad)
        # without per-pad config.
        caps = pad.get_current_caps() or pad.query_caps(None)
        parser = _parser_for_caps(caps)
        if parser is None:
            caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else 'unknown'
            warn_key = f"{rule_id}::{caps_name}"
            if warn_key not in _unknown_codec_warned:
                _unknown_codec_warned.add(warn_key)
                emit_event({"event": "warning",
                            "message": f"linkOnPadAdded: no parser registered for caps '{caps_name}' on rule {rule_id} — linking passthrough; mpegtsmux may refuse if codec needs framing"})
        elif parser != '':
            branch_str = f"{parser} ! {branch_str}"
        try:
            bin_ = Gst.parse_bin_from_description(branch_str, True)
            bin_.set_name(f"branch_{rule_id.replace('::','_')}_{index}")
            # Order matters: add → link (both ends) → sync state. Linking before
            # the bin moves to PLAYING avoids a race where the demuxer pad
            # produces buffers with no downstream sink yet.
            pipe.add(bin_)
            sink_pad = bin_.get_static_pad("sink")
            if not sink_pad:
                emit_event({"event": "error",
                            "message": f"linkOnPadAdded: branch has no sink pad ({rule_id})"})
                return
            link_ret = pad.link(sink_pad)
            if link_ret != Gst.PadLinkReturn.OK:
                emit_event({"event": "error",
                            "message": f"linkOnPadAdded: pad link failed ({link_ret}) for rule {rule_id}"})
                return
            # Optional: link the bin's src ghost pad to a request pad on an outer element
            if link_to_name:
                target = pipe.get_by_name(link_to_name)
                if not target:
                    emit_event({"event": "error",
                                "message": f"linkOnPadAdded: linkTo target not found: {link_to_name}"})
                    return
                src_pad = bin_.get_static_pad("src")
                if not src_pad:
                    emit_event({"event": "error",
                                "message": f"linkOnPadAdded: branch has no src pad to link to {link_to_name} ({rule_id})"})
                    return
                # Request a fresh sink pad on the target (works for muxers / aggregators)
                req_pad = target.request_pad_simple("sink_%d")
                if not req_pad:
                    emit_event({"event": "error",
                                "message": f"linkOnPadAdded: could not request sink pad on {link_to_name} ({rule_id})"})
                    return
                outer_link = src_pad.link(req_pad)
                if outer_link != Gst.PadLinkReturn.OK:
                    emit_event({"event": "error",
                                "message": f"linkOnPadAdded: could not link branch src to {link_to_name} ({outer_link}) ({rule_id})"})
                    return
            bin_.sync_state_with_parent()
            emit_event({"event": "pad_linked",
                        "rule": rule_id,
                        "index": index,
                        "padName": pad.get_name()})
        except GLib.Error as e:
            emit_event({"event": "error",
                        "message": f"linkOnPadAdded: branch parse failed: {e.message}"})

    src.connect("pad-added", on_pad_added)


def handle_start(data):
    """Start a GStreamer pipeline from a pipeline string."""
    global pipeline, loop, running, use_stdio_for_data, _pad_link_counts

    pipeline_str = data.get("pipeline", "")
    use_stdio_for_data = data.get("useStdioForData", False)
    pad_link_rules = data.get("linkOnPadAdded", []) or []

    if not pipeline_str:
        emit_event({"event": "error", "message": "No pipeline string provided"})
        return

    try:
        pipeline = Gst.parse_launch(pipeline_str)
    except GLib.Error as e:
        emit_event({"event": "error", "message": f"Pipeline parse error: {e.message}"})
        return

    # Reset per-run pad counters and install dynamic-pad-link rules
    _pad_link_counts = {}
    for rule in pad_link_rules:
        _install_pad_link_rule(pipeline, rule)

    # Set up bus watch
    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_bus_message)

    # Start playing
    ret = pipeline.set_state(Gst.State.PLAYING)
    if ret == Gst.StateChangeReturn.FAILURE:
        emit_event({"event": "error", "message": "Failed to set pipeline to PLAYING"})
        pipeline.set_state(Gst.State.NULL)
        return

    running = True
    emit_event({"event": "started"})

def handle_stop(data=None):
    """Stop the pipeline."""
    global pipeline, running
    if pipeline:
        pipeline.set_state(Gst.State.NULL)
        running = False
        emit_event({"event": "state_change", "state": "null"})
    if loop and loop.is_running():
        loop.quit()

def handle_set_property(data):
    """Set a property on a named element."""
    if not pipeline:
        emit_event({"event": "error", "message": "No pipeline running"})
        return

    element_name = data.get("element", "")
    prop = data.get("property", "")
    value = data.get("value")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_event({"event": "error", "message": f"Element not found: {element_name}"})
        return

    try:
        # GStreamer needs the value in the correct type
        # Try to get the current property to determine its type
        current = element.get_property(prop)
        if isinstance(current, float):
            value = float(value)
        elif isinstance(current, int):
            value = int(value)
        elif isinstance(current, bool):
            value = bool(value)

        element.set_property(prop, value)
        emit_event({"event": "property_set", "element": element_name, "property": prop, "value": value})
    except Exception as e:
        emit_event({"event": "error", "message": f"set_property failed: {e}"})

def handle_get_property(data):
    """Get a property from a named element."""
    if not pipeline:
        emit_event({"event": "error", "message": "No pipeline running"})
        return

    element_name = data.get("element", "")
    prop = data.get("property", "")
    req_id = data.get("id")  # For request/response correlation

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_event({"event": "error", "message": f"Element not found: {element_name}"})
        return

    try:
        value = element.get_property(prop)
        # Convert GStreamer types to JSON-safe
        if isinstance(value, Gst.Structure):
            value = gst_structure_to_dict(value)
        result = {"event": "property", "element": element_name, "property": prop, "value": value}
        if req_id:
            result["id"] = req_id
        emit_event(result)
    except Exception as e:
        emit_event({"event": "error", "message": f"get_property failed: {e}"})

def handle_get_stats(data):
    """Read the 'stats' property from a named element (e.g. srtsrc, srtserversrc)."""
    if not pipeline:
        emit_event({"event": "error", "message": "No pipeline running"})
        return

    element_name = data.get("element", "")
    req_id = data.get("id")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_event({"event": "error", "message": f"Element not found: {element_name}"})
        return

    try:
        stats = element.get_property("stats")
        stats_dict = gst_structure_to_dict(stats) if isinstance(stats, Gst.Structure) else {}
        result = {"event": "stats", "element": element_name, "data": stats_dict}
        if req_id:
            result["id"] = req_id
        emit_event(result)
    except Exception as e:
        emit_event({"event": "error", "message": f"get_stats failed: {e}"})

def _pad_probe_cb(pad, info, element_name):
    """Pad probe callback — counts bytes flowing through."""
    buf = info.get_buffer()
    if buf:
        with throughput_lock:
            tracker = throughput_trackers.get(element_name)
            if tracker:
                tracker['bytes'] += buf.get_size()
    return Gst.PadProbeReturn.OK

def handle_track_throughput(data):
    """Start tracking throughput on a named element's src pad."""
    if not pipeline:
        emit_event({"event": "error", "message": "No pipeline running"})
        return

    element_name = data.get("element", "")
    pad_name = data.get("pad", "src")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_event({"event": "error", "message": f"Element not found: {element_name}"})
        return

    pad = element.get_static_pad(pad_name)
    if not pad:
        emit_event({"event": "error", "message": f"Pad not found: {element_name}.{pad_name}"})
        return

    with throughput_lock:
        if element_name not in throughput_trackers:
            import time
            throughput_trackers[element_name] = {
                'bytes': 0, 'last_bytes': 0,
                'last_time': time.monotonic(), 'bps': 0,
            }
            pad.add_probe(Gst.PadProbeType.BUFFER, _pad_probe_cb, element_name)
            emit_event({"event": "tracking", "element": element_name, "pad": pad_name})

def handle_get_throughput(data):
    """Get current throughput stats for tracked elements."""
    import time
    req_id = data.get("id")
    result = {}

    with throughput_lock:
        now = time.monotonic()
        for name, tracker in throughput_trackers.items():
            elapsed = now - tracker['last_time']
            if elapsed > 0:
                delta_bytes = tracker['bytes'] - tracker['last_bytes']
                tracker['bps'] = (delta_bytes * 8) / elapsed  # bits per second
                tracker['last_bytes'] = tracker['bytes']
                tracker['last_time'] = now
            result[name] = {
                'total_bytes': tracker['bytes'],
                'bitrate_kbps': round(tracker['bps'] / 1000, 1),
                'bitrate_mbps': round(tracker['bps'] / 1_000_000, 3),
            }

    evt = {"event": "throughput", "data": result}
    if req_id:
        evt["id"] = req_id
    emit_event(evt)

# Command dispatch
CMD_HANDLERS = {
    "start": handle_start,
    "stop": handle_stop,
    "set_property": handle_set_property,
    "get_property": handle_get_property,
    "get_stats": handle_get_stats,
    "track_throughput": handle_track_throughput,
    "get_throughput": handle_get_throughput,
}

def dispatch_command(line):
    """Parse and dispatch a JSON command."""
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        emit_event({"event": "error", "message": f"Invalid JSON command: {line}"})
        return

    cmd = data.get("cmd", "")
    handler = CMD_HANDLERS.get(cmd)
    if handler:
        # Run handler on GLib main context for thread safety
        GLib.idle_add(lambda: (handler(data), False)[1])
    else:
        emit_event({"event": "error", "message": f"Unknown command: {cmd}"})

# ---------------------------------------------------------------------------
# Command reader thread
# ---------------------------------------------------------------------------
def command_reader_thread():
    """Read JSON commands from cmd_fd (stdin or fd 3) in a background thread."""
    try:
        for line in cmd_fd:
            line = line.strip()
            if line:
                dispatch_command(line)
    except (EOFError, OSError, ValueError):
        pass
    finally:
        # Input closed — shut down
        if loop and loop.is_running():
            GLib.idle_add(handle_stop)

# ---------------------------------------------------------------------------
# Signal handling
# ---------------------------------------------------------------------------
def on_signal(signum, frame):
    """Handle SIGTERM/SIGINT."""
    if loop and loop.is_running():
        GLib.idle_add(handle_stop)

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global loop, cmd_fd, event_fd

    # Determine IPC file descriptors
    # If fd 3 exists, use it for commands (data-pipe mode: stdin/stdout = binary data)
    # Otherwise, use stdin for commands (bus-messages mode)
    try:
        cmd_fd = os.fdopen(3, 'r')
        event_fd = os.fdopen(4, 'w')
    except OSError:
        # No fd 3/4 — use stdin for commands, stderr for events
        cmd_fd = sys.stdin
        event_fd = None  # Will use sys.stderr

    emit_event({"event": "ready"})

    # Start command reader in background thread
    reader = threading.Thread(target=command_reader_thread, daemon=True)
    reader.start()

    # Run GLib main loop (processes bus messages, idle callbacks)
    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        # Print why we're exiting so the parent log isn't a silent "code=0".
        sys.stderr.write(f"[gst-runner.py] Main loop exited (pipeline={'set' if pipeline else 'unset'})\n")
        sys.stderr.flush()
        if pipeline:
            pipeline.set_state(Gst.State.NULL)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        sys.stderr.write(f"[gst-runner.py] Fatal: {e}\n")
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        sys.exit(1)
