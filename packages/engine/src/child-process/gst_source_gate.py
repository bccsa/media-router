"""Source gate — the two non-live heads and what the runner does about them.

`unixfdsrc` and `udpsrc` are NOT live sources (measured: both sit ASYNC in
PAUSED until their first buffer). Under the runner's blanket "reached PLAYING"
watchdog that made every dark input a 10 s restart loop: a bus consumer whose
producer is silent (an interlock-disabled encoder, a caller whose peer is down)
or a UDP input whose sender is quiet was torn down and rebuilt for ever, each
rebuild destroying every consumer edge socket, re-creating PipeWire streams and
flooding journald (SCC French master, 2026-09-15: 940 rebuilds/hour for two
dark inputs). ADR-0010 rule 3 + its UDP amendment.

Two mechanisms, one module (they share the probe/idle discipline and the
teardown):

DATA WAIT — for a pipeline whose PLAYING request came back ASYNC and whose head
is unixfdsrc/udpsrc, the PLAYING deadline starts when EVERY such source has
delivered its first buffer, not at start. Until then the pipeline waits
passively (sink built and corked, nothing spawned, nothing torn down). A bus
consumer reports `waiting_for_data` once after the watchdog period (the engine
turns it into the same "Waiting for upstream module" health warning as the
socket gate and clears it on `data_arrived`); a UDP head leaves the warning to
the silence watch below so it is reported exactly once. Once all data flows the
same deadline as before applies — a wedge WITH data is still a wedge.

While waiting, the unixfd socket paths are polled every `DATA_WAIT_POLL_MS`: a
parked unixfdsrc never surfaces its peer closing (measured on .103: a producer
restarting under it re-created the edge socket three times while the consumer
sat on the dead one, and the returning feed went to the new socket for ever).
Gone or re-created means this pipeline can never get data — it fails out as
`bus_producer_restarted` and the normal restart reconnects it. Bounded by
producer restarts, never a timer.

UDP SILENCE — `udpsrc` posts `GstUDPSrcTimeout` every `timeout` of silence. The
first one after start or after data emits `input_silent` once (health warning
+ Waiting badge), the first buffer back emits `input_resumed`; the pipeline is
never rebuilt for a quiet sender. The one legitimate rebuild is a MULTICAST
membership lost across a network blip, so a producer may declare
`udpSilenceRestartMs` (mpegts-ip-input, aes67-input: 60 s, multicast only) past
which the old `udp_timeout` error and restart still apply.

Wired by the runner: `configure()` once, `start()` after set_state(PLAYING),
`on_playing()` on the PLAYING state-change, `on_udp_timeout()` on the element
message, `stop()` from every teardown path. Pinned by
gst_playing_watchdog_data_gate_test.py and gst_udp_silence_test.py.
"""
import os
import time

import gi
gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

DATA_WAIT_POLL_MS = 2000
NON_LIVE_FACTORIES = ("unixfdsrc", "udpsrc")

_emit = None            # runner.emit_event
_fail = None            # runner._fail_pipeline(event) — emit + teardown + quit
_arm_deadline = None    # runner._arm_playing_watchdog(timeout_ms)
_pipeline = None        # callable → the runner's current pipeline (or None)

data_wait = None        # dict while waiting for first data (see start)
udp_silence = None      # dict while a udpsrc head is watched for silence/resume


def configure(emit_event, fail_pipeline, arm_deadline, pipeline_getter):
    global _emit, _fail, _arm_deadline, _pipeline
    _emit, _fail, _arm_deadline, _pipeline = emit_event, fail_pipeline, arm_deadline, pipeline_getter


def sources_by_factory(pipe, factory_name):
    """The pipeline's source elements made by `factory_name`."""
    out = []
    it = pipe.iterate_sources()
    while True:
        result, el = it.next()
        if result == Gst.IteratorResult.OK:
            f = el.get_factory()
            if f is not None and f.get_name() == factory_name:
                out.append(el)
        elif result == Gst.IteratorResult.RESYNC:
            it.resync()
            out = []
        else:
            break
    return out


def _probe_src_pads(elements, callback):
    """One BUFFER/BUFFER_LIST probe per element src pad; returns [(pad, id)]."""
    probes = []
    for el in elements:
        pad = el.get_static_pad("src")
        if pad is not None:
            probes.append((pad, pad.add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST,
                                              callback, el)))
    return probes


def _remove_probes(probes):
    for pad, pid in probes:
        try:
            pad.remove_probe(pid)
        except Exception:  # noqa: BLE001 — a disposed pad has no probes left
            pass


def _remove_source(key, state):
    if state.get(key) is not None:
        GLib.source_remove(state[key])
        state[key] = None


def _socket_identity(path):
    """(inode, device, ctime) of a socket path, or None — a re-created socket
    changes at least the ctime even if the inode number is reused."""
    try:
        st = os.stat(path)
        return (st.st_ino, st.st_dev, st.st_ctime_ns)
    except OSError:
        return None


# --------------------------------------------------------------------------- start / stop

def start(pipe, ret_async, timeout_ms, udp_restart_ms):
    """Called right after set_state(PLAYING). Returns True when the PLAYING
    deadline is deferred to first data (the caller must NOT arm it now)."""
    stop()
    _arm_udp_silence(pipe, udp_restart_ms)
    if not ret_async or timeout_ms <= 0:
        return False
    srcs = [el for name in NON_LIVE_FACTORIES for el in sources_by_factory(pipe, name)]
    if not srcs:
        return False
    _defer_deadline_until_data(srcs, timeout_ms)
    return True


