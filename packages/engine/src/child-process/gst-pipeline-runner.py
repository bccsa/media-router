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
import socket as pysocket
import sys
import threading
import time

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

Gst.init([])  # [] not None: None breaks under pygobject < 3.48 with gst 1.28 typelibs

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


# EOS drain before teardown. Taking a PLAYING pipeline straight to NULL issues
# STREAMOFF on whatever the decoder is doing right now — and the Pi's stateless
# HEVC decoder (rpi-hevc-dec, kernel 6.12) cannot survive that: stopping it
# MID-DECODE wedges hevc_d_stop_streaming → __vb2_queue_cancel in an
# uninterruptible wait for a hardware completion that never arrives, while it
# holds the videodev mutex. Every later V4L2 open/close then piles up in D
# state and the box needs a power cycle (field incident, Pi 400, 2026-08 — the
# codec-aware player rebuilds its pipeline on a codec switch, so every switch
# stopped an actively-decoding pipeline). The driver has no timeout in its stop
# path, so userspace can only avoid arming the bug: send EOS first and let the
# decoder finish and flush its in-flight frame, so STREAMOFF lands on an idle
# decoder.
#
# The wait is BOUNDED but not short: a pipeline that has not reached EOS by then
# is set to NULL anyway. Waiting forever would leak runner processes, and a
# driver that is already hung cannot be helped from userspace.
#
# WHY 6 s and not the original 1.5 s: EOS has to travel the whole pipeline and
# be posted on the bus, and the bootstrap decodebin3 chain buffers seconds of
# data (multiqueue plus the ~1 s jitter/leaky queues), so the message routinely
# needs several seconds to arrive. At 1.5 s the cap fired first, NULL landed
# mid-decode and STREAMOFF hung forever in the Pi 4's hevc_d_h265_stop — exactly
# the bug this drain exists to avoid (syscall-level capture, Pi 400, 2026-08; a
# manual `gst-launch -e` stop, which waits for EOS unbounded, tears the same
# stream down cleanly on the same box).
#
# LOAD-BEARING BUDGET: this must stay comfortably below every parent-side
# force-kill window, or the drain gets SIGKILLed halfway and we are back to a
# mid-decode teardown. Those windows are PythonProcess.stop's kill timer,
# GstRunner.shutdown's SIGKILL/exit timers and GstChildProcess.stop's SIGKILL
# timer — all >= 8000 ms, pinned by eosDrainContract.test.ts.
EOS_DRAIN_TIMEOUT_MS = 6000


def _drain_decoder_branch(deadline):
    """Push EOS straight into the decoder when the whole-pipeline drain can't.

    THE CASE THIS COVERS. An ERRORED pipeline cannot be drained end to end: the
    source element's task is already stopped, so a pipeline-level EOS is queued
    behind a task that will never run again (`GstBaseSrc` pushes a pending EOS
    from its streaming thread) and the bus wait just burns its whole budget
    before NULL lands MID-DECODE — the STREAMOFF hang this drain exists to avoid
    (field: `phase1_cb: Post wait: 0xffffffff`, Pi 400, 2026-08). Every bus
    disconnect used to take exactly that path, because the consumer always dies
    by `unixfdsrc` ERROR first.

    THE DRAIN. The decoder is reachable without the source: `keyframeGate`
    already resolved its SINK pad by name, and sending EOS to that pad hands the
    event to the decoder directly. `GstVideoDecoder` finishes its pending frames
    inside that call, so by the time it returns the decoder is idle and NULL is
    safe. Nothing downstream needs waiting for — the hazard is the decoder, not
    the sink.

    The send runs on a worker thread with a bounded join, because the one case
    where the decoder cannot finish (already-wedged hardware) is exactly the one
    that would block the main loop past the parent's force-kill window. A
    blocked send is left to its daemon thread and reported; the caller sets NULL
    anyway, which is no worse than today's behaviour on that pipeline.

    Returns True when the decoder accepted (and therefore drained) the EOS.
    """
    st = _keyframe_gate
    if not st:
        # No gated decoder = nothing addressable to drain (the `decodebin3`
        # bootstrap rung plugs its own decoder, so there is no element name).
        return False
    pad, name = st["pad"], st["decoder"]
    done = threading.Event()

    def _send():
        try:
            pad.send_event(Gst.Event.new_eos())
        finally:
            done.set()

    threading.Thread(target=_send, name="eos-branch-drain", daemon=True).start()
    if not done.wait(max(0.0, deadline - time.monotonic())):
        emit_event({"event": "warning",
                    "message": f"EOS drain: {name} did not accept EOS within "
                               f"{EOS_DRAIN_TIMEOUT_MS} ms — forcing NULL "
                               f"(decoder may be mid-frame)"})
        return False
    return True


def _eos_drain(pipe, errored=False):
    """EOS-drain `pipe` so its decoder is idle before we stop it.

    Only pipelines that are actually running are drained: a NULL/READY (or
    stalled-in-PAUSED) pipeline has nothing in flight, and a preroll-only
    pipeline still counts (a stateless decoder decodes its preroll frame), so
    the pending state is checked too.

    `errored=True` (the bus ERROR handler) skips the pipeline-level EOS: it
    cannot travel a pipeline whose source has already failed, so we go straight
    to the decoder branch — see `_drain_decoder_branch`.

    Returns True when the pipeline drained (or had nothing to drain), False on
    timeout — the caller sets NULL either way.
    """
    _ret, state, pending = pipe.get_state(0)
    if state != Gst.State.PLAYING and pending != Gst.State.PLAYING:
        return True

    # One budget for the whole drain, however many attempts it takes: the
    # branch drain runs on what the pipeline-level attempt left behind, so a
    # teardown can never cost more than EOS_DRAIN_TIMEOUT_MS in total (the
    # invariant that keeps it under the parent's force-kill window).
    deadline = time.monotonic() + EOS_DRAIN_TIMEOUT_MS / 1000.0

    if errored or not pipe.send_event(Gst.Event.new_eos()):
        return _drain_decoder_branch(deadline)

    # `timed_pop_filtered` pops straight off the bus queue. Every caller runs on
    # the main-loop thread (command handlers and signal handlers go through
    # GLib.idle_add), so the signal watch installed at start cannot race us for
    # the message. ERROR ends the wait too — a pipeline that just failed will
    # never reach EOS, so that message hands us over to the branch drain
    # instead of being reported as "drained".
    msg = pipe.get_bus().timed_pop_filtered(
        int(max(0.0, deadline - time.monotonic()) * Gst.SECOND),
        Gst.MessageType.EOS | Gst.MessageType.ERROR,
    )
    if msg is None:
        emit_event({"event": "warning",
                    "message": f"EOS drain timed out after {EOS_DRAIN_TIMEOUT_MS} ms — "
                               f"forcing NULL (decoder may be mid-frame)"})
        return False
    if msg.type == Gst.MessageType.ERROR:
        return _drain_decoder_branch(deadline)
    return True


def _teardown_pipeline(pipe, drain=True, errored=False):
    """Take `pipe` to NULL, EOS-draining it first (see EOS_DRAIN_TIMEOUT_MS).

    Every path that stops the pipeline goes through here. `drain=False` is for
    callers that already know the stream ended (the bus EOS handler): sending a
    second EOS would just burn the whole timeout waiting for a message that
    cannot come again. `errored=True` is the bus ERROR handler telling the drain
    that the pipeline-level EOS is already dead in the water.
    """
    if pipe is None:
        return
    if drain:
        _eos_drain(pipe, errored=errored)
    pipe.set_state(Gst.State.NULL)


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
    _teardown_pipeline(pipeline)
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
        # A `watchdog` element inserted by buildBusSrc's stallTimeoutMs
        # (named `buswd_*`) firing means the bus source is silent but
        # connected. Tag the error so modules can treat source-silent
        # differently from a hard failure (e.g. video-player's colour-bars
        # fallback) — the unixfd equivalent of `GstUDPSrcTimeout` below.
        if element.startswith("buswd"):
            emit_event({"event": "error", "kind": "bus_stall",
                        "message": str(err.message),
                        "debug": debug or "", "element": element})
        else:
            emit_event({"event": "error", "message": str(err.message),
                        "debug": debug or "", "element": element})
        # Stop the pipeline on error. `errored`: the source that just failed
        # can no longer carry a pipeline-level EOS, so the drain goes straight
        # at the decoder instead of burning its budget (see _eos_drain).
        _teardown_pipeline(pipeline, errored=True)
        if loop and loop.is_running():
            loop.quit()

    elif t == Gst.MessageType.EOS:
        emit_event({"event": "eos"})
        # Already drained by definition — EOS reached the sinks, so the decoder
        # is idle and a second EOS would only stall the teardown.
        _teardown_pipeline(pipeline, drain=False)
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
        if name in ("mrtsstamp-anchor", "mrtsstamp-reanchor",
                    "mrtsstamp-segment-warning"):
            # The native egress stamper reports through the bus (it has no other
            # way home). Translated here into the SAME engine events the python
            # probe emits — identical field names, identical message text — so
            # which backend stamped is invisible to everything downstream.
            gst_bus_stamper.handle_message(src_name, name, structure)
        elif name and src_name and (src_name, name) in bus_reports:
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
            _teardown_pipeline(pipeline)
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


# ---------------------------------------------------------------------------
# preserveSourceTimeline — carry the SOURCE PES timeline through a tsdemux
# ---------------------------------------------------------------------------
# tsdemux erases the source timeline (buffer PTS rebased ~0 on an identity
# segment), so everything downstream — including this pipeline's own output
# mpegtsmux — stamps a fresh per-incarnation timeline. Downstream muxers then
# anchor A/V branches by ARRIVAL, and every restart re-rolls lipsync (the
# 2026-07-23 incident; TodoNotes:20). This opt-in feature latches the first
# PES PTS per PID on the demux SINK pad, then shifts each media src pad onto
# the source timeline via GstPad.set_offset() so output PES PTS/PCR carry
# source values. Restart ⇒ re-latch ⇒ same timeline. Mid-stream source
# discontinuities and the 26.5 h PTS wrap are NOT followed (plan non-goals) —
# the offset is per-incarnation, exactly like today's anchor.
_preserve_timeline = None   # {"latch", "sink_pad", "sink_probe_id", "pending"}


def _clear_preserve_timeline():
    global _preserve_timeline
    _preserve_timeline = None


