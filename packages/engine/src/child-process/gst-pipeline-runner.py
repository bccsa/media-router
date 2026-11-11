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
from gi.repository import Gst, GLib, GObject
# GstApp is only needed by the LEGACY python RIST sender drain (`rist` runner
# config, try_pull_sample()), and it must be loaded BEFORE any pipeline is
# parsed: PyGObject types an element's wrapper when it is first seen, and an
# appsink wrapped before the typelib is loaded is a bare stub. Optional so a
# box without the typelib still runs every non-RIST pipeline.
try:
    gi.require_version('GstApp', '1.0')
    from gi.repository import GstApp  # noqa: F401 — import for side effect
    _GSTAPP_AVAILABLE = True
except (ValueError, ImportError):
    _GSTAPP_AVAILABLE = False

import json
import os
import resource
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

# Element messages forwarded unsubscribed as `<name>:<element>`: inputs added at runtime have
# no busReports entry. Equal to runner.cpp's kForwardedMessages.
FORWARDED_ELEMENT_MESSAGES = ("mrlateness", "mralignwatch", "mrtsdemux", "mrasrc-stats", "mrasrc-event",
                              "mrvideopace")

# VU throttle: only send when changed, heartbeat every 1s
last_vu = None
last_vu_time = 0
# Engine VuBatcher.heartbeatMs must stay well below this or re-sends get deduped (#677).
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
# LOAD-BEARING INVARIANT: this blanket deadline is safe ONLY for a LIVE head
# (srtsrc, ristsrc, capture, test sources), which reaches PLAYING with
# NO_PREROLL and does NOT wait for data. The two non-live heads in this engine,
# `unixfdsrc` and `udpsrc`, are gated on their first data instead — see
# gst_source_gate.py (ADR-0010 rule 3), which also owns udpsrc silence. A path
# that wants no deadline at all passes `playingTimeoutMs: 0`.
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
# `eosDrain` of the start payload: drain on a deliberate stop. False only for
# audio-only bus producers — see PipelineDescription.eosDrain.
_drain_on_stop = True
# Bin names of the live input branches (`liveInputBranches` + bus_input_add,
# minus removes): an error inside one is contained — the branch is dropped
# and `input_branch_lost` reported, the pipeline keeps running.
_live_input_branches = set()
# A running aggregator's last sink pad, unlinked and kept by aggregator name until
# the next add takes it (B-208): GstAudioAggregator left with no sink pad can
# aggregate once over none and restart its output at running time 0.
_kept_agg_pads = {}


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


def _send_drain_eos(pipe, playing):
    """The drain's EOS. Before PLAYING each source gets it under its own state lock, as
    gst_bin_send_event sends it, but not under the pipeline's: its async change to PLAYING
    needs that lock to free a source thread parked in a sink's preroll (B-202)."""
    eos = Gst.Event.new_eos()
    if playing or not isinstance(pipe, Gst.Bin):
        return pipe.send_event(eos)
    sent = True
    it = pipe.iterate_sources()
    while True:
        res, el = it.next()
        if res == Gst.IteratorResult.OK:
            sent &= el.send_event(eos)
        elif res == Gst.IteratorResult.RESYNC:
            it.resync()
            sent = True
        else:
            return sent