def stop():
    """Every teardown path: drop both watches. Returns True when a
    `waiting_for_data` warning was standing (the caller may report it cleared)."""
    warned = _clear_data_wait()
    _clear_udp_silence()
    return warned


def on_playing():
    """PLAYING state-change: the wait is over by definition."""
    if _clear_data_wait():
        _emit({"event": "data_arrived"})


# --------------------------------------------------------------------------- data wait

def _defer_deadline_until_data(srcs, timeout_ms):
    global data_wait
    sockets = []
    for s in srcs:
        f = s.get_factory()
        if f is not None and f.get_name() == "unixfdsrc":
            try:
                sockets.append(str(s.get_property("socket-path")))
            except Exception:  # noqa: BLE001
                pass
    dw = {"probes": [], "warn_id": None, "poll_id": None, "warned": False,
          "pending": set(id(s) for s in srcs), "fired": False,
          "timeout_ms": timeout_ms, "sockets": sockets,
          "identity": {p: _socket_identity(p) for p in sockets}}
    data_wait = dw

    def on_first(_pad, _info, el):
        # Streaming thread. The deadline starts when EVERY non-live head has
        # delivered (a mux waits for all its inputs, so one head's data does
        # not make a wedge measurable yet); hand over to the main loop once.
        dw["pending"].discard(id(el))
        if not dw["pending"] and not dw["fired"]:
            dw["fired"] = True
            GLib.idle_add(_on_data_arrived, dw)
        return Gst.PadProbeReturn.OK

    dw["probes"] = _probe_src_pads(srcs, on_first)

    def on_warn():
        dw["warn_id"] = None
        dw["warned"] = True
        _emit({"event": "waiting_for_data", "sockets": sockets,
               "message": (f"no data yet on bus socket(s) {', '.join(sockets)} after "
                           f"{timeout_ms} ms — waiting for the producer, not restarting")})
        return False

    def on_poll():
        if data_wait is not dw or dw["fired"]:
            return data_wait is dw          # data won the race: stay quiet, stop polling
        for p, ident in dw["identity"].items():
            now = _socket_identity(p)
            if now != ident:
                what = "went away" if now is None else "was re-created"
                _clear_data_wait()
                _fail({"event": "error", "kind": "bus_producer_restarted",
                       "message": (f"producer bus socket {p} {what} while waiting for "
                                   f"its first data — reconnecting")})
                return False
        return True

    # A UDP head leaves the warning to the silence watch; the socket poll only
    # has something to watch when there are bus sockets.
    if sockets:
        dw["warn_id"] = GLib.timeout_add(timeout_ms, on_warn)
        dw["poll_id"] = GLib.timeout_add(DATA_WAIT_POLL_MS, on_poll)


def _clear_data_wait():
    global data_wait
    dw, data_wait = data_wait, None
    if dw is None:
        return False
    _remove_probes(dw["probes"])
    _remove_source("warn_id", dw)
    _remove_source("poll_id", dw)
    return dw["warned"]


def _on_data_arrived(dw):
    if data_wait is not dw:             # superseded by a stop / a newer start
        return False
    if _clear_data_wait():
        _emit({"event": "data_arrived", "sockets": dw["sockets"]})
    pipe = _pipeline()
    if pipe is not None:
        _ret, state, _pending = pipe.get_state(0)
        if state != Gst.State.PLAYING:
            _arm_deadline(dw["timeout_ms"])
    return False


# --------------------------------------------------------------------------- udp silence

def _arm_udp_silence(pipe, restart_ms):
    global udp_silence
    srcs = sources_by_factory(pipe, "udpsrc")
    if not srcs:
        return
    st = {"since": None, "probes": [], "restart_ms": int(restart_ms or 0)}
    udp_silence = st

    def on_buffer(_pad, _info, _el):
        if st["since"] is not None:
            st["since"] = None
            GLib.idle_add(_on_udp_resumed, st)
        return Gst.PadProbeReturn.OK

    st["probes"] = _probe_src_pads(srcs, on_buffer)


def _clear_udp_silence():
    global udp_silence
    st, udp_silence = udp_silence, None
    if st is not None:
        _remove_probes(st["probes"])


def _on_udp_resumed(st):
    if udp_silence is st:
        _emit({"event": "input_resumed", "message": "UDP source receiving again"})
    return False


def on_udp_timeout(src_name):
    """One `GstUDPSrcTimeout`: the first after start or after data reports the
    silence; later ones only decide whether the multicast re-join is due."""
    st = udp_silence
    now = time.monotonic()
    if st is None:
        # No udpsrc found at start (should not happen): the old behaviour
        # rather than sitting blind.
        _fail({"event": "error", "kind": "udp_timeout",
               "message": "UDP source timeout (no data received)"})
        return
    if st["since"] is None:
        st["since"] = now
        _emit({"event": "input_silent", "kind": "udp_timeout", "element": src_name,
               "message": f"UDP source {src_name} silent — waiting for data, not restarting"})
        return
    if st["restart_ms"] > 0 and (now - st["since"]) * 1000.0 >= st["restart_ms"]:
        _fail({"event": "error", "kind": "udp_timeout",
               "message": (f"UDP source {src_name} silent for {int(now - st['since'])} s — "
                           f"restarting to re-join (udpSilenceRestartMs={st['restart_ms']})")})
