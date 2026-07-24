#!/usr/bin/env python3
"""Source-timeline latch for the runner's preserveSourceTimeline feature.

Pure logic, no GStreamer (the ts_split.py pattern): the runner feeds it the
raw TS bytes seen on a tsdemux SINK pad; it records the FIRST PES PTS per PID.
`offset_ns()` then converts a demuxed src pad's first buffer PTS into the
`GstPad.set_offset()` value that shifts that branch's running time onto the
source timeline — valid because tsdemux emits identity segments
(running_time == buffer pts).

WRAP HANDLING: the PES PTS is a 33-bit 90 kHz counter that wraps every
~26.5 h. Latching is EPOCH-CONSISTENT: the first PID to latch defines the
epoch, and every later PID's first PTS is unwrapped to the 2^33 period
nearest that reference — so an incarnation that starts astride the boundary
(some PIDs latching just before the wrap, some just after) still shifts all
branches onto ONE timeline instead of two epochs 26.5 h apart (the 2026-07-16
failure mode). A near-boundary unwrap can land a few frames NEGATIVE for the
lagging side; downstream tolerates a sub-second negative-running-time sliver
far better than a 26.5 h split. Mid-stream discontinuities still stale the
offset — the runner's post-latch watch handles those by restarting the
pipeline (fresh latch).
"""
from ts_psi import iter_packets, read_pes_pts, ts_pid

PTS_WRAP = 1 << 33

# 90 kHz ticks -> nanoseconds, exact in integers: ns = pts * 1e9 / 90e3.
_NS_NUM = 100000
_NS_DEN = 9


def pts90k_to_ns(pts: int) -> int:
    return pts * _NS_NUM // _NS_DEN


def unwrap_near(pts: int, ref: int) -> int:
    """`pts` shifted by the 2^33 period that lands it nearest `ref`.

    `ref` may itself be unwrapped (outside 33 bits). Real interleave skew is
    seconds at most, so the nearest-period candidate is always unambiguous.
    """
    base = ref - ((ref - pts) % PTS_WRAP)
    return base if (ref - base) <= PTS_WRAP // 2 else base + PTS_WRAP


class TimelineLatch:
    """Per-PID first-PES-PTS recorder over a TS byte stream."""

    def __init__(self):
        self.first_pts = {}   # pid -> first PES PTS, epoch-unwrapped (see doc)
        self._epoch_ref = None

    def feed(self, data: bytes) -> None:
        for pkt in iter_packets(data):
            if not (pkt[1] & 0x40):        # PUSI quick-reject before PID parse
                continue
            pid = ts_pid(pkt)
            if pid in self.first_pts:      # cheap steady-state: latch once
                continue
            pts = read_pes_pts(pkt)
            if pts is not None:
                if self._epoch_ref is None:
                    self._epoch_ref = pts
                else:
                    pts = unwrap_near(pts, self._epoch_ref)
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
