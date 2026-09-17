"""mpegts-muxer runner hook: media-agnostic routing of demuxed pads into the
muxer (ADR-0017), owned by the plugin (ADR-0002: no domain code in the engine).

Installed through `PipelineDescription.runnerHooks` as
`{"module": "mux_routing", "config": {"inputs": [...]}}`; the engine runner
imports this module (every plugin `py/` dir is on its PYTHONPATH), calls
`install(pipeline, config, ctx)` before PLAYING and `clear()` on stop.

    config = {"inputs": [{
        "demux":  "demux_0",                 # tsdemux whose pad-added we route
        "linkTo": "mux",                     # the mpegtsmux (request pads)
        "routes": {                          # first pad of each class goes here
            "video":    {"padName": "sink_256", "branch": "queue …", "parser": "none"},
            "audio":    {"padName": "sink_257", "branch": "queue …", "padOffsetNs": -700000000},
            "klv":      {"padName": "sink_258", "branch": "queue …", "sparse": True},
            "subtitle": {"padName": "sink_259", "branch": "queue …", "sparse": True},
        },
        "ignorePids": [496],                 # never routed (an upstream name carousel)
        "pcr": {"program": 1},               # pick the PCR stream video-first at link time
    }]}

What one input does at pad-added time:
  * classify the pad by caps — video / audio / klv (`meta/x-klv`, the WebVTT
    carrier of ADR-0016) / subtitle (DVB, teletext) / data;
  * the FIRST pad of a class with a route is parsed (codec parser picked from
    the caps, mpegtsmux refuses unparsed AAC/AC-3/MPEG audio), pushed through
    the route's `branch` and linked into `linkTo`'s request pad `padName`
    (`sink_<pid>` pins the output PID);
  * everything else — a class without a route, a second pad of a routed
    class, an ignored PID — is sunk into a `fakesink` so the demuxer keeps
    flowing: tsdemux combines its pads' flow returns, a TS whose ONLY pad is
    left unlinked returns NOT_LINKED and the source restart-loops (the
    2026-09-15 .103 muxer);
  * with `pcr`, `prog-map`'s `PCR_<program>` is pointed at the first VIDEO
    pad's request pad before it is linked (first audio until a video shows
    up) — mpegtsmux reads prog-map per pad at stream creation, so the builder
    need not know which input carries video;
  * a `sparse` route (one buffer per cue, nothing between) is restamped to
    the pipeline running time on every buffer and kept fed with GAP events
    while idle, so the aggregator never holds the other pads for it
    (mpegtsmux waited latency + min-upstream-latency = 2.4 s and burst the
    video, 2026-09-16).

Events go to the engine through `ctx["emit_event"]`: `pad_linked`
(`rule`, `padName`, `media`, `pid`, `padOffsetNs`), `warning`, `error` — the
same shapes the runner's own pad-link rules emit, so GstRunner logs them the
same way. Pinned by `mux_routing_test.py` (real tsdemux → mpegtsmux run).
"""
import sys

_emit_event = None
_state = None   # {"pcr": {linkTo: {...}}, "sparse": [...], "handlers": [(element, id)], "warned": set()}

# Caps-name → parser between tsdemux and mpegtsmux. mpegtsmux rejects unparsed
# AAC / AC-3 / MPEG-audio (no codec_data, framed=false) and the failure
# surfaces upstream as "Internal data stream error". config-interval=-1 on the
# video parsers re-emits parameter sets before EVERY IDR so a frame lost on a
# lossy link recovers at the next keyframe. None = parser-free (tsdemux hands
# the stream over muxer-ready: Opus, and every PES-framed private stream).
_PARSER_FOR_CAPS_NAME = {
    "video/x-h264": "h264parse config-interval=-1",
    "video/x-h265": "h265parse config-interval=-1",
    "video/x-av1": "av1parse",
    "audio/x-ac3": "ac3parse",
    "audio/x-eac3": "ac3parse",
    "audio/mpeg": None,            # aacparse / mpegaudioparse by mpegversion
    "audio/x-opus": "",
    "meta/x-klv": "",
    "application/x-teletext": "",
    "subpicture/x-dvb": "",
}
# `parser: "none"` on a video route: declare access-unit alignment instead of
# parsing (one frame less latency; tsdemux already hands over whole AUs).
_AU_ALIGNED_CAPS = {
    "video/x-h264": "video/x-h264,stream-format=byte-stream,alignment=au",
    "video/x-h265": "video/x-h265,stream-format=byte-stream,alignment=au",
}

