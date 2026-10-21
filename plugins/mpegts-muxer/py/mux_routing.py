"""mpegts-muxer runner hook: media-agnostic routing of demuxed pads into the
muxer (ADR-0017), owned by the plugin (ADR-0002: no domain code in the engine).

Installed through `PipelineDescription.runnerHooks` as
`{"module": "mux_routing", "config": {"inputs": [...]}}`; the engine runner
imports this module (every plugin `py/` dir is on its PYTHONPATH), calls
`install(pipeline, config, ctx)` before PLAYING and `clear()` on stop.

    config = {"inputs": [{
        "demux":  "demux_0",                 # tsdemux whose pad-added we route
        "linkTo": "mux",                     # the mpegtsmux (request pads)
        "pid":    264,                       # generic input: the output PID of its stream
        "routes": {                          # first pad of each class goes here
            "video":    {"branch": "mralignwatch …", "parser": "none"},
            "audio":    {"branch": "mralignwatch …"},
            "klv":      {"branch": "mralignwatch … sparse=true"},
            "subtitle": {"branch": "mralignwatch … sparse=true"},
        },
        "ignorePids": [496],                 # never routed (an upstream name carousel)
        "pcr": {"program": 1},               # pick the PCR stream video-first at link time
    }]}

A LEGACY port (`video-N` / `audio-N`) has no `pid`; each of its routes carries
a fixed `padName` (`sink_<pid>`) instead.

What one input does at pad-added time:
  * classify the pad by caps — video / audio / klv (`meta/x-klv`, the WebVTT
    carrier of ADR-0016) / subtitle (DVB, teletext) / data;
  * the FIRST pad of a class with a route is parsed (codec parser picked from
    the caps, mpegtsmux refuses unparsed AAC/AC-3/MPEG audio), pushed through
    the route's `branch` and linked into `linkTo`'s request pad — the route's
    `padName` on a legacy port; on a generic input `sink_<pid>` where the
    input's OWN `pid` goes to its highest-priority class (video, audio, klv,
    subtitle — `_PRIORITY`) and every further class takes the next free PID
    above it. Which classes the input carries is read from the source PMT
    (tsdemux posts every section on the bus; `sync-message::element`) BEFORE
    any pad appears, so the choice never depends on which pad shows up first
    and a subtitle-only input lands on exactly the PID the operator set. Once
    a class has a PID in this run it keeps it. `prog-map` gets an entry for
    every extra PID before the pad is requested;
  * everything else — a class without a route, a second pad of a routed
    class, an ignored PID — is sunk into a `fakesink` so the demuxer keeps
    flowing: tsdemux combines its pads' flow returns, a TS whose ONLY pad is
    left unlinked returns NOT_LINKED and the source restart-loops (the
    2026-09-15 .103 muxer);
  * with `pcr`, `prog-map`'s `PCR_<program>` is pointed at the first VIDEO
    pad's request pad before it is linked (first audio until a video shows
    up) — mpegtsmux reads prog-map per pad at stream creation, so the builder
    need not know which input carries video.

Timestamps are not the hook's business: a route's buffers reach the mux as the
branch hands them over. A cue route's `mralignwatch sparse=true` (in its
`branch`) fills between cues with gaps at the mux's pace.

Events go to the engine through `ctx["emit_event"]`: `pad_linked`
(`rule`, `padName`, `media`, `pid`, `outPid`), `warning`,
`error` — the same shapes the runner's own pad-link rules emit, so GstRunner
logs them the same way — and through `ctx["emit_plugin_event"]` one
`mux:routed` per linked pad (`demux`, `media`, `srcPid`, `outPid`, `caps`)
for the module's status panel. Pinned by `mux_routing_test.py` (real tsdemux
→ mpegtsmux run).
"""
import sys
import threading

_emit_event = None
_emit_plugin_event = None
# PMT messages and pad-added run on each demuxer's streaming thread; two
# inputs at once must not pick the same PID nor swap the mux's prog-map
# together (the native form holds a mutex for the same reasons).
_lock = threading.Lock()
# {"pcr": {linkTo: {...}}, "handlers": [(element, id)], "warned": set(),
#  "taken": set(output PIDs no class may take), "inputs": {demux name: input state},
#  "bus": (bus, handler id) or None}
_state = None

# Class order when one input carries several streams: the first class present
# takes the input's PID. TS twin: MUX_ROUTE_PRIORITY (engine/muxPids.ts).
_PRIORITY = ("video", "audio", "klv", "subtitle")
# Output PIDs an extra class may never spill onto (mpegtsmux PMT, the old
# metadata carousel PID every muxer still drops downstream).
_RESERVED_PIDS = (0x1000, 0x1F0)
MAX_ES_PID = 0x1FFE

