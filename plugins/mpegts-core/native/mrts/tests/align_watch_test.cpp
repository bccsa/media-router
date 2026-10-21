// ArrivalRhythm, PaceGroup, PaceRegistry and GapPlanner (plan ch. 6 WI-P2-6): W on synthetic
// rhythms, the pace's rules (seeds, rises only, recomputed on leave) and the gap stretches an
// absent input gets.
#include <cstdint>
#include <thread>
#include <vector>

#include "../align_watch.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t MS = 1000000;
constexpr int64_t S = 1000 * MS;

ArrivalRhythm::Config defaults() { return ArrivalRhythm::Config(); }

// --- W -----------------------------------------------------------------------------------

void test_rhythm_cbr() {
    ArrivalRhythm r;
    const ArrivalRhythm::Config c = defaults();
    CHECK("no arrival yet: W is the ceiling (2 s)", r.limit_ns(c) == 2 * S);
    for (int i = 0; i < 9; i++) r.arrive(i * 20 * MS);
    CHECK("9 arrivals of a 20 ms CBR: still the ceiling", r.limit_ns(c) == 2 * S);
    r.arrive(9 * 20 * MS);
    CHECK("the 10th arrival opens W: 3 x 20 ms = 60 ms, raised to the 100 ms floor",
          r.limit_ns(c) == 100 * MS);
    for (int i = 10; i < 400; i++) r.arrive(i * 20 * MS);
    CHECK("400 arrivals of 20 ms CBR: p95 20 ms, W 100 ms (floor)",
          r.p95_ns() == 20 * MS && r.limit_ns(c) == 100 * MS);
    CHECK("arrivals counted", r.arrivals() == 400 && r.last_ns() == 399 * 20 * MS);

    ArrivalRhythm f;
    for (int i = 0; i < 50; i++) f.arrive(i * 40 * MS);
    CHECK("40 ms CBR: 3 x 40 = 120 ms, above the floor", f.limit_ns(c) == 120 * MS);
    ArrivalRhythm::Config c2 = c;
    c2.factor = 4.0;
    CHECK("the factor scales W (4 x 40 ms)", f.limit_ns(c2) == 160 * MS);
    c2.floor_ns = 200 * MS;
    CHECK("the floor is a setting (200 ms)", f.limit_ns(c2) == 200 * MS);
}

void test_rhythm_bursts() {
    // A sender that delivers 7 or 8 buffers of 20 ms back to back every 150 ms (RIST, SRT).
    ArrivalRhythm r;
    int64_t t = 0;
    for (int burst = 0; burst < 60; burst++) {
        for (int k = 0; k < (burst % 2 ? 8 : 7); k++) r.arrive(t + k * 100000);   // 0.1 ms apart
        t += 150 * MS;
    }
    const int64_t w = r.limit_ns(defaults());
    CHECK("150 ms bursts: W about 450 ms (3 x the 150 ms gap that ends each burst)",
          w > 440 * MS && w < 460 * MS);
    CHECK("... p95 is the gap between bursts, not the 0.1 ms inside one",
          r.p95_ns() > 145 * MS && r.p95_ns() < 150 * MS);

    ArrivalRhythm slow;
    for (int i = 0; i < 20; i++) slow.arrive(i * S);
    CHECK("1 s gaps: 3 s capped at the 2 s ceiling", slow.limit_ns(defaults()) == 2 * S);
    ArrivalRhythm::Config c = defaults();
    c.floor_ns = 5 * S;   // a floor above the ceiling: the ceiling still bounds W
    CHECK("the ceiling bounds W even under a floor set above it", slow.limit_ns(c) == 2 * S);
}

