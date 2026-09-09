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


# --- TimelineStamper (the contract's producer side) -------------------------
# Same cases as the C++ port (native/mrts/tests/ts_timeline_test.cpp) and the
# runner's gst_bus_stamper_test.py: one contract, three implementations.
STEP, STEP_NS = 3600, 40_000_000       # 40 ms
FIRST, HOUSE = 8_100_000, 1_000_000_000_000

anchors = []
st = t.TimelineStamper(on_anchor=anchors.append)
jitter = [0, 7_000_000, 1_000_000, 13_000_000, 2_000_000, 9_000_000]
seen = [st.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), HOUSE + i * STEP_NS + j)
        for i, j in enumerate(jitter)]
check("one anchor per egress, naming the first PES",
      len(anchors) == 1 and anchors[0]['refPts90k'] == FIRST
      and anchors[0]['anchorNs'] == HOUSE)
check("the stamp is anchor + PES delta, exactly",
      seen == [HOUSE + i * STEP_NS for i in range(6)])
check("a PES-less buffer repeats the previous stamp (never timestampless)",
      st.stamp(p.null_packet(), HOUSE + 99 * STEP_NS) == seen[-1])
check("the stamp reads the buffer's FIRST PES, not the last",
      st.stamp(pes_ts_packet(0x100, pts=FIRST + 6 * STEP)
               + pes_ts_packet(0x101, pts=FIRST + 50 * STEP), HOUSE)
      == HOUSE + 6 * STEP_NS)

# A legal 2^33 wrap is continuous; a shed run reads as its own PES delta.
wrapst = t.TimelineStamper()
wrapped = [wrapst.stamp(pes_ts_packet(0x100, pts=(W - 3 * STEP + i * STEP) % W), HOUSE + i)
           for i in range(24)]
check("every step across the 2^33 wrap is the plain 40 ms",
      {wrapped[i + 1] - wrapped[i] for i in range(23)} == {STEP_NS})
check("the wrap does not re-anchor", wrapst.reanchors == 0)
gapst = t.TimelineStamper()
gap_a = gapst.stamp(pes_ts_packet(0x100, pts=FIRST), HOUSE)
gap_b = gapst.stamp(pes_ts_packet(0x100, pts=FIRST + 6 * STEP), HOUSE + STEP_NS)
check("a shed run shows up as its own PES delta, not one step",
      gap_b - gap_a == 6 * STEP_NS and gapst.reanchors == 0)

# A real discontinuity re-anchors in place AND drops the monotone floor with
# the anchor — otherwise a late-detected forward jump freezes the timeline.
# The watch returns on the FIRST anomalous PES of a buffer, so 0x100 both
# reports and (a buffer later, from the epoch it proposed) confirms the jump.
reanchors = []
jumpst = t.TimelineStamper(on_reanchor=reanchors.append)
JUMP = 90000 * 600                     # +10 min
jseen = []
for i in range(40):
    pts = FIRST + i * STEP + (JUMP if i >= 20 else 0)
    jseen.append(jumpst.stamp(
        pes_ts_packet(0x100, pts=pts) + pes_ts_packet(0x101, pts=pts + 90),
        HOUSE + i * STEP_NS))
check("the discontinuity produced exactly one re-anchor", len(reanchors) == 1)
check("the re-anchor names the confirming PID and the jump",
      reanchors[0]['pid'] == 0x100 and reanchors[0]['deltaTicks'] == JUMP + 2 * STEP)
check("only a bounded run of buffers carries the jumped stamp",
      sum(1 for i in range(1, 40) if jseen[i] - jseen[i - 1] > 60_000_000_000) <= 2)
check("the timeline recovers instead of freezing at the jumped value",
      jseen[-1] > jseen[26] and jseen[-1] < HOUSE + 100 * STEP_NS)
check("and it steps at the source's real 40 ms rate again",
      {jseen[i + 1] - jseen[i] for i in range(27, 39)} == {STEP_NS})

# ONE anchor + epoch across streams (mr-tssplit's per-PID outputs): a branch
# whose first buffer arrives 300 ms later must NOT anchor on its own arrival.
mult = t.TimelineStamper()
VIDEO, AUDIO = FIRST, FIRST + 1234
v0 = mult.stamp(pes_ts_packet(0x100, pts=VIDEO), HOUSE, 0x100)
a0 = mult.stamp(pes_ts_packet(0x101, pts=AUDIO), HOUSE + 300_000_000, 0x101)
check("a later branch inherits the shared anchor, not its own arrival",
      a0 - v0 == t.pts90k_to_ns(AUDIO - VIDEO))
v1 = mult.stamp(pes_ts_packet(0x100, pts=VIDEO + STEP), HOUSE + 5, 0x100)
a1 = mult.stamp(pes_ts_packet(0x101, pts=AUDIO + STEP), HOUSE + 400_000_000, 0x101)
check("and the A/V offset stays exactly the source's",
      a1 - v1 == t.pts90k_to_ns(AUDIO - VIDEO))
check("each stream keeps its own staircase floor",
      mult.stamp(p.null_packet(), HOUSE, 0x101) == a1 and a1 > v1)


# --- the VOD loop (2026-08-13 field failure) --------------------------------
# A looping VOD source rewinds its PES timeline to ~0 every pass. mr-tssplit
# stamps each of its per-PID SPTS outputs as its OWN single-PID buffer, so the
# cross-PID confirmation rule — a second PID reporting the same jump a buffer
# later — has nothing to confirm with. Before the same-PID path existed, the
# watch counted exactly one anomaly per output, never re-anchored, and the
# monotone floor pinned every later stamp to the last pre-loop value for the
# rest of the loop (measured on .202: every buffer on the video edge frozen at
# one identical PTS 11.6 minutes behind CLOCK_MONOTONIC, sync=true sink at
# max-lateness 1 s dropping the lot).
LOOP_AT, LOOP0 = 20, 4500                # rewind to 50 ms at buffer 20
N = 40


def vod_pts(i, base=FIRST):
    """PES PTS of buffer `i` on a source that loops back to ~0 at LOOP_AT."""
    return base + i * STEP if i < LOOP_AT else LOOP0 + (i - LOOP_AT) * STEP


loops = []
loopst = t.TimelineStamper(on_reanchor=loops.append)
lseen = [loopst.stamp(pes_ts_packet(0x100, pts=vod_pts(i)), HOUSE + i * STEP_NS)
         for i in range(N)]
check("a SINGLE-PID stream re-anchors at the loop (the field bug)",
      len(loops) == 1 and loops[0]['pid'] == 0x100)
recovered = next(i for i in range(LOOP_AT, N) if lseen[i] == HOUSE + i * STEP_NS)
check("and it fires within _CONFIRM buffers of the rewind",
      recovered - LOOP_AT <= t.TimelineStamper._CONFIRM)
check("the stamps track house time again — no frozen clamp",
      all(lseen[i] == HOUSE + i * STEP_NS for i in range(LOOP_AT + 2, N)))
check("nothing lags house time by more than the detection latency",
      max((HOUSE + i * STEP_NS) - lseen[i] for i in range(N)) <= 2 * STEP_NS)
check("the floor dropped with the anchor: a clean 40 ms ladder after the loop",
      {lseen[i + 1] - lseen[i] for i in range(LOOP_AT + 1, N - 1)} == {STEP_NS})

# The cross-PID rule is NOT replaced by the same-PID one — a muxed egress whose
# jump lands on a different PID each buffer still confirms on the second.
xpid = []
xst = t.TimelineStamper(on_reanchor=xpid.append)
for i in range(LOOP_AT):
    xst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP)
              + pes_ts_packet(0x101, pts=FIRST + i * STEP + 90), HOUSE + i * STEP_NS)
