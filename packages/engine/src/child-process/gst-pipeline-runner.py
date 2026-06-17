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

# In-band KLV name carousel (mpegts muxer, Phase 2). The parent pushes a JSON
# payload via the `set_klv_payload` command; we re-push it onto the named
# `appsrc` once per second so late-joining receivers and live name edits both
# converge. Per plan D6 this never affects pipeline health — a push failure is
# swallowed, an empty payload simply stops pushing.
KLV_CAROUSEL_INTERVAL_S = 1
klv_payloads = {}        # appsrc element name → bytes to carousel
klv_timer_id = None      # GLib source id of the running carousel timer

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

def emit_command_error(req_id, message):
    """Emit a non-fatal RPC handler failure.

    Distinct from `event: error` (which is reserved for pipeline-lifecycle
    failures — bus ERROR, parse-fail, PLAYING-fail, udpsrc timeout — and
    triggers gst-runner's restart path). `command_error` carries the
    originating request id so the parent resolves the pending RPC instead
    of letting it time out, and the live pipeline keeps running.
    """
    evt = {"event": "command_error", "message": message}
    if req_id:
        evt["id"] = req_id
    emit_event(evt)

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
            # timeout, it just posts the message. `kind` discriminates this
            # from generic bus errors so consumers (e.g. video-player) can
            # treat the source-silent case differently from a hard failure.
            emit_event(
                {
                    "event": "error",
                    "kind": "udp_timeout",
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


def _stream_media_from_caps_name(caps_name):
    """Classify a tsdemux pad's media type from its caps structure name.

    Covers the elementary-stream pads (video/audio) plus the private metadata
    pad (`meta/x-klv`) the in-band name channel rides on (Phase 2) and DVB
    subtitles (Phase 4). Anything else is `data` — the stream inspector still
    lists it, it just has no specialised handling.
    """
    if caps_name.startswith('video/'):
        return 'video'
    if caps_name.startswith('audio/'):
        return 'audio'
    if caps_name == 'meta/x-klv':
        return 'metadata'
    if caps_name.startswith('subpicture/') or caps_name == 'application/x-teletext':
        return 'subtitle'
    return 'data'


def _pid_from_tsdemux_pad_name(pad_name):
    """Parse the PID from a tsdemux pad name.

    tsdemux names pads `<media>_<programhex>_<pidhex>` (e.g. `audio_0_0141`,
    `private_0_012c`) — confirmed on 1.22, see the plan's Phase 0 findings.
    The PID is the last `_`-delimited field, hex. Returns the int PID, or None
    if the name doesn't match (so callers degrade to "unknown PID" rather than
    crash on an unexpected pad-name scheme).
    """
    if not pad_name:
        return None
    tail = pad_name.rsplit('_', 1)[-1]
    try:
        return int(tail, 16)
    except ValueError:
        return None


# Decoded-text cap on a KLV buffer before we even try to JSON-parse it (plan
# D6 / section 3 — "a few KB"). A larger buffer is garbage; we emit a malformed
# `stream_names` once rather than parsing megabytes of junk. The JS-side parser
# enforces the same cap; this is the runner's first line of defence.
_KLV_MAX_BYTES = 4096
# One-shot guard so a persistently-bad metadata stream doesn't spam a warning
# every carousel tick — keyed by demux element name.
_klv_garbage_warned = set()


def _attach_klv_reader(pipe, pad, source_name):
    """Attach `queue ! appsink` to a `meta/x-klv` demux pad and forward payloads.

    The `queue` is mandatory (Phase 0 finding): an appsink linked straight onto
    a tsdemux pad back-pressures the streaming loop and stalls the whole TS.
    Per plan D6 this path is report-only — a parse/link failure is swallowed so
    the name channel can never disturb the media pipeline. The appsink hands
    the raw bytes up as a `stream_names` event with a `malformed` hint; the
    actual JSON parse + name merge happens Node-side.
    """
    try:
        q = Gst.ElementFactory.make("queue", None)
        sink = Gst.ElementFactory.make("appsink", None)
        if q is None or sink is None:
            return
        sink.set_property("emit-signals", True)
        sink.set_property("sync", False)
        # Bound the appsink's own queue so a wedged consumer can't grow memory;
        # drop oldest, never block upstream (D6 — must not affect TS health).
        sink.set_property("max-buffers", 4)
        sink.set_property("drop", True)

        def on_sample(s):
            smp = s.emit("pull-sample")
            if not smp:
                return Gst.FlowReturn.OK
            buf = smp.get_buffer()
            ok, mi = buf.map(Gst.MapFlags.READ)
            if not ok:
                return Gst.FlowReturn.OK
            try:
                size = mi.size
                if size == 0 or size > _KLV_MAX_BYTES:
                    if source_name not in _klv_garbage_warned:
                        _klv_garbage_warned.add(source_name)
                        emit_event({"event": "stream_names", "payload": None,
                                    "malformed": True})
                    return Gst.FlowReturn.OK
                try:
                    payload = bytes(mi.data).decode("utf-8")
                except (UnicodeDecodeError, ValueError):
                    if source_name not in _klv_garbage_warned:
                        _klv_garbage_warned.add(source_name)
                        emit_event({"event": "stream_names", "payload": None,
                                    "malformed": True})
                    return Gst.FlowReturn.OK
                emit_event({"event": "stream_names", "payload": payload,
                            "malformed": False})
            finally:
                buf.unmap(mi)
            return Gst.FlowReturn.OK

        sink.connect("new-sample", on_sample)
        pipe.add(q)
        pipe.add(sink)
        q.sync_state_with_parent()
        sink.sync_state_with_parent()
        q.link(sink)
        pad.link(q.get_static_pad("sink"))
    except Exception:  # noqa: BLE001 — name channel must never crash the runner (D6)
        pass


def _install_stream_discovery(element, source_name, read_klv_names=False):
    """Emit a `stream_discovered` event for every pad tsdemux exposes.

    Separate from the pad-link rules: link rules filter by media and only fire
    for the streams a module routes, whereas the stream inspector wants *all*
    streams in the TS — including the private metadata PID and any extra
    audio/subtitle PIDs the source carries that aren't wired to an output.
    Discovery never links or routes anything; it only reports (plan D6 — the
    metadata/inspection path must not affect routing or pipeline health).

    When `read_klv_names` is set (mpegts demuxer, Phase 2), a `meta/x-klv` pad
    additionally gets a `queue ! appsink` reader so the in-band name carousel is
    surfaced as `stream_names` events. The metadata PID is still never linked to
    a routing branch — only read for labels.
    """
    pipe = element.get_parent()

    def on_pad(_el, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ''
        emit_event({
            "event": "stream_discovered",
            "from": source_name,
            "pid": _pid_from_tsdemux_pad_name(pad.get_name()),
            "media": _stream_media_from_caps_name(caps_name or ''),
            "caps": caps.to_string() if caps else '',
            "padName": pad.get_name(),
        })
        if read_klv_names and caps_name == 'meta/x-klv' and pipe is not None:
            _attach_klv_reader(pipe, pad, source_name)

    element.connect("pad-added", on_pad)


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

_DECODER_MAX_THREADS = max(1, os.cpu_count() or 1)


def _set_decoder_threads(element):
    """If `element` is an avdec_* decoder, set its `max-threads` property.

    Called from both branches of decoder discovery — explicit elements in the
    parsed graph and elements auto-plugged later by decodebin. Guards with
    `find_property` because not every avdec_* has the prop and `try/except`
    on a 1-line set would be noisier. `thread-type` is left at its default
    (0 = ffmpeg picks slice/frame combo) — the win is in `max-threads`.
    """
    factory = element.get_factory()
    name = factory.get_name() if factory else ""
    if not name.startswith("avdec_"):
        return
    if element.find_property("max-threads") is None:
        return
    try:
        element.set_property("max-threads", _DECODER_MAX_THREADS)
        sys.stderr.write(f"[gst-runner.py] decoder threads: {name} max-threads={_DECODER_MAX_THREADS}\n")
        sys.stderr.flush()
    except GLib.Error as e:
        sys.stderr.write(f"[gst-runner.py] decoder threads: {name} set failed: {e.message}\n")
        sys.stderr.flush()


def _install_decoder_thread_hook(pipe):
    """Set max-threads on every avdec_* in the pipeline — both the elements
    that exist at parse time (explicit `avdec_aac` etc.) and the ones plugged
    later by decodebin once caps are negotiated.

    Two hooks because they cover disjoint cases:
      1. Walk current children and set the property on any avdec_* already
         present — catches explicit decoders in the parsed graph.
      2. Connect `deep-element-added` on the pipeline root — fires for every
         element added to any descendant bin (including decodebin's
         auto-plugged decoder), one signal connect for all nesting.
    `element-setup` would be cleaner but doesn't exist on this GStreamer
    version's `decodebin`; `deep-element-added` is the portable equivalent.
    """
    def visit(bin_):
        it = bin_.iterate_elements()
        while True:
            result, element = it.next()
            if result == Gst.IteratorResult.OK:
                _set_decoder_threads(element)
                if isinstance(element, Gst.Bin):
                    visit(element)
            elif result == Gst.IteratorResult.DONE:
                break
            else:
                break
    visit(pipe)
    pipe.connect("deep-element-added", lambda _root, _bin, el: _set_decoder_threads(el))
    sys.stderr.write(f"[gst-runner.py] decoder-threads hook installed (cpu={_DECODER_MAX_THREADS})\n")
    sys.stderr.flush()


def _parser_prefix_for_pad(pad, rule_id):
    """Return the codec-parser prefix string (`'aacparse ! '`, or '') to prepend
    to a branch for this pad's caps, warning once per unknown codec. Shared by
    the single-branch and tee fan-out link paths."""
    caps = pad.get_current_caps() or pad.query_caps(None)
    parser = _parser_for_caps(caps)
    if parser is None:
        caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else 'unknown'
        warn_key = f"{rule_id}::{caps_name}"
        if warn_key not in _unknown_codec_warned:
            _unknown_codec_warned.add(warn_key)
            emit_event({"event": "warning",
                        "message": f"linkOnPadAdded: no parser registered for caps '{caps_name}' on rule {rule_id} — linking passthrough; mpegtsmux may refuse if codec needs framing"})
        return ''
    return f"{parser} ! " if parser != '' else ''


def _link_pad_to_branches_via_tee(pipe, pad, rule_id, indices, branches,
                                  link_to_name):
    """Fan one demux pad out to several branches through a `tee`.

    Used when a PID appears more than once in `matchPids` — e.g. the mpegts-
    demuxer migration, where a PID-based output port and the legacy positional
    port that maps to the same stream both need the pad's data. One pad can
    only link once, so we insert a `tee` and feed each branch from its own
    requested tee src pad. The shared codec parser is applied once, before the
    tee, so every branch receives parsed frames. `linkTo` is not supported on
    this path (the demuxer branches are self-contained `queue ! mpegtsmux !
    udpsink`); a rule that needs both is a configuration error.
    """
    if link_to_name:
        emit_event({"event": "error",
                    "message": f"linkOnPadAdded: duplicate-PID fan-out with linkTo is unsupported ({rule_id})"})
        return
    try:
        # Build the optional parser + tee as explicit elements added directly to
        # the pipeline (not wrapped in a bin): a tee's request src pads aren't
        # ghosted out of a bin, so linking them to a sibling branch bin fails
        # with WRONG_HIERARCHY. As direct pipeline children they share the
        # branch bins' hierarchy and link cleanly. The parser (if any) sits
        # before the tee so every branch receives muxer-ready frames.
        prefix = _parser_prefix_for_pad(pad, rule_id).removesuffix(" ! ")
        head = Gst.parse_bin_from_description(prefix, True) if prefix else None
        tee = Gst.ElementFactory.make("tee", None)
        pipe.add(tee)
        tee.sync_state_with_parent()
        if head:
            # parser bin in front of the tee: pad ! parser ! tee.
            pipe.add(head)
            head.sync_state_with_parent()
            if pad.link(head.get_static_pad("sink")) != Gst.PadLinkReturn.OK or \
               head.get_static_pad("src").link(tee.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
                emit_event({"event": "error",
                            "message": f"linkOnPadAdded: tee fan-out parser link failed ({rule_id})"})
                return
        elif pad.link(tee.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
            emit_event({"event": "error",
                        "message": f"linkOnPadAdded: tee fan-out link failed ({rule_id})"})
            return
        for index in indices:
            if index >= len(branches):
                continue
            leaf = Gst.parse_bin_from_description(branches[index], True)
            leaf.set_name(f"branch_{rule_id.replace('::','_')}_{index}")
            pipe.add(leaf)
            leaf.sync_state_with_parent()
            tee_src = tee.request_pad_simple("src_%u")
            link_ret = tee_src.link(leaf.get_static_pad("sink")) if tee_src else None
            if link_ret != Gst.PadLinkReturn.OK:
                emit_event({"event": "error",
                            "message": f"linkOnPadAdded: tee branch link failed ({rule_id}, {index}, {link_ret})"})
                continue
            emit_event({"event": "pad_linked", "rule": rule_id, "index": index,
                        "padName": pad.get_name()})
    except GLib.Error as e:
        emit_event({"event": "error",
                    "message": f"linkOnPadAdded: tee fan-out parse failed: {e.message}"})


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
      "requestedPadNames": ["sink_256", ...],  # optional — explicit request-pad
                                        # names to ask `linkTo` for, one per
                                        # matched pad. Index N uses entry N; past
                                        # the list end we fall back to "sink_%d".
                                        # Generic: mpegtsmux uses "sink_<pid>" to
                                        # pin a stream's PID (plan D3).
      "matchPids": [256, 321, ...],     # optional — match pads to branches by
                                        # PID instead of pad-added order. branch N
                                        # links to the pad whose PID == matchPids[N]
                                        # (PID read from the pad name); a pad whose
                                        # PID isn't listed is ignored. Fixes the
                                        # positional fragility for PID-based ports
                                        # (mpegts-demuxer, plan Phase 3).
    }

    By default the Nth pad of the matching media type is connected to
    `branches[N]`. When `matchPids` is supplied, the pad's PID picks the branch
    index instead, so pad-added order and unrouted extra streams don't misroute.
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
    requested_pad_names = rule.get("requestedPadNames") or []
    # Optional PID→branch matching (plan Phase 3). When present, the pad's PID
    # picks the branch index; absent, we fall back to pad-added order.
    match_pids = rule.get("matchPids") or []

    def on_pad_added(_element, pad):
        if media_filter and _pad_caps_media(pad) != media_filter:
            return
        if match_pids:
            # Match this pad to its branch(es) by PID rather than arrival order.
            # A pad whose PID isn't wired to an output (extra source stream)
            # is simply ignored — never misrouted onto another branch.
            pad_pid = _pid_from_tsdemux_pad_name(pad.get_name())
            indices = [i for i, p in enumerate(match_pids) if p == pad_pid]
            if pad_pid is None or not indices:
                return
            # A PID can appear more than once in matchPids when several output
            # ports carry the same stream (mpegts-demuxer migration: a PID-based
            # port and the legacy positional port that maps to it). One pad can
            # only link once, so fan it out through a `tee` and feed each branch
            # from its own tee src pad.
            if len(indices) > 1:
                _link_pad_to_branches_via_tee(pipe, pad, rule_id, indices, branches,
                                              link_to_name)
                return
            index = indices[0]
        else:
            index = _pad_link_counts[rule_id]
        if index >= len(branches):
            return
        _pad_link_counts[rule_id] = index + 1
        # Auto-prepend the right codec parser based on the pad's actual caps.
        # Centralising parser selection here means JS-side branches stay
        # codec-agnostic (`queue ! mpegtsmux ! udpsink`) and the same demuxer
        # can serve mixed-codec streams (e.g. one AAC pad + one Opus pad)
        # without per-pad config.
        branch_str = _parser_prefix_for_pad(pad, rule_id) + branches[index]
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
                # Request a sink pad on the target (works for muxers /
                # aggregators). If the rule pinned an explicit name for this
                # pad index (e.g. mpegtsmux "sink_<pid>" to fix the PID per
                # D3), ask for that exact pad; otherwise fall back to the
                # implicit auto-numbered "sink_%d".
                pad_name = (
                    requested_pad_names[index]
                    if index < len(requested_pad_names)
                    else "sink_%d"
                )
                req_pad = target.request_pad_simple(pad_name)
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


# GstNet is optional: only sync-enabled pipelines carry a `clock` config. If
# the typelib is missing we log once and run on the default clock (unsynced) —
# never fatal, so a box without GstNet still plays, just without cross-pipeline
# lock.
_GstNet = None
_net_clock_warned = False


def _apply_net_clock(pipe, clock_cfg):
    """Slave `pipe` to the shared net clock for cross-pipeline A/V sync.

    `clock_cfg` = {host, port} from the engine's clock authority. None / falsy
    → no-op (the pipeline keeps its auto-selected clock, today's behaviour).
    Every pipeline in a sync group gets the SAME host/port; sharing the clock
    (same rate) removes the drift. Base-time is anchored naturally at PLAYING
    (no shared base-time), leaving a small constant start offset. Buffers must
    carry the shared source PTS (no per-consumer re-anchoring) for the
    running-times to line up.
    """
    global _GstNet, _net_clock_warned
    if not clock_cfg:
        return
    host = clock_cfg.get("host")
    port = clock_cfg.get("port")
    if not host or not port:
        return
    if _GstNet is None:
        try:
            gi.require_version("GstNet", "1.0")
            from gi.repository import GstNet
            _GstNet = GstNet
        except (ValueError, ImportError):
            if not _net_clock_warned:
                _net_clock_warned = True
                emit_event({"event": "warning",
                            "message": "GstNet unavailable — pipeline runs unsynced (no cross-pipeline clock)"})
            return
    clock = _GstNet.NetClientClock.new(None, host, int(port), 0)
    # Block briefly for the first clock sync so the first buffers are stamped
    # against a settled clock; a slow sync just means a short startup delay.
    clock.wait_for_sync(2 * Gst.SECOND)
    pipe.use_clock(clock)
    # Sharing the clock (same rate) is what kills the DRIFT — that's the whole
    # point. Base-time is left to anchor naturally at PLAYING: every pipeline
    # lands within a moment of the others on the SAME clock, so the residual is
    # a small CONSTANT offset (trim with a sink ts-offset if needed), never
    # growing. We deliberately do NOT force a shared base-time — coordinating
    # one in this clock's time domain across processes is fragile and a stale
    # value would make every buffer "late" and break playback.


def handle_start(data):
    """Start a GStreamer pipeline from a pipeline string."""
    global pipeline, loop, running, use_stdio_for_data, _pad_link_counts
    global klv_payloads, klv_timer_id

    # Drop any carousel state from a prior run; the parent re-pushes after the
    # pipeline is PLAYING. Stale payloads pointing at the old element graph
    # would just no-op, but clearing keeps the carousel deterministic.
    klv_payloads = {}
    if klv_timer_id is not None:
        GLib.source_remove(klv_timer_id)
        klv_timer_id = None

    pipeline_str = data.get("pipeline", "")
    use_stdio_for_data = data.get("useStdioForData", False)
    pad_link_rules = data.get("linkOnPadAdded", []) or []
    read_klv_names = data.get("readKlvNames", False)
    _klv_garbage_warned.clear()

    if not pipeline_str:
        emit_event({"event": "error", "message": "No pipeline string provided"})
        return

    try:
        pipeline = Gst.parse_launch(pipeline_str)
    except GLib.Error as e:
        emit_event({"event": "error", "message": f"Pipeline parse error: {e.message}"})
        return

    # Cross-pipeline A/V sync (opt-in): slave this pipeline to a shared net
    # clock + base-time so it presents on the SAME timeline as its sibling
    # pipelines (e.g. video-player ↔ audio-decoder). Applied before PLAYING so
    # the pipeline never runs on its own auto-selected clock first.
    _apply_net_clock(pipeline, data.get("clock"))

    # Reset per-run pad counters and install dynamic-pad-link rules
    _pad_link_counts = {}
    for rule in pad_link_rules:
        _install_pad_link_rule(pipeline, rule)

    # Install stream discovery on every distinct demux element the rules
    # reference, so the owning module sees an unfiltered `stream_discovered`
    # event per pad (PID + caps + media type) regardless of what's routed.
    # Connected once per element even when a tsdemux has both a video and an
    # audio rule.
    for src_name in {rule.get("from") for rule in pad_link_rules if rule.get("from")}:
        el = pipeline.get_by_name(src_name)
        if el:
            _install_stream_discovery(el, src_name, read_klv_names)

    # Crank software decoders to all available cores. avdec_* defaults to 1
    # thread (or whatever ffmpeg picks at runtime, often conservative) which
    # leaves 3 of the Pi 5's 4 A76 cores idle. With multi-threaded slice/frame
    # decode the same workload finishes in a fraction of the wall-clock time,
    # turning a borderline 1080p H.264 stream from "every IDR is a hiccup" into
    # comfortable headroom. The pipeline string can't set this property when
    # the decoder is plugged by `decodebin` (the element doesn't exist at parse
    # time), so we hook every avdec_* as it shows up — see the function for
    # the two-pronged tree-walk + `deep-element-added` strategy.
    _install_decoder_thread_hook(pipeline)

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
    req_id = data.get("id")
    if not pipeline:
        emit_command_error(req_id, "No pipeline running")
        return

    element_name = data.get("element", "")
    prop = data.get("property", "")
    value = data.get("value")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_command_error(req_id, f"Element not found: {element_name}")
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
        result = {"event": "property_set", "element": element_name, "property": prop, "value": value}
        if req_id:
            result["id"] = req_id
        emit_event(result)
    except Exception as e:
        emit_command_error(req_id, f"set_property failed: {e}")

def handle_get_property(data):
    """Get a property from a named element."""
    req_id = data.get("id")  # For request/response correlation
    if not pipeline:
        emit_command_error(req_id, "No pipeline running")
        return

    element_name = data.get("element", "")
    prop = data.get("property", "")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_command_error(req_id, f"Element not found: {element_name}")
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
        emit_command_error(req_id, f"get_property failed: {e}")

def handle_get_stats(data):
    """Read the 'stats' property from a named element (e.g. srtsrc, srtserversrc)."""
    req_id = data.get("id")
    if not pipeline:
        emit_command_error(req_id, "No pipeline running")
        return

    element_name = data.get("element", "")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_command_error(req_id, f"Element not found: {element_name}")
        return

    try:
        stats = element.get_property("stats")
        stats_dict = gst_structure_to_dict(stats) if isinstance(stats, Gst.Structure) else {}
        result = {"event": "stats", "element": element_name, "data": stats_dict}
        if req_id:
            result["id"] = req_id
        emit_event(result)
    except Exception as e:
        emit_command_error(req_id, f"get_stats failed: {e}")

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
    req_id = data.get("id")
    if not pipeline:
        emit_command_error(req_id, "No pipeline running")
        return

    element_name = data.get("element", "")
    pad_name = data.get("pad", "src")

    element = pipeline.get_by_name(element_name)
    if not element:
        emit_command_error(req_id, f"Element not found: {element_name}")
        return

    pad = element.get_static_pad(pad_name)
    if not pad:
        emit_command_error(req_id, f"Pad not found: {element_name}.{pad_name}")
        return

    with throughput_lock:
        if element_name not in throughput_trackers:
            import time
            throughput_trackers[element_name] = {
                'bytes': 0, 'last_bytes': 0,
                'last_time': time.monotonic(), 'bps': 0,
            }
            pad.add_probe(Gst.PadProbeType.BUFFER, _pad_probe_cb, element_name)

    # Always ack — second call for an already-tracked element is a no-op but
    # the parent's pending RPC still needs to resolve.
    result = {"event": "tracking", "element": element_name, "pad": pad_name}
    if req_id:
        result["id"] = req_id
    emit_event(result)

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

def _push_klv_carousel():
    """Re-push every stored KLV payload onto its appsrc. Runs on the GLib loop.

    One buffer per appsrc per tick. Never raises — a missing element, a NULL
    pipeline, or a push that returns non-OK is swallowed so the name channel
    can't disturb the media pipeline (plan D6). `Gst.Buffer.new_wrapped(b"")`
    aborts on null data (Phase 0 finding), so empty payloads are skipped at
    the source (`handle_set_klv_payload` never stores an empty payload).
    """
    if not klv_payloads or pipeline is None:
        return True
    for name, payload in klv_payloads.items():
        try:
            src = pipeline.get_by_name(name)
            if src is None:
                continue
            buf = Gst.Buffer.new_wrapped(payload)
            src.emit("push-buffer", buf)
        except Exception:  # noqa: BLE001 — name channel must never crash the runner
            pass
    return True  # keep the timer alive


def _ensure_klv_timer():
    """Start the carousel timer once there's at least one payload to push."""
    global klv_timer_id
    if klv_timer_id is None and klv_payloads:
        klv_timer_id = GLib.timeout_add_seconds(
            KLV_CAROUSEL_INTERVAL_S, _push_klv_carousel
        )


def handle_set_klv_payload(data):
    """Store/replace the KLV name payload for an appsrc and (re)start the carousel.

    Fire-and-forget from the parent (no `id`/ack). An empty payload clears the
    stored entry — we never push a zero-length buffer (it aborts on 1.22). The
    payload is pushed immediately so a live name edit converges without waiting
    a full carousel interval.
    """
    name = data.get("element", "")
    payload = data.get("payload", "")
    if not name:
        return
    if not payload:
        klv_payloads.pop(name, None)
        return
    klv_payloads[name] = payload.encode("utf-8") if isinstance(payload, str) else payload
    _ensure_klv_timer()
    _push_klv_carousel()


# Command dispatch
CMD_HANDLERS = {
    "start": handle_start,
    "stop": handle_stop,
    "set_property": handle_set_property,
    "get_property": handle_get_property,
    "get_stats": handle_get_stats,
    "track_throughput": handle_track_throughput,
    "get_throughput": handle_get_throughput,
    "set_klv_payload": handle_set_klv_payload,
}

def dispatch_command(line):
    """Parse and dispatch a JSON command."""
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        # No id available — log only; don't tear the pipeline down for a bad
        # parent message.
        emit_command_error(None, f"Invalid JSON command: {line}")
        return

    cmd = data.get("cmd", "")
    handler = CMD_HANDLERS.get(cmd)
    if handler:
        # Run handler on GLib main context for thread safety
        GLib.idle_add(lambda: (handler(data), False)[1])
    else:
        emit_command_error(data.get("id"), f"Unknown command: {cmd}")

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