void test_rhythm_window_and_rank() {
    // Nearest rank over 100 gaps: 94 small and 6 large puts a large one at rank 95.
    ArrivalRhythm a;
    int64_t t = 0;
    a.arrive(t);
    for (int i = 0; i < 100; i++) a.arrive(t += (i < 94 ? 10 : 100) * MS);
    CHECK("p95, 100 gaps with 6 of 100 ms: rank 95 is 100 ms", a.p95_ns() == 100 * MS);
    ArrivalRhythm b;
    t = 0;
    b.arrive(t);
    for (int i = 0; i < 100; i++) b.arrive(t += (i < 95 ? 10 : 100) * MS);
    CHECK("p95, 100 gaps with 5 of 100 ms: rank 95 is 10 ms", b.p95_ns() == 10 * MS);
    ArrivalRhythm c1;
    c1.arrive(0);
    c1.arrive(70 * MS);
    CHECK("one gap: p95 is it", c1.p95_ns() == 70 * MS);
    ArrivalRhythm d;
    t = 0;
    d.arrive(t);
    for (int i = 0; i < 10; i++) d.arrive(t += (i < 9 ? 10 : 100) * MS);
    CHECK("p95, 10 gaps with one of 100 ms: rank ceil(9.5) = 10 is it", d.p95_ns() == 100 * MS);

    // Only the gaps before the last 200 arrivals count.
    ArrivalRhythm r;
    t = 0;
    r.arrive(t);
    for (int i = 0; i < 200; i++) r.arrive(t += 500 * MS);
    CHECK("200 gaps of 500 ms: W 1.5 s", r.limit_ns(defaults()) == 1500 * MS);
    for (int i = 0; i < 199; i++) r.arrive(t += 20 * MS);
    CHECK("199 of 20 ms after them: one 500 ms gap of 200 is under p95, W at the floor",
          r.limit_ns(defaults()) == 100 * MS);
    ArrivalRhythm q;
    t = 0;
    q.arrive(t);
    for (int i = 0; i < 200; i++) q.arrive(t += 500 * MS);
    for (int i = 0; i < 189; i++) q.arrive(t += 20 * MS);
    CHECK("189 of 20 ms: 11 of 500 ms left of 200, p95 still 500 ms",
          q.limit_ns(defaults()) == 1500 * MS);
    q.arrive(t += 20 * MS);
    CHECK("the 190th pushes the 500 ms gaps to 10 of 200: p95 20 ms",
          q.limit_ns(defaults()) == 100 * MS);

    r.reset();
    CHECK("reset: back to the ceiling, no arrivals",
          r.arrivals() == 0 && r.limit_ns(defaults()) == 2 * S);
}

// --- the pace ------------------------------------------------------------------------------

void test_pace_rises_only() {
    PaceGroup g;
    g.join(1, -1);
    g.join(2, -1);
    CHECK("no seed, no lateness: pace 0", g.pace() == 0);
    for (int i = 0; i < 100; i++) {
        g.observe(1, i * 10 * MS, 200 * MS);
        g.observe(2, i * 10 * MS, 50 * MS);
    }
    CHECK("pace is the largest member mean (200 ms)", g.pace() == 200 * MS);
    int64_t l = 0;
    CHECK("a member's lateness is its mean", g.lateness(2, &l) && l == 50 * MS);
    for (int i = 100; i < 300; i++) g.observe(1, i * 10 * MS, 1500 * MS);
    CHECK("member 1 slows to 1.5 s: the pace follows", g.pace() == 1500 * MS);
    for (int i = 300; i < 600; i++) g.observe(1, i * 10 * MS, 100 * MS);
    CHECK("member 1 speeds up to 100 ms: the pace holds 1.5 s (rises only)",
          g.pace() == 1500 * MS);
    CHECK("... while member 1's own lateness reads 100 ms", g.lateness(1, &l) && l == 100 * MS);

    // The mean is over the second before each arrival: an old second ages out of it.
    PaceGroup h;
    h.join(1, -1);
    for (int i = 0; i < 300; i++) h.observe(1, i * 10 * MS, i < 100 ? 1000 * MS : 0);
    CHECK("a second 1 s late, then two on time: the pace holds 1 s",
          h.pace() == 1000 * MS && h.lateness(1, &l) && l == 0);
    PaceGroup w;
    w.join(1, -1);
    for (int i = 0; i < 150; i++) w.observe(1, i * 10 * MS, i < 100 ? 1000 * MS : 0);
    CHECK("half a second after a 1 s late second: the mean over 1 s is half of it",
          w.lateness(1, &l) && l == 500 * MS);

    // One sample, or a few within half a second, is no mean over a second.
    PaceGroup b;
    b.join(1, -1);
    b.observe(1, 0, 610 * MS);   // a start-up burst's first, latest packet
    for (int i = 1; i < 50; i++) b.observe(1, i * 10 * MS, 100 * MS);
    CHECK("the first 490 ms of arrivals do not set the pace (a burst's first sample is 610 ms)",
          b.pace() == 0 && b.lateness(1, &l) && l == 110200000);
    b.observe(1, 500 * MS, 100 * MS);
    CHECK("at half a second their mean counts (110 ms, not the first sample's 610)",
          b.pace() == 110 * MS);

    PaceGroup e;
    e.join(1, -1);
    for (int i = 0; i < 100; i++) e.observe(1, i * 10 * MS, -40 * MS);
    CHECK("an early member (lateness -40 ms) leaves the pace at 0", e.pace() == 0);
    e.raise(300 * MS);
    CHECK("raise (a late sparse cue): pace 300 ms", e.pace() == 300 * MS);
    e.raise(100 * MS);
    CHECK("a lower raise changes nothing", e.pace() == 300 * MS);

    PaceGroup x;
    x.join(1, -1);
    x.observe(1, 0, 10 * PaceGroup::LATENESS_LIMIT_NS);
    x.observe(1, 600 * MS, 10 * PaceGroup::LATENESS_LIMIT_NS);
    CHECK("a garbage lateness is clamped to 1 h", x.pace() == PaceGroup::LATENESS_LIMIT_NS);
}