xst.stamp(pes_ts_packet(0x100, pts=LOOP0), HOUSE + LOOP_AT * STEP_NS)
xst.stamp(pes_ts_packet(0x101, pts=LOOP0 + 90), HOUSE + (LOOP_AT + 1) * STEP_NS)
check("a second PID still confirms what the first reported (muxed egress)",
      len(xpid) == 1 and xpid[0]['pid'] == 0x101)

# A/V outputs of ONE splitter share the anchor, so they re-anchor TOGETHER and
# lipsync survives the loop — the whole reason a stamper serves a whole egress.
av = []
avst = t.TimelineStamper(on_reanchor=av.append)
SKEW = 1234                              # the source's own A/V offset
pairs = []
for i in range(N):
    pv = vod_pts(i)
    v = avst.stamp(pes_ts_packet(0x100, pts=pv), HOUSE + i * STEP_NS, 0x100)
    a = avst.stamp(pes_ts_packet(0x101, pts=pv + SKEW),
                   HOUSE + i * STEP_NS + 5_000_000, 0x101)
    pairs.append((v, a))
check("the A/V pair re-anchors together, once", len(av) == 1)
SKEW_NS = t.pts90k_to_ns(SKEW)
check("and lipsync is the source's on both sides of the loop",
      {a - v for v, a in pairs[:LOOP_AT]} == {SKEW_NS}
      # After the loop the timeline's zero is the AUDIO PES that confirmed the
      # re-anchor, so the video's delta off it is negative and floor division
      # (python `//`, matched tick for tick by the C++ pts90k_to_ns) rounds it
      # one ns down. One nanosecond, not one sample.
      and all(abs((a - v) - SKEW_NS) <= 1 for v, a in pairs[LOOP_AT + 2:]))

# Debounce intact: ONE bad PES PTS is not a discontinuity. The pre-jump
# reference is retained across the anomaly precisely so the stream can come
# back to it and prove the outlier was an outlier.
glitch = []
gst = t.TimelineStamper(on_reanchor=glitch.append)
gseen = [gst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP - (90000 * 30 if i == 10 else 0)),
                   HOUSE + i * STEP_NS) for i in range(24)]
check("a single corrupt PTS does NOT re-anchor", len(glitch) == 0)
check("and it costs one repeated stamp, not a timeline",
      gseen[10] == gseen[9] and gseen[11] == HOUSE + 11 * STEP_NS)

# Nor does a legitimately SPARSE PID riding a healthy mux — a metadata
# carousel whose PES really are further apart than the forward threshold. This
# is what confirming against the PROPOSED EPOCH buys over merely counting a
# PID's anomalies: the carousel is anomalous on EVERY appearance, so a
# same-PID anomaly COUNTER would re-anchor the whole egress on its second one,
# while its 8 s advance never continues from the epoch the previous one
# proposed.
SEC = 90000
sparse = []
spst = t.TimelineStamper(on_reanchor=sparse.append)
for i in range(40):
    buf = pes_ts_packet(0x100, pts=FIRST + i * SEC)
    if i % 8 == 0:
        buf += pes_ts_packet(0x1FF, pts=FIRST + i * SEC + 45000)
    spst.stamp(buf, HOUSE + i * 1_000_000_000)
check("a sparse metadata PID (8 s carousel) never re-anchors", len(sparse) == 0)


# --- the bounded-staleness net (defense in depth) ---------------------------
# The watch is a DETECTOR: it answers the discontinuities it recognises. This
# one it cannot — a source that has fallen behind real time emits a perfectly
# legal 40 ms PES step every buffer while house time runs 400 ms per buffer, so
# there is no anomaly to see and the stamps trail further behind for ever. The
# net catches it on the lag alone.
slow = []
slowst = t.TimelineStamper(on_reanchor=slow.append)
HOUSE_STEP = 10 * STEP_NS                # 400 ms of house per 40 ms of media
sseen = [slowst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), HOUSE + i * HOUSE_STEP)
         for i in range(24)]
check("a watch-invisible lag still forces a re-anchor", len(slow) == 1)
check("the re-anchor reports the LAG that forced it, not a PES jump",
      slow[0]['deltaTicks'] < 0
      and abs(t.pts90k_to_ns(-slow[0]['deltaTicks'])
              - (t.TimelineStamper._STALE_NS + t.TimelineStamper._STALE_HOLD_NS))
      <= 2 * HOUSE_STEP)
worst = max((HOUSE + i * HOUSE_STEP) - sseen[i] for i in range(24))
check("the lag is BOUNDED — bound + hold + one buffer, never unbounded",
      worst <= t.TimelineStamper._STALE_NS + t.TimelineStamper._STALE_HOLD_NS
      + HOUSE_STEP)
check("and the stamps are back on house time after it fires",
      sseen[-1] > sseen[0] and (HOUSE + 23 * HOUSE_STEP) - sseen[-1] < worst)

# Belt and braces: with the watch blinded entirely — standing in for a
# discontinuity shape nobody has thought of yet — the exact field fixture (the
# VOD loop, media and house both running at 1x) still cannot freeze. Without
# the net this run stays clamped for the 11.6 minutes it takes the source to
# reach its pre-loop PTS again; with it the freeze is bound + hold.
blind = []
blindst = t.TimelineStamper(on_reanchor=blind.append)
blindst._scan_watch = lambda pes, house_now: None
BLIND_N = 220
bseen = [blindst.stamp(pes_ts_packet(0x100, pts=vod_pts(i)), HOUSE + i * STEP_NS)
         for i in range(BLIND_N)]
check("a blind watch still cannot produce the frozen-clamp mode", len(blind) == 1)
check("and the frozen run is bounded by the net, not by the source's loop",
      max((HOUSE + i * STEP_NS) - bseen[i] for i in range(BLIND_N))
      <= t.TimelineStamper._STALE_NS + t.TimelineStamper._STALE_HOLD_NS + STEP_NS)
check("after which the stamps track house time again",
      bseen[-1] == HOUSE + (BLIND_N - 1) * STEP_NS)

# A PSI-only first flush on a freshly wired output must not look like a stream
# frozen since the epoch (a zero floor is a ~55-year lag to the net).
fresh = []
frst = t.TimelineStamper(on_reanchor=fresh.append)
frst.stamp(pes_ts_packet(0x100, pts=FIRST), HOUSE, 0x100)
psi_first = frst.stamp(p.null_packet(), HOUSE + STEP_NS, 0x101)
frst.stamp(p.null_packet(), HOUSE + 2 * STEP_NS, 0x101)
check("a stream whose first buffer has no PES stamps house time, not zero",
      psi_first == HOUSE + STEP_NS)
check("and no zero floor trips the net", len(fresh) == 0)

# --- the drift slew (ADR-0005 decision 5's drift term) ----------------------
# The watch answers STEPS and the net answers freezes; neither can answer a
# source whose crystal runs at a different RATE from ours, which every source's
# does — 50 ppm is 180 ms per hour of margin walk, and on a 24/7 route it never
# stops. The slew cancels that TREND.
#
# It cancels the trend and NOTHING ELSE. The first cut of this held the margin
# at a baseline it captured shortly after the anchor, and that shipped a
# regression the same day (2026-08-13, .202): an HLS player builds a ~2 s
# delivery lead over its first minutes, the baseline was captured mid-buildup,
# and the loop then spent its whole authority destroying the lead it read as an
# error — 125 ms of a 2.25 s video lead given away in 17 minutes, at the clamp,
# still falling, with the sink dropping late frames. The fixture below is that
# producer, and it is the reason this loop has no setpoint.
#
# The same numbers run in the C++ port (native/mrts/tests/ts_timeline_test.cpp).
D_STEP, D_STEP_NS = 18000, 200_000_000          # 200 ms of media per buffer
D_RATE = 3600 * 5                               # buffers per simulated hour
BUILD_NS, BUILD_S = 2_000_000_000, 30           # the player's 2 s lead, over 30 s
LUMP, LUMP_STEP_NS = 30, 26_666_666             # 6 s segments, 800 ms of sawtooth


