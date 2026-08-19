#!/usr/bin/env python3
"""Logic tests for aes67_clock.py. Run: python3 aes67_clock_test.py

The arithmetic is tested against SYNTHETIC clock samples, because the box
running the suite is almost never PTP-disciplined — the one thing that must
never happen is a green suite that only proves "this machine has no TAI
offset". The real clocks are read once at the end, and only to assert the
shape of the answer.
"""
import aes67_clock as c


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


GS = 1_000_000_000

# --- the epoch offset ------------------------------------------------------
# One second of TAI-vs-monotonic separation is exactly one second of media
# clock: 48000 samples at 48 kHz.
check("one second of offset is one second of samples",
      c.rtp_timestamp_offset(GS, 48000) == 48000)
check("integer truncation, not float rounding",
      c.rtp_timestamp_offset(GS + 1, 48000) == 48000)
check("zero offset is zero", c.rtp_timestamp_offset(0, 48000) == 0)

# The offset is reduced mod 2^32 because the RTP timestamp field is 32 bits —
# and a real TAI-minus-monotonic value (~1.79e18 ns) wraps it ~20000 times.
big = 1_786_464_746 * GS
check("wraps into the 32-bit RTP field",
      0 <= c.rtp_timestamp_offset(big, 48000) < c.RTP_TS_MODULO)
check("wrap is modular, not saturating",
      c.rtp_timestamp_offset(big, 48000)
      == (big * 48000 // GS) % c.RTP_TS_MODULO)
# Advancing by a whole number of wraps must land on the same offset — the
# property that makes the truncation harmless rather than a rounding error.
# Three wraps, not one: 2^32 samples is 2^32 x 62500/3 ns, which is only a
# whole nanosecond count in multiples of three.
three_wraps_ns = c.RTP_TS_MODULO * 62500
check("advancing by whole wraps is a no-op",
      c.rtp_timestamp_offset(big, 48000)
      == c.rtp_timestamp_offset(big + three_wraps_ns, 48000))
try:
    c.rtp_timestamp_offset(GS, 0)
    check("rejects a zero clock rate", False)
except ValueError:
    check("rejects a zero clock rate", True)

# --- the discipline gate ---------------------------------------------------
# The kernel's TAI offset is 0 until an NTP/PTP daemon sets it. A box in that
# state would stamp RTP timestamps ~37 s away from every real AES67 sender.
check("undisciplined: TAI == UTC", c.is_disciplined(0) is False)
check("undisciplined: sub-second offset", c.is_disciplined(999_999_999) is False)
check("disciplined: today's 37 s", c.is_disciplined(37 * GS) is True)
# Not pinned to 37: a future leap second must not fail the check.
check("disciplined: a future 38 s", c.is_disciplined(38 * GS) is True)
check("threshold is 10 s", c.is_disciplined(10 * GS) is True and
      c.is_disciplined(10 * GS - 1) is False)

# --- what the sender module reads -----------------------------------------
disciplined = c.epoch_state(48000, clocks={
    "taiNs": 1_786_464_783 * GS, "monotonicNs": 37 * GS,
    "realtimeNs": 1_786_464_746 * GS,
    "taiMinusMonotonicNs": (1_786_464_783 - 37) * GS,
    "taiMinusRealtimeNs": 37 * GS,
})
check("disciplined box reports an offset", disciplined["rtpTimestampOffset"] is not None)
check("offset matches the standalone arithmetic",
      disciplined["rtpTimestampOffset"]
      == c.rtp_timestamp_offset((1_786_464_783 - 37) * GS, 48000))
check("tai offset is reported in seconds for the operator",
      disciplined["taiOffsetS"] == 37.0)

free = c.epoch_state(48000, clocks={
    "taiNs": 1_786_464_746 * GS, "monotonicNs": 37 * GS,
    "realtimeNs": 1_786_464_746 * GS,
    "taiMinusMonotonicNs": (1_786_464_746 - 37) * GS,
    "taiMinusRealtimeNs": 0,
})
# None, not 0: 0 is a legal offset and would be silently wrong. The sender must
# be able to tell "no epoch" from "epoch at zero" and fall back to a random
# RFC 3550 offset instead of fabricating one.
check("undisciplined box reports NO offset", free["rtpTimestampOffset"] is None)
check("undisciplined box says so", free["disciplined"] is False)

# --- the real clocks (shape only) -----------------------------------------
live = c.epoch_state(48000)
check("live read returns every field",
      set(live) == {"clockRate", "disciplined", "taiOffsetS",
                    "taiMinusMonotonicNs", "rtpTimestampOffset"})
check("live offset is present iff disciplined",
      (live["rtpTimestampOffset"] is not None) == live["disciplined"])
print("  (this box: disciplined=%s, TAI-UTC=%ss)" % (live["disciplined"], live["taiOffsetS"]))

print("\nall aes67_clock tests passed")
