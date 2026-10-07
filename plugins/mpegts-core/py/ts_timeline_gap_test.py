#!/usr/bin/env python3
"""ts_timeline.py across a delivery gap: the gap carry, the held frame and the
late hold (.24 Translation Station, 2026-10-06; ADR-0005 decision 2 and
Stage 3f amendments 2026-10-07). The C++ twin is native/mrts/tests/
ts_timeline_gap_test.cpp: the same checks, names and order.
Run: python3 ts_timeline_gap_test.py"""
import ts_timeline as t
from ts_psi_test import pes_ts_packet  # reuse the hand-built PES packet helper
import ts_psi as p


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


HOUSE, FIRST, STEP_NS = 1_000_000_000_000, 8_100_000, 40_000_000

# --- the gap carry: a reconnect keeps the timeline ---------------------------
# .21's wire PTS is its house clock + mpegtsmux's 1 h, so every .21 muxer restart
# reached .24 as a 5-17 s SRT outage inside ONE timeline, the first PES back the
# head of the reconnect's backlog (-26..+160 ms on the mapping before the gap at
# 30 of 34 reconnects; -132..-169 ms, an early transient, at the 4 right after a
# .21 producer restart). The watch re-anchored on each: a fresh latch per
# reconnect, the splitter's mapping stepping -36..+46 ms and the Hall
# transcoder's egress -70..+59 ms.
G_V, G_A, G_H = 250, 251, 0x41
G_VSTEP, G_ASTEP = 3600, 1920              # 40 ms video, 21.333 ms AAC / 302M
G_FIRST = 3600 * 90000 + FIRST             # .21's wire: house + 1 h
G_TRANSIT, MS = 100_000_000, 1_000_000


def _gpes(pid, pts, sid, pcr=False):
    """A PES start, carrying the PCR 250 ms behind its PTS when `pcr` (mpegtsmux's layout)."""
    if not pcr:
        return pes_ts_packet(pid, pts=pts, stream_id=sid)
    b = bytearray(pes_ts_packet(pid, pts=pts, af_len=7, stream_id=sid))
    b[5:12] = p.build_pcr_packet(pid, (pts - 22500) * 300)[5:12]
    return bytes(b)


def _gap_events(repair=True):
    ev = {'re': [], 'se': [], 'gap': [], 'cond': []}
    st = t.TimelineStamper(repair_latch=repair, on_reanchor=ev['re'].append, on_settled=ev['se'].append,
                           on_gap=ev['gap'].append,
                           on_conditioned=lambda e: ev['cond'].append(e) if e['clock'] == 'pts' else None)
    return st, ev


def _gap_split(gap_ms, head_ms, late_ms=0, epoch=None, repair=True, jump_s=0, first=G_FIRST):
    """mr-tssplit across one SRT outage: video (PCR on every other PES) + audio 10 ms
    on, one stamper, one stream per output PID, the input conditioned first; 60 s,
    the outage, 20 s. The first PES back is `head_ms` late on the source's timeline
    (the backlog head, drained over 1 s); every later one `late_ms` (a level the
    reconnect really moved). `epoch` restarts the PTS (a reboot), `jump_s` steps
    them with no outage at all, `first` is the first PTS (2^33 wraps it)."""
    st, ev = _gap_events(repair)
    n_pre, g, rows = 1500, gap_ms // 40, []
    for i in range(n_pre + g + 500):
        if n_pre <= i < n_pre + g:
            continue
        v = (first + i * G_VSTEP + (jump_s * 90000 if i >= n_pre else 0)) % t.PTS_WRAP
        if epoch is not None and i >= n_pre:
            v = epoch + (i - n_pre - g) * G_VSTEP
        h = HOUSE + i * STEP_NS + G_TRANSIT
        if i >= n_pre:
            back = (i - n_pre - g) * STEP_NS
            if back < 1_000_000_000:
                h += head_ms * MS - head_ms * MS * back // 1_000_000_000
            h += late_ms * MS
        buf = bytearray(_gpes(G_V, v, 0xE0, pcr=i % 2 == 0) + _gpes(G_A, v + 900, 0xC0))
        st.condition(buf, h)
        rows.append((i - n_pre - g, h, st.stamp(bytes(buf[:188]), h, G_V), st.stamp(bytes(buf[188:]), h, G_A)))
    return st, ev, rows