def _install_preserve_timeline(pipe, cfg):
    """cfg = {"demux": "<element name>"} from the pipeline description."""
    global _preserve_timeline
    _clear_preserve_timeline()
    if not cfg:
        return
    demux_name = cfg.get("demux")
    demux = pipe.get_by_name(demux_name) if demux_name else None
    if not demux:
        sys.stderr.write(
            f"[gst-runner.py] preserveSourceTimeline: element "
            f"'{demux_name}' not found — feature disabled for this run\n")
        return
    import ts_timeline  # lazy, pure stdlib (embedded-core pattern)

    state = {"latch": ts_timeline.TimelineLatch(),
             "sink_pad": demux.get_static_pad("sink"),
             "sink_probe_id": None,
             "pending": 0,       # armed src pads still awaiting their offset
             "attempts": {},     # per-PID unlatched-buffer retry counts
             "watch": False,     # post-latch discontinuity watch active
             "last": {},         # per-PID last COHERENT PES PTS (watch mode)
             "proposed": {},     # per-PID epoch its last anomaly proposed
             "anom": 0,          # consecutive anomalous buffers
             "nbuf": 0,          # buffer stride counter (watch samples 1-in-8)
             "fired": False}
    _preserve_timeline = state

    # Post-latch discontinuity watch: a genuine mid-stream source PTS jump
    # (upstream encoder restart, playout switch) stales every latched offset
    # and silently re-rolls downstream A/V pairing. Anything past the
    # stamper's thresholds is a REAL discontinuity: emit a `timeline_discont`
    # pipeline error and let the normal restartOnError path rebuild + re-latch
    # within seconds. Sampled 1-in-8 buffers.
    #
    # The RULE is `TimelineStamper`'s, not a copy of it: `_delta` (wrap-folded,
    # so a legal 2^33 crossing reads as the tiny step it is) and `_coherent`
    # come from the module that defines the contract, and the thresholds with
    # them. This path had carried its own copy of the OLD, defective rule —
    # reference advanced ACROSS the anomaly, one anomaly counted per buffer,
    # nothing but the cross-PID count to confirm with — which is exactly the
    # 2026-08-13 field bug fixed in the stamper: a single-PID source that loops
    # reports one anomaly, comes back coherent from the epoch it jumped to, and
    # never fires. Under the time-sync contract this whole feature is dropped
    # (GstPluginBase.applyTimeSync), so what is fixed here is the LEGACY
    # transcoder path — which is precisely where a stale offset still costs a
    # re-rolled lipsync.
    _WATCH_STRIDE = 8
    _CONFIRM = ts_timeline.TimelineStamper._CONFIRM

    def watch_scan(data):
        for pkt in ts_timeline.iter_packets(data):
            if not (pkt[1] & 0x40):
                continue
            pts = ts_timeline.read_pes_pts(pkt)
            if pts is None:
                continue
            pid = ts_timeline.ts_pid(pkt)
            lastp = state["last"].get(pid)
            if lastp is None:
                state["last"][pid] = pts
                continue
            if ts_timeline.TimelineStamper._coherent(pts, lastp):
                # Continues from the pre-jump reference, so whatever it
                # proposed before was an outlier: advance and forget it.
                state["last"][pid] = pts
                state["proposed"].pop(pid, None)
                continue
            state["anom"] += 1
            cand = state["proposed"].get(pid)
            state["proposed"][pid] = pts
            # Two ways to confirm, either sufficient: the SAME PID coming back
            # coherent from the epoch its last anomaly proposed (the only path
            # a single-PID stream has), or `_CONFIRM` consecutive anomalous
            # buffers whichever PIDs reported them (a muxed source, where the
            # second PID confirms a buffer later). The reference is deliberately
            # NOT advanced here, so a merely glitched PID can come back to it.
            confirmed = (cand is not None
                         and ts_timeline.TimelineStamper._coherent(pts, cand))
            if (confirmed or state["anom"] >= _CONFIRM) and not state["fired"]:
                d = ts_timeline.TimelineStamper._delta(pts, lastp)
                state["fired"] = True
                emit_event({
                    "event": "error",
                    "kind": "timeline_discont",
                    "message": (
                        f"source timeline discontinuity on pid 0x{pid:x}"
                        f" ({lastp} -> {pts}, {d / 90000.0:+.2f}s) — "
                        f"restarting pipeline to re-latch"),
                })
            return
        state["anom"] = 0

    def on_sink_buffer(_pad, info):
        buf = info.get_buffer()
        if buf is None or state["fired"]:
            return Gst.PadProbeReturn.OK
        if state["watch"]:
            state["nbuf"] += 1
            if state["nbuf"] % _WATCH_STRIDE:
                return Gst.PadProbeReturn.OK
        ok, mi = buf.map(Gst.MapFlags.READ)
        if ok:
            try:
                data = bytes(mi.data)
            finally:
                buf.unmap(mi)
            state["latch"].feed(data)     # latch-once per PID; cheap when done
            if state["watch"]:
                watch_scan(data)
        return Gst.PadProbeReturn.OK

    def maybe_release_sink_probe():
        # All armed pads resolved → switch the sink probe from full-rate
        # latching into the sampled discontinuity watch (kept for the life of
        # the pipeline; ~1-in-8 buffers pay a header scan).
        if state["pending"] == 0 and not state["watch"]:
            state["watch"] = True
            sys.stderr.write(
                "[gst-runner.py] preserveSourceTimeline: all pads shifted — "
                "watching for source discontinuities\n")

    def on_first_buffer(pad, info, pid):
        buf = info.get_buffer()
        if buf is None:
            # Non-buffer item on a BLOCK|BUFFER probe — let it through and
            # stay armed (returning OK would keep the pad blocked forever).
            return Gst.PadProbeReturn.PASS
        pts = buf.pts
        if pts == Gst.CLOCK_TIME_NONE:
            # A PTS-less leading buffer (e.g. codec headers mid-resync): pass
            # it through and keep waiting for the first STAMPED buffer — giving
            # up here would run the whole incarnation un-shifted (seen live
            # 2026-07-23 during the swap-starvation churn).
            return Gst.PadProbeReturn.PASS
        off = state["latch"].offset_ns(pid, pts)
        if off is None:
            # Latch hasn't seen a PES PTS for this PID yet (e.g. the leading
            # PES carried none). Pass and retry on subsequent buffers, bounded
            # so a pathological stream can't pay probe overhead forever.
            state["attempts"][pid] = state["attempts"].get(pid, 0) + 1
            if state["attempts"][pid] < 300:
                return Gst.PadProbeReturn.PASS
            state["pending"] -= 1
            sys.stderr.write(
                f"[gst-runner.py] preserveSourceTimeline: PID 0x{pid:x} never "
                f"latched a source PTS — pad {pad.get_name()} left un-shifted\n")
            maybe_release_sink_probe()
            return Gst.PadProbeReturn.REMOVE
        state["pending"] -= 1
        pad.set_offset(off)
        sys.stderr.write(
            f"[gst-runner.py] preserveSourceTimeline: {pad.get_name()} "
            f"pid=0x{pid:x} offsetNs={off} (sourcePts90k="
            f"{state['latch'].first_pts.get(pid)} firstBufPtsNs={pts})\n")
        maybe_release_sink_probe()
        return Gst.PadProbeReturn.REMOVE

    def on_demux_pad_added(_element, pad):
        name = pad.get_name() or ""
        if not (name.startswith("audio_") or name.startswith("video_")):
            return
        pid = _pid_from_tsdemux_pad_name(name)
        if pid is None:
            sys.stderr.write(
                f"[gst-runner.py] preserveSourceTimeline: no PID in pad name "
                f"'{name}' — pad left un-shifted\n")
            return
        state["pending"] += 1
        # BLOCK|BUFFER: the callback runs with the pad blocked BEFORE the
        # first buffer passes, so the recomputed segment (set_offset) reaches
        # downstream ahead of that buffer. Validated on the rig (plan gate 1).
        pad.add_probe(Gst.PadProbeType.BLOCK | Gst.PadProbeType.BUFFER,
                      on_first_buffer, pid)

    state["sink_probe_id"] = state["sink_pad"].add_probe(
        Gst.PadProbeType.BUFFER, on_sink_buffer)
    demux.connect("pad-added", on_demux_pad_added)


# ---------------------------------------------------------------------------
# alignBranchesToStamps — anchor a mux's input branches to the PRODUCER'S STAMPS
# ---------------------------------------------------------------------------
# THE DEFECT (measured on the .202 X-Chain rig, 2026-08-14). A multi-input mux
# gives each input its own `tsdemux`, and every branch works out its own zero
# point: tsdemux slaves the PES timeline it emits to the timestamp of the bus
# buffer it locked on. Under the time-sync contract that timestamp is the
# producer's house-clock STAMP, so the branch is right whenever that one stamp
# was exact — and wrong by however much it was NOT, for the whole incarnation.
#
# It is not exact on a REORDERED stream. The stamp is `anchor + (firstPES −
# ref)` under a monotone floor (ts_timeline.TimelineStamper), and a B-frame
# stream's per-buffer FIRST PES walks backwards, so those buffers' stamps are
# clamped UP to the previous one — measured on the live video leg: K spread
# 120.009 ms (= the reorder depth), against 0.316 ms on the audio leg of the
# same producer. A branch that locks on a clamped buffer therefore runs its
# whole timeline that far LATE, and the sibling audio branch does not: the pair
# leaves the mux 100–121 ms apart (t0/t1/t2 rounds) from inputs measured
# 0.001 ms apart, re-drawn on every mux restart because the clamp of whichever
# buffer the branch locked on is a fresh draw.
#
# THE FIX. The stamps are the shared truth, so anchor every branch to them
# EXPLICITLY instead of to the one stamp it happened to lock on:
#
#     offset = K + ns(anchorPES) − firstBufferPts
#
#   * `K` = `stamp − ns(firstPES)` = `anchor − ns(ref)`, one constant per
#     producer egress, taken as the MINIMUM over the buffers seen — the floor
#     can only push a stamp UP, so the lower end of that distribution is the
#     unclamped truth (the same reading the rig's analysis tool takes).
#   * `anchorPES` is the PES of the access unit the demuxer's FIRST OUTPUT
#     BUFFER actually carries, identified BY CONTENT: that buffer IS a PES
#     payload this branch's sink pad has already reassembled (tsdemux strips the
#     PES header and passes the payload through, and this probe sits ahead of
#     any parser), so its LAST 64 bytes are an exact join back to that PES's PTS.
#
#     THE TAIL, not the head, and not a prediction. Three cuts were refuted on
#     the rig (.202, 2026-08-14), each measurably: "the first usable PES of the
#     stream" sat 5 frames early (applied −200 ms, residual skew −80 ms); "the
#     first PES of the bus buffer whose STAMP came back on the first output
#     buffer" — which the stamp arithmetic matches to the nanosecond — computed
#     0 ms on a branch measured 107.5 ms late the same round, because the stamp
#     says which BUFFER the branch slaved to and not which access unit was in
#     flight; and a join on the payload HEAD landed on the wrong frame outright
#     (corrections came out as exact multiples of the 40 ms frame — H.264 access
#     units open with the same AUD/SEI bytes, so the head is not an identity).
#     The tail of the last slice is unique per frame and survives this hop
#     byte-for-byte, which is why the rig's own analysis tool joins on it too.
#   * so the pad's running time becomes `K + ns(PES)` = that media's HOUSE
#     time, for every branch, whatever each demuxer made of it.
#
# Branches are then aligned BY CONSTRUCTION rather than by luck, and against an
# absolute (house) reference rather than each other — so a restart re-derives
# the same timeline instead of re-rolling the skew, and two branches fed by
# DIFFERENT producers align too (each carries its own K). The per-input
# `offsetMs` lipsync knob is untouched: it rides on the mux's request pad, this
# on the demuxer's src pad, so it stays exactly the manual trim it always was.
#
# NOTHING IS APPLIED ON A GUESS. No join, or a payload head that two PES of this
# branch share (so the join would be a coin toss), leaves the branch exactly as
# it is today — logged, no offset.
#
# CONTRACT-ONLY, and gated one layer up (`GstPluginBase.applyTimeSync` drops the
# config when the contract is off): with arrival-timed bus buffers there is no
# house mapping to anchor to, `K` would be noise, and the legacy path must stay
# byte-identical.
_branch_align = {}      # demux element name -> per-branch state


def _clear_branch_align():
    _branch_align.clear()


