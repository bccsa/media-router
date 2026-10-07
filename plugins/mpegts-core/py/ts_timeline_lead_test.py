#!/usr/bin/env python3
"""A CBR contribution feed through the egress stamper (#816, NO-OCC-Gate01
2026-10-07). Run: python3 ts_timeline_lead_test.py

The feed is a synthetic copy of the one Gate01 ingests (multicast 239.255.0.191,
1080i50 H.264 CBR 28.6 Mbit/s): an 8-frame hierarchical-B GOP, so the PTS of a
PES in decode order jumps +360 ms from the last B of one mini-GOP to the next P,
and an encoder buffer that sends each picture 0.7-1.3 s ahead of its DTS, the
lead wandering over 37 s; the PCR rides the video and tracks arrival exactly,
the audio arrives 60 ms ahead of its PTS. What the capture measured: PCR within
±1 ms of arrival, PES 0.34-1.63 s ahead of it, +360 ms reorder steps 1.3 a
second. On e1ea55cd the conditioner read every +360 ms as a +0.32 s clock step
and the late tier re-anchored every ~10 s; with the conditioner fixed, the lead
wander alone still re-anchored. Twin: native/mrts/tests/ts_timeline_lead_test.cpp
(the same fixture, the same integers).
"""
import ts_timeline as t
from ts_psi_test import pes_ts_packet  # reuse the hand-built PES packet helper
import ts_psi as p


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


V, A = 0x65, 0xC9
STEP, STEP_NS = 3600, 40_000_000           # one 25 fps frame
HOUSE, FIRST = 1_000_000_000_000, 8_100_000
MINI = (8, 4, 2, 1, 3, 6, 5, 7)             # display slot of each decode position in the mini-GOP
REORDER = 2                                 # frames between decode and the earliest presentation
TOP_NS = 1_300_000_000                      # the wander's largest lead
FRAMES = 7500                               # 300 s
STALL_NS = 520_000_000                      # a path stall: 13 frames held back
RESTART_BACK = 3600 * 90_000                # an encoder restart: every clock an hour back


def wander(i):
    """The encoder buffer's lead of picture i's DTS over the PCR it leaves at:
    a 924-frame (37 s) triangle from 1.3 s down to 0.7 s and back, top first."""
    return 700_000_000 + abs(i % 924 - 462) * 600_000_000 // 462


def fill(i):
    """A buffer filling from 0.2 s to 1.8 s over the first 20 s, then full."""
    return 200_000_000 + min(i, 500) * 1_600_000_000 // 500