def hls_house(i, ppm, build=BUILD_NS):
    """House arrival time of buffer `i` from an HLS-shaped producer.

    Three things at once, because all three are true of the real one: a
    delivery LEAD that ramps to `build` over 30 s and then holds (the player's
    ahead-buffer), 800 ms of segment LUMPINESS on top of it, and a source clock
    running `ppm` fast under all of it.
    """
    t_ns = i * D_STEP_NS
    lead = min(build, t_ns * build // (BUILD_S * 1_000_000_000))
    return (HOUSE + t_ns - lead - (i % LUMP) * LUMP_STEP_NS
            - (t_ns * ppm) // (1_000_000 + ppm))


def hls_run(ppm, hours, slew=True, build=BUILD_NS, collapse_at=None):
    """Returns (stamper, per-buffer scheduling margin `stamp - house`).

    `collapse_at` drops the producer's lead by 400 ms at that hour — a rebuffer,
    i.e. a LEVEL change that is none of the loop's business.
    """
    st = t.TimelineStamper()
    if not slew:
        st._slew = lambda house_now: None       # the control, below
    margins = []
    for i in range(int(hours * D_RATE)):
        house = hls_house(i, ppm, build)
        if collapse_at is not None and i >= collapse_at * D_RATE:
            house += 400_000_000
        margins.append(st.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP),
                                house) - house)
    return st, margins


def settled(margins, at_hour):
    """The producer's delivery lead around `at_hour` — the TOP of the segment
    sawtooth, which is the level the lumps hang off."""
    i = int(at_hour * D_RATE)
    return max(margins[max(0, i - 300):i + 300])


# A healthy producer with NO drift must come through completely untouched. This
# is the field regression as a one-line assertion: the old loop would have
# dragged all 2.77 s of this back to whatever it sampled at the start.
st, m = hls_run(0, 4)
check("a healthy HLS lead is not touched at all when there is no drift",
      settled(m, 0.03) == settled(m, 4) == 2_773_300_000 // 1_000_000 * 1_000_000 + 3_300_000
      or settled(m, 0.03) == settled(m, 4))
check("...and the servo applied literally nothing to the anchor",
      st.drift_stats()['slewNs'] == 0 and st.drift_stats()['ppm'] == 0)
check("the margin never went anywhere near the lateness limit",
      min(m[600:]) > 1_500_000_000)

# The control: the same producer, 50 ppm off, with the slew disabled. 180 ms of
# margin per hour, for ever — this is what the loop is for, and what the
# assertions below are measured against.
_, walk = hls_run(50, 4, slew=False)
check("WITHOUT the slew a 50 ppm HLS source walks its margin (the control)",
      abs((settled(walk, 4) - settled(walk, 1)) - 3 * 180_000_000) < 40_000_000)

# ...and with it: the TREND is cancelled while the LEAD is left where the
# producer put it. Both directions.
for ppm, name in ((50, 'fast'), (-50, 'slow')):
    st, m = hls_run(ppm, 4)
    lead = settled(m, 4)
    per_hour = settled(m, 4) - settled(m, 3)
    check(f"a {ppm:+d} ppm ({name}) HLS source has its trend cancelled "
          f"({per_hour / 1e6:+.1f} ms in the last hour, against 180)",
          abs(per_hour) <= 20_000_000)
    check(f"and its 2 s delivery lead is still there ({lead / 1e6:.0f} ms, {name})",
          lead > 2_500_000_000)
    check(f"the servo locked onto the source's own offset ({name})",
          abs(st.drift_stats()['ppm'] + ppm) <= 15)
    check(f"and never cost the margin more than the give-back guard ({name})",
          settled(m, 4) > settled(m, 0.5) - t.TimelineStamper._GIVEBACK_NS)

# A LEVEL step is none of the loop's business. A rebuffer that costs the
# producer 400 ms of lead is not a rate error, and a loop that chased it would
# be the field failure again in a different disguise.
st, m = hls_run(0, 4, collapse_at=2)
check("a mid-run rebuffer (a LEVEL step) provokes no correction at all",
      st.drift_stats()['slewNs'] == 0)
check("and the loop stands down rather than chasing it",
      st.drift_stats()['ppm'] == 0)

# Nothing at all happens during the settling period — the transient a producer
# opens with is exactly what the old design measured, and exactly what it must
# not.
st, m = hls_run(50, 0.4)                        # 24 min: settle + most of a window
check("nothing is corrected while the producer is still settling",
      st.drift_stats()['slewNs'] == 0 and st.drift_stats()['samples']
      < t.TimelineStamper._TREND_SLOTS)

# The rate bound, checked between consecutive buffers (which implies it over any
# interval, the steps being cumulative).
st = t.TimelineStamper()
prev_h = prev_s = None
over = 0
for i in range(int(4 * D_RATE)):
    house = hls_house(i, 50)
    st.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP), house)
    if prev_h is not None:
        moved = abs(st.drift_stats()['slewNs'] - prev_s)
        if moved > t.TimelineStamper._SLEW_MAX_PPM * (house - prev_h) // 1_000_000:
            over += 1
    prev_h, prev_s = house, st.drift_stats()['slewNs']
check(f"the correction never exceeds ±{t.TimelineStamper._SLEW_MAX_PPM} ppm of real time",
      over == 0)

# The give-back watchdog: if the margin ever falls further than _GIVEBACK_NS
# below where the servo engaged, the servo stands down whatever it thinks it is
# doing, drops its rate and re-settles. This is the outcome watchdog, and the
# only test of it that means anything is one where the loop CANNOT win: a source
# 400 ppm slow outruns the whole ±200 ppm authority, so the margin keeps falling
# while the servo corrects — and a servo that keeps correcting through that is
# a servo that will keep correcting through the next thing it has wrong.
standdowns = 0
engaged = False
worst_rate = 0
st = t.TimelineStamper()
for i in range(int(2 * D_RATE)):
    st.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP), hls_house(i, -400))
    now_engaged = st.drift_stats()['engageNs'] != 0
    if engaged and not now_engaged:
        standdowns += 1
    engaged = now_engaged
check("a drift past our authority stands the servo down rather than limping on",
      standdowns >= 1)

# The clamp, on the case that actually reaches it: a source 400 ppm FAST grows
# its margin instead of losing it, so the give-back watchdog (which fires first
# for a slow one, above) never sees anything wrong and the servo ramps until
# something stops it. 200 is written out rather than read from the class on
# purpose — a test that quotes the constant it is checking cannot fail when the
# constant moves.
st = t.TimelineStamper()
for i in range(int(2 * D_RATE)):
    st.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP), hls_house(i, 400))
    worst_rate = max(worst_rate, abs(st.drift_stats()['ppm']))
check(f"and the ±200 ppm clamp is what stops it (peaked at {worst_rate})",
      worst_rate == 200)

# A re-anchor restarts the settling period: a fresh anchor means a fresh
# producer transient (the HLS lead rebuilds from zero), and measuring through it
# is the mistake this loop was born from.
st, m = hls_run(50, 1)
check("the servo is engaged before the re-anchor",
      st.drift_stats()['ppm'] != 0 and st.drift_stats()['samples']
      == t.TimelineStamper._TREND_SLOTS)
base_h = hls_house(int(1 * D_RATE), 50)
st.stamp(pes_ts_packet(0x100, pts=LOOP0), base_h)
st.stamp(pes_ts_packet(0x100, pts=LOOP0 + D_STEP), base_h + D_STEP_NS)
check("and the re-anchor resets it — rate, window and settling all fresh",
      st.drift_stats() == {'ppm': 0, 'slewNs': 0, 'marginNs': 0, 'engageNs': 0,
                           'samples': 0, 'window': t.TimelineStamper._TREND_SLOTS})

