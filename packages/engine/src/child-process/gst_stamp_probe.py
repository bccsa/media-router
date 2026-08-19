#!/usr/bin/env python3
"""The python stamping backend: a buffer probe on one `busout_*` tee sink pad.

This is the REFERENCE implementation of the contract's GStreamer half and the
fallback for a box where the native `mrtsstamp` plugin is missing or fails to
load (`gst_stamp_native`). Same arm point, same semantics, same events — a
consumer cannot tell which backend stamped its stream.

ONE probe per tee SINK pad covers every GStreamer producer — relays (srt-input,
mpegts-ip-input) and muxers (mpegts-muxer, transcoder, video/audio-encoder)
alike — because it works on the muxed TS bytes, not on whatever produced them.
The tee sink is also the only stable point: busedge `unixfdsink` branches are
created per consumer AT RUNTIME, so there is no fixed downstream pad to
instrument.

THE MATHS IS NOT HERE. `ts_timeline.TimelineStamper` (plugins/mpegts-core/py) is
the one python definition of the contract's arithmetic — anchor, per-PID unwrap,
discontinuity watch, re-anchor, monotone staircase, drift slew — shared with the
`unixfd-fanout.py` sidecar and ported to `mrts::TimelineStamper` for the native
ones. What lives here is only where the stamp lands and how the segment mapping
survives it.
"""
import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

import gst_stamp_events as events  # noqa: E402


# ---------------------------------------------------------------------------
# Segment correctness — the stamp has to survive the running-time mapping
# ---------------------------------------------------------------------------
# What reaches the wire is not the PTS we write: unixfdsink transmits
# gst_segment_to_running_time(segment, pts) + base_time. On the identity segment
# a bus producer normally carries, that IS the PTS and there is nothing to do.
# Anything else (an upstream `GstPad.set_offset` — preserveSourceTimeline's
# mechanism — a trimmed or rate-scaled segment, a non-zero base after a
# seek/discontinuity) shifts or rescales it, and the contract would ship
# silently wrong timing.
#
# So the stamp is computed in RUNNING TIME (house time, which is what a consumer
# must end up seeing) and converted back to a buffer position through the
# segment's own inverse mapping. Identity segments take the same path and get
# the same number back, at the cost of one cached boolean per buffer.
def _identity_segment(seg):
    return (seg.format == Gst.Format.TIME and seg.rate == 1.0
            and seg.applied_rate == 1.0 and seg.start == 0
            and seg.offset == 0 and seg.base == 0 and seg.time == 0)


def _note_segment(st, seg):
    """Cache one segment and describe it once, in the runner's log."""
    st["segment"] = seg
    st["seg_identity"] = seg is not None and _identity_segment(seg)
    if seg is None or st["seg_identity"]:
        return
    events.log_line(
        st["tee"],
        f"non-identity segment (format={seg.format} rate={seg.rate} "
        f"appliedRate={seg.applied_rate} start={seg.start} "
        f"offset={seg.offset} base={seg.base} time={seg.time}) — stamps are "
        f"mapped back through it so running time still carries house time")


def _segment_warn(st, why):
    """Report an unmappable segment once per armed egress — same event the
    native element's bus message is translated into (`segment_warning_event`),
    so which backend noticed is invisible to the engine."""
    if st.get("seg_warned"):
        return
    st["seg_warned"] = True
    events.emit(events.segment_warning_event(st["tee"], why))
    events.log_line(st["tee"], f"{why} — stamp written unmapped")


def _position_for(st, stamp):
    """Buffer PTS that makes this buffer's RUNNING time equal `stamp`."""
    if st.get("seg_identity"):
        return stamp
    seg = st.get("segment")
    if seg is None:
        _segment_warn(st, "no SEGMENT event on the tee sink")
        return stamp
    if seg.format != Gst.Format.TIME:
        _segment_warn(st, f"segment format is {seg.format}, not TIME")
        return stamp
    pos = seg.position_from_running_time(Gst.Format.TIME, stamp)
    if pos == Gst.CLOCK_TIME_NONE:
        _segment_warn(st, "the house stamp falls outside the current segment")
        return stamp
    return pos


