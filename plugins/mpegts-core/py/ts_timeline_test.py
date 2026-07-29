#!/usr/bin/env python3
"""Logic tests for ts_timeline.py. Run: python3 ts_timeline_test.py"""
import ts_timeline as t
from ts_psi_test import pes_ts_packet  # reuse the hand-built PES packet helper
import ts_psi as p


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


# 90 kHz -> ns conversion is exact for whole-second values and monotone.
check("90k->ns one second", t.pts90k_to_ns(90000) == 1_000_000_000)
check("90k->ns one tick", t.pts90k_to_ns(1) == 11111)

latch = t.TimelineLatch()
video = pes_ts_packet(0x65, pts=900000)              # 10 s
audio = pes_ts_packet(0xCC, pts=900900)              # 10.01 s
later_video = pes_ts_packet(0x65, pts=1800000)       # must NOT overwrite

# Multi-PID interleave with non-PES noise: each PID latches its own first PTS.
latch.feed(p.null_packet() + video + audio + later_video)
check("video PID latched first PTS", latch.first_pts[0x65] == 900000)
check("audio PID latched first PTS", latch.first_pts[0xCC] == 900900)
check("latched() reflects state", latch.latched(0x65) and not latch.latched(0x99))

# Second feed never overwrites (latch-once semantics).
latch.feed(pes_ts_packet(0x65, pts=42))
check("first PTS is sticky", latch.first_pts[0x65] == 900000)

# offset math: source 10 s, tsdemux rebased first buffer to 1 s -> +9 s shift.
check("offset_ns shifts to source timeline",
      latch.offset_ns(0x65, 1_000_000_000) == 9_000_000_000)
check("offset_ns can be negative",
      latch.offset_ns(0x65, 11_000_000_000) == -1_000_000_000)
check("offset_ns None when unlatched", latch.offset_ns(0x99, 0) is None)

# PES without PTS and PSI packets never latch.
quiet = t.TimelineLatch()
quiet.feed(pes_ts_packet(0x65) + p.build_pat(1, {1: 0x100}))
check("no latch from PTS-less PES / PSI", quiet.first_pts == {})

# Epoch-consistent latching astride the 33-bit boundary (the 2026-07-16
# mid-wrap-restart failure mode): first PID latches just BELOW 2^33, second
# just after the wrap — the second must unwrap UP onto the first's epoch.
W = t.PTS_WRAP
straddle = t.TimelineLatch()
straddle.feed(pes_ts_packet(0x65, pts=W - 9000))       # 100 ms pre-wrap
straddle.feed(pes_ts_packet(0xCC, pts=4500))           # 50 ms post-wrap
check("post-wrap PID unwraps onto the pre-wrap epoch",
      straddle.first_pts[0xCC] == W + 4500)
check("epoch-consistent offsets differ by real skew only",
      straddle.offset_ns(0xCC, 0) - straddle.offset_ns(0x65, 0)
      == t.pts90k_to_ns(W + 4500) - t.pts90k_to_ns(W - 9000))

# Mirror case: first PID latches post-wrap, straggler arrives pre-wrap —
# unwraps DOWN (slightly negative), never 26.5 h away.
mirror = t.TimelineLatch()
mirror.feed(pes_ts_packet(0x65, pts=4500))
mirror.feed(pes_ts_packet(0xCC, pts=W - 9000))
check("pre-wrap straggler unwraps down beside the epoch",
      mirror.first_pts[0xCC] == -9000)

# unwrap_near is identity when no boundary is involved.
check("unwrap_near identity", t.unwrap_near(900000, 900900) == 900000)

print("\nALL ts_timeline TESTS PASSED")
