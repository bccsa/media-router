"""Runner hook `subtitle_bridge` — the runner-side half of the subtitle-core cue
carrier, installed via `PipelineDescription.runnerHooks` with
`{pay?: [...], overlay?: {...}}`. Producer: `subtitle_pay`;
consumer: `subtitle_overlay`. ADR-0016 (amendment 2026-10-09) and
docs/research/subtitle-content-time-20261009.md. Python-only by decision
(ADR-0016 2026-10-09, ADR-0020 allows it): there is no native form, so
descriptions carrying this hook pin `runner: 'python'`.
"""
import subtitle_overlay
import subtitle_pay
import subtitle_runtime as rt

_state = None               # {"pay": [entries], "overlay": dict|None}


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
    _state = {"pay": [], "overlay": None}
    for spec in pay_specs or []:
        entry = subtitle_pay.install_pay(pipe, spec)
        if entry is not None:
            _state["pay"].append(entry)
    if overlay_cfg:
        _state["overlay"] = subtitle_overlay.install_overlay(pipe, overlay_cfg)


def clear():
    """Runner hook exit point (pipeline stop)."""
    global _state
    _state = None


def state():
    return _state

