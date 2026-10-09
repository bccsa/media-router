"""Consumer half of the subtitle bridge (`overlay`): KLV cues off the named
tsdemux, each anchored on the house stamp of the bus chunk it arrived in,
queued by start (`subtitle_cues.OverlayCues`) and drawn by setting the named
textoverlay's `text` from a probe on its video pad — never its text pad.
ADR-0016 amendment 2026-10-09; docs/research/subtitle-content-time-20261009.md.
"""
import subtitle_klv
import subtitle_runtime as rt
import subtitle_ts
from subtitle_cues import OverlayCues, absolute_cue, cue_t0, frame_time


def klv_key(payload):
    """Join key between a chunk's KLV PES and the demuxed KLV buffer."""
    return subtitle_ts.payload_key(subtitle_ts.klv_span(payload))


def install_overlay(pipe, cfg):
    """→ the overlay state, or None when its elements are missing."""
    _, Gst = rt.gst()
    demux = pipe.get_by_name(cfg.get("demux", ""))
    ov = pipe.get_by_name(cfg.get("overlay", ""))
    if demux is None or ov is None:
        rt.warn(f"overlay elements missing ({cfg.get('demux')}/{cfg.get('overlay')})")
        return None
    st = {"pipe": pipe, "ov": ov, "cues": OverlayCues(), "index": subtitle_ts.StampIndex(),
          "readers": {}}
    sink = demux.get_static_pad("sink")
    if sink is not None:
        sink.add_probe(Gst.PadProbeType.BUFFER,
                       rt.chunk_probe(pipe, subtitle_ts.PesStamper(), st["index"], klv_key))
    demux.connect("pad-added", _on_demux_pad, st)
    demux.connect("pad-removed", _on_demux_pad_removed, st)
    vpad = ov.get_static_pad("video_sink")
    if vpad is not None:
        vpad.add_probe(Gst.PadProbeType.BUFFER, _on_video_frame, st)
    return st


def _on_demux_pad(demux, pad, st):
    _, Gst = rt.gst()
    pipe = st["pipe"]
    caps = pad.get_current_caps() or pad.query_caps(None)
    name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ""
    _on_demux_pad_removed(demux, pad, st)      # a re-added pad name: retire the old reader
    try:
        if name == "meta/x-klv":
            q = Gst.ElementFactory.make("queue", None)
            sink = Gst.ElementFactory.make("appsink", None)
            sink.set_property("emit-signals", True)
            sink.set_property("sync", False)
            sink.set_property("max-buffers", 8)
            sink.set_property("drop", True)
            sink.connect("new-sample", _on_cue_sample, st)
            pipe.add(q)
            pipe.add(sink)
            q.sync_state_with_parent()
            sink.sync_state_with_parent()
            q.link(sink)
            pad.link(q.get_static_pad("sink"))
            st["readers"][pad.get_name()] = [q, sink]
        else:
            # Not ours (an A/V TS wired into the subtitle input): keep the demux
            # flowing rather than letting an unlinked pad kill it.
            fs = Gst.ElementFactory.make("fakesink", None)
            fs.set_property("sync", False)
            fs.set_property("async", False)
            pipe.add(fs)
            fs.sync_state_with_parent()
            pad.link(fs.get_static_pad("sink"))
            st["readers"][pad.get_name()] = [fs]
            rt.warn(f"ignoring non-subtitle stream {name or '?'} on the subtitle input")
    except Exception as exc:  # noqa: BLE001
        rt.warn(f"could not link subtitle pad ({exc})")


def _on_demux_pad_removed(_demux, pad, st):
    """Retire that pad's reader (tsdemux re-adds pads on a PMT change), off
    the streaming thread: set to NULL and removed from the pipeline."""
    elements = st["readers"].pop(pad.get_name(), None)
    if not elements:
        return
    GLib, Gst = rt.gst()

    def retire():
        for el in elements:
            el.set_state(Gst.State.NULL)
            st["pipe"].remove(el)
        return False
    GLib.idle_add(retire)


def _on_cue_sample(sink, st):
    _, Gst = rt.gst()
    smp = sink.emit("pull-sample")
    if not smp:
        return Gst.FlowReturn.OK
    buf = smp.get_buffer()
    data = rt.map_bytes(buf)
    rel = subtitle_klv.decode_cue(data)
    if rel is None:
        return Gst.FlowReturn.OK
    now = rt.house_now_ms(st["pipe"])
    key = klv_key(data)
    pts = rt.pts_ms(buf, Gst)
    t0, source = cue_t0(st["index"].lookup(key, now), pts, now)
    if t0 is not None:
        st["cues"].add(absolute_cue(rel, t0)._replace(key=key, src=source), now)
    return Gst.FlowReturn.OK


def show_line(text, cue, t_ms, now_ms):
    """The `show` trace: cueLate = frame − cue start, cueLag = now − cue start,
    frameLag = now − frame."""
    lags = "" if now_ms is None else f" cueLag={now_ms - cue.start:.0f} frameLag={now_ms - t_ms:.0f}"
    return (f"show {text.replace(chr(10), ' / ')[:60]!r} cueLate={t_ms - cue.start:.0f}"
            f"{lags} t0src={cue.src}")


def _on_video_frame(pad, info, st):
    _, Gst = rt.gst()
    buf = info.get_buffer()
    if buf is None:
        return Gst.PadProbeReturn.OK
    now = rt.house_now_ms(st["pipe"])
    t = frame_time(rt.pts_ms(buf, Gst), now)
    result = st["cues"].frame(t)            # decided under the cue lock
    if result is None:
        return Gst.PadProbeReturn.OK
    kind, text, cue = result
    if kind == "show":
        st["ov"].set_property("text", text)
        rt.trace(show_line(text, cue, t, now))
    else:
        st["ov"].set_property("text", "")
        due = (cue.end if cue.text else cue.start) if cue is not None else None
        late = f" cueLate={t - due:.0f}" if due is not None and t is not None else ""
        lag = f" frameLag={now - t:.0f}" if t is not None and now is not None else ""
        rt.trace(f"clear{late}{lag} t0src={cue.src if cue else None}")
    return Gst.PadProbeReturn.OK
