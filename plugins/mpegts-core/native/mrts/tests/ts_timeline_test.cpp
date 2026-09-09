// Port of ts_timeline_test.py (the latch half) plus the egress stamper the
// native bus sidecars share — the C++ half of the time-sync contract's
// producer side. The stamper cases mirror gst_bus_stamper_test.py, which pins
// the same semantics for the runner's gst producers: one contract, three
// implementations, identical arithmetic.
#include <cmath>
#include <cstring>
#include <map>
#include <vector>

#include "../ts_psi.h"
#include "../ts_timeline.h"
#include "check.h"

using namespace mrts;

namespace {

// Hand-built PES packet (ts_psi_test.cpp / gst_bus_stamper_test.py parity):
// PUSI, payload 00 00 01 <stream_id>, then the '10' marker, PTS_DTS_flags and
// the 5-byte PTS. `pts` < 0 = a PES with no PTS at all.
TsPacket pes_packet(int pid, int64_t pts) {
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = 0x40 | ((pid >> 8) & 0x1F);
    t.b[2] = pid & 0xFF;
    t.b[3] = 0x10;
    int i = 4;
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    t.b[i++] = 0x01;
    t.b[i++] = 0xE0;
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    t.b[i++] = 0x80;
    t.b[i++] = pts >= 0 ? 0x80 : 0x00;
    t.b[i++] = pts >= 0 ? 0x05 : 0x00;
    if (pts >= 0) {
        int64_t p = pts & (PTS_WRAP - 1);
        t.b[i++] = 0x21 | (uint8_t)(((p >> 30) & 0x07) << 1);
        t.b[i++] = (uint8_t)((p >> 22) & 0xFF);
        t.b[i++] = 0x01 | (uint8_t)(((p >> 15) & 0x7F) << 1);
        t.b[i++] = (uint8_t)((p >> 7) & 0xFF);
        t.b[i++] = 0x01 | (uint8_t)((p & 0x7F) << 1);
    }
    return t;
}

// A packet with NO PES header — continuation / null padding.
TsPacket filler_packet(int pid = PID_NULL) {
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = (pid >> 8) & 0x1F;
    t.b[2] = pid & 0xFF;
    t.b[3] = 0x10;
    return t;
}

std::vector<uint8_t> bytes_of(const std::vector<TsPacket>& pkts) {
    std::vector<uint8_t> out;
    for (const auto& p : pkts) out.insert(out.end(), p.b, p.b + PKT);
    return out;
}

int64_t stamp_of(TimelineStamper& s, const std::vector<TsPacket>& pkts, int64_t now,
                 int stream = 0) {
    auto data = bytes_of(pkts);
    return s.stamp(data.data(), data.size(), now, stream);
}

constexpr int64_t STEP = 3600;             // 40 ms in 90 kHz ticks
constexpr int64_t STEP_NS = 40'000'000;
constexpr int64_t FIRST_PES = 8'100'000;   // 90 s
constexpr int64_t HOUSE = 1'000'000'000'000;

// --- drift fixture (ts_timeline_test.py parity, number for number) ---------
constexpr int64_t D_STEP = 18000, D_STEP_NS = 200'000'000;   // 200 ms per buffer
constexpr int D_RATE = 3600 * 5;                             // buffers per sim hour
constexpr int64_t BUILD_NS = 2'000'000'000LL;                // the player's 2 s lead
constexpr int BUILD_S = 30;                                  // ... built over this
constexpr int LUMP = 30;                                     // 6 s segments
constexpr int64_t LUMP_STEP_NS = 26'666'666LL;               // 800 ms of sawtooth
constexpr int SLEW_MAX_PPM = 200;        // the .cpp's own constants, mirrored here
constexpr int TREND_SLOTS = 10;
constexpr int64_t GIVEBACK_NS = 200'000'000LL;

// python's `//` — the fixture divides a negative product for a slow source.
int64_t fdiv(int64_t a, int64_t b) {
    int64_t q = a / b;
    if (a % b != 0 && (a < 0) != (b < 0)) q--;
    return q;
}

// House arrival of buffer `i` from an HLS-shaped producer: a delivery LEAD that
// ramps to 2 s over 30 s and then holds, 800 ms of segment LUMPINESS on top,
// and a source clock running `ppm` fast under all of it.
int64_t hls_house(int i, int ppm) {
    int64_t t = (int64_t)i * D_STEP_NS;
    int64_t lead = t * BUILD_NS / ((int64_t)BUILD_S * 1'000'000'000LL);
    if (lead > BUILD_NS) lead = BUILD_NS;
    return HOUSE + t - lead - (int64_t)(i % LUMP) * LUMP_STEP_NS
           - fdiv(t * ppm, 1'000'000 + ppm);
}

}  // namespace

int main() {
    // --- ts_timeline.py parity: conversion + latch -------------------------
    CHECK("90k->ns one second", pts90k_to_ns(90000) == 1'000'000'000);
    CHECK("90k->ns one tick", pts90k_to_ns(1) == 11111);
    CHECK("90k->ns floors like python //", pts90k_to_ns(-1) == -11112);

    TimelineLatch latch;
    auto feed = [&latch](const std::vector<TsPacket>& pkts) {
        auto d = bytes_of(pkts);
        latch.feed(d.data(), d.size());
    };
    feed({filler_packet(), pes_packet(0x65, 900000), pes_packet(0xCC, 900900),
          pes_packet(0x65, 1800000)});
    CHECK("video PID latched first PTS", latch.first_pts(0x65, -1) == 900000);
    CHECK("audio PID latched first PTS", latch.first_pts(0xCC, -1) == 900900);
    CHECK("latched() reflects state", latch.latched(0x65) && !latch.latched(0x99));
    feed({pes_packet(0x65, 42)});
    CHECK("first PTS is sticky", latch.first_pts(0x65, -1) == 900000);
    CHECK("epoch_ref is the FIRST latched value (python insertion order)",
          latch.epoch_ref(-1) == 900000);

    TimelineLatch quiet;
    auto q = bytes_of({pes_packet(0x65, -1), filler_packet(0x100)});
    quiet.feed(q.data(), q.size());
    CHECK("no latch from PTS-less PES / PSI", !quiet.has_epoch());

    // Epoch-consistent latching astride the 33-bit boundary.
    TimelineLatch straddle;
    auto s1 = bytes_of({pes_packet(0x65, PTS_WRAP - 9000)});
    straddle.feed(s1.data(), s1.size());
    auto s2 = bytes_of({pes_packet(0xCC, 4500)});
    straddle.feed(s2.data(), s2.size());
    CHECK("post-wrap PID unwraps onto the pre-wrap epoch",
          straddle.first_pts(0xCC, -1) == PTS_WRAP + 4500);

    TimelineLatch mirror;
    auto m1 = bytes_of({pes_packet(0x65, 4500)});
    mirror.feed(m1.data(), m1.size());
    auto m2 = bytes_of({pes_packet(0xCC, PTS_WRAP - 9000)});
    mirror.feed(m2.data(), m2.size());
    CHECK("pre-wrap straggler unwraps down beside the epoch",
          mirror.first_pts(0xCC, -1) == -9000);
    CHECK("unwrap_near identity", unwrap_near(900000, 900900) == 900000);

    // --- the egress stamper ------------------------------------------------
    // Anchor + PES delta exactly, and the arrival time (`house_now`, jittered
    // here as a live relay's would be) leaves no trace after the first buffer.
    {
        int anchors = 0;
        TimelineStamper st([&](const TimelineStamper::Anchored& a) {
            anchors++;
            CHECK("the anchor callback names the first PES",
                  a.pid == 0x100 && a.ref_pts == FIRST_PES && a.anchor_ns == HOUSE);
        });
        std::vector<int64_t> seen;
        const int64_t jitter[6] = {0, 7'000'000, 1'000'000, 13'000'000, 2'000'000, 9'000'000};
        for (int i = 0; i < 6; i++) {
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)},
                                    HOUSE + i * STEP_NS + jitter[i]));
        }
        CHECK("exactly one anchor per egress", anchors == 1);
        CHECK("the stamp is anchor + PES delta, exactly",
              seen[0] == HOUSE && seen[5] == HOUSE + 5 * STEP_NS);
        bool clean = true;
        for (size_t i = 1; i < seen.size(); i++) clean &= seen[i] - seen[i - 1] == STEP_NS;
        CHECK("arrival jitter is gone — a clean 40 ms ladder", clean);

        // Every buffer carries a valid stamp: a PES-less one repeats rather
        // than inventing a time (a timestampless buffer makes a time-bounded
        // leaky queue unable to measure its own level).
        int64_t repeat = stamp_of(st, {filler_packet()}, HOUSE + 99 * STEP_NS);
        CHECK("a PES-less buffer repeats the previous stamp", repeat == seen[5]);

        // The stamp comes from the FIRST PES in the buffer, not the last —
        // taking the last would drag it forward by the interleave depth.
        int64_t first_wins = stamp_of(
            st, {pes_packet(0x100, FIRST_PES + 6 * STEP), pes_packet(0x101, FIRST_PES + 50 * STEP)},
            HOUSE);
        CHECK("the stamp reads the buffer's FIRST PES", first_wins == HOUSE + 6 * STEP_NS);
    }

    // A legal 2^33 wrap is continuous, not a discontinuity.
    {
        TimelineStamper st;
        std::vector<int64_t> seen;
        for (int i = 0; i < 24; i++) {
            int64_t pts = (PTS_WRAP - 3 * STEP + i * STEP) % PTS_WRAP;
            seen.push_back(stamp_of(st, {pes_packet(0x100, pts)}, HOUSE + i));
        }
        bool clean = true;
        for (size_t i = 1; i < seen.size(); i++) clean &= seen[i] - seen[i - 1] == STEP_NS;
        CHECK("every step across the 2^33 wrap is the plain 40 ms", clean);
        CHECK("the wrap does not re-anchor", st.reanchors() == 0);
    }

    // A synthetic gap (R7): a leaky queue shedding buffers changes the SPACING,
    // never the mapping — the stamp derives from the payload, not the buffer
    // count, so a dropped run reads as exactly its own PES delta.
    {
        TimelineStamper st;
        int64_t a = stamp_of(st, {pes_packet(0x100, FIRST_PES)}, HOUSE);
        int64_t b = stamp_of(st, {pes_packet(0x100, FIRST_PES + 6 * STEP)}, HOUSE + STEP_NS);
        CHECK("a shed run shows up as its own PES delta, not one step",
              b - a == 6 * STEP_NS && st.reanchors() == 0);
    }

    // A real source discontinuity re-anchors IN PLACE, and MUST drop the
    // monotone floor with the anchor: detection is a buffer late, so the floor
    // already holds a stamp derived from the jumped payload — left in place it
    // would pin the timeline ten minutes ahead and freeze it there.
    {
        const int64_t JUMP = 90000 * 600;   // +10 min
        int reanchors = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) {
            reanchors++;
            // The CONFIRMING PID fires it. The watch returns on the first
            // anomalous packet of a buffer, so 0x100 both reports the jump and
            // — a buffer later, coming back coherent from the epoch it
            // proposed — confirms it, with the two steps in between
            // accumulated into its delta.
            CHECK("the re-anchor names the offending PID and the jump",
                  r.pid == 0x100 && r.delta_ticks == JUMP + 2 * STEP && r.count == 1);
        });
        std::vector<int64_t> seen;
        for (int i = 0; i < 40; i++) {
            int64_t p = FIRST_PES + i * STEP + (i >= 20 ? JUMP : 0);
            // Two PIDs, as any real A/V producer has.
            seen.push_back(stamp_of(st, {pes_packet(0x100, p), pes_packet(0x101, p + 90)},
                                    HOUSE + i * STEP_NS));
        }
        CHECK("the discontinuity produced exactly one re-anchor", reanchors == 1);
        int jumped = 0;
        for (size_t i = 1; i < seen.size(); i++)
            if (seen[i] - seen[i - 1] > 60'000'000'000LL) jumped++;
        CHECK("only a bounded run of buffers carries the jumped stamp", jumped <= 2);
        bool recovers = seen.back() > seen[26] && seen.back() < HOUSE + 100 * STEP_NS;
        bool steps = true;
        for (size_t i = 27; i < seen.size(); i++) steps &= seen[i] - seen[i - 1] == STEP_NS;
        CHECK("the timeline recovers instead of freezing at the jumped value", recovers);
        CHECK("and it steps at the source's real 40 ms rate again", steps);
    }

    // ONE anchor + epoch across streams — the splitter's whole raison d'être.
    // Each output PID is its own wire stream, but they must stay mutually
    // aligned: the implied anchor (stamp - mapped PES) is ONE number for all.
    {
        TimelineStamper st;
        const int64_t VIDEO = FIRST_PES, AUDIO = FIRST_PES + 1234;
        // The audio branch starts LATE (its first buffer arrives 300 ms after
        // the video's) — with a per-stream anchor that wall gap would land
        // straight in the lipsync.
        int64_t v0 = stamp_of(st, {pes_packet(0x100, VIDEO)}, HOUSE, 0x100);
        int64_t a0 = stamp_of(st, {pes_packet(0x101, AUDIO)}, HOUSE + 300'000'000, 0x101);
        CHECK("a later branch inherits the shared anchor, not its own arrival",
              a0 - v0 == pts90k_to_ns(AUDIO - VIDEO));
        int64_t v1 = stamp_of(st, {pes_packet(0x100, VIDEO + STEP)}, HOUSE + 5, 0x100);
        int64_t a1 = stamp_of(st, {pes_packet(0x101, AUDIO + STEP)}, HOUSE + 400'000'000, 0x101);
        CHECK("and the A/V offset stays exactly the source's",
              a1 - v1 == pts90k_to_ns(AUDIO - VIDEO));

        // Per-stream monotone floors: a shared floor would clamp the lagging
        // branch to the leading one's stamp and silently re-roll lipsync.
        int64_t a2 = stamp_of(st, {filler_packet()}, HOUSE, 0x101);
        CHECK("each stream keeps its own staircase floor", a2 == a1 && a1 > v1);
    }

    // --- the VOD loop (2026-08-13 field failure) ---------------------------
    // ts_timeline_test.py runs the same fixture against the python definition;
    // the two must agree buffer for buffer. A looping VOD rewinds its PES
    // timeline to ~0 every pass, and mr-tssplit stamps each of its per-PID
    // SPTS outputs as its OWN single-PID buffer — so the cross-PID rule (a
    // second PID confirming a buffer later) has nothing to confirm with. Until
    // the same-PID path existed the watch counted exactly one anomaly per
    // output, never re-anchored, and the monotone floor pinned every later
    // stamp to the last pre-loop value for the rest of the loop.
    constexpr int LOOP_AT = 20, LOOP0 = 4500, N = 40;
    auto vod_pts = [](int i, int64_t base = FIRST_PES) {
        return i < LOOP_AT ? base + i * STEP : LOOP0 + (i - LOOP_AT) * STEP;
    };
    {
        int loops = 0, loop_pid = -1;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) {
            loops++;
            loop_pid = r.pid;
        });
        std::vector<int64_t> seen;
        for (int i = 0; i < N; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, vod_pts(i))}, HOUSE + i * STEP_NS));
        CHECK("a SINGLE-PID stream re-anchors at the loop (the field bug)",
              loops == 1 && loop_pid == 0x100);
        int recovered = N;
        for (int i = LOOP_AT; i < N && recovered == N; i++)
            if (seen[i] == HOUSE + i * STEP_NS) recovered = i;
        CHECK("and it fires within the confirmation window of the rewind",
              recovered - LOOP_AT <= 2);
        bool tracks = true, ladder = true;
        int64_t worst = 0;
        for (int i = 0; i < N; i++) worst = std::max(worst, HOUSE + i * STEP_NS - seen[i]);
        for (int i = LOOP_AT + 2; i < N; i++) tracks &= seen[i] == HOUSE + i * STEP_NS;
        for (int i = LOOP_AT + 2; i < N; i++) ladder &= seen[i] - seen[i - 1] == STEP_NS;
        CHECK("the stamps track house time again — no frozen clamp", tracks);
        CHECK("nothing lags house time by more than the detection latency",
              worst <= 2 * STEP_NS);
        CHECK("the floor dropped with the anchor: a clean 40 ms ladder after the loop",
              ladder);
    }

    // The cross-PID rule is NOT replaced by the same-PID one — a muxed egress
    // whose jump lands on a different PID each buffer still confirms on the
    // second.
    {
        int loops = 0, loop_pid = -1;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) {
            loops++;
            loop_pid = r.pid;
        });
        for (int i = 0; i < LOOP_AT; i++)
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP),
                          pes_packet(0x101, FIRST_PES + i * STEP + 90)},
                     HOUSE + i * STEP_NS);
        stamp_of(st, {pes_packet(0x100, LOOP0)}, HOUSE + LOOP_AT * STEP_NS);
        stamp_of(st, {pes_packet(0x101, LOOP0 + 90)}, HOUSE + (LOOP_AT + 1) * STEP_NS);
        CHECK("a second PID still confirms what the first reported (muxed egress)",
              loops == 1 && loop_pid == 0x101);
    }

    // A/V outputs of ONE splitter share the anchor, so they re-anchor TOGETHER
    // and lipsync survives the loop.
    {
        const int64_t SKEW = 1234, SKEW_NS = pts90k_to_ns(SKEW);
        int loops = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { loops++; });
        bool before = true, after = true;
        for (int i = 0; i < N; i++) {
            int64_t pv = vod_pts(i);
            int64_t v = stamp_of(st, {pes_packet(0x100, pv)}, HOUSE + i * STEP_NS, 0x100);
            int64_t a = stamp_of(st, {pes_packet(0x101, pv + SKEW)},
                                 HOUSE + i * STEP_NS + 5'000'000, 0x101);
            if (i < LOOP_AT) before &= a - v == SKEW_NS;
            // After the loop the timeline's zero is the AUDIO PES that
            // confirmed the re-anchor, so the video's delta off it is negative
            // and floor division rounds it one ns down — in python too, which
            // is the point of pts90k_to_ns flooring. One nanosecond.
            if (i >= LOOP_AT + 2) after &= std::llabs(a - v - SKEW_NS) <= 1;
        }
        CHECK("the A/V pair re-anchors together, once", loops == 1);
        CHECK("and lipsync is the source's on both sides of the loop", before && after);
    }

    // Debounce intact: ONE bad PES PTS is not a discontinuity. The pre-jump
    // reference is retained across the anomaly precisely so the stream can
    // come back to it and prove the outlier was an outlier.
    {
        int loops = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { loops++; });
        std::vector<int64_t> seen;
        for (int i = 0; i < 24; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP
                                                    - (i == 10 ? 90000 * 30 : 0))},
                                    HOUSE + i * STEP_NS));
        CHECK("a single corrupt PTS does NOT re-anchor", loops == 0);
        CHECK("and it costs one repeated stamp, not a timeline",
              seen[10] == seen[9] && seen[11] == HOUSE + 11 * STEP_NS);
    }

    // Nor does a legitimately SPARSE PID riding a healthy mux. This is what
    // confirming against the PROPOSED EPOCH buys over merely counting a PID's
    // anomalies: an 8 s metadata carousel is anomalous on EVERY appearance, so
    // a same-PID anomaly counter would re-anchor the whole egress on its
    // second one, while its 8 s advance never continues from the epoch the
    // previous one proposed.
    {
        constexpr int64_t SEC = 90000;
        int loops = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { loops++; });
        for (int i = 0; i < 40; i++) {
            std::vector<TsPacket> buf{pes_packet(0x100, FIRST_PES + i * SEC)};
            if (i % 8 == 0) buf.push_back(pes_packet(0x1FF, FIRST_PES + i * SEC + 45000));
            stamp_of(st, buf, HOUSE + i * 1'000'000'000LL);
        }
        CHECK("a sparse metadata PID (8 s carousel) never re-anchors", loops == 0);
    }

    // --- the bounded-staleness net (defense in depth) ----------------------
    // The watch is a DETECTOR: it answers the discontinuities it recognises.
    // This one it cannot — a source that has fallen behind real time emits a
    // perfectly legal 40 ms PES step every buffer while house time runs 400 ms
    // per buffer, so there is no anomaly to see and the stamps would trail
    // further behind for ever. The net catches it on the lag alone, which is
    // what makes the frozen-clamp mode impossible even for a detection gap
    // nobody has thought of. Bound and hold are ts_timeline.py's, to the ns.
    {
        constexpr int64_t HOUSE_STEP = 10 * STEP_NS;
        constexpr int64_t STALE_NS = 5'000'000'000LL, STALE_HOLD_NS = 1'000'000'000LL;
        int loops = 0;
        int64_t forced = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) {
            loops++;
            forced = r.delta_ticks;
        });
        std::vector<int64_t> seen;
        for (int i = 0; i < 24; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)},
                                    HOUSE + i * HOUSE_STEP));
        CHECK("a watch-invisible lag still forces a re-anchor", loops == 1);
        CHECK("the re-anchor reports the LAG that forced it, not a PES jump",
              forced < 0 && std::llabs(pts90k_to_ns(-forced) - (STALE_NS + STALE_HOLD_NS))
                                <= 2 * HOUSE_STEP);
        int64_t worst = 0;
        for (int i = 0; i < 24; i++) worst = std::max(worst, HOUSE + i * HOUSE_STEP - seen[i]);
        CHECK("the lag is BOUNDED — bound + hold + one buffer, never unbounded",
              worst <= STALE_NS + STALE_HOLD_NS + HOUSE_STEP);
        CHECK("and the stamps are back on house time after it fires",
              seen.back() > seen.front()
              && HOUSE + 23 * HOUSE_STEP - seen.back() < worst);
    }

    // A PSI-only first flush on a freshly wired output must not look like a
    // stream frozen since the epoch (a zero floor is a ~55-year lag to the net).
    {
        int loops = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { loops++; });
        stamp_of(st, {pes_packet(0x100, FIRST_PES)}, HOUSE, 0x100);
        int64_t psi_first = stamp_of(st, {filler_packet()}, HOUSE + STEP_NS, 0x101);
        stamp_of(st, {filler_packet()}, HOUSE + 2 * STEP_NS, 0x101);
        CHECK("a stream whose first buffer has no PES stamps house time, not zero",
              psi_first == HOUSE + STEP_NS);
        CHECK("and no zero floor trips the net", loops == 0);
    }

    // The engine-event contract, shared by every native producer. The sidecars
    // each carried their own emit lambda before this, and both had dropped
    // `lastPts90k` / `deltaTicks` from the re-anchor — so the same event meant
    // something different depending on which implementation sent it. The field
    // set below is `ts_timeline.py`'s callback payload verbatim; the python ↔
    // native cross-check lives in unixfdFanout.test.ts.
    {
        std::string a = anchor_event_json({0x100, 1234567890LL, 8100000LL});
        CHECK("the anchor event carries event/pid/anchorNs/refPts90k",
              a == "{\"event\":\"timeline_restamped\",\"pid\":256,"
                   "\"anchorNs\":1234567890,\"refPts90k\":8100000}");
        std::string r = reanchor_event_json({0x101, 8100000LL, 62100000LL, 54000000LL,
                                             1234567890LL, 3});
        CHECK("the re-anchor event names the jump that caused it, not just a count",
              r == "{\"event\":\"timeline_reanchor\",\"pid\":257,"
                   "\"lastPts90k\":8100000,\"refPts90k\":62100000,"
                   "\"deltaTicks\":54000000,\"anchorNs\":1234567890,\"count\":3}");
    }

    // --- the drift slew ----------------------------------------------------
    // ts_timeline_test.py's HLS fixture, buffer for buffer: a 2 s delivery lead
    // built over 30 s, 800 ms segment lumps, and a source clock off by `ppm`
    // under all of it. What the servo may do is cancel the TREND; what it may
    // NOT do is touch the LEVEL — the position loop that shipped first read a
    // healthy 2.25 s lead as an error and gave 125 ms of it away in 17 minutes
    // on .202, with the sink dropping late frames.
    {
        // No drift: the servo must apply LITERALLY NOTHING.
        TimelineStamper st;
        std::vector<int64_t> m;
        for (int i = 0; i < 4 * D_RATE; i++) {
            int64_t h = hls_house(i, 0);
            m.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)}, h)
                        - h);
        }
        auto settled = [&m](double hour) {
            int i = (int)(hour * D_RATE);
            int64_t best = m[i];
            for (int k = (i > 300 ? i - 300 : 0); k < i + 300 && k < (int)m.size(); k++)
                if (m[k] > best) best = m[k];
            return best;
        };
        // The literal is python's, from the same fixture — which is what makes
        // this a cross-language parity check and not two tests that happen to
        // agree in spirit (ts_timeline_test.py, `hls_run(0, 4)`).
        CHECK("a healthy HLS lead is not touched at all when there is no drift",
              settled(0.03) == settled(4.0) && settled(4.0) == 2'773'333'314LL);
        CHECK("...and the servo applied literally nothing to the anchor",
              st.drift().slew_ns == 0 && st.drift().ppm == 0);
    }
    for (int ppm : {50, -50}) {
        TimelineStamper st;
        std::vector<int64_t> m;
        for (int i = 0; i < 4 * D_RATE; i++) {
            int64_t h = hls_house(i, ppm);
            m.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)}, h)
                        - h);
        }
        auto settled = [&m](double hour) {
            int i = (int)(hour * D_RATE);
            int64_t best = m[i];
            for (int k = (i > 300 ? i - 300 : 0); k < i + 300 && k < (int)m.size(); k++)
                if (m[k] > best) best = m[k];
            return best;
        };
        int64_t per_hour = settled(4.0) - settled(3.0);
        CHECK("an HLS source's drift trend is cancelled (against 180 ms/hour)",
              (per_hour < 0 ? -per_hour : per_hour) <= 20'000'000LL);
        CHECK("and its 2 s delivery lead is still there",
              settled(4.0) > 2'500'000'000LL
              && settled(4.0) > settled(0.5) - GIVEBACK_NS);
        // ...and the locked rate is python's to the ppm (-52 / +49 there).
        CHECK("the servo locked onto the source's own offset",
              st.drift().ppm == (ppm == 50 ? -52 : 49));
        CHECK("and the trend window is full and engaged",
              st.drift().samples == TREND_SLOTS && st.drift().engage_ns != 0);
    }
    {
        // Nothing at all during the settling period, and the ±200 ppm bound
        // between every pair of consecutive buffers (which implies it over any
        // interval, the steps being cumulative).
        TimelineStamper st;
        int64_t prev_h = 0, prev_s = 0;
        bool bound_held = true, quiet_while_settling = true;
        for (int i = 0; i < 4 * D_RATE; i++) {
            int64_t h = hls_house(i, 50);
            stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)}, h);
            int64_t sl = st.drift().slew_ns;
            if (i > 0) {
                int64_t moved = sl - prev_s;
                if (moved < 0) moved = -moved;
                if (moved > (int64_t)SLEW_MAX_PPM * (h - prev_h) / 1'000'000)
                    bound_held = false;
            }
            if (i < (int)(0.4 * D_RATE) && sl != 0) quiet_while_settling = false;
            prev_h = h;
            prev_s = sl;
        }
        CHECK("nothing is corrected while the producer is still settling",
              quiet_while_settling);
        CHECK("and the correction never exceeds ±200 ppm of real time", bound_held);
    }
    {
        // The give-back watchdog: a source 400 ppm slow outruns the servo's
        // whole authority, so the margin keeps falling while it corrects — and
        // a servo that keeps correcting through that is one that will keep
        // correcting through the next thing it has wrong.
        TimelineStamper st;
        int standdowns = 0, worst_rate = 0;
        bool engaged = false;
        for (int i = 0; i < 2 * D_RATE; i++) {
            stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)},
                     hls_house(i, -400));
            bool now = st.drift().engage_ns != 0;
            if (engaged && !now) standdowns++;
            engaged = now;
            int r = st.drift().ppm < 0 ? -st.drift().ppm : st.drift().ppm;
            if (r > worst_rate) worst_rate = r;
        }
        CHECK("a drift past our authority stands the servo down rather than limping on",
              standdowns >= 1);
        // The clamp, on the case that actually reaches it: a source 400 ppm FAST
        // grows its margin instead of losing it, so the give-back watchdog
        // (which fires first for a slow one) never sees anything wrong and the
        // servo ramps until something stops it. 200 is written out on purpose —
        // a test that quotes the constant it checks cannot fail when it moves.
        TimelineStamper fast;
        for (int i = 0; i < 2 * D_RATE; i++) {
            stamp_of(fast, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)},
                     hls_house(i, 400));
            int r = fast.drift().ppm < 0 ? -fast.drift().ppm : fast.drift().ppm;
            if (r > worst_rate) worst_rate = r;
        }
        CHECK("and the ±200 ppm clamp is what stops it", worst_rate == 200);
    }
    {
        // A re-anchor restarts settling: a fresh anchor means a fresh producer
        // transient (the HLS lead rebuilds from zero), and measuring through it
        // is the mistake this loop was born from.
        TimelineStamper st;
        for (int i = 0; i < D_RATE; i++)
            stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)},
                     hls_house(i, 50));
        CHECK("the servo is engaged before the re-anchor",
              st.drift().ppm != 0 && st.drift().samples == TREND_SLOTS);
        int64_t h = hls_house(D_RATE, 50);
        stamp_of(st, {pes_packet(0x100, LOOP0)}, h);
        stamp_of(st, {pes_packet(0x100, LOOP0 + D_STEP)}, h + D_STEP_NS);
        TimelineStamper::Drift d = st.drift();
        CHECK("and the re-anchor resets it — rate, window and settling all fresh",
              d.ppm == 0 && d.slew_ns == 0 && d.margin_ns == 0 && d.engage_ns == 0
              && d.samples == 0);
    }
    {
        // PES-less buffers repeat the previous stamp, so their "margin" is that
        // stamp's AGE — feeding them in would read as a source falling behind.
        TimelineStamper st;
        for (int i = 0; i < (int)(1.5 * D_RATE); i++)
            stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)},
                     hls_house(i, 50));
        TimelineStamper::Drift before = st.drift();
        for (int k = 0; k < 50; k++)
            stamp_of(st, {filler_packet()},
                     hls_house((int)(1.5 * D_RATE), 50) + k * 100'000'000LL);
        TimelineStamper::Drift after = st.drift();
        CHECK("a run of PES-less buffers moves neither the estimate nor the anchor",
              after.ppm == before.ppm && after.slew_ns == before.slew_ns
              && after.margin_ns == before.margin_ns && after.samples == before.samples);
    }
    {
        // A/V through the slew: both legs stamp off ONE anchor, so a correction
        // moves them together and the source's lipsync survives it.
        const int64_t SKEW = 1234, SKEW_NS = pts90k_to_ns(SKEW);
        TimelineStamper st;
        int64_t worst = 0;
        for (int i = 0; i < (int)(1.5 * D_RATE); i++) {
            int64_t house = hls_house(i, 50);
            int64_t v = stamp_of(st, {pes_packet(0x100, FIRST_PES + (int64_t)i * D_STEP)},
                                 house, 0x100);
            int64_t a = stamp_of(st, {pes_packet(0x101, FIRST_PES + (int64_t)i * D_STEP + SKEW)},
                                 house + 3'000'000, 0x101);
            int64_t dev = (a - v) - SKEW_NS;
            if (dev < 0) dev = -dev;
            if (dev > worst) worst = dev;
        }
        CHECK("A/V hold the source's skew through the whole slew (to within ns)",
              worst <= 1000 && st.drift().ppm != 0);
    }

    // The stats line's `timeline` object — one shape for every producer, so a
    // burn-in chart never has to know which implementation stamped.
    {
        CHECK("drift_stats_json carries ppm/slewNs/marginNs/engageNs/samples/window",
              drift_stats_json({-50, -353102332LL, -2666666650LL, -2600000000LL, 10, 10})
                  == "{\"ppm\":-50,\"slewNs\":-353102332,\"marginNs\":-2666666650,"
                     "\"engageNs\":-2600000000,\"samples\":10,\"window\":10}");
    }

    // --- latch repair (the 2026-09-05 GATE01 field failure) ----------------
    // ts_timeline_test.py's burst fixture, literal for literal: a live source
    // (re)connects and flushes the backlog it queued while the session was
    // down, so the first PES is that backlog's HEAD — late by all of it — and
    // every buffer after it arrives early against an anchor taken off it. On
    // .46 a vMix SRT feed came back with ~1.8 s queued and every mux mixing it
    // with a sibling feed shipped 1.8 s of lipsync downstream.
    constexpr int BACKLOG = 45;                        // 1.8 s of 40 ms buffers queued
    constexpr int64_t BURST_NS = 4'000'000LL;          // ... flushed at one per 4 ms
    constexpr int64_t BURST_ERR_NS = BACKLOG * (STEP_NS - BURST_NS);   // 1.62 s
    constexpr int BURST_N = 200;                       // 6.2 s: the 3 s window closes inside
    auto burst_house = [](int i) {
        return i < BACKLOG ? HOUSE + i * BURST_NS
                           : HOUSE + BACKLOG * BURST_NS + (int64_t)(i - BACKLOG) * STEP_NS;
    };
    {
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        std::vector<int64_t> seen;
        for (int i = 0; i < BURST_N; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)},
                                    burst_house(i)));
        CHECK("the window closes once, on the first PES past it, and reports its cost",
              settled.size() == 1 && settled[0].anchor_ns == HOUSE - BURST_ERR_NS
              && settled[0].repair_ns == -BURST_ERR_NS
              && settled[0].window_ns == 3'000'000'000LL
              && BURST_ERR_NS == 1'620'000'000LL);
        bool backlog_ok = true, cadence_ok = true, monotone = true;
        for (int i = 0; i < BACKLOG; i++) backlog_ok &= seen[i] == burst_house(i);
        for (int i = BACKLOG + 1; i < BURST_N; i++) cadence_ok &= seen[i] == burst_house(i);
        for (int i = 1; i < BURST_N; i++) monotone &= seen[i] >= seen[i - 1];
        CHECK("the backlog leaves stamped with its arrival — fast-forwarded, never early",
              backlog_ok);
        CHECK("and after it every stamp is ON the source's delivery cadence (margin 0)",
              cadence_ok);
        CHECK("monotone by construction: no floor clamp, no backwards step for a consumer",
              monotone);
        CHECK("the anchor is fixed once the window closes",
              st.anchor_ns() == HOUSE - BURST_ERR_NS);
    }
    {
        // The control: a default stamper is the field failure, and repair is
        // opt-in so nothing that did not ask for it (the HLS fan-out) moves.
        TimelineStamper st;
        bool stuck = true;
        for (int i = 0; i < BURST_N; i++) {
            int64_t s = stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, burst_house(i));
            if (i >= BACKLOG) stuck &= s - burst_house(i) == BURST_ERR_NS;
        }
        CHECK("a default stamper still anchors on the first PES — repair is opt-in", stuck);
    }
    {
        // A source ON cadence costs the window nothing: jitter is late, never early.
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        const int64_t jitter[6] = {0, 7'000'000, 1'000'000, 13'000'000, 2'000'000, 9'000'000};
        bool untouched = true;
        for (int i = 0; i < 120; i++)
            untouched &= stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)},
                                  HOUSE + i * STEP_NS + jitter[i % 6]) == HOUSE + i * STEP_NS;
        CHECK("a source on cadence costs the window nothing (jitter is late, never early)",
              untouched && settled.size() == 1 && settled[0].repair_ns == 0
              && settled[0].anchor_ns == HOUSE);
    }
    {
        // A/V of ONE egress through the burst: the window converges on the
        // stream that delivers earliest, then both legs hold the source's skew.
        const int64_t SKEW = 1234, SKEW_NS = pts90k_to_ns(SKEW);
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        bool skew_held = true;
        for (int i = 0; i < BURST_N; i++) {
            int64_t house = burst_house(i);
            int64_t v = stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, house, 0x100);
            int64_t a = stamp_of(st, {pes_packet(0x101, FIRST_PES + i * STEP + SKEW)},
                                 house + 5'000'000, 0x101);
            if (i >= BACKLOG + 2) skew_held &= a - v == SKEW_NS;
        }
        CHECK("A/V settle onto ONE repaired anchor and hold the source's skew after it",
              skew_held && settled.size() == 1
              && settled[0].repair_ns == -(BURST_ERR_NS + SKEW_NS - 5'000'000)
              && settled[0].repair_ns == -1'628'711'111LL);   // python's literal
    }
    {
        // A re-anchor re-opens the window; a clean post-jump cadence closes it
        // again for free.
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        constexpr int JUMP_AT = 100;
        constexpr int64_t JUMP = 90000LL * 600;
        for (int i = 0; i < 2 * JUMP_AT; i++) {
            int64_t pts = FIRST_PES + i * STEP + (i >= JUMP_AT ? JUMP : 0);
            stamp_of(st, {pes_packet(0x100, pts), pes_packet(0x101, pts + 90)},
                     HOUSE + i * STEP_NS);
        }
        CHECK("a re-anchor re-opens the window and a clean cadence closes it for free",
              st.reanchors() == 1 && settled.size() == 2 && settled[0].repair_ns == 0
              && settled[1].repair_ns == 0);
    }
    {
        // A disarm INSIDE the window still reports the repair so far, once;
        // closing twice, or a stamper that never opened one, is a no-op.
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        for (int i = 0; i < BACKLOG + 10; i++)
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, burst_house(i));
        st.close_latch();
        st.close_latch();
        TimelineStamper never;
        never.close_latch();
        CHECK("a disarm inside the window reports the repair so far, once",
              settled.size() == 1 && settled[0].repair_ns == -BURST_ERR_NS
              && settled[0].anchor_ns == HOUSE - BURST_ERR_NS);
    }
    {
        // A discontinuity INSIDE an open window: closed and reported first,
        // then the fresh anchor starts from zero.
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        constexpr int MID_JUMP_AT = 60;     // 0.78 s in: window still open
        constexpr int64_t JUMP = 90000LL * 600;
        for (int i = 0; i < MID_JUMP_AT + 100; i++) {   // ...and the second closes too
            int64_t pts = FIRST_PES + i * STEP + (i >= MID_JUMP_AT ? JUMP : 0);
            stamp_of(st, {pes_packet(0x100, pts), pes_packet(0x101, pts + 90)}, burst_house(i));
        }
        CHECK("a re-anchor inside the window reports the first anchor's cost, then starts fresh",
              st.reanchors() == 1 && settled.size() == 2
              && settled[0].repair_ns == -BURST_ERR_NS && settled[1].repair_ns == 0
              && settled[0].anchor_ns == HOUSE - BURST_ERR_NS);
    }
    {
        // The jumped (flagged, unconfirmed) buffer is not early delivery, and
        // a single corrupt PTS must never move the anchor for good.
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        for (int i = 0; i < 100; i++)
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP + (i == 10 ? 90000LL * 30 : 0))},
                     HOUSE + i * STEP_NS);
        CHECK("an unconfirmed forward PTS jump inside the window never moves the anchor",
              st.reanchors() == 0 && st.anchor_ns() == HOUSE && settled.size() == 1
              && settled[0].repair_ns == 0);
    }
    {
        // The backlog through the RE-ANCHOR path (ts_timeline_test.py's
        // rejump fixture, literal for literal): clean cadence, a source
        // discontinuity, the post-jump media flushed as a burst.
        constexpr int RE_JUMP_AT = 100;
        constexpr int64_t JUMP = 90000LL * 600;
        const int64_t RE_T0 = HOUSE + RE_JUMP_AT * STEP_NS;
        auto rejump_house = [&](int i) {
            if (i < RE_JUMP_AT) return HOUSE + i * STEP_NS;
            int k = i - RE_JUMP_AT;
            if (k < BACKLOG) return RE_T0 + k * BURST_NS;
            return RE_T0 + BACKLOG * BURST_NS + (int64_t)(k - BACKLOG) * STEP_NS;
        };
        std::vector<TimelineStamper::Settled> settled;
        TimelineStamper st(nullptr, nullptr,
                           [&](const TimelineStamper::Settled& s) { settled.push_back(s); },
                           true);
        std::vector<int64_t> seen;
        for (int i = 0; i < RE_JUMP_AT + 200; i++) {
            int64_t pts = FIRST_PES + i * STEP + (i >= RE_JUMP_AT ? JUMP : 0);
            seen.push_back(stamp_of(st, {pes_packet(0x100, pts)}, rejump_house(i)));
        }
        // The watch confirms one buffer late, so the visible backlog is one
        // buffer shorter than the first-PES case.
        constexpr int64_t RE_ERR_NS = (BACKLOG - 1) * (STEP_NS - BURST_NS);
        bool cadence = true;
        for (int i = RE_JUMP_AT + BACKLOG + 2; i < RE_JUMP_AT + 200; i++)
            cadence &= seen[i] == rejump_house(i);
        CHECK("a backlog flushed after a discontinuity is repaired off the re-anchor too",
              st.reanchors() == 1 && settled.size() == 2 && settled[0].repair_ns == 0
              && settled[1].repair_ns == -RE_ERR_NS && RE_ERR_NS == 1'584'000'000LL);
        CHECK("and after it every stamp is on the source's delivery cadence again", cadence);
    }
    {
        CHECK("the settled event carries event/anchorNs/repairNs/windowNs",
              settled_event_json({998380000000LL, -1620000000LL, 3000000000LL})
                  == "{\"event\":\"timeline_settled\",\"anchorNs\":998380000000,"
                     "\"repairNs\":-1620000000,\"windowNs\":3000000000}");
    }

    // --- the late-level tier of the net (the 2026-09-08 .103 freeze) --------
    // ts_timeline_test.py parity, number for number: a 300 ms LEVEL from buffer
    // 20 (not a PTS step, not a slope, not 5 s) re-anchors once, on the buffer
    // that completes the 10 s hold, and every buffer from it leaves stamped
    // with its arrival.
    {
        constexpr int64_t LATE_LEVEL = 300'000'000LL;
        constexpr int LATE_AT = 20;
        constexpr int LATE_HOLD_BUFS = 10'000'000'000LL / STEP_NS;   // 250
        auto late_house = [&](int i) {
            return HOUSE + i * STEP_NS + (i >= LATE_AT ? LATE_LEVEL : 0);
        };
        std::vector<TimelineStamper::Reanchor> late;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) { late.push_back(r); });
        std::vector<int64_t> seen;
        for (int i = 0; i < 400; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, late_house(i)));
        CHECK("a sustained late level re-anchors exactly once", late.size() == 1);
        CHECK("... on the buffer that completes the hold, not before",
              late.size() == 1 && late[0].anchor_ns == late_house(LATE_AT + LATE_HOLD_BUFS));
        CHECK("... and reports the level it removed (negative: media behind house)",
              late.size() == 1
              && std::llabs(pts90k_to_ns(-late[0].delta_ticks) - LATE_LEVEL) <= STEP_NS);
        bool before = true, after = true;
        for (int i = LATE_AT; i < LATE_AT + LATE_HOLD_BUFS; i++)
            before &= late_house(i) - seen[i] == LATE_LEVEL;
        for (int i = LATE_AT + LATE_HOLD_BUFS; i < 400; i++) after &= seen[i] == late_house(i);
        CHECK("before it the stamps sat the level behind house", before);
        CHECK("from it every buffer leaves stamped with its arrival", after);
    }
    {
        // An in-bound level, one straggler and a delivery lead never trip it.
        int quiet = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { quiet++; });
        for (int i = 0; i < 400; i++) {
            int64_t h = HOUSE + i * STEP_NS;
            if (i >= 20) h += 80'000'000LL;
            if (i == 100) h += 900'000'000LL;
            int64_t ahead = i >= 200 ? 2 * 90000 : 0;
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP + ahead)}, h);
        }
        CHECK("an in-bound level, a straggler and a delivery lead never trip the tier",
              quiet == 0);
    }
    {
        // Egress-wide MINIMUM: one late stream among on-time siblings.
        int mixed = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { mixed++; });
        for (int i = 0; i < 400; i++) {
            int64_t h = HOUSE + i * STEP_NS;
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, h, 0x100);
            stamp_of(st, {pes_packet(0x140, FIRST_PES + i * STEP - 27000)}, h, 0x140);
        }
        CHECK("one late stream among on-time siblings never trips the tier", mixed == 0);
    }
    {
        // A sparse (1 Hz) PID is on time by its own mapping, whatever its floor's age.
        int sparse = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { sparse++; });
        for (int i = 0; i < 400; i++) {
            int64_t h = HOUSE + i * STEP_NS;
            stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP)}, h, 0x100);
            if (i % 25 == 0) stamp_of(st, {pes_packet(0x1F0, FIRST_PES + i * STEP)}, h, 0x1F0);
        }
        CHECK("a 1 Hz metadata PID never trips the tier", sparse == 0);
    }
    // --- the EARLY side (the #737 rewind, the RIST-reconnect lead) ----------
    // ts_timeline_test.py parity: at 8 s (past the 3 s latch-repair window,
    // which would otherwise absorb it on the spot) the source steps 1.5 s AHEAD
    // in PTS (coherent to the watch), so every buffer is stamped 1.5 s before
    // it arrives. With repair_latch (a live-cadence producer) the tier
    // re-anchors once the hold completes and reports the lead it removed; an
    // opt-out (HLS) producer keeps its lead, and a 500 ms lead is in bound.
    {
        constexpr int64_t EARLY_LEVEL = 1'500'000'000LL;
        constexpr int64_t EARLY_TICKS = 135000;
        constexpr int EARLY_AT = 200, EARLY_N = 700;
        constexpr int EARLY_HOLD_BUFS = 10'000'000'000LL / STEP_NS;
        std::vector<TimelineStamper::Reanchor> early;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) { early.push_back(r); },
                           nullptr, true);
        std::vector<int64_t> seen;
        for (int i = 0; i < EARLY_N; i++)
            seen.push_back(stamp_of(st, {pes_packet(0x100, FIRST_PES + i * STEP + (i >= EARLY_AT ? EARLY_TICKS : 0))},
                                    HOUSE + i * STEP_NS));
        CHECK("a sustained early lead re-anchors exactly once (live-cadence producer)",
              early.size() == 1);
        CHECK("... on the buffer that completes the hold",
              early.size() == 1 && early[0].anchor_ns == HOUSE + (EARLY_AT + EARLY_HOLD_BUFS) * STEP_NS);
        CHECK("... and reports the lead it removed (positive: media ahead of house)",
              early.size() == 1
              && std::llabs(pts90k_to_ns(early[0].delta_ticks) - EARLY_LEVEL) <= STEP_NS);
        bool before = true, after = true;
        for (int i = EARLY_AT; i < EARLY_AT + EARLY_HOLD_BUFS; i++)
            before &= seen[i] - (HOUSE + i * STEP_NS) == EARLY_LEVEL;
        for (int i = EARLY_AT + EARLY_HOLD_BUFS; i < EARLY_N; i++) after &= seen[i] == HOUSE + i * STEP_NS;
        CHECK("before it the stamps ran the lead ahead of house", before);
        CHECK("from it every buffer leaves stamped with its arrival", after);

        int lead_off = 0;
        TimelineStamper off(nullptr, [&](const TimelineStamper::Reanchor&) { lead_off++; });
        for (int i = 0; i < EARLY_N; i++)
            stamp_of(off, {pes_packet(0x100, FIRST_PES + i * STEP + (i >= EARLY_AT ? EARLY_TICKS : 0))},
                     HOUSE + i * STEP_NS);
        CHECK("a delivery lead never moves an opt-out (HLS) producer's anchor", lead_off == 0);

        int small = 0;
        TimelineStamper sm(nullptr, [&](const TimelineStamper::Reanchor&) { small++; }, nullptr, true);
        for (int i = 0; i < EARLY_N; i++)
            stamp_of(sm, {pes_packet(0x100, FIRST_PES + i * STEP + (i >= EARLY_AT ? 45000 : 0))},
                     HOUSE + i * STEP_NS);
        CHECK("a 500 ms lead is inside the early bound and never trips it", small == 0);
    }

    // --- the timeline conditioner (the vMix CBR pacer reset, 2026-09-08) -----
    // ts_timeline_test.py parity, number for number: audio steps back 1.42 s
    // (gaining a DTS after its PTS), video 1.19 s a second later, then both
    // leap forward and the PCR leaps +1.19 s. Conditioned, every written clock
    // stays continuous, the stamper sees no discontinuity, the net offset is 0.
    {
        constexpr int V = 0x100, A = 0x140;
        constexpr int64_t A_BACK = 127800, V_BACK = 107100;
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        auto pes_dts_pkt = [](int pid, int64_t pts, int64_t dts) {
            TsPacket t = pes_packet(pid, pts);
            t.b[4 + 7] = 0xC0; t.b[4 + 8] = 0x0A;                 // PTS+DTS, header length 10
            t.b[4 + 9] = (uint8_t)((t.b[4 + 9] & 0x0F) | 0x30);   // '0011' prefix on the PTS
            int64_t d = dts & (PTS_WRAP - 1);
            t.b[4 + 14] = (uint8_t)(0x11 | (((d >> 30) & 0x07) << 1));
            t.b[4 + 15] = (uint8_t)((d >> 22) & 0xFF);
            t.b[4 + 16] = (uint8_t)(0x01 | (((d >> 15) & 0x7F) << 1));
            t.b[4 + 17] = (uint8_t)((d >> 7) & 0xFF);
            t.b[4 + 18] = (uint8_t)(0x01 | ((d & 0x7F) << 1));
            return t;
        };
        auto fold = [](int64_t d, int64_t m) { d %= m; if (d < 0) d += m; return d > m / 2 ? d - m : d; };
        auto read_dts = [](const uint8_t* pkt) -> int64_t {
            int off = payload_offset(pkt); if (!(pkt[off + 7] & 0x40)) return -1;
            const uint8_t* q = pkt + off + 14;
            return ((int64_t)((q[0] >> 1) & 7) << 30) | ((int64_t)q[1] << 22) | ((int64_t)(q[2] >> 1) << 15) | ((int64_t)q[3] << 7) | (q[4] >> 1);
        };
        std::vector<TimelineStamper::Conditioned> cond; int reanchors = 0;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor&) { reanchors++; }, nullptr, true);
        st.set_on_conditioned([&](const TimelineStamper::Conditioned& c) { cond.push_back(c); });
        std::vector<int64_t> wv, wa, wpcr, stamps; int dts_bad = 0;
        for (int i = 0; i < 600; i++) {
            int64_t h = HOUSE + i * STEP_NS;
            int64_t v_pts = FIRST_PES + i * STEP - ((i >= 150 && i < 250) ? V_BACK : 0);
            int64_t a_pts = FIRST_PES + 900 + i * STEP - ((i >= 100 && i < 249) ? A_BACK : 0);
            int64_t pcr = (FIRST_PES - 9000 + i * STEP + (i >= 250 ? V_BACK : 0)) * 300;
            std::vector<TsPacket> pk = {pcr_pkt(V, pcr), pes_packet(V, v_pts),
                                        (i >= 100 && i < 249) ? pes_dts_pkt(A, a_pts, a_pts + A_BACK) : pes_packet(A, a_pts)};
            auto data = bytes_of(pk);
            st.condition(data.data(), data.size(), h);
            stamps.push_back(st.stamp(data.data(), data.size(), h, 0));
            wpcr.push_back(read_pcr(data.data())); wv.push_back(read_pes_pts(data.data() + PKT));
            wa.push_back(read_pes_pts(data.data() + 2 * PKT));
            int64_t d = read_dts(data.data() + 2 * PKT);
            if (d >= 0 && fold(d - wa.back(), PTS_WRAP) > 0) dts_bad++;
        }
        auto cont = [&](const std::vector<int64_t>& s, int64_t m, int64_t unit_ns_num, int64_t unit_ns_den) {
            for (size_t i = 0; i + 1 < s.size(); i++) {
                int64_t d = fold(s[i + 1] - s[i], m) * unit_ns_num / unit_ns_den;
                if (d <= 0 || d > 100'000'000LL) return false;
            }
            return true;
        };
        CHECK("conditioned: written video PTS is continuous through the pacer reset", cont(wv, PTS_WRAP, 100000, 9));
        CHECK("conditioned: written audio PTS is continuous through the pacer reset", cont(wa, PTS_WRAP, 100000, 9));
        CHECK("conditioned: written PCR is continuous through the pacer reset (after the flagged switch to regeneration)",
              cont(std::vector<int64_t>(wpcr.begin() + 1, wpcr.end()), PCR_MODULO, 1000, 27));
        CHECK("conditioned: no DTS is left after its own PTS", dts_bad == 0);
        CHECK("conditioned: the stamper saw no discontinuity — no re-anchor", reanchors == 0);
        bool steady = true;
        for (size_t i = 0; i + 1 < stamps.size(); i++) steady &= stamps[i + 1] >= stamps[i] && stamps[i + 1] - stamps[i] <= 100'000'000LL;
        CHECK("conditioned: the stamps themselves never step", steady);
        std::vector<int64_t> pts_steps, pcr_steps;
        std::map<int, int64_t> last_off;
        for (auto& c : cond) {
            if (c.pcr) pcr_steps.push_back(c.step_ticks);
            else { pts_steps.push_back(c.step_ticks); last_off[c.pid] = c.offset_ticks; }
        }
        auto near = [](int64_t v, int64_t want) { return std::llabs(v - want) <= 2000; };
        CHECK("conditioned: the four PES steps are each reported once",
              pts_steps.size() == 4 && near(pts_steps[0], -A_BACK) && near(pts_steps[1], -V_BACK)
              && near(pts_steps[2], A_BACK) && near(pts_steps[3], V_BACK));
        if (!(pcr_steps.size() == 2 && near(pcr_steps[0], -17100) && near(pcr_steps[1], -V_BACK))) {
            std::printf("  pcr events:");
            for (auto v : pcr_steps) std::printf(" %lld", (long long)v);
            std::printf("\n");
        }
        CHECK("conditioned: the regenerated PCR reports its lead over the source's (once) and the source's leap (once)",
              pcr_steps.size() == 2 && near(pcr_steps[0], -17100) && near(pcr_steps[1], -V_BACK));
        bool pes_zero = last_off.size() == 2;
        for (auto& kv : last_off) pes_zero &= kv.second == 0;
        CHECK("conditioned: both PES offsets are back to zero once the reset is over", pes_zero);
        bool lead = true;
        for (size_t i = 1; i < wv.size(); i++)
            lead &= std::llabs(fold(wv[i] - wpcr[i] / 300, PTS_WRAP) - 22500) <= 4500;
        CHECK("conditioned: written PTS − PCR sits on the lead throughout", lead);
    }
    {
        // The correction is sized by cadence, not arrival: a step landing on a
        // big frame (350 ms of wire time) is absorbed by exactly the step.
        std::vector<TimelineStamper::Conditioned> big; std::vector<int64_t> bw;
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        st.set_on_conditioned([&](const TimelineStamper::Conditioned& c) { big.push_back(c); });
        for (int i = 0; i < 300; i++) {
            int64_t h = HOUSE + i * STEP_NS + (i >= 100 ? 350'000'000LL : 0);
            int64_t pts = FIRST_PES + i * STEP - ((i >= 100 && i < 200) ? 94500 : 0);
            auto data = bytes_of({pes_packet(0x100, pts)});
            st.condition(data.data(), data.size(), h);
            bw.push_back(read_pes_pts(data.data()));
        }
        bool exact = big.size() == 2 && big[0].step_ticks == -94500 && big[1].step_ticks == 94500
                     && big[1].offset_ticks == 0;
        CHECK("a step that lands on a big frame is absorbed by exactly the step, not the frame's wire time", exact);
        bool smooth = true;
        for (size_t i = 0; i + 1 < bw.size(); i++) { int64_t d = bw[i + 1] - bw[i]; smooth &= d > 0 && d <= STEP; }
        CHECK("... so the written PTS has no residual step anywhere", smooth);
    }
    {
        // PCR regeneration (ts_timeline_test.py parity): a 12.6 s PCR lag is
        // gone from the first regenerated packet; a PCR that freezes 1.1 s
        // while the PTS runs on does not move the written clock; one
        // discontinuity indicator, and an event per 300 ms of source drift.
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        auto fold = [](int64_t d, int64_t m) { d %= m; if (d < 0) d += m; return d > m / 2 ? d - m : d; };
        std::vector<TimelineStamper::Conditioned> ev; std::vector<double> gaps; std::vector<int64_t> wp; int di = 0;
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        st.set_on_conditioned([&](const TimelineStamper::Conditioned& c) { ev.push_back(c); });
        int64_t pcr_val = (FIRST_PES - 12 * 90000 - 54000) * 300;
        for (int i = 0; i < 400; i++) {
            bool frozen = (i >= 150 && i < 177) || (i >= 300 && i < 327);
            if (!frozen) pcr_val += STEP * 300;
            auto data = bytes_of({pcr_pkt(0x100, pcr_val), pes_packet(0x100, FIRST_PES + i * STEP)});
            st.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            if (data[5] & 0x80) di++;
            wp.push_back(read_pcr(data.data()));
            gaps.push_back(fold(read_pes_pts(data.data() + PKT) - read_pcr(data.data()) / 300, PTS_WRAP) / 90000.0);
        }
        const double GAP0 = (12 * 90000 + 54000 - STEP) / 90000.0;
        CHECK("PCR regeneration: a 12.6 s PCR lag is gone from the first regenerated packet",
              !ev.empty() && ev[0].pcr && std::fabs(ev[0].step_ticks / 90000.0 - (GAP0 - 0.25)) < 0.05
              && std::fabs(gaps[1] - 0.25) < 0.05);
        bool onlead = true, mono = true;
        for (size_t i = 1; i < gaps.size(); i++) onlead &= std::fabs(gaps[i] - 0.25) <= 0.05;
        for (size_t i = 1; i + 1 < wp.size(); i++) { int64_t d = fold(wp[i + 1] - wp[i], PCR_MODULO); mono &= d >= 0 && d <= 27'000'000 / 10; }
        CHECK("... the written PTS − PCR holds the lead through the pacer's freezes", onlead);
        CHECK("... the written PCR is continuous and monotone throughout", mono);
        CHECK("... one discontinuity indicator (the first regenerated value), and the freezes are reported",
              di == 1 && ev.size() >= 3);
    }
    {
        // The reference is the PID carrying the PCR, even when a leading audio
        // PID's PES came first (the .103 11:41 freeze).
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        auto fold = [](int64_t d, int64_t m) { d %= m; if (d < 0) d += m; return d > m / 2 ? d - m : d; };
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        bool ok = true;
        for (int i = 0; i < 200; i++) {
            int64_t a_pts = FIRST_PES + 126000 + i * STEP, v_pts = FIRST_PES + i * STEP;
            auto data = bytes_of({pes_packet(0x140, a_pts), pcr_pkt(0x100, (v_pts - 9000) * 300), pes_packet(0x100, v_pts)});
            st.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            double g = fold(read_pes_pts(data.data() + 2 * PKT) - read_pcr(data.data() + PKT) / 300, PTS_WRAP) / 90000.0;
            if (i >= 2) ok &= std::fabs(g - 0.25) <= 0.05;
        }
        CHECK("the regenerated PCR trails the PCR PID's own PTS, not a leading audio PID's", ok);

        // ... and when a stream LAGS the video (audio 400 ms behind) the PCR
        // trails the lagging one; a sparse PID seconds behind cannot drag it.
        TimelineStamper lag(nullptr, nullptr, nullptr, true);
        bool lag_ok = true;
        for (int i = 0; i < 200; i++) {
            int64_t v_pts = FIRST_PES + i * STEP, a_pts = v_pts - 36000, k_pts = v_pts - 5 * 90000;
            std::vector<TsPacket> pk = {pcr_pkt(0x100, (v_pts - 9000) * 300), pes_packet(0x100, v_pts), pes_packet(0x140, a_pts)};
            if (i % 50 == 0) pk.push_back(pes_packet(0x1F0, k_pts));
            auto data = bytes_of(pk);
            lag.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            int64_t pcr = read_pcr(data.data()) / 300;
            double vg = fold(read_pes_pts(data.data() + PKT) - pcr, PTS_WRAP) / 90000.0;
            double ag = fold(read_pes_pts(data.data() + 2 * PKT) - pcr, PTS_WRAP) / 90000.0;
            if (i >= 3) lag_ok &= std::fabs(ag - 0.25) <= 0.05 && std::fabs(vg - 0.65) <= 0.05;
        }
        CHECK("the PCR trails the lagging audio (audio ≥ lead, video = lead + its lag), unmoved by a sparse PID seconds behind", lag_ok);
    }
    {
        // Sparse PCR clusters are cadence (one indicator in total); a real 2 s
        // picture gap (PTS +2 s, arrival one frame) is signalled.
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        std::vector<int> di;
        for (int i = 0; i < 400; i++) {
            int64_t pts = FIRST_PES + i * STEP + (i >= 300 ? 2 * 90000 : 0) + (i >= 350 ? 20 * 90000 : 0);
            int64_t h = HOUSE + i * STEP_NS + (i >= 300 ? 2'000'000'000LL : 0);
            std::vector<TsPacket> pk;
            if (i % 55 == 0) pk.push_back(pcr_pkt(0x100, (pts - 27000) * 300));
            pk.push_back(pes_packet(0x100, pts));
            auto data = bytes_of(pk);
            st.condition(data.data(), data.size(), h);
            if ((data[3] & 0x20) && (data[5] & 0x80)) di.push_back(i);
        }
        CHECK("sparse PCR clusters and a real picture gap are cadence; only a jump past the bound is signalled",
              di.size() == 2 && di[0] == 55 && di[1] == 385);
    }
    {
        // TIMING PID (ts_timeline_test.py parity): audio PES 1.7 s ahead of the
        // video and first in every buffer; the anchor lands on the video, the
        // video stays on its arrival, the audio rides 1.7 s early.
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        int reanchors = 0, rebase_pid = -1; int64_t rebase_delta = -1;
        TimelineStamper st(nullptr,
                           [&](const TimelineStamper::Reanchor& r) { if (reanchors++ == 0) { rebase_pid = r.pid; rebase_delta = r.delta_ticks; } },
                           nullptr, true);
        bool video_ok = true, audio_ok = true;
        for (int i = 0; i < 600; i++) {
            int64_t h = HOUSE + i * STEP_NS;
            int64_t v_pts = FIRST_PES + i * STEP, a_pts = v_pts + 153000;
            auto ab = bytes_of({pes_packet(0x140, a_pts)});
            st.condition(ab.data(), ab.size(), h);
            int64_t am = st.stamp(ab.data(), ab.size(), h, 0x140) - h;
            auto vb = bytes_of({pcr_pkt(0x100, (v_pts - 9000) * 300), pes_packet(0x100, v_pts)});
            st.condition(vb.data(), vb.size(), h);
            int64_t vm = st.stamp(vb.data(), vb.size(), h, 0x100) - h;
            if (i >= 2) { video_ok &= std::llabs(vm) <= STEP_NS; audio_ok &= std::llabs(am - 1'700'000'000LL) <= STEP_NS; }
        }
        CHECK("timing PID: the anchor is re-based onto the PCR carrier (video) once it is known",
              reanchors == 1 && rebase_pid == 0x100 && rebase_delta == 0);
        CHECK("timing PID: the video stays stamped on its arrival for the whole run (no repair/tier flip)", video_ok);
        CHECK("timing PID: the audio rides the same anchor, 1.7 s early, untouched", audio_ok);
    }
    {
        // A stall, a real gap and reorder jitter leave the bytes untouched; a
        // source restart is past the bound and re-anchors as before.
        int quiet = 0; bool untouched = true;
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        st.set_on_conditioned([&](const TimelineStamper::Conditioned&) { quiet++; });
        const int64_t jit[4] = {0, 7200, -3600, 3600};
        for (int i = 0; i < 400; i++) {
            int64_t h = HOUSE + i * STEP_NS + (i >= 100 ? 1'500'000'000LL : 0) + (i >= 200 ? 3'000'000'000LL : 0);
            int64_t pts = FIRST_PES + i * STEP + (i >= 200 ? 3 * 90000 : 0) + jit[i % 4];
            auto data = bytes_of({pes_packet(0x100, pts)});
            st.condition(data.data(), data.size(), h);
            untouched &= read_pes_pts(data.data()) == (pts & (PTS_WRAP - 1));
        }
        CHECK("a stall, a real gap and reorder jitter are never conditioned (bytes untouched)", quiet == 0 && untouched);
        int rc = 0, rr = 0;
        TimelineStamper rs(nullptr, [&](const TimelineStamper::Reanchor&) { rr++; }, nullptr, true);
        rs.set_on_conditioned([&](const TimelineStamper::Conditioned&) { rc++; });
        for (int i = 0; i < 400; i++) {
            int64_t pts = (FIRST_PES + i * STEP - (i >= 200 ? 2LL * 3600 * 90000 : 0)) & (PTS_WRAP - 1);
            auto data = bytes_of({pes_packet(0x100, pts)});
            rs.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            rs.stamp(data.data(), data.size(), HOUSE + i * STEP_NS, 0);
        }
        CHECK("a source restart is past the conditioner's bound and re-anchors as before", rc == 0 && rr == 1);
    }

    // --- the late tier re-anchors on the PES it stamped FROM (.103, 2026-09-08 13:02-13:15) ---
    // ts_timeline_test.py parity. An audio PES ahead of the video's in every
    // buffer, written 2 s ahead of it; the PCR rides the video, so the video is
    // the timing PID. From buffer 20 every buffer arrives 300 ms late (a level).
    // The tier must re-anchor once, referenced on the VIDEO's own PES, and leave
    // the video on its arrival — not the written A/V skew behind it, which
    // matured the hold again 10 s later, and again: one re-anchor every 10 s
    // with the level growing to -3 s, one dropped bus buffer each, live.
    {
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        constexpr int64_t SKEW = 2 * 90000;
        constexpr int64_t LATE_LEVEL = 300'000'000LL;
        constexpr int LATE_AT = 20;
        constexpr int LATE_HOLD_BUFS = 10'000'000'000LL / STEP_NS;   // 250
        auto late_house = [&](int i) {
            return HOUSE + i * STEP_NS + (i >= LATE_AT ? LATE_LEVEL : 0);
        };
        std::vector<TimelineStamper::Reanchor> re;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) { re.push_back(r); }, nullptr, true);
        std::vector<int64_t> vm;
        for (int i = 0; i < 800; i++) {
            const int64_t v = FIRST_PES + i * STEP;
            auto data = bytes_of({pes_packet(0x140, v + SKEW), pcr_pkt(0x100, (v - 9000) * 300),
                                  pes_packet(0x100, v)});
            st.condition(data.data(), data.size(), late_house(i));
            vm.push_back(st.stamp(data.data(), data.size(), late_house(i), 0) - late_house(i));
        }
        size_t tier = 0;
        for (const auto& r : re) if (r.delta_ticks != 0) tier++;
        CHECK("audio ahead of the timing PID in the buffer: the anchor is re-based onto the video first",
              !re.empty() && re[0].pid == 0x100 && re[0].delta_ticks == 0);
        CHECK("... the late level then re-anchors exactly once", tier == 1 && re.size() == 2);
        CHECK("... referenced on the timing PID's own PES, not the buffer's first",
              re.size() == 2 && re.back().pid == 0x100
              && re.back().pts == FIRST_PES + (LATE_AT + LATE_HOLD_BUFS) * STEP);
        bool after = true;
        for (int i = LATE_AT + LATE_HOLD_BUFS; i < 800; i++) after &= std::llabs(vm[i]) <= STEP_NS;
        CHECK("... and from it the video leaves on its arrival for the rest of the run (no 10 s cycle)", after);
    }

    // --- a foreign-timeline metadata PID never moves the shared anchor (.103, 2026-09-08 13:27) ---
    // ts_timeline_test.py parity. The PCR rides the video (0x100), so the video
    // is the timing PID. A sparse KLV-style PID (0x1f0) carries its own clock
    // ~24 h off the media and steps around on it. It must NEVER trip the watch:
    // re-anchoring the egress onto it blanks every consumer (live: +77 s jumps
    // on every reconnect). The video's own -1 s rewind still re-anchors.
    {
        auto pcr_pkt = [](int pid, int64_t pcr27) {
            TsPacket t; std::memset(t.b, 0xFF, PKT);
            t.b[0] = SYNC_BYTE; t.b[1] = (pid >> 8) & 0x1F; t.b[2] = pid & 0xFF; t.b[3] = 0x20;
            t.b[4] = 183; t.b[5] = 0x10;
            int64_t base = pcr27 / 300; int ext = (int)(pcr27 % 300);
            t.b[6] = (uint8_t)(base >> 25); t.b[7] = (uint8_t)(base >> 17); t.b[8] = (uint8_t)(base >> 9);
            t.b[9] = (uint8_t)(base >> 1); t.b[10] = (uint8_t)(((base & 1) << 7) | 0x7E | ((ext >> 8) & 1));
            t.b[11] = (uint8_t)(ext & 0xFF);
            return t;
        };
        constexpr int64_t META = 7'900'000'000LL;   // ~24 h off, its own timeline
        std::vector<TimelineStamper::Reanchor> re;
        TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& r) { re.push_back(r); }, nullptr, true);
        for (int i = 0; i < 200; i++) {
            const int64_t v = FIRST_PES + i * STEP;
            // The metadata PID jumps around wildly on its own clock every buffer.
            const int64_t m = META + (int64_t)((i * 37) % 500) * 90000;
            auto data = bytes_of({pcr_pkt(0x100, (v - 9000) * 300), pes_packet(0x100, v),
                                  pes_packet(0x1f0, m)});
            st.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            st.stamp(data.data(), data.size(), HOUSE + i * STEP_NS, 0);
        }
        bool meta_drove = false;
        for (const auto& r : re) if (r.pid == 0x1f0) meta_drove = true;
        CHECK("a foreign-timeline metadata PID never re-anchors the shared egress", !meta_drove);
        // The timing PID's own RESTART (past the conditioner's 10 s bound, so
        // the watch — not the conditioner — owns it) still re-anchors, with the
        // metadata PID present the whole time.
        std::vector<TimelineStamper::Reanchor> re2;
        TimelineStamper st2(nullptr, [&](const TimelineStamper::Reanchor& r) { re2.push_back(r); }, nullptr, true);
        for (int i = 0; i < 60; i++) {
            const int64_t v = (FIRST_PES + i * STEP - (i >= 30 ? 30LL * 90000 : 0)) & (PTS_WRAP - 1);
            auto data = bytes_of({pcr_pkt(0x100, (v - 9000) * 300), pes_packet(0x100, v),
                                  pes_packet(0x1f0, META)});
            st2.condition(data.data(), data.size(), HOUSE + i * STEP_NS);
            st2.stamp(data.data(), data.size(), HOUSE + i * STEP_NS, 0);
        }
        bool video_reanchored = false;
        for (const auto& r : re2) if (r.pid == 0x100) video_reanchored = true;
        CHECK("the timing PID's own restart still re-anchors, with a metadata PID present", video_reanchored);
    }

    // --- the conditioner rounds negative steps with FLOOR division (ts_timeline_test.py parity) ---
    // A backward PTS step whose ns->tick conversion does NOT divide evenly: floor
    // and C++ truncate-toward-zero differ by one tick. The wire must be byte-for-byte
    // identical to python, so the reported step, the offset and the rewritten PTS are
    // the FLOOR result. A plain `/` at ts_timeline.cpp:671 reports -89999 and writes
    // 8128800 (the .103 conditioner) and this fails.
    {
        std::vector<TimelineStamper::Conditioned> cr;
        TimelineStamper st(nullptr, nullptr, nullptr, true);
        st.set_on_conditioned([&](const TimelineStamper::Conditioned& c) { cr.push_back(c); });
        for (int i = 0; i < 8; i++) {                 // fill the cadence memory with 40 ms deltas
            auto d = bytes_of({pes_packet(0x100, FIRST_PES + i * STEP)});
            st.condition(d.data(), d.size(), HOUSE + i * STEP_NS);
        }
        auto d = bytes_of({pes_packet(0x100, FIRST_PES + 8 * STEP - 89999)});   // ~1 s back, non-even
        st.condition(d.data(), d.size(), HOUSE + 8 * STEP_NS);
        CHECK("a non-even backward step is conditioned with floor division (reported step)",
              cr.size() == 1 && cr[0].step_ticks == -90000);
        CHECK("... the cumulative offset is the floored step negated",
              cr.size() == 1 && cr[0].offset_ticks == 90000);
        CHECK("... and the rewritten PTS carries the floored offset (byte parity with python)",
              read_pes_pts(d.data()) == 8128801);
    }

    return test_summary("ts_timeline");
}
