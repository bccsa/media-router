"""Runner hook `subtitle_bridge` — the runner-side half of the subtitle-core cue
carrier, installed via `PipelineDescription.runnerHooks` with
`{pay?: [...], sourceDemux?: str, overlay?: {...}}`. Producer: `subtitle_pay`;
consumer: `subtitle_overlay`. ADR-0016 (amendment 2026-10-09) and
docs/research/subtitle-content-time-20261009.md. Python-only by decision
(ADR-0016 2026-10-09, ADR-0020 allows it): there is no native form, so
descriptions carrying this hook pin `runner: 'python'`.
"""
import subtitle_overlay
import subtitle_pay
import subtitle_runtime as rt
from subtitle_cues import RESEND_MS

_state = None               # {"pay": [entries], "overlay": dict|None, "timer": id|None, "retime": ...}


def configure(emit_event, emit_plugin_event):
    rt.configure(emit_event, emit_plugin_event)


def install(pipe, config, ctx=None):
    """Runner hook entry point: before PLAYING, once per pipeline start."""
    global _state
    if ctx:
        configure(ctx.get("emit_event"), ctx.get("emit_plugin_event"))
    config = config or {}
    pay_specs, overlay_cfg = config.get("pay"), config.get("overlay")
    clear()
    if not pay_specs and not overlay_cfg:
        return
    _state = {"pay": [], "overlay": None, "timer": None, "retime": None}
    if pay_specs and config.get("sourceDemux"):
        _state["retime"] = subtitle_pay.install_retime(pipe, config["sourceDemux"])
    for spec in pay_specs or []:
        entry = subtitle_pay.install_pay(pipe, spec)
        if entry is not None:
            _state["pay"].append(entry)
    if overlay_cfg:
        _state["overlay"] = subtitle_overlay.install_overlay(pipe, overlay_cfg)
    if _state["pay"]:
        GLib, _ = rt.gst()
        _state["timer"] = GLib.timeout_add(RESEND_MS, _resend_tick)


def _resend_tick():
    if _state is None:
        return False
    subtitle_pay.resend(_state["pay"])
    return True


def clear():
    """Runner hook exit point (pipeline stop)."""
    global _state
    if _state is None:
        return
    if _state.get("timer") is not None:
        GLib, _ = rt.gst()
        GLib.source_remove(_state["timer"])
    _state = None


def state():
    return _state