def _eos_drain(pipe, errored=False):
    """EOS-drain `pipe` so its decoder is idle before we stop it.

    Only pipelines that are actually running are drained: a NULL/READY (or
    stalled-in-PAUSED) pipeline has nothing in flight, and a preroll-only
    pipeline still counts (a stateless decoder decodes its preroll frame), so
    the pending state is checked too. Such a pipeline gets its EOS source by
    source (`_send_drain_eos`).

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

    if errored or not _send_drain_eos(pipe, state == Gst.State.PLAYING):
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
    # Before the drain: a relaunched producer publishes its edges at once (B-190).
    _release_bus_paths()
    source_gate.stop()
    if drain and _drain_on_stop:
        _eos_drain(pipe, errored=errored)
    pipe.set_state(Gst.State.NULL)
    # No streaming thread is left to meet a queue full: the last episode's count is final.
    _clear_queue_watch()


def _cancel_playing_watchdog():
    """Disarm the PLAYING watchdog (reached PLAYING, or pipeline torn down)."""
    global playing_watchdog_id
    if playing_watchdog_id is not None:
        GLib.source_remove(playing_watchdog_id)
        playing_watchdog_id = None


def _arm_playing_watchdog(timeout_ms):
    global playing_watchdog_id
    _cancel_playing_watchdog()
    if timeout_ms > 0:
        playing_watchdog_id = GLib.timeout_add(timeout_ms, _on_playing_timeout)


def _fail_pipeline(event, drain=True, errored=False):
    """The one fatal-lifecycle exit: report `event`, tear the pipeline down
    and leave the main loop so the parent's restart policy takes over."""
    emit_event(event)
    _teardown_pipeline(pipeline, drain=drain, errored=errored)
    if loop and loop.is_running():
        loop.quit()


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
    _fail_pipeline({
        "event": "error",
        "kind": "playing_timeout",
        "message": f"pipeline did not reach PLAYING within {PLAYING_WATCHDOG_MS} ms",
    })
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
        # CONTAINMENT: an error inside a live input branch (its producer died)
        # costs that input, not the mix — drop it, report it, keep running.
        lost = _live_branch_ancestor(src)
        if lost is not None:
            _drop_live_branch(lost)
            emit_event({"event": "input_branch_lost", "name": lost,
                        "message": f"live input {lost} lost ({element}): {err.message} — "
                                   f"branch dropped, mix continues without it"})
            return True
        # A `watchdog` element inserted by buildBusSrc's stallTimeoutMs
        # (named `buswd_*`) firing means the bus source is silent but
        # connected. Tag the error so modules can treat source-silent
        # differently from a hard failure (e.g. video-player's colour-bars
        # fallback) — the unixfd equivalent of `GstUDPSrcTimeout` below.
        if element.startswith("buswd"):
            ev = {"event": "error", "kind": "bus_stall", "message": str(err.message),
                  "debug": debug or "", "element": element}
        else:
            ev = {"event": "error", "message": str(err.message),
                  "debug": debug or "", "element": element}
        # Stop the pipeline on error. `errored`: the source that just failed
        # can no longer carry a pipeline-level EOS, so the drain goes straight
        # at the decoder instead of burning its budget (see _eos_drain).
        _fail_pipeline(ev, errored=True)

    elif t == Gst.MessageType.EOS:
        # Already drained by definition — EOS reached the sinks, so the decoder
        # is idle and a second EOS would only stall the teardown.
        _fail_pipeline({"event": "eos"}, drain=False)

    elif t == Gst.MessageType.STATE_CHANGED:
        if message.src == pipeline:
            old, new, pending = message.parse_state_changed()
            state_name = new.value_nick  # 'playing', 'paused', 'ready', 'null'
            if new == Gst.State.PLAYING:
                _cancel_playing_watchdog()
                source_gate.on_playing()
            emit_event({"event": "state_change", "state": state_name})

    elif t == Gst.MessageType.ELEMENT:
        structure = message.get_structure()
        name = structure.get_name() if structure else None
        src = message.src
        src_name = src.get_name() if src else None
        if gst_bus_stamper.is_stamper_message(name):
            # The egress stamper reports through the bus: the identity log line and the
            # segment warning, worded as mr-gst-runner words them.
            gst_bus_stamper.handle_message(src_name, name, structure)
        elif name in FORWARDED_ELEMENT_MESSAGES and src_name:
            # An egress tap reads house time only while its stamper is armed (B-26).
            if (not src_name.startswith(gst_bus_stamper.EGRESS_TAP_PREFIX)
                    or gst_bus_stamper.take_egress_window(src_name)):
                emit_plugin_event(f"{name}:{src_name}", gst_structure_to_dict(structure))
        elif name and src_name and (src_name, name) in bus_reports:
            # Subscribed via `busReports` — forward the whole structure on the
            # generic `<structure>:<element>` channel (e.g. `level:sclevel`).
            emit_plugin_event(f"{name}:{src_name}", gst_structure_to_dict(structure))
        elif name == "level":
            handle_level_message(structure)
        elif name == "GstUDPSrcTimeout":
            # udpsrc has not received data within its configured timeout. A
            # state, not a fault — see gst_source_gate.py: warn once, keep the
            # pipeline, restart only past a producer-declared multicast bound.
            _ok, timeout_ns = structure.get_uint64("timeout")
            source_gate.on_udp_timeout(src.get_name() if src is not None else "udpsrc", timeout_ns)

    return True

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Dynamic pad linking (a demux's sometimes-pads → branches)
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
    """Classify a demux pad's media type from its caps structure name.

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


def _pid_from_demux_pad_name(pad_name):
    """Parse the PID from a demuxer pad name.

    tsdemux and mrtsdemux name pads `<media>_<programhex>_<pidhex>` (e.g.
    `audio_0_0141`, `private_0_012c`). The PID is the last `_`-delimited field,
    hex. Returns the int PID, or None if the name doesn't match (so callers
    degrade to "unknown PID" rather than crash on an unexpected pad-name scheme).
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
    a demux pad back-pressures the streaming loop and stalls the whole TS.
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
    """Report every pad the demux exposes on the `stream:discovered` channel.

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
            "pid": _pid_from_demux_pad_name(pad.get_name()),
            "media": _stream_media_from_caps_name(caps_name or ''),
            "caps": caps.to_string() if caps else '',
            "padName": pad.get_name(),
        })
        if read_klv_names and caps_name == 'meta/x-klv' and pipe is not None:
            _attach_klv_reader(pipe, pad, source_name)

    element.connect("pad-added", on_pad)


# Caps-name → parser element used between the demux and a downstream `mpegtsmux`.
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
    'audio/x-opus': None,  # the demux already emits muxer-ready caps
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


# --------------------------------------------------------------------------- no-late-drop (B-170)
# House-clock P11 in the runner: no element drops a buffer for being late, including those a bin
# plugs (a decodebin3 rung, an overlay bin). Always on. Twin: mr-gst-runner no_late_drop.cpp.
def _is_a(element, type_name):
    """Whether `element` is a `type_name`: none is before a loaded library registers that type."""
    try:
        return GObject.type_is_a(element.__gtype__, GObject.type_from_name(type_name))
    except RuntimeError:
        return False


def _has_bool(element, prop):
    spec = element.find_property(prop)
    return (spec is not None and spec.value_type == GObject.TYPE_BOOLEAN
            and bool(spec.flags & GObject.ParamFlags.WRITABLE))


def _no_late_drop(element):
    """Turn off what drops a late buffer on `element`: a GstBaseSink's `qos` and `max-lateness`, a
    decoder's or a GstBaseTransform's `qos`. What it changed ("vc qos→false"), or ""."""
    changed = []
    if _is_a(element, "GstBaseSink"):
        if element.get_property("qos"):
            element.set_property("qos", False)
            changed.append("qos→false")
        if element.get_property("max-lateness") != -1:
            element.set_property("max-lateness", -1)
            changed.append("max-lateness→-1")
    elif (any(_is_a(element, t) for t in ("GstBaseTransform", "GstVideoDecoder", "GstAudioDecoder"))
          and _has_bool(element, "qos")):
        if element.get_property("qos"):
            element.set_property("qos", False)
            changed.append("qos→false")
    return f"{element.get_name()} {', '.join(changed)}" if changed else ""


def _install_no_late_drop(pipe):
    """Before PLAYING: every element of `pipe` (one log line), and each one added later (one line
    each that changed)."""
    changed = []
    it = pipe.iterate_recurse()
    while True:
        result, element = it.next()
        if result == Gst.IteratorResult.OK:
            c = _no_late_drop(element)
            if c:
                changed.append(c)
        elif result == Gst.IteratorResult.RESYNC:
            it.resync()
        else:
            break
    sys.stderr.write(f"[gst-runner.py] no-late-drop: {', '.join(changed) or 'nothing to change'}\n")
    sys.stderr.flush()

    def added(_root, _bin, element):
        c = _no_late_drop(element)
        if c:
            sys.stderr.write(f"[gst-runner.py] no-late-drop: {c}\n")
            sys.stderr.flush()

    pipe.connect("deep-element-added", added)


# --------------------------------------------------------------------------- queue watch (B-170)
# Every queue that drops at capacity (leaky) or holds an output's backlog (named below) counts
# each buffer that meets it full (`overrun`); each episode is one `queue_overrun` plugin event
# (B-182's rule). Twin: mr-gst-runner queue_watch.cpp.
QUEUE_OVERRUN_EVENT = "queue_overrun"          # queueOverrun.ts QUEUE_OVERRUN_EVENT
WATCHED_QUEUE_NAMES = ("vp_esq", "ad_esq", "prefill")   # queueOverrun.ts: watched though not leaky
_QUEUE_QUIET_MS = 1000     # an episode ends after this long without an overrun
_QUEUE_LONG_MS = 10000     # one still open this long is reported as it stands, then at its end
_QUEUE_TICK_MS = 250
_FOREVER = 1 << 62         # a `now` past every bound: the episode ends now
_queue_watch_lock = threading.Lock()     # the list and the state below
_queue_watches = []
_queue_watch = {"pipe": None, "tick": None, "added": 0, "removed": 0}


class _QueueWatch:
    """One watched queue: the streaming thread that meets it full writes the counts, the main loop
    owns the episode."""

    def __init__(self, queue, leaky):
        self.queue, self.name, self.leaky = queue, queue.get_name(), leaky
        self.overruns = self.first_us = self.last_us = 0
        self.level_us = self.level_ns = self.level_bytes = 0
        self.removed = False                 # left the pipeline: its episode ends at the next tick
        self.open = self.long_reported = False
        self.base = self.opened_us = 0
        self.input = None                    # the first unixfdsrc upstream when it opened
        self.handler = queue.connect("overrun", self._on_overrun)

    def _on_overrun(self, queue):
        now = GLib.get_monotonic_time()
        if not self.first_us:
            self.first_us = now
        self.last_us = now
        # The level it was full at, read at most once a second (the queue's lock is free while
        # it emits the signal); the episode keeps its highest, as a read can find it drained.
        if now - self.level_us >= 1_000_000:
            self.level_us = now
            self.level_ns = max(self.level_ns, queue.get_property("current-level-time"))
            self.level_bytes = max(self.level_bytes, queue.get_property("current-level-bytes"))
        self.overruns += 1


def _feeding_pad(sink):
    """The src pad feeding `sink` across ghost pads, or None."""
    peer = sink.get_peer()
    for _ in range(16):
        if peer is None:
            return None
        if isinstance(peer, Gst.GhostPad):            # a bin's src ghost: into the bin
            peer = peer.get_target()
        elif isinstance(peer, Gst.ProxyPad):          # the inside of a bin's sink ghost: out of it
            ghost = peer.get_parent()
            peer = ghost.get_peer() if isinstance(ghost, Gst.Pad) else None
        else:
            return peer
    return None


def _first_unixfdsrc(element, seen):
    """The name of the first unixfdsrc upstream of `element`: depth first, its sink pads in turn."""
    if element in seen or len(seen) >= 256:
        return None
    seen.add(element)
    it = element.iterate_sink_pads()
    while True:
        result, pad = it.next()
        if result == Gst.IteratorResult.OK:
            src = _feeding_pad(pad)
            up = src.get_parent_element() if src is not None else None
            if up is not None:
                factory = up.get_factory()
                if factory is not None and factory.get_name() == "unixfdsrc":
                    return up.get_name()
                found = _first_unixfdsrc(up, seen)
                if found:
                    return found
        elif result == Gst.IteratorResult.RESYNC:
            it.resync()
        else:
            return None


def _queue_overrun_report(w, total, last, ongoing):
    """The episode so far: each buffer that met the queue full (leaky: pushed an older one out)."""
    emit_plugin_event(QUEUE_OVERRUN_EVENT, {
        "element": w.name, "input": w.input, "leaky": w.leaky,
        "levelTimeMs": w.level_ns // 1_000_000, "levelBytes": w.level_bytes,
        "overruns": total - w.base, "ms": (last - w.opened_us) // 1000,
        "totalOverruns": total, "ongoing": ongoing})


def _queue_at_bound(q):
    """Whether `q` is at a bound now: a level at its nonzero maximum."""
    for k in ("buffers", "bytes", "time"):
        top = q.get_property("max-size-" + k)
        if top and q.get_property("current-level-" + k) >= top:
            return True
    return False


def _queue_watch_check(w, now):
    """Open an episode on a new overrun; close it after _QUEUE_QUIET_MS without one (`now` past
    every bound: close it now); one report while it is open past _QUEUE_LONG_MS."""
    total, last = w.overruns, w.last_us
    if not w.open:
        if total == w.base:
            return
        w.open, w.long_reported = True, False
        w.opened_us = w.first_us or last
        w.input = _first_unixfdsrc(w.queue, set()) if w.queue is not None else None
    if now - last >= _QUEUE_QUIET_MS * 1000:
        # A non-leaky queue met full once and below its bound since: one buffer's label jump (an
        # outage's), not a backlog, which meets it full on every buffer (B-177). A stop reports all.
        if (now >= _FOREVER or w.leaky or total - w.base > 1
                or (w.queue is not None and _queue_at_bound(w.queue))):
            _queue_overrun_report(w, total, last, False)
        w.open, w.base, w.first_us = False, total, 0
        w.level_us = w.level_ns = w.level_bytes = 0   # the next episode reads its own level
    elif not w.long_reported and now - w.opened_us >= _QUEUE_LONG_MS * 1000:
        _queue_overrun_report(w, total, last, True)
        w.long_reported = True


def _queue_watch_tick():
    now = GLib.get_monotonic_time()
    with _queue_watch_lock:
        live = list(_queue_watches)
    gone = []
    for w in live:
        removed = w.removed                  # a queue that left the pipeline ends as at a stop
        _queue_watch_check(w, _FOREVER if removed else now)
        if removed:
            gone.append(w)
    if gone:
        with _queue_watch_lock:
            for w in gone:
                _queue_watches.remove(w)
                w.queue = None
    return True


def _queue_watched(element):
    """The queue's `leaky` when the watch takes it (leaky, or one of the names), else None."""
    factory = element.get_factory()
    if factory is None or factory.get_name() != "queue":
        return None
    leaky = int(element.get_property("leaky"))
    return leaky if leaky != 0 or element.get_name() in WATCHED_QUEUE_NAMES else None


