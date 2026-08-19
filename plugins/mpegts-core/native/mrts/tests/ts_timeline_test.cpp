// Port of ts_timeline_test.py (the latch half) plus the egress stamper the
// native bus sidecars share — the C++ half of the time-sync contract's
// producer side. The stamper cases mirror gst_bus_stamper_test.py, which pins
// the same semantics for the runner's gst producers: one contract, three
// implementations, identical arithmetic.
#include <cstring>
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

    return test_summary("ts_timeline");
}