def pcr27(src_ns):
    """The source's PCR at `src_ns` of its own clock (house-aligned): it IS the
    transport, so a packet leaving at that time carries exactly this."""
    return (FIRST - TOP_NS * 9 // 100000) * 300 + (src_ns - HOUSE) * 27 // 1000


def run(lead=wander, late_from=FRAMES, late_ns=0, pcr_until=FRAMES, stall_at=FRAMES, restart_at=FRAMES):
    """Feed FRAMES pictures and their audio through ONE stamper as mrtsstamp
    drives it (repair-latch on: condition, then stamp, on the same bytes).
    `late_ns` makes the PATH slower from picture `late_from` on (every packet
    arrives later; the clocks it carries do not move). No PCR from picture
    `pcr_until` on. The path stops for STALL_NS when picture `stall_at` leaves
    and then delivers what it held back at once, in order. The encoder
    restarts at picture `restart_at`: nothing for 2 s, then every clock
    RESTART_BACK back. Returns (re-anchors, conditioned events, video PES
    rewritten)."""
    re, cond = [], []
    st = t.TimelineStamper(on_reanchor=re.append, on_conditioned=cond.append, repair_latch=True)
    t0 = HOUSE + stall_at * STEP_NS + TOP_NS - lead(stall_at)

    def path(h):
        return t0 + STALL_NS - (t0 + STALL_NS - h) // 1000 - 1 if t0 <= h < t0 + STALL_NS else h
    bufs = []
    for i in range(FRAMES):
        m, j = divmod(i, 8)
        back, gap = (RESTART_BACK, 2_000_000_000) if i >= restart_at else (0, 0)
        dts = (FIRST + i * STEP - back) % t.PTS_WRAP
        pts = (FIRST + (8 * m + MINI[j] + REORDER) * STEP - back) % t.PTS_WRAP
        src = HOUSE + i * STEP_NS + TOP_NS - lead(i)               # when it leaves the encoder
        delay = (late_ns if i >= late_from else 0) + gap
        pkt = pes_ts_packet(V, pts=pts, dts=dts if pts != dts else None)
        if i < pcr_until:
            pkt = p.build_pcr_packet(V, (pcr27(src) - back * 300) % t.PCR_MODULO) + pkt
        bufs.append((path(src + delay), 0, pkt, pts, dts))
        a_src = HOUSE + TOP_NS - lead(0) + 20_000_000 + i * STEP_NS     # audio: 60 ms ahead of its PTS
        a_pts = (pcr27(a_src) // 300 + 5400 - back) % t.PTS_WRAP
        bufs.append((path(a_src + delay), 1, pes_ts_packet(A, pts=a_pts, stream_id=0xC0), None, None))
    bufs.sort(key=lambda b: (b[0], b[1]))
    rewritten = 0
    for h, kind, pkt, pts, dts in bufs:
        buf = bytearray(pkt)
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
        if kind == 0:
            pes = list(p.iter_packets(bytes(buf)))[-1]
            if p.read_pes_pts(pes) != pts or t.read_pes_dts(pes) != (dts if pts != dts else None):
                rewritten += 1
    return re, cond, rewritten


# --- the feed as captured: nothing on it is a step, nothing is late ----------
re, cond, rewritten = run()
check("a +360 ms reorder step is never read as a clock step (decode clock: one frame)",
      [e for e in cond if e['clock'] == 'pts'] == [])
check("... so not one video PES is rewritten in 300 s", rewritten == 0)
check("the PTS lead wandering 0.7-1.7 s (buffer 0.7-1.3 s + reorder) over an on-time transport never re-anchors",
      re == [])

# --- the EARLY side alike: the buffer filling by 1.6 s after the anchor -------
# Every PES then runs ~1 s further ahead of its stamp than at the anchor — past
# `_EARLY_NS` for good — while the transport stays exactly on time.
re, cond, rewritten = run(lead=fill)
check("a buffer filling to a 1.6 s higher lead after the anchor never re-anchors (transport on time)",
      re == [])

# --- a path that really gets 400 ms slower still re-anchors, once -------------
# Timed so the re-anchor lands on the wander's top: the lead then sags for
# 18 s, which only a FRESH transport reference keeps from re-anchoring again.
LATE_AT = 2522                                                  # 100.9 s in
re, cond, rewritten = run(late_from=LATE_AT, late_ns=400_000_000)
late_at_ns = LATE_AT * STEP_NS + TOP_NS - wander(LATE_AT) + 400_000_000
check("a path 400 ms slower (the PCR's arrival moves with the PES) re-anchors exactly once",
      len(re) == 1 and re[0]['deltaTicks'] < 0)
check("... once its hold has matured (10-11 s after the path slowed)",
      len(re) == 1 and 10_000_000_000 <= re[0]['anchorNs'] - HOUSE - late_at_ns <= 11_000_000_000)
check("... on the same PES with the same level as the C++ twin (parity)",
      len(re) == 1 and re[0]['anchorNs'] - HOUSE == 111_610_389_611 and re[0]['deltaTicks'] == -36467)

# --- without the PCR the PES decide alone again (`_TX_FRESH_NS`) --------------
PCR_UNTIL = 500                                                 # 20 s
re, cond, rewritten = run(pcr_until=PCR_UNTIL)
check("no PCR on the timing PID for over 1 s: the PES level decides again (re-anchors on the wander)",
      len(re) >= 1 and re[0]['anchorNs'] - HOUSE > PCR_UNTIL * STEP_NS + 1_000_000_000)
check("... first on the same PES as the C++ twin (parity)",
      len(re) >= 1 and re[0]['anchorNs'] - HOUSE == 31_541_818_182)

# --- a stalled path is not a broken PCR (one-sided) ------------------------------
# The path stops for 520 ms and then hands over what it held back at once: the
# PCR moved 40 ms against 520 ms of arrival, then 40 ms against none, PCR to
# PCR. Neither is the PCR running ahead of arrival (a stall, a loss or a burst
# only ever moves arrival against it), so the transport keeps judging and the
# wander still never re-anchors; read both ways, it would stand down at the
# stall and the PES would decide alone again.
re, cond, rewritten = run(stall_at=1000)                         # 40 s in
check("a 520 ms stall of the path, then its backlog at once, leaves the transport judging (no re-anchor)",
      re == [])

# --- an encoder restart re-anchors once, and its new PCR judges again -----------
# 2 s of nothing, then every clock an hour back: the watch re-anchors on the
# jump, and the new PCR — one step back after an outage, not a pause — must
# only qualify again (10 s) to keep the wander from re-anchoring after it.
re, cond, rewritten = run(restart_at=2000)                       # 80 s in
check("an encoder restart (2 s gone, clocks an hour back) re-anchors once; the PCR judges again after it",
      [(e['anchorNs'] - HOUSE, e['deltaTicks']) for e in re] == [(82_238_701_299, -323_982_000)])

# --- a PCR that leaps ahead of arrival is no transport clock (vMix, .103) --------
# The captured .103 shape (ts_timeline_test.py), 14-20 s in — after the PCR has
# tracked arrival for 10 s: audio steps back 1.42 s, video 1.19 s, both leap
# forward again and the PCR leaps +1.19 s and STAYS there, so the conditioner
# takes the PES steps back out and the source's PCR ends 1.19 s off its arrival.
# From 34 s the path gets 300 ms slower: a genuine late level, which must still
# re-anchor once (the PCR leapt against arrival, so the PES decide alone) — read
# as a transport, the PCR said "1.19 s early" until the next anchor.
def vmix_then_late(late_at=850, late_ns=300_000_000, n=1250):
    VX, AX, A_BACK, V_BACK = 0x100, 0x140, 127800, 107100
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    for i in range(n):
        h = HOUSE + i * STEP_NS + (late_ns if i >= late_at else 0)
        v = FIRST + i * STEP - (V_BACK if 400 <= i < 500 else 0)
        a = FIRST + 900 + i * STEP - (A_BACK if 350 <= i < 499 else 0)
        buf = bytearray(p.build_pcr_packet(VX, (FIRST - 9000 + i * STEP + (V_BACK if i >= 500 else 0)) * 300)
                        + pes_ts_packet(VX, pts=v)
                        + pes_ts_packet(AX, pts=a, dts=(a + A_BACK) if 350 <= i < 499 else None))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return re
re = vmix_then_late()
check("vMix's PCR leap is no transport: a later 300 ms late path still re-anchors once, 10 s on (as e1ea55cd)",
      len(re) == 1 and re[0]['anchorNs'] - HOUSE == 44_300_000_000 and re[0]['deltaTicks'] == -27000)

# --- a PCR that stops and then lags never judges again (#820) -------------------
# vMix's pacer clock stops while its pictures run on and lags from then on
# (12.6 s on .103; a 1.5 s freeze measured there): here, one PES and its PCR a
# frame, 1 s apart, the PCR stands still for 1.48 s at 20 s and runs on 1.48 s
# behind for good. That source keeps today's handling on this egress — the PES
# decide every level alone, re-anchor for re-anchor as on e1ea55cd: the path
# 1.5 s deep draining from 60 s (early), 400 ms slower from 100 s (late), and
# 30 s of pictures 250 ms closer to their PTS from 160 s (late). A re-anchor
# does not restore the PCR's standing: lagging at its rate, it would have
# qualified again and kept the last one quiet — which is what a PCR that only
# STEPS back gets (a reset, or a restart: it re-anchors anyway): it stands down
# until the next anchor, then tracks arrival for 10 s and judges again.
def vmix_pcr(reset=False, n=5000):
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    h = None
    for i in range(n):
        src = HOUSE + i * STEP_NS
        if i < 1500:
            h = src + 1_500_000_000
        else:
            h = max(src + (400_000_000 if i >= 2500 else 0), h + 100_000)
        k = i if i < 500 else i - 25 if reset else max(500, i - 37)         # the PCR's frame
        sag = 22_500 if 4000 <= i < 4750 else 0
        buf = bytearray(p.build_pcr_packet(V, (FIRST - 90_000 + k * STEP) * 300)
                        + pes_ts_packet(V, pts=FIRST + i * STEP - sag))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return [(e['anchorNs'] - HOUSE, e['deltaTicks']) for e in re]
check("a PCR that stops for 1.48 s, then lags (vMix's pacer, #820), never judges: every level as e1ea55cd",
      vmix_pcr() == [(71_480_000_000, 75411), (110_400_000_000, -36000), (170_400_000_000, -22500)])
check("... one that steps back 1 s instead judges again after the next anchor: the last sag stays quiet",
      vmix_pcr(reset=True) == [(71_480_000_000, 75411), (110_400_000_000, -36000)])

# --- a PCR that does not track arrival never judges (#820) ----------------------
# The path hands the feed over in 400 ms bursts (ten pictures at once), so the
# arrival wanders 0-360 ms against the PCR and never stays within `_LATE_NS` of
# it for 10 s: the PES decide alone, and 30 s of pictures 250 ms closer to their
# PTS re-anchor once, as on e1ea55cd. Trusted for merely running on, its
# moments on time would have kept that from the tier.
def bursty_sag(n=3000):
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    for i in range(n):
        h = HOUSE + (i // 10 * 10 + 9) * STEP_NS + i * 1000                 # with the tenth picture
        sag = 22_500 if 1500 <= i < 2250 else 0
        buf = bytearray(p.build_pcr_packet(V, (FIRST - 90_000 + i * STEP) * 300)
                        + pes_ts_packet(V, pts=FIRST + i * STEP - sag))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return [(e['anchorNs'] - HOUSE, e['deltaTicks']) for e in re]
check("a PCR the path delivers in 400 ms bursts never tracks arrival, never judges: a sag as e1ea55cd",
      bursty_sag() == [(70_361_750_000, -22635)])

# --- an anchor older than half the PCR's 26.5 h period still judges -----------
# One PES and its PCR a second, the PCR starting an hour before its 33-bit wrap;
# at 13.5 h (past the 13.26 h at which a PCR folded against a fixed reference
# reads a whole period off) the encoder sends 30 s of pictures 250 ms closer to
# their PTS — PES late, transport on time. Unwrapped PCR to PCR, the transport
# still says so; the control is the same sag one hour in.
def long_sag(sag_at, n):
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    pcr0 = t.PCR_MODULO - 3600 * 27_000_000
    for i in range(n):
        h = HOUSE + i * 1_000_000_000
        lead = 75_000 if sag_at <= i < sag_at + 30 else 90_000            # 1.0 s, 0.75 s in the sag
        pts = (pcr0 // 300 + i * 90_000 + lead) % t.PTS_WRAP
        buf = bytearray(p.build_pcr_packet(V, (pcr0 + i * 27_000_000) % t.PCR_MODULO) + pes_ts_packet(V, pts=pts))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return re
check("a 250 ms lead sag over an on-time transport never re-anchors, one hour in (across the PCR wrap)",
      long_sag(3600, 3700) == [])
check("... nor 13.5 h in, past half the PCR period (the PCR unwrapped PCR to PCR)",
      long_sag(48_600, 48_700) == [])

# --- a reconnect backlog at the anchor does not keep the PCR from judging -------
# The first 45 pictures (1.8 s) arrive flushed back to back with the 45th, then
# the feed runs live; from 20 s to 50 s the encoder sends its pictures 250 ms
# closer to their PTS, and from 60 s the path gets 400 ms slower. The
# transport's reference is its EARLIEST arrival in the repair window (the
# backlog drained), so it qualifies, keeps the sag quiet and reads the late path
# +400 ms: one re-anchor. Referenced on the backlog's head it would read 1.76 s
# early, never qualify, and leave the sag to the PES (re-anchored at 30 s).
def backlog_then_late(late_at=1500, n=2000):
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    for i in range(n):
        src = HOUSE + i * STEP_NS
        h = (HOUSE + 44 * STEP_NS + i * 100_000) if i < 45 else src + (400_000_000 if i >= late_at else 0)
        sag = 22_500 if 500 <= i < 1250 else 0
        buf = bytearray(p.build_pcr_packet(V, (FIRST - 90_000 + i * STEP) * 300)
                        + pes_ts_packet(V, pts=FIRST + i * STEP - sag))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return re
re = backlog_then_late()
check("a backlog at the anchor, a lead sag, then a path 400 ms slower: re-anchors exactly once, 10 s on",
      len(re) == 1 and re[0]['anchorNs'] - HOUSE == 70_400_000_000 and re[0]['deltaTicks'] == -36000)

# --- the transport is judged net of the drift slew ------------------------------
# A source clock 20 ppm slow, one PES and PCR a second: by 3 h the servo has
# locked (~20 ppm) and slewed the anchor ~173 ms after it, so the transport, read
# raw, is ~216 ms "late" — net of the slew it is where the stamps are (~43 ms).
# A 250 ms lead sag there is the encoder's buffering, and never re-anchors.
def drift_sag(ppm=20, hours=3):
    re = []
    st = t.TimelineStamper(on_reanchor=re.append, repair_latch=True)
    n = hours * 3600
    for i in range(n):
        h = HOUSE + i * 1_000_000_000
        src = i * (1_000_000_000 - ppm * 1000)                            # the source's own clock
        lead = 75_000 if n - 60 <= i < n - 30 else 90_000
        buf = bytearray(p.build_pcr_packet(V, (FIRST * 300 + src * 27 // 1000) % t.PCR_MODULO)
                        + pes_ts_packet(V, pts=(FIRST + src * 9 // 100000 + lead) % t.PTS_WRAP))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return re, st.drift_stats()
re, drift = drift_sag()
check("a 20 ppm source with the servo locked: a lead sag never re-anchors (the transport net of the slew)",
      re == [] and drift['ppb'] == 19997 and drift['slewNs'] == 172_784_623)

# --- and through the conditioner's program correction ---------------------------
# A reordered feed whose PES carry no DTS is judged on its PTS, so the
# conditioner still reads the +360 ms reorder (here every third mini-GOP) as a
# clock step and the written video timeline falls 0.33 s behind every second.
# The stamps are cut from that written timeline, so the transport is read
# through the same correction — and so read, this PCR never tracks arrival
# for 10 s and never judges: the stamps falling behind reach the late tier
# every ~10 s exactly as on e1ea55cd. Read past the correction, the PCR would
# have qualified as on time and hidden them until the 5 s net.
def dtsless(n=1500):
    re, cond = [], []
    st = t.TimelineStamper(on_reanchor=re.append, on_conditioned=cond.append, repair_latch=True)
    for i in range(n):
        m, j = divmod(i, 8)
        pts = FIRST + ((8 * m + MINI[j]) if m % 3 == 0 else i) * STEP + REORDER * STEP
        h = HOUSE + i * STEP_NS
        buf = bytearray(p.build_pcr_packet(V, (FIRST - 90_000 + i * STEP) * 300) + pes_ts_packet(V, pts=pts))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return re, cond
re, cond = dtsless()
check("a reordered feed without DTS: the conditioner's error still reaches the late tier (as e1ea55cd)",
      len([e for e in cond if e['clock'] == 'pts']) == 62
      and [(e['anchorNs'] - HOUSE, e['deltaTicks']) for e in re]
      == [(10_040_000_000, -18000), (20_600_000_000, -18000), (31_160_000_000, -18000),
          (41_720_000_000, -18000), (52_280_000_000, -18000)])

print("\nALL ts_timeline lead TESTS PASSED")
