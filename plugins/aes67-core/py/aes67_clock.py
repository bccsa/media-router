#!/usr/bin/env python3
"""TAI ↔ house-clock arithmetic for AES67 RTP stamping (ADR-0005 decisions 5-7).

An AES67 sender's RTP timestamp is the media clock counted from the PTP epoch:
`rtptime = (TAI_ns * clock_rate / 1e9) mod 2^32`. Our pipelines run on the
house clock — a plain MONOTONIC `GstSystemClock` with `base_time=0`, so
running-time IS CLOCK_MONOTONIC (ADR-0005 decision 3). GStreamer's
`rtpbasepayload` computes

    rtptime = timestamp-offset + running_time * clock_rate / 1e9      (mod 2^32)

with the running time taken ABSOLUTELY, not relative to the first buffer
(pinned by `plugins/aes67-core/tests/aes67Gst.test.ts`). So one integer turns
a house-clock pipeline into a PTP-epoch sender:

    timestamp-offset = ((TAI_ns - MONOTONIC_ns) * clock_rate / 1e9) mod 2^32

Why measuring that offset ONCE at pipeline start is enough, and not a lie:
CLOCK_MONOTONIC on Linux is "affected by the incremental adjustments performed
by adjtime(3) and NTP" (`man 2 clock_gettime`; CLOCK_MONOTONIC_RAW is the
variant that is NOT). Both CLOCK_TAI and CLOCK_MONOTONIC therefore ride the
same disciplined timekeeper, and their difference is constant under frequency
discipline — which is exactly what `phc2sys` applies. It moves only on a STEP
(a coarse `clock_settime`, or a change to the kernel's TAI offset), which is a
discrete event the module re-measures for rather than a drift it has to track.

`disciplined` is the honest gate on all of the above: the kernel's TAI offset
is 0 until an NTP/PTP daemon sets it, and a box in that state would stamp RTP
timestamps ~37 s away from every real AES67 sender on the network. We refuse to
claim the epoch there instead of shipping a plausible wrong number.
"""

import argparse
import json
import time

#: RTP timestamps are a 32-bit field; every offset is computed modulo this.
RTP_TS_MODULO = 1 << 32

#: TAI - UTC is 37 s since 2017 and only ever grows by leap seconds. Anything
#: below this means the kernel's TAI offset was never set (no PTP/NTP daemon),
#: NOT that we live in a pre-1972 world — so it reads as "not disciplined".
#: Deliberately not pinned to 37: a future leap second must not fail the check.
MIN_TAI_UTC_OFFSET_S = 10


def read_clocks():
    """One sample of the three clocks, read as close together as possible.

    Read order matters only at the microsecond level (the residual is the cost
    of two `clock_gettime` calls), which is 5+ orders below the millisecond
    budgets anything downstream cares about.
    """
    tai = time.clock_gettime_ns(time.CLOCK_TAI)
    mono = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    realtime = time.clock_gettime_ns(time.CLOCK_REALTIME)
    return {
        "taiNs": tai,
        "monotonicNs": mono,
        "realtimeNs": realtime,
        "taiMinusMonotonicNs": tai - mono,
        "taiMinusRealtimeNs": tai - realtime,
    }


def is_disciplined(tai_minus_realtime_ns):
    """Has anything on this box set the kernel's TAI offset?

    True does not prove PTP lock — `ptp4l`+`phc2sys` and a plain NTP client
    both set it. It proves only that CLOCK_TAI means TAI here; the caller pairs
    it with its own operator-configured `ptpSync` intent.
    """
    return tai_minus_realtime_ns >= MIN_TAI_UTC_OFFSET_S * 1_000_000_000


def rtp_timestamp_offset(tai_minus_monotonic_ns, clock_rate):
    """The `timestamp-offset` that maps house-clock running time onto the PTP epoch.

    Scaled with integer arithmetic (the value is ~1.7e18 ns at boot+decades, so
    float would lose whole samples) and reduced mod 2^32, which is the same
    wrap the payloader's own 32-bit accumulation performs.
    """
    if clock_rate <= 0:
        raise ValueError("clock_rate must be positive")
    return (tai_minus_monotonic_ns * clock_rate // 1_000_000_000) % RTP_TS_MODULO


def epoch_state(clock_rate=48000, clocks=None):
    """Everything a sender module needs to decide whether it can claim the epoch.

    `rtpTimestampOffset` is None when the box is not disciplined: a caller must
    then leave the payloader on its random RFC 3550 offset (a free-running
    sender) rather than stamping a fabricated epoch.
    """
    c = clocks if clocks is not None else read_clocks()
    disciplined = is_disciplined(c["taiMinusRealtimeNs"])
    return {
        "clockRate": clock_rate,
        "disciplined": disciplined,
        "taiOffsetS": round(c["taiMinusRealtimeNs"] / 1e9, 3),
        "taiMinusMonotonicNs": c["taiMinusMonotonicNs"],
        "rtpTimestampOffset": (
            rtp_timestamp_offset(c["taiMinusMonotonicNs"], clock_rate) if disciplined else None
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clock-rate", type=int, default=48000,
                        help="RTP media clock rate (default 48000)")
    parser.add_argument("--json", action="store_true",
                        help="emit one JSON object (the only output mode; kept explicit)")
    args = parser.parse_args()
    state = epoch_state(args.clock_rate)
    print(json.dumps(state), flush=True)
    # Exit 0 either way: "not disciplined" is an answer, not a failure. The
    # caller decides what to do with it (we warn and free-run).
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
