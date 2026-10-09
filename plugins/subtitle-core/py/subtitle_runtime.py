"""Shared plumbing of the subtitle bridge's producer (`subtitle_pay`) and
consumer (`subtitle_overlay`): GStreamer access, house time, the stderr trace,
the engine emitters and the bus-chunk stamp probe. Tests replace `gst`.
"""
import sys

CUE_EVENT_CHANNEL = "subtitle:cue"

_emit_event = None          # callable(dict) — engine events (warnings)
_emit_plugin_event = None   # callable(channel, payload) — module status


def configure(emit_event, emit_plugin_event):
    global _emit_event, _emit_plugin_event
    _emit_event, _emit_plugin_event = emit_event, emit_plugin_event


def gst():
    """(GLib, Gst), imported on first use (the pure modules never need them)."""
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
    return GLib, Gst


def trace(msg):
    """One stderr line (journal `[gst-py]`): the only remote evidence of when
    a cue was made and drawn."""
    sys.stderr.write(f"[subtitle_bridge] {msg}\n")
    sys.stderr.flush()


def warn(message):
    if _emit_event:
        _emit_event({"event": "warning", "message": f"subtitle bridge: {message}"})


def emit_cue_event(payload):
    if _emit_plugin_event:
        _emit_plugin_event(CUE_EVENT_CHANNEL, payload)


def house_now_ms(pipe):
    clock = pipe.get_clock()
    if clock is None:
        return None
    return (clock.get_time() - pipe.get_base_time()) / 1e6


def pts_ms(buf, Gst):
    return buf.pts / 1e6 if buf.pts != Gst.CLOCK_TIME_NONE else None


def map_bytes(buf):
    return buf.extract_dup(0, buf.get_size())


def chunk_probe(pipe, stamper, index, key_of):
    """Demux sink BUFFER probe: record each completed PES's house time."""
    _, Gst = gst()

    def on_chunk(_pad, info):
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        try:
            done = stamper.feed(map_bytes(buf), pts_ms(buf, Gst))
            if done:
                now = house_now_ms(pipe)
                for _pid, payload, house in done:
                    index.record(key_of(payload), house, now)
        except Exception as exc:  # noqa: BLE001 — never take the input down
            warn(f"chunk stamp read failed ({exc})")
            return Gst.PadProbeReturn.REMOVE
        return Gst.PadProbeReturn.OK
    return on_chunk
