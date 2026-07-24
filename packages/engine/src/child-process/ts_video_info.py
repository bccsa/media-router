#!/usr/bin/env python3
"""Video parameter detection from an MPEG-TS elementary stream — packet-level,
no GStreamer. Finds the H.264 / H.265 SPS in a video PID's PES payload and
reports resolution / frame rate / scan type ("1920×1080i50"). Sibling of
ts_psi.py; imported by ts_split.py and the runner's tsProbe glue. The SPS
field decoding itself lives in sps_parse.py.

MPEG-2 video is reported codec-only by the callers (no sequence-header
parser here).
"""
from __future__ import annotations

import ts_psi
from sps_parse import strip_ep, parse_h264_sps, parse_h265_sps

__all__ = ['strip_ep', 'parse_h264_sps', 'parse_h265_sps',
           'format_video_info', 'VideoInfoProbe', 'MAX_COLLECT']


def format_video_info(info) -> str:
    """Display string: 1920×1080i50 / 1280×720p59.94 / 1920×1080i (fps
    unknown). Interlaced shows the FIELD rate (fps carries the frame rate)."""
    if not info or not info.get("width"):
        return None
    scan = "i" if info.get("interlaced") else "p"
    fps = info.get("fps")
    rate = ""
    if fps:
        shown = fps * 2 if info.get("interlaced") else fps
        rate = f"{shown:.0f}" if abs(shown - round(shown)) < 0.01 else f"{shown:.2f}"
    return f"{info['width']}×{info['height']}{scan}{rate}"


# Cap on bytes collected per PES payload start while hunting the SPS. SPS sits
# with VPS/PPS right at the access-unit start on IDR frames; 1024 covers every
# encoder observed (a giant leading SEI would push it out - tunable).
MAX_COLLECT = 1024
_SPS_NAL = {"h264": 7, "h265": 33}


class VideoInfoProbe:
    """Find and parse the SPS on one video PID. feed(pkt) returns an info dict
    when video parameters are (re)established, else None. Cheap steady-state:
    early-out on every non-PUSI packet once a window is not being collected;
    after the first parse, later SPS sightings byte-compare against the cached
    SPS and re-parse only on change (mid-stream format switches)."""

    def __init__(self, pid: int, codec: str):
        self.pid = pid
        self.codec = codec                   # 'h264' | 'h265'
        self._buf = None                     # collecting window or None
        self._sps = None                     # last raw SPS bytes seen
        self.info = None
        self._scrambled_reported = False

    def feed(self, pkt) -> dict | None:
        if self._buf is None and not ts_psi.ts_pusi(pkt):
            return None
        if pkt[3] & 0xC0:                    # TS-level scrambling
            if self._scrambled_reported:
                return None
            self._scrambled_reported = True
            return {"codec": self.codec, "width": None, "height": None,
                    "interlaced": None, "fps": None, "scrambled": True}
        if not ts_psi.ts_has_payload(pkt):
            return None
        off = ts_psi.payload_offset(pkt)
        if off >= ts_psi.PKT:
            return None
        payload = bytes(pkt[off:])
        if ts_psi.ts_pusi(pkt):
            # New PES payload unit: drop any unfinished window, skip the PES
            # header, start collecting.
            self._buf = None
            if len(payload) < 9 or payload[0] != 0 or payload[1] != 0 or payload[2] != 1:
                return None
            if not (0xE0 <= payload[3] <= 0xEF):
                return None                  # not a video stream id
            skip = 9 + payload[8]            # 9-byte header + extension length
            if skip >= len(payload):
                return None                  # header spans packets - wait for next PUSI
            self._buf = bytearray(payload[skip:])
        else:
            self._buf += payload
        if len(self._buf) < 16:
            return None
        info = self._scan_window()
        if info is not None or len(self._buf) >= MAX_COLLECT:
            self._buf = None                 # done with this window either way
        return info

    def _scan_window(self) -> dict | None:
        """Look for the SPS NAL in the collected window; parse when it changed."""
        buf = self._buf
        want = _SPS_NAL[self.codec]
        i = 0
        n = len(buf)
        while i + 4 < n:
            if buf[i] == 0 and buf[i + 1] == 0 and buf[i + 2] == 1:
                hdr = buf[i + 3]
                typ = (hdr >> 1) & 0x3F if self.codec == "h265" else hdr & 0x1F
                if typ == want:
                    start = i + 3
                    end = n
                    j = start + 1
                    while j + 3 <= n:        # next start code bounds the NAL
                        if buf[j] == 0 and buf[j + 1] == 0 and buf[j + 2] in (0, 1):
                            end = j
                            break
                        j += 1
                    sps = bytes(buf[start:end])
                    if sps == self._sps:
                        return None          # unchanged - nothing to report
                    hdr_len = 2 if self.codec == "h265" else 1
                    rbsp = strip_ep(sps[hdr_len:])
                    parse = parse_h265_sps if self.codec == "h265" else parse_h264_sps
                    info = parse(rbsp)
                    if info is not None:
                        self._sps = sps
                        self.info = info
                        return info
                    return None
                i += 3
            else:
                i += 1
        return None