# PES-less buffers repeat the previous stamp, so their "margin" is that stamp's
# AGE — feeding them to the estimator would read as a source falling behind.
pesless = t.TimelineStamper()
for i in range(int(1.5 * D_RATE)):
    pesless.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP), hls_house(i, 50))
before = dict(pesless.drift_stats())
for k in range(50):
    pesless.stamp(p.null_packet(), hls_house(int(1.5 * D_RATE), 50) + k * 100_000_000)
check("a run of PES-less buffers moves neither the estimate nor the anchor",
      pesless.drift_stats() == before)

# A/V through the slew: both legs stamp off ONE anchor, so a correction moves
# them together and the source's lipsync survives it.
avst = t.TimelineStamper()
av_off = []
for i in range(int(1.5 * D_RATE)):
    house = hls_house(i, 50)
    v = avst.stamp(pes_ts_packet(0x100, pts=FIRST + i * D_STEP), house, 0x100)
    a = avst.stamp(pes_ts_packet(0x101, pts=FIRST + i * D_STEP + SKEW),
                   house + 3_000_000, 0x101)
    av_off.append(a - v)
SKEW_NS = t.pts90k_to_ns(SKEW)
check("A/V hold the source's skew through the whole slew (to within ns)",
      max(abs(o - SKEW_NS) for o in av_off) <= 1000 and avst.drift_stats()['ppm'] != 0)


# --- latch repair (the 2026-09-05 GATE01 field failure) ---------------------
# A live network source (re)connects and flushes what it queued while the
# session was down: the first PES is the HEAD of that backlog, late by all of
# it, and every buffer after it arrives early against an anchor taken off it.
# On .46 a vMix SRT feed came back with ~1.8 s queued, its stamps sat 1.8 s
# later than its sibling feeds' for the same picture, and every mux mixing the
# two shipped that as lipsync. The same numbers run in the C++ port
# (native/mrts/tests/ts_timeline_test.cpp) — pinned literal for literal.
BACKLOG = 45                          # 1.8 s of 40 ms buffers queued at the sender
BURST_NS = 4_000_000                  # ... flushed at one buffer per 4 ms
# What the un-repaired anchor is wrong by: the backlog's media minus the wall
# time its flush took. Every steady-state buffer arrives this much BEFORE the
# stamp a first-PES anchor gives it.
BURST_ERR_NS = BACKLOG * (STEP_NS - BURST_NS)


def burst_house(i):
    """House arrival of buffer `i`: the backlog lands as a burst from HOUSE,
    then the source is on its real cadence from where the flush ended."""
    if i < BACKLOG:
        return HOUSE + i * BURST_NS
    return HOUSE + BACKLOG * BURST_NS + (i - BACKLOG) * STEP_NS


BURST_N = 200                         # 6.2 s of house: the 3 s window closes inside it
settled = []
rep = t.TimelineStamper(on_settled=settled.append, repair_latch=True)
rseen = [rep.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), burst_house(i))
         for i in range(BURST_N)]
check("the window closes once, on the first PES past it, and reports its cost",
      settled == [{'anchorNs': HOUSE - BURST_ERR_NS, 'repairNs': -BURST_ERR_NS,
                   'windowNs': t.TimelineStamper._LATCH_REPAIR_NS}]
      and BURST_ERR_NS == 1_620_000_000)
check("the backlog leaves stamped with its arrival — fast-forwarded, never early",
      rseen[:BACKLOG] == [burst_house(i) for i in range(BACKLOG)])
check("and after it every stamp is ON the source's delivery cadence (margin 0)",
      rseen[BACKLOG + 1:] == [burst_house(i) for i in range(BACKLOG + 1, BURST_N)])
check("monotone by construction: no floor clamp, no backwards step for a consumer",
      all(rseen[i] >= rseen[i - 1] for i in range(1, BURST_N)))
check("the anchor is fixed once the window closes",
      rep.anchor == HOUSE - BURST_ERR_NS and rep._latch_until is None)

# The control: the SAME delivery through a default stamper is the field
# failure — every steady-state stamp 1.62 s in the future of its arrival, for
# the life of the anchor. Repair is opt-in, so nothing that did not ask for it
# (the HLS fan-out, whose burst is a segment and whose lead is by design) moves.
ctl = t.TimelineStamper()
cseen = [ctl.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), burst_house(i))
         for i in range(BURST_N)]
check("a default stamper still anchors on the first PES — repair is opt-in",
      all(cseen[i] - burst_house(i) == BURST_ERR_NS for i in range(BACKLOG, BURST_N))
      and ctl._latch_until is None)

# A source that arrives ON cadence is left exactly where the first PES put it:
# the window only ever answers a stamp later than its arrival.
clean_settled = []
clean = t.TimelineStamper(on_settled=clean_settled.append, repair_latch=True)
kseen = [clean.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), HOUSE + i * STEP_NS + j)
         for i, j in enumerate(jitter * 20)]
check("a source on cadence costs the window nothing (jitter is late, never early)",
      kseen == [HOUSE + i * STEP_NS for i in range(len(kseen))]
      and clean_settled == [{'anchorNs': HOUSE, 'repairNs': 0,
                             'windowNs': t.TimelineStamper._LATCH_REPAIR_NS}])

# A/V of ONE egress through the burst (mr-tssplit's per-PID outputs): the
# window converges on whichever stream delivers earliest, so once it has
# settled both legs hold the source's own skew — the audio PES that sits
# 13.7 ms ahead of the video's for 5 ms more arrival is what sets the anchor.
av_settled = []
avr = t.TimelineStamper(on_settled=av_settled.append, repair_latch=True)
rpairs = []
for i in range(BURST_N):
    house = burst_house(i)
    v = avr.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), house, 0x100)
    a = avr.stamp(pes_ts_packet(0x101, pts=FIRST + i * STEP + SKEW),
                  house + 5_000_000, 0x101)
    rpairs.append((v, a))
check("A/V settle onto ONE repaired anchor and hold the source's skew after it",
      all(a - v == SKEW_NS for v, a in rpairs[BACKLOG + 2:])
      and av_settled[0]['repairNs'] == -(BURST_ERR_NS + SKEW_NS - 5_000_000))

# A re-anchor is a fresh anchor with the same exposure, so it re-opens the
# window; a clean post-jump cadence closes it again at no cost.
re_settled = []
rer = t.TimelineStamper(on_settled=re_settled.append, repair_latch=True)
JUMP_AT = 100
for i in range(2 * JUMP_AT):
    pts = FIRST + i * STEP + (JUMP if i >= JUMP_AT else 0)
    rer.stamp(pes_ts_packet(0x100, pts=pts) + pes_ts_packet(0x101, pts=pts + 90),
              HOUSE + i * STEP_NS)
check("a re-anchor re-opens the window and a clean cadence closes it for free",
      rer.reanchors == 1 and [s['repairNs'] for s in re_settled] == [0, 0])

# A producer disarmed INSIDE the window (last consumer edge gone, module stop)
# still reports what the window had cost so far — the short-lived incarnation
# is exactly the one a burn-in tally must not skip. Closing twice is a no-op.
early_settled = []
early = t.TimelineStamper(on_settled=early_settled.append, repair_latch=True)
for i in range(BACKLOG + 10):                     # well inside the 3 s window
    early.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), burst_house(i))
early.close_latch()
early.close_latch()
check("a disarm inside the window reports the repair so far, once",
      early_settled == [{'anchorNs': HOUSE - BURST_ERR_NS, 'repairNs': -BURST_ERR_NS,
                         'windowNs': t.TimelineStamper._LATCH_REPAIR_NS}]
      and early._latch_until is None)
check("closing a stamper that never opened a window is a no-op",
      (lambda s: (s.close_latch(), True)[1])(t.TimelineStamper()))

