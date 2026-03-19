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
def gst_structure_to_dict(structure):
    """Recursively convert a GstStructure to a Python dict."""
    if structure is None:
        return {}
    result = {}
    for i in range(structure.n_fields()):
        name = structure.nth_field_name(i)
        value = structure.get_value(name)
        if isinstance(value, Gst.Structure):
            result[name] = gst_structure_to_dict(value)
        elif hasattr(value, '__len__') and not isinstance(value, str):
            # GValueArray or list-like
            result[name] = [v for v in value]
        else:
            result[name] = value
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
        if structure and structure.get_name() == "level":
            handle_level_message(structure)

    return True

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
def handle_start(data):
    """Start a GStreamer pipeline from a pipeline string."""
    global pipeline, loop, running, use_stdio_for_data

    pipeline_str = data.get("pipeline", "")
    use_stdio_for_data = data.get("useStdioForData", False)

    if not pipeline_str:
        emit_event({"event": "error", "message": "No pipeline string provided"})
        return

    try:
        pipeline = Gst.parse_launch(pipeline_str)
    except GLib.Error as e:
        emit_event({"event": "error", "message": f"Pipeline parse error: {e.message}"})
        return

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
        if pipeline:
            pipeline.set_state(Gst.State.NULL)

if __name__ == "__main__":
    main()
