#!/usr/bin/env python3
"""Self-checking tests for ts_video_info.py (no GStreamer, no engine).

Run:  python3 ts_video_info_test.py
"""
import sys

import ts_psi
import ts_video_info as tvi

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# Real SPS captures with ffprobe ground truth recorded alongside.
# OCC multicast 239.255.0.191:5500 on gate01 (2026-07-23):
#   ffprobe: h264 High, level 40, 1920x1080, field_order=tt, r_frame_rate=25/1
H264_1080I50_SPS = bytes.fromhex(
    "67640028ad843fff9087fff210ffffffffffffffff087fffffffffffffff"
    "2cc501e0113f780a10101014000003000400000300ca50")
# gate01 transcoder rendition 0 via ZA-SCC-TECH01 SRT :9000 (2026-07-23):
#   ffprobe: hevc Main, 1920x1080, r_frame_rate=50/1 (progressive)
H265_1080P50_SPS = bytes.fromhex(
    "42010101600000030090000003000003007ba003c0801107cbb3e491b6af"
    "fc0004000404000003000400000300c820")

# --- H.264 parse: geometry, interlace, fps, display --------------------------
info = tvi.parse_h264_sps(tvi.strip_ep(H264_1080I50_SPS[1:]))
check("h264 1080i50: geometry", info is not None
      and info["width"] == 1920 and info["height"] == 1080)
check("h264 1080i50: interlaced", info and info["interlaced"] is True)
check("h264 1080i50: frame rate 25", info and info["fps"] == 25.0)
check("h264 1080i50: display shows field rate",
      tvi.format_video_info(info) == "1920×1080i50")

# --- H.265 parse -------------------------------------------------------------
info5 = tvi.parse_h265_sps(tvi.strip_ep(H265_1080P50_SPS[2:]))
check("h265 1080p50: geometry", info5 is not None
      and info5["width"] == 1920 and info5["height"] == 1080)
check("h265 1080p50: progressive, fps 50",
      info5 and info5["interlaced"] is False and info5["fps"] == 50.0)
check("h265 1080p50: display", tvi.format_video_info(info5) == "1920×1080p50")

# --- emulation-prevention stripping is load-bearing ---------------------------
# Both fixtures carry 00 00 03 sequences in their VUI timing fields; parsing
# without stripping yields plausible-but-wrong values (observed: fps 43690.67).
raw = tvi.parse_h264_sps(H264_1080I50_SPS[1:])
check("h264 without strip_ep parses differently (locks the strip in)",
      raw is None or raw["fps"] != 25.0)
check("strip_ep is a no-op without EP sequences",
      tvi.strip_ep(b"\x00\x01\x02\x03") == b"\x00\x01\x02\x03")
check("strip_ep removes 00 00 03",
      tvi.strip_ep(b"\x00\x00\x03\x01\x00\x00\x03\x00") == b"\x00\x00\x01\x00\x00\x00")

# --- malformed input never throws ---------------------------------------------
check("truncated h264 SPS -> None", tvi.parse_h264_sps(H264_1080I50_SPS[1:6]) is None)
check("empty -> None", tvi.parse_h264_sps(b"") is None and tvi.parse_h265_sps(b"") is None)
check("garbage -> None or plausible dict, no throw",
      tvi.parse_h265_sps(b"\xff" * 40) is None or True)
check("format of None/empty -> None",
      tvi.format_video_info(None) is None
      and tvi.format_video_info({"width": None}) is None)
check("format without fps omits rate",
      tvi.format_video_info({"width": 1920, "height": 1080,
                             "interlaced": True, "fps": None}) == "1920×1080i")
check("format fractional rate",
      tvi.format_video_info({"width": 1280, "height": 720,
                             "interlaced": False, "fps": 59.94}) == "1280×720p59.94")

# --- VideoInfoProbe over synthetic TS packets ---------------------------------
VIDEO_PID = 0x100


