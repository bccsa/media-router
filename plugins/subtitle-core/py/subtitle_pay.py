"""Producer half of the subtitle bridge (`pay`): cue text from an appsink →
one packed TS chunk per cue into a `video/mpegts` appsrc, PES PTS = the cue's
content time, re-sent every RESEND_MS while live; `sourceDemux` retimes the
teletext pad onto the bus stamps first. ADR-0016 amendment 2026-10-09;
docs/research/subtitle-content-time-20261009.md.
"""
import os

import subtitle_klv
import subtitle_native
import subtitle_pack
import subtitle_runtime as rt
import subtitle_ts
from subtitle_cues import PayState, StartGate, wire_cue

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


def pid_from_pad_name(name):
    """tsdemux pad `private_0_0123` → 0x123, or None."""
    try:
        return int(name.rsplit("_", 1)[1], 16)
    except (IndexError, ValueError):
        return None


def pack_cue(packer, cue):
    """The TS chunk for every send of `cue` (PES on its start, `0 --> hold`)."""
    pes_ms, rel = wire_cue(cue)
    return packer.cue_chunk(subtitle_pack.pes_ticks(pes_ms), subtitle_klv.encode_cue(*rel))


# --- source retime: the teletext pad onto the bus stamps ----------------------

def install_retime(pipe, demux_name):
    """Retime `demux_name`'s private src pads onto the bus stamps (content
    time); a PES the join misses carries the pad's last correction."""
    _, Gst = rt.gst()
    demux = pipe.get_by_name(demux_name)
    sink = demux.get_static_pad("sink") if demux is not None else None
    if sink is None:
        rt.warn(f"source demux missing ({demux_name}) — cues start at tsdemux time")
        return None
    # Every private PID until tsdemux adds its pads (it adds them while chaining
    # the first PES, after the sink probe read that chunk).
    retime = {"pipe": pipe, "stamper": subtitle_ts.PesStamper(),
              "index": subtitle_ts.StampIndex(), "hits": 0, "misses": 0}
    # The per-packet walk runs natively when it can (subtitle_native); the
    # python probe is its spec and the fallback.
    retime["native"] = subtitle_native.attach(pipe, demux, retime["index"])
    if retime["native"] is None:
        sink.add_probe(Gst.PadProbeType.BUFFER,
                       rt.chunk_probe(pipe, retime["stamper"], retime["index"], subtitle_ts.payload_key))
    rt.trace(f"retime source: {'native mrpeshouse' if retime['native'] is not None else 'python probe'}")
    demux.connect("pad-added", _on_source_pad, retime)
    return retime


def _on_source_pad(_demux, pad, retime):
    _, Gst = rt.gst()
    name = pad.get_name() or ""
    pid = pid_from_pad_name(name)
    if not name.startswith("private_") or pid is None:
        return
    stamper = retime["stamper"]
    stamper.pids = (stamper.pids or set()) | {pid}
    if retime.get("native") is not None:
        subtitle_native.set_pids(retime["native"], stamper.pids)
    pad.add_probe(Gst.PadProbeType.BUFFER, _on_source_buffer,
                  {"retime": retime, "delta": None, "warned": False})


def _on_source_buffer(pad, info, ps):
    _, Gst = rt.gst()
    buf = info.get_buffer()
    if buf is None or buf.pts == Gst.CLOCK_TIME_NONE:
        return Gst.PadProbeReturn.OK
    retime = ps["retime"]
    house = retime["index"].lookup(subtitle_ts.payload_key(rt.map_bytes(buf)),
                                   rt.house_now_ms(retime["pipe"]))
    if house is not None:
        out = int(house * 1e6)
        ps["delta"] = out - buf.pts
        retime["hits"] += 1
        if retime["hits"] == 1:
            rt.trace(f"retime {pad.get_name()}: content time from the bus stamps "
                     f"(tsdemux was {-ps['delta'] / 1e6:+.0f} ms off)")
    elif ps["delta"] is not None:
        out = buf.pts + ps["delta"]
        retime["misses"] += 1
    else:
        if not ps["warned"]:                # start-up: no chunk stamp joined yet
            ps["warned"] = True
            rt.warn(f"{pad.get_name()}: content time unavailable yet — tsdemux time used")
        return Gst.PadProbeReturn.OK
    if out >= 0:
        buf.pts = out
        if buf.dts != Gst.CLOCK_TIME_NONE:
            buf.dts = out
    return Gst.PadProbeReturn.OK