# Sparse routes: GAP cadence and how far ahead of the mux position the GAP is
# placed (a gap AT the position is consumed at once and the pad is empty again
# until the next tick, which paced the video in 500 ms steps — measured).
SPARSE_GAP_MS = 500
SPARSE_GAP_LEAD_MS = 2 * SPARSE_GAP_MS


def _gst():
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
    return GLib, Gst


def _emit(ev):
    if _emit_event:
        _emit_event(ev)


def _log(msg):
    sys.stderr.write(f"[mux_routing] {msg}\n")
    sys.stderr.flush()


# --- pure helpers (unit-tested without GStreamer) -----------------------------

def route_media_for_caps(caps_name):
    """Route class of a tsdemux pad from its caps structure name. TS twin:
    `muxRouteMedia` (plugins/mpegts-muxer/engine/muxPids.ts) — both pinned to
    the same table by mux_routing_test.py and muxPids.test.ts."""
    caps_name = caps_name or ""
    if caps_name.startswith("video/"):
        return "video"
    if caps_name.startswith("audio/"):
        return "audio"
    if caps_name == "meta/x-klv":
        return "klv"
    if caps_name.startswith("subpicture/") or caps_name == "application/x-teletext":
        return "subtitle"
    return "data"


def pid_from_pad_name(pad_name):
    """tsdemux names pads `<media>_<programhex>_<pidhex>`; the PID is the last
    field. None when the name does not fit."""
    if not pad_name:
        return None
    try:
        return int(pad_name.rsplit("_", 1)[-1], 16)
    except ValueError:
        return None


def parser_for_caps_name(caps_name, mpegversion=None):
    """Parser element string, '' for parser-free, None for unknown."""
    if caps_name == "audio/mpeg":
        if mpegversion in (2, 4):
            return "aacparse"
        if mpegversion == 1:
            return "mpegaudioparse"
        return None
    return _PARSER_FOR_CAPS_NAME.get(caps_name)


# --- GStreamer plumbing -------------------------------------------------------

def install(pipe, config, ctx=None):
    global _emit_event, _state
    clear()
    if ctx:
        _emit_event = ctx.get("emit_event")
    _state = {"pcr": {}, "sparse": [], "handlers": [], "warned": set()}
    for entry in (config or {}).get("inputs") or []:
        _install_input(pipe, entry)


def clear():
    global _state
    if _state is None:
        return
    GLib, _ = _gst()
    for st in _state["sparse"]:
        if st.get("timer") is not None:
            GLib.source_remove(st["timer"])
            st["timer"] = None
    for element, hid in _state["handlers"]:
        try:
            element.disconnect(hid)
        except Exception:  # noqa: BLE001
            pass
    _state = None


def state():
    return _state