# A discontinuity INSIDE an open window: the window is closed and reported
# before the re-anchor opens a fresh one, so the first anchor's cost is in the
# tally and the second starts from zero.
mid_settled = []
mid = t.TimelineStamper(on_settled=mid_settled.append, repair_latch=True)
MID_JUMP_AT = 60                                  # 0.78 s in: window still open
for i in range(MID_JUMP_AT + 100):                # ...and the second one closes too
    pts = FIRST + i * STEP + (JUMP if i >= MID_JUMP_AT else 0)
    mid.stamp(pes_ts_packet(0x100, pts=pts) + pes_ts_packet(0x101, pts=pts + 90),
              burst_house(i))
check("a re-anchor inside the window reports the first anchor's cost, then starts fresh",
      mid.reanchors == 1
      and [s['repairNs'] for s in mid_settled] == [-BURST_ERR_NS, 0]
      and mid_settled[0]['anchorNs'] == HOUSE - BURST_ERR_NS)

# The jumped buffer itself — the one the watch has flagged but not yet
# confirmed — is NOT early delivery: its stamp is the old timeline plus the
# jump, and reading it as a backlog would pull the anchor back by ten minutes.
# The same rule keeps a single corrupt PTS (never confirmed, never re-anchored)
# from moving the anchor for good.
fg_settled = []
fg = t.TimelineStamper(on_settled=fg_settled.append, repair_latch=True)
for i in range(100):
    fg.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP + (90000 * 30 if i == 10 else 0)),
             HOUSE + i * STEP_NS)
check("an unconfirmed forward PTS jump inside the window never moves the anchor",
      fg.reanchors == 0 and fg.anchor == HOUSE
      and [s['repairNs'] for s in fg_settled] == [0])

# The backlog can arrive through the RE-ANCHOR path too (the librist
# reconnect signature seen on .103): a clean cadence, a source discontinuity,
# and the post-jump media flushed as a burst. The fresh anchor is taken off
# the head of that burst exactly as the first one was, and the window repairs
# it the same way. Same numbers in the C++ port.
RE_JUMP_AT = 100                                  # first window long closed
RE_T0 = HOUSE + RE_JUMP_AT * STEP_NS              # arrival of the jump's first PES


def rejump_house(i):
    if i < RE_JUMP_AT:
        return HOUSE + i * STEP_NS
    k = i - RE_JUMP_AT
    if k < BACKLOG:
        return RE_T0 + k * BURST_NS
    return RE_T0 + BACKLOG * BURST_NS + (k - BACKLOG) * STEP_NS


re_settled = []
rej = t.TimelineStamper(on_settled=re_settled.append, repair_latch=True)
rseen2 = []
for i in range(RE_JUMP_AT + 200):
    pts = FIRST + i * STEP + (JUMP if i >= RE_JUMP_AT else 0)
    rseen2.append(rej.stamp(pes_ts_packet(0x100, pts=pts), rejump_house(i)))
# The watch confirms the jump one buffer late (same-PID coherence), so the
# re-anchor lands on buffer RE_JUMP_AT + 1: the backlog the window can see is
# one buffer shorter than the first-PES case.
RE_ERR_NS = (BACKLOG - 1) * (STEP_NS - BURST_NS)
check("a backlog flushed after a discontinuity is repaired off the re-anchor too",
      rej.reanchors == 1
      and [s['repairNs'] for s in re_settled] == [0, -RE_ERR_NS]
      and RE_ERR_NS == 1_584_000_000)
check("and after it every stamp is on the source's delivery cadence again",
      rseen2[RE_JUMP_AT + BACKLOG + 2:] == [rejump_house(i)
                                          for i in range(RE_JUMP_AT + BACKLOG + 2,
                                                         RE_JUMP_AT + 200)])


# --- the late-level tier of the net (the 2026-09-08 .103 freeze) -----------
# A LEVEL step: not a PTS step (the watch sees a legal 40 ms per buffer), not a
# slope (the slew sees none), not 5 s (the net's bound) and not inside the 3 s
# latch window. From buffer 20 every buffer arrives 300 ms after the time its
# stamp says it plays at — a path that got slower after the anchor, or an anchor
# taken off a fast first PES — and every paced consumer whose D is under 300 ms
# is late on every frame until something moves the anchor. The tier does, once
# the level has HELD for the hold, on the buffer that completes the hold.
LATE_LEVEL = 300_000_000
LATE_AT = 20
LATE_HOLD_BUFS = t.TimelineStamper._LATE_HOLD_NS // STEP_NS      # 250
late = []
latest = t.TimelineStamper(on_reanchor=late.append)
def late_house(i):
    return HOUSE + i * STEP_NS + (LATE_LEVEL if i >= LATE_AT else 0)
lseen = [latest.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), late_house(i))
         for i in range(400)]
check("a sustained late level re-anchors exactly once", len(late) == 1)
check("... on the buffer that completes the hold, not before",
      late[0]['anchorNs'] == late_house(LATE_AT + LATE_HOLD_BUFS))
check("... and reports the level it removed (negative: media behind house)",
      abs(t.pts90k_to_ns(-late[0]['deltaTicks']) - LATE_LEVEL) <= STEP_NS)
check("before it the stamps sat the level behind house",
      all(late_house(i) - lseen[i] == LATE_LEVEL for i in range(LATE_AT, LATE_AT + LATE_HOLD_BUFS)))
check("from it every buffer leaves stamped with its arrival",
      all(lseen[i] == late_house(i) for i in range(LATE_AT + LATE_HOLD_BUFS, 400)))

# What must NOT trip it: a level inside the bound, one straggler far outside
# it, and a delivery LEAD of any size (negative margin — the HLS player's
# healthy 2 s, here as the source stepping 2 s ahead, which the watch accepts).
quiet = []
qst = t.TimelineStamper(on_reanchor=quiet.append)
for i in range(400):
    h = HOUSE + i * STEP_NS
    if i >= 20:
        h += 80_000_000                       # an 80 ms level: inside the bound
    if i == 100:
        h += 900_000_000                      # one 900 ms straggler: a transient
    ahead = 2 * 90000 if i >= 200 else 0      # then 2 s of lead
    qst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP + ahead), h)
check("an in-bound level, a straggler and a delivery lead never trip the tier",
      len(quiet) == 0)

# Egress-wide MINIMUM: one late stream never moves the anchor its siblings
# share. A muxer's audio PES arriving 300 ms behind its video for the same
# house time is that leg's encoder latency, not a mapping error; the video leg
# proves the mapping right on every buffer.
mixed = []
mst = t.TimelineStamper(on_reanchor=mixed.append)
for i in range(400):
    h = HOUSE + i * STEP_NS
    mst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), h, 0x100)
    mst.stamp(pes_ts_packet(0x140, pts=FIRST + i * STEP - 27000), h, 0x140)
check("one late stream among on-time siblings never trips the tier", len(mixed) == 0)

# And a sparse PID cannot trip it by its cadence alone: a 1 Hz metadata stream
# is 1 s "late" by the floor's reckoning at every PES, and exactly on time by
# its own mapping — which is what the tier measures.
sparse_late = []
sst = t.TimelineStamper(on_reanchor=sparse_late.append)
for i in range(400):
    h = HOUSE + i * STEP_NS
    sst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP), h, 0x100)
    if i % 25 == 0:
        sst.stamp(pes_ts_packet(0x1F0, pts=FIRST + i * STEP), h, 0x1F0)
check("a 1 Hz metadata PID never trips the tier", len(sparse_late) == 0)