# A zero point can only be off by the reorder depth / one buffer's span of
# media. Anything past this is not the error this feature exists to remove —
# a misidentified anchor, a stream whose stamps aren't house-mapped — and the
# safe answer is to leave the branch exactly as it is today and say so.
_BRANCH_ALIGN_MAX_NS = 500_000_000
# How long a branch is left alone before its error is even sampled. A tsdemux
# RE-SLAVES to the upstream stamps for the first seconds of a stream (the
# settling `gst_tsdemux_slave_test.py` measures), so anything read before this
# is a transient, not the mapping the branch will hold — 3 s is past the
# settling on the live rig and inside the mux's own 1.2 s latency fill.
_BRANCH_ALIGN_SETTLE_MS = 3000.0
# Access units joined before the correction is taken, and the ceiling on waiting
# for them. The median of the window is the branch's error; a handful is plenty
# once settled (the spread is logged so a noisy branch is visible).
_BRANCH_ALIGN_SAMPLES = 9
_BRANCH_ALIGN_GIVEUP_MS = 15000.0
# Below this the branch is already where the stamps say it should be, and a
# timeline step costs more than it buys.
_BRANCH_ALIGN_MIN_NS = 2_000_000
# How many access units of payload→PTS history a branch keeps while it waits for
# its demuxer's first output. The join is normally in the first few; the live
# video branch had discarded five buffers' worth before it emitted. This is the
# memory bound, not an expectation.
_BRANCH_ALIGN_HISTORY = 4096
# Bytes of PES payload TAIL used as the join key — the end of the last slice,
# which no two frames share (an access unit's HEAD is codec boilerplate every
# frame repeats: measured on the live H.264 leg, a head join landed whole frames
# out). Same key the rig's analysis tool joins access units on.
_BRANCH_ALIGN_KEY_BYTES = 64


def _install_branch_stamp_align(pipe, cfg):
    """cfg = {"demuxes": ["demux_0", ...]} from the pipeline description."""
    _clear_branch_align()
    if not cfg:
        return
    names = [n for n in (cfg.get("demuxes") or []) if n]
    if not names:
        return
    import ts_psi          # lazy, pure stdlib (embedded-core pattern)
    import ts_timeline

    for name in names:
        demux = pipe.get_by_name(name)
        if not demux:
            sys.stderr.write(
                f"[gst-runner.py] branchAlign: element '{name}' not found — "
                f"branch left un-anchored\n")
            continue
        sink_pad = demux.get_static_pad("sink")
        if sink_pad is None:
            continue
        state = {
            "name": name,
            "k": None,          # min(stamp − ns(firstPES)) — the house mapping
            "ksamples": 0,
            # PES payload TAIL -> that PES's PTS, or None once two access units
            # of this branch have shared a tail (an unusable key, not a licence
            # to pick one).
            "byTail": {},
            "tailOrder": [],    # insertion order, for the history bound
            "open": {},         # pid -> [pts, bytearray] of the AU being received
            "sink_pad": sink_pad,
            "sink_probe_id": None,
            "pending": 0,       # armed src pads still awaiting their offset
            "samples": {},      # pid -> joined error samples, settled window
            "t0": None,         # running time of this branch's first output
            "settled": False,
            "done": False,
        }
        _branch_align[name] = state

        def close_au(st, pid):
            """An access unit ends where the next one starts (a video PES has no
            length field), so a PUSI closes the one before it — the same trigger
            the demuxer emits on, which is why the join is always ready in time.
            """
            rec = st["open"].pop(pid, None)
            if rec is None or rec[0] is None or len(rec[1]) < _BRANCH_ALIGN_KEY_BYTES:
                return
            tail = bytes(rec[1][-_BRANCH_ALIGN_KEY_BYTES:])
            prev = st["byTail"].get(tail, False)
            if prev is False:
                st["tailOrder"].append(tail)
                if len(st["tailOrder"]) > _BRANCH_ALIGN_HISTORY:
                    st["byTail"].pop(st["tailOrder"].pop(0), None)
                st["byTail"][tail] = rec[0]
            elif prev != rec[0]:
                # Two access units with the same tail: the key cannot decide
                # between them, so it decides nothing (None disqualifies it).
                st["byTail"][tail] = None

        def on_sink_buffer(_pad, info, st=state):
            """One pass over the branch's TS: the producer's mapping (K), and a
            payload-tail → PTS index of the access units in flight."""
            buf = info.get_buffer()
            if buf is None or st["done"]:
                return Gst.PadProbeReturn.OK
            stamp = buf.pts
            ok, mi = buf.map(Gst.MapFlags.READ)
            if not ok:
                return Gst.PadProbeReturn.OK
            try:
                data = bytes(mi.data)
            finally:
                buf.unmap(mi)
            first_pts = None
            for pkt in ts_psi.iter_packets(data):
                if not ts_psi.ts_has_payload(pkt):
                    continue
                off = ts_psi.payload_offset(pkt)
                if off >= ts_psi.PKT:
                    continue
                pid = ts_psi.ts_pid(pkt)
                if pkt[1] & 0x40:                   # PUSI: a PES may start here
                    p = pkt[off:]
                    if len(p) < 14 or p[0] != 0x00 or p[1] != 0x00 or p[2] != 0x01:
                        continue                    # PSI section, not a PES
                    pts = ts_psi.read_pes_pts(pkt)
                    close_au(st, pid)
                    # K is measured from the buffer's FIRST PES: that is the PES
                    # the producer's stamp maps, whatever the demuxer later
                    # makes of the buffer.
                    if pts is not None and first_pts is None:
                        first_pts = pts
                    st["open"][pid] = [pts, bytearray(pkt[off + 9 + p[8]:])]
                elif pid in st["open"]:
                    st["open"][pid][1] += pkt[off:]
            if first_pts is None or stamp == Gst.CLOCK_TIME_NONE:
                return Gst.PadProbeReturn.OK
            k = stamp - ts_timeline.pts90k_to_ns(first_pts)
            st["ksamples"] += 1
            # MINIMUM, not latest: the monotone floor only ever pushes a stamp
            # up, so the smallest reading is the unclamped mapping.
            if st["k"] is None or k < st["k"]:
                st["k"] = k
            return Gst.PadProbeReturn.OK

        def release_sink_probe(st=state):
            if st["pending"] or st["done"]:
                return
            st["done"] = True
            if st["sink_probe_id"] is not None:
                st["sink_pad"].remove_probe(st["sink_probe_id"])
                st["sink_probe_id"] = None
            # Nothing left to measure: the offsets are latched for this
            # incarnation, so the branch pays no per-buffer cost from here.

        def on_out_buffer(pad, info, arg):
            """Sample this branch's error, and once it has SETTLED, correct it.

            The error is `K + ns(thisAU) − thisBuffer.pts`: where the producer's
            stamps put this access unit in house time, minus where the branch
            put it. Sampled rather than latched on the first buffer, because the
            first buffer is exactly when the branch is NOT yet on its final
            mapping — tsdemux re-slaves for a few seconds after it starts (the
            settling `gst_tsdemux_slave_test.py` pins), and the rig showed
            first-buffer corrections landing tens of ms off the value the branch
            then held for the rest of its life (.202, 2026-08-14: residuals
            −25.9 / −186.6 / +46.7 ms across three incarnations, each computed
            from a first buffer). The MEDIAN of the settled window is what the
            branch actually runs at.
            """
            pid, st = arg
            buf = info.get_buffer()
            if buf is None or st.get("settled"):
                return Gst.PadProbeReturn.OK
            pts = buf.pts
            if pts == Gst.CLOCK_TIME_NONE or st["k"] is None:
                return Gst.PadProbeReturn.OK
            samples = st["samples"].setdefault(pid, [])
            # Elapsed on the BRANCH's own timeline (its buffer PTS), not a clock
            # reading: it needs no pipeline-global to be in scope, it is exactly
            # "this much media has passed since the branch started", and it is
            # what a test can drive deterministically.
            if st["t0"] is None:
                st["t0"] = pts
            elapsed = (pts - st["t0"]) / 1e6
            if elapsed < _BRANCH_ALIGN_SETTLE_MS:
                return Gst.PadProbeReturn.OK          # still settling
            if len(samples) < _BRANCH_ALIGN_SAMPLES:
                # Which access unit is this? Join it back to the TS by its
                # payload TAIL — the demuxer strips the PES header and passes
                # the payload through untouched, and this probe is ahead of any
                # parser.
                size = buf.get_size()
                if size >= _BRANCH_ALIGN_KEY_BYTES:
                    tail = buf.extract_dup(size - _BRANCH_ALIGN_KEY_BYTES,
                                           _BRANCH_ALIGN_KEY_BYTES)
                    anchor = st["byTail"].get(tail)
                    if anchor is not None:
                        samples.append(
                            st["k"] + ts_timeline.pts90k_to_ns(anchor) - pts)
                if len(samples) < _BRANCH_ALIGN_SAMPLES:
                    if elapsed > _BRANCH_ALIGN_GIVEUP_MS:
                        st["settled"] = True
                        sys.stderr.write(
                            f"[gst-runner.py] branchAlign: {st['name']} pid=0x{pid:x} "
                            f"joined only {len(samples)} access units in "
                            f"{elapsed:.0f} ms — branch left un-anchored\n")
                        sys.stderr.flush()
                        finish(st)
                    return Gst.PadProbeReturn.OK
            off = sorted(samples)[len(samples) // 2]      # median of the window
            spread = max(samples) - min(samples)
            st["settled"] = True
            note = ""
            if abs(off) > _BRANCH_ALIGN_MAX_NS:
                note = " — REJECTED (past the plausible zero-point error), branch left as-is"
            elif abs(off) < _BRANCH_ALIGN_MIN_NS:
                note = " — already aligned, left untouched"
            else:
                pad.set_offset(pad.get_offset() + off)
            sys.stderr.write(
                f"[gst-runner.py] branchAlign: {st['name']} {pad.get_name()} "
                f"pid=0x{pid:x} offsetNs={off} ({off / 1e6:+.3f} ms){note} "
                f"(median of {len(samples)} joined AUs, spread {spread / 1e6:.3f} ms, "
                f"K={st['k']} from {st['ksamples']} buffers, ausIndexed={len(st['byTail'])})\n")
            sys.stderr.flush()
            finish(st)
            return Gst.PadProbeReturn.OK

        def finish(st):
            """One branch is done measuring: drop its probes so the steady state
            costs nothing (the sink index is the expensive half)."""
            st["pending"] -= 1
            release_sink_probe(st)

        def on_pad_added(_element, pad, st=state):
            pad_name = pad.get_name() or ""
            if not (pad_name.startswith("audio_") or pad_name.startswith("video_")):
                return
            pid = _pid_from_tsdemux_pad_name(pad_name)
            if pid is None:
                return
            st["pending"] += 1
            # A plain BUFFER probe, NOT a blocking one: the correction lands a
            # few seconds in (see on_out_buffer), and nothing may be held up
            # waiting for it. The offset then arrives as one timeline step on
            # this pad while the mux is still filling its latency budget.
            pad.add_probe(Gst.PadProbeType.BUFFER, on_out_buffer, (pid, st))

        state["sink_probe_id"] = sink_pad.add_probe(
            Gst.PadProbeType.BUFFER, on_sink_buffer)
        demux.connect("pad-added", on_pad_added)


# ---------------------------------------------------------------------------
# Bus egress stamper (time-sync contract) — the PRODUCER stamps the timeline
# ---------------------------------------------------------------------------
# The subsystem lives in `gst_bus_stamper.py` next to this file (probe install,
# lazy arm/disarm per consumer edge, native `mrtsstamp` splice, engine events),
# and the arithmetic it applies is `ts_timeline.TimelineStamper` — the one
# python definition of the contract, shared with the sidecars. What stays here
# is the wiring: the emitter it reports through, and the consumer-edge
# bookkeeping only this file knows about (`_bus_branches`).
import gst_bus_stamper                                            # noqa: E402

# A lambda, not the function object: the emitter is resolved on every event, so
# a test (or a future indirection) that replaces this module's `emit_event`
# still owns what the stamper emits.
gst_bus_stamper.set_emitter(lambda obj: emit_event(obj))


def _release_bus_stamper(tee_name):
    """Disarm `tee_name`'s stamper once its LAST consumer edge is gone.

    Held edges keep it armed, so one consumer of several detaching changes
    nothing. A tee that gets a consumer again later re-anchors from that
    moment, which is the established re-anchor semantics.

    Note the stall watchdog's in-place edge RESET goes through here too when
    the stalled edge is a tee's only one: that reset EOFs the zombie consumer
    so it respawns, and a fresh consumer wants a fresh anchor anyway.
    """
    for entry in _bus_branches.values():
        if entry.get("tee_name") == tee_name:
            return
    gst_bus_stamper.release(tee_name)


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


def _apply_contract_clock(pipe, live_capture_clock=False):
    """Put `pipe` on the time-sync contract's clock and PIN its timeline.

    The contract (engine-wide `timeSyncContract`) replaces the net-clock dance
    with the one time base every process on the box already agrees on: the
    monotonic system clock. Two moves:

      * `use_clock(SystemClock)` — a fixed, explicitly MONOTONIC clock (that is
        already GstSystemClock's default clock-type; set for clarity), so no
        element-provided clock (pulsesink's, a source's) gets auto-selected and
        every pipeline ticks at the same rate.
      * `set_start_time(CLOCK_TIME_NONE)` + `set_base_time(0)` — running-time
        then IS clock time, identically in every process. A pipeline start time
        of CLOCK_TIME_NONE is what stops GstPipeline recomputing base-time on
        the PAUSED→PLAYING transition, so the 0 we set here survives; both must
        therefore be set BEFORE the state change out of NULL/READY.

    `live_capture_clock` (the start payload's `liveCaptureClock`) keeps the
    first move and DROPS the second: the pipeline still runs on the shared
    monotonic house clock, but base-time anchors naturally at PLAYING. It is for
    pipelines whose head is a real live capture element feeding an
    aggregator-based muxer — today `v4l2src ! ... ! mpegtsmux` (video-encoder).
    `mpegtsmux` is a GstAggregator and schedules its output off RUNNING TIME:
    with base-time pinned to 0 that is house time (the size of the box's
    uptime) while the live source produces from its own natural zero, so the mux
    mis-schedules and releases video in GOP-sized ~2.3 s bursts (measured on a
    Pi4 + ATEM: ~31 KB/s starve seconds alternating with ~300 KB/s spikes, every
    live consumer frozen on one frame).

    The contract survives that: the producer stamp is base-time independent by
    construction — both stamping backends read house time as `clock - base_time`
    (`gst_stamp_probe.house_now`, `gst_mrtsstamp_house_now`) and `unixfdsink`
    transmits `segment_to_running_time(pts) + base_time`, so the base-time
    cancels and the wire carries the same absolute house time either way. Only
    the pinning is skipped; the clock half is identical. Bus-fed producers
    (transcoder, mpegts-muxer) must NOT use it — their branch alignment is built
    on running-time being house time. See `PipelineDescription.liveCaptureClock`.

    Nothing external is contacted or waited for, so unlike `_apply_net_clock`
    this can neither delay nor wedge a start — there is no timeout case and no
    sink to relax to `sync=false`.
    """
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    if live_capture_clock:
        return
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)