def _install_input(pipe, entry):
    demux_name = entry.get("demux", "")
    src = pipe.get_by_name(demux_name)
    if src is None:
        _emit({"event": "error", "message": f"mux_routing: demuxer not found: {demux_name}"})
        return
    rule_id = f"{demux_name}::any"
    routes = entry.get("routes") or {}
    link_to = entry.get("linkTo")
    ignore = set(entry.get("ignorePids") or [])
    pcr = entry.get("pcr")
    if link_to and pcr:
        _state["pcr"].pop(link_to, None)
    linked = {}   # class → demux pad already routed on this input

    def on_pad_added(_element, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ""
        pid = pid_from_pad_name(pad.get_name())
        if pid is not None and pid in ignore:
            _sink_unrouted(pipe, pad, rule_id, f"pid 0x{pid:x} is excluded")
            return
        media = route_media_for_caps(caps_name)
        route = routes.get(media)
        if not route or not route.get("padName"):
            _sink_unrouted(pipe, pad, rule_id, f"no route for {media} ({caps_name or 'unknown caps'})")
            return
        if media in linked:
            _sink_unrouted(pipe, pad, rule_id, f"second {media} stream (already routed {linked[media]})")
            return
        linked[media] = pad.get_name()
        branch = _parser_prefix(pad, caps, rule_id, route.get("parser") or "auto") + (route.get("branch") or "queue")
        if link_to and pcr and media in ("video", "audio"):
            _pin_pcr_before_link(pipe, link_to, int(pcr.get("program", 1)), media, route["padName"], rule_id)
        _link_pad(pipe, pad, rule_id, media, branch, link_to, route["padName"],
                  route.get("padOffsetNs"), {"media": media, "pid": pid}, bool(route.get("sparse")))

    _state["handlers"].append((src, src.connect("pad-added", on_pad_added)))


def _parser_prefix(pad, caps, rule_id, mode):
    caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ""
    if mode == "none" and caps_name in _AU_ALIGNED_CAPS:
        au = _AU_ALIGNED_CAPS[caps_name]
        _emit({"event": "warning",
               "message": f"mux_routing: parser bypass on {pad.get_name()} ({rule_id}) — declaring {au}"})
        return f'capssetter caps="{au}" ! '
    mpegversion = None
    if caps_name == "audio/mpeg":
        ok, v = caps.get_structure(0).get_int("mpegversion")
        mpegversion = v if ok else None
    parser = parser_for_caps_name(caps_name, mpegversion)
    if parser is None:
        key = f"{rule_id}::{caps_name}"
        if key not in _state["warned"]:
            _state["warned"].add(key)
            _emit({"event": "warning",
                   "message": f"mux_routing: no parser registered for caps '{caps_name or 'unknown'}' on {rule_id} — "
                              f"linking passthrough; mpegtsmux may refuse if the codec needs framing"})
        return ""
    return f"{parser} ! " if parser else ""


def _sink_unrouted(pipe, pad, rule_id, why):
    _, Gst = _gst()
    key = f"{rule_id}::{why}"
    if key not in _state["warned"]:
        _state["warned"].add(key)
        _emit({"event": "warning",
               "message": f"mux_routing: {pad.get_name()} not routed on {rule_id} — {why}; sinking it"})
    try:
        fs = Gst.ElementFactory.make("fakesink", None)
        if fs is None:
            return
        fs.set_property("sync", False)
        fs.set_property("async", False)
        pipe.add(fs)
        fs.sync_state_with_parent()
        pad.link(fs.get_static_pad("sink"))
    except Exception as e:  # noqa: BLE001 — never fatal
        _emit({"event": "warning", "message": f"mux_routing: could not sink unrouted pad {pad.get_name()} ({e})"})


def _pin_pcr_before_link(pipe, target_name, program, media, pad_name, rule_id):
    """Point `prog-map` `PCR_<program>` of `target_name` at the request pad
    about to be linked, video preferred. mpegtsmux compares a STRING entry to
    each new sink pad's name at stream creation and the match becomes the
    program's PCR stream (later matches override), so writing before the link
    is enough: first audio takes PCR until the first video takes it over.
    At most two writes per pipeline."""
    _, Gst = _gst()
    st = _state["pcr"].get(target_name)
    if st is not None and (st["media"] == "video" or media != "video"):
        return
    target = pipe.get_by_name(target_name)
    if target is None or target.find_property("prog-map") is None:
        return
    try:
        cur = target.get_property("prog-map")
        struct = cur.copy() if cur is not None else Gst.Structure.new_empty("program_map")
        struct.set_value(f"PCR_{program}", pad_name)
        target.set_property("prog-map", struct)
        _state["pcr"][target_name] = {"media": media, "pad": pad_name}
        _log(f"PCR_{program} of {target_name} → {pad_name} ({media}, {rule_id})")
    except Exception as e:  # noqa: BLE001
        _emit({"event": "warning", "message": f"mux_routing: could not pin PCR on {target_name} ({e})"})


def _sparse_position(pipe, pad):
    """The mux's current position in `pad`'s stream time: the pipeline running
    time (NOT minus the aggregator latency — that budget is only how long it
    waits for a pad WITHOUT data), mapped through the pad's segment."""
    _, Gst = _gst()
    clock = pipe.get_clock()
    if clock is None:
        return None
    rt = max(0, clock.get_time() - pipe.get_base_time())
    ev = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
    if ev is not None:
        pos = ev.parse_segment().position_from_running_time(Gst.Format.TIME, rt)
        if pos is not None and pos != Gst.CLOCK_TIME_NONE:
            return int(pos)
    return int(rt)


def _arm_sparse_pad(pipe, req_pad, rule_id, media):
    """Restamp every buffer on `req_pad` to the mux position and send a GAP
    every SPARSE_GAP_MS placed SPARSE_GAP_LEAD_MS ahead of it. The branch's
    own timestamps are unusable: tsdemux hands a sparse private stream over
    mostly without PTS and unaligned when it has one; a cue's timing lives in
    its payload (subtitle-core: relative to the carrying PES), not its PTS."""
    GLib, Gst = _gst()
    st = {"pad": req_pad, "restamped": 0, "gaps": 0, "gap_refused": 0, "timer": None}

    def on_buf(pad, info):
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        try:
            pos = _sparse_position(pipe, pad)
        except Exception as e:  # noqa: BLE001
            _emit({"event": "warning", "message": f"mux_routing: sparse restamp failed on {rule_id} ({e})"})
            pos = None
        if pos is not None:
            if st["restamped"] == 0:
                had = None if buf.pts == Gst.CLOCK_TIME_NONE else f"{buf.pts / 1e6:.0f} ms"
                _log(f"sparse {media} route on {rule_id} restamped to the mux position "
                     f"(first buffer carried {had or 'no PTS'}, now {pos / 1e6:.0f} ms)")
            buf.pts = pos
            buf.dts = Gst.CLOCK_TIME_NONE
            st["restamped"] += 1
        return Gst.PadProbeReturn.OK

    req_pad.add_probe(Gst.PadProbeType.BUFFER, on_buf)

    def tick():
        try:
            pos = _sparse_position(pipe, req_pad)
            if pos is None:
                return True
            ok = req_pad.send_event(Gst.Event.new_gap(pos + SPARSE_GAP_LEAD_MS * 1_000_000, 0))
            st["gaps" if ok else "gap_refused"] += 1
        except Exception as e:  # noqa: BLE001
            _emit({"event": "warning", "message": f"mux_routing: sparse GAP failed on {rule_id} ({e})"})
            return False
        return True

    st["timer"] = GLib.timeout_add(SPARSE_GAP_MS, tick)
    _state["sparse"].append(st)
    return st


def _link_pad(pipe, pad, rule_id, media, branch_str, link_to, pad_name, pad_offset_ns, extra, sparse):
    GLib, Gst = _gst()
    try:
        bin_ = Gst.parse_bin_from_description(branch_str, True)
        bin_.set_name(f"branch_{rule_id.replace('::', '_')}_{media}")
        # add → link both ends → sync state: linking before the bin moves to
        # PLAYING avoids buffers with no downstream yet.
        pipe.add(bin_)
        sink_pad = bin_.get_static_pad("sink")
        if sink_pad is None:
            _emit({"event": "error", "message": f"mux_routing: branch has no sink pad ({rule_id})"})
            return
        ret = pad.link(sink_pad)
        if ret != Gst.PadLinkReturn.OK:
            _emit({"event": "error", "message": f"mux_routing: pad link failed ({ret}) on {rule_id}"})
            return
        if link_to:
            target = pipe.get_by_name(link_to)
            if target is None:
                _emit({"event": "error", "message": f"mux_routing: linkTo target not found: {link_to}"})
                return
            src_pad = bin_.get_static_pad("src")
            req_pad = target.request_pad_simple(pad_name)
            if src_pad is None or req_pad is None:
                _emit({"event": "error",
                       "message": f"mux_routing: could not request {pad_name} on {link_to} ({rule_id})"})
                return
            # Offset BEFORE linking: the sticky segment propagates at link time.
            if pad_offset_ns:
                req_pad.set_offset(int(pad_offset_ns))
            outer = src_pad.link(req_pad)
            if outer != Gst.PadLinkReturn.OK:
                _emit({"event": "error",
                       "message": f"mux_routing: could not link branch to {link_to} ({outer}) ({rule_id})"})
                return
            if sparse:
                _arm_sparse_pad(pipe, req_pad, rule_id, media)
        bin_.sync_state_with_parent()
        _emit({"event": "pad_linked", "rule": rule_id, "padName": pad.get_name(), **extra,
               **({"padOffsetNs": int(pad_offset_ns)} if (pad_offset_ns and link_to) else {})})
    except GLib.Error as e:
        _emit({"event": "error", "message": f"mux_routing: branch parse failed: {e.message}"})