gst0, gev, grows = _gap_split(6950, 62)
gpost = [r for r in grows if r[0] >= 0]
check("gap carry: a 6.95 s SRT reconnect (+62 ms backlog head) does not re-anchor the splitter",
      gev['re'] == [] and len(gev['se']) == 1)
check("... it is reported once, on the video PID, +62 ms on the kept anchor",
      [(e['pid'], e['marginNs'], e['anchorNs'], e['count']) for e in gev['gap']]
      == [(G_V, 62 * MS, HOUSE + G_TRANSIT, 1)] and gst0.anchor == HOUSE + G_TRANSIT)
check("... the backlog head leaves on its mapped time (late, not fast-forwarded), then every "
      "stamp is its arrival on the pre-gap mapping", gpost[0][2] == gpost[0][1] - 62 * MS
      and all(r[2] == r[1] for r in gpost if r[0] >= 25))
check("... audio stays the source's 10 ms on the video throughout, and nothing is conditioned",
      all(r[3] - r[2] == 10 * MS for r in grows) and gev['cond'] == [])
_, gev, _ = _gap_split(17300, 146)
check("gap carry: a 17.3 s outage (+146 ms head) is carried too", gev['re'] == [] and len(gev['gap']) == 1)
# .21's PTS (house + 1 h) wraps 2^33 every 26.5 h: the gap is judged on the unwrapped PES.
_, gev, grows = _gap_split(6950, 62, first=t.PTS_WRAP - 1580 * G_VSTEP)
check("gap carry: an outage across the 2^33 PTS wrap is carried the same way (+62 ms, stamps on the kept mapping)",
      gev['re'] == [] and [e['marginNs'] for e in gev['gap']] == [62 * MS]
      and all(r[2] == r[1] for r in grows if r[0] >= 25))
for head, carried in ((330, True), (800, True), (1100, False)):
    _, gev, _ = _gap_split(6950, head)
    check(f"gap carry: a +{head} ms first PES is " + ("carried" if carried else "a re-latch (past _GAP_LATE_NS)"),
          (gev['re'], len(gev['gap'])) == ([], 1) if carried
          else (len(gev['re']), gev['gap'], len(gev['se'])) == (1, [], 2))
for lvl, carried in ((-200, True), (-280, True), (-350, False)):
    _, gev, _ = _gap_split(6950, 0, late_ms=lvl)
    check(f"gap carry: a mapping {-lvl} ms EARLY after the gap is "
          + ("carried" if carried else "re-anchored (past _GAP_EARLY_NS)"),
          (gev['re'], len(gev['gap'])) == ([], 1) if carried else (len(gev['re']), gev['gap']) == (1, []))
for what, kw in (("an 11 min outage (past _GAP_MAX_TICKS)", dict(gap_ms=660_000, head_ms=50)),
                 ("a reboot's new epoch (PTS = uptime + 1 h)", dict(gap_ms=60_000, head_ms=50, epoch=3630 * 90000)),
                 ("repair off (the HLS fan-out)", dict(gap_ms=6950, head_ms=62, repair=False))):
    _, gev, _ = _gap_split(**kw)
    check(f"gap carry: {what} re-anchors as before, no gap event", len(gev['re']) == 1 and gev['gap'] == [])
_, gev, _ = _gap_split(0, 0, jump_s=6)
check("gap carry: a +6 s PTS step with NO outage is a clock step for the conditioner, never a gap",
      gev['gap'] == [] and gev['re'] == [] and len(gev['cond']) >= 1)