void test_pace_leave() {
    PaceGroup g;
    g.join(1, -1);
    g.join(2, -1);
    g.join(3, -1);
    for (int i = 0; i < 100; i++) {
        g.observe(1, i * 10 * MS, 1500 * MS);
        g.observe(2, i * 10 * MS, 300 * MS);
        g.observe(3, i * 10 * MS, 100 * MS);
    }
    CHECK("three members: pace 1.5 s", g.pace() == 1500 * MS);
    g.leave(1);
    CHECK("the 1.5 s member leaves: recomputed from the others, 300 ms",
          g.pace() == 300 * MS && g.size() == 2);
    g.leave(7);
    CHECK("leaving twice, or a stranger, changes nothing", g.pace() == 300 * MS);

    // An absent member keeps its last need through another member's leave.
    for (int i = 0; i < 300; i++) g.observe(3, 1000 * MS + i * 10 * MS, 100 * MS);
    CHECK("member 2 silent for 3 s: the pace holds 300 ms", g.pace() == 300 * MS);
    PaceGroup::Member m4 = 4;
    g.join(m4, -1);
    g.leave(m4);
    CHECK("another member leaves: member 2's held 300 ms still counts", g.pace() == 300 * MS);
    g.leave(2);
    CHECK("member 2 leaves: 100 ms", g.pace() == 100 * MS);
    g.leave(3);
    CHECK("the last leaves: 0", g.pace() == 0 && g.size() == 0);

    PaceGroup s;
    s.join(1, -1);
    s.join(2, -1);
    for (int i = 0; i < 100; i++) s.observe(1, i * 10 * MS, 100 * MS);
    for (int i = 0; i < 30; i++) s.observe(2, i * 10 * MS, 2000 * MS);
    s.leave(1);
    CHECK("a recompute takes no mean that never counted (300 ms of arrivals): 0",
          s.pace() == 0);
}

void test_pace_seeds() {
    PaceGroup g;
    g.join(1, 800 * MS);
    CHECK("a seed sets the pace at join, before any arrival", g.pace() == 800 * MS);
    g.join(2, 200 * MS);
    CHECK("a lower seed changes nothing", g.pace() == 800 * MS);
    for (int i = 0; i < 100; i++) {
        g.observe(1, i * 10 * MS, 300 * MS);
        g.observe(2, i * 10 * MS, 300 * MS);
    }
    CHECK("members faster than the seed: the seed holds (800 ms)", g.pace() == 800 * MS);
    g.leave(1);
    CHECK("the seeded member leaves: its seed goes with it (300 ms measured)",
          g.pace() == 300 * MS);
    g.join(3, 0);
    CHECK("a zero seed is a seed of 0, not none", g.pace() == 300 * MS);
    PaceGroup h;
    h.join(1, 0);
    h.join(2, 600 * MS);
    h.leave(2);
    CHECK("recompute from a zero seed alone: 0", h.pace() == 0);
    PaceGroup k;
    k.join(1, 600 * MS);
    k.join(2, -1);
    for (int i = 0; i < 100; i++) {
        k.observe(1, i * 10 * MS, 50 * MS);
        k.observe(2, i * 10 * MS, 900 * MS);
    }
    CHECK("a 900 ms member over a 600 ms seed: 900 ms", k.pace() == 900 * MS);
    k.leave(2);
    CHECK("it leaves: the seed of the one that stays holds the pace (600 ms)",
          k.pace() == 600 * MS);
}

// --- the registry --------------------------------------------------------------------------