def _queue_watch_add(element):
    """Any thread: a queue of the pipeline, at start or added later (an edge, a live input)."""
    leaky = _queue_watched(element)
    if leaky is None:
        return
    with _queue_watch_lock:
        if _queue_watch["pipe"] is None or any(w.queue == element for w in _queue_watches):
            return
        _queue_watches.append(_QueueWatch(element, leaky))
        if _queue_watch["tick"] is None:
            _queue_watch["tick"] = GLib.timeout_add(_QUEUE_TICK_MS, _queue_watch_tick)


def _queue_watch_removed(_root, _bin, element):
    """Any thread: its queue left the pipeline, so no overrun comes after this."""
    with _queue_watch_lock:
        for w in _queue_watches:
            if w.queue == element and not w.removed:
                w.queue.disconnect(w.handler)
                w.removed = True


def _start_queue_watch(pipe):
    """Before PLAYING: watch every such queue of `pipe`, and each one added to it later."""
    _clear_queue_watch()
    with _queue_watch_lock:
        _queue_watch["pipe"] = pipe
    it = pipe.iterate_recurse()
    while True:
        result, element = it.next()
        if result == Gst.IteratorResult.OK:
            _queue_watch_add(element)
        elif result == Gst.IteratorResult.RESYNC:
            it.resync()
        else:
            break
    _queue_watch["added"] = pipe.connect("deep-element-added", lambda _r, _b, el: _queue_watch_add(el))
    _queue_watch["removed"] = pipe.connect("deep-element-removed", _queue_watch_removed)


def _clear_queue_watch():
    """Once the pipeline is in NULL (no streaming thread left): report each open episode, forget."""
    with _queue_watch_lock:
        tick, pipe = _queue_watch["tick"], _queue_watch["pipe"]
        handlers = (_queue_watch["added"], _queue_watch["removed"])
        _queue_watch.update(pipe=None, tick=None, added=0, removed=0)
        watches = list(_queue_watches)
        _queue_watches.clear()
    if tick is not None:
        GLib.source_remove(tick)
    if pipe is not None:
        for handler in handlers:
            pipe.disconnect(handler)
    for w in watches:
        _queue_watch_check(w, _FOREVER)
        if not w.removed:
            w.queue.disconnect(w.handler)


# `parser: "none"` on a pad-link rule: skip the codec parser and instead DECLARE
# the framing the demux already delivers. mrtsdemux emits one whole PES payload per
# buffer, and on this bus one PES is one access unit (ADR-0011), so the only
# thing the parser adds on such a branch is one frame of latency: h264parse
# closes an AU only when it sees the start of the NEXT one (measured 41 ms at
# 25 fps into the mpegts-muxer, 2026-09-04). mpegtsmux/avdec refuse bare
# `video/x-h264, stream-format=byte-stream` without an `alignment` field, so a
# capssetter adds `alignment=au` — a truthful claim for our producers, NOT for a
# foreign source whose PES framing is sloppy, which is why the option is opt-in
# per module and never the default. Cost of opting in: no SPS/PPS re-emission
# before every IDR (the parser's config-interval=-1) — the source must repeat
# them itself.
_AU_ALIGNED_CAPS = {
    'video/x-h264': 'video/x-h264,stream-format=byte-stream,alignment=au',
    'video/x-h265': 'video/x-h265,stream-format=byte-stream,alignment=au',
}


def _parser_prefix_for_pad(pad, rule_id, parser_mode="auto"):
    """Return the codec-parser prefix string (`'aacparse ! '`, or '') to prepend
    to a branch for this pad's caps, warning once per unknown codec. Shared by
    the single-branch and tee fan-out link paths. `parser_mode="none"` replaces
    a VIDEO parser with an `alignment=au` capssetter (see _AU_ALIGNED_CAPS);
    audio and unknown codecs are unaffected by the mode."""
    caps = pad.get_current_caps() or pad.query_caps(None)
    if parser_mode == "none" and caps and caps.get_size() > 0:
        au_caps = _AU_ALIGNED_CAPS.get(caps.get_structure(0).get_name() or '')
        if au_caps:
            emit_event({"event": "warning",
                        "message": f"linkOnPadAdded: parser bypass on {pad.get_name()} ({rule_id}) — declaring {au_caps}"})
            return f'capssetter caps="{au_caps}" ! '
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
                                  link_to_name,
                                  parser_mode="auto"):
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
        prefix = _parser_prefix_for_pad(pad, rule_id, parser_mode).removesuffix(" ! ")
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
      "parser": "auto"|"none",          # optional — "none" skips the injected codec
                                        # parser on VIDEO pads and declares
                                        # alignment=au instead (one frame less
                                        # latency; see _AU_ALIGNED_CAPS). Default auto.
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
    # Optional parser bypass (video only) — see _parser_prefix_for_pad.
    parser_mode = rule.get("parser") or "auto"

    def on_pad_added(_element, pad):
        if media_filter and _pad_caps_media(pad) != media_filter:
            return
        if match_pids:
            # Match this pad to its branch(es) by PID rather than arrival order.
            # A pad whose PID isn't wired to an output (extra source stream)
            # is simply ignored — never misrouted onto another branch.
            pad_pid = _pid_from_demux_pad_name(pad.get_name())
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
                                              link_to_name, parser_mode)
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
        branch_str = _parser_prefix_for_pad(pad, rule_id, parser_mode) + branches[index]
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
# Bus egress stamper — every egress stamped by identity, PES − 1 h
# ---------------------------------------------------------------------------
# The subsystem lives in `gst_bus_stamper.py` next to this file (the `mrtsstamp`
# splice, lazy arm/disarm per consumer edge, its bus messages). What stays here
# is the wiring: the emitter it reports through, and the consumer-edge
# bookkeeping only this file knows about (`_bus_branches`).
import gst_bus_stamper                                            # noqa: E402
import gst_rist_native                                            # noqa: E402
import gst_lateness_native                                        # noqa: E402
import gst_native_plugins                                         # noqa: E402

# A lambda, not the function object: the emitter is resolved on every event, so
# a test (or a future indirection) that replaces this module's `emit_event`
# still owns what the stamper emits.
gst_bus_stamper.set_emitter(lambda obj: emit_event(obj))


def _release_bus_stamper(tee_name):
    """Disarm `tee_name`'s stamper once its LAST consumer edge is gone.

    Held edges keep it armed, so one consumer of several detaching changes
    nothing. A tee that gets a consumer again later is stamped afresh (the element
    forgets the stream on every transition).

    Note the stall watchdog's in-place edge RESET goes through here too when
    the stalled edge is a tee's only one: that reset EOFs the zombie consumer
    so it respawns.
    """
    for entry in _bus_branches.values():
        if entry.get("tee_name") == tee_name:
            return
    gst_bus_stamper.release(tee_name)