def _now_running_ms():
    """The pipeline's RUNNING TIME in ms, or 0.0 when there is no pipeline/clock.

    The one time base the backlog shedder's samples, its policy's hold/cooldown
    windows and renderWatch's staleness test all share — deliberately not
    `time.monotonic()`, which is a different epoch from the pipeline clock and
    would make a comparison between the two silently wrong.
    """
    pipe = pipeline
    if pipe is None:
        return 0.0
    clock = pipe.get_pipeline_clock()
    if clock is None:
        return 0.0
    return (clock.get_time() - pipe.get_base_time()) / 1e6


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

    # Time sync (opt-in), applied before PLAYING so the pipeline never runs on
    # its own auto-selected clock first. The engine sends exactly one of these:
    # under the time-sync contract, a monotonic system clock with a pinned
    # timeline (no daemon involved); otherwise the legacy shared net clock that
    # slaves this pipeline to its siblings (video-player ↔ audio-decoder).
    # `liveCaptureClock` is read HERE AND ONLY HERE, inside the contract branch:
    # it selects the contract variant that keeps the house clock but lets
    # base-time anchor naturally (live capture head into an aggregator mux — see
    # `_apply_contract_clock`). With the contract off the legacy path below is
    # byte-identical to what it was.
    if data.get("timeSyncContract"):
        _apply_contract_clock(pipeline, data.get("liveCaptureClock"))
    else:
        _apply_net_clock(pipeline, data.get("clock"))

    # Reset per-run pad counters and install dynamic-pad-link rules
    _pad_link_counts = {}
    for rule in pad_link_rules:
        _install_pad_link_rule(pipeline, rule)

    # Source-timeline preservation (opt-in; must be armed BEFORE PLAYING so
    # the sink-pad latch sees the very first TS bytes).
    _install_preserve_timeline(pipeline, data.get("preserveSourceTimeline"))

    # Multi-branch stamp alignment (contract-only; same window and the same
    # reason — the first TS bytes carry the mapping every branch is anchored to,
    # and a branch that has already emitted cannot be re-zeroed without a jolt).
    _install_branch_stamp_align(pipeline, data.get("alignBranchesToStamps"))

    # The producer half of the time-sync contract: stamp every bus egress with
    # house-clock media time. The FLAG is recorded here, before PLAYING, for the
    # same reason as above — an attach can land the moment the pipeline starts
    # and the probe must own that edge's first buffer. The probes themselves arm
    # per tee as consumers attach. Gated on the same flag as the clock, because
    # the stamp is only meaningful once base_time is pinned to 0.
    gst_bus_stamper.enable(pipeline, data.get("timeSyncContract"))

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
        _teardown_pipeline(pipeline)
        pipeline = None
        return

    # Report-only TS video-info probe (`tsProbe` config) — same wiring window.
    if not _start_ts_probe(pipeline, data.get("tsProbe")):
        _teardown_pipeline(pipeline)
        pipeline = None
        return

    # Report-only render keep-up watch (`renderWatch` config) — same window.
    if not _start_render_watch(pipeline, data.get("renderWatch")):
        _teardown_pipeline(pipeline)
        pipeline = None
        return

    # Keyframe gate (`keyframeGate` config). NOT report-only — it drops
    # buffers — and it MUST be armed before PLAYING: the very first access
    # unit off a mid-GOP join is the one that wedges a stateless V4L2 decoder.
    if not _start_keyframe_gate(pipeline, data.get("keyframeGate")):
        _teardown_pipeline(pipeline)
        pipeline = None
        return

    # Backlog shedder (`backlogShed` config) — the time-sync contract's latency
    # ratchet guard. Also NOT report-only, and armed AFTER the gate on purpose:
    # both probes sit on the decoder's sink pad, a probe that DROPS stops the
    # rest of the chain being called, and a shut gate must win — it is already
    # dropping everything, which drains the same backlog.
    if not _start_backlog_shedder(pipeline, data.get("backlogShed")):
        _teardown_pipeline(pipeline)
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
        # The state change was REJECTED, so nothing ever ran — no drain (it
        # would only burn the EOS timeout on a pipeline that never decoded).
        _teardown_pipeline(pipeline, drain=False)
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
    """Stop the pipeline.

    The deliberate-teardown path: the parent's `stop` command, a SIGTERM/SIGINT
    and a closed command pipe all land here. It EOS-drains before NULL — this
    is the path a codec-switch pipeline rebuild takes, i.e. the one that used
    to stop an actively-decoding pipeline (see EOS_DRAIN_TIMEOUT_MS).
    """
    global pipeline, running
    _cancel_playing_watchdog()
    _clear_pending_bus_attaches()
    _clear_preserve_timeline()
    _clear_branch_align()
    gst_bus_stamper.clear()
    _stop_rist()
    _stop_ts_probe()
    _stop_render_watch()
    if pipeline:
        _teardown_pipeline(pipeline)
        running = False
        emit_event({"event": "state_change", "state": "null"})
    # AFTER the teardown, not before: the drain reaches the decoder through the
    # gate's pad when the pipeline-level EOS can't travel (see
    # _drain_decoder_branch), and the gate is harmless during a drain — it only
    # ever touches buffers, never events.
    _stop_keyframe_gate()
    # Same window, same reason: the shedder sits on that pad too, and it can
    # only ever drop a buffer the drain does not need.
    _stop_backlog_shedder()
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
    """Pad probe callback — counts bytes flowing through (the FALLBACK counter).

    Buffer LISTS are counted as one callback for the whole list: an mpegtsmux
    emits its output as lists, and a probe that only sees single buffers is
    either blind to them (BUFFER-only, upstream of any basetransform) or fires
    ~1170 times/s (downstream of capssetter/capsfilter, which dismantle the
    lists) — the latter measured at 0.5-0.7 of a core per producer on a Pi 4.
    Producers with the time-sync contract on never reach this callback: their
    `busout_*` tee is counted natively in `mrtsstamp` (`bytes-total`), see
    handle_track_throughput.
    """
    buf = info.get_buffer()
    size = 0
    if buf is not None:
        size = buf.get_size()
    else:
        blist = info.get_buffer_list()
        if blist is not None:
            for i in range(blist.length()):
                size += blist.get(i).get_size()
    if size:
        with throughput_lock:
            tracker = throughput_trackers.get(element_name)
            if tracker:
                tracker['bytes'] += size
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
            tracker = {
                'bytes': 0, 'last_bytes': 0,
                'last_time': time.monotonic(), 'bps': 0,
            }
            # A `busout_*` tee with the contract on has a native `mrtsstamp`
            # spliced in front of it that counts every byte in C: read its
            # counter on each get_throughput instead of running a python
            # callback per buffer on the streaming thread (see _pad_probe_cb).
            native_el = gst_bus_stamper.elements.get(element_name) if pad_name == "sink" else None
            if native_el is not None:
                tracker['native'] = native_el
            else:
                pad.add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST,
                              _pad_probe_cb, element_name)
            throughput_trackers[element_name] = tracker

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
            native_el = tracker.get('native')
            if native_el is not None:
                try:
                    tracker['bytes'] = gst_bus_stamper.native.bytes_total(native_el)
                except Exception:  # noqa: BLE001 — element disposed mid-teardown: keep the last count
                    pass
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
        # No pipeline YET — not "no pipeline ever". `bus_attach` can legitimately
        # arrive before `start` (the engine queues attaches for a producer whose
        # own input socket gate hasn't opened; GstRunner flushes them at launch),
        # and the old `return True` popped them off `_pending_bus_attaches`, so
        # the branch was never built and every consumer of that edge waited on a
        # socket nobody would create. Stay pending: identical to the
        # tee-not-created-yet case, which the 250 ms retry already owns.
        # `handle_stop` clears the queue and quits the loop, so this cannot
        # outlive the pipeline it is waiting for.
        return False
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
    # Arm the egress stamper BEFORE the branch is linked (no-op unless the
    # time-sync contract is on, or the tee is already armed for an earlier
    # consumer): once linked, buffers reach the new edge immediately, and one
    # that slipped past an unarmed probe would carry an arrival time onto the
    # wire. The structural-failure paths below release it again.
    gst_bus_stamper.arm(tee, tee_name)
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
            _release_bus_stamper(tee_name)
            return True  # don't retry a structural failure
        link_ret = tee_src.link(branch.get_static_pad("sink"))
        if link_ret != Gst.PadLinkReturn.OK:
            emit_event({"event": "warning",
                        "message": f"bus_attach: link failed ({link_ret}) {socket}"})
            tee.release_request_pad(tee_src)
            branch.set_state(Gst.State.NULL)
            parent.remove(branch)
            _release_bus_stamper(tee_name)
            return True
        entry = {"branch": branch, "tee": tee, "tee_src": tee_src,
                 "tee_name": tee_name, "queue": None, "sink_pad": None,
                 "progressed": False, "stall": 0, "probe_id": None,
                 "soft_healed": False}
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
        _release_bus_stamper(tee_name)
        return True


