// ts_trust: mrts::TrustGate (p5-6b, register B-226; plan ch. 9 part 4.8, WI-P5-6's acceptance) on
// synthetic sequences built here: a sender's PCR every 35 ms at a chosen transit, its PMT every
// 100 ms. Parity with py/trust_gate.py is trust_parity_test.py's; this suite pins the C++ API.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../ts_hcdesc.h"
#include "../ts_house.h"
#include "../ts_trust.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t MS = 1000000, S = 1000000000;
constexpr int64_t E = 1799999000 * S;     // the receiver's E
constexpr int64_t T0 = 1000 * S;          // arrival of the first PCR (house time)
constexpr int64_t DE90 = 18000;           // the sender's D_e, 200 ms
using St = TrustGate::State;
using Dec = TrustGate::Decision;

HouseTimeDecl good_decl() {
    HouseTimeDecl d;
    d.house_time_tai = d.disciplined = true;
    d.d_e_90k = DE90;
    d.clock_error_class = 10;
    d.timeline_id = 0x0123456789abcdefULL;
    d.epoch_seq = 7;
    return d;
}

ClockDecl good_clock() {
    ClockDecl c;
    c.e_ns = E;
    c.seq = 1;
    c.disciplined = true;
    c.error_us = 100;
    return c;
}

TrustConfig cfg_l(int64_t l_ns) {
    TrustConfig c;
    c.l_ns = l_ns;
    return c;
}

// The sender's PCR that arrives at `t` with `transit_ns` on the receiver's E.
int64_t pcr_at(int64_t t, int64_t transit_ns, int64_t e = E) {
    const int64_t base = ns_to_pts90k(t + e) - ns_to_pts90k(transit_ns) - DE90;
    return ((base % PTS_WRAP + PTS_WRAP) % PTS_WRAP) * 300 + 123;
}

// A run of PCRs every 35 ms and PMTs every 100 ms from `from` to `to`, transit by `tr(t)`;
// the gate steps after each. Returns the decisions other than none/hold with their times.
struct Sim {
    TrustGate g;
    HouseTimeDecl decl = good_decl();
    bool send_decl = true;
    int64_t e = E;
    std::vector<std::pair<int64_t, Dec>> seen;
    Sim(bool trust, int64_t l_ns = 2 * S, ClockDecl c = good_clock()) : g(1, cfg_l(l_ns), c, trust, T0) {}
    template <class F>
    void run(int64_t from, int64_t to, F tr) {
        for (int64_t t = from; t < to; t += 5 * MS) {
            g.on_input(t);
            if ((t - T0) % (100 * MS) == 0) g.on_pmt(send_decl ? &decl : nullptr, t);
            if ((t - T0) % (35 * MS) == 0) g.on_pcr(pcr_at(t, tr(t), e), t);
            const Dec d = g.step(t);
            if (d != Dec::none && d != Dec::hold) seen.push_back({t, d});
        }
    }
    void run(int64_t from, int64_t to, int64_t transit) {
        run(from, to, [&](int64_t) { return transit; });
    }
    // The last transition into `s`, or none: its time.
    int64_t when(Dec d) const {
        for (const auto& x : seen)
            if (x.second == d) return x.first;
        return -1;
    }
};

void test_crc() {
    CHECK("crc32_ieee: zlib's check value for \"123456789\" (0xCBF43926)",
          crc32_ieee(0, "123456789", 9) == 0xCBF43926u && crc32_ieee(crc32_ieee(0, "1234", 4), "56789", 5) == 0xCBF43926u);
    CHECK("names: states, decisions and mappings as the reference prints them",
          !std::strcmp(trust_state_name(St::converging), "converging") &&
              !std::strcmp(trust_decision_name(Dec::release_restamp), "release-restamp") &&
              !std::strcmp(trust_decision_name(Dec::switch_to_trust), "switch-to-trust") &&
              !std::strcmp(trust_mapping_name(TrustGate::Mapping::stc), "stc"));
}