def _apply_contract_clock(pipe, live_capture_clock=False):
    """Put `pipe` on the house clock and PIN its timeline (every pipeline).

    The one time base every process on the box agrees on is the monotonic
    system clock (§4.1). Two moves:

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
    construction — the identity stamp maps to running time `stamp - base_time`
    (`mrtsstamp`, `gst_mrtsstamp_clock_now`), and `unixfdsink`
    transmits `segment_to_running_time(pts) + base_time`, so the base-time
    cancels and the wire carries the same absolute house time either way. Only
    the pinning is skipped; the clock half is identical. Bus-fed producers
    (transcoder, mpegts-muxer) must NOT use it — their demux's PES − 1 h is house
    time only while running time is. See `PipelineDescription.liveCaptureClock`.

    Nothing external is contacted or waited for, so this can neither delay nor
    wedge a start.
    """
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    if live_capture_clock:
        sys.stderr.write("[gst-runner.py] contract clock: monotonic, base_time=natural (live capture)\n")
        return
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    sys.stderr.write("[gst-runner.py] contract clock: monotonic, base_time=0\n")


_runner_hooks = []      # python modules installed for the running pipeline


def _install_runner_hooks(pipe, hooks):
    """`hooks = [{"module": "<py module in a plugin's py/ dir>", "config": {...}}]`.
    Each module implements `install(pipeline, config, ctx)` and `clear()`.
    A hook that fails to import or install is reported and skipped — it must
    never take the media pipeline down."""
    global _runner_hooks
    _clear_runner_hooks()
    ctx = {"emit_event": emit_event, "emit_plugin_event": emit_plugin_event}
    for hook in hooks or []:
        name = (hook or {}).get("module")
        if not name:
            continue
        try:
            import importlib
            mod = importlib.import_module(name)
            mod.install(pipe, (hook or {}).get("config"), ctx)
            _runner_hooks.append(mod)
        except Exception as exc:  # noqa: BLE001 — a plugin hook fault is not a pipeline fault
            emit_event({"event": "warning", "message": f"runner hook '{name}' failed: {exc}"})


def _clear_runner_hooks():
    global _runner_hooks
    for mod in _runner_hooks:
        try:
            mod.clear()
        except Exception:  # noqa: BLE001
            pass
    _runner_hooks = []


# ---------------------------------------------------------------------------
# A PipeWire capture's streaming tasks at real-time priority (B-111)
# ---------------------------------------------------------------------------
# Each task from a `pipewiresrc` down to its mux runs SCHED_RR, granted by rtkit as
# module-rt's data loop is (B-88). Twin of mr-gst-runner's capture_rt.cpp.
# Below PipeWire's data loops (RR 20, rtkit's maximum): a cycle always preempts the capture.
CAPTURE_RT_PRIORITY = 19
# The RLIMIT_RTTIME bound, us: rtkit's RTTimeUSecMax, the limit module-rt sets (B-88).
CAPTURE_RT_RTTIME_US = 200000
# How long a request waits for rtkit's answer before it counts as refused.
CAPTURE_RT_TIMEOUT_MS = 5000
_RTKIT = "org.freedesktop.RealtimeKit1"
_capture_rt_lock = threading.Lock()   # the marks: written before PLAYING, read by entering tasks
_capture_rt_path = set()
# Main loop only: the requests run there, so no streaming thread waits on rtkit or the bus.
_capture_rt_refused = False
_capture_rt_bus = None
# Gio, imported at the first request: only a capture's runner pays its ~1 MB (False: no typelib).
_capture_rt_gio = None


def _capture_rt_mark(el):
    """`el` and everything downstream of it; a muxer ends its branch."""
    if el in _capture_rt_path:
        return
    _capture_rt_path.add(el)
    factory = el.get_factory()
    if factory is not None and factory.list_is_type(Gst.ELEMENT_FACTORY_TYPE_MUXER):
        return
    for pad in el.srcpads:
        peer = pad.get_peer()
        nxt = peer.get_parent_element() if peer is not None else None
        if nxt is not None:
            _capture_rt_mark(nxt)


def _install_capture_rt(pipe):
    """Mark every element from each `pipewiresrc` down to its first muxer, and ask rtkit for
    each of their tasks as it enters. A pipeline without a `pipewiresrc` asks nothing."""
    with _capture_rt_lock:
        it = pipe.iterate_recurse()
        while True:
            result, el = it.next()
            if result == Gst.IteratorResult.OK:
                factory = el.get_factory()
                if factory is not None and factory.get_name() == "pipewiresrc":
                    _capture_rt_mark(el)
            elif result == Gst.IteratorResult.RESYNC:
                it.resync()
            else:
                break
        if not _capture_rt_path:
            return
    bus = pipe.get_bus()
    bus.enable_sync_message_emission()
    bus.connect("sync-message::stream-status", _on_capture_stream_status)


def _clear_capture_rt():
    with _capture_rt_lock:
        _capture_rt_path.clear()


def _on_capture_stream_status(_bus, message):
    """On the entering task's own thread: its tid, then the request on the main loop."""
    kind, owner = message.parse_stream_status()
    if kind != Gst.StreamStatusType.ENTER:
        return
    with _capture_rt_lock:
        if owner not in _capture_rt_path:
            return
    GLib.idle_add(_capture_rt_request, threading.get_native_id(),
                  f"{owner.get_name()}:{message.src.get_name()}")


def _capture_rt_refuse(task, why):
    """Said once per runner; the capture runs on at normal priority."""
    global _capture_rt_refused
    if _capture_rt_refused:
        return
    _capture_rt_refused = True
    emit_event({"event": "warning", "message": f"real-time priority refused for {task} ({why}): "
                                               "the capture runs at normal priority"})


def _capture_rt_bound_rttime():
    """rtkit grants only to a process whose RLIMIT_RTTIME hard limit is within its maximum."""
    _soft, hard = resource.getrlimit(resource.RLIMIT_RTTIME)
    if hard != resource.RLIM_INFINITY and hard <= CAPTURE_RT_RTTIME_US:
        return None
    try:
        resource.setrlimit(resource.RLIMIT_RTTIME, (CAPTURE_RT_RTTIME_US, CAPTURE_RT_RTTIME_US))
    except (OSError, ValueError) as e:
        return f"RLIMIT_RTTIME: {e}"
    return None


def _capture_rt_request(tid, task):
    global _capture_rt_gio
    if _capture_rt_gio is None:
        try:
            from gi.repository import Gio
            _capture_rt_gio = Gio
        except ImportError:
            _capture_rt_gio = False
    why = "no Gio" if not _capture_rt_gio else _capture_rt_bound_rttime()
    if why:
        _capture_rt_refuse(task, why)
    elif _capture_rt_bus is not None:
        _capture_rt_call(tid, task)
    else:
        _capture_rt_gio.bus_get(_capture_rt_gio.BusType.SYSTEM, None, _capture_rt_on_bus, (tid, task))
    return False


def _capture_rt_on_bus(_source, res, req):
    global _capture_rt_bus
    try:
        bus = _capture_rt_gio.bus_get_finish(res)
    except GLib.Error as e:
        _capture_rt_refuse(req[1], e.message)
        return
    # The shared connection would SIGTERM the runner if the bus went away.
    bus.set_exit_on_close(False)
    _capture_rt_bus = bus
    _capture_rt_call(*req)


def _capture_rt_call(tid, task):
    """module-rt's call (B-88), inside the same rtkit limits."""
    _capture_rt_bus.call(_RTKIT, "/org/freedesktop/RealtimeKit1", _RTKIT, "MakeThreadRealtimeWithPID",
                         GLib.Variant("(ttu)", (os.getpid(), tid, CAPTURE_RT_PRIORITY)), None,
                         _capture_rt_gio.DBusCallFlags.NONE, CAPTURE_RT_TIMEOUT_MS, None, _capture_rt_on_reply,
                         task)


def _capture_rt_on_reply(bus, res, task):
    try:
        bus.call_finish(res)
    except GLib.Error as e:
        _capture_rt_refuse(task, e.message)
        return
    sys.stderr.write(f"[gst-runner.py] real-time: {task} at SCHED_RR {CAPTURE_RT_PRIORITY} (rtkit)\n")
    sys.stderr.flush()