# PMT stream_type → route class (ISO/IEC 13818-1 table 2-34 + registrations);
# 0x06 private PES is named by its descriptor loop only (see pmt_stream_media).
_VIDEO_STREAM_TYPES = {0x01, 0x02, 0x10, 0x1B, 0x24, 0x42, 0xEA}
_AUDIO_STREAM_TYPES = {0x03, 0x04, 0x0F, 0x11, 0x1C, 0x81, 0x87, 0x8A}

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


def pmt_stream_media(stream_type, descriptors=()):
    """Route class of one PMT stream from its stream_type and descriptor
    loop. `descriptors` is an iterable of (tag, extra): `extra` is the
    4-byte registration id for a registration descriptor (0x05), the
    extension tag for a DVB extension descriptor (0x7F), else None — the
    two facts PyGObject can expose (raw descriptor bytes are not readable
    from python; the native hook derives the same pair from the bytes). Same
    identities the ts-splitter labels from (its streamTypes.ts): DVB teletext
    0x56 / subtitling 0x59 are subtitles, a KLVA registration is KLV,
    AC-3/E-AC-3/DTS/AAC/Opus descriptors are audio; an unnamed private
    stream is data."""
    if stream_type in _VIDEO_STREAM_TYPES:
        return "video"
    if stream_type in _AUDIO_STREAM_TYPES:
        return "audio"
    if stream_type == 0x15:
        return "klv"
    if stream_type == 0x06:
        for tag, extra in descriptors:
            if tag in (0x56, 0x59):
                return "subtitle"
            if tag == 0x05 and extra == b"KLVA":
                return "klv"
            if tag == 0x05 and extra == b"Opus":
                return "audio"
            if tag in (0x6A, 0x7A, 0x7B, 0x7C) or (tag == 0x7F and extra == 0x80):
                return "audio"
    return "data"


def _descriptor_facts(d):
    """(tag, extra) of a GstMpegts.Descriptor — see pmt_stream_media."""
    tag = int(d.tag)
    if tag == 0x05:
        try:
            ok, reg, _info = d.parse_registration()
        except Exception:  # noqa: BLE001
            ok, reg = False, 0
        return tag, int(reg).to_bytes(4, "big") if ok else None
    if tag == 0x7F:
        return tag, int(d.tag_extension)
    return tag, None


def plan_output_pid(pid, media, classes, routable, assigned, taken):
    """Output PID for the `media` pad of a generic input whose stream PID is
    `pid`: the input's own PID for its primary class — the first class in
    _PRIORITY among `classes` (the PMT's, plus `media` itself in case no PMT
    was seen) that has a route in `routable` — else the next free PID above
    `pid` not in `taken`. `assigned` (class → PID already handed out on this
    input) makes the choice sticky: a class keeps its PID, and the input's
    PID is handed out once (the primary may well arrive after a spilled
    class — its PID sits in `taken` from install, so no spill takes it).
    None when no output PID is left above `pid` (the native form returns -1);
    the caller reports it and sinks the pad. Pure; unit-tested."""
    if media in assigned:
        return assigned[media]
    present = [c for c in _PRIORITY if (c in classes or c == media) and c in routable]
    primary = present[0] if present else media
    if primary == media and pid not in assigned.values():
        return pid
    out = pid + 1
    while out in taken or out in _RESERVED_PIDS:
        out += 1
    if out > MAX_ES_PID:
        return None
    return out


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
    global _emit_event, _emit_plugin_event, _state
    clear()
    if ctx:
        _emit_event = ctx.get("emit_event")
        _emit_plugin_event = ctx.get("emit_plugin_event")
    _state = {"pcr": {}, "handlers": [], "warned": set(),
              "taken": set(_RESERVED_PIDS), "inputs": {}, "bus": None}
    entries = (config or {}).get("inputs") or []
    # Every input's own PID is off limits to every other input's spill.
    for entry in entries:
        if entry.get("pid") is not None:
            _state["taken"].add(int(entry["pid"]))
    for entry in entries:
        _install_input(pipe, entry)
    if any(e.get("pid") is not None for e in entries):
        _watch_pmts(pipe)


def clear():
    global _state
    if _state is None:
        return
    for element, hid in _state["handlers"]:
        try:
            element.disconnect(hid)
        except Exception:  # noqa: BLE001
            pass
    if _state["bus"] is not None:
        bus, hid = _state["bus"]
        try:
            bus.disconnect(hid)
            bus.disable_sync_message_emission()
        except Exception:  # noqa: BLE001
            pass
    _state = None