void test_qualify() {
    Sim s(true);
    s.run(T0, T0 + 3 * S, 1900 * MS);
    const int64_t fifth = T0 + 4 * 35 * MS;
    CHECK("transit 1.9 s with L = 2 s: deciding releases to trust on the fifth good PCR",
          s.seen.size() == 1 && s.seen[0].second == Dec::release_trust && s.seen[0].first == fifth &&
              s.g.state() == St::trust && s.g.failed(T0 + 3 * S) == nullptr);
    const TrustGate::Stats st = s.g.stats(T0 + 3 * S);
    CHECK("stats: the transit's median 1.9 s, lo -(20 ms + 1.024 ms + 0.1 ms), hi L + tau, the declaration",
          st.have_transit && st.transit_median_ns == 1900 * MS && st.bound_lo_ns == pts90k_to_ns(-ns_to_pts90k(21124 * 1000)) &&
              st.bound_hi_ns == 2200 * MS && st.have_decl && st.decl.timeline_id == 0x0123456789abcdefULL &&
              st.decl.epoch_seq == 7 && st.trust_selected);
    TrustGate::Stats st2 = s.g.stats(T0 + 3 * S);
    CHECK("stats: the 64-sample ring keeps the last 64 PCRs", st2.transit_min_ns == st2.transit_max_ns);
}

void test_transit_high() {
    Sim s(true);
    std::vector<int64_t> bad;
    s.run(T0, T0 + 20 * S, [&](int64_t t) {
        const bool b = t >= T0 + 10 * S;
        if (b && (t - T0) % (35 * MS) == 0) bad.push_back(t);
        return b ? 2300 * MS : 1900 * MS;
    });
    const int64_t fb = s.when(Dec::switch_to_restamp);
    CHECK("2.3 s: falls back at exactly the third bad PCR, transit-high", fb == bad[2] && s.g.state() == St::fallback &&
                                                                           !std::strcmp(s.g.failed(fb), "transit-high"));
    Sim two(true);
    int n = 0;
    two.run(T0, T0 + 5 * S, [&](int64_t t) {
        if (t < T0 + 2 * S || (t - T0) % (35 * MS) != 0) return 1900 * MS;
        return ++n <= 2 ? 2300 * MS : 1900 * MS;
    });
    CHECK("two bad PCRs, then a good one: trust holds", two.g.state() == St::trust && two.when(Dec::switch_to_restamp) < 0);
}

const char* first_failed(Sim& s, int64_t transit) {
    s.run(T0, T0 + 2 * S, transit);
    return s.seen.empty() ? "" : s.g.failed(s.seen[0].first);
}

void test_failed_names() {
    {
        Sim s(true);
        CHECK("the sender's TAI offset unset (+37 s) -> transit-high", !std::strcmp(first_failed(s, 37 * S + 1900 * MS), "transit-high"));
    }
    {
        Sim s(true);
        CHECK("the receiver's TAI offset unset (-37 s) -> transit-negative",
              !std::strcmp(first_failed(s, -37 * S + 1900 * MS), "transit-negative"));
    }
    {
        Sim s(true);
        s.send_decl = false;
        s.run(T0, T0 + 2 * S, 1900 * MS);
        CHECK("no MRHT -> no-descriptor, deciding ends at 1 s -> fallback",
              s.seen.size() == 1 && s.seen[0].first == T0 + S && s.seen[0].second == Dec::release_restamp &&
                  !std::strcmp(s.g.failed(T0 + S), "no-descriptor") && s.g.state() == St::fallback);
    }
    {
        Sim s(true);
        s.decl.disciplined = false;
        CHECK("sender disciplined = 0 -> sender-undisciplined", !std::strcmp(first_failed(s, 1900 * MS), "sender-undisciplined"));
    }
    {
        Sim s(true);
        s.decl.house_time_tai = false;
        CHECK("house_time_tai = 0 -> not-house-time (no PCR judged)",
              !std::strcmp(first_failed(s, 1900 * MS), "not-house-time") && !s.g.stats(T0).have_transit);
    }
    {
        ClockDecl c = good_clock();
        c.e_ns = 0;
        Sim s(true, 2 * S, c);
        CHECK("local E unknown -> local-undisciplined", !std::strcmp(first_failed(s, 1900 * MS), "local-undisciplined"));
    }
    {
        ClockDecl c = good_clock();
        c.disciplined = false;
        Sim s(true, 2 * S, c);
        CHECK("local clock undisciplined -> local-undisciplined", !std::strcmp(first_failed(s, 1900 * MS), "local-undisciplined"));
    }
    {
        TrustGate g(1, cfg_l(2 * S), good_clock(), true, T0);
        HouseTimeDecl d = good_decl();
        g.on_pmt(&d, T0);
        CHECK("a declaration and both clocks but no PCR judged yet -> no-pcr", !std::strcmp(g.failed(T0), "no-pcr"));
        g.on_pmt(&d, T0);
        CHECK("a PMT older than 1 s -> no-descriptor", !std::strcmp(g.failed(T0 + S + 1), "no-descriptor"));
        g.on_natural_gap(3 * S, T0 + 2 * S);
        CHECK("a natural gap restarts the PMT's age", std::strcmp(g.failed(T0 + 2 * S), "no-descriptor") != 0);
    }
}