def handle_start(data):
    """Start a GStreamer pipeline from a pipeline string."""
    global pipeline, loop, running, use_stdio_for_data, _pad_link_counts
    global klv_payloads, klv_timer_id, playing_watchdog_id, bus_reports, _drain_on_stop

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
    # Drain opt-out for audio-only bus producers; absent = drain.
    _drain_on_stop = data.get("eosDrain", True) is not False
    _live_input_branches.clear()
    _kept_agg_pads.clear()
    _live_input_branches.update(str(n) for n in (data.get("liveInputBranches") or []) if n)
    source_gate.live_branches = _live_input_branches
    _klv_garbage_warned.clear()

    if not pipeline_str:
        emit_event({"event": "error", "message": "No pipeline string provided"})
        return

    # Native RIST elements live in a plugin the runner loads by path (never
    # GST_PLUGIN_PATH) — must be registered before the parse sees their names.
    if "mrristsink" in pipeline_str or "mrristsrc" in pipeline_str:
        gst_rist_native.load_plugin()
    # The house-clock plugin, by path, before the parse: if it cannot be used, its elements get
    # stand-ins and the module alarms, or the start is refused (plan ch. 3 part 4.5 rule 6).
    gst_native_plugins.load(emit_event)
    pipeline_str = gst_native_plugins.stand_in(pipeline_str, emit_event)
    if pipeline_str is None:
        return

    try:
        pipeline = Gst.parse_launch(pipeline_str)
    except GLib.Error as e:
        emit_event({"event": "error", "message": f"Pipeline parse error: {e.message}"})
        return

    # The house clock, applied before PLAYING so the pipeline never runs on its
    # own auto-selected clock first. `liveCaptureClock` keeps the clock but lets
    # base-time anchor naturally (live capture head into an aggregator mux).
    _apply_contract_clock(pipeline, data.get("liveCaptureClock"))

    # Reset per-run pad counters and install dynamic-pad-link rules
    _pad_link_counts = {}
    for rule in pad_link_rules:
        _install_pad_link_rule(pipeline, rule)

    # The bus egress stamp, spliced before PLAYING so an attach landing the moment
    # the pipeline starts owns that edge's first buffer. It arms per tee as
    # consumers attach.
    gst_bus_stamper.enable(pipeline)

    # Install stream discovery on every distinct demux element the rules
    # reference, so the owning module sees an unfiltered `stream:discovered`
    # report per pad (PID + caps + media type) regardless of what's routed.
    # Connected once per element even when a demux has both a video and an
    # audio rule.
    for src_name in {rule.get("from") for rule in pad_link_rules if rule.get("from")}:
        el = pipeline.get_by_name(src_name)
        if el:
            _install_stream_discovery(el, src_name, read_klv_names)
    # Plugin-owned runner hooks (`runnerHooks`): a plugin ships python in its
    # own `py/` dir (on our PYTHONPATH) and names it here; we import it and
    # hand it the pipeline before PLAYING. The runner learns nothing about the
    # plugin's domain (ADR-0002).
    _install_runner_hooks(pipeline, data.get("runnerHooks"))

    # Set software-decoder threading. `max-threads` is always the core count;
    # `decoderThreadType` (default 'auto') decides whether to force FRAME
    # threading, the opt-in multi-core mode that relieves a pinned core on heavy
    # 4K software decode at the cost of ~130-160 ms latency — so it's never the
    # default on the live path. The pipeline string can't set this when the
    # decoder is plugged by `decodebin` (the element doesn't exist at parse
    # time), so we hook every avdec_* as it shows up — see the function for the
    # two-pronged tree-walk + `deep-element-added` strategy.
    _install_decoder_thread_hook(pipeline, decoder_thread_type)
    # No element drops a late buffer (P11), and each queue that fills reports its episodes (B-170).
    _install_no_late_drop(pipeline)
    _start_queue_watch(pipeline)

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

    # Set up bus watch
    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_bus_message)
    # A PipeWire capture's tasks ask for real-time priority as they enter (B-111).
    _install_capture_rt(pipeline)

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
    # Non-live heads (unixfdsrc / udpsrc) start the deadline at their first data
    # and udpsrc silence is watched from here on — gst_source_gate.py. A live
    # head keeps the blanket deadline.
    deferred = source_gate.start(pipeline, ret == Gst.StateChangeReturn.ASYNC, timeout_ms,
                                 data.get("udpSilenceRestartMs"))
    if timeout_ms > 0 and not deferred:
        playing_watchdog_id = GLib.timeout_add(timeout_ms, _on_playing_timeout)

    running = True
    # Which timing plugin this start loaded (None: none); the engine clears rule 6's alarm on
    # one, so a missing stamper plugin reports none.
    emit_event({"event": "started",
                "timingPlugin": None if gst_bus_stamper.missing() else gst_native_plugins.timing_plugin()})

def handle_stop(data=None):
    """Stop the pipeline.

    The deliberate-teardown path: the parent's `stop` command, a SIGTERM/SIGINT
    and a closed command pipe all land here. It EOS-drains before NULL — this
    is the path a codec-switch pipeline rebuild takes, i.e. the one that used
    to stop an actively-decoding pipeline (see EOS_DRAIN_TIMEOUT_MS).
    """
    global pipeline, running
    _cancel_playing_watchdog()
    source_gate.stop()
    _clear_pending_bus_attaches()
    _live_input_branches.clear()
    _kept_agg_pads.clear()
    gst_bus_stamper.clear()
    _clear_runner_hooks()
    _stop_rist()
    _stop_ts_probe()
    _stop_render_watch()
    _clear_capture_rt()
    if pipeline:
        _teardown_pipeline(pipeline)
        running = False
        emit_event({"event": "state_change", "state": "null"})
    # AFTER the teardown, not before: the drain reaches the decoder through the
    # gate's pad when the pipeline-level EOS can't travel (see
    # _drain_decoder_branch), and the gate is harmless during a drain — it only
    # ever touches buffers, never events.
    _stop_keyframe_gate()
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

    # A stand-in has none of the timing element's properties: the call is answered with a
    # warning carrying its id, so the request resolves (plan ch. 3 part 4.5 rule 6).
    if element_name in gst_native_plugins.stood_in:
        evt = {"event": "warning",
               "message": f"set_property {element_name}.{prop} ignored: a stand-in runs in its "
                          f"place (native TS module not loaded)"}
        if req_id:
            evt["id"] = req_id
        emit_event(evt)
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
# BusFanoutCoordinator attaches ONE `queue leaky=2` (time- AND byte-capped,
# ADR-0015) `! unixfdsink` branch per
# consumer edge at runtime. This is the isolation the shared unixfdsink lacked:
# unixfdsink sends under its object lock with blocking sockets, so a shared
# sink froze every sibling when one consumer stalled; a per-consumer branch
# with a leaky queue sheds only its own buffers, so a consumer that restarts,
# crash-loops, or stalls in preroll can never back up the producer or a sibling.
# It stays leaky=2 (OQ-30): a full one is a resource fault the queue watch reports, not a
# lateness drop; the R10 checklist's one runner-built leaky queue (B-173).
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
# Per-consumer edge queue bounds (ADR-0015). The byte ceiling is the
# timestamp-independent backstop next to the time bound: `queue` measures its
# time level from the stamps passing through it, so a stalled or stepped-back
# timeline leaves a time-only leaky queue unbounded. Working hypothesis for
# the gate01 2026-09-06 muxer growth (~2.8 GB each at program bitrate) —
# unconfirmed on the box, see docs/TodoNotes.md. Rate mirrors
# `TS_QUEUE_BYTES_PER_MS` in the engine's queueBounds.ts (64 Mbit/s).
# The TIME bound is 5 s, not the 500 ms the byte cap is sized for: `queue`
# reads its time level off the stamps passing through it, so a forward stamp
# step of more than the bound — every producer re-anchor that moves the
# timeline later (a late-level correction, a source restart) — reads as a full
# queue for one buffer and the leak drops it: one dropped bus buffer per
# re-anchor, a CC break on every PID in it, DISCONT, and the consumer's
# keyframe gate paying a GOP (the Pi 5 test box, 2026-09-08 13:02-13:15: one
# CC break per re-anchor, measured on the bus with the wire clean). 5 s is past any step
# the stamper corrects in place (its conditioner absorbs up to 10 s and marks
# a larger one a restart); a stalled consumer still sheds here, at 5 s of its
# stream or the byte cap, whichever comes first, and never back-pressures the
# producer.
BUS_EDGE_QUEUE_MS = 5_000
BUS_EDGE_QUEUE_BYTES_MS = 500
BUS_EDGE_QUEUE_BYTES_PER_MS = 8_000
BUS_EDGE_QUEUE_MAX_BYTES = BUS_EDGE_QUEUE_BYTES_MS * BUS_EDGE_QUEUE_BYTES_PER_MS