# --- the EARLY side (the #737 rewind, the RIST-reconnect lead) ----------------
# At 8 s — past the 3 s latch-repair window, which would otherwise absorb it
# on the spot — the source steps 1.5 s AHEAD in PTS (the watch accepts up to
# 5 s), so every buffer is stamped 1.5 s before it arrives — for ever, on a
# stamper without this tier. With `repair_latch` (a live-cadence producer) the
# tier re-anchors once the hold completes and reports the lead it removed.
EARLY_LEVEL = 1_500_000_000
EARLY_TICKS = 135000                                            # 1.5 s in 90 kHz
EARLY_AT = 200                                                  # 8 s in
EARLY_N = 700
early = []
est = t.TimelineStamper(on_reanchor=early.append, repair_latch=True)
eseen = [est.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP + (EARLY_TICKS if i >= EARLY_AT else 0)),
                   HOUSE + i * STEP_NS) for i in range(EARLY_N)]
EARLY_HOLD_BUFS = t.TimelineStamper._EARLY_HOLD_NS // STEP_NS      # 250
check("a sustained early lead re-anchors exactly once (live-cadence producer)", len(early) == 1)
check("... on the buffer that completes the hold",
      early[0]['anchorNs'] == HOUSE + (EARLY_AT + EARLY_HOLD_BUFS) * STEP_NS)
check("... and reports the lead it removed (positive: media ahead of house)",
      abs(t.pts90k_to_ns(early[0]['deltaTicks']) - EARLY_LEVEL) <= STEP_NS)
check("before it the stamps ran the lead ahead of house",
      all(eseen[i] - (HOUSE + i * STEP_NS) == EARLY_LEVEL
          for i in range(EARLY_AT, EARLY_AT + EARLY_HOLD_BUFS)))
check("from it every buffer leaves stamped with its arrival",
      all(eseen[i] == HOUSE + i * STEP_NS for i in range(EARLY_AT + EARLY_HOLD_BUFS, EARLY_N)))

# The same lead on a producer that runs ahead by design (repair_latch off —
# the HLS fan-out) is its business and never moves the anchor; nor does a lead
# inside the bound on a live-cadence producer.
lead_off = []
lst = t.TimelineStamper(on_reanchor=lead_off.append)
for i in range(EARLY_N):
    lst.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP + (EARLY_TICKS if i >= EARLY_AT else 0)),
              HOUSE + i * STEP_NS)
check("a delivery lead never moves an opt-out (HLS) producer's anchor", len(lead_off) == 0)
small_lead = []
sl = t.TimelineStamper(on_reanchor=small_lead.append, repair_latch=True)
for i in range(EARLY_N):
    sl.stamp(pes_ts_packet(0x100, pts=FIRST + i * STEP + (45000 if i >= EARLY_AT else 0)),
             HOUSE + i * STEP_NS)
check("a 500 ms lead is inside the early bound and never trips it", len(small_lead) == 0)


# --- the timeline conditioner (the vMix CBR pacer reset, 2026-09-08) ---------
# Captured shape: audio PES steps back 1.42 s (and gains a DTS sitting AFTER
# its PTS), video steps back 1.19 s a second later, then audio and video leap
# forward by the same amounts and the PCR leaps +1.19 s with them. Nothing is
# lost; only the numbers moved. Conditioned, every written clock stays
# continuous, the stamper sees no discontinuity at all, and the net offset is
# zero once the pacer has finished its reset.
def _pcr_pkt(pid, pcr27):
    b = bytearray(188); b[0] = p.SYNC; b[1] = (pid >> 8) & 0x1F; b[2] = pid & 0xFF
    b[3] = 0x20; b[4] = 183; b[5] = 0x10
    base, ext = pcr27 // 300, pcr27 % 300
    b[6] = (base >> 25) & 0xFF; b[7] = (base >> 17) & 0xFF; b[8] = (base >> 9) & 0xFF
    b[9] = (base >> 1) & 0xFF; b[10] = ((base & 1) << 7) | 0x7E | ((ext >> 8) & 1); b[11] = ext & 0xFF
    for i in range(12, 188): b[i] = 0xFF
    return bytes(b)

def _dts_of(pkt):
    off = p.payload_offset(pkt)
    if not pkt[off + 7] & 0x40: return None
    q = pkt[off + 14:off + 19]
    return (((q[0] >> 1) & 7) << 30) | (q[1] << 22) | ((q[2] >> 1) << 15) | (q[3] << 7) | (q[4] >> 1)

V, A = 0x100, 0x140
A_BACK, V_BACK = 127800, 107100          # 1.42 s and 1.19 s in 90 kHz
cond_events = []; re_events = []
cst = t.TimelineStamper(on_reanchor=re_events.append, repair_latch=True,
                        on_conditioned=cond_events.append)
w_v, w_a, w_pcr, w_dts_bad, stamps = [], [], [], 0, []
for i in range(600):
    h = HOUSE + i * STEP_NS
    v_pts = FIRST + i * STEP - (V_BACK if 150 <= i < 250 else 0)
    a_pts = FIRST + 900 + i * STEP - (A_BACK if 100 <= i < 249 else 0)
    a_dts = (a_pts + A_BACK) if 100 <= i < 249 else None      # vMix's marker: DTS after PTS
    pcr = (FIRST - 9000 + i * STEP + (V_BACK if i >= 250 else 0)) * 300
    buf = bytearray(_pcr_pkt(V, pcr) + pes_ts_packet(V, pts=v_pts) + pes_ts_packet(A, pts=a_pts, dts=a_dts))
    cst.condition(buf, h)
    stamps.append(cst.stamp(bytes(buf), h))
    pk = list(p.iter_packets(bytes(buf)))
    w_pcr.append(p.read_pcr(pk[0])); w_v.append(p.read_pes_pts(pk[1])); w_a.append(p.read_pes_pts(pk[2]))
    d = _dts_of(pk[2])
    if d is not None and t.TimelineStamper._fold(d - w_a[-1], t.PTS_WRAP) > 0: w_dts_bad += 1