// B-226: a silence ages the PMT 40 ms at most, so one just under 1 s is no no-descriptor fallback.
void test_silence() {
    for (int64_t ms : {900, 950, 990, 1100}) {
        Sim s(true);
        s.run(T0, T0 + 2 * S, 1900 * MS);
        s.run(T0 + 2 * S + ms * MS, T0 + 4 * S, 1900 * MS);
        char name[96];
        std::snprintf(name, sizeof name, "a %lld ms silence after trust: still trust, no switch", (long long)ms);
        CHECK(name, s.g.state() == St::trust && s.when(Dec::switch_to_restamp) < 0 && s.g.stats(T0 + 4 * S).switches == 0);
    }
    for (int64_t gap : {10 * MS, 100 * MS}) {
        TrustGate g(1, cfg_l(2 * S), good_clock(), true, T0);
        HouseTimeDecl d = good_decl();
        g.on_input(T0);
        g.on_pmt(&d, T0);
        g.on_pcr(pcr_at(T0, 1900 * MS), T0);
        int64_t t = T0;
        while (!g.failed(t) && t < T0 + 10 * S) g.on_input(t += gap);
        CHECK(gap == 10 * MS ? "no PMT, inputs 10 ms apart: no-descriptor at 1 s"
                             : "no PMT, inputs 100 ms apart: 40 ms each, no-descriptor at 2.5 s",
              g.failed(t) && !std::strcmp(g.failed(t), "no-descriptor") &&
                  t - T0 - (gap == 10 * MS ? S : 2500 * MS) <= gap && t - T0 - (gap == 10 * MS ? S : 2500 * MS) > -gap);
    }
    TrustGate g(1, cfg_l(2 * S), good_clock(), true, T0);
    HouseTimeDecl d = good_decl();
    g.on_input(T0);
    g.on_pmt(&d, T0);
    g.on_pcr(pcr_at(T0, 1900 * MS), T0);
    CHECK("inside a silence the PMT's age stops at its first 40 ms",
          !g.failed(T0 + 990 * MS) && !g.failed(T0 + 5 * S) && g.stats(T0 + 5 * S).failed == nullptr);
    int64_t t = T0 + 5 * S;
    while (!g.failed(t) && t < T0 + 10 * S) g.on_input(t += 10 * MS);
    CHECK("inputs again from 5.01 s: the age runs on from its 40 ms, no-descriptor at 5.98 s", t == T0 + 5980 * MS);
}

void test_lo_bound() {
    {
        Sim s(true, 0);
        s.run(T0, T0 + 2 * S, -21 * MS);
        CHECK("lo: -21 ms inside -(20 ms + 2^10 us + 100 us) qualifies", s.g.state() == St::trust);
    }
    {
        Sim s(true, 0);
        s.run(T0, T0 + 2 * S, -22 * MS);
        CHECK("lo: -22 ms below it -> transit-negative", s.g.state() == St::fallback);
    }
    {
        Sim s(true, 0);
        s.decl.clock_error_class = 255;
        s.run(T0, T0 + 2 * S, -60 * MS);
        CHECK("lo: class 0xFF widens it by 50 ms (-60 ms qualifies)", s.g.state() == St::trust);
    }
    {
        ClockDecl c = good_clock();
        c.error_us = -1;
        Sim s(true, 0, c);
        s.decl.clock_error_class = 200;   // read as 31: 2147 s
        s.run(T0, T0 + 2 * S, -100 * S);
        CHECK("lo: a class above 31 reads as 31; an unknown local error 50 ms", s.g.state() == St::trust);
    }
}

