#!/usr/bin/env python3
"""Source-timeline latch for the runner's preserveSourceTimeline feature.

Pure logic, no GStreamer (the ts_split.py pattern): the runner feeds it the
raw TS bytes seen on a tsdemux SINK pad; it records the FIRST PES PTS per PID.
`offset_ns()` then converts a demuxed src pad's first buffer PTS into the
`GstPad.set_offset()` value that shifts that branch's running time onto the
source timeline — valid because tsdemux emits identity segments
(running_time == buffer pts).

HAZARD (deliberately unsolved here, per plan non-goals): the PES PTS is a
33-bit 90 kHz counter that wraps every ~26.5 h. A latch taken near the wrap,
or a mid-stream source discontinuity, leaves the offset stale exactly like
today's arrival anchor — restarts re-latch, wraps/disconts do not.
"""
from ts_psi import iter_packets, read_pes_pts, ts_pid

# 90 kHz ticks -> nanoseconds, exact in integers: ns = pts * 1e9 / 90e3.
_NS_NUM = 100000
_NS_DEN = 9


def pts90k_to_ns(pts: int) -> int:
    return pts * _NS_NUM // _NS_DEN


class TimelineLatch:
    """Per-PID first-PES-PTS recorder over a TS byte stream."""

    def __init__(self):
        self.first_pts = {}   # pid -> 33-bit 90 kHz PTS of the first PES seen

    def feed(self, data: bytes) -> None:
        for pkt in iter_packets(data):
            if not (pkt[1] & 0x40):        # PUSI quick-reject before PID parse
                continue
            pid = ts_pid(pkt)
            if pid in self.first_pts:      # cheap steady-state: latch once
                continue
            pts = read_pes_pts(pkt)
            if pts is not None:
                self.first_pts[pid] = pts

    def latched(self, pid: int) -> bool:
        return pid in self.first_pts

    def offset_ns(self, pid: int, first_buffer_pts_ns: int):
        """set_offset() value moving a branch whose first buffer carried
        `first_buffer_pts_ns` onto the source timeline; None if not latched."""
        pts = self.first_pts.get(pid)
        if pts is None:
            return None
        return pts90k_to_ns(pts) - first_buffer_pts_ns