def _cont(seq, unit): return all(0 < t.TimelineStamper._fold(seq[i + 1] - seq[i], t.PTS_WRAP) * unit <= 100_000_000 for i in range(len(seq) - 1))
check("conditioned: written video PTS is continuous through the pacer reset", _cont(w_v, 100000 // 9))
check("conditioned: written audio PTS is continuous through the pacer reset", _cont(w_a, 100000 // 9))
check("conditioned: written PCR is continuous through the pacer reset (after the flagged switch to regeneration)",
      all(0 < t.TimelineStamper._fold(w_pcr[i + 1] - w_pcr[i], t.PCR_MODULO) <= 27_000_000 for i in range(1, 599)))
check("conditioned: no DTS is left after its own PTS", w_dts_bad == 0)
check("conditioned: the stamper saw no discontinuity — no re-anchor", len(re_events) == 0)
check("conditioned: the stamps themselves never step",
      all(0 <= stamps[i + 1] - stamps[i] <= 100_000_000 for i in range(599)))
pts_kinds = [(e['pid'], round(e['stepTicks'] / 90000, 2)) for e in cond_events if e['clock'] == 'pts']
pcr_kinds = [round(e['stepTicks'] / 90000, 2) for e in cond_events if e['clock'] == 'pcr']
check("conditioned: the four PES steps are each reported once",
      pts_kinds == [(A, -1.42), (V, -1.19), (A, 1.42), (V, 1.19)])
check("conditioned: the regenerated PCR reports its lead over the source's (once) and the source's leap (once)",
      pcr_kinds == [-0.19, -1.19])
check("conditioned: both PES offsets are back to zero once the reset is over",
      {e['pid']: e['offsetTicks'] for e in cond_events if e['clock'] == 'pts'} == {A: 0, V: 0})
check("conditioned: written PTS − PCR sits on the lead throughout",
      all(abs(t.TimelineStamper._fold(w_v[i] - w_pcr[i] // 300, t.PTS_WRAP) / 90000 - 0.25) < 0.05 for i in range(1, 600)))

# The correction is sized by cadence, not arrival: the step lands on a 94 KB
# I-frame that took 350 ms to arrive (the .103 capture). Absorbing "delta minus
# arrival" would over-correct by that 350 ms and leave a residual step; the
# median cadence absorbs exactly the 1.05 s that moved.
big = []
bst = t.TimelineStamper(repair_latch=True, on_conditioned=big.append)
bw = []
for i in range(300):
    h = HOUSE + i * STEP_NS + (350_000_000 if i >= 100 else 0)        # one slow big frame at 100
    pts = FIRST + i * STEP - (94500 if 100 <= i < 200 else 0)          # −1.05 s stretch
    buf = bytearray(pes_ts_packet(V, pts=pts)); bst.condition(buf, h); bw.append(p.read_pes_pts(buf))
check("a step that lands on a big frame is absorbed by exactly the step, not the frame's wire time",
      [round(e['stepTicks'] / 90000, 2) for e in big] == [-1.05, 1.05] and big[-1]['offsetTicks'] == 0)
check("... so the written PTS has no residual step anywhere",
      all(0 < t.TimelineStamper._fold(bw[i + 1] - bw[i], t.PTS_WRAP) <= STEP for i in range(299)))

# PCR regeneration: a source whose PCR sits 12.6 s behind its PTS (the .103
# 11:05 state) is on the lead from the first regenerated packet; a PCR that
# then FREEZES 1.1 s while the PTS runs on (the pacer pausing, .103 11:20) does
# not move the written clock at all — it runs with the pictures. One
# discontinuity indicator, on the first regenerated value, and an event per
# 300 ms the source's clock drifts from ours.
gap_ev = []
gst_ = t.TimelineStamper(repair_latch=True, on_conditioned=gap_ev.append)
gaps = []; di_flags = 0; pcr_val = (FIRST - 12 * 90000 - 54000) * 300; wp = []
for i in range(400):
    frozen = 150 <= i < 177 or 300 <= i < 327
    if not frozen:
        pcr_val += STEP * 300
    buf = bytearray(_pcr_pkt(V, pcr_val) + pes_ts_packet(V, pts=FIRST + i * STEP))
    gst_.condition(buf, HOUSE + i * STEP_NS)
    pk = list(p.iter_packets(bytes(buf)))
    if pk[0][5] & 0x80: di_flags += 1
    wp.append(p.read_pcr(pk[0]))
    gaps.append(t.TimelineStamper._fold(p.read_pes_pts(pk[1]) - p.read_pcr(pk[0]) // 300, t.PTS_WRAP) / 90000)
GAP0 = (12 * 90000 + 54000 - STEP) / 90000                      # 12.56 s at the first PES
check("PCR regeneration: a 12.6 s PCR lag is gone from the first regenerated packet",
      gap_ev and gap_ev[0]['clock'] == 'pcr' and abs(gap_ev[0]['stepTicks'] / 90000 - (GAP0 - 0.25)) < 0.05
      and abs(gaps[1] - 0.25) < 0.05)
check("... the written PTS − PCR holds the lead through the pacer's freezes",
      all(abs(g - 0.25) <= 0.05 for g in gaps[1:]))
check("... the written PCR is continuous and monotone throughout",
      all(0 <= t.TimelineStamper._fold(wp[i + 1] - wp[i], t.PCR_MODULO) <= 27_000_000 // 10 for i in range(1, 399)))
check("... one discontinuity indicator (the first regenerated value), and the freezes are reported",
      di_flags == 1 and len(gap_ev) >= 3)

# Sparse PCR (one cluster every 2.2 s of media, arrival on cadence) is cadence,
# not a discontinuity, and a real 2 s gap in the pictures (PTS and arrival both
# +2 s) is time passing — one indicator in total, the first regenerated value.
# What IS signalled: a jump past the conditioner's bound (a source restart,
# +20 s with arrival one frame), which reaches the wire as written.
sp_ev = []; sp = t.TimelineStamper(repair_latch=True, on_conditioned=sp_ev.append); sp_di = []
for i in range(400):
    pts = FIRST + i * STEP + (2 * 90000 if i >= 300 else 0) + (20 * 90000 if i >= 350 else 0)
    h = HOUSE + i * STEP_NS + (2_000_000_000 if i >= 300 else 0)
    pk = pes_ts_packet(V, pts=pts)
    if i % 55 == 0:
        pk = _pcr_pkt(V, (pts - 27000) * 300) + pk
    buf = bytearray(pk); sp.condition(buf, h)
    if buf[3] & 0x20 and buf[5] & 0x80: sp_di.append(i)
check("sparse PCR clusters and a real picture gap are cadence; only a jump past the bound is signalled",
      sp_di == [55, 385])

# The reference is the PID carrying the PCR, even when another PID's PES came
# first and leads it: audio PES 1.4 s ahead of video, seen first, PCR on video
# (the .103 11:41 freeze — a PCR derived from the audio put every video frame
# 1.2 s late and the sink dropped the lot).
ref_ev = []; rst_ = t.TimelineStamper(repair_latch=True, on_conditioned=ref_ev.append); vg = []
for i in range(200):
    a_pts = FIRST + 126000 + i * STEP; v_pts = FIRST + i * STEP
    buf = bytearray(pes_ts_packet(A, pts=a_pts) + _pcr_pkt(V, (v_pts - 9000) * 300) + pes_ts_packet(V, pts=v_pts))
    rst_.condition(buf, HOUSE + i * STEP_NS); pk = list(p.iter_packets(bytes(buf)))
    vg.append(t.TimelineStamper._fold(p.read_pes_pts(pk[2]) - p.read_pcr(pk[1]) // 300, t.PTS_WRAP) / 90000)
check("the regenerated PCR trails the PCR PID's own PTS, not a leading audio PID's",
      all(abs(g - 0.25) <= 0.05 for g in vg[2:]))

# … and when a stream LAGS the video (audio 400 ms behind), the PCR trails the
# lagging one, so nothing is ever placed before it is delivered; a sparse
# metadata PID seconds behind (a KLV carousel) cannot drag it more than 1 s.
lag_st = t.TimelineStamper(repair_latch=True); vgap = []; agap = []
for i in range(200):
    v_pts = FIRST + i * STEP; a_pts = v_pts - 36000; k_pts = v_pts - 5 * 90000
    pk = _pcr_pkt(V, (v_pts - 9000) * 300) + pes_ts_packet(V, pts=v_pts) + pes_ts_packet(A, pts=a_pts)
    if i % 50 == 0:
        pk += pes_ts_packet(0x1F0, pts=k_pts)
    buf = bytearray(pk); lag_st.condition(buf, HOUSE + i * STEP_NS); pkl = list(p.iter_packets(bytes(buf)))
    pcr = p.read_pcr(pkl[0]) // 300
    vgap.append(t.TimelineStamper._fold(p.read_pes_pts(pkl[1]) - pcr, t.PTS_WRAP) / 90000)
    agap.append(t.TimelineStamper._fold(p.read_pes_pts(pkl[2]) - pcr, t.PTS_WRAP) / 90000)
check("the PCR trails the lagging audio (audio ≥ lead, video = lead + its lag), unmoved by a sparse PID seconds behind",
      all(abs(a - 0.25) <= 0.05 for a in agap[3:]) and all(abs(v - 0.65) <= 0.05 for v in vgap[3:]))

# TIMING PID: vMix with its audio PES 1.7 s AHEAD of its video (the .103 12:03
# freeze), audio first in every buffer. The anchor must land on the video (the
# PCR carrier), and neither the latch repair nor the tiers may let the audio's
# lead pull the anchor: the video stays stamped on its arrival for the whole
# run while the audio rides the same anchor 1.7 s early.
tp_anchor = []; tp_re = []
tp = t.TimelineStamper(on_anchor=tp_anchor.append, on_reanchor=tp_re.append, repair_latch=True)
vm = []; am = []
for i in range(600):
    h = HOUSE + i * STEP_NS
    v_pts = FIRST + i * STEP; a_pts = v_pts + 153000                     # +1.7 s
    vbuf = bytearray(_pcr_pkt(V, (v_pts - 9000) * 300) + pes_ts_packet(V, pts=v_pts))
    abuf = bytearray(pes_ts_packet(A, pts=a_pts))
    tp.condition(abuf, h); am.append(tp.stamp(bytes(abuf), h, A) - h)           # audio arrives first
    tp.condition(vbuf, h); vm.append(tp.stamp(bytes(vbuf), h, V) - h)
check("timing PID: the anchor is re-based onto the PCR carrier (video) once it is known",
      len(tp_re) == 1 and tp_re[0]['pid'] == V and tp_re[0]['deltaTicks'] == 0)
check("timing PID: the video stays stamped on its arrival for the whole run (no repair/tier flip)",
      all(abs(m) <= STEP_NS for m in vm[2:]))
check("timing PID: the audio rides the same anchor, 1.7 s early, untouched",
      all(abs(m - 1_700_000_000) <= STEP_NS for m in am[2:]))

# What it must leave alone: a delivery stall (PTS one frame on, arrival 1.5 s
# late), a genuine 3 s content gap (PTS and arrival move together), B-frame
# reorder (±80 ms), and a source restart (PTS −2 h, past the bound — the
# watch's job).
quiet_c = []
qst = t.TimelineStamper(repair_latch=True, on_conditioned=quiet_c.append)
for i in range(400):
    h = HOUSE + i * STEP_NS + (1_500_000_000 if i >= 100 else 0) + (3_000_000_000 if i >= 200 else 0)
    pts = FIRST + i * STEP + (3 * 90000 if i >= 200 else 0) + ([0, 7200, -3600, 3600][i % 4])
    buf = bytearray(pes_ts_packet(V, pts=pts))
    qst.condition(buf, h)
    if p.read_pes_pts(buf) != pts % t.PTS_WRAP: quiet_c.append(('rewrote', i))
check("a stall, a real gap and reorder jitter are never conditioned (bytes untouched)", quiet_c == [])
restart_c = []; restart_re = []
rst = t.TimelineStamper(on_reanchor=restart_re.append, repair_latch=True, on_conditioned=restart_c.append)
for i in range(400):
    buf = bytearray(pes_ts_packet(V, pts=(FIRST + i * STEP - (2 * 3600 * 90000 if i >= 200 else 0)) % t.PTS_WRAP))
    rst.condition(buf, HOUSE + i * STEP_NS); rst.stamp(bytes(buf), HOUSE + i * STEP_NS)
check("a source restart is past the conditioner's bound and re-anchors as before",
      restart_c == [] and len(restart_re) == 1)


# --- the late tier re-anchors on the PES it stamped FROM (.103, 2026-09-08 13:02-13:15) ---
# An audio PES ahead of the video's in every buffer, written 2 s ahead of it; the
# PCR rides the video, so the video is the timing PID. From buffer 20 every buffer
# arrives 300 ms late (a level). The tier must re-anchor once, referenced on the
# VIDEO's own PES, and leave the video on its arrival — not the written A/V skew
# behind it, which matured the hold again 10 s later, and again: one re-anchor
# every 10 s with the level growing to -3 s, one dropped bus buffer each, live.
SKEW = 2 * 90000
lt_re = []
lt = t.TimelineStamper(on_reanchor=lt_re.append, repair_latch=True)
lvm = []
for i in range(800):
    v = FIRST + i * STEP
    buf = bytearray(pes_ts_packet(A, pts=v + SKEW) + _pcr_pkt(V, (v - 9000) * 300) + pes_ts_packet(V, pts=v))
    lt.condition(buf, late_house(i))
    lvm.append(lt.stamp(bytes(buf), late_house(i)) - late_house(i))
lt_tier = [r for r in lt_re if r['deltaTicks'] != 0]
check("audio ahead of the timing PID in the buffer: the anchor is re-based onto the video first",
      bool(lt_re) and lt_re[0]['pid'] == V and lt_re[0]['deltaTicks'] == 0)
check("... the late level then re-anchors exactly once", len(lt_tier) == 1 and len(lt_re) == 2)
check("... referenced on the timing PID's own PES, not the buffer's first",
      len(lt_re) == 2 and lt_re[-1]['pid'] == V
      and lt_re[-1]['refPts90k'] == FIRST + (LATE_AT + LATE_HOLD_BUFS) * STEP)
check("... and from it the video leaves on its arrival for the rest of the run (no 10 s cycle)",
      all(abs(m) <= STEP_NS for m in lvm[LATE_AT + LATE_HOLD_BUFS:]))

# --- a foreign-timeline metadata PID never moves the shared anchor (.103, 2026-09-08 13:27) ---
# The PCR rides the video (V), so the video is the timing PID. A sparse KLV-style
# PID (0x1f0) carries its own clock ~24 h off the media and steps around on it. It
# must NEVER trip the watch — re-anchoring the egress onto it blanks every consumer
# (live: +77 s jumps on every reconnect). The video's own rewind still re-anchors.
META = 7_900_000_000
mw_re = []
mw = t.TimelineStamper(on_reanchor=mw_re.append, repair_latch=True)
for i in range(200):
    v = FIRST + i * STEP
    m = META + ((i * 37) % 500) * 90000
    buf = bytearray(_pcr_pkt(V, (v - 9000) * 300) + pes_ts_packet(V, pts=v) + pes_ts_packet(0x1F0, pts=m))
    mw.condition(buf, HOUSE + i * STEP_NS); mw.stamp(bytes(buf), HOUSE + i * STEP_NS)
check("a foreign-timeline metadata PID never re-anchors the shared egress",
      not any(r['pid'] == 0x1F0 for r in mw_re))
vw_re = []
vw = t.TimelineStamper(on_reanchor=vw_re.append, repair_latch=True)
for i in range(60):
    v = (FIRST + i * STEP - (30 * 90000 if i >= 30 else 0)) % t.PTS_WRAP   # 30 s restart, past the conditioner bound
    buf = bytearray(_pcr_pkt(V, (v - 9000) * 300) + pes_ts_packet(V, pts=v) + pes_ts_packet(0x1F0, pts=META))
    vw.condition(buf, HOUSE + i * STEP_NS); vw.stamp(bytes(buf), HOUSE + i * STEP_NS)
check("the timing PID's own restart still re-anchors, with a metadata PID present",
      any(r['pid'] == V for r in vw_re))

# --- the conditioner rounds negative steps with FLOOR division (C++ floor_div parity) ---
# A backward PTS step whose ns->tick conversion does NOT divide evenly: floor and
# truncate-toward-zero differ by one tick. The twins write byte-for-byte identical
# wire, so the reported step, the cumulative offset and the rewritten PTS are pinned
# to the FLOOR result. A C++ plain `/` here (trunc) reports -89999 and writes
# 8128800 (ts_timeline.cpp:671, the .103 conditioner) and fails this.
cr_evs = []
cr = t.TimelineStamper(repair_latch=True, on_conditioned=cr_evs.append)
for i in range(8):                                   # fill the cadence memory with 40 ms deltas
    cr.condition(bytearray(pes_ts_packet(V, pts=FIRST + i * STEP)), HOUSE + i * STEP_NS)
cr_buf = bytearray(pes_ts_packet(V, pts=FIRST + 8 * STEP - 89999))   # ~1 s back, non-even
cr.condition(cr_buf, HOUSE + 8 * STEP_NS)
check("a non-even backward step is conditioned with floor division (reported step)",
      len(cr_evs) == 1 and cr_evs[0]['stepTicks'] == -90000)
check("... the cumulative offset is the floored step negated", cr_evs[0]['offsetTicks'] == 90000)
check("... and the rewritten PTS carries the floored offset (byte parity with C++)",
      p.read_pes_pts(cr_buf) == 8128801)

print("\nALL ts_timeline TESTS PASSED")
