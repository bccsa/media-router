"""The source retime's per-packet walk, natively: `mrpeshouse`
(plugins/mpegts-core/native/mrpeshouse) spliced in front of the source tsdemux,
its `pes-house` signal filling the bridge's StampIndex. It runs the python
`PesStamper` + `StampModel` (the spec) rule for rule; when the plugin is
absent, fails to load or to splice, the bridge keeps its python chunk probe.
`MR_SUBTITLE_NATIVE_RETIME=0` forces the probe. ADR-0016 amendment 2026-10-09.
"""
import os

import subtitle_runtime as rt

SO = "libgstmrpeshouse.so"
FACTORY = "mrpeshouse"
DISABLE_ENV = "MR_SUBTITLE_NATIVE_RETIME"

_loaded = None              # one load attempt per process: None = not tried yet


def so_paths():
    """Repo/deployed plugins tree first (a dev drop-in wins), then the
    packaged libexec root — as gst_stamp_native.so_paths resolves mrtsstamp."""
    here = os.path.dirname(os.path.abspath(__file__))
    plugins = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(os.path.join(here, "..", ".."))
    libexec = os.environ.get("MR_LIBEXEC_DIR") or "/usr/libexec/media-router"
    return [os.path.join(plugins, "mpegts-core", "native", "mrpeshouse", SO),
            os.path.join(libexec, "mpegts-core", SO)]


def load():
    """True when the `mrpeshouse` factory is available (loading it by path once)."""
    global _loaded
    if os.environ.get(DISABLE_ENV) == "0":
        return False
    if _loaded is None:
        _, Gst = rt.gst()
        _loaded = Gst.ElementFactory.find(FACTORY) is not None
        for path in ([] if _loaded else so_paths()):
            if not os.path.exists(path):
                continue
            try:
                _loaded = Gst.Plugin.load_file(path) is not None
            except Exception as exc:  # noqa: BLE001 — any failure is the python fallback
                rt.trace(f"mrpeshouse at {path} failed to load ({exc})")
                continue
            if _loaded:
                break
    return _loaded


def splice(pipe, demux):
    """`peer ! mrpeshouse ! demux`, before PLAYING; the element, or None with
    the graph left as it was."""
    _, Gst = rt.gst()
    sink = demux.get_static_pad("sink")
    peer = sink.get_peer() if sink is not None else None
    el = Gst.ElementFactory.make(FACTORY, f"{demux.get_name()}_peshouse") if peer is not None else None
    if el is None:
        return None
    parent = demux.get_parent() or pipe
    parent.add(el)
    esink, esrc = el.get_static_pad("sink"), el.get_static_pad("src")
    ok = (peer.unlink(sink) and peer.link(esink) == Gst.PadLinkReturn.OK
          and esrc.link(sink) == Gst.PadLinkReturn.OK)
    if not ok:
        peer.unlink(esink)
        esrc.unlink(sink)
        parent.remove(el)
        if sink.get_peer() is None:
            peer.link(sink)
        return None
    el.sync_state_with_parent()
    return el


def attach(pipe, demux, index):
    """Load, splice and connect; the element, or None (python probe instead)."""
    try:
        el = splice(pipe, demux) if load() else None
    except Exception as exc:  # noqa: BLE001 — never fatal: the python probe covers it
        rt.trace(f"mrpeshouse unavailable ({exc})")
        return None
    if el is not None:
        el.connect("pes-house", _on_pes_house, {"pipe": pipe, "index": index, "warned": False})
    return el


def set_pids(el, pids):
    el.set_property("pids", ",".join(hex(p) for p in sorted(pids)))


def _on_pes_house(_el, _pid, _pts90k, sha1_hex, house_ns, ctx):
    """Streaming thread, before the demux sees the chunk: hash → house ms."""
    try:
        house = house_ns / 1e6 if house_ns >= 0 else None
        ctx["index"].record(bytes.fromhex(sha1_hex), house, rt.house_now_ms(ctx["pipe"]))
    except Exception as exc:  # noqa: BLE001 — never take the input down
        if not ctx["warned"]:
            ctx["warned"] = True
            rt.warn(f"native chunk stamp record failed ({exc})")