def _watch_pmts(pipe):
    """Read each generic input's stream classes off its demuxer's PMT: tsdemux
    posts every PSI section it parses as an element message; sync emission
    delivers it on the demuxer's streaming thread, before that thread adds any
    pad, so `plan_output_pid` always knows the class set first."""
    try:
        import gi
        gi.require_version("GstMpegts", "1.0")
        from gi.repository import GstMpegts
    except (ImportError, ValueError) as e:  # pragma: no cover
        _emit({"event": "warning",
               "message": f"mux_routing: GstMpegts unavailable ({e}) — PIDs of multi-stream inputs "
                          f"follow pad order instead of the PMT"})
        return
    bus = pipe.get_bus()
    if bus is None:
        return

    def on_sync(_bus, msg):
        _, Gst = _gst()
        if msg.type != Gst.MessageType.ELEMENT or _state is None:
            return
        src = msg.src
        name = src.get_name() if src is not None else None
        inp = _state["inputs"].get(name) if name else None
        if inp is None:
            return
        section = GstMpegts.message_parse_mpegts_section(msg)
        if section is None or section.section_type != GstMpegts.SectionType.PMT:
            return
        pmt = section.get_pmt()
        if pmt is None:
            return
        classes = set()
        for stream in pmt.streams:
            descs = [_descriptor_facts(d) for d in (stream.descriptors or [])]
            classes.add(pmt_stream_media(int(stream.stream_type), descs))
        with _lock:
            inp["classes"] = classes
        # Same spelling as the native form: `demux_0 PMT: [klv, video] (pid 264)`.
        _log(f"{name} PMT: [{', '.join(sorted(classes))}] (pid {inp['pid']})")

    bus.enable_sync_message_emission()
    _state["bus"] = (bus, bus.connect("sync-message::element", on_sync))


