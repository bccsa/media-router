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


print("\nALL ts_timeline TESTS PASSED")
