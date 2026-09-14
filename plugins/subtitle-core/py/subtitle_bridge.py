#!/usr/bin/env python3
"""Subtitle bridge — the runner-side half of the subtitle-core cue carrier.

Lives in the plugin (plugins/subtitle-core/py) and is loaded by the gst
pipeline runner through the generic `PipelineDescription.runnerHooks` seam:
`{ module: "subtitle_bridge", config: { pay?: [...], overlay?: {...} } }`.
The runner knows nothing about subtitles — it imports the module by name
(every plugins/*/py dir is on its PYTHONPATH), calls `install(pipeline,
config, ctx)` before PLAYING and `clear()` on stop. `ctx` carries the two
things the plugin cannot own: `emit_event(dict)` (engine events) and
`emit_plugin_event(channel, payload)` (module status channel).

Producer side (`pay`, one entry per subtitle stream): an `appsink`
in the pipeline delivers cue TEXT (one buffer per cue — a teletext page from
`teletextdec`, empty = clear). The bridge stamps the cue with the house time
it arrived at (running-time ≡ house time on a contract pipeline, ADR-0005),
wraps it as a KLV-wrapped WebVTT cue (`subtitle_klv`, plugins/subtitle-core/py)
and pushes it into the stream's `appsrc` (`meta/x-klv,parsed=true` → mpegtsmux
→ bus). A cue is re-sent every RESEND_MS while it is live so a consumer that
attaches mid-cue still shows it; `holdMs` bounds a cue whose source never
sends a clear.

Consumer side (`overlay`): the bridge links every `meta/x-klv` pad the
named tsdemux exposes to a `queue ! appsink` cue reader (anything else to a
fakesink, so a mis-wired A/V stream cannot stall the demux), keeps the latest
cue, and drives the `text` property of the named `textoverlay` from a BUFFER
probe on its video sink pad: the text is set on the first frame whose PTS
reaches the cue's start and cleared on the first frame past its end. The
textoverlay TEXT PAD is deliberately not used — its buffer-window semantics
(no-duration buffers flash for one frame, a pending buffer blocks the pad)
were the whole problem in the 2026-09-09 spike; a property set from the video
path is frame-accurate against the stamped timeline and never blocks anything.

Frame time: a frame's PTS is house time when its branch is stamp-aligned
(video-player: `alignBranchesToStamps`). Where it is not (a decoded frame
still on a source timeline), the PTS is nowhere near house time; `frame_time`
then falls back to house-now, i.e. the cue shows when it arrives — the same
behaviour as before alignment, never a stuck or invisible cue.

Pure helpers (`clean_text`, `make_cue`, `frame_time`, `decide`) carry the
logic and are unit-tested without GStreamer (`subtitle_bridge_test.py`);
the GStreamer plumbing around them is thin.
"""

RESEND_MS = 2000
FRAME_TIME_TOLERANCE_MS = 10_000
CUE_EVENT_CHANNEL = "subtitle:cue"

_emit_event = None          # callable(dict) — engine events (warnings)
_emit_plugin_event = None   # callable(channel, payload) — module status
_state = None               # {"pay": [entries], "overlay": dict|None, "timer": id|None}


def configure(emit_event, emit_plugin_event):
    global _emit_event, _emit_plugin_event
    _emit_event, _emit_plugin_event = emit_event, emit_plugin_event


def install(pipe, config, ctx=None):
    """Runner hook entry point: `config = {"pay": [...], "overlay": {...}}`."""
    if ctx:
        configure(ctx.get("emit_event"), ctx.get("emit_plugin_event"))
    config = config or {}
    _install(pipe, config.get("pay"), config.get("overlay"))


def _warn(message):
    if _emit_event:
        _emit_event({"event": "warning", "message": f"subtitle bridge: {message}"})


# --- pure logic -------------------------------------------------------------