def _arm_bus_progress_probe(entry):
    """One-shot buffer probe on the edge sink's pad — sets the progress flag.

    Single-writer protocol (root cause of the false-stall cascades, fixed
    2026-07-21): the callback must NEVER write `probe_id`. The old protocol
    (`_cb` cleared probe_id on fire) raced the watchdog's re-arm — when the
    fresh probe fired between `add_probe()` returning and the id being
    stored, the stale id blocked every future re-arm, detection silently
    died on a healthy flowing edge, and 3 ticks later the watchdog
    destructively reset it (consumer -5 → module restart → mux dead-input
    rebuilds → on-air dropouts, ~1 false reset/80 min fleet-wide). Now only
    the watchdog tick writes `probe_id`: it clears it on the progressed path
    (progressed ⇒ the one-shot fired ⇒ the stored id is dead) before
    re-arming, so a stale store self-corrects one tick later instead of
    latching forever.
    """
    pad = entry.get("sink_pad")
    if pad is None or entry.get("probe_id") is not None:
        return

    def _cb(_pad, _info):
        entry["progressed"] = True
        return Gst.PadProbeReturn.REMOVE

    entry["probe_id"] = pad.add_probe(Gst.PadProbeType.BUFFER, _cb)


def _arm_tee_progress_probe(tentry):
    """One-shot buffer probe on the tee's sink pad — 'the producer has data'.
    Same single-writer protocol as _arm_bus_progress_probe (the callback
    never writes probe_id); this side's latch was benign — tee_flowing stuck
    False just disabled detection — but both paths stay uniform."""
    if tentry.get("probe_id") is not None:
        return

    def _cb(_pad, _info):
        tentry["progressed"] = True
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
                # progressed ⇒ the one-shot fired ⇒ any stored id is dead.
                # Clearing it HERE (single writer) is what makes a racy
                # stale store self-correct instead of blocking re-arms.
                tentry["probe_id"] = None
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
                entry["soft_healed"] = False
                # progressed ⇒ the one-shot fired ⇒ any stored id is dead
                # (see _arm_bus_progress_probe: single-writer protocol).
                entry["probe_id"] = None
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
                    if not entry.get("soft_healed"):
                        # First recovery attempt is non-destructive: a branch
                        # latched by a state race un-wedges with a plain
                        # re-sync (repro-validated) and the consumer's socket
                        # survives. Only if the edge stays silent for another
                        # full window does the destructive reset run.
                        entry["soft_healed"] = True
                        entry["stall"] = 0
                        try:
                            entry["branch"].sync_state_with_parent()
                        except Exception:  # noqa: BLE001
                            pass
                        emit_event({"event": "warning",
                                    "message": f"bus edge silent {_BUS_STALL_TICKS} ticks "
                                               f"(tee flowing) — soft re-sync {socket}"})
                        continue
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
                # Name what is actually missing: with no pipeline at all, "tee
                # not up yet" sends the reader hunting for a tee that no
                # pipeline could contain.
                what = "pipeline" if pipeline is None else f"tee {tee_name}"
                emit_event({"event": "warning",
                            "message": f"bus_attach: {what} not up yet for {socket} — still retrying"})
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
    # The entry is already out of `_bus_branches`, so this disarms the egress
    # stamper exactly when the tee just lost its LAST consumer. Done here rather
    # than in the async probe below: the edge is gone as far as bookkeeping is
    # concerned, and stamping for a departed consumer is the cost we removed.
    _release_bus_stamper(entry.get("tee_name"))
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


def handle_bus_reinput(data):
    """Re-point a named `unixfdsrc` at a new edge socket WITHOUT rebuilding
    the pipeline — the make-before-break half of a live input swap on a
    single-input bus sink (ts-splitter head-end). `socket-path` is construct-
    time-only on unixfdsrc, so the element is replaced: stop → unlink →
    remove → fresh unixfdsrc (same name, new socket) → add → link → sync.
    Responds `bus_reinput_done` (tracked RPC) only after the new element is
    linked and state-synced, so the parent may then detach the OLD edge.
    On any failure it responds `command_error` and the executor falls back to
    the classic stop/start restart.
    """
    req_id = data.get("id")
    name = data.get("element", "")
    socket = data.get("socket", "")
    if not pipeline:
        emit_command_error(req_id, "bus_reinput: no pipeline")
        return
    if not name or not socket:
        emit_command_error(req_id, "bus_reinput: element and socket required")
        return
    old = pipeline.get_by_name(name)
    if old is None:
        emit_command_error(req_id, f"bus_reinput: element '{name}' not found")
        return
    src_pad = old.get_static_pad("src")
    peer = src_pad.get_peer() if src_pad else None
    if peer is None:
        emit_command_error(req_id, f"bus_reinput: '{name}' has no linked src pad")
        return
    try:
        # Stopping the source stops dataflow on this branch — no pad blocking
        # needed (the ingress queue downstream simply runs dry for the gap).
        old.set_state(Gst.State.NULL)
        src_pad.unlink(peer)
        pipeline.remove(old)

        new = Gst.ElementFactory.make("unixfdsrc", name)
        if new is None:
            emit_command_error(req_id, "bus_reinput: unixfdsrc factory unavailable")
            return
        new.set_property("socket-path", socket)
        pipeline.add(new)
        link = new.get_static_pad("src").link(peer)
        if link != Gst.PadLinkReturn.OK:
            emit_command_error(req_id, f"bus_reinput: relink failed ({link})")
            return
        new.sync_state_with_parent()
    except GLib.Error as e:
        emit_command_error(req_id, f"bus_reinput: {e.message}")
        return
    sys.stderr.write(f"[gst-runner.py] bus_reinput: {name} -> {socket}\n")
    emit_event({"event": "bus_reinput_done", "id": req_id})


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
    session_timeout_ms = cfg.get("sessionTimeout")
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
                url, buffer_ms=buffer_ms, secret=secret, aes_type=enc_type,
                session_timeout_ms=session_timeout_ms))
        if stats_ms > 0:
            ctx.set_stats_callback(stats_ms, _on_rist_stats)

        if role == "receiver":
            _rist_stop.clear()

            def _push_loop():
                # Blocking read releases the GIL; appsrc push-buffer is
                # thread-safe. A push before PLAYING / during teardown returns
                # FLUSHING and the buffer drops — live-source semantics,
                # exactly what udpsrc did under the CLI relay.
                #
                # A read error is TRANSIENT: librist deletes and recreates the
                # flow around a link blackout (field case 2026-08-02: peer dead
                # 832 ms → flow deleted → read returned -3), then keeps
                # receiving into its fifo. Exiting the loop here left that fifo
                # undrained ("Rist data out fifo queue overflow") and wedged
                # the relay until a module restart — so warn once per error
                # burst and keep reading.
                err_streak = 0
                while not _rist_stop.is_set():
                    try:
                        data = ctx.read(100)
                    except librist.RistError as e:
                        err_streak += 1
                        if err_streak == 1:
                            emit_event({"event": "warning",
                                        "message": f"librist read failed (retrying): {e}"})
                        _rist_stop.wait(0.1)
                        continue
                    err_streak = 0
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


_ts_probe = None          # truthy while a tsProbe appsink is wired


def _start_ts_probe(pipe, cfg):
    """Report-only TS video-info probe (`tsProbe: {appsink}` config): watch a
    passthrough pipeline's TS bytes via a tap appsink, discover the first
    program's video ES and emit `tsprobe:videoinfo` plugin events with the
    SPS-derived parameters. Never touches routing; a probe failure past
    wiring is swallowed (KLV-reader philosophy). Returns True when no config
    is present or the probe is wired; a missing appsink the module explicitly
    asked for is still a hard error.

    CPU strategy: every buffer is processed until the first SPS parses
    (seconds), then 1 buffer in PROBE_SAMPLE_STRIDE keeps discovery + the
    SPS byte-compare alive at ~1.5% duty on a 30 Mbps feed. Buffers arrive
    datagram-aligned (7x188); a misaligned buffer yields nothing from
    iter_packets — harmless on a report-only path.
    """
    global _ts_probe
    if not cfg:
        return True
    try:
        import ts_psi
        import ts_video_info
    except Exception as e:  # noqa: BLE001
        emit_event({"event": "error", "message": f"ts_video_info unavailable: {e}"})
        return False
    appsink = pipe.get_by_name(cfg.get("appsink", ""))
    if appsink is None:
        emit_event({"event": "error",
                    "message": f"tsProbe: appsink not found: {cfg.get('appsink')!r}"})
        return False

    PROBE_SAMPLE_STRIDE = 64
    VIDEO_TYPES = {ts_psi.STREAM_TYPE_MPEG2_VIDEO: 'mpeg2', 0x01: 'mpeg1',
                   ts_psi.STREAM_TYPE_AVC: 'h264', ts_psi.STREAM_TYPE_HEVC: 'h265'}
    st = {"disc": ts_psi.PsiDiscovery(), "probe": None, "stable": False, "n": 0}

    def _emit(pid, codec, info=None):
        payload = {"pid": pid, "codec": codec, "width": None, "height": None,
                   "interlaced": None, "fps": None, "scrambled": None,
                   "display": None}
        if info:
            payload.update(info)
            payload["display"] = ts_video_info.format_video_info(info)
        emit_plugin_event("tsprobe:videoinfo", payload)

    def _on_pmt():
        for pid, stype in st["disc"].pmt["streams"]:
            codec = VIDEO_TYPES.get(stype)
            if codec is None:
                continue
            old = st["probe"]
            if old is not None and old.pid == pid and old.codec == codec:
                return                       # unchanged video ES — keep state
            st["stable"] = False
            if codec in ('h264', 'h265'):
                st["probe"] = ts_video_info.VideoInfoProbe(pid, codec)
            else:
                st["probe"] = None           # mpeg1/2: codec-only report
            _emit(pid, codec)                # early codec line for the UI
            return                           # first video ES of first program

    def _on_sample(sink):
        smp = sink.emit("pull-sample")
        if not smp:
            return Gst.FlowReturn.OK
        st["n"] += 1
        if st["stable"] and st["n"] % PROBE_SAMPLE_STRIDE:
            return Gst.FlowReturn.OK
        buf = smp.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            data = bytes(mi.data)
        finally:
            buf.unmap(mi)
        try:
            probe = st["probe"]
            psi = []
            for pkt in ts_psi.iter_packets(data):
                pid = ts_psi.ts_pid(pkt)
                if pid == 0 or pid == st["disc"].pmt_pid:
                    psi.append(pkt)
                if probe is not None and pid == probe.pid:
                    info = probe.feed(pkt)
                    if info is not None:
                        st["stable"] = True
                        _emit(pid, probe.codec, info)
            if st["disc"].feed(psi):
                _on_pmt()
        except Exception:  # noqa: BLE001 — report-only: never hurt the pipeline
            pass
        return Gst.FlowReturn.OK

    appsink.set_property("emit-signals", True)
    appsink.set_property("sync", False)
    # async=false: keep the tap out of preroll — a dark input must not wedge
    # the passthrough pipeline in PAUSED (verified gst 1.22).
    appsink.set_property("async", False)
    # drop=true, small bound: report-only tap must shed, never back-pressure
    # the tee it hangs off (opposite of a lossless drain, which uses drop=False).
    appsink.set_property("max-buffers", 8)
    appsink.set_property("drop", True)
    appsink.connect("new-sample", _on_sample)
    _ts_probe = True
    return True


def _stop_ts_probe():
    # State rides the appsink streaming thread; NULL transition stops it.
    global _ts_probe
    _ts_probe = None


# ---------------------------------------------------------------------------
# Render keep-up watch (`renderWatch` config)
# ---------------------------------------------------------------------------
_render_watch = None      # state dict while a renderWatch pad probe is armed

RENDER_WATCH_WINDOW_MS = 2000


