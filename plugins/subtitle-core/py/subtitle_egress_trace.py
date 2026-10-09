"""Opt-in egress latency trace of the subtitle pay branches
(MR_SUBTITLE_EGRESS_TRACE=1, see `subtitle_pay.egress_trace`): one line per cue
PES at the bus tee, `egress <label> start=<ms> src=+<ms> tee=+<ms>`, wall-clock
ms after the push. Built to localize the OCC gate's mpegtsmux hold (research
doc subtitle-content-time-20261009); matched on the 33-bit PES PTS as written.
"""
import time

import subtitle_pack
import subtitle_ts

PENDING_MAX = 32


def klv_pes_ticks(data):
    """PES PTS (90 kHz, as written) of the private PES that start in `data`."""
    out = []
    for pkt in subtitle_ts.iter_packets(data):
        if not pkt[1] & 0x40:
            continue
        hdr = subtitle_ts.parse_pes_header(pkt[subtitle_ts.payload_offset(pkt):])
        if hdr and hdr[0] == subtitle_ts.STREAM_ID_PRIVATE_1 and hdr[1] is not None:
            out.append(hdr[1])
    return out


def _now():
    return time.monotonic() * 1000.0


class EgressTrace:
    """Per pay entry: pushes in, sightings at the appsrc src and the bus tee.
    `Gst` is the caller's module (no import back into the bridge)."""

    def __init__(self, label, trace, Gst):
        self.label, self.trace, self.Gst = label, trace, Gst
        self.pending = {}       # PES ticks -> {"start": ms, "push": t, "src": dt}
        self.armed = False

    def pushed(self, start_ms, src=None):
        """A cue chunk is about to be pushed into `src` (probes armed on the first)."""
        if not self.armed and src is not None:
            self._arm(src)
        if len(self.pending) >= PENDING_MAX:
            self.pending.pop(next(iter(self.pending)))
        self.pending[subtitle_pack.pes_ticks(start_ms)] = {"start": round(start_ms),
                                                           "push": _now(), "src": None}

    def seen(self, where, data):
        """`data` passed `where` ("src" or "tee"): note it, or log the cue at the tee."""
        for ticks in klv_pes_ticks(data):
            rec = self.pending.get(ticks)
            if rec is None:
                continue
            dt = _now() - rec["push"]
            if where == "src":
                rec["src"] = dt
            else:
                self.pending.pop(ticks, None)
                src = "?" if rec["src"] is None else f"+{rec['src']:.0f}"
                self.trace(f"egress {self.label} start={rec['start']} src={src} tee=+{dt:.0f}")

    def _buffers(self, info):
        if info.type & self.Gst.PadProbeType.BUFFER_LIST:
            lst = info.get_buffer_list()
            return [lst.get(i) for i in range(lst.length())] if lst else []
        buf = info.get_buffer()
        return [buf] if buf else []

    def _probe(self, where):
        def cb(_pad, info):
            for buf in self._buffers(info):
                self.seen(where, buf.extract_dup(0, buf.get_size()))
            return self.Gst.PadProbeReturn.OK
        return cb

    def _arm(self, src):
        """The appsrc src pad, then downstream to the `busout_*` tee's sink."""
        self.armed = True
        kinds = self.Gst.PadProbeType.BUFFER | self.Gst.PadProbeType.BUFFER_LIST
        pad = src.get_static_pad("src")
        if pad is None:
            return
        pad.add_probe(kinds, self._probe("src"))
        for _ in range(8):
            peer = pad.get_peer()
            el = peer.get_parent_element() if peer else None
            if el is None:
                return
            if (el.get_name() or "").startswith("busout_"):
                peer.add_probe(kinds, self._probe("tee"))
                return
            pad = el.get_static_pad("src")
            if pad is None:
                return