def bus_edge_branch_description(socket):
    """gst-launch description of one per-consumer fan-out branch.

    `queue leaky=2` (5 s, byte-capped at 500 ms of 64 Mbit/s) ! `unixfdsink` on `socket`, its private
    bind path, published at the consumer's edge socket (B-190). A pure function so the shape is
    unit-testable — see `_try_bus_attach` for why every property here is load-bearing.
    """
    return (
        f"queue leaky=2 max-size-time={BUS_EDGE_QUEUE_MS * 1_000_000} max-size-buffers=0"
        f" max-size-bytes={BUS_EDGE_QUEUE_MAX_BYTES}"
        f" ! unixfdsink socket-path={socket} sync=false async=false"
        " wait-for-connection=false"
    )
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
# Edges whose probe-gated teardown hasn't completed yet, socket -> entry (see
# _teardown_bus_branch): an attach for one waits on the 250 ms pending retry. Main
# loop only (B-193): a probe on a streaming thread hands its record over.
_bus_teardowns = {}

# Edge path ownership (B-190), as in bus_edges.cpp: unixfdsink never binds over a file and
# unlinks its socket-path at stop, whoever owns it then, so the sink binds a private path published
# at the edge path with link(2), and a runner unlinks only its own socket's path.
_bus_attach_held_logged = set()   # pending sockets whose held path was warned about once


def _bus_bind_path(socket):
    """The sink's private bind path: unique to this process, beside the edge path."""
    return f"{socket}.{os.getpid()}"