def _start_render_watch(pipe, cfg):
    """Report-only render keep-up watch (`renderWatch: {sink}` config).

    Judges the rate of frames the sink actually PRESENTS — GstBaseSink's
    `stats` property (`rendered`/`dropped` counters) — against the framerate
    the pad's negotiated caps declare. Counting pad arrivals instead is a
    proven blind spot: on the 2026-08-01 Pi 4 investigation the pad saw a
    clean 50 fps while waylandsink discarded 18 fps internally (compositor
    frame-callback pacing), so an arrival-based watch reported everything
    fine during exactly the stutter it exists to catch.

    A pad probe still counts arrivals, but only as a gate: a window with NO
    arrivals is the stall watchdog's condition (dead source), not render
    lag, so those windows are fed as zero and the monitor's stall/preroll
    logic applies. Sinks without a `stats` property fall back to arrival
    counting (better than nothing on autovideosink-style bins).

    The hysteresis lives in render_lag.RenderLagMonitor; state transitions
    emit `renderwatch:lag` / `renderwatch:recovered` plugin events with
    `{achievedFps, expectedFps, droppedFps}` so the owning module can warn
    the operator. Never touches routing; a missing sink the module
    explicitly asked to watch is a hard error (matches tsProbe).
    """
    global _render_watch
    if not cfg:
        return True
    try:
        from render_lag import RenderLagMonitor
    except Exception as e:  # noqa: BLE001
        emit_event({"event": "error", "message": f"render_lag unavailable: {e}"})
        return False
    sink = pipe.get_by_name(cfg.get("sink", ""))
    if sink is None:
        emit_event({"event": "error",
                    "message": f"renderWatch: sink not found: {cfg.get('sink')!r}"})
        return False
    pad = sink.get_static_pad("sink")
    if pad is None:
        emit_event({"event": "error",
                    "message": f"renderWatch: no sink pad on: {cfg.get('sink')!r}"})
        return False

    st = {"pad": pad, "sink": sink, "frames": 0, "mon": RenderLagMonitor(),
          "probe_id": None, "timer_id": None, "prev_stats": None}

    def _on_buffer(_pad, _info):
        st["frames"] += 1
        return Gst.PadProbeReturn.OK

    def _expected_fps():
        # Re-read every tick: a mid-stream format switch renegotiates caps and
        # the monitor resets its streaks on an expected-fps change.
        caps = pad.get_current_caps()
        if not caps or caps.get_size() == 0:
            return None
        ok, num, den = caps.get_structure(0).get_fraction("framerate")
        if not ok or num <= 0 or den <= 0:
            return None                      # no VUI timing → nothing to judge
        return num / den

    def _sink_stats():
        # (rendered, dropped) totals from GstBaseSink, or None when the sink
        # doesn't expose them (not a basesink, e.g. an autovideosink bin).
        try:
            s = st["sink"].get_property("stats")
            return s.get_value("rendered"), s.get_value("dropped")
        except Exception:  # noqa: BLE001
            return None

    def _tick():
        arrivals = st["frames"]
        st["frames"] = 0
        achieved = arrivals
        dropped = 0
        stats = _sink_stats()
        if stats is not None:
            prev = st["prev_stats"]
            st["prev_stats"] = stats
            # First window has no delta yet; a negative delta means the sink
            # restarted its counters — both fall back to arrivals.
            if prev is not None and arrivals > 0:
                d_rendered = stats[0] - prev[0]
                d_dropped = stats[1] - prev[1]
                if d_rendered >= 0 and d_dropped >= 0:
                    achieved = d_rendered
                    dropped = d_dropped
        ev = st["mon"].tick(achieved, RENDER_WATCH_WINDOW_MS / 1000.0, _expected_fps(),
                            dropped / (RENDER_WATCH_WINDOW_MS / 1000.0))
        if ev:
            kind, achieved_fps, expected = ev
            # arrivalsFps lets the module tell RENDER lag (sink presents fewer
            # frames than arrive) from SOURCE shortfall (fewer frames arrive
            # in the first place — a feed/link problem the render chain can't
            # fix and must not be blamed for).
            payload = {"achievedFps": round(achieved_fps, 1),
                       "expectedFps": round(expected, 2),
                       "droppedFps": round(
                           dropped / (RENDER_WATCH_WINDOW_MS / 1000.0), 1),
                       "arrivalsFps": round(
                           arrivals / (RENDER_WATCH_WINDOW_MS / 1000.0), 1)}
            # RETAINED LATENCY, when a shedder is armed to measure it. Without
            # it this event could not name the contract's ratchet at all: with
            # the leg an hour behind, the sink's own back-pressure throttles
            # ARRIVALS to the presented rate and the sink's `dropped` counter
            # stays 0 (the frames are QoS-dropped in `videoconvert`, upstream of
            # it), so achieved ≈ arrivals ≈ 1 fps and the attribution reads
            # "source under-delivering" about a source delivering 50 fps —
            # observed verbatim on .42, 2026-08-14 07:19. `retainedMs` against
            # `budgetMs` is the one number that separates the two, so it rides
            # along whenever it exists and the payload is unchanged when it
            # does not (legacy/unpaced legs).
            reading = _backlog_shed_window(_now_running_ms())
            if reading:
                payload.update(reading)
            emit_plugin_event(f"renderwatch:{kind}", payload)
        return True                          # keep the GLib timer alive

    st["probe_id"] = pad.add_probe(Gst.PadProbeType.BUFFER, _on_buffer)
    st["timer_id"] = GLib.timeout_add(RENDER_WATCH_WINDOW_MS, _tick)
    _render_watch = st
    return True


def _stop_render_watch():
    global _render_watch
    st = _render_watch
    _render_watch = None
    if not st:
        return
    if st["timer_id"] is not None:
        GLib.source_remove(st["timer_id"])
    if st["probe_id"] is not None:
        st["pad"].remove_probe(st["probe_id"])


# ---------------------------------------------------------------------------
# Keyframe gate (`keyframeGate` config)
# ---------------------------------------------------------------------------
_keyframe_gate = None     # state dict while the gate probe is armed

# Fault injector env var — see _fault_drop_budget(). Absent = feature off.
FAULT_DROP_DELTAS_ENV = "VP_FAULT_DROP_DELTAS"


def _fault_drop_budget():
    """How many post-keyframe delta AUs the fault injector must swallow.

    DIAGNOSTIC HOOK, SHIPPED DISABLED. Unset (the normal case), non-numeric or
    <= 0 all mean 0 — completely inert: no burst, no logging, and nothing in
    the steady-state probe path beyond one int test per delta AU.

    WHAT IT IS FOR. The gate below protects the decoder from every gap it can
    SEE: a mid-GOP join (no keyframe yet) and a leak that upstream MARKED, i.e.
    a DELTA_UNIT carrying DISCONT. It cannot protect against a gap nothing
    marks — AUs lost on the wire inside a still-continuous byte stream, or
    dropped below us. Set `VP_FAULT_DROP_DELTAS=N` and the gate probe itself
    swallows the next N delta AUs after it opens, WITHOUT touching the flags of
    anything that follows: no DISCONT appears, so the gate's own re-arm rule
    cannot fire, and the decoder is handed post-gap AUs referencing pictures it
    never received. That is the condition that makes rpivid log
    `Col ref index 255 >= N`, program COLBASE=0 and wedge phase1 — this hook
    reproduces it on demand, in the REAL pipeline, past all app-level
    protection, which is the only honest way to test decoder-side handling of
    it.

    Read per gate build, so a `restartOnError` respawn re-arms the injector —
    intentional: with the var still set, every pipeline start gets one burst.
    Unset the var (and restart) to disarm.
    """
    try:
        n = int(os.environ.get(FAULT_DROP_DELTAS_ENV, ""))
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _start_keyframe_gate(pipe, cfg):
    """Hold a decoder shut until an IRAP, on stream entry AND after any loss
    (`keyframeGate: {decoder}` config).

    THE FAILURE THIS PREVENTS. Every live RIST/TS join lands MID-GOP, so the
    first access units handed to the decoder are delta units whose reference
    frames it never saw. On the stateless V4L2 decoders (rpivid
    `v4l2slh265dec` on Pi 4, `hevc_dec` on Pi 5, kernel 6.12.87) that is not
    just corrupt output: the driver is left holding a decode request that
    never completes, and the NEXT teardown blocks forever in the kernel
    (`hevc_d_h265_stop` in D state, videodev mutex held) — V4L2 is then dead
    box-wide and only a reboot clears it. Reproduced deterministically with a
    mid-GOP-cut TS through `tsdemux ! capsfilter ! queue ! h265parse !
    v4l2slh265dec`; `decodebin3` pipelines never wedged on the same feed
    because parsebin gates stream entry for us. The EOS drain
    (`_eos_drain`) fixes teardown ORDERING and cannot help here — by then the
    decoder is already stuck.

    THE GATE. A buffer probe on the decoder's SINK pad DROPS every buffer
    carrying `GST_BUFFER_FLAG_DELTA_UNIT` and passes the first one without it
    — `h264parse`/`h265parse` set that flag correctly per access unit, which
    is why the gate is placed after the parser rather than trying to read
    NAL types here. Events are never touched: caps/segment/EOS all flow
    normally.

    IT RE-ARMS, and that is the second half of the same bug. The gate used to
    pass the first keyframe and REMOVE itself, which left the decoder
    unprotected against loss LATER in the stream — and the live chain loses
    data by design: every jitter queue on the way here is `leaky=2`, most
    sharply the 200 ms ES queue feeding the parser, which sheds its oldest
    buffers whenever the decoder stalls (device open, CMA allocation and
    DMABuf negotiation at startup are ~1 s of stream time). The AUs it sheds
    are the ones right after the keyframe the gate just let through, so the
    next delta AUs reference frames the decoder never saw. GStreamer submits
    them anyway with the missing references marked 0xff, and rpivid logs
    `Col ref index 255 >= N` and programs COLBASE=0 — the hardware then reads
    collocated MVs from address 0 and phase1 wedges (field: Pi 400, 3/3
    hardware sessions, 2026-08). So a leak downstream of the gate is exactly
    as fatal as a mid-GOP join, and it needs the same answer.

    A leak is visible: `GstQueue` flags the buffer after a leak DISCONT, and
    `GstBaseParse` carries that flag onto the corresponding output AU, so a
    DISCONT on a DELTA_UNIT at this pad means "data was lost upstream". The
    gate closes again on it and drops until the next IRAP, at which point the
    picture resumes from a self-contained frame. A DISCONT on a keyframe is
    harmless (nothing references what was lost) and passes.

    COST: one flag test per AU for the pipeline's life, against a hardware
    wedge that needs a reboot to clear.

    SCOPE: armed once per pipeline START and stays armed. `restartOnError`
    replays the whole start command, so a restarted pipeline gets a fresh
    gate.

    A missing decoder element the module explicitly asked to gate is a hard
    error (matches tsProbe/renderWatch).

    FAULT INJECTION (`VP_FAULT_DROP_DELTAS`, off unless set) rides on this same
    probe so its drops are ordered against the gate's — see
    _fault_drop_budget().
    """
    global _keyframe_gate
    # Never inherit a previous pipeline's gate: its pad belongs to an element
    # that is gone, and the teardown drain now reaches the decoder through this
    # state (see _drain_decoder_branch).
    _stop_keyframe_gate()
    if not cfg:
        return True
    name = cfg.get("decoder", "")
    dec = pipe.get_by_name(name)
    if dec is None:
        emit_event({"event": "error",
                    "message": f"keyframeGate: decoder not found: {name!r}"})
        return False
    pad = dec.get_static_pad("sink")
    if pad is None:
        emit_event({"event": "error",
                    "message": f"keyframeGate: no sink pad on: {name!r}"})
        return False

    # `opened`, `dropped`, `rearms` and `since_close` are written ONLY by the
    # probe callback (one streaming thread) and read by _stop_keyframe_gate and
    # the tests. Same single-writer discipline as the bus progress probes: the
    # callback never writes `probe_id`.
    #   dropped     — cumulative delta AUs dropped, every closed window
    #   since_close — delta AUs dropped since the gate last closed
    #   rearms      — how many times upstream loss re-closed an open gate
    #   fault_budget  — delta AUs the fault injector still owes (0 = inert/done)
    #   fault_dropped — delta AUs the fault injector has swallowed
    st = {"pad": pad, "decoder": name, "probe_id": None, "dropped": 0,
          "opened": False, "since_close": 0, "rearms": 0,
          "fault_budget": _fault_drop_budget(), "fault_dropped": 0}

    def _log(line):
        sys.stderr.write(f"[gst-runner.py] keyframe gate: {name} {line}\n")
        sys.stderr.flush()

    # Loud on purpose, at both ends of the burst: an injected gap is
    # indistinguishable from wire loss in the decoder's behaviour, so a journal
    # must never leave anyone guessing whether it was organic.
    if st["fault_budget"]:
        _log(f"FAULT INJECTOR: dropping next {st['fault_budget']} delta AUs "
             f"after keyframe ({FAULT_DROP_DELTAS_ENV})")

    def _on_buffer(_pad, info):
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        delta = buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
        if st["opened"]:
            # Open: only upstream LOSS shuts the gate again. A DISCONT keyframe
            # is self-contained, so it passes and the gate stays open.
            if not (delta and buf.has_flags(Gst.BufferFlags.DISCONT)):
                # Fault injection: swallow the next N delta AUs this open gate
                # would have PASSED, one-shot per gate. Keyframes are never
                # touched (the picture must be able to recover), and the
                # buffers after the burst keep their original flags — no
                # DISCONT — so the re-arm rule above cannot see this gap. That
                # is the whole point: the decoder gets the unprotected gap.
                if delta and st["fault_budget"] > 0:
                    st["fault_budget"] -= 1
                    st["fault_dropped"] += 1
                    if st["fault_budget"] == 0:
                        _log("FAULT INJECTOR: burst complete "
                             f"({st['fault_dropped']} dropped)")
                    return Gst.PadProbeReturn.DROP
                return Gst.PadProbeReturn.OK
            st["opened"] = False
            st["since_close"] = 0
            st["rearms"] += 1
            _log(f"re-armed on a DISCONT delta unit — data lost upstream, "
                 f"dropping until the next keyframe (re-arm #{st['rearms']})")
        if delta:
            st["dropped"] += 1
            st["since_close"] += 1
            return Gst.PadProbeReturn.DROP
        st["opened"] = True
        _log(f"opened on {'a' if st['rearms'] else 'first'} keyframe "
             f"({st['since_close']} delta unit(s) dropped"
             + (f", re-arm #{st['rearms']}" if st["rearms"] else "") + ")")
        return Gst.PadProbeReturn.OK

    st["probe_id"] = pad.add_probe(Gst.PadProbeType.BUFFER, _on_buffer)
    _keyframe_gate = st
    return True


