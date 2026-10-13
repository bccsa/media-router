// ts_house: the units, the 1 h formula and its inverse, the 33-bit wrap, the
// per-stream unwrap and the bus <-> network boundary (WI-S0-1). Hard-coded
// integers were computed with python's big ints (py/ts_timeline.py semantics).
#include <cstdint>
#include <initializer_list>

#include "../ts_house.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t STEP = 3600;                    // 40 ms in 90 kHz ticks
constexpr int64_t STEP_NS = 40'000'000;
constexpr int64_t MUX = MUX_CLOCK_BASE_90K;
constexpr int64_t E_TAI = 1760283215123456789LL;  // E of a 2026 boot, TAI offset applied

int64_t mod33(int64_t v) { return ((v % PTS_WRAP) + PTS_WRAP) % PTS_WRAP; }

}  // namespace

int main() {
    // --- constants -----------------------------------------------------------
    CHECK("the PCR is the 90 kHz base times 300",
          PCR_HZ == 300 * 90000 && PCR_MODULO == 300 * PTS_WRAP);
    CHECK("PCR interval bound is 40 ms", PCR_MAX_INTERVAL_NS == 40'000'000);
    CHECK("the mux base is one hour", pts90k_to_ns(MUX) == 3'600'000'000'000LL);

    // --- units: floor everywhere, as python's // -----------------------------
    CHECK("90k->ns one second", pts90k_to_ns(90000) == 1'000'000'000);
    CHECK("90k->ns one tick floors", pts90k_to_ns(1) == 11111);
    CHECK("90k->ns floors a negative like python //", pts90k_to_ns(-1) == -11112);
    CHECK("ns->90k one second", ns_to_pts90k(1'000'000'000) == 90000);
    CHECK("ns->90k floors both ways",
          ns_to_pts90k(11111) == 0 && ns_to_pts90k(11112) == 1 && ns_to_pts90k(-1) == -1);
    CHECK("ns->27M one second", ns_to_pcr27(1'000'000'000) == 27'000'000);
    CHECK("27M->ns floors", pcr27_to_ns(1) == 37 && pcr27_to_ns(27'000'000) == 1'000'000'000);
    CHECK("ns->27M wraps at 300 * 2^33", ns_to_pcr27(100'000'000'000'000LL) == 123'019'622'400LL);
    CHECK("ns->27M folds a negative into [0, PCR_MODULO)", ns_to_pcr27(-1) == PCR_MODULO - 1);
    CHECK("ns->90k on TAI-scale ns, no overflow", ns_to_pts90k(E_TAI) == 158425489361111LL);
    CHECK("90k->ns on TAI-scale ticks, no overflow",
          pts90k_to_ns(158425489361111LL) == 1760283215123455555LL);
    {
        // ns -> 90k -> ns lands at most one tick below ("inverse within 11.1 us"),
        // exactly on the 100 us grid; 90k -> ns -> 90k is exact on the 9-tick grid.
        bool within = true, grid = true;
        for (int64_t h = -3'000'000; h <= 3'000'000; h += 7919) {
            for (int64_t base : {(int64_t)0, E_TAI}) {
                const int64_t back = pts90k_to_ns(ns_to_pts90k(base + h));
                within &= base + h - back >= 0 && base + h - back < 11112;
            }
        }
        for (int64_t k = -50; k <= 50; k++) {
            grid &= pts90k_to_ns(ns_to_pts90k(k * 100000)) == k * 100000;
            grid &= ns_to_pts90k(pts90k_to_ns(9 * k)) == 9 * k;
            grid &= ns_to_pcr27(pcr27_to_ns(27 * (k + 50))) == 27 * (k + 50);
        }
        CHECK("ns -> 90k -> ns is within one tick, never above", within);
        CHECK("the round trips are exact on their grids", grid);
    }

    // --- fold33 and unwrap_near ----------------------------------------------
    CHECK("fold33 passes small deltas through", fold33(5) == 5 && fold33(-5) == -5);
    CHECK("fold33 folds across the wrap", fold33(PTS_WRAP - 5) == -5 && fold33(5 - PTS_WRAP) == 5);
    CHECK("fold33 keeps half a period positive",
          fold33(PTS_WRAP / 2) == PTS_WRAP / 2 && fold33(PTS_WRAP / 2 + 1) == 1 - PTS_WRAP / 2);
    CHECK("fold33 ignores whole periods", fold33(3 * PTS_WRAP + 7) == 7 && fold33(-3 * PTS_WRAP - 7) == -7);
    CHECK("unwrap_near identity", unwrap_near(900000, 900900) == 900000);
    CHECK("unwrap_near forward across the wrap", unwrap_near(4500, PTS_WRAP - 9000) == PTS_WRAP + 4500);
    CHECK("unwrap_near back across the wrap", unwrap_near(PTS_WRAP - 9000, 4500) == -9000);
    CHECK("unwrap_near onto an unwrapped reference",
          unwrap_near(4500, 5 * PTS_WRAP + 100) == 5 * PTS_WRAP + 4500);

    // --- the bus formula (moved from ts_timeline_test) -----------------------
    {
        const int64_t H = 10'000'000'000LL;           // 10 s of house time
        CHECK("house_from_mux_pts inverts the mux's 1 h offset exactly",
              house_from_mux_pts(MUX + 900000, H) == H);
        CHECK("... to the 2^33 period nearest the house clock",
              house_from_mux_pts((MUX + 900000 + 3 * PTS_WRAP) % PTS_WRAP,
                                 3 * PTS_WRAP * 100000 / 9 + H)
              == pts90k_to_ns(3 * PTS_WRAP + 900000));
        CHECK("mux_pts_from_house adds exactly 1 h",
              mux_pts_from_house(0) == MUX && mux_pts_from_house(H) == MUX + 900000);
        // A negative clock at the half-period tie: python floors it to -1 tick,
        // C's truncation would read 0 and pick the other period.
        CHECK("a negative house clock floors like python",
              house_from_mux_pts(4618967295LL, -1) == -47721858855556LL);
    }
    {
        // T: the house tick at which the bus PTS (house + 1 h) wraps to 0.
        const int64_t T = PTS_WRAP - MUX;
        CHECK("wrap: content before the bus wrap, clock after it",
              house_from_mux_pts(PTS_WRAP - 900, pts90k_to_ns(T + 900)) == pts90k_to_ns(T - 900));
        CHECK("wrap: content after the bus wrap, clock before it",
              house_from_mux_pts(900, pts90k_to_ns(T - 900)) == pts90k_to_ns(T + 900));
        const int64_t h0 = pts90k_to_ns(T) / 100000 * 100000 - 5 * STEP_NS;   // 100 us grid
        const int64_t H12 = 12 * 3'600'000'000'000LL;
        int wraps = 0;
        bool exact = true, in_range = true;
        int64_t prev = -1;
        for (int i = 0; i < 10; i++) {
            const int64_t h = h0 + i * STEP_NS, m = mux_pts_from_house(h);
            if (prev >= 0 && m < prev) wraps++;
            in_range &= m >= 0 && m < PTS_WRAP;
            // Valid while |lateness| < 13 h: a clock 12 h off still finds the period.
            exact &= house_from_mux_pts(m, h) == h && house_from_mux_pts(m, h + H12) == h &&
                     house_from_mux_pts(m, h - H12) == h;
            prev = m;
        }
        CHECK("mux_pts_from_house wraps at 2^33 exactly once across the boundary",
              wraps == 1 && in_range);
        CHECK("... and house_from_mux_pts gives every house time back exactly", exact);
        bool near = true;
        for (int64_t h = h0; h < h0 + 400 * STEP_NS; h += 1'234'567) {
            const int64_t back = house_from_mux_pts(mux_pts_from_house(h), h);
            near &= h - back >= 0 && h - back < 11112;
        }
        CHECK("off the grid the inverse is within one tick, never above", near);
    }

    // --- Unwrapper -----------------------------------------------------------
    {
        Unwrapper u;
        CHECK("a fresh unwrapper is not primed", !u.primed());
        CHECK("the first value lands nearest the seed",
              u.feed(4500, 5 * PTS_WRAP - 100) == 5 * PTS_WRAP + 4500 && u.primed());
        CHECK("later values follow the previous one, not the seed",
              u.feed(4500 + STEP, 0) == 5 * PTS_WRAP + 4500 + STEP);
        u.reset();
        CHECK("reset re-seeds", !u.primed() && u.feed(4500, 0) == 4500);
    }
    {
        Unwrapper u;
        bool cont = true;
        for (int i = 0; i < 20; i++) {
            const int64_t want = PTS_WRAP - 10 * STEP + i * STEP;
            cont &= u.feed(want % PTS_WRAP, PTS_WRAP - 10 * STEP) == want;
        }
        CHECK("PTS unwraps continuously through 2^33", cont);
    }
    {
        // The a1 fault (design §6): B-frame DTS two frames behind its PTS while
        // the 33-bit field wraps, so for two PES the DTS sits before the wrap
        // and the PTS after it. Three periods in, so a raw DTS is wrong too.
        Unwrapper u;
        const int64_t first = 4 * PTS_WRAP - 3 * STEP;
        bool ok = true;
        int straddles = 0;
        for (int i = 0; i < 10; i++) {
            const int64_t pts = first + i * STEP, dts = pts - 2 * STEP;
            const int64_t pts33 = mod33(pts), dts33 = mod33(dts);
            if (dts33 > pts33) straddles++;
            const int64_t pu = u.feed(pts33, first);
            ok &= pu == pts && u.feed_dts(dts33, pu) == dts;
        }
        CHECK("a1: DTS < PTS across the wrap unwraps beside its own PTS", ok && straddles == 2);
        CHECK("a1: nothing discarded", u.dts_discarded() == 0);
    }
    {
        // The fault itself: the first PES straddles the wrap and the seed sits
        // 13 h off, nearer the PTS's period than the DTS's.
        Unwrapper u;
        const int64_t seed = 5 * PTS_WRAP + 1800 + PTS_WRAP / 2 - 1000;
        const int64_t pu = u.feed(1800, seed);
        CHECK("a1: the PTS lands nearest the seed", pu == 5 * PTS_WRAP + 1800);
        CHECK("a1: a DTS unwrapped on its own would land a whole period late",
              unwrap_near(PTS_WRAP - 1800, seed) == 6 * PTS_WRAP - 1800);
        CHECK("a1: feed_dts keeps it 3600 ticks before its PTS",
              u.feed_dts(PTS_WRAP - 1800, pu) == 5 * PTS_WRAP - 1800);
        Unwrapper fresh;
        CHECK("feed_dts unwraps against the PTS it is given, not the stream's state",
              fresh.feed_dts(PTS_WRAP - 1800, pu) == 5 * PTS_WRAP - 1800);
    }
    {
        Unwrapper u;
        const int64_t pu = u.feed(1'000'000, 0);
        CHECK("a DTS exactly 5 s before its PTS is kept",
              u.feed_dts(1'000'000 - 450000, pu) == 1'000'000 - 450000 && u.dts_discarded() == 0);
        CHECK("a DTS more than 5 s off either way is discarded and counted",
              u.feed_dts(1'000'000 - 450001, pu) == Unwrapper::NO_DTS &&
                  u.feed_dts(1'000'000 + 450001, pu) == Unwrapper::NO_DTS &&
                  u.dts_discarded() == 2);
        CHECK("an absent DTS is not a discard",
              u.feed_dts(-1, pu) == Unwrapper::NO_DTS && u.dts_discarded() == 2);
        u.reset();
        CHECK("the discard counter survives reset", u.dts_discarded() == 2);
    }

    // --- the network boundary ------------------------------------------------
    {
        const NetEpoch e0{0};
        CHECK("E = 0: bus_to_net takes the hour off",
              bus_to_net(MUX + 900000, e0) == 900000 && bus_to_net(900000, e0) == mod33(900000 - MUX));
        bool rt = true;
        for (int64_t p : {(int64_t)0, (int64_t)1, (int64_t)900000, MUX - 1, MUX, PTS_WRAP / 2,
                          PTS_WRAP - 1})
            rt &= net_to_bus(bus_to_net(p, e0), e0) == p && bus_to_net(net_to_bus(p, e0), e0) == p;
        CHECK("E = 0: round trip both ways", rt);
    }
    {
        const NetEpoch e{E_TAI};
        CHECK("e_90k floors a TAI-scale E without overflow", e.e_90k() == 158425489361111LL);
        bool rt = true;
        for (int64_t p = 0; p < PTS_WRAP; p += 123456789) {
            const int64_t n = bus_to_net(p, e);
            rt &= n >= 0 && n < PTS_WRAP && net_to_bus(n, e) == p && bus_to_net(net_to_bus(p, e), e) == p;
        }
        CHECK("E = boot + 37 s: every bus PTS round-trips", rt);
        // With E on the 100 us grid the wire is exactly (MONO + E) x 90 kHz mod 2^33.
        const NetEpoch eg{E_TAI / 100000 * 100000};
        bool wire = true;
        for (int64_t h = 0; h < 200'000'000'000'000LL; h += 7'777'777'777'777LL)
            wire &= bus_to_net(mux_pts_from_house(h), eg) == mod33(ns_to_pts90k(h + eg.e_ns));
        CHECK("the wire PTS is (MONO + E) x 90 kHz mod 2^33", wire);
    }
    {
        // An E whose network wrap falls inside a run of bus PTS: bus `base +
        // 5 * STEP` goes out as network 0. TAI-sized, and the smallest E (a
        // ceiling) that floors to that e_90k.
        const int64_t base = MUX + 900000;
        const int64_t e90 = 18443 * PTS_WRAP - (900000 + 5 * STEP);
        const NetEpoch ew{-pts90k_to_ns(-e90)};
        CHECK("E across a wrap: the epoch is as constructed",
              ew.e_ns == 1760268475136177778LL && ew.e_90k() == e90);
        bool cont = true, rt = true;
        int64_t prev = 0;
        for (int i = 0; i < 10; i++) {
            const int64_t bus = mod33(base + i * STEP), net = bus_to_net(bus, ew);
            if (i == 4) cont &= net == PTS_WRAP - STEP;
            if (i == 5) cont &= net == 0;
            if (i > 0) cont &= fold33(net - prev) == STEP;
            rt &= net_to_bus(net, ew) == bus;
            prev = net;
        }
        CHECK("E across a wrap: the network PTS wraps to 0 and stays continuous", cont);
        CHECK("E across a wrap: round trip", rt);
    }
    CHECK("net_pcr27 is H - D_e at 27 MHz", net_pcr27(1'500'000'000, 500'000'000) == 27'000'000);
    CHECK("net_pcr27 on a TAI-scale H, no overflow",
          net_pcr27(E_TAI, 500'000'000) == 397690756533LL);
    CHECK("the PCR base is the PTS of the same instant",
          net_pcr27(E_TAI, 500'000'000) / 300 == mod33(ns_to_pts90k(E_TAI - 500'000'000)));
    CHECK("net_pcr27 stays in [0, PCR_MODULO)", net_pcr27(0, 1) == PCR_MODULO - 1);

    return test_summary("ts_house");
}