void test_registry() {
    PaceRegistry r;
    PaceRegistry::Membership a = r.join("pipe1/mux", 400 * MS);
    PaceRegistry::Membership b = r.join("pipe1/mux", -1);
    PaceRegistry::Membership c = r.join("pipe2/mux", -1);
    CHECK("two keys, two groups", r.groups() == 2 && a.member && b.member && c.member
                                      && a.member != b.member);
    CHECK("members of one key share the seed's pace",
          r.view(b).pace_ns == 400 * MS && r.view(a).members == 2);
    CHECK("another pipeline's group is apart", r.view(c).pace_ns == 0);
    r.observe(c, 0, 900 * MS);
    r.observe(c, 600 * MS, 900 * MS);
    CHECK("its lateness stays in its group",
          r.view(c).pace_ns == 900 * MS && r.view(a).pace_ns == 400 * MS);
    r.raise(a, 500 * MS);
    PaceRegistry::View v = r.view(b);
    CHECK("raise reaches the group", v.pace_ns == 500 * MS);
    CHECK("no lateness before an arrival", !v.has_lateness);
    r.leave(&a);
    CHECK("leave clears the membership", a.member == 0 && r.view(b).members == 1);
    r.leave(&a);
    CHECK("a second leave is a no-op", r.view(b).members == 1);
    r.leave(&b);
    r.leave(&c);
    CHECK("a group goes with its last member", r.groups() == 0);
    PaceRegistry::Membership none;
    CHECK("an unjoined membership reads nothing", r.view(none).members == 0);

    // Members on several threads, as every aligner's chain and task are.
    PaceRegistry t;
    std::vector<std::thread> th;
    for (int k = 0; k < 4; k++) {
        th.emplace_back([&t, k] {
            PaceRegistry::Membership m = t.join("p/agg", -1);
            for (int i = 0; i < 2000; i++) {
                t.observe(m, i * MS, (k + 1) * 100 * MS);
                t.view(m);
            }
        });
    }
    for (std::thread& x : th) x.join();
    PaceRegistry::Membership last = t.join("p/agg", -1);
    CHECK("four threads: the group took the slowest (400 ms)",
          t.view(last).pace_ns == 400 * MS && t.view(last).members == 5);
}

// --- gaps ----------------------------------------------------------------------------------

void test_gaps() {
    GapPlanner p;
    GapPlanner::Gap g{};
    CHECK("no horizon: nothing is stale", !p.stale(0, 10 * MS));
    CHECK("no horizon yet: only a zero-length gap at now - pace",
          p.take(10 * S, 1500 * MS, nullptr, &g) && g.start_ns == 8500 * MS
              && g.end_ns == 8500 * MS && p.horizon_ns() == 8500 * MS);
    CHECK("the next tick: [horizon, now - pace)",
          p.take(10 * S + 20 * MS, 1500 * MS, nullptr, &g) && g.start_ns == 8500 * MS
              && g.end_ns == 8520 * MS);
    CHECK("a tick with no time passed: nothing", !p.take(10 * S + 20 * MS, 1500 * MS, nullptr, &g));
    const int64_t next = 8530 * MS;
    CHECK("a gap never passes a queued item",
          p.take(10 * S + 100 * MS, 1500 * MS, &next, &g) && g.start_ns == 8520 * MS
              && g.end_ns == 8530 * MS);
    CHECK("... nor the tick after", !p.take(10 * S + 120 * MS, 1500 * MS, &next, &g));
    p.emitted(8540 * MS);
    CHECK("data out moves the horizon", p.horizon_ns() == 8540 * MS);
    p.emitted(8000 * MS);
    CHECK("an item that ends earlier (a late cue) never moves it back",
          p.horizon_ns() == 8540 * MS);
    CHECK("a raised pace stops the gaps: now - pace behind the horizon",
          !p.take(10 * S + 140 * MS, 2000 * MS, nullptr, &g));

    CHECK("stale: ends before the horizon", p.stale(8500 * MS, 8530 * MS));
    CHECK("stale: ends at the horizon with content before it", p.stale(8530 * MS, 8540 * MS));
    CHECK("not stale: a zero-length item at the horizon", !p.stale(8540 * MS, 8540 * MS));
    CHECK("not stale: straddles the horizon", !p.stale(8530 * MS, 8550 * MS));
    CHECK("not stale: after it", !p.stale(8540 * MS, 8560 * MS));

    GapPlanner early;
    CHECK("now - pace before running time 0: nothing to push", !early.take(MS, 50 * MS, nullptr, &g)
                                                                    && !early.has_horizon());
    p.reset();
    CHECK("reset: no horizon", !p.has_horizon() && !p.stale(0, MS));
}

}  // namespace

int main() {
    test_rhythm_cbr();
    test_rhythm_bursts();
    test_rhythm_window_and_rank();
    test_pace_rises_only();
    test_pace_leave();
    test_pace_seeds();
    test_registry();
    test_gaps();
    return test_summary("align_watch");
}