def clean_text(data):
    """Cue text bytes → str: drop NULs (teletextdec appends one), CRs, and
    trailing blank lines; an all-blank page is a CLEAR."""
    text = bytes(data).replace(b"\x00", b"").decode("utf-8", "replace")
    lines = [ln.rstrip() for ln in text.replace("\r", "").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return "\n".join(lines)


def make_cue(now_ms, text, hold_ms):
    """(start, end, text): a live cue runs from now for hold_ms; a clear is a
    zero-length cue at now."""
    start = int(round(now_ms))
    if not text:
        return (start, start, "")
    return (start, start + max(0, int(hold_ms)), text)


def frame_time(pts_ms, now_ms):
    """House time to judge a frame by: its PTS when stamp-aligned, else now."""
    if pts_ms is None or now_ms is None:
        return now_ms
    return pts_ms if abs(pts_ms - now_ms) <= FRAME_TIME_TOLERANCE_MS else now_ms


def decide(cue, shown, t_ms):
    """What the overlay should do for a frame at house time t_ms.
    Returns ("show", text), ("clear", None) or None (no change).
    `shown` is the text currently set on the overlay (None when blank)."""
    if cue is None or t_ms is None:
        return ("clear", None) if shown else None
    start, end, text = cue
    if t_ms < start:
        return None
    if t_ms >= end or not text:
        return ("clear", None) if shown else None
    return ("show", text) if shown != text else None


# --- GStreamer plumbing -----------------------------------------------------

def _gst():
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
    return GLib, Gst


def house_now_ms(pipe):
    clock = pipe.get_clock()
    if clock is None:
        return None
    return (clock.get_time() - pipe.get_base_time()) / 1e6


def _install(pipe, pay_specs, overlay_cfg):
    """Called once per pipeline start, before PLAYING."""
    global _state
    clear()
    if not pay_specs and not overlay_cfg:
        return
    _state = {"pay": [], "overlay": None, "timer": None}
    for spec in pay_specs or []:
        _install_pay(pipe, spec)
    if overlay_cfg:
        _install_overlay(pipe, overlay_cfg)
    if _state["pay"]:
        GLib, _ = _gst()
        _state["timer"] = GLib.timeout_add(RESEND_MS, _resend_tick)


def clear():
    global _state
    if _state is None:
        return
    if _state.get("timer") is not None:
        GLib, _ = _gst()
        GLib.source_remove(_state["timer"])
    _state = None


def state():
    return _state


def _install_pay(pipe, spec):
    _, Gst = _gst()
    sink = pipe.get_by_name(spec.get("appsink", ""))
    src = pipe.get_by_name(spec.get("appsrc", ""))
    if sink is None or src is None:
        _warn(f"pay elements missing ({spec.get('appsink')}/{spec.get('appsrc')})")
        return
    entry = {
        "pipe": pipe, "src": src, "hold_ms": int(spec.get("holdMs", 8000)),
        "label": spec.get("label") or spec.get("appsrc"), "current": None, "count": 0,
    }
    sink.set_property("emit-signals", True)
    sink.set_property("sync", False)
    sink.set_property("max-buffers", 8)
    sink.set_property("drop", True)
    sink.connect("new-sample", _on_text_sample, entry)
    _state["pay"].append(entry)


def _on_text_sample(sink, entry):
    _, Gst = _gst()
    smp = sink.emit("pull-sample")
    if not smp:
        return Gst.FlowReturn.OK
    buf = smp.get_buffer()
    try:
        text = clean_text(buf.extract_dup(0, buf.get_size()))
        now = house_now_ms(entry["pipe"])
        if now is None:
            return Gst.FlowReturn.OK
        cue = make_cue(now, text, entry["hold_ms"])
        _push_cue(entry, cue, now)
        entry["current"] = cue if text else None
        entry["count"] += 1
        if _emit_plugin_event:
            _emit_plugin_event(CUE_EVENT_CHANNEL, {
                "label": entry["label"], "text": text, "startMs": cue[0], "count": entry["count"],
            })
    except Exception as exc:  # noqa: BLE001 — a bad cue must never take the pipeline down
        _warn(f"cue dropped ({exc})")
    return Gst.FlowReturn.OK


def _push_cue(entry, cue, now_ms):
    import subtitle_klv  # plugins/subtitle-core/py — on the runner's PYTHONPATH
    _, Gst = _gst()
    payload = subtitle_klv.encode_cue(*cue)
    buf = Gst.Buffer.new_wrapped(payload)
    buf.pts = int(now_ms * 1e6)
    buf.dts = buf.pts
    buf.duration = Gst.CLOCK_TIME_NONE
    entry["src"].emit("push-buffer", buf)


def _resend_tick():
    if _state is None:
        return False
    for entry in _state["pay"]:
        cue = entry["current"]
        if cue is None:
            continue
        now = house_now_ms(entry["pipe"])
        if now is None:
            continue
        if now >= cue[1]:
            entry["current"] = None
            continue
        try:
            _push_cue(entry, cue, now)
        except Exception as exc:  # noqa: BLE001
            _warn(f"cue re-send failed ({exc})")
    return True


def _install_overlay(pipe, cfg):
    _, Gst = _gst()
    demux = pipe.get_by_name(cfg.get("demux", ""))
    ov = pipe.get_by_name(cfg.get("overlay", ""))
    if demux is None or ov is None:
        _warn(f"overlay elements missing ({cfg.get('demux')}/{cfg.get('overlay')})")
        return
    st = {"pipe": pipe, "ov": ov, "cue": None, "shown": None, "count": 0}
    _state["overlay"] = st
    demux.connect("pad-added", _on_demux_pad, st)
    vpad = ov.get_static_pad("video_sink")
    if vpad is not None:
        vpad.add_probe(Gst.PadProbeType.BUFFER, _on_video_frame, st)


def _on_demux_pad(demux, pad, st):
    _, Gst = _gst()
    pipe = st["pipe"]
    caps = pad.get_current_caps() or pad.query_caps(None)
    name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ""
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
        else:
            # Not ours (someone wired an A/V TS into the subtitle input): keep
            # the demux flowing rather than letting an unlinked pad kill it.
            fs = Gst.ElementFactory.make("fakesink", None)
            fs.set_property("sync", False)
            fs.set_property("async", False)
            pipe.add(fs)
            fs.sync_state_with_parent()
            pad.link(fs.get_static_pad("sink"))
            _warn(f"ignoring non-subtitle stream {name or '?'} on the subtitle input")
    except Exception as exc:  # noqa: BLE001
        _warn(f"could not link subtitle pad ({exc})")


def _on_cue_sample(sink, st):
    import subtitle_klv
    _, Gst = _gst()
    smp = sink.emit("pull-sample")
    if not smp:
        return Gst.FlowReturn.OK
    buf = smp.get_buffer()
    cue = subtitle_klv.decode_cue(buf.extract_dup(0, buf.get_size()))
    if cue is not None:
        st["cue"] = cue
        st["count"] += 1
    return Gst.FlowReturn.OK


def _on_video_frame(pad, info, st):
    _, Gst = _gst()
    buf = info.get_buffer()
    if buf is None:
        return Gst.PadProbeReturn.OK
    now = house_now_ms(st["pipe"])
    pts_ms = buf.pts / 1e6 if buf.pts != Gst.CLOCK_TIME_NONE else None
    action = decide(st["cue"], st["shown"], frame_time(pts_ms, now))
    if action is None:
        return Gst.PadProbeReturn.OK
    kind, text = action
    if kind == "show":
        st["ov"].set_property("text", text)
        st["shown"] = text
    else:
        st["ov"].set_property("text", "")
        st["shown"] = None
        if st["cue"] is not None and (not st["cue"][2] or frame_time(pts_ms, now) >= st["cue"][1]):
            st["cue"] = None
    return Gst.PadProbeReturn.OK