void test_return_timing() {
    for (int with_gap = 0; with_gap < 2; with_gap++) {
        Sim s(true);
        s.run(T0, T0 + 20 * S, 1900 * MS);
        ClockDecl lost = good_clock();
        lost.disciplined = false;
        s.g.set_clock(lost, T0 + 20 * S);
        s.run(T0 + 20 * S, T0 + 21 * S, 1900 * MS);
        const bool at_once = s.when(Dec::switch_to_restamp) == T0 + 20 * S;
        s.g.set_clock(good_clock(), T0 + 21 * S);
        if (with_gap) {
            s.run(T0 + 21 * S, T0 + 33 * S, 1900 * MS);
            s.g.on_natural_gap(5 * MS, T0 + 33 * S);
            s.run(T0 + 33 * S, T0 + 40 * S, 1900 * MS);
            CHECK("the clock lost: fallback at once; 10 s qualified, then the return at a natural gap 12 s on",
                  at_once && s.when(Dec::switch_to_trust) == T0 + 33 * S && s.g.state() == St::trust);
        } else {
            s.run(T0 + 21 * S, T0 + 65 * S, 1900 * MS);
            // With no PES emitted the switch has no k: a gap of 0 into trust.
            CHECK("... or at once 40 s after qualifying again without one",
                  s.when(Dec::switch_to_trust) == T0 + 61 * S && s.g.state() == St::trust);
        }
    }
}

void test_operator() {
    Sim s(false);
    s.run(T0, T0 + 5 * S, 1900 * MS);
    CHECK("Restamp selected: the gate runs for display only", s.seen.empty() && s.g.state() == St::restamp &&
                                                                  s.g.failed(T0 + 5 * S) == nullptr);
    s.g.set_mode(true, T0 + 5 * S);
    CHECK("Trust selected mid-stream -> qualifying", s.g.state() == St::qualifying);
    s.run(T0 + 5 * S, T0 + 10 * S, 1900 * MS);
    s.g.on_natural_gap(5 * MS, T0 + 10 * S);
    s.run(T0 + 10 * S, T0 + 11 * S, 1900 * MS);
    CHECK("taken at a natural gap after 2 s qualified", s.when(Dec::switch_to_trust) == T0 + 10 * S);
    Sim w(false);
    w.run(T0, T0 + 5 * S, 1900 * MS);
    w.g.set_mode(true, T0 + 5 * S);
    w.run(T0 + 5 * S, T0 + 40 * S, 1900 * MS);
    CHECK("else at once 30 s after 2 s qualified", w.when(Dec::switch_to_trust) == T0 + 37 * S);
    w.g.set_mode(false, T0 + 40 * S);
    w.run(T0 + 40 * S, T0 + 45 * S, 1900 * MS);
    CHECK("Restamp selected from trust waits for a natural gap", w.g.state() == St::trust);
    w.g.on_natural_gap(5 * MS, T0 + 45 * S);
    w.run(T0 + 45 * S, T0 + 46 * S, 1900 * MS);
    CHECK("... and switches there -> restamp", w.when(Dec::switch_to_restamp) == T0 + 45 * S && w.g.state() == St::restamp);
    Sim d(true);
    d.g.set_mode(false, T0);
    CHECK("Restamp selected while deciding: released to restamp at once", d.g.state() == St::restamp &&
                                                                         d.g.take_log().back().decision == Dec::release_restamp);
}

void test_wrap() {
    // E so that the network time crosses 2^33 ticks 5 s in.
    const int64_t wrap_ns = pts90k_to_ns(((ns_to_pts90k(T0 + E) / PTS_WRAP) + 1) * PTS_WRAP);
    ClockDecl c = good_clock();
    c.e_ns = E + (wrap_ns - (T0 + 5 * S) - E);
    Sim s(true, 2 * S, c);
    s.e = c.e_ns;
    s.run(T0, T0 + 10 * S, 1900 * MS);
    const TrustGate::Stats st = s.g.stats(T0 + 10 * S);
    CHECK("the transit across the network's 2^33 wrap: 1.9 s on both sides, trust throughout",
          s.seen.size() == 1 && s.g.state() == St::trust && st.transit_min_ns == 1900 * MS && st.transit_max_ns == 1900 * MS);
}

