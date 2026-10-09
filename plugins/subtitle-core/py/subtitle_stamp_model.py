"""The program's house mapping K (house ms = K + PTS/90) read back off the
engine's floored bus-chunk stamps, and the reference PES a chunk's stamp was
taken from. K is learned only on a stamp RISE whose reference both engine rules
agree on; derivation and measurements: docs/research/subtitle-content-time-20261009.md.
The spec of the C++ twin (mpegts-core/native/mrpeshouse/stamp_model.cpp): port
any change there and regenerate its vectors (`subtitle_stamp_dump.py`).
"""
from typing import NamedTuple, Optional

PTS_WRAP = 1 << 33
# A clamped chunk's reference this far above / below its stamp, or a rise
# implying a K this far off, is a re-anchor.
REANCHOR_FWD_MS = 300.0
REANCHOR_BACK_MS = 2500.0


class Reference(NamedTuple):
    """The PES the engine mapped for a chunk; `sure` = both rules pick it."""
    pts: Optional[int]
    sure: bool


def timing_stream_id(sid):
    """Video or audio stream_id — what may define a chunk's stamp."""
    return (sid & 0xF0) == 0xE0 or (sid & 0xE0) == 0xC0


def fold_ticks(d):
    """Signed 33-bit-wrap-folded PTS delta (90 kHz ticks)."""
    d %= PTS_WRAP
    return d - PTS_WRAP if d > PTS_WRAP // 2 else d


def chunk_reference(heads, pcr_pid):
    """`heads` = [(pid, stream_id, pts)] in packet order. The PCR PID's first
    PES (timing PID known), else the first video/audio PES (unknown); a private
    PES only on the PCR PID (`timing_pes`). `sure` when both rules agree."""
    first = next((pts for _pid, sid, pts in heads if timing_stream_id(sid)), None)
    pcr = next((pts for pid, _sid, pts in heads if pid == pcr_pid), None)
    if pcr is None:
        return Reference(first, True)
    return Reference(pcr, first is None or first == pcr)


class StampModel:
    """K off the chunk stamps (module doc). Feed EVERY chunk in order."""

    def __init__(self):
        self.k = None
        self.prev = None        # last chunk stamp (ms)
        self.last = None        # last reference PTS, unwrapped

    def _unwrap(self, pts):
        return pts if self.last is None else self.last + fold_ticks(pts - self.last)

    def observe(self, chunk_ms, ref_pts, sure=True):
        if chunk_ms is None:
            return
        prev, self.prev = self.prev, chunk_ms
        u = None
        if ref_pts is not None:
            u = self.last = self._unwrap(ref_pts)
        if prev is not None and chunk_ms < prev:
            self.k = None               # the stream restarted
            return
        if u is None:
            return                      # arrival or floor repeat: K unchanged
        if not sure:
            return                      # the rules disagree: keep K (a miss, never wrong)
        if prev is None or chunk_ms > prev:
            k = chunk_ms - u / 90.0         # the stamp rose: it IS this PES's mapping
            # A rise off the current K by more than a re-anchor step: drop K and
            # re-learn on the next rise (also undoes a clamped first chunk).
            if self.k is not None and abs(k - self.k) > REANCHOR_FWD_MS:
                self.k = None
            else:
                self.k = k
        elif self.k is not None:
            mapped = self.k + u / 90.0
            if mapped > chunk_ms + REANCHOR_FWD_MS or mapped < chunk_ms - REANCHOR_BACK_MS:
                self.k = None           # clamped, yet off the mapping: re-anchored

    def house(self, pts):
        if self.k is None or pts is None:
            return None
        return self.k + self._unwrap(pts) / 90.0