def _reclose_keyframe_gate(decoder_name):
    """Shut an open gate on `decoder_name` — "this decoder was just reset".

    The gate re-closes itself on evidence the STREAM lost data (a DISCONT delta
    AU). A decoder flushed under it (the post-shed stall watch's soft reset) is
    the same hazard with no such evidence: the next delta AU would be handed to
    a decoder that no longer holds its references. No-op when no gate is armed
    on that element. Written from the main loop rather than the probe thread,
    which is safe in the one direction it can move the gate: stricter.
    """
    st = _keyframe_gate
    if not st or st["decoder"] != decoder_name or not st["opened"]:
        return
    st["opened"] = False
    st["since_close"] = 0
    st["rearms"] += 1
    sys.stderr.write(f"[gst-runner.py] keyframe gate: {decoder_name} re-armed after "
                     f"a post-shed decoder flush (re-arm #{st['rearms']})\n")
    sys.stderr.flush()


def _stop_keyframe_gate():
    """Take the gate probe off the pad. The probe never self-removes (it has to
    survive to re-arm), so this is the only thing that ever detaches it."""
    global _keyframe_gate
    st = _keyframe_gate
    _keyframe_gate = None
    if not st or st["probe_id"] is None:
        return
    st["pad"].remove_probe(st["probe_id"])


# ---------------------------------------------------------------------------
# Backlog shedder (`backlogShed` config) — the time-sync contract's ratchet guard
# ---------------------------------------------------------------------------
_backlog_shed = None      # state dict while the shedder probe is armed

# A lateness reading older than this is not reported to renderWatch: with the
# leg gated shut (keyframe gate closed, source silent) the last sample says
# nothing about NOW, and a stale number in an attribution is worse than none.
BACKLOG_SHED_STALE_MS = 4_000

# A keyframe-aligned shed can only END on an IRAP (see below). Past this the
# wait itself is worth an event — the picture is blank while it lasts.
BACKLOG_SHED_KEYFRAME_WARN_MS = 3_000


