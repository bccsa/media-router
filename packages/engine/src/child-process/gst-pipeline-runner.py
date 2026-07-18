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
from gi.repository import Gst, GLib, Gio

import json
import math
import os
import signal
import socket as pysocket
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

# Bus-message subscriptions: (element_name, structure_name) pairs whose ELEMENT
# messages are forwarded verbatim to the parent on the generic
# `<structure>:<element>` plugin-event channel (payload = the structure as a
# dict). Generic — any plugin observes any element bus message (level, QoS,
# spectrum, element stats, …) with zero type-specific code here. Set from
# `busReports` at start. A subscribed `level` element is forwarded instead of
# feeding the aggregate VU meter.
bus_reports = set()

# VU throttle: only send when changed, heartbeat every 1s
last_vu = None
last_vu_time = 0
VU_HEARTBEAT_MS = 1000

# Throughput tracking per element (pad probes)
throughput_trackers = {}  # element_name → { bytes: int, last_bytes: int, last_time: float, bps: float }
throughput_lock = threading.Lock()

# In-band KLV name carousel (mpegts muxer, Phase 2). The parent pushes a JSON
# payload via the `set_klv_payload` command; we re-push it onto the named
# `appsrc` so late-joining receivers and live name edits both converge.
#
# The push interval is SHORT (not 1 s) on purpose, and it is load-bearing for
# video quality — not just a late-joiner nicety. `mpegtsmux` is a GstAggregator:
# it can only advance its output up to the *oldest* timestamp present across ALL
# its sink pads, including this metadata pad. With a 1 s carousel the metadata
# pad's timestamp only advanced once per second, so the mux stalled the
# video/audio output between KLV buffers; the per-pad leaky input queues then
# dropped the backlog, and the muxed stream collapsed to ~8 % of the encoder
# bitrate (measured: 2.2 Mbps encoder -> 0.18 Mbps muxed = ~92 % video loss,
# seen as catastrophic "packet loss"/macroblocking downstream). Re-pushing the
# (tiny) payload every 50 ms keeps the metadata pad's running-time within a
# frame of the media pads, so the aggregator never gates and the full bitrate
# passes through. The payload is small and unchanged between pushes, so the
# extra rate is negligible. (A cleaner long-term fix is to mark the metadata
# pad sparse so mpegtsmux never waits on it regardless of cadence.)
KLV_CAROUSEL_INTERVAL_MS = 50
klv_payloads = {}        # appsrc element name → bytes to carousel
klv_timer_id = None      # GLib source id of the running carousel timer

# "Reached PLAYING" watchdog. A pipeline told to go PLAYING transitions
# asynchronously; if it stalls in PAUSED (sink waiting on a bad clock, caps that
# never negotiate, a demux pad that never appears) nothing else notices — the
# udpsrc timeout can't fire because the source task doesn't run until PLAYING.
# We arm a timer at start and cancel it on the PLAYING state-change; if it
# fires, the pipeline never came up, so we surface a restartable error (the
# parent's restartOnError then rebuilds) instead of wedging silently forever.
#
# LOAD-BEARING INVARIANT: this blanket deadline is safe ONLY because every
# source in this engine is a LIVE source (udpsrc/srtsrc/etc.), so the pipeline
# reaches PLAYING with NO_PREROLL — it does NOT wait for data. A non-live path
# that prerolls off a source which can be silent at startup would turn "waiting
# for data" into a 10 s restart loop; such a path must pass `playingTimeoutMs:0`
# (handle_start honours it) to opt out, or gate the watchdog on data arrival.
PLAYING_WATCHDOG_MS = 10000
playing_watchdog_id = None  # GLib source id of the running PLAYING watchdog


def _cancel_playing_watchdog():
    """Disarm the PLAYING watchdog (reached PLAYING, or pipeline torn down)."""
    global playing_watchdog_id
    if playing_watchdog_id is not None:
        GLib.source_remove(playing_watchdog_id)
        playing_watchdog_id = None


def _on_playing_timeout():
    """Watchdog fired: the pipeline never reached PLAYING. Treat as a fatal
    lifecycle error so the gst-runner restart path recovers it."""
    global playing_watchdog_id
    playing_watchdog_id = None
    # Defensive: if we somehow raced the state-change and are already PLAYING,
    # do nothing.
    if pipeline is not None:
        _ret, state, _pending = pipeline.get_state(0)
        if state == Gst.State.PLAYING:
            return False
    emit_event({
        "event": "error",
        "kind": "playing_timeout",
        "message": f"pipeline did not reach PLAYING within {PLAYING_WATCHDOG_MS} ms",
    })
    if pipeline is not None:
        pipeline.set_state(Gst.State.NULL)
    if loop and loop.is_running():
        loop.quit()
    return False  # one-shot

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

def emit_plugin_event(channel, payload):
    """Generic pipeline→plugin data channel. The runner emits `{channel,
    payload}`; the parent forwards it verbatim to the owning module's
    `onPluginEvent(channel, payload)` hook. This is the ONE transport for
    getting data back from a pipeline — new data types add extraction here and a
    handler in the plugin, never any middle-layer plumbing."""
    emit_event({"event": "plugin_event", "channel": channel, "payload": payload})