_, gev, grows = _gap_split(6950, 0, late_ms=180)
gres = next(r[1] for r in grows if r[0] >= 0)
check("gap carry: a kept anchor that turns out 180 ms late is the late tier's: one re-anchor, 10 s of delivery on",
      [e['marginNs'] for e in gev['gap']] == [180 * MS] and len(gev['re']) == 1
      and gev['re'][0]['deltaTicks'] < 0 and abs(gev['re'][0]['anchorNs'] - gres - 10_000_000_000) <= STEP_NS)

# The drift servo's state crosses a carried gap: 30 min of a source 20 ppm fast (the
# servo engaged), then a 60 s outage. The locked rate slews the anchor through it, and
# the gap is judged on the anchor AS SLEWED — the margin reported is the one the PES
# is stamped with, not the rate x 60 s off it.
gst0, gev = _gap_events()
for i in range(9900):
    if 9000 <= i < 9300:
        continue
    gh = HOUSE + i * 200 * MS + G_TRANSIT
    if i == 9300:
        gd0 = gst0.drift_stats()
    gs = gst0.stamp(pes_ts_packet(G_V, pts=G_FIRST + i * 200 * MS * 1_000_000 // 999_980 * 9 // 100000), gh)
    if i == 9300:
        g_margin, g_slewed = gh - gs, gst0.drift_stats()['slewNs'] - gd0['slewNs']
check("gap carry: drift — the servo had locked a rate before the gap", gd0['samples'] == 10 and gd0['ppb'] != 0)
check("... the 60 s gap is carried: no re-anchor, the trend window kept",
      gev['re'] == [] and len(gev['gap']) == 1 and gst0.drift_stats()['samples'] == 10)
check("... the locked rate ran on through it (rate x 60.2 s, to the microsecond)",
      abs(g_slewed - gd0['ppb'] * 301 * 200 * MS // 1_000_000_000) <= 1000)
check("... and the gap's margin is the one its PES was stamped with", [e['marginNs'] for e in gev['gap']] == [g_margin])


# THE HALL TRANSCODER'S EGRESS: one 302M PID carrying the PCR on every other PES. Its
# aacparse holds the last frame before an input gap and releases it WITH the first frame
# after it (GStreamer 1.28.2: 240 of 241 frames leave before the gap), so the gap arrives
# as a PTS jump with no arrival change: "absorbed a +6.95s PTS step" (.24, 13:42:48),
# every stamp after it the gap late until the staleness net re-anchored 1 s later. The
# first frame back lands `head_ms` late on the source's timeline (drained over 1 s).
def _gap_hall(gap_ms, held=True, head_ms=0):
    st, ev = _gap_events()
    n_pre, g, rows = 2813, gap_ms * 90 // G_ASTEP, []
    resume = HOUSE + t.pts90k_to_ns((n_pre + g) * G_ASTEP) + G_TRANSIT + head_ms * MS
    for i in range(n_pre + g + 938):
        if n_pre <= i < n_pre + g:
            continue
        v = G_FIRST + i * G_ASTEP
        h = HOUSE + t.pts90k_to_ns(i * G_ASTEP) + G_TRANSIT
        back = t.pts90k_to_ns((i - n_pre - g) * G_ASTEP)
        if 0 <= back < 1_000_000_000:
            h += head_ms * MS - head_ms * MS * back // 1_000_000_000
        if held and i == n_pre - 1:
            h = resume - MS
        buf = bytearray(_gpes(G_H, v, 0xBD, pcr=i % 2 == 0))
        st.condition(buf, h)
        rows.append((i - n_pre - g, h, st.stamp(bytes(buf), h), v, bytes(buf)))
    return ev, rows


for gap in (700, 3000, 6950, 16200):
    gev, grows = _gap_hall(gap)
    gpost = [r for r in grows if r[0] >= 0]
    check(f"Hall egress, {gap} ms gap behind a held frame: not a clock step, not a re-anchor"
          + (", one gap carried" if gap > 5000 else ""),
          gev['cond'] == [] and gev['re'] == [] and len(gev['gap']) == (1 if gap > 5000 else 0))
    check(f"... ({gap} ms) the wire PTS are the source's and every post-gap stamp is its arrival "
          "on the pre-gap mapping (Headphone1 does not move)",
          all(p.read_pes_pts(r[4]) == r[3] for r in grows) and all(r[2] == r[1] for r in gpost))
    if gap > 1000:
        # A PCR from the held frame on trails its OWN PES by the lead (+ one frame),
        # never the pre-gap floor by the gap (#806's PCR-after-gap rule, on the DUE time).
        leads = [t.TimelineStamper._fold(p.read_pes_pts(r[4]) - p.read_pcr(r[4]) // 300, t.PTS_WRAP)
                 for r in grows if r[0] >= -1 and p.read_pcr(r[4]) is not None]
        check(f"... ({gap} ms) every PCR past the gap trails its own PES by the lead",
              leads != [] and all(22500 <= x <= 22500 + G_ASTEP for x in leads))
_, grows = _gap_hall(6950, held=False)
check("Hall egress, the same gap with no held frame: carried the same way",
      all(r[2] == r[1] for r in grows if r[0] >= 0))

# The late tier's hold counts DELIVERED time across a gap (.24 Hall egress, 14:15:04 and
# 14:17:51: "re-anchored (-0.11s / -0.10s jump)" past 16-17 s gaps, then "pulled back
# 16197.6 / 17301.8 ms"). The level sits at +105 ms (> _LATE_NS) for the last 2 s before
# the gap, a +60 ms head on it for 1 s after, then +90 ms: 3 s of late DELIVERY, never 10.
for gap in (12000, 16200):
    for held in (True, False):
        st, gev = _gap_events()
        n_pre, g, sched = 375, gap * 90 // G_ASTEP, []
        for i in range(n_pre + g + 1406):
            if n_pre <= i < n_pre + g:
                continue
            back = t.pts90k_to_ns((i - n_pre - g) * G_ASTEP)
            if i < n_pre:
                lvl = 0 if i < 140 else 90 * MS if i < 281 else 105 * MS
            else:
                lvl = 105 * MS + max(0, 60 * MS - 60 * MS * back // 1_000_000_000) if back < 1_000_000_000 else 90 * MS
            sched.append((HOUSE + t.pts90k_to_ns(i * G_ASTEP) + 30 * MS + lvl, i))
        if held:
            first = next(a for a, i in sched if i >= n_pre + g)
            sched = sorted(((first - 1) if i == n_pre - 1 else a, i) for a, i in sched)
        for h, i in sched:
            buf = bytearray(_gpes(G_H, G_FIRST + i * G_ASTEP, 0xBD, pcr=True))
            st.condition(buf, h)
            st.stamp(bytes(buf), h)
        check(f"late hold across a {gap} ms gap ({'held frame' if held else 'no held frame'}): "
              "no re-anchor, the gap carried", gev['re'] == [] and gev['cond'] == [] and len(gev['gap']) == 1)

# ... the LONGEST pause in the hold, once per hold: a 1.5 s stall in the 4 s of late
# delivery before a 16.2 s gap must not use the hold's allowance up, and the same
# again 30 s later is a new hold with its own.
st, gev = _gap_events()
g = 16200 * 90 // G_ASTEP
starts, sched = (375, 375 + g + 1406 + 375), []
for i in range(starts[1] + g + 1406):
    if any(s <= i < s + g for s in starts):
        continue
    lvl, at = 0 if i < 140 else 90 * MS, i
    for s in starts:
        back = t.pts90k_to_ns((i - s - g) * G_ASTEP)
        if s - 188 <= i < s:
            lvl = 105 * MS
            if s - 140 <= i < s - 70:
                at = s - 70                    # the stall: delivered with frame s - 70
        elif 0 <= back < 1_000_000_000:
            lvl = 105 * MS + 60 * MS - 60 * MS * back // 1_000_000_000
    sched.append((HOUSE + t.pts90k_to_ns(at * G_ASTEP) + 30 * MS + lvl, i))
for h, i in sorted(sched):
    buf = bytearray(_gpes(G_H, G_FIRST + i * G_ASTEP, 0xBD, pcr=True))
    st.condition(buf, h)
    st.stamp(bytes(buf), h)
check("late hold, its longest pause once per hold: a 1.5 s stall in the hold before each of two 16200 ms gaps "
      "30 s apart: no re-anchor, both gaps carried", gev['re'] == [] and gev['cond'] == [] and len(gev['gap']) == 2)

# The due-time rule is BOUNDED (_COND_GAP_NS of media past the last on-time PES): after a
# stall that delivery never recovers from, a genuine +-1.1 s pacer reset 5 s later is
# still a clock step. Unbounded, the virtual cadence ran on and 5 of 6 were missed.
for stall in (0, 900, 3000):
    for step in (99000, -99000):
        st, gev = _gap_events()
        for i in range(1875):
            pts = G_FIRST + i * G_ASTEP + (step if i >= 703 else 0)
            h = HOUSE + t.pts90k_to_ns(i * G_ASTEP) + (stall * MS if i >= 469 else 0)
            buf = bytearray(_gpes(0x44, pts, 0xC0, pcr=True))
            st.condition(buf, h)
            st.stamp(bytes(buf), h)
        check(f"a {step / 90000:+.1f} s pacer reset "
              + (f"5 s after a {stall} ms stall that never recovers" if stall else "with continuous delivery")
              + " is still absorbed", [e['stepTicks'] for e in gev['cond']] == [step])


# ... pinned at 1 s from both sides, and FORWARD jumps only: one audio PID, delivery
# `late_ms` late from 10 s on for good, its PTS stepping by `step` `k` frames in.
# `bframes` reorders a video PID's PTS (+160/-80/+40 ms deltas), whose negative delta
# must never be held: it would walk the due time back and stretch the chain.
def _chain(late_ms, step, k, bframes=False):
    st, ev = _gap_events()
    for i in range(1875):
        n = (i + 2 if i % 3 == 0 else i - 1) if bframes else i
        pts = G_FIRST + n * (G_VSTEP if bframes else G_ASTEP) + (step if i >= 469 + k else 0)
        h = HOUSE + (i * STEP_NS if bframes else t.pts90k_to_ns(i * G_ASTEP)) + (late_ms * MS if i >= 469 else 0)
        buf = bytearray(_gpes(0x44, pts, 0xE0 if bframes else 0xC0, pcr=True))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return [e['stepTicks'] for e in ev['cond']]


check("a +0.6 s step 0.7 s into a 600 ms stall that persists is the held chain's time that passed, "
      "not a step (the due chain runs 1 s)", _chain(600, 54000, 33) == [])
check("... 1.3 s into it, it is absorbed (the due chain ends 1 s past the last on-time PES)",
      _chain(600, 54000, 61) == [54000])
check("a -1.1 s step 0.5 s into a 1.2 s stall that persists is absorbed: the due time never vetoes a backward jump",
      _chain(1200, -99000, 23) == [-99000])
check("a video PID with B-frames, a +0.6 s step 0.5 s into a 600 ms stall that persists: absorbed "
      "(a negative delta is never held)", _chain(600, 54000, 13, bframes=True) == [54000])

# On a PROGRAM every PID decides on arrival, as on #806: the due-time veto is one-PID
# only. Applied per PID (earlier drafts), a program step landing in a stall reached the
# PIDs differently: the reference missed it, or the second PID booked it as its OWN step
# and released it 30 s later (_COND_OWN_HOLD_NS), splitting A/V by the whole step.
# Video (the reference, PCR on every PES) and audio (two 20 ms PES per frame, 900 ticks
# on), one PES per buffer; from 20 s delivery runs `stall_ms` late, catching up at
# `catch_up` of media time, and `step_at_ms` in every PID steps; 60 s.
def _stall_step(stall_ms, step, step_at_ms=120, catch_up=(1, 3)):
    st, ev = _gap_events()
    at, recs = 20_000 * MS, []
    for i in range(1500):
        for pid, k in ((G_V, 0), (G_A, 0), (G_A, 1)):
            m = i * STEP_NS + k * 20 * MS
            src = G_FIRST + i * G_VSTEP + (900 + k * 1800 if pid == G_A else 0)
            lat = max(0, stall_ms * MS - (m - at) * catch_up[0] // catch_up[1]) if m >= at else 0
            recs.append((HOUSE + m + (50 if pid == G_V else 52) * MS + lat, pid,
                         src + (step if m >= at + step_at_ms * MS else 0), src, m))
    off = {G_V: set(), G_A: set()}
    for h, pid, pts, src, m in sorted(recs):
        buf = bytearray(_gpes(pid, pts, 0xE0 if pid == G_V else 0xC0, pcr=pid == G_V))
        st.condition(buf, h)
        st.stamp(bytes(buf), h, pid)
        off[pid].add(t.TimelineStamper._fold(p.read_pes_pts(bytes(buf)) - src, t.PTS_WRAP))
    return ev, off


for stall, step_at, catch_up in ((400, 120, (1, 3)), (700, 120, (1, 3)), (1000, 40, (9, 10))):
    for step in (99000, -99000):
        gev, goff = _stall_step(stall, step, step_at, catch_up)
        tag = f"{step / 90000:+.1f} s program step {step_at} ms into a {stall} ms stall"
        check(f"{tag}: the reference absorbs it and the second PID adopts it, one event each, no re-anchor",
              [(e['pid'], e['stepTicks']) for e in gev['cond']] == [(G_V, step), (G_A, step)] and gev['re'] == [])
        check(f"... ({tag}) A/V holds at every PES: both PIDs' written PTS stay on the pre-step "
              "timeline, nothing booked as the audio's own to release", goff == {G_V: {0}, G_A: {0}})

# The repo's vMix pacer reset (ts_timeline_test.py) on its muxed egress, with a 1.5 s
# delivery stall (draining at 2x) from frame 149, where the video's 1.19 s step back
# lands in it, or 248, where the leap forward does: an earlier draft's per-PID veto
# made the video miss its step back and left A/V 1.19 s off for good.
VX, AX, A_BACK, V_BACK = 0x100, 0x140, 127800, 107100
for at in (149, 248):
    st, gev = _gap_events()
    rel = []
    for i in range(1500):
        h = HOUSE + i * STEP_NS + (max(0, 1500 * MS - (i - at) * 20 * MS) if i >= at else 0)
        v = FIRST + i * 3600 - (V_BACK if 150 <= i < 250 else 0)
        a = FIRST + 900 + i * 3600 - (A_BACK if 100 <= i < 249 else 0)
        buf = bytearray(p.build_pcr_packet(VX, (FIRST - 9000 + i * 3600 + (V_BACK if i >= 250 else 0)) * 300)
                        + pes_ts_packet(VX, pts=v)
                        + pes_ts_packet(AX, pts=a, dts=a + A_BACK if 100 <= i < 249 else None, stream_id=0xC0))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
        rel.append(t.TimelineStamper._fold(p.read_pes_pts(bytes(buf[376:])) - p.read_pes_pts(bytes(buf[188:376])),
                                           t.PTS_WRAP))
    check(f"vMix pacer reset under a 1.5 s delivery stall from frame {at} (draining at 2x): A/V after the "
          "reset is the source's", all(x == 900 for x in rel[260:]))

# On a one-PID egress a content gap behind a late burst is a gap, never a step, whether
# delivery is on time again after it (#806 read the burst's lateness as the step; a
# program still does) or stays late through it (the due time read alone did): three
# frames 450 ms late, then 400 ms of frames never produced, then 10 more on time or late.
for late_after in (False, True):
    st, gev = _gap_events()
    k, g = 1500, 10
    for i in range(k + 200):
        if k + 3 <= i < k + 3 + g:
            continue
        h = HOUSE + i * STEP_NS + G_TRANSIT
        if k <= i < k + 3 or (late_after and k + 3 + g <= i < k + 13 + g):
            h += 450 * MS
        buf = bytearray(_gpes(G_V, G_FIRST + i * G_VSTEP, 0xE0, pcr=True))
        st.condition(buf, h)
        st.stamp(bytes(buf), h)
    check("a 400 ms content gap behind a 450 ms late burst, delivery "
          + ("staying late through it" if late_after else "on time after it") + ": no clock step, no re-anchor",
          gev['cond'] == [] and gev['re'] == [])

# The held frame's successor is judged from the held frame's due time on BOTH counts —
# the jump against the time that passed, and the delivery-gap bound — so a backlog head
# past the step threshold (+450 ms; the carry keeps heads up to +1 s) does not turn a
# gap of 700 ms or more back into a clock step. (A gap of 320-600 ms with a head of
# 300-600 ms, together under 1 s, still reads as one: ADR-0005 Stage 3f.)
for gap in (700, 6950):
    gev, grows = _gap_hall(gap, head_ms=450)
    check(f"Hall egress, {gap} ms gap behind a held frame, a +450 ms backlog head: still not a clock step, "
          "not a re-anchor" + (", one gap carried" if gap > 5000 else ""),
          gev['cond'] == [] and gev['re'] == [] and len(gev['gap']) == (1 if gap > 5000 else 0)
          and all(r[2] == r[1] for r in grows if r[0] >= 47))

# A hold takes out ONE delivery pause: a link that delivers in bursts more than 1 s apart
# and stays late is late. From 60 s, bursts every 1.5 s, the newest frame of each 300 ms
# late: with every pause taken out the hold never matured (no re-anchor in 60 s); in
# house time it matures 10 s after the first late burst, as it still does with the
# repair off (the HLS fan-out, which does not condition either) or bursts under 1 s apart.
def _bursts(repair, period_ms=1500):
    st, ev = _gap_events(repair)
    for i in range(3000):
        m = i * STEP_NS
        h = HOUSE + m + 50 * MS
        if m >= 60_000 * MS:
            h = HOUSE + 60_000 * MS + ((m - 60_000 * MS) // (period_ms * MS) + 1) * period_ms * MS + 350 * MS
        buf = bytearray(_gpes(G_V, G_FIRST + i * G_VSTEP, 0xE0, pcr=True))
        if repair:
            st.condition(buf, h)
        st.stamp(bytes(buf), h)
    return ev


gev = _bursts(True)
check("bursts 1.5 s apart, the newest frame 300 ms late: the late tier still re-anchors, once, "
      "one burst later than in house time",
      gev['cond'] == [] and [e['anchorNs'] - HOUSE for e in gev['re']] == [73_850 * MS])
check("... with the repair off (HLS) the hold counts house time, as before: once, at the first burst past 10 s",
      [e['anchorNs'] - HOUSE for e in _bursts(False)['re']] == [72_350 * MS])
check("... bursts 0.75 s apart pause under 1 s: the hold counts house time, once, at the first burst past 10 s",
      [e['anchorNs'] - HOUSE for e in _bursts(True, 750)['re']] == [71_600 * MS])
print("all gap-carry checks passed")