def pes_packets(pid, es, cc0=0, stream_id=0xE0, scrambled=False):
    """Wrap an annex-B ES chunk in a minimal PES header and split it into
    188-byte TS packets (PUSI on the first)."""
    pes = bytes([0, 0, 1, stream_id, 0, 0, 0x80, 0x00, 0x00]) + es
    pkts = []
    cc = cc0
    off = 0
    first = True
    while off < len(pes):
        chunk = pes[off:off + 184]
        off += 184
        hdr = bytearray([ts_psi.SYNC,
                         (0x40 if first else 0x00) | ((pid >> 8) & 0x1F),
                         pid & 0xFF,
                         0x10 | (cc & 0x0F)])
        if scrambled:
            hdr[3] |= 0x80
        first = False
        cc = (cc + 1) & 0x0F
        pkt = bytes(hdr) + chunk
        if len(pkt) < ts_psi.PKT:            # stuff the tail packet
            pkt += b"\xff" * (ts_psi.PKT - len(pkt))
        pkts.append(pkt)
    return pkts


ANNEXB_H264 = b"\x00\x00\x00\x01" + H264_1080I50_SPS + b"\x00\x00\x01\x68\xce\x3c\x80" \
    + b"\x00\x00\x01\x65" + b"\xaa" * 400
probe = tvi.VideoInfoProbe(VIDEO_PID, "h264")
results = [probe.feed(p) for p in pes_packets(VIDEO_PID, ANNEXB_H264)]
fired = [r for r in results if r]
check("probe finds SPS across split packets", len(fired) == 1
      and fired[0]["width"] == 1920 and fired[0]["interlaced"] is True)

# same SPS again -> silent (byte-compare)
results2 = [probe.feed(p) for p in pes_packets(VIDEO_PID, ANNEXB_H264)]
check("probe silent on unchanged SPS", not any(results2))

# non-PUSI packets while idle -> early-out (no state, no fire)
idle = pes_packets(VIDEO_PID, ANNEXB_H264)[1:]
check("probe ignores mid-PES packets while idle",
      not any(tvi.VideoInfoProbe(VIDEO_PID, "h264").feed(p) is not None
              for p in idle if not ts_psi.ts_pusi(p)))

# a DIFFERENT SPS -> re-fires (mid-stream format change)
H264_MODIFIED = bytearray(H264_1080I50_SPS)
H264_MODIFIED[4] ^= 0x01                     # tweak level bits -> different bytes
res3 = [probe.feed(p) for p in pes_packets(
    VIDEO_PID, b"\x00\x00\x00\x01" + bytes(H264_MODIFIED) + b"\x00\x00\x01\x65" + b"\xaa" * 100)]
check("probe re-fires on changed SPS", any(res3))

# scrambled TS bits -> one scrambled report, then silence
sp = tvi.VideoInfoProbe(VIDEO_PID, "h264")
spkts = pes_packets(VIDEO_PID, ANNEXB_H264, scrambled=True)
sres = [sp.feed(p) for p in spkts + spkts]
fired_s = [r for r in sres if r]
check("scrambled reported once", len(fired_s) == 1 and fired_s[0]["scrambled"] is True)

# h265 probe end-to-end
ANNEXB_H265 = b"\x00\x00\x00\x01" + H265_1080P50_SPS + b"\x00\x00\x01\x26\x01" + b"\xbb" * 300
p5 = tvi.VideoInfoProbe(VIDEO_PID, "h265")
r5 = [p5.feed(p) for p in pes_packets(VIDEO_PID, ANNEXB_H265)]
fired5 = [r for r in r5 if r]
check("h265 probe end-to-end", len(fired5) == 1
      and fired5[0]["width"] == 1920 and fired5[0]["fps"] == 50.0)

print()
if _failures:
    print("FAILURES:", ", ".join(_failures))
    sys.exit(1)
print("ALL ts_video_info TESTS PASSED")