def _ensure_prog_map(pipe, target_name, program, pad_name):
    """Add `sink_<pid>=(int)program` to `target_name`'s prog-map for a PID the
    builder could not list (a multi-stream input's spill). Same mechanism as
    the PCR pin: mpegtsmux reads prog-map per pad at stream creation. Caller
    holds `_lock`: mpegtsmux frees the old map on every set, unlocked."""
    _, Gst = _gst()
    target = pipe.get_by_name(target_name)
    if target is None or target.find_property("prog-map") is None:
        return
    cur = target.get_property("prog-map")
    if cur is not None and cur.has_field(pad_name):
        return
    struct = cur.copy() if cur is not None else Gst.Structure.new_empty("program_map")
    struct.set_value(pad_name, int(program))
    target.set_property("prog-map", struct)


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
    program = int((pcr or {}).get("program", 1))
    if link_to and pcr:
        _state["pcr"].pop(link_to, None)
    linked = {}   # class → demux pad already routed on this input
    input_pid = entry.get("pid")
    # Generic input state: its PID, the classes its PMT carries, and the
    # output PID each routed class got (sticky for the run).
    inp = {"pid": int(input_pid) if input_pid is not None else None, "classes": set(), "assigned": {}}
    _state["inputs"][demux_name] = inp

    def out_pad_name(media, route):
        """(request-pad name, output PID) for this class; (None, None) when
        no output PID is left — the caller reports it and sinks the pad.
        Caller holds `_lock`."""
        if inp["pid"] is None:
            return route.get("padName"), None
        out = plan_output_pid(inp["pid"], media, inp["classes"], set(routes), inp["assigned"],
                              _state["taken"])
        if out is None:
            return None, None
        inp["assigned"][media] = out
        _state["taken"].add(out)
        return f"sink_{out}", out

    def plan_route(pad, caps, caps_name, pid, media):
        """The routing decision for one demuxed pad, and the mux's prog-map and PCR
        edits it needs: (None, request pad, output PID, branch) to link, else (why the
        pad is sunk, None, None, None). Caller holds `_lock`."""
        if pid is not None and pid in ignore:
            return f"pid 0x{pid:x} is excluded", None, None, None
        route = routes.get(media)
        if not route or (inp["pid"] is None and not route.get("padName")):
            return f"no route for {media} ({caps_name or 'unknown caps'})", None, None, None
        if media in linked:
            return f"second {media} stream (already routed {linked[media]})", None, None, None
        pad_name, out_pid = out_pad_name(media, route)
        if pad_name is None:
            _emit({"event": "error",
                   "message": f"mux_routing: no free output PID above {inp['pid']} for {media} on {rule_id}"})
            return "no free output PID", None, None, None
        linked[media] = pad.get_name()
        if inp["pid"] is not None and out_pid != inp["pid"]:
            _log(f"{rule_id}: {media} spills to output PID {out_pid} (input PID {inp['pid']} "
                 f"belongs to {next((c for c, p in inp['assigned'].items() if p == inp['pid']), 'a higher class')})")
        branch = _parser_prefix(pad, caps, rule_id, route.get("parser") or "auto") + (route.get("branch") or "queue")
        if link_to and inp["pid"] is not None:
            _ensure_prog_map(pipe, link_to, program, pad_name)
        if link_to and pcr and media in ("video", "audio"):
            _pin_pcr_before_link(pipe, link_to, program, media, pad_name, rule_id)
        return None, pad_name, out_pid, branch

    def on_pad_added(_element, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ""
        pid = pid_from_pad_name(pad.get_name())
        media = route_media_for_caps(caps_name)
        # Each demux adds its pads on its own streaming thread: one decision and one
        # prog-map edit at a time (two inputs' edits at once double-freed the map).
        with _lock:
            why, pad_name, out_pid, branch = plan_route(pad, caps, caps_name, pid, media)
        if why is not None:
            _sink_unrouted(pipe, pad, rule_id, why)
            return
        ok = _link_pad(pipe, pad, rule_id, media, branch, link_to, pad_name,
                       {"media": media, "pid": pid, "outPid": out_pid})
        if ok and _emit_plugin_event:
            _emit_plugin_event("mux:routed", {"demux": demux_name, "media": media, "srcPid": pid,
                                              "outPid": out_pid, "caps": caps.to_string() if caps else ""})

    _state["handlers"].append((src, src.connect("pad-added", on_pad_added)))


def _parser_prefix(pad, caps, rule_id, mode):
    """The parser (or capssetter) ahead of a route's branch. Caller holds `_lock`."""
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
    """Sink a pad no route takes. Takes `_lock` for the warned set; the caller must not hold it."""
    _, Gst = _gst()
    key = f"{rule_id}::{why}"
    with _lock:
        first = key not in _state["warned"]
        _state["warned"].add(key)
    if first:
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
    At most two writes per pipeline. Caller holds `_lock`."""
    _, Gst = _gst()
    st = _state["pcr"].get(target_name)
    if st is not None and (st["media"] == "video" or media != "video"):
        return
    target = pipe.get_by_name(target_name)
    if target is None or target.find_property("prog-map") is None:
        return
    try:
        cur = target.get_property("prog-map")
        # A pin the map already holds writes nothing: every set frees the map the mux reads.
        if cur is None or cur.get_string(f"PCR_{program}") != pad_name:
            struct = cur.copy() if cur is not None else Gst.Structure.new_empty("program_map")
            struct.set_value(f"PCR_{program}", pad_name)
            target.set_property("prog-map", struct)
        _state["pcr"][target_name] = {"media": media, "pad": pad_name}
        _log(f"PCR_{program} of {target_name} → {pad_name} ({media}, {rule_id})")
    except Exception as e:  # noqa: BLE001
        _emit({"event": "warning", "message": f"mux_routing: could not pin PCR on {target_name} ({e})"})


def _link_pad(pipe, pad, rule_id, media, branch_str, link_to, pad_name, extra):
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
            return False
        ret = pad.link(sink_pad)
        if ret != Gst.PadLinkReturn.OK:
            _emit({"event": "error", "message": f"mux_routing: pad link failed ({ret}) on {rule_id}"})
            return False
        if link_to:
            target = pipe.get_by_name(link_to)
            if target is None:
                _emit({"event": "error", "message": f"mux_routing: linkTo target not found: {link_to}"})
                return False
            src_pad = bin_.get_static_pad("src")
            req_pad = target.request_pad_simple(pad_name)
            if src_pad is None or req_pad is None:
                _emit({"event": "error",
                       "message": f"mux_routing: could not request {pad_name} on {link_to} ({rule_id})"})
                return False
            outer = src_pad.link(req_pad)
            if outer != Gst.PadLinkReturn.OK:
                _emit({"event": "error",
                       "message": f"mux_routing: could not link branch to {link_to} ({outer}) ({rule_id})"})
                return False
        bin_.sync_state_with_parent()
        _emit({"event": "pad_linked", "rule": rule_id, "padName": pad.get_name(), **extra})
        return True
    except GLib.Error as e:
        _emit({"event": "error", "message": f"mux_routing: branch parse failed: {e.message}"})
        return False