# --- pay entries ------------------------------------------------------------------

def install_pay(pipe, spec):
    """One subtitle stream: appsink (cue text) → PayState → appsrc. → entry."""
    _, Gst = rt.gst()
    sink = pipe.get_by_name(spec.get("appsink", ""))
    src = pipe.get_by_name(spec.get("appsrc", ""))
    if sink is None or src is None:
        rt.warn(f"pay elements missing ({spec.get('appsink')}/{spec.get('appsrc')})")
        return None
    packer = subtitle_pack.KlvTsPacker(int(spec.get("pid", 0x180)))
    label = spec.get("label") or spec.get("appsrc")
    entry = {
        "pipe": pipe, "src": src, "label": label, "gate": StartGate(),
        "pay": PayState(int(spec.get("holdMs", 8000)), lambda cue: pack_cue(packer, cue)),
        "egress": egress_trace(label, Gst),
    }
    src.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, _on_pay_out, entry)
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


def _on_pay_out(_pad, info, entry):
    """appsrc src (its one streaming thread): drop a chunk older than one out."""
    _, Gst = rt.gst()
    buf = info.get_buffer()
    if buf is None or buf.pts == Gst.CLOCK_TIME_NONE or entry["gate"].admit(buf.pts):
        return Gst.PadProbeReturn.OK
    rt.trace(f"egress {entry['label']} dropped a stale re-send (start={buf.pts // 1_000_000})")
    return Gst.PadProbeReturn.DROP


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
        cue, chunk, count, warn = entry["pay"].new_cue(text, pts, now)
        if warn:
            off = "missing" if pts is None else f"{pts - now:+.0f} ms off"
            rt.warn(f"{entry['label']}: cue time {off} house-now — cues start on arrival")
        push_chunk(entry, cue, chunk)
        late = int(round(now - cue.start))
        rt.trace(f"cue {entry['label']} start={cue.start} late={late} "
                 f"text={text.replace(chr(10), ' / ')[:60]!r}")
        rt.emit_cue_event({"label": entry["label"], "text": text, "startMs": cue.start,
                           "lateMs": late, "count": count})
    except Exception as exc:  # noqa: BLE001 — a bad cue must never take the pipeline down
        rt.warn(f"cue dropped ({exc})")
    return Gst.FlowReturn.OK


def push_chunk(entry, cue, chunk):
    """One cue's TS into the appsrc, buffer PTS = its start (outside any lock)."""
    _, Gst = rt.gst()
    buf = Gst.Buffer.new_wrapped(chunk)
    buf.pts = int(cue.start * 1e6)
    buf.dts = buf.pts
    buf.duration = Gst.CLOCK_TIME_NONE
    if entry["egress"] is not None:
        try:
            entry["egress"].pushed(cue.start, entry["src"])
        except Exception:  # noqa: BLE001 — diagnostics only
            pass
    entry["src"].emit("push-buffer", buf)


def resend(entries):
    """The RESEND_MS timer: re-send every entry's live cue (same PES bytes)."""
    for entry in entries:
        now = rt.house_now_ms(entry["pipe"])
        if now is None:
            continue
        try:
            again = entry["pay"].resend(now)
            if again is not None:
                push_chunk(entry, *again)
        except Exception as exc:  # noqa: BLE001
            rt.warn(f"cue re-send failed ({exc})")