def _bus_path_held(socket_path):
    """None when the edge path is free: absent, or a file nothing listens on (a
    runner that died hard) removed. Otherwise what holds it — an old runner
    still draining, or a second producer on one path."""
    if not os.path.lexists(socket_path):
        return None
    probe = pysocket.socket(pysocket.AF_UNIX, pysocket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(socket_path)
        return f"live producer already on {socket_path}"
    except OSError:
        pass
    finally:
        probe.close()
    try:
        os.unlink(socket_path)
        emit_event({"event": "warning", "message": f"bus_attach: unlinked stale bus socket {socket_path}"})
    except FileNotFoundError:
        pass
    except OSError as e:
        return f"stale bus socket {socket_path} cannot be removed ({e.strerror})"
    return None


def _bus_publish(bind, socket, entry):
    """Publish the started sink's socket at the edge path. Raises OSError
    (FileExistsError: another socket took the path since `_bus_path_held`)."""
    st = os.lstat(bind)
    os.link(bind, socket)
    entry["path_id"] = (st.st_dev, st.st_ino)
    try:
        os.unlink(bind)
    except OSError:
        pass


_bus_release_lock = threading.Lock()   # a teardown probe and a stop may release one path at once


def _release_bus_path(socket, entry):
    """Unlink the edge path if it still names this runner's socket. Called while
    the sink still listens, so a successor finds the path live or gone, never
    stale, and cannot replace it between the check and the unlink."""
    with _bus_release_lock:
        path_id = entry.pop("path_id", None)
        if path_id is None:
            return
        try:
            st = os.lstat(socket)
            if (st.st_dev, st.st_ino) == path_id:
                os.unlink(socket)
        except OSError:
            pass


def _release_bus_paths():
    """Every edge path this runner still owns, edges still detaching included,
    before its pipeline stops: a relaunched producer can take the paths over
    during the EOS drain, and a stopped pipeline may never fire a pending probe."""
    for socket, entry in _bus_branches.items():
        _release_bus_path(socket, entry)
    for socket, entry in _bus_teardowns.items():
        _release_bus_path(socket, entry)


def _try_bus_attach(tee_name, socket):
    """Attach one branch. True when done (attached, or a structural failure not
    worth retrying), False while the pipeline or tee isn't up yet, or a str
    saying what holds the edge path (B-190); both of those stay pending."""
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
    _, st_cur, st_pend = pipeline.get_state(0)
    if (st_pend if st_pend != Gst.State.VOID_PENDING else st_cur) < Gst.State.READY:
        return False  # a stopped pipeline
    tee = pipeline.get_by_name(tee_name)
    if tee is None:
        return False  # tee not created yet — caller queues a retry
    # Never bind beside a live listener (B-190): wait until the path is free.
    held = _bus_path_held(socket)
    if held is not None:
        return held
    bind = _bus_bind_path(socket)
    if len(bind) >= 108:   # sizeof(sockaddr_un.sun_path)
        emit_event({"event": "warning", "message": f"bus_attach: socket path too long: {bind}"})
        return True
    # Arm the egress stamper BEFORE the branch is linked (no-op unless the
    # time-sync contract is on, or the tee is already armed for an earlier
    # consumer): once linked, buffers reach the new edge immediately, and one
    # that slipped past an unarmed probe would carry an arrival time onto the
    # wire. The structural-failure paths below release it again.
    gst_bus_stamper.arm(tee, tee_name)
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
        # feed (measured on TECH01 bus 40000: 10 CC errors/min on the bus vs 1
        # on the wire, engine librist lost=0). 500 ms absorbs the worst
        # observed hold (~253 ms) with 2x headroom; memory cost is trivial
        # (≈340 KB at 5.4 Mbps). Still leaky=2 — a genuinely stalled consumer
        # must shed here, never back-pressure the producer. The byte cap
        # (BUS_EDGE_QUEUE_MAX_BYTES) is what still sheds when stalled stamps
        # blind the time bound.
        branch = Gst.parse_bin_from_description(
            bus_edge_branch_description(bind), True
        )
        _bus_branch_seq += 1
        branch.set_name(f"busedge_{_bus_branch_seq}")
        # Bind and publish before the branch joins the pipeline: a failed start
        # then posts to no bus, so it can never fail the producer.
        entry = {}
        try:
            os.unlink(bind)
        except OSError:
            pass
        try:
            if branch.set_state(Gst.State.READY) == Gst.StateChangeReturn.FAILURE:
                raise OSError("bind failed")
            _bus_publish(bind, socket, entry)
        except OSError as e:
            branch.set_state(Gst.State.NULL)
            _release_bus_stamper(tee_name)
            if isinstance(e, FileExistsError):
                return f"{socket} was taken by another socket"
            emit_event({"event": "warning",
                        "message": f"bus_attach: cannot serve {socket}: {e.strerror or e}"})
            return True
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
            _release_bus_path(socket, entry)
            branch.set_state(Gst.State.NULL)
            parent.remove(branch)
            _release_bus_stamper(tee_name)
            return True  # don't retry a structural failure
        link_ret = tee_src.link(branch.get_static_pad("sink"))
        if link_ret != Gst.PadLinkReturn.OK:
            emit_event({"event": "warning",
                        "message": f"bus_attach: link failed ({link_ret}) {socket}"})
            tee.release_request_pad(tee_src)
            _release_bus_path(socket, entry)
            branch.set_state(Gst.State.NULL)
            parent.remove(branch)
            _release_bus_stamper(tee_name)
            return True
        entry.update({"branch": branch, "tee": tee, "tee_src": tee_src,
                      "tee_name": tee_name, "queue": None, "sink_pad": None,
                      "progressed": False, "stall": 0, "probe_id": None,
                      "soft_healed": False})
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

def _note_bus_attach_held(socket, held):
    """One warning per pending attach while its path is held, so a second live
    producer on one path (a configuration error) never spins silently."""
    if socket not in _bus_attach_held_logged:
        _bus_attach_held_logged.add(socket)
        emit_event({"event": "warning", "message": f"bus_attach: {held} — attach waits until the path is free"})


def _note_bus_attach_done(socket):
    if socket in _bus_attach_held_logged:
        _bus_attach_held_logged.discard(socket)
        if socket in _bus_branches:
            sys.stderr.write(f"[gst-runner.py] bus_attach: {socket} free again — attached\n")


def _retry_pending_bus_attaches():
    global _bus_retry_timer_id
    for socket in list(_pending_bus_attaches.keys()):
        tee_name, attempts = _pending_bus_attaches[socket]
        res = _try_bus_attach(tee_name, socket)
        if res is True:
            _pending_bus_attaches.pop(socket, None)
            _note_bus_attach_done(socket)
        elif isinstance(res, str):
            _note_bus_attach_held(socket, res)
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
    the edge's previous branch is still mid-teardown, or its path is held)."""
    global _bus_retry_timer_id
    res = _try_bus_attach(tee_name, socket)
    if res is True:
        _pending_bus_attaches.pop(socket, None)
        _note_bus_attach_done(socket)
        return
    _pending_bus_attaches[socket] = [tee_name, 0]
    if isinstance(res, str):
        _note_bus_attach_held(socket, res)
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
    """Drop queued attaches (pipeline stop). Edges still detaching stay recorded, for
    _release_bus_paths."""
    _pending_bus_attaches.clear()
    _bus_attach_held_logged.clear()


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
    (TECH01, 2026-07-16 21:37). Reproduced 5/5 at ~500 pkt/s with the naked
    teardown; 5/5 clean with this probe (repro5.py, 2026-07-17).
    BLOCK_DOWNSTREAM intercepts between buffers when flowing; IDLE fires
    immediately when the pad is quiet, so a dark producer detaches at once.

    The actual teardown is therefore ASYNCHRONOUS. `_bus_teardowns` marks
    the edge until the probe has finished and the main loop has dropped the
    record (B-193); `_try_bus_attach` treats a mid-teardown
    socket as "not ready yet" (returns False → caller's 250 ms retry), so
    a fast detach→attach on the same edge path can't bind over the dying
    branch's socket or double-request the tee pad.
    """
    # Cancel a not-yet-satisfied attach for this edge, if any.
    _pending_bus_attaches.pop(socket, None)
    _bus_attach_held_logged.discard(socket)
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
            # While the sink still listens; its own stop unlinks only the
            # private bind path.
            _release_bus_path(socket, entry)
            peer = pad.get_peer()
            if peer is not None:
                pad.unlink(peer)
            branch.set_state(Gst.State.NULL)
            parent = branch.get_parent()
            if parent is not None:
                parent.remove(branch)
            # Release the request pad from the main loop, not from its own
            # probe (validated in repro5; avoids re-entering the tee under
            # the probe's pad lock).
            GLib.idle_add(_release_tee_pad, tee, pad)
            emit_event({"event": "bus_detached", "socket": socket})
        except Exception:  # noqa: BLE001 — teardown must never crash the runner
            pass
        finally:
            # An idle pad fires this inside add_probe, on the main loop; a streaming
            # thread hands the record to the main loop instead (B-193).
            if GLib.MainContext.default().is_owner():
                _drop_bus_teardown(socket, entry)
            else:
                GLib.idle_add(_drop_bus_teardown, socket, entry)
        return Gst.PadProbeReturn.REMOVE

    _bus_teardowns[socket] = entry
    try:
        tee_src.add_probe(
            Gst.PadProbeType.BLOCK_DOWNSTREAM | Gst.PadProbeType.IDLE, _finish)
    except Exception:  # noqa: BLE001 — pad already dead: fall back to direct teardown
        _bus_teardowns.pop(socket, None)
        try:
            _release_bus_path(socket, entry)
            branch.set_state(Gst.State.NULL)
            parent = branch.get_parent()
            if parent is not None:
                parent.remove(branch)
            emit_event({"event": "bus_detached", "socket": socket})
        except Exception:  # noqa: BLE001
            pass
    return True


def _drop_bus_teardown(socket, entry):
    """Forget a finished teardown (main loop): its own record only, never a later teardown's."""
    if _bus_teardowns.get(socket) is entry:
        del _bus_teardowns[socket]
    return False  # one-shot idle source


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


def _branch_src_pad(bin_):
    """The branch's src pad: "src" when ghosted here (a live add), the parser's
    "ghost<N>" on a start-time bin; a non-live mixer waits on a pad left behind."""
    pad = bin_.get_static_pad("src")
    if pad is not None:
        return pad
    res, pad = bin_.iterate_src_pads().next()
    return pad if res == Gst.IteratorResult.OK else None


def _is_aggregator(el):
    """A GstAggregator (audiomixer, mpegtsmux, ...), by GType name: no GstBase typelib needed."""
    try:
        return el.__gtype__.is_a(GObject.type_from_name("GstAggregator"))
    except RuntimeError:            # no aggregator class registered yet
        return False


def _take_kept_pad(agg):
    """The kept pad of `agg` while it is still one of its sink pads, else None."""
    pad = _kept_agg_pads.pop(agg.get_name(), None)
    return pad if pad is not None and pad.get_parent() is agg else None


def _remove_live_bin(bin_, agg=None):
    """Stop the branch (the pushing side — NULL ends its thread; no pad probe,
    one on its own src pad would deadlock the NULL join), unlink it, release
    the aggregator's request pad (`agg` when given must own it) or keep it when
    it is the aggregator's last, drop the bin."""
    # Its heads leave the data wait first: neither pending first-data nor a
    # polled socket may fire for a branch that is being taken away.
    source_gate.forget_sources_in(bin_)
    bin_.set_state(Gst.State.NULL)
    src = _branch_src_pad(bin_)
    agg_pad = src.get_peer() if src is not None else None
    if src is not None and agg_pad is not None:
        src.unlink(agg_pad)
    if agg_pad is not None:
        owner = agg_pad.get_parent()
        if isinstance(owner, Gst.Element) and (agg is None or owner is agg):
            name = owner.get_name()
            if _is_aggregator(owner) and owner.numsinkpads <= 1 and name not in _kept_agg_pads:
                _kept_agg_pads[name] = agg_pad
                sys.stderr.write(f"[gst-runner.py] live input: last pad of {name} kept for the next add "
                                 f"({agg_pad.get_name()})\n")
            else:
                owner.release_request_pad(agg_pad)
    parent = bin_.get_parent()
    if isinstance(parent, Gst.Bin):
        parent.remove(bin_)


def _live_branch_ancestor(obj):
    """Name of the live input branch bin above `obj` (a bus message source),
    or None when it is not inside one."""
    if not _live_input_branches:
        return None
    cur = obj
    while cur is not None:
        name = cur.get_name() if hasattr(cur, "get_name") else None
        if name in _live_input_branches:
            return name
        cur = cur.get_parent()
    return None


def _drop_live_branch(name):
    """Drop a live input branch by name (its producer died under it). True
    when it existed."""
    _live_input_branches.discard(name)
    if not pipeline:
        return False
    bin_ = pipeline.get_by_name(name)
    if bin_ is None:
        return False
    _remove_live_bin(bin_)
    return True


def handle_bus_input_add(data):
    """Add one input branch bin to a running aggregator (tracked, idempotent).
    Tail src pad ghosted by hand: auto-ghosting would claim the capsfilter's
    unlinked sink pad behind tsdemux's delayed link."""
    req_id = data.get("id")
    element = data.get("element", "")
    name = data.get("name", "")
    desc = data.get("description", "")
    if not pipeline:
        emit_command_error(req_id, "bus_input_add: no pipeline")
        return
    if not element or not name or not desc:
        emit_command_error(req_id, "bus_input_add: element, name and description required")
        return
    if pipeline.get_by_name(name) is not None:
        # Idempotent: already there (built at start, or the producer-PLAYING
        # re-link and the connection re-apply raced for the same edge) — that
        # IS the requested state; an error made the engine restart the module.
        _live_input_branches.add(name)
        sys.stderr.write(f"[gst-runner.py] bus_input_add: {name} already present — no-op\n")
        emit_event({"event": "bus_input_add_done", "id": req_id, "name": name})
        return
    agg = pipeline.get_by_name(element)
    if agg is None:
        emit_command_error(req_id, f"bus_input_add: element '{element}' not found")
        return
    try:
        bin_ = Gst.parse_bin_from_description(desc, False)
    except GLib.Error as e:
        # Live adds are never stood in (B-17): an unloaded plugin's element names the alarm.
        emit_event(gst_native_plugins.refuse_live_add(
            req_id, desc, f"bus_input_add: parse failed: {e.message}"))
        return
    bin_.set_name(name)
    tail = bin_.find_unlinked_pad(Gst.PadDirection.SRC)
    if tail is None:
        emit_command_error(req_id, f"bus_input_add: branch '{name}' has no unlinked src pad")
        return
    ghost = Gst.GhostPad.new("src", tail)
    ghost.set_active(True)
    bin_.add_pad(ghost)
    # Same parent bin as the aggregator (a cross-bin link cannot be made).
    parent = agg.get_parent()
    if not isinstance(parent, Gst.Bin):
        parent = pipeline
    parent.add(bin_)
    # The aggregator's kept last pad first (B-208), else a new request pad.
    agg_pad = _take_kept_pad(agg)
    kept = agg_pad is not None
    if agg_pad is None:
        agg_pad = agg.request_pad_simple("sink_%u")
    if agg_pad is None:
        parent.remove(bin_)
        emit_command_error(req_id, f"bus_input_add: no request pad on '{element}'")
        return
    link = ghost.link(agg_pad)
    if link != Gst.PadLinkReturn.OK:
        if kept:
            _kept_agg_pads[agg.get_name()] = agg_pad     # still its last pad: kept for the next add
        else:
            agg.release_request_pad(agg_pad)
        parent.remove(bin_)
        emit_command_error(req_id, f"bus_input_add: link failed ({link})")
        return
    # Link first, then run: a source-headed branch pushes the moment it is
    # PLAYING, and its sticky events need the peer to exist.
    bin_.sync_state_with_parent()
    _live_input_branches.add(name)
    on_kept = f" on its kept pad {agg_pad.get_name()}" if kept else ""
    sys.stderr.write(f"[gst-runner.py] bus_input_add: {name} -> {element}{on_kept}\n")
    emit_event({"event": "bus_input_add_done", "id": req_id, "name": name})


def handle_bus_input_remove(data):
    """Remove the input branch bin `name` from the running aggregator (tracked, idempotent)."""
    req_id = data.get("id")
    element = data.get("element", "")
    name = data.get("name", "")
    if not pipeline:
        emit_command_error(req_id, "bus_input_remove: no pipeline")
        return
    if not element or not name:
        emit_command_error(req_id, "bus_input_remove: element and name required")
        return
    bin_ = pipeline.get_by_name(name)
    if bin_ is None:
        # Idempotent: already gone (dropped as input_branch_lost when its
        # producer died) — the requested state; an error made the engine
        # restart the module over nothing.
        _live_input_branches.discard(name)
        sys.stderr.write(f"[gst-runner.py] bus_input_remove: {name} already gone — no-op\n")
        emit_event({"event": "bus_input_remove_done", "id": req_id, "name": name})
        return
    agg = pipeline.get_by_name(element)
    if agg is None:
        emit_command_error(req_id, f"bus_input_remove: element '{element}' not found")
        return
    _remove_live_bin(bin_, agg)
    _live_input_branches.discard(name)
    sys.stderr.write(f"[gst-runner.py] bus_input_remove: {name} removed from {element}\n")
    emit_event({"event": "bus_input_remove_done", "id": req_id, "name": name})


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
# Receiver: max packets folded into one appsrc push (32 x 1316 B = 42 KB).
_RIST_READ_BATCH = 32


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
                    # librist's data-out thread releases packets in 5 ms
                    # batches; drain what is ALREADY released (timeout 0, no
                    # waiting) and push the batch as one 188-aligned buffer.
                    # Cuts the per-packet Python/GObject push overhead ~6x at
                    # typical rates without adding latency.
                    chunks = [data]
                    try:
                        while len(chunks) < _RIST_READ_BATCH:
                            more = ctx.read(0)
                            if not more:
                                break
                            chunks.append(more)
                    except librist.RistError:
                        pass  # surfaces on the next blocking read
                    buf = Gst.Buffer.new_wrapped(chunks[0] if len(chunks) == 1 else b"".join(chunks))
                    try:
                        element.push_buffer(buf)   # GstApp method, no signal marshalling
                    except Exception:  # noqa: BLE001 — teardown race
                        pass

            _rist_thread = threading.Thread(
                target=_push_loop, daemon=True, name="rist-reader")
        else:
            # appsink → librist. Properties are set here (not in the pipeline
            # string) so the drain contract can't drift: bounded + dropping +
            # unsynced. data_write only copies into librist's own buffers, so
            # the streaming thread is never held hostage.
            #
            # Drained by a dedicated thread with try_pull_sample() rather than
            # the `new-sample` signal: at bus rates (~1200 buffers/s at
            # 12 Mbit/s) the GObject signal round trip into Python and the
            # `pull-sample` emit back out cost more than the write itself, and
            # they ran ON the streaming thread. The blocking pull releases the
            # GIL; the streaming thread just queues into the appsink.
            if not _GSTAPP_AVAILABLE:
                emit_event({"event": "error",
                            "message": "GstApp typelib unavailable — python RIST sender drain cannot run"})
                return False
            element.set_property("emit-signals", False)
            element.set_property("sync", False)
            element.set_property("max-buffers", 64)
            element.set_property("drop", True)
            _rist_stop.clear()

            def _drain_loop():
                while not _rist_stop.is_set():
                    smp = element.try_pull_sample(200 * Gst.MSECOND)
                    if smp is None:
                        # Timeout or flushing → re-check stop. Before PLAYING
                        # and after EOS the pull returns immediately, so only
                        # then pay for the property read and back off.
                        if element.get_property("eos"):
                            _rist_stop.wait(0.2)
                        continue
                    buf = smp.get_buffer()
                    # extract_dup is one C memcpy into a bytes object; the
                    # map()/bytes(mi.data)/unmap() route costs ~5x more per
                    # buffer in PyGObject (51 vs 9 us on a Pi 4).
                    data = buf.extract_dup(0, buf.get_size())
                    try:
                        if len(data) <= _RIST_WRITE_CHUNK:
                            ctx.write(data)
                        else:
                            for off in range(0, len(data), _RIST_WRITE_CHUNK):
                                ctx.write(data[off:off + _RIST_WRITE_CHUNK])
                    except librist.RistError:
                        pass  # transient send failure — recovery is librist's job

            _rist_thread = threading.Thread(
                target=_drain_loop, daemon=True, name="rist-writer")

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
    SPS byte-compare alive at ~1.5% duty on a 30 Mbps feed. Bus buffers are
    whole TS packets (one access unit each under ADR-0011, 1316 B chunks
    from relay producers); a misaligned buffer yields nothing from
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

    def _emit_pmt(pmt):
        # Whole PMT + raw ES descriptor loops as hex (same shape as the
        # splitter's `tssplit:discovered`) for descriptor-only facts.
        es_info = pmt.get("es_info") or {}
        emit_plugin_event("tsprobe:pmt", {
            "programNumber": pmt.get("program_number"),
            "pcrPid": pmt.get("pcr_pid", -1),
            "streams": [{"pid": pid, "streamType": stype,
                         "esInfo": bytes(es_info.get(pid, b"")).hex()}
                        for pid, stype in pmt["streams"]],
        })

    def _on_pmt():
        _emit_pmt(st["disc"].pmt)
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
    pace = pipe.get_by_name(cfg["pace"]) if cfg.get("pace") else None
    if cfg.get("pace") and pace is None:
        emit_event({"event": "error",
                    "message": f"renderWatch: pace not found: {cfg.get('pace')!r}"})
        return False

    st = {"pad": pad, "sink": sink, "frames": 0, "mon": RenderLagMonitor(),
          "probe_id": None, "timer_id": None, "prev_stats": None, "pace": pace,
          "prev_drops": None}

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

    def _pace_drops():
        # The pace's rate drops this window: frames a slower display takes no more of, kept up
        # (B-169). 0 without a pace, or with a stand-in that has no stats.
        try:
            total = st["pace"].get_property("stats").get_value("rate-drops")
        except Exception:  # noqa: BLE001
            return 0
        prev, st["prev_drops"] = st["prev_drops"], total
        return total - prev if prev is not None and total >= prev else 0

    def _tick():
        arrivals = st["frames"]
        st["frames"] = 0
        paced = _pace_drops() if st["pace"] is not None else 0
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
        arrivals += paced
        achieved += paced
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
# Non-live source heads — lives in gst_source_gate.py
# ---------------------------------------------------------------------------
import gst_source_gate as source_gate                       # noqa: E402
# Data-gated PLAYING deadline and udpsrc silence. Configured here, once every
# callable it needs exists; `emit_event` late-bound (the suites swap it).
source_gate.configure(lambda obj: emit_event(obj), _fail_pipeline, _arm_playing_watchdog,
                      lambda: pipeline)


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
    unprotected against loss LATER in the stream — a gap, or the bus
    backstop's shed at its capacity (the ES queue has been non-leaky since
    B-169; when this was written it shed its oldest buffers whenever the
    decoder stalled at startup). The AUs lost are the ones right after the
    keyframe the gate just let through, so the
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


def _stop_keyframe_gate():
    """Take the gate probe off the pad. The probe never self-removes (it has to
    survive to re-arm), so this is the only thing that ever detaches it."""
    global _keyframe_gate
    st = _keyframe_gate
    _keyframe_gate = None
    if not st or st["probe_id"] is None:
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
    "bus_input_add": handle_bus_input_add,
    "bus_input_remove": handle_bus_input_remove,
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

    # By path, before any pipeline: every bus fragment may name `mrlateness`.
    gst_lateness_native.load_plugin()
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