# ---------------------------------------------------------------------------
# The probe itself
# ---------------------------------------------------------------------------
def install(tee, name, pipe):
    """Install the stamping probe on `tee`'s sink pad. Returns the stamper
    state dict, or None if the pad is not there.

    Stamp = houseAnchor + (payload PES PTS − firstPES). That REPLACES arrival
    time with mapped media time, which is the point: a constant
    `GstPad.set_offset` (the preserveSourceTimeline mechanism) can carry a
    timeline but cannot remove per-buffer jitter, and jitter on the producer's
    PTS is what rippled through every consumer's tsdemux.
    """
    import ts_timeline  # lazy, pure stdlib (embedded-core pattern)

    pad = tee.get_static_pad("sink")
    if pad is None:
        return None

    st = {"tee": name, "pad": pad, "probe_id": None,
          "segment": None, "seg_identity": False, "seg_warned": False}

    def house_now():
        # Running-time, which under the contract IS house-clock time. Written
        # as clock − base_time rather than clock.get_time() so a pipeline that
        # somehow missed `_apply_contract_clock` still gets a self-consistent
        # timeline instead of one offset by its base-time.
        clock = pipe.get_pipeline_clock()
        if clock is None:
            return 0
        return max(0, clock.get_time() - pipe.get_base_time())

    def on_anchor(ev):
        events.anchor_moment(name, ev)

    def on_reanchor(ev):
        events.reanchor_moment(name, ev)

    # The contract's arithmetic, verbatim from the module every other producer
    # runs (`unixfd-fanout.py`, and `mrts::TimelineStamper` for the native
    # sidecars): per-buffer watch, epoch-consistent latch, monotone staircase,
    # re-anchor in place. ONE egress, so ONE `stream`.
    stamper = ts_timeline.TimelineStamper(on_anchor=on_anchor,
                                          on_reanchor=on_reanchor)
    st["stamper"] = stamper

    def on_buffer(_pad, info):
        # SEGMENT tracking rides the same probe: the mapping the stamp has to
        # survive is the tee sink's current segment, and events are rare enough
        # that the type test below is the whole cost on the buffer path.
        if not (info.type & Gst.PadProbeType.BUFFER):
            ev = info.get_event()
            if ev is not None and ev.type == Gst.EventType.SEGMENT:
                _note_segment(st, ev.parse_segment())
            return Gst.PadProbeReturn.OK
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        if st["segment"] is None:
            # Armed mid-stream: the SEGMENT event went by before the probe
            # existed, so take it off the pad's sticky store instead.
            seg_ev = pad.get_sticky_event(Gst.EventType.SEGMENT, 0)
            _note_segment(st, seg_ev.parse_segment() if seg_ev is not None else None)
        ok, mi = buf.map(Gst.MapFlags.READ)
        if ok:
            try:
                # memoryview, not bytes: ts_psi slices a packet per TS packet
                # and again per PES header, and over a view those slices are
                # views rather than 188-byte copies. (`mi.data` itself is the
                # one unavoidable copy — pygobject builds a fresh bytes on every
                # access, so it is read exactly once.)
                stamp = stamper.stamp(memoryview(mi.data), house_now())
            finally:
                buf.unmap(mi)
        else:
            # Unmappable buffer: no PES to read, but it still must not leave
            # timestampless — a time-bounded leaky queue (500 ms busedge, 5 s
            # consumer ingress) cannot measure its own level without a PTS and
            # sheds as if permanently full. An empty feed takes the stamper's
            # own no-PES path (repeat the staircase, or house time before the
            # anchor), so the fallback is the contract's, not a second one.
            stamp = stamper.stamp(b"", house_now())
        pos = _position_for(st, stamp)
        buf.pts = pos
        # DTS is LOAD-BEARING here, not tidiness. The consumer's tsdemux takes
        # its PCR skew basis from GST_BUFFER_DTS_OR_PTS — DTS FIRST — so a
        # mux-generated DTS riding along unchanged silently overrides the PTS we
        # just wrote and the whole contract becomes a no-op that nothing reports
        # (ADR-0005's named regression).
        buf.dts = pos
        return Gst.PadProbeReturn.OK

    st["probe_id"] = pad.add_probe(
        Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, on_buffer)
    return st


def remove(st):
    """Take the probe off the pad. The latch state goes with it (see
    `gst_bus_stamper.release`)."""
    try:
        if st.get("probe_id") is not None:
            st["pad"].remove_probe(st["probe_id"])
    except Exception:  # noqa: BLE001 — a dead pad is already disarmed
        pass
    st["probe_id"] = None


def drift_stats(st):
    """This probe's drift state, or None while it is still measuring."""
    stamper = st.get("stamper")
    return stamper.drift_stats() if stamper is not None else None
