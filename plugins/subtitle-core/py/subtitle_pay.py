"""Producer half of the subtitle bridge (`pay`): cue text from an appsink →
one packed TS chunk per cue into a `video/mpegts` appsrc, PES PTS = the cue's
content time (the text's PTS: its source PES time, which the formula demux put
on it), sent once. A probe on the decoder's sink (`pesProbe`) sends an
empty-value keepalive per KEEPALIVE_MS of source PES time. ADR-0016 amendments
2026-10-09 and 2026-11-25 (MR-062); docs/research/subtitle-content-time-20261009.md.
"""
import os

import subtitle_klv
import subtitle_pack
import subtitle_runtime as rt
from subtitle_cues import PayState, wire_cue

try:  # diagnostics only: a missing trace module must never take the cue path down
    import subtitle_egress_trace
except ImportError:
    subtitle_egress_trace = None

EGRESS_TRACE_ENV = "MR_SUBTITLE_EGRESS_TRACE"


def clean_text(data):
    """Cue text bytes → str: drop NULs (teletextdec appends one), CRs, and
    leading/trailing blank lines; an all-blank page is a CLEAR."""
    text = bytes(data).replace(b"\x00", b"").decode("utf-8", "replace")
    lines = [ln.rstrip() for ln in text.replace("\r", "").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return "\n".join(lines)


def pack_cue(packer, cue):
    """The TS chunk for `cue` (PES on its start, `0 --> hold`)."""
    pes_ms, rel = wire_cue(cue)
    return packer.cue_chunk(subtitle_pack.pes_ticks(pes_ms), subtitle_klv.encode_cue(*rel))


def pack_keepalive(packer, pes_ms):
    """A keepalive's TS chunk: the cue layout, an empty KLV value, PES at `pes_ms`."""
    return packer.cue_chunk(subtitle_pack.pes_ticks(pes_ms), subtitle_klv.KEEPALIVE)


# --- pay entries ------------------------------------------------------------------

def install_pay(pipe, spec):
    """One subtitle stream: appsink (cue text) and the `pesProbe` element's sink
    (source PES, keepalives) → PayState → appsrc. → entry."""
    _, Gst = rt.gst()
    sink = pipe.get_by_name(spec.get("appsink", ""))
    src = pipe.get_by_name(spec.get("appsrc", ""))
    if sink is None or src is None:
        rt.warn(f"pay elements missing ({spec.get('appsink')}/{spec.get('appsrc')})")
        return None
    packer = subtitle_pack.KlvTsPacker(int(spec.get("pid", 0x180)))
    label = spec.get("label") or spec.get("appsrc")
    entry = {"pipe": pipe, "src": src, "label": label, "egress": egress_trace(label, Gst)}
    entry["pay"] = PayState(int(spec.get("holdMs", 8000)), lambda cue: pack_cue(packer, cue),
                            lambda t: pack_keepalive(packer, t),
                            lambda t, chunk, cue: push_chunk(entry, t, chunk, cue))
    probe = pipe.get_by_name(spec["pesProbe"]) if spec.get("pesProbe") else None
    if probe is not None:
        probe.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, _on_source_pes, entry)
    else:
        rt.warn(f"{label}: no source PES probe ({spec.get('pesProbe')}), no keepalives")
    sink.set_property("emit-signals", True)
    sink.set_property("sync", False)
    sink.set_property("max-buffers", 8)
    sink.set_property("drop", True)
    sink.connect("new-sample", _on_text_sample, entry)
    return entry


def egress_trace(label, Gst):
    """The per-cue egress trace, only with MR_SUBTITLE_EGRESS_TRACE=1 (it adds
    wall-clock probes on the appsrc and the bus tee)."""
    if os.environ.get(EGRESS_TRACE_ENV) != "1" or subtitle_egress_trace is None:
        return None
    try:
        return subtitle_egress_trace.EgressTrace(label, rt.trace, Gst)
    except Exception:  # noqa: BLE001 — diagnostics only
        return None


def _on_source_pes(_pad, info, entry):
    """Decoder sink (the cue callback's streaming thread, ahead of it): a
    keepalive on this PES's time once it is KEEPALIVE_MS past the last send."""
    _, Gst = rt.gst()
    buf = info.get_buffer()
    try:
        now = rt.house_now_ms(entry["pipe"]) if buf is not None else None
        sent = entry["pay"].keepalive(rt.pts_ms(buf, Gst), now) if now is not None else None
        if sent is not None and sent[1]:
            rt.warn(f"{entry['label']}: PES time off house-now — keepalives on arrival")
    except Exception as exc:  # noqa: BLE001 — a keepalive must never stop the decoder
        rt.warn(f"keepalive failed ({exc})")
    return Gst.PadProbeReturn.OK


def _on_text_sample(sink, entry):
    _, Gst = rt.gst()
    smp = sink.emit("pull-sample")
    if not smp:
        return Gst.FlowReturn.OK
    buf = smp.get_buffer()
    try:
        text = clean_text(rt.map_bytes(buf))
        now = rt.house_now_ms(entry["pipe"])
        if now is None:
            return Gst.FlowReturn.OK
        pts = rt.pts_ms(buf, Gst)
        cue, count, warn = entry["pay"].new_cue(text, pts, now)       # pushed under its lock
        if warn:
            off = "missing" if pts is None else f"{pts - now:+.0f} ms off"
            rt.warn(f"{entry['label']}: cue time {off} house-now — cues start on arrival")
        late = int(round(now - cue.start))
        rt.trace(f"cue {entry['label']} start={cue.start:.3f} late={late} "
                 f"text={text.replace(chr(10), ' / ')[:60]!r}")
        rt.emit_cue_event({"label": entry["label"], "text": text, "startMs": cue.start,
                           "lateMs": late, "count": count})
    except Exception as exc:  # noqa: BLE001 — a bad cue must never take the pipeline down
        rt.warn(f"cue dropped ({exc})")
    return Gst.FlowReturn.OK


def push_chunk(entry, pes_ms, chunk, cue=None):
    """One chunk into the appsrc, buffer PTS = its PES time; `cue` None = a
    keepalive (not egress-traced). Called under the PayState lock."""
    _, Gst = rt.gst()
    buf = Gst.Buffer.new_wrapped(chunk)
    buf.pts = int(pes_ms * 1e6)
    buf.dts = buf.pts
    buf.duration = Gst.CLOCK_TIME_NONE
    if cue is not None and entry["egress"] is not None:
        try:
            entry["egress"].pushed(pes_ms, entry["src"])
        except Exception:  # noqa: BLE001 — diagnostics only
            pass
    entry["src"].emit("push-buffer", buf)