def _start_backlog_shedder(pipe, cfg):
    """Give a clock-paced leg its retained backlog back (`backlogShed` config).

    THE FAILURE. `backlog_shed.py` documents the ratchet in full; the short of
    it is that a `sync=true` sink drains at exactly media rate, so backlog the
    leaky queues absorb during a downstream hiccup is never handed back. It is
    retained latency, it only ever grows, and past `max-lateness` (plus the QoS
    the sink asks its upstream for) it costs nearly every frame — .42 measured
    50 fps decoded and 2.5 fps on the glass after ~16 h.

    NOT report-only: it DROPS buffers. It is armed on the same pipelines the
    contract paces and nowhere else — with the contract off no module sends this
    config and nothing here runs (the legacy `sync=false` sink drains its own
    backlog, which is the behaviour the queues were sized against).

    WHERE IT MEASURES. On the sink pad of `element`, per buffer:

        lateness = now_running_time - (buffer_running_time + ts_offset)

    `ts_offset` is read live off the `sink` element, so it is the ROUTE's
    playout offset D including any operator trim, and lateness is therefore the
    excess over budget directly (`retained latency = lateness + D`). Running
    time comes from the pad's own SEGMENT, which is why the probe watches
    downstream events too — buffer PTS alone is not a timeline.

    WHERE IT SHEDS, and why that is the same pad. The backlog lives UPSTREAM of
    the decoder: the ES queue (1 s) and the jitter queue ahead of it are what
    absorbed the stall. Dropping there is nearly free and drains at I/O speed,
    where dropping decoded frames at the sink would be limited by decode rate
    (~1.2× real time on a Pi 4) and might never converge. So the video leg
    names its DECODER, and the drops happen on its sink pad — the same pad the
    keyframe gate uses, for the same reason: `h26xparse` has already marked
    every access unit `DELTA_UNIT` or not.

    KEYFRAME ALIGNMENT is not optional on that pad. Handing a stateless V4L2
    decoder a delta unit whose references were dropped is the documented
    hardware wedge (see `_start_keyframe_gate`, and `VP_FAULT_DROP_DELTAS`,
    which manufactures exactly this gap on purpose). So a video shed ends only
    on an IRAP: the runner keeps dropping until the stream offers one. It can
    therefore cost up to a GOP of picture — the same price the keyframe gate
    already pays on every re-arm, and bounded by the cooldown to at most once a
    minute. `keyframeAligned: false` (the audio leg) ends on the first buffer
    that is inside budget, because raw PCM references nothing.

    THE AUDIO LEG's shed is whole-buffer and gap-tolerant by construction: it
    drops only complete decoded buffers at `pulsesink`'s own pad, so no sample
    is ever cut and nothing is resampled. What the sink then sees is a TIMESTAMP
    GAP, which `GstAudioBaseSink` answers with a ring resync once it exceeds
    `alignment-threshold` (40 ms default) — samples already in the ring play
    out, then the sink re-anchors on the new timeline. Audible as one click at
    the shed, which is the price of returning lipsync to the configured D.

    RATE LIMITING AND SAFETY live in `backlog_shed.BacklogShedPolicy`: a
    sustained-excess floor rule, a cooldown, and the sanity ceiling that refuses
    to treat an implausible reading as a backlog (it would otherwise drop a
    whole stream chasing a target on a timeline it isn't on).

    AND THE SHED ITSELF CAN WEDGE THE DECODER. Resuming on the IRAP is correct
    and still not sufficient: on a Pi 400 (2026-08-18) a textbook shed left
    the stateless V4L2 HEVC decoder producing nothing at all — for 12 h, with no
    error posted and the pipeline still PLAYING. So every VIDEO shed arms
    `backlog_shed.PostShedStallWatch` on the shed target's OUTPUT: one buffer
    disarms it, silence past the grace flushes the decoder, silence past a
    second grace posts a bus ERROR and lets the parent's existing restart policy
    take it from there. Nothing of this exists until a shed fires.

    A missing element the module explicitly named is a hard error (matches
    tsProbe / renderWatch / keyframeGate).
    """
    global _backlog_shed
    # Never inherit a previous pipeline's shedder — its pad belongs to elements
    # that are gone (same rule as the keyframe gate).
    _stop_backlog_shedder()
    if not cfg:
        return True
    try:
        from backlog_shed import BacklogShedPolicy, PostShedStallWatch
    except Exception as e:  # noqa: BLE001
        emit_event({"event": "error", "message": f"backlog_shed unavailable: {e}"})
        return False
    name = cfg.get("element", "")
    el = pipe.get_by_name(name)
    if el is None:
        emit_event({"event": "error",
                    "message": f"backlogShed: element not found: {name!r}"})
        return False
    pad = el.get_static_pad("sink")
    if pad is None:
        emit_event({"event": "error",
                    "message": f"backlogShed: no sink pad on: {name!r}"})
        return False
    sink_name = cfg.get("sink", "")
    sink = pipe.get_by_name(sink_name)
    if sink is None:
        emit_event({"event": "error",
                    "message": f"backlogShed: sink not found: {sink_name!r}"})
        return False

    policy = BacklogShedPolicy(
        tolerance_ms=cfg.get("toleranceMs", 250),
        hold_ms=cfg.get("holdMs", 5_000),
        cooldown_ms=cfg.get("cooldownMs", 60_000),
        sanity_ms=cfg.get("sanityMs", 10_000),
    )
    # Every field below except `probe_id` is written ONLY by the probe callback
    # (one streaming thread) — the same single-writer discipline as the keyframe
    # gate. `win_min`/`last_*` are read by renderWatch on the main loop, which is
    # a benign race: it reads a float that is only ever replaced, never mutated.
    keyframe_aligned = cfg.get("keyframeAligned", True) is not False
    st = {"pad": pad, "element": name, "sink": sink, "policy": policy,
          "probe_id": None, "segment": None,
          "keyframe_aligned": keyframe_aligned,
          "shedding": False, "dropped": 0, "sheds": 0,
          "shed_at": None, "before_ms": None, "caught_up_at": None,
          "keyframe_warned": False,
          "last_ms": None, "last_at": None, "win_min": None, "budget_ms": 0.0,
          # Post-shed stall watch. Armed only by a finished VIDEO shed, so on a
          # leg that never sheds there is no probe, no timer and no cost. The
          # generation counter is what makes a re-arm (or a stop) retire the
          # previous stage's pending timeout instead of stacking a second one.
          "stall": PostShedStallWatch(enabled=keyframe_aligned),
          "out_pad": el.get_static_pad("src"),
          "stall_probe_id": None, "stall_gen": 0}
    _backlog_shed = st

    def _log(line):
        sys.stderr.write(f"[gst-runner.py] backlog shed: {name} {line}\n")
        sys.stderr.flush()

    def _ts_offset_ms():
        try:
            return float(sink.get_property("ts-offset")) / 1e6
        except (TypeError, AttributeError, GLib.Error):
            return 0.0

    def _stall_now_ms():
        """Monotonic ms — the base GLib's own timeouts run on. Deliberately NOT
        the pipeline clock's running time: this watch asks whether WALL-CLOCK
        time has passed with no output, and must stay right when the media
        timeline is the very thing that stopped."""
        return GLib.get_monotonic_time() / 1000.0

    def _stall_disarm():
        """Idempotent. Bumping the generation retires any pending timeout: its
        callback is the only thing that could act on a watch that is over."""
        st["stall_gen"] += 1
        st["stall"].disarm()
        if st["stall_probe_id"] is not None:
            st["out_pad"].remove_probe(st["stall_probe_id"])
            st["stall_probe_id"] = None

    def _on_output(_pad, _info):
        # One buffer out of the shed target and the episode is genuinely over.
        # One-shot (REMOVE) — the steady state carries no output probe at all.
        st["stall_probe_id"] = None
        st["stall_gen"] += 1
        st["stall"].saw_output()
        return Gst.PadProbeReturn.REMOVE

    def _stall_timeout(gen):
        """A grace window expired with nothing out. Stage 1 flushes the decoder,
        stage 2 escalates to the parent's restart policy."""
        watch = st["stall"]
        if gen != st["stall_gen"]:
            return False        # a re-arm, a buffer or a stop already took over
        action = watch.tick(_stall_now_ms())
        if action == "flush":
            _log(f"post-shed stall: no decoder output for "
                 f"{watch.grace_ms / 1000.0:g}s — flushing {name}")
            # WHY A FLUSH BEFORE A RESTART: the wedge is a stateless V4L2
            # decoder still holding a decode request for references the shed
            # dropped (the Pi 4-class failure, 2026-08-18). A flush pair is
            # the cheapest thing that clears that, and costs nothing extra —
            # the picture is already frozen. `reset_time=False` because the
            # contract pins running time to the house clock. The flush also
            # drops the pad's SEGMENT, so the last one the shed probe saw goes
            # back: without it the decoder's next buffer arrives on no timeline.
            pad.send_event(Gst.Event.new_flush_start())
            pad.send_event(Gst.Event.new_flush_stop(False))
            if st["segment"] is not None:
                pad.send_event(Gst.Event.new_segment(st["segment"]))
            # A flushed decoder needs a self-contained frame again, and nothing
            # in the stream will say so.
            _reclose_keyframe_gate(name)
        elif action == "error":
            _log("post-shed stall: decoder produced no output after shed + flush "
                 "— escalating to pipeline restart")
            _stall_disarm()
            err = GLib.Error.new_literal(
                Gst.StreamError.quark(),
                "post-shed stall: decoder produced no output after shed + flush "
                "— escalating to pipeline restart",
                int(Gst.StreamError.DECODE))
            # Posted from the PIPELINE, not the decoder element. The decoder
            # posted nothing — this watch judged it wedged — and an error naming
            # `vpdec` would cost the hardware decoder its rung for the rest of
            # the engine session (video-player's demotion rule). A bus ERROR is
            # all that is needed: the parent already restarts on one, with
            # backoff, which is the recovery this escalates to.
            pipe.post_message(Gst.Message.new_error(pipe, err, f"backlogShed {name}"))
            return False
        if watch.armed:
            # Next stage, or the remainder if the timer beat the deadline.
            GLib.timeout_add(max(1, int(watch.remaining_ms(_stall_now_ms()))),
                             _stall_timeout, gen)
        return False

    def _stall_arm():
        """Watch the shed target's output. No-op on an audio leg (see
        `PostShedStallWatch`) or an element with no static src pad."""
        watch = st["stall"]
        out_pad = st["out_pad"]
        if out_pad is None or not watch.arm(_stall_now_ms()):
            return
        st["stall_gen"] += 1
        if st["stall_probe_id"] is None:
            st["stall_probe_id"] = out_pad.add_probe(
                Gst.PadProbeType.BUFFER, _on_output)
        GLib.timeout_add(int(watch.grace_ms), _stall_timeout, st["stall_gen"])

    def _finish(late_ms, now_ms, outcome):
        st["shedding"] = False
        st["sheds"] += 1
        policy.shed_finished(now_ms)
        budget = st["budget_ms"]
        payload = {"element": name,
                   "outcome": outcome,
                   "budgetMs": round(budget, 1),
                   # RETAINED pipeline latency, the number an operator can hold
                   # against D — the raw lateness is the excess over it.
                   "retainedBeforeMs": round(st["before_ms"] + budget, 1),
                   "retainedAfterMs": round(late_ms + budget, 1),
                   "excessBeforeMs": round(st["before_ms"], 1),
                   "excessAfterMs": round(late_ms, 1),
                   "droppedBuffers": st["dropped"],
                   "durationMs": round(now_ms - st["shed_at"], 1),
                   "shedCount": st["sheds"]}
        st["dropped"] = 0
        st["shed_at"] = None
        st["caught_up_at"] = None
        st["keyframe_warned"] = False
        _log(f"shed #{payload['shedCount']}: retained "
             f"{payload['retainedBeforeMs']:.0f} → {payload['retainedAfterMs']:.0f} ms "
             f"(budget {budget:.0f} ms), {payload['droppedBuffers']} buffers dropped "
             f"in {payload['durationMs']:.0f} ms")
        emit_plugin_event("backlog_shed", payload)
        # The resume is not proof the decoder took it — watch its output until
        # one buffer says so. Armed AFTER the event so the shed is reported
        # whatever the decoder then does.
        _stall_arm()

    def _on_probe(_pad, info):
        if info.type & Gst.PadProbeType.EVENT_DOWNSTREAM:
            ev = info.get_event()
            if ev is not None and ev.type == Gst.EventType.SEGMENT:
                st["segment"] = ev.parse_segment()
                # Either side of a new segment the running times are not
                # comparable — start the streak over rather than carry it.
                policy.reset()
            return Gst.PadProbeReturn.OK
        buf = info.get_buffer()
        seg = st["segment"]
        if buf is None or seg is None or buf.pts == Gst.CLOCK_TIME_NONE:
            return Gst.PadProbeReturn.OK
        clock = pipe.get_pipeline_clock()
        if clock is None:
            return Gst.PadProbeReturn.OK
        rt = seg.to_running_time(Gst.Format.TIME, buf.pts)
        if rt == Gst.CLOCK_TIME_NONE:
            return Gst.PadProbeReturn.OK          # outside the segment
        now_rt = clock.get_time() - pipe.get_base_time()
        budget_ms = _ts_offset_ms()
        st["budget_ms"] = budget_ms
        late_ms = (now_rt - rt) / 1e6 - budget_ms
        now_ms = now_rt / 1e6
        st["last_ms"] = late_ms
        st["last_at"] = now_ms
        # The FLOOR over the window is the retained part (a spike relaxes; a
        # floor does not) — that is what renderWatch reports and judges on.
        st["win_min"] = late_ms if st["win_min"] is None else min(st["win_min"], late_ms)

        if st["shedding"]:
            at_budget = late_ms <= 0.0
            keyframe_ok = (not st["keyframe_aligned"]
                           or not buf.has_flags(Gst.BufferFlags.DELTA_UNIT))
            if at_budget and keyframe_ok:
                _finish(late_ms, now_ms, "recovered")
                return Gst.PadProbeReturn.OK      # the IRAP itself PASSES
            if at_budget:
                # Caught up; only the IRAP is missing now. Loud once, because
                # from here the picture is blank for reasons the stream owns.
                if st["caught_up_at"] is None:
                    st["caught_up_at"] = now_ms
                elif (not st["keyframe_warned"]
                        and now_ms - st["caught_up_at"] > BACKLOG_SHED_KEYFRAME_WARN_MS):
                    st["keyframe_warned"] = True
                    _log(f"at budget for {BACKLOG_SHED_KEYFRAME_WARN_MS} ms, still "
                         "waiting for a keyframe — resuming mid-GOP would hand the "
                         "decoder missing references, so the wait stands")
                    emit_plugin_event("backlog_shed",
                                      {"element": name, "outcome": "awaiting_keyframe",
                                       "budgetMs": round(budget_ms, 1),
                                       "retainedBeforeMs": round(st["before_ms"] + budget_ms, 1),
                                       "excessBeforeMs": round(st["before_ms"], 1),
                                       "droppedBuffers": st["dropped"],
                                       "durationMs": round(now_ms - st["shed_at"], 1),
                                       "shedCount": st["sheds"] + 1})
            st["dropped"] += 1
            return Gst.PadProbeReturn.DROP

        verdict = policy.observe(late_ms, now_ms)
        if verdict == "implausible":
            _log(f"lateness {late_ms:.0f} ms is past the sanity ceiling — treating "
                 "it as a timeline mismatch, NOT a backlog (nothing shed)")
            emit_plugin_event("backlog_shed",
                              {"element": name, "outcome": "implausible",
                               "budgetMs": round(budget_ms, 1),
                               "excessBeforeMs": round(late_ms, 1)})
            return Gst.PadProbeReturn.OK
        if verdict != "shed":
            return Gst.PadProbeReturn.OK
        st["shedding"] = True
        st["shed_at"] = now_ms
        st["before_ms"] = late_ms
        st["dropped"] = 1
        _log(f"retained {late_ms + budget_ms:.0f} ms against a {budget_ms:.0f} ms "
             f"budget for {policy.hold_ms:.0f} ms — dropping the oldest data"
             + (" up to the next keyframe" if st["keyframe_aligned"] else ""))
        return Gst.PadProbeReturn.DROP

    st["probe_id"] = pad.add_probe(
        Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, _on_probe)
    return True


def _backlog_shed_window(now_ms):
    """The window's retained-latency reading for renderWatch, or None.

    Consumes the window minimum (the FLOOR — see the probe), so each renderWatch
    tick judges its own window. None when no shedder is armed or the last sample
    is stale, which is what keeps the legacy/unpaced payload byte-identical.
    """
    st = _backlog_shed
    if not st or st["last_at"] is None or st["win_min"] is None:
        return None
    if now_ms - st["last_at"] > BACKLOG_SHED_STALE_MS:
        return None
    floor = st["win_min"]
    st["win_min"] = None
    return {"latenessMs": round(floor, 1),
            "retainedMs": round(floor + st["budget_ms"], 1),
            "budgetMs": round(st["budget_ms"], 1),
            "shedding": st["shedding"],
            "shedCount": st["sheds"]}


def _stop_backlog_shedder():
    """Take the shedder probe off the pad. Like the gate's, it never
    self-removes — a shed is an episode, not the probe's lifetime."""
    global _backlog_shed
    st = _backlog_shed
    _backlog_shed = None
    if not st:
        return
    # Any armed stall watch dies with the shedder: its pending timeout would
    # otherwise flush (or error) a pipeline that is being torn down or replaced.
    st["stall_gen"] = st.get("stall_gen", 0) + 1
    if st.get("stall") is not None:
        st["stall"].disarm()
    if st.get("stall_probe_id") is not None:
        st["out_pad"].remove_probe(st["stall_probe_id"])
        st["stall_probe_id"] = None
    if st["probe_id"] is None:
        return
    st["pad"].remove_probe(st["probe_id"])


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
    "bus_reinput": handle_bus_reinput,
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
        # Last teardown before the hard exit below. Normally a no-op (handle_stop
        # already took the pipeline to NULL, so the drain gate skips), but a loop
        # that exited any other way must not leave a PLAYING pipeline to be
        # stopped mid-decode by process teardown.
        _teardown_pipeline(pipeline)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        sys.stderr.write(f"[gst-runner.py] Fatal: {e}\n")
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        os._exit(1)
    # Skip CPython finalization: gi/GStreamer worker threads (librist logging,
    # bus watches, streaming threads mid-unwind) race Py_Finalize and crash
    # deterministically in libpython (SIGSEGV at fixed offset, observed on
    # every cascade's module restart — the crash left stale sockets and
    # stretched consumer outages past the muxers' 5 s dead-input watchdog).
    # The runner is a disposable child: everything worth flushing is flushed,
    # the pipeline is NULL, so a hard exit is strictly safer here.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