// A program in trust that falls back for 1 s and returns with the STC 2.2 s ahead of Trust.
void test_converging() {
    Sim s(true);
    s.run(T0, T0 + 3 * S, 1900 * MS);
    const int64_t k90 = ns_to_pts90k(2200 * MS);
    int64_t x = 1000000;                  // the sender's PTS (network timeline)
    TrustGate::Mapped m = s.g.map(x, 0, -1);
    CHECK("trust maps net_to_bus exactly", m.kind == TrustGate::Mapping::trust && m.k90k == 0 &&
                                               m.pts == net_to_bus(x, NetEpoch{E}) && m.dts == -1);
    m = s.g.map(x, 3600, -1);
    CHECK("... and the DTS on its own", m.dts == net_to_bus(x + 3600, NetEpoch{E}));
    s.g.emitted(0x100, x, m, T0 + 3 * S);
    ClockDecl lost = good_clock();
    lost.disciplined = false;
    s.g.set_clock(lost, T0 + 3 * S);
    s.run(T0 + 3 * S, T0 + 4 * S, 1900 * MS);
    // Fallback: the STC maps the next PES 2.2 s later than Trust would.
    x += 1800;
    const int64_t stc = net_to_bus(x, NetEpoch{E}) + k90;
    m = s.g.map(x, 0, stc);
    CHECK("fallback maps by the STC value as given, no O or trim", m.kind == TrustGate::Mapping::stc && m.pts == stc);
    s.g.emitted(0x100, x, m, T0 + 4 * S);
    s.g.set_clock(good_clock(), T0 + 4 * S);
    s.run(T0 + 4 * S, T0 + 44 * S + 5 * MS, 1900 * MS);
    std::vector<TrustGate::Transition> log = s.g.take_log();
    const TrustGate::Transition& sw = log.back();
    CHECK("the return converges: k = the last PES's STC value - its Trust value (2.2 s)",
          sw.decision == Dec::switch_to_trust && sw.state == St::converging && sw.k90k == k90 && sw.has_k &&
              sw.k_ns == pts90k_to_ns(k90) && s.g.state() == St::converging);
    // k falls 1 tick per 200 ticks of content, on each PES's own PTS.
    bool ok = true;
    int64_t prev = stc;
    for (int i = 1; i <= 100; i++) {
        const int64_t xi = x + i * 1800;
        m = s.g.map(xi, 0, -1);
        ok = ok && m.kind == TrustGate::Mapping::converging && m.k90k == k90 - (int64_t)i * 1800 / 200 &&
             m.pts == (net_to_bus(xi, NetEpoch{E}) + m.k90k) % PTS_WRAP && m.pts > prev;
        prev = m.pts;
    }
    CHECK("converging: f(x) = net_to_bus(x) + k(x), k down 9 ticks per 20 ms PES, the output strictly rising", ok);
    m = s.g.map(x + 1800, 0, -1);
    s.g.emitted(0x100, x + 1800, m, T0 + 45 * S);
    s.g.on_natural_gap(500 * MS, T0 + 45 * S);
    s.g.step(T0 + 45 * S);
    log = s.g.take_log();
    CHECK("a 0.5 s natural gap takes 0.5 s off k", log.size() == 1 && log[0].state == St::converging &&
                                                       log[0].k90k == k90 - 9 - 45000 && s.g.k_at(x + 1800) == k90 - 9 - 45000);
    const int64_t end_x = x + 1800 + (k90 - 9 - 45000) * 200;
    m = s.g.map(end_x, 0, -1);
    CHECK("k reaches 0 after k x 200 ticks of content", m.k90k == 0 && s.g.map(end_x - 200, 0, -1).k90k == 1);
    s.g.emitted(0x100, end_x, m, T0 + 500 * S);
    log = s.g.take_log();
    CHECK("the first PES whose k is 0 ends converging -> trust", log.size() == 1 && log[0].state == St::trust &&
                                                                     s.g.state() == St::trust && s.g.stats(0).k_ns == 0);
}