# ---------------------------------------------------------------------------
# Bus message handler
# ---------------------------------------------------------------------------
def on_bus_message(bus, message):
    """Handle GStreamer bus messages."""
    t = message.type

    if t == Gst.MessageType.ERROR:
        err, debug = message.parse_error()
        src = message.src
        element = (src.get_name() or "") if src is not None else ""
        # CONTAINMENT: an error originating inside a per-consumer fan-out
        # branch (`busedge_*` bin — edge unixfdsink bind/send failure) must
        # never kill the producer pipeline: that restart-storms the producer's
        # whole consumer subtree over ONE consumer's edge (the same class of
        # cascade the attach-time fix removed). Detach the failed branch and
        # keep running; the engine re-attaches the edge on the next connect /
        # producer-PLAYING reconcile, and the affected consumer's own gate +
        # restart path recovers it independently.
        edge = _busedge_ancestor(src)
        if edge is not None:
            edge_socket = _socket_for_busedge(edge)
            if edge_socket:
                _teardown_bus_branch(edge_socket)
            emit_event({"event": "warning",
                        "message": f"bus edge failed ({element}): {err.message} — "
                                   f"branch detached, producer unaffected"})
            return True
        emit_event({"event": "error", "message": str(err.message),
                    "debug": debug or "", "element": element})
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
            if new == Gst.State.PLAYING:
                _cancel_playing_watchdog()
            emit_event({"event": "state_change", "state": state_name})

    elif t == Gst.MessageType.ELEMENT:
        structure = message.get_structure()
        name = structure.get_name() if structure else None
        src = message.src
        src_name = src.get_name() if src else None
        if name and src_name and (src_name, name) in bus_reports:
            # Subscribed via `busReports` — forward the whole structure on the
            # generic `<structure>:<element>` channel (e.g. `level:sclevel`).
            emit_plugin_event(f"{name}:{src_name}", gst_structure_to_dict(structure))
        elif name == "level":
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
# `stream:names` once rather than parsing megabytes of junk. The JS-side parser
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
    the raw bytes up on the `stream:names` plugin-event channel with a
    `malformed` hint; the actual JSON parse + name merge happens Node-side.
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
                        emit_plugin_event("stream:names",
                                          {"payload": None, "malformed": True})
                    return Gst.FlowReturn.OK
                try:
                    payload = bytes(mi.data).decode("utf-8")
                except (UnicodeDecodeError, ValueError):
                    if source_name not in _klv_garbage_warned:
                        _klv_garbage_warned.add(source_name)
                        emit_plugin_event("stream:names",
                                          {"payload": None, "malformed": True})
                    return Gst.FlowReturn.OK
                emit_plugin_event("stream:names",
                                  {"payload": payload, "malformed": False})
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
    """Report every pad tsdemux exposes on the `stream:discovered` channel.

    Separate from the pad-link rules: link rules filter by media and only fire
    for the streams a module routes, whereas the stream inspector wants *all*
    streams in the TS — including the private metadata PID and any extra
    audio/subtitle PIDs the source carries that aren't wired to an output.
    Discovery never links or routes anything; it only reports (plan D6 — the
    metadata/inspection path must not affect routing or pipeline health).

    When `read_klv_names` is set (mpegts demuxer, Phase 2), a `meta/x-klv` pad
    additionally gets a `queue ! appsink` reader so the in-band name carousel is
    surfaced on the `stream:names` channel. The metadata PID is still never
    linked to a routing branch — only read for labels.
    """
    pipe = element.get_parent()

    def on_pad(_el, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        caps_name = caps.get_structure(0).get_name() if caps and caps.get_size() > 0 else ''
        emit_plugin_event("stream:discovered", {
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
    # config-interval=-1: re-emit SPS/PPS (h264) / VPS-SPS-PPS (h265) in-band
    # before EVERY IDR rather than at most once per second. A frame dropped
    # under jitter then recovers at the very next keyframe — without it the
    # decoder can macroblock for up to a second waiting for the next parameter
    # set. Negligible bandwidth cost; the right default for lossy/live links.
    'video/x-h264': 'h264parse config-interval=-1',
    'video/x-h265': 'h265parse config-interval=-1',
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


# avdec_*'s `thread-type` GFlags (verified via gst-inspect on the Pi, and they
# match libavcodec's FF_THREAD_*): 0x1 = frame, 0x2 = slice. Counter-intuitively
# for these streams, FRAME is the mode that actually parallelises decode across
# cores — measured on a 4K H.264 clip: thread-type=frame ~24s → ~14s and the
# live decode goes from one pinned thread to ~5 busy. SLICE gives no speedup
# (broadcast streams are single-slice, so there's nothing within a frame to
# split). The catch: frame threading decodes several frames concurrently, so it
# adds ~max-threads frames of latency (~130-160 ms at 25-30 fps). That breaks
# the live-latency budget, so it is OPT-IN per pipeline (decoderThreadType),
# never the default. Default 'auto' leaves ffmpeg's choice — single-core, zero
# added latency, on the live path.
_THREAD_TYPE_FRAME = 1


def _set_decoder_threads(element, thread_type="auto"):
    """If `element` is an avdec_* decoder, set its threading properties.

    Called from both branches of decoder discovery — explicit elements in the
    parsed graph and elements auto-plugged later by decodebin. Guards with
    `find_property` because not every avdec_* has the prop and `try/except`
    on a 1-line set would be noisier.

    A decoder whose `max-threads` is already non-default (0 = auto) was
    configured explicitly in the pipeline string — leave it entirely alone.
    With frame threading, `max-threads` is NOT a harmless ceiling: it sets the
    concurrent-decode depth, i.e. ~max-threads frames of added latency. The
    transcoder pins `thread-type=frame max-threads=3` (~60 ms at 50 fps);
    overriding that to the core count took a 16-core box to ~320 ms of decode
    delay. Otherwise `max-threads` is cranked to the core count and
    `thread-type` is only forced to FRAME when `thread_type == 'frame'` (the
    opt-in multi-core mode that adds latency); an avdec_* without the
    `thread-type` property stays 'auto' even when frame was asked.
    """
    factory = element.get_factory()
    name = factory.get_name() if factory else ""
    if not name.startswith("avdec_"):
        return
    if element.find_property("max-threads") is None:
        return
    try:
        if element.get_property("max-threads") != 0:
            sys.stderr.write(
                f"[gst-runner.py] decoder threads: {name} configured in pipeline — left as-is\n"
            )
            sys.stderr.flush()
            return
        element.set_property("max-threads", _DECODER_MAX_THREADS)
        applied = "auto"
        if thread_type == "frame" and element.find_property("thread-type") is not None:
            element.set_property("thread-type", _THREAD_TYPE_FRAME)
            applied = "frame"
        sys.stderr.write(
            f"[gst-runner.py] decoder threads: {name} max-threads={_DECODER_MAX_THREADS} "
            f"thread-type={applied}\n"
        )
        sys.stderr.flush()
    except GLib.Error as e:
        sys.stderr.write(f"[gst-runner.py] decoder threads: {name} set failed: {e.message}\n")
        sys.stderr.flush()


def _install_decoder_thread_hook(pipe, thread_type="auto"):
    """Apply decoder threading on every avdec_* in the pipeline — both the
    elements that exist at parse time (explicit `avdec_aac` etc.) and the ones
    plugged later by decodebin once caps are negotiated. `thread_type`
    ('auto' | 'frame') is forwarded to `_set_decoder_threads` for every decoder.

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
                _set_decoder_threads(element, thread_type)
                if isinstance(element, Gst.Bin):
                    visit(element)
            elif result == Gst.IteratorResult.DONE:
                break
            else:
                break
    visit(pipe)
    pipe.connect(
        "deep-element-added",
        lambda _root, _bin, el: _set_decoder_threads(el, thread_type),
    )
    sys.stderr.write(
        f"[gst-runner.py] decoder-threads hook installed "
        f"(cpu={_DECODER_MAX_THREADS} thread-type={thread_type})\n"
    )
    sys.stderr.flush()


def _parser_prefix_for_pad(pad, rule_id):
    """Return the codec-parser prefix string (`'aacparse ! '`, or '') to prepend
    to a branch for this pad's caps, warning once per unknown codec. Shared by
    the single-branch and tee fan-out link paths."""
    caps = pad.get_current_caps() or pad.query_caps(None)
    parser = _parser_for_caps(caps)
    emit_event({"event": "warning",
                "message": f"DEBUG parser pick: pad={pad.get_name()} caps={caps.to_string()[:120] if caps else None} parser={parser!r}"})
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
      "padOffsetNs": -700000000,        # optional — GstPad.set_offset() on the
                                        # linkTo request pad, applied BEFORE the
                                        # link (the sticky segment propagates at
                                        # link time). Positive delays, negative
                                        # advances (early buffers clip at segment
                                        # start). Requires linkTo; not applied on
                                        # the matchPids tee-fanout path.
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
    # Optional timestamp offset (ns) on the linkTo request pad (lipsync knob).
    pad_offset_ns = rule.get("padOffsetNs")

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
                # Apply the pad offset BEFORE linking — the sticky segment
                # event propagates at link time and must already carry it.
                if pad_offset_ns:
                    req_pad.set_offset(int(pad_offset_ns))
                outer_link = src_pad.link(req_pad)
                if outer_link != Gst.PadLinkReturn.OK:
                    emit_event({"event": "error",
                                "message": f"linkOnPadAdded: could not link branch src to {link_to_name} ({outer_link}) ({rule_id})"})
                    return
            bin_.sync_state_with_parent()
            emit_event({"event": "pad_linked",
                        "rule": rule_id,
                        "index": index,
                        "padName": pad.get_name(),
                        **({"padOffsetNs": int(pad_offset_ns)}
                           if (pad_offset_ns and link_to_name) else {})})
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
    #
    # CRITICAL: sync is best-effort and must NEVER block playback. If the clock
    # authority is unreachable (daemon down, stale/ephemeral port, cross-host),
    # `wait_for_sync` returns False. Force-attaching an unsynced NetClientClock
    # is what wedges the pipeline: a `sync=true` sink then waits on a clock that
    # never advances, so the pipeline never reaches PLAYING, its source task
    # never runs, and the upstream socket backs up until everything stalls.
    # When sync fails we leave the auto-selected clock in place and run unsynced
    # — degraded sync beats no playback. `_net_clock_warned` throttles the log.
    if not clock.wait_for_sync(2 * Gst.SECOND):
        if not _net_clock_warned:
            _net_clock_warned = True
            emit_event({"event": "warning",
                        "message": f"net clock {host}:{port} did not sync — running unsynced (auto clock)"})
        # The pipeline was built for the synced case: its sink is `sync=true` so
        # it would present each frame at its (shared-clock) PTS. With no shared
        # clock that sink waits on timestamps it can't honour and stalls. Relax
        # the named `sink` to `sync=false` so it renders frames as they arrive —
        # the same low-latency behaviour the unsynced (SRT/RIST) path uses, which
        # plays reliably. Best-effort: skip silently if there's no such element.
        sink = pipe.get_by_name("sink")
        if sink is not None:
            try:
                sink.set_property("sync", False)
            except (TypeError, AttributeError, GLib.Error):
                pass
        return
    pipe.use_clock(clock)
    # Sharing the clock (same rate) is what kills the DRIFT — that's the whole
    # point. Base-time is left to anchor naturally at PLAYING: every pipeline
    # lands within a moment of the others on the SAME clock, so the residual is
    # a small CONSTANT offset (trim with a sink ts-offset if needed), never
    # growing. We deliberately do NOT force a shared base-time — coordinating
    # one in this clock's time domain across processes is fragile and a stale
    # value would make every buffer "late" and break playback.


def _isolate_loopback_bus_udpsrc(pipe):
    """Group-bind every loopback-bus udpsrc so foreign unicast can't pollute it.

    GStreamer's udpsrc binds INADDR_ANY:port on Linux even when a
    multicast-group is set, so any unicast datagram sprayed at that port is
    delivered into the pipeline and interleaved with the bus TS. Seen live on
    a fleet box: a remote RIST peer's control packets (60/64-byte keepalives)
    landed on ports colliding with the bus allocator range (40000+), and the
    SRT output forwarded them to MediaMTX, which rejected the whole publish
    with "received packet with size 60 not multiple of 188".

    Fix: pre-create the socket ourselves, bound to the GROUP address
    (239.x:port) — the kernel then only delivers datagrams addressed to the
    group, excluding all unicast — and hand it to udpsrc via its `socket`
    property. Membership is joined on `lo` explicitly (the bus convention),
    with `auto-multicast` disabled so udpsrc doesn't double-join.

    Only touches udpsrc elements with `multicast-iface=lo` AND a `239.`
    address — the loopback-bus signature from buildUdpSrc. Network-facing
    sources (mpegts-ip-input on a real NIC, ristsrc's internal udpsrc pair)
    use other ifaces/addresses and keep stock behaviour. Any failure falls
    back to udpsrc's own ANY-bind (today's behaviour) with a warning.
    """
    it = pipe.iterate_recurse()
    while True:
        result, element = it.next()
        if result == Gst.IteratorResult.RESYNC:
            it.resync()
            continue
        if result != Gst.IteratorResult.OK:
            break
        factory = element.get_factory()
        if not factory or factory.get_name() != 'udpsrc':
            continue
        try:
            iface = element.get_property('multicast-iface')
            addr = element.get_property('address')
            port = element.get_property('port')
        except (TypeError, GLib.Error):
            continue
        if iface != 'lo' or not addr or not addr.startswith('239.'):
            continue
        try:
            gsock = Gio.Socket.new(Gio.SocketFamily.IPV4,
                                   Gio.SocketType.DATAGRAM,
                                   Gio.SocketProtocol.UDP)
            buf = element.get_property('buffer-size') or 0
            if buf > 0:
                gsock.set_option(pysocket.SOL_SOCKET, pysocket.SO_RCVBUF, buf)
            # allow_reuse=True — several consumers of one producer share a port
            gsock.bind(Gio.InetSocketAddress.new_from_string(addr, port), True)
            gsock.join_multicast_group(Gio.InetAddress.new_from_string(addr),
                                       False, 'lo')
            element.set_property('auto-multicast', False)
            element.set_property('socket', gsock)
            sys.stderr.write(
                f"[gst-runner.py] bus udpsrc {addr}:{port} group-bound "
                f"(foreign unicast excluded)\n")
            sys.stderr.flush()
        except GLib.Error as e:
            emit_event({"event": "warning",
                        "message": f"bus udpsrc isolation failed for {addr}:{port} "
                                   f"— falling back to ANY-bind: {e.message}"})


def handle_start(data):
    """Start a GStreamer pipeline from a pipeline string."""
    global pipeline, loop, running, use_stdio_for_data, _pad_link_counts
    global klv_payloads, klv_timer_id, playing_watchdog_id, bus_reports

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
    decoder_thread_type = data.get("decoderThreadType", "auto")
    _klv_garbage_warned.clear()

    if not pipeline_str:
        emit_event({"event": "error", "message": "No pipeline string provided"})
        return

    try:
        pipeline = Gst.parse_launch(pipeline_str)
    except GLib.Error as e:
        emit_event({"event": "error", "message": f"Pipeline parse error: {e.message}"})
        return

    # Harden the loopback bus BEFORE any state change: group-bound sockets
    # must be handed to udpsrc while it is still NULL (it opens/binds on
    # READY). See _isolate_loopback_bus_udpsrc for the why.
    _isolate_loopback_bus_udpsrc(pipeline)

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
    # reference, so the owning module sees an unfiltered `stream:discovered`
    # report per pad (PID + caps + media type) regardless of what's routed.
    # Connected once per element even when a tsdemux has both a video and an
    # audio rule.
    for src_name in {rule.get("from") for rule in pad_link_rules if rule.get("from")}:
        el = pipeline.get_by_name(src_name)
        if el:
            _install_stream_discovery(el, src_name, read_klv_names)

    # Set software-decoder threading. `max-threads` is always the core count;
    # `decoderThreadType` (default 'auto') decides whether to force FRAME
    # threading, the opt-in multi-core mode that relieves a pinned core on heavy
    # 4K software decode at the cost of ~130-160 ms latency — so it's never the
    # default on the live path. The pipeline string can't set this when the
    # decoder is plugged by `decodebin` (the element doesn't exist at parse
    # time), so we hook every avdec_* as it shows up — see the function for the
    # two-pronged tree-walk + `deep-element-added` strategy.
    _install_decoder_thread_hook(pipeline, decoder_thread_type)

    # Bus-message subscriptions (generic; e.g. the audio-dynamics ducker keys
    # its envelope off the sidechain `level` element).
    bus_reports = {
        (r.get("element"), r.get("structure"))
        for r in (data.get("busReports") or [])
        if r.get("element") and r.get("structure")
    }

    # librist half of a RIST module — wired BEFORE PLAYING so the appsink
    # can never see data without its handler; appsrc pushes before PLAYING
    # just FLUSH-drop (live-source semantics, satisfies the NO_PREROLL
    # invariant of the playing watchdog above).
    if not _start_rist(pipeline, data.get("rist")):
        pipeline.set_state(Gst.State.NULL)
        pipeline = None
        return

    # ts-splitter half of a ts-splitter module — same before-PLAYING wiring
    # contract as the rist block above.
    if not _start_ts_split(pipeline, data.get("tsSplit")):
        pipeline.set_state(Gst.State.NULL)
        pipeline = None
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

    # Arm the "reached PLAYING" watchdog (cancelled by the PLAYING state-change
    # on the bus). Caller may override the timeout; an explicit 0 disables it
    # (e.g. a non-live preroll path that can sit waiting for data). Note: a bare
    # `or` would treat 0 as falsy and keep the default, so test for None.
    _cancel_playing_watchdog()
    _pt = data.get("playingTimeoutMs")
    timeout_ms = PLAYING_WATCHDOG_MS if _pt is None else int(_pt)
    if timeout_ms > 0:
        playing_watchdog_id = GLib.timeout_add(timeout_ms, _on_playing_timeout)

    running = True
    emit_event({"event": "started"})

def handle_stop(data=None):
    """Stop the pipeline."""
    global pipeline, running
    _cancel_playing_watchdog()
    _clear_pending_bus_attaches()
    _stop_rist()
    _stop_ts_split()
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

# Stats reads currently running, by element name. srtsrc blocks its 'stats'
# property getter while (re)connecting; a blocked read on the main context
# would freeze every other command until it returns (RPC-timeout pile-up in
# the parent), so reads run on worker threads with at most one in flight per
# element.
stats_reads_in_flight = set()
stats_reads_lock = threading.Lock()

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

    with stats_reads_lock:
        if element_name in stats_reads_in_flight:
            emit_command_error(
                req_id, f"stats read for {element_name} still in progress (element busy)")
            return
        stats_reads_in_flight.add(element_name)

    def read_and_emit():
        try:
            stats = element.get_property("stats")
            stats_dict = gst_structure_to_dict(stats) if isinstance(stats, Gst.Structure) else {}
            result = {"event": "stats", "element": element_name, "data": stats_dict}
            if req_id:
                result["id"] = req_id
            emit_event(result)
        except Exception as e:
            emit_command_error(req_id, f"get_stats failed: {e}")
        finally:
            with stats_reads_lock:
                stats_reads_in_flight.discard(element_name)

    threading.Thread(target=read_and_emit, daemon=True,
                     name=f"stats-{element_name}").start()

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
        klv_timer_id = GLib.timeout_add(
            KLV_CAROUSEL_INTERVAL_MS, _push_klv_carousel
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


# ---------------------------------------------------------------------------
# Per-consumer bus fan-out (unixfd transport)
# ---------------------------------------------------------------------------
# A producer's bus egress is a `tee` (built by buildUdpSink); the engine's
# BusFanoutCoordinator attaches ONE `queue leaky=2 ! unixfdsink` branch per
# consumer edge at runtime. This is the isolation the shared unixfdsink lacked:
# unixfdsink sends under its object lock with blocking sockets, so a shared
# sink froze every sibling when one consumer stalled; a per-consumer branch
# with a leaky queue sheds only its own buffers, so a consumer that restarts,
# crash-loops, or stalls in preroll can never back up the producer or a sibling.
#
# Keyed by edge socket path so attach is idempotent — a re-applied connection
# or a producer-restart re-attach is a no-op when the branch already exists.
#
# Convergence design decisions (gate01 24-stream incident, 2026-07-16):
# - Edge branches are attached DYNAMICALLY only — static pre-creation in the
#   pipeline string was evaluated and rejected: unixfdsink binds its socket at
#   NULL→READY during sync_state_with_parent (verified gst 1.24 + 1.28), so a
#   dynamic attach already publishes the socket before any data flows; static
#   branches would bypass the _bus_branches idempotency (double-bind on
#   re-attach) and be invisible to bus_detach, for no latency win on the real
#   long pole (demuxer tees are pad-added, i.e. data-gated).
# - A producer respawn remains CONSUMER-pipeline-fatal by design: consumers'
#   unixfdsrc dies, and their restart goes through the (indefinite, spawn-free)
#   busSocketGate — one cheap gated respawn per consumer per real producer
#   restart, matching UDP-bus semantics. In-place unixfdsrc swap was rejected:
#   a sourceless pipeline can't hold sinks in preroll, and the added state
#   machine isn't worth ~1s on an infrequent operator action.
# - Errors INSIDE a busedge_* branch are contained (branch detached, warning
#   emitted) — see on_bus_message. A single consumer's edge failure must never
#   kill the producer; that cascade is what kept large graphs from converging.
_bus_branches = {}      # socket_path -> dict(branch, tee, tee_src, tee_name, queue, sink_pad, progressed, stall, probe_id)
# Monotonic edge-topology version: bumped on every fan-out attach/detach so
# consumers of the wired-state (the ts-splitter's wired-only gating) can
# cheaply detect changes with one int compare per buffer.
_bus_topology_version = 0
_bus_branch_seq = 0
# Edge-stall watchdog (gate01 wedge, 2026-07-16): stock unixfdsink's send
# BLOCKS forever on a connected client that stops reading (~208KB kernel
# sndbuf ≈ 60ms of a 28Mbps stream) while holding the sink object lock —
# freezing the producer's whole chain. A consumer stuck mid-startup is
# exactly such a client (unixfdsrc connects at READY, reads only at
# PLAYING). The watchdog samples each edge branch every 2s via a one-shot
# buffer probe on the unixfdsink's sink pad; a branch whose queue holds
# data but whose sink saw no buffer for 3 consecutive ticks is torn down
# and RE-CREATED in place (fresh sink, same socket path): the zombie
# client gets EOF → its runner errors → gated respawn → clean reconnect.
# Self-healing on both sides with no engine round-trip.
_BUS_STALL_TICK_MS = 2000
_BUS_STALL_TICKS = 3
_bus_stall_timer_id = None
# Per-tee input progress flags: {tee_name: {"pad": tee_sink_pad, "progressed": bool, "probe_id": id}}
# The discriminator that makes edge resets safe: an edge is reset only when
# its TEE keeps receiving data while the edge's sink delivers nothing — a
# dark/idle source (tee idle) never triggers resets, so an idle-but-healthy
# edge is left alone.
_bus_tee_progress = {}
# Attaches whose tee doesn't exist YET. The mpegts-demuxer creates its output
# tees dynamically at pad-added time (when source data flows), so on a busy
# multi-stream startup a tee can legitimately take longer than any fixed
# deadline (measured: gate01's 24-stream graph). Pending attaches therefore
# retry INDEFINITELY (bus_detach or pipeline stop cancels them) and never
# escalate to an error: an `error` event is pipeline-fatal to GstRunner, and
# killing the PRODUCER because one consumer edge isn't ready yet restart-storms
# the whole graph. One warning is emitted once per socket after ~10s so the
# wait is visible in logs.
_pending_bus_attaches = {}   # socket_path -> [tee_name, attempts_so_far]
_bus_retry_timer_id = None
_BUS_ATTACH_WARN_AFTER = 40   # ~10 s at 250 ms — log once, keep retrying
# Edges whose probe-gated teardown hasn't completed yet (see
# _teardown_bus_branch). An attach for one of these is deferred through the
# same 250 ms pending-retry path as a not-yet-created tee.
_bus_teardowns = set()

def _remove_stale_bus_socket(socket_path):
    # unixfdsink cannot bind over an existing socket file, and a runner that
    # dies hard (SIGKILL on engine stop, SIGSEGV) never unlinks its path. Edge
    # paths are deterministic, so the next attach is guaranteed to collide and
    # the producer crash-loops. Unlink only if nothing is listening — a live
    # listener means another producer owns the edge (ghost engine), and
    # binding over it must stay a loud failure, not a silent takeover.
    if not os.path.exists(socket_path):
        return
    probe = pysocket.socket(pysocket.AF_UNIX, pysocket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(socket_path)
        emit_event({"event": "warning",
                    "message": f"bus_attach: live producer already on {socket_path} — not unlinking"})
    except OSError:
        try:
            os.unlink(socket_path)
            emit_event({"event": "warning",
                        "message": f"bus_attach: unlinked stale bus socket {socket_path}"})
        except OSError:
            pass
    finally:
        probe.close()


def _try_bus_attach(tee_name, socket):
    """Attach one branch. Returns True on success, False if the tee isn't up yet."""
    global _bus_branch_seq
    if pipeline is None:
        return True
    if socket in _bus_teardowns:
        return False  # old branch still detaching — caller queues a retry
    existing = _bus_branches.get(socket)
    if existing is not None:
        # Idempotent re-attach (connection re-apply / producer-PLAYING
        # reconcile). NOT a plain no-op: an attach that landed while the
        # pipeline's own state change was in progress can leave the branch
        # stuck at READY — a bin's state cascade misses children added
        # mid-transition, and sync_state_with_parent latches whatever state
        # the parent momentarily had. A READY branch has inactive pads, so
        # the tee's first sticky-event push returns FLUSHING and the whole
        # upstream chain freezes (observed live: netsrc blocked, rx_queue
        # full, sink accepting clients but never receiving a caps event).
        # Re-syncing here lets the engine's PLAYING re-attach bump the
        # branch to the now-settled parent state.
        try:
            existing["branch"].sync_state_with_parent()
        except Exception:  # noqa: BLE001
            pass
        return True
    tee = pipeline.get_by_name(tee_name)
    if tee is None:
        return False  # tee not created yet — caller queues a retry
    _remove_stale_bus_socket(socket)
    try:
        # wait-for-connection=false is LOAD-BEARING (gate01 wedge, 2026-07-16):
        # stock unixfdsink KICKS a client on any send failure (silently — the
        # GST_ERROR goes to the disabled gst debug log), and with the default
        # wait-for-connection=true the NEXT render then blocks FOREVER on
        # wait_for_connection_cond once the client table is empty — freezing
        # the producer's whole chain (observed: netsrc rx_queue full, 2.4M
        # kernel drops, zero data on every edge). With per-consumer fan-out,
        # "no client → drop and keep flowing" is exactly the UDP-multicast
        # semantic this bus replaces; a kicked/gone consumer recovers through
        # its own busSocketGate + restart path without touching the producer.
        # 500 ms edge queue, NOT 200: a RIST-fed producer delivers in hold-and-
        # burst cycles — librist withholds ~1 RTT (measured up to ~250 ms at
        # RTT 200) while a retransmit is in flight, then releases the backlog
        # at line rate. The burst momentarily outruns the client's ~208 KB
        # kernel sndbuf, unixfdsink blocks, and a 200 ms queue overflowed and
        # shed mid-burst — corrupting PAT/PMT/media on an otherwise LOSSLESS
        # feed (measured on .211 bus 40000: 10 CC errors/min on the bus vs 1
        # on the wire, engine librist lost=0). 500 ms absorbs the worst
        # observed hold (~253 ms) with 2x headroom; memory cost is trivial
        # (≈340 KB at 5.4 Mbps). Still leaky=2 — a genuinely stalled consumer
        # must shed here, never back-pressure the producer.
        branch = Gst.parse_bin_from_description(
            "queue leaky=2 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0"
            f" ! unixfdsink socket-path={socket} sync=false async=false"
            " wait-for-connection=false",
            True,
        )
        _bus_branch_seq += 1
        branch.set_name(f"busedge_{_bus_branch_seq}")
        # Add the leaf to the tee's OWN parent bin, not the top-level pipeline:
        # the mpegts-demuxer's tee lives inside a per-pad branch bin, and linking
        # a tee request pad to an element in a different bin fails WRONG_HIERARCHY
        # (same reason _link_pad_to_branches_via_tee keeps its tee a direct child).
        parent = tee.get_parent() or pipeline
        parent.add(branch)
        # Activate the branch BEFORE linking it to the tee. The link is what
        # exposes the pad to dataflow: when an attach races the pipeline's
        # own NULL→PLAYING transition, the bin's state cascade misses a child
        # added mid-change, and the tee's first sticky-event push into the
        # still-inactive pad returns FLUSHING — which pauses the producer's
        # upstream queue task PERMANENTLY (observed live on gate01: netsrc
        # blocked, rx_queue full, edge sink accepting clients but never
        # receiving a caps event; no later state-sync can restart the paused
        # task). An unlinked branch activates trivially, so add → activate →
        # link removes the race. Target the pipeline's PENDING state —
        # sync_state_with_parent would latch the mid-transition current
        # state (READY) instead.
        _, st_cur, st_pend = pipeline.get_state(0)
        branch.set_state(st_pend if st_pend != Gst.State.VOID_PENDING else st_cur)
        tee_src = tee.request_pad_simple("src_%u")
        if tee_src is None:
            emit_event({"event": "warning", "message": f"bus_attach: no tee src pad ({tee_name})"})
            branch.set_state(Gst.State.NULL)
            parent.remove(branch)
            return True  # don't retry a structural failure
        link_ret = tee_src.link(branch.get_static_pad("sink"))
        if link_ret != Gst.PadLinkReturn.OK:
            emit_event({"event": "warning",
                        "message": f"bus_attach: link failed ({link_ret}) {socket}"})
            tee.release_request_pad(tee_src)
            branch.set_state(Gst.State.NULL)
            parent.remove(branch)
            return True
        entry = {"branch": branch, "tee": tee, "tee_src": tee_src,
                 "tee_name": tee_name, "queue": None, "sink_pad": None,
                 "progressed": False, "stall": 0, "probe_id": None}
        it2 = branch.iterate_recurse()
        while True:
            r2, el2 = it2.next()
            if r2 == Gst.IteratorResult.RESYNC:
                it2.resync()
                continue
            if r2 != Gst.IteratorResult.OK:
                break
            f2 = el2.get_factory()
            fname = f2.get_name() if f2 else ''
            if fname == 'unixfdsink':
                entry["sink_pad"] = el2.get_static_pad('sink')
            elif fname == 'queue':
                entry["queue"] = el2
        _bus_branches[socket] = entry
        globals()["_bus_topology_version"] += 1
        _arm_bus_progress_probe(entry)
        if tee_name not in _bus_tee_progress:
            tpad = tee.get_static_pad('sink')
            if tpad is not None:
                _bus_tee_progress[tee_name] = {"pad": tpad, "progressed": False, "probe_id": None}
                _arm_tee_progress_probe(_bus_tee_progress[tee_name])
        _ensure_bus_stall_timer()
        emit_event({"event": "bus_attached", "tee": tee_name, "socket": socket})
        return True
    except GLib.Error as e:
        emit_event({"event": "warning", "message": f"bus_attach parse failed: {e.message}"})
        return True


def _arm_bus_progress_probe(entry):
    """One-shot buffer probe on the edge sink's pad — sets the progress flag."""
    pad = entry.get("sink_pad")
    if pad is None or entry.get("probe_id") is not None:
        return

    def _cb(_pad, _info):
        entry["progressed"] = True
        entry["probe_id"] = None
        return Gst.PadProbeReturn.REMOVE

    entry["probe_id"] = pad.add_probe(Gst.PadProbeType.BUFFER, _cb)


def _arm_tee_progress_probe(tentry):
    """One-shot buffer probe on the tee's sink pad — 'the producer has data'."""
    if tentry.get("probe_id") is not None:
        return

    def _cb(_pad, _info):
        tentry["progressed"] = True
        tentry["probe_id"] = None
        return Gst.PadProbeReturn.REMOVE

    tentry["probe_id"] = tentry["pad"].add_probe(Gst.PadProbeType.BUFFER, _cb)


def _ensure_bus_stall_timer():
    global _bus_stall_timer_id
    if _bus_stall_timer_id is None and _bus_branches:
        _bus_stall_timer_id = GLib.timeout_add(_BUS_STALL_TICK_MS, _bus_stall_watchdog)


def _bus_stall_watchdog():
    """Detect and reset edge branches whose sink stopped draining (see the
    watchdog comment above). Never raises — a watchdog fault must not take
    the runner down."""
    global _bus_stall_timer_id
    # Snapshot per-tee progress for this tick, then re-arm the tee probes.
    tee_flowing = {}
    for tname, tentry in _bus_tee_progress.items():
        try:
            tee_flowing[tname] = tentry["progressed"]
            if tentry["progressed"]:
                tentry["progressed"] = False
                _arm_tee_progress_probe(tentry)
        except Exception:  # noqa: BLE001
            tee_flowing[tname] = False
    for socket in list(_bus_branches.keys()):
        entry = _bus_branches.get(socket)
        if entry is None:
            continue
        try:
            if entry["progressed"]:
                entry["progressed"] = False
                entry["stall"] = 0
                _arm_bus_progress_probe(entry)
                continue
            # No edge progress this tick. Only counts as a stall when the tee
            # itself IS receiving data (dark source ≠ stuck edge). The stuck
            # buffer usually sits inside the sink's blocked render (already
            # popped from the queue), so queue level can read 0 — do not gate
            # on it.
            if tee_flowing.get(entry["tee_name"], False):
                entry["stall"] += 1
                if entry["stall"] >= _BUS_STALL_TICKS:
                    tee_name = entry["tee_name"]
                    emit_event({"event": "warning",
                                "message": f"bus edge stalled (tee flowing, edge sink "
                                           f"silent {entry['stall']} ticks) — resetting {socket}"})
                    _teardown_bus_branch(socket)
                    # Teardown is probe-gated (async): queue the re-create so
                    # it lands after the old branch actually releases the
                    # socket and tee pad.
                    _attach_or_queue(tee_name, socket)
            else:
                entry["stall"] = 0
        except Exception:  # noqa: BLE001
            pass
    if not _bus_branches:
        for tentry in _bus_tee_progress.values():
            try:
                if tentry.get("probe_id") is not None:
                    tentry["pad"].remove_probe(tentry["probe_id"])
            except Exception:  # noqa: BLE001
                pass
        _bus_tee_progress.clear()
        _bus_stall_timer_id = None
        return False
    return True

def _retry_pending_bus_attaches():
    global _bus_retry_timer_id
    for socket in list(_pending_bus_attaches.keys()):
        tee_name, attempts = _pending_bus_attaches[socket]
        if _try_bus_attach(tee_name, socket):
            _pending_bus_attaches.pop(socket, None)
        else:
            attempts += 1
            if attempts == _BUS_ATTACH_WARN_AFTER:
                emit_event({"event": "warning",
                            "message": f"bus_attach: tee {tee_name} not up yet for {socket} — still retrying"})
            _pending_bus_attaches[socket] = [tee_name, attempts]
    if not _pending_bus_attaches:
        _bus_retry_timer_id = None
        return False   # stop the timer
    return True

def _attach_or_queue(tee_name, socket):
    """Attach now, or queue the persistent 250 ms retry (tee not created yet,
    or the edge's previous branch is still mid-teardown)."""
    global _bus_retry_timer_id
    if _try_bus_attach(tee_name, socket):
        _pending_bus_attaches.pop(socket, None)
        return
    _pending_bus_attaches[socket] = [tee_name, 0]
    if _bus_retry_timer_id is None:
        _bus_retry_timer_id = GLib.timeout_add(250, _retry_pending_bus_attaches)


def handle_bus_attach(data):
    """Attach a per-consumer fan-out branch to a producer's egress tee."""
    tee_name = data.get("tee", "")
    socket = data.get("socket", "")
    if not tee_name or not socket:
        return
    _attach_or_queue(tee_name, socket)


def _clear_pending_bus_attaches():
    _pending_bus_attaches.clear()
    _bus_teardowns.clear()


def _teardown_bus_branch(socket):
    """Tear down one fan-out branch by edge socket. Returns True if it existed.

    Shared by `bus_detach` (engine-driven), the on_bus_message busedge error
    containment, and the stall watchdog's in-place edge reset.

    Teardown happens BEHIND A BLOCKING PAD PROBE on the tee src pad — the
    canonical dynamic-unlink recipe. The producer pushes from its own
    streaming thread; deactivating the branch mid-push (the old order:
    NULL → unlink → release) makes that in-flight push return FLUSHING,
    which silently pauses the producer's basesrc task FOREVER — no bus
    error, appsrc queue pins at max-bytes with leaky-drop, every edge on
    the bus goes dark until the module restarts. That is exactly what
    killed the live RIST producer when a consumer module was restarted
    (.211, 2026-07-16 21:37). Reproduced 5/5 at ~500 pkt/s with the naked
    teardown; 5/5 clean with this probe (repro5.py, 2026-07-17).
    BLOCK_DOWNSTREAM intercepts between buffers when flowing; IDLE fires
    immediately when the pad is quiet, so a dark producer detaches at once.

    The actual teardown is therefore ASYNCHRONOUS. `_bus_teardowns` marks
    the edge until the probe fires; `_try_bus_attach` treats a mid-teardown
    socket as "not ready yet" (returns False → caller's 250 ms retry), so
    a fast detach→attach on the same edge path can't bind over the dying
    branch's socket or double-request the tee pad.
    """
    # Cancel a not-yet-satisfied attach for this edge, if any.
    _pending_bus_attaches.pop(socket, None)
    entry = _bus_branches.pop(socket, None)
    if entry is None:
        return False
    globals()["_bus_topology_version"] += 1
    branch, tee, tee_src = entry["branch"], entry["tee"], entry["tee_src"]
    try:
        # Drop a pending progress probe so its closure can't fire on a pad of
        # a removed branch.
        if entry.get("probe_id") is not None and entry.get("sink_pad") is not None:
            entry["sink_pad"].remove_probe(entry["probe_id"])
            entry["probe_id"] = None
    except Exception:  # noqa: BLE001
        pass

    def _finish(pad, _info):
        # Runs with the tee src pad blocked (or idle): the producer's
        # streaming thread cannot be inside this branch anymore.
        try:
            peer = pad.get_peer()
            if peer is not None:
                pad.unlink(peer)
            branch.set_state(Gst.State.NULL)
            parent = branch.get_parent()
            if parent is not None:
                parent.remove(branch)
            # unixfdsink does not unlink its socket file on NULL; remove it so
            # a later attach on this edge doesn't hit the stale-file bind
            # failure.
            try:
                os.unlink(socket)
            except OSError:
                pass
            # Release the request pad from the main loop, not from its own
            # probe (validated in repro5; avoids re-entering the tee under
            # the probe's pad lock).
            GLib.idle_add(_release_tee_pad, tee, pad)
            emit_event({"event": "bus_detached", "socket": socket})
        except Exception:  # noqa: BLE001 — teardown must never crash the runner
            pass
        finally:
            _bus_teardowns.discard(socket)
        return Gst.PadProbeReturn.REMOVE

    _bus_teardowns.add(socket)
    try:
        tee_src.add_probe(
            Gst.PadProbeType.BLOCK_DOWNSTREAM | Gst.PadProbeType.IDLE, _finish)
    except Exception:  # noqa: BLE001 — pad already dead: fall back to direct teardown
        _bus_teardowns.discard(socket)
        try:
            branch.set_state(Gst.State.NULL)
            parent = branch.get_parent()
            if parent is not None:
                parent.remove(branch)
            try:
                os.unlink(socket)
            except OSError:
                pass
            emit_event({"event": "bus_detached", "socket": socket})
        except Exception:  # noqa: BLE001
            pass
    return True


def _release_tee_pad(tee, pad):
    try:
        tee.release_request_pad(pad)
    except Exception:  # noqa: BLE001
        pass
    return False  # one-shot idle source


def _busedge_ancestor(obj):
    """Nearest `busedge_*` fan-out branch bin above a message source, or None."""
    while obj is not None:
        try:
            name = obj.get_name() or ''
        except Exception:  # noqa: BLE001 — never let attribution crash the bus watch
            return None
        if name.startswith('busedge_'):
            return obj
        obj = obj.get_parent()
    return None


def _socket_for_busedge(edge_bin):
    """Reverse-lookup the edge socket path owning a busedge branch bin."""
    for sock, entry in _bus_branches.items():
        if entry["branch"] is edge_bin:
            return sock
    return None


def handle_bus_detach(data):
    """Detach and tear down a per-consumer fan-out branch by edge socket."""
    _teardown_bus_branch(data.get("socket", ""))


# ---------------------------------------------------------------------------
# librist integration (rist-input / rist-output as native gst modules)
#
# The RIST plugins used to spawn the ristreceiver/ristsender CLI and relay
# through a loopback UDP socket. Driving librist in-process instead moves
# payloads straight between librist and a named appsrc/appsink, so RIST
# modules ride the same bus transport as every other gst module (tee fan-out
# under unixfd) with no intermediate datagram hop. See librist.py (same dir)
# for the ctypes binding and its ABI-stability strategy.
# ---------------------------------------------------------------------------
_rist_ctx = None          # librist.RistReceiver | librist.RistSender
_rist_thread = None       # receiver push loop (daemon)
_rist_stop = threading.Event()

# 7 x 188 — the classic TS-over-datagram unit. Sender payloads are re-chunked
# to this so a large bus buffer (mpegtsmux with wide alignment) never exceeds
# what a RIST datagram carried under the old CLI relay. Buffers on this bus
# are 188-aligned by caps, so 1316-byte slices stay packet-aligned.
_RIST_WRITE_CHUNK = 1316


def _rist_log(_level, msg):
    # librist logs arrive on librist's own threads; plain stderr lines join
    # the runner's debug stream without touching the JSON event channel.
    sys.stderr.write(f"[librist] {msg}\n")


def _on_rist_stats(stats_json):
    # Called on a librist thread — emit_event is thread-safe (event_lock).
    # Same JSON shape the CLI printed on stderr ({"receiver-stats":...} /
    # {"sender-stats":...}), so the plugin's parser carries over unchanged.
    try:
        payload = json.loads(stats_json)
    except (json.JSONDecodeError, ValueError):
        return
    emit_plugin_event("rist:stats", payload)


def _start_rist(pipe, cfg):
    """Bring up the librist half of a RIST module pipeline.

    Returns True when no rist config is present or librist is up; on failure
    emits an `error` event (the parent's restart/backoff path applies) and
    returns False so handle_start can abort the pipeline.
    """
    global _rist_ctx, _rist_thread
    if not cfg:
        return True
    try:
        import librist
    except Exception as e:  # noqa: BLE001 — a missing/broken .so must fail loudly
        emit_event({"event": "error", "message": f"librist unavailable: {e}"})
        return False

    role = cfg.get("role", "")
    urls = cfg.get("urls") or []
    element_name = cfg.get("appElement", "")
    element = pipe.get_by_name(element_name)
    if not element or not urls or role not in ("receiver", "sender"):
        emit_event({
            "event": "error",
            "message": (f"rist config invalid (role={role!r}, element="
                        f"{element_name!r} found={bool(element)}, {len(urls)} url(s))"),
        })
        return False

    profile = int(cfg.get("profile", 1))
    buffer_ms = cfg.get("buffer")
    secret = cfg.get("secret") or None
    enc_type = cfg.get("encType")
    stats_ms = int(cfg.get("statsInterval", 1000))

    ctx = None
    try:
        lib_ver, api_ver = librist.versions()
        sys.stderr.write(
            f"[gst-runner.py] librist {lib_ver} (API {api_ver}) "
            f"role={role} peers={len(urls)} element={element_name}\n")
        if role == "receiver":
            ctx = librist.RistReceiver(profile=profile, log_fn=_rist_log)
        else:
            ctx = librist.RistSender(profile=profile, log_fn=_rist_log,
                                     npd=bool(cfg.get("npd")))
        for url in urls:
            ctx.add_peer(librist.augment_url(
                url, buffer_ms=buffer_ms, secret=secret, aes_type=enc_type))
        if stats_ms > 0:
            ctx.set_stats_callback(stats_ms, _on_rist_stats)

        if role == "receiver":
            _rist_stop.clear()

            def _push_loop():
                # Blocking read releases the GIL; appsrc push-buffer is
                # thread-safe. A push before PLAYING / during teardown returns
                # FLUSHING and the buffer drops — live-source semantics,
                # exactly what udpsrc did under the CLI relay.
                while not _rist_stop.is_set():
                    try:
                        data = ctx.read(100)
                    except librist.RistError as e:
                        emit_event({"event": "warning",
                                    "message": f"librist read failed: {e}"})
                        break
                    if not data:
                        continue
                    try:
                        element.emit("push-buffer", Gst.Buffer.new_wrapped(data))
                    except Exception:  # noqa: BLE001 — teardown race
                        pass

            _rist_thread = threading.Thread(
                target=_push_loop, daemon=True, name="rist-reader")
        else:
            # appsink → librist. Properties are set here (not in the pipeline
            # string) so the drain contract can't drift: bounded + dropping +
            # unsynced. data_write only copies into librist's own buffers, so
            # the streaming thread is never held hostage.
            element.set_property("emit-signals", True)
            element.set_property("sync", False)
            element.set_property("max-buffers", 64)
            element.set_property("drop", True)

            def _on_sample(sink):
                smp = sink.emit("pull-sample")
                if not smp:
                    return Gst.FlowReturn.OK
                buf = smp.get_buffer()
                ok, mi = buf.map(Gst.MapFlags.READ)
                if not ok:
                    return Gst.FlowReturn.OK
                try:
                    data = bytes(mi.data)
                    for off in range(0, len(data), _RIST_WRITE_CHUNK):
                        ctx.write(data[off:off + _RIST_WRITE_CHUNK])
                except librist.RistError:
                    pass  # transient send failure — recovery is librist's job
                finally:
                    buf.unmap(mi)
                return Gst.FlowReturn.OK

            element.connect("new-sample", _on_sample)

        ctx.start()
        _rist_ctx = ctx
        if _rist_thread is not None:
            _rist_thread.start()
        return True
    except librist.RistError as e:
        emit_event({"event": "error", "message": f"librist start failed: {e}"})
        if ctx is not None:
            try:
                ctx.destroy()
            except Exception:  # noqa: BLE001
                pass
        return False


def _stop_rist():
    global _rist_ctx, _rist_thread
    _rist_stop.set()
    if _rist_thread is not None:
        _rist_thread.join(timeout=2)
        _rist_thread = None
    if _rist_ctx is not None:
        # destroy() joins librist's threads — no stats/log/data callback can
        # fire after it returns, so dropping the refs is safe.
        try:
            _rist_ctx.destroy()
        except Exception:  # noqa: BLE001 — teardown must never crash the runner
            pass
        _rist_ctx = None


# ---------------------------------------------------------------------------
# ts-splitter integration (packet-level per-PID SPTS outputs)
#
# The ts-splitter plugin's pipeline is `<bus src> ! appsink` plus one
# `appsrc ! <bus sink>` chain per PID output. This glue drains the appsink on
# its streaming thread, routes packets in a single pass (ts_split.SplitterCore)
# and pushes one joined buffer per (input buffer, output) — packet-level
# pass-through, so output cadence equals ingest cadence (no PES assembly, no
# demuxer hold-and-burst). See ts_split.py for the core's contract.
# ---------------------------------------------------------------------------
_ts_split = None          # {"core": SplitterCore, "appsrcs": {pid: element}} while active


def _start_ts_split(pipe, cfg):
    """Bring up the ts-splitter half of a ts-splitter module pipeline.

    Returns True when no tsSplit config is present or the splitter is wired;
    on failure emits an `error` event (the parent's restart/backoff path
    applies) and returns False so handle_start can abort the pipeline.
    """
    global _ts_split
    if not cfg:
        return True
    try:
        import ts_split
    except Exception as e:  # noqa: BLE001 — a missing core must fail loudly
        emit_event({"event": "error", "message": f"ts_split unavailable: {e}"})
        return False

    appsink = pipe.get_by_name(cfg.get("inputAppsink", ""))
    if appsink is None:
        emit_event({"event": "error",
                    "message": f"tsSplit: input appsink not found: {cfg.get('inputAppsink')!r}"})
        return False
    appsrcs = {}
    outputs = []
    # Wired-only gating map: pid -> busout tee name, for outputs whose egress
    # tee exists in this pipeline (unixfd transport). Such an output is
    # produced only while its tee has >= 1 attached fan-out edge — an unwired
    # pin is discarded at the routing lookup (no PSI rewrite, no join, no
    # push). Outputs without a port, or whose tee is absent (UDP transport:
    # fixed udpsink, no fan-out), stay always-on.
    gated = {}
    for out in cfg.get("outputs") or []:
        el = pipe.get_by_name(out.get("appsrc", ""))
        if el is None:
            emit_event({"event": "error",
                        "message": f"tsSplit: output appsrc not found: {out.get('appsrc')!r}"})
            return False
        pid = int(out["pid"])
        appsrcs[pid] = el
        outputs.append((pid, out.get("streamType")))
        port = out.get("port")
        if port is not None and pipe.get_by_name(f"busout_{int(port)}") is not None:
            gated[pid] = f"busout_{int(port)}"
    # Empty outputs is valid: the input-only pipeline still runs discovery so
    # the module can learn the source's PIDs before any port is wired.

    def _on_discovered(streams, pcr_pid):
        # Called from the appsink streaming thread — emit_event is
        # lock-protected (same precedent as the librist stats callback).
        emit_plugin_event("tssplit:discovered", {
            "streams": [{"pid": p, "streamType": t} for p, t in streams],
            "pcrPid": pcr_pid,
        })

    def _on_desync(dropped):
        emit_event({"event": "warning",
                    "message": f"tsSplit: resynced after {dropped} garbage bytes"})

    core = ts_split.SplitterCore(int(cfg.get("tsId", 1)), outputs,
                                 on_discovered=_on_discovered,
                                 on_desync=_on_desync)

    # Drain contract set here, not in the pipeline string, so it can't drift.
    # drop=False (unlike the rist sender): this feeds the lossless local bus,
    # and the routing callback is ~1% core — overflow should back-pressure
    # into the upstream LEAKY ingress queue (the bus's universal shed point),
    # never silently vanish at a hidden 64-buffer cliff here.
    appsink.set_property("emit-signals", True)
    appsink.set_property("sync", False)
    # async=false: keep the appsink OUT of preroll. Without it the pipeline
    # wedges in PAUSED until the first buffer arrives (verified gst 1.22) —
    # a dark upstream would then hit the PLAYING watchdog and restart-loop,
    # exactly the demuxer failure mode this module exists to avoid.
    appsink.set_property("async", False)
    appsink.set_property("max-buffers", 64)
    appsink.set_property("drop", False)

    # Wired-state cache for the gating check: one int compare per buffer in
    # steady state; the enabled set is recomputed only when an edge attaches
    # or detaches (_bus_topology_version bumps on the GLib main loop; a
    # briefly stale read here self-heals on the next buffer).
    gate_state = {"ver": -1}

    def _refresh_gate():
        gate_state["ver"] = _bus_topology_version
        active = {e["tee_name"] for e in _bus_branches.values()}
        enabled = [p for p in appsrcs
                   if p not in gated or gated[p] in active]
        core.set_enabled(enabled)

    def _on_sample(sink):
        smp = sink.emit("pull-sample")
        if not smp:
            return Gst.FlowReturn.OK
        if gated and gate_state["ver"] != _bus_topology_version:
            _refresh_gate()
        buf = smp.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            data = bytes(mi.data)   # one copy; feed()'s memoryviews point at THIS
        finally:
            buf.unmap(mi)
        # push-buffer never blocks (appsrc block=false default; each output
        # appsrc is bounded by leaky-type=downstream in the pipeline string),
        # so routing in-callback cannot deadlock the input streaming thread.
        for pid, payload in core.feed(data).items():
            try:
                appsrcs[pid].emit("push-buffer", Gst.Buffer.new_wrapped(payload))
            except Exception:  # noqa: BLE001 — teardown race
                pass
        return Gst.FlowReturn.OK

    appsink.connect("new-sample", _on_sample)
    _ts_split = {"core": core, "appsrcs": appsrcs}
    return True


def _stop_ts_split():
    # No threads to join: all splitter work rides the appsink streaming
    # thread, which the pipeline's NULL transition stops. A runner-internal
    # respawn replays the same start payload, so state rebuilds itself.
    global _ts_split
    _ts_split = None


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
    "bus_attach": handle_bus_attach,
    "bus_detach": handle_bus_detach,
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