void test_converging_exits() {
    for (int kind = 0; kind < 2; kind++) {
        Sim s(true);
        s.run(T0, T0 + 3 * S, 1900 * MS);
        TrustGate::Mapped m = s.g.map(5000, 0, -1);
        s.g.emitted(0x101, 5000, m, T0 + 3 * S);
        s.g.take_log();
        ClockDecl c = good_clock();
        c.e_ns = E + 300 * MS;   // a receiver re-epoch: the new mapping 300 ms earlier
        c.seq = 2;
        s.g.set_clock(c, T0 + 3 * S);
        std::vector<TrustGate::Transition> log = s.g.take_log();
        const bool conv = log.size() == 1 && log[0].decision == Dec::switch_to_trust && log[0].state == St::converging &&
                          log[0].k90k == 27000;
        if (kind == 0) {
            s.g.on_natural_gap(3 * S, T0 + 3 * S);
            s.g.step(T0 + 3 * S);
            log = s.g.take_log();
            CHECK("a receiver re-epoch of +300 ms converges (k 300 ms); a 3 s natural gap ends it at once",
                  conv && log.size() == 1 && log[0].state == St::trust && log[0].has_gap && log[0].gap_ns / MS == 2700);
        } else {
            ClockDecl lost = c;
            lost.disciplined = false;
            s.g.set_clock(lost, T0 + 4 * S);
            s.g.step(T0 + 4 * S);
            log = s.g.take_log();
            CHECK("a receiver re-epoch converging, then the clock lost: fallback at once",
                  conv && log.size() == 1 && log[0].decision == Dec::switch_to_restamp && log[0].state == St::fallback &&
                      s.g.stats(0).k_ns == 0);
        }
    }
    Sim s(true);
    s.run(T0, T0 + 3 * S, 1900 * MS);
    TrustGate::Mapped m = s.g.map(5000, 0, -1);
    s.g.emitted(0x101, 5000, m, T0 + 3 * S);
    s.g.take_log();
    ClockDecl c = good_clock();
    c.e_ns = E - 300 * MS;
    s.g.set_clock(c, T0 + 3 * S);
    std::vector<TrustGate::Transition> log = s.g.take_log();
    CHECK("a receiver re-epoch of -300 ms: switch-to-trust as a gap of 300 ms",
          log.size() == 1 && log[0].state == St::trust && log[0].has_gap && log[0].gap_ns / MS == 300);
    c.e_ns = 0;
    s.g.set_clock(c, T0 + 4 * S);
    CHECK("E going to 0 is no re-epoch (the next step disqualifies)", s.g.take_log().empty() &&
                                                                    s.g.step(T0 + 4 * S) == Dec::switch_to_restamp);
}

void test_give_up() {
    Sim s(true);
    s.g.on_pmt(&s.decl, T0);
    CHECK("give_up while deciding: release-restamp -> fallback (the restamp's 4 MB bound)",
          s.g.give_up(T0 + 10 * MS) == Dec::release_restamp && s.g.state() == St::fallback);
    CHECK("give_up otherwise: nothing", s.g.give_up(T0 + 20 * MS) == Dec::none && s.g.state() == St::fallback);
    TrustGate r(1, TrustConfig(), good_clock(), false, T0);
    const TrustGate::Mapped m = r.map(100, 3600, 5000);
    CHECK("restamp maps by the STC value given (O and trims are the caller's), DTS at its distance",
          m.kind == TrustGate::Mapping::restamp && m.pts == 5000 && m.dts == 8600);
    r.emitted(0x100, 100, m, T0);
    const TrustGate::Stats st = r.stats(T0);
    CHECK("stats count PES by mapping; the digest is of Trust-mapped PES only",
          st.pes[(int)TrustGate::Mapping::restamp] == 1 && st.digest == 0 && !st.trust_selected);
}

}  // namespace

int main() {
    test_crc();
    test_qualify();
    test_transit_high();
    test_failed_names();
    test_silence();
    test_lo_bound();
    test_return_timing();
    test_operator();
    test_wrap();
    test_converging();
    test_converging_exits();
    test_give_up();
    return test_summary("ts_trust");
}
