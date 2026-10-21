// ArrivalRhythm, PaceGroup, PaceRegistry and GapPlanner (plan ch. 6 WI-P2-6): W on synthetic
// rhythms, the pace's rules (seeds, rises only, recomputed on leave, a lateness over wall time
// that a backlog's drain does not move), a join into a running group and the gap stretches an
// absent input gets.
#include <algorithm>
#include <cmath>
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
    CHECK("pace is the largest member lateness (200 ms)", g.pace() == 200 * MS);
    int64_t l = 0;
    CHECK("a member's lateness is its own (50 ms)", g.lateness(2, &l) && l == 50 * MS);
    for (int i = 100; i < 300; i++) g.observe(1, i * 10 * MS, 1500 * MS);
    CHECK("member 1 slows to 1.5 s: the pace follows", g.pace() == 1500 * MS);
    for (int i = 300; i < 600; i++) g.observe(1, i * 10 * MS, 100 * MS);
    CHECK("member 1 speeds up to 100 ms: the pace holds 1.5 s (rises only)",
          g.pace() == 1500 * MS);
    CHECK("... while member 1's own lateness reads 100 ms", g.lateness(1, &l) && l == 100 * MS);

    // The lateness is over the second before each arrival: an old second ages out of it.
    PaceGroup h;
    h.join(1, -1);
    for (int i = 0; i < 300; i++) h.observe(1, i * 10 * MS, i < 100 ? 1000 * MS : 0);
    CHECK("a second 1 s late, then two on time: the pace holds 1 s",
          h.pace() == 1000 * MS && h.lateness(1, &l) && l == 0);
    // The 1 s -> 0 drop in 10 ms is a catch-up, left out; the median turns when more than half
    // the second is at the new lateness.
    PaceGroup w;
    w.join(1, -1);
    for (int i = 0; i < 150; i++) w.observe(1, i * 10 * MS, i < 100 ? 1000 * MS : 0);
    CHECK("0.49 s after a 1 s late second: 500 ms of it in the window, still 1 s",
          w.lateness(1, &l) && l == 1000 * MS);
    w.observe(1, 1500 * MS, 0);
    w.observe(1, 1510 * MS, 0);
    CHECK("0.51 s after it: 510 ms at 0 of 990, the median is 0", w.lateness(1, &l) && l == 0);

    // A few stretches within half a second are no lateness over a second.
    PaceGroup b;
    b.join(1, -1);
    b.observe(1, 0, 610 * MS);   // a start-up burst's first, latest packet
    for (int i = 1; i <= 49; i++) b.observe(1, i * 10 * MS, 100 * MS);
    CHECK("490 ms of stretches do not set the pace; the 610 ms drop is left out (100 ms)",
          b.pace() == 0 && b.lateness(1, &l) && l == 100 * MS);
    b.observe(1, 500 * MS, 100 * MS);
    CHECK("at half a second of stretches it counts: 100 ms, nothing of the 610",
          b.pace() == 100 * MS);

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
    CHECK("a recompute takes no lateness that never counted (300 ms of arrivals): 0",
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

// --- bursts: a median over wall time, a catch-up weighs nothing -----------------------------

void test_pace_bursts() {
    int64_t l = 0;
    // An upstream aligner's start backlog (B2, WI-P2-8): 2 s of 10 ms buffers drained in 60 ms
    // as the input's first data, lateness 2 s -> 70 ms, then 70 ms steady. The mean over the
    // arrivals of a second was about 840 ms, and the pace held it.
    PaceGroup a;
    a.join(1, -1);
    for (int n = 0; n < 200; n++) {
        const int64_t at = 2000 * MS + n * 300000;   // 0.3 ms apart
        a.observe(1, at, at - n * 10 * MS);
    }
    for (int n = 200; n < 350; n++) a.observe(1, n * 10 * MS + 70 * MS, 70 * MS);
    CHECK("a 2 s backlog drained in 60 ms, then 70 ms: the pace is 70 ms",
          a.pace() >= 69 * MS && a.pace() <= 71 * MS);
    CHECK("... and the member reads 70 ms", a.lateness(1, &l) && l >= 69 * MS && l <= 71 * MS);

    // A rejoin starts a run: no stretch reaches back across the absence (it would rise from
    // 20 to 300 ms over 2 s and pull the median to 160).
    PaceGroup f;
    f.join(1, -1);
    for (int i = 0; i < 100; i++) f.observe(1, i * 10 * MS, 20 * MS);
    for (int i = 0; i < 60; i++) f.observe(1, 3 * S + i * 10 * MS, 300 * MS, i == 0);
    CHECK("a rejoin at 300 ms after 20 ms: the member reads 300 ms, and so does the pace",
          f.lateness(1, &l) && l == 300 * MS && f.pace() == 300 * MS);

    // A stall of 70 ms, then its backlog at once, mid-run: 80 ms of stretches at 40 -> 110 ms,
    // the drain left out, 920 ms at 40 ms. A stall is not a slower input.
    PaceGroup s;
    s.join(1, -1);
    for (int n = 0; n < 50; n++) s.observe(1, n * 10 * MS + 40 * MS, 40 * MS);
    for (int n = 50; n < 58; n++) s.observe(1, 610 * MS, (57 - n) * 10 * MS + 40 * MS);
    for (int n = 58; n < 151; n++) s.observe(1, n * 10 * MS + 40 * MS, 40 * MS);
    CHECK("a 70 ms stall then its backlog: 40 ms, and the pace too",
          s.lateness(1, &l) && l == 40 * MS && s.pace() == 40 * MS);

    // A sender of 150 ms bursts (RIST, SRT): 20 ms buffers, each burst all the content done 10 ms
    // before it. Over wall time its lateness is the middle of its range, as the arrivals' mean.
    PaceGroup r;
    r.join(1, -1);
    int n = 0;
    double sum = 0;
    int cnt = 0;
    for (int j = 1; j <= 40; j++) {
        const int64_t w = j * 150 * MS;
        for (int k = 0; (n + 1) * 20 * MS <= w - 10 * MS; k++, n++) {
            const int64_t at = w + k * 100000, late = at - n * 20 * MS;
            r.observe(1, at, late);
            if (j > 30) sum += (double)late, cnt++;
        }
    }
    const double arrival_mean = sum / cnt;
    CHECK("150 ms bursts: the arrivals' mean within 10 ms (the middle of 31..170 ms)",
          r.lateness(1, &l) && std::abs((double)l - arrival_mean) <= 10.0 * MS
              && l > 80 * MS && l < 120 * MS);
}

// A delay of 0..2 x `jit` ms, the same on every platform.
struct Jitter {
    uint32_t x = 2463534242u;
    Jitter() = default;
    explicit Jitter(uint32_t seed) : x(seed) {}
    int64_t next(int jit) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        return jit ? (int64_t)(x % (uint32_t)(2 * jit * 1000 + 1)) * 1000 : 0;
    }
};

void test_pace_catch_ups() {
    // A 4 s backlog drained in 300 ms, then 50 ms: a third of the first half second was drain.
    PaceGroup a;
    a.join(1, -1);
    for (int n = 0; n < 400; n++) {
        const int64_t at = 4000 * MS + n * 750000;
        a.observe(1, at, at - n * 10 * MS);
    }
    for (int n = 400; n < 600; n++) a.observe(1, n * 10 * MS + 50 * MS, 50 * MS);
    CHECK("a 4 s backlog drained in 300 ms, then 50 ms: the pace is 50 ms", a.pace() == 50 * MS);

    // A slow catch-up: 2 s behind at the start, 1.5 x real time until 50 ms behind, arrivals
    // delayed 0..10 ms, so many stretches rise, at the draining level. Not taken until settled.
    PaceGroup s;
    s.join(1, -1);
    Jitter j;
    int64_t content = 0, prev = 0, behind = 2000 * MS, taken_behind = -1;
    for (int n = 0; n < 700; n++) {
        const int64_t at = std::max(prev, content + behind + j.next(5));
        prev = at;
        s.observe(1, at, at - content);
        if (taken_behind < 0 && s.pace() > 0) taken_behind = behind;
        content += 10 * MS;
        if (behind > 50 * MS) behind -= std::min<int64_t>(behind - 50 * MS, 10 * MS / 3);
    }
    CHECK("a 1.5 x catch-up from 2 s: the pace is taken only once it settled 50 ms behind",
          taken_behind == 50 * MS);
    CHECK("... at the 50 ms and its jitter", s.pace() > 50 * MS && s.pace() <= 60 * MS);

    // A 5 x catch-up with arrivals delayed 0..16 ms: a few of its stretches rise, at the
    // draining level, too few of the window to be taken (without that rule: 191 ms).
    PaceGroup v;
    v.join(1, -1);
    Jitter q{99};
    content = 0, prev = 0, behind = 2000 * MS;
    for (int n = 0; n < 1500; n++) {
        const int64_t at = std::max(prev, content + behind + q.next(8));
        prev = at;
        v.observe(1, at, at - content);
        content += 10 * MS;
        if (behind > 50 * MS) behind -= std::min<int64_t>(behind - 50 * MS, 8 * MS);
    }
    CHECK("a 5 x catch-up, delays up to 16 ms: the pace is the 50 ms and its jitter",
          v.pace() > 50 * MS && v.pace() <= 70 * MS);

    // A real slowdown is taken: 40 ms for a second, then 300 ms.
    PaceGroup u;
    u.join(1, -1);
    int64_t t = 0, when = -1;
    for (int k = 0; k < 100; k++, t += 10 * MS) u.observe(1, t, 40 * MS);
    for (int k = 0; k < 150; k++, t += 10 * MS) {
        u.observe(1, t, 300 * MS);
        if (when < 0 && u.pace() == 300 * MS) when = t - 1000 * MS;
    }
    CHECK("an input that slows from 40 to 300 ms: the pace follows within 0.6 s",
          when >= 0 && when <= 600 * MS);

    // Symmetric jitter (+-4 ms around 100 ms, arrivals in order) leaves the median at 100.
    PaceGroup e;
    e.join(1, -1);
    Jitter k;
    for (int n = 0; n < 300; n++) {
        const int64_t jj = k.next(4) - 4 * MS;
        e.observe(1, n * 10 * MS + jj, 100 * MS + jj);
    }
    CHECK("+-4 ms jitter around 100 ms: the pace within 1.5 ms of it",
          e.pace() >= 100 * MS - 1500000 && e.pace() <= 100 * MS + 1500000);
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

// A member that joins once the aggregator runs is late: its aligner gaps it while it waits.
void test_late_join() {
    PaceGroup g;
    g.join(1, -1);
    CHECK("a new group has not run", !g.started());
    g.start();
    CHECK("start: it runs, the pace untouched", g.started() && g.pace() == 0);

    PaceRegistry r;
    PaceRegistry::Membership a = r.join("p/mix", -1);
    PaceRegistry::Membership b = r.join("p/mix", -1);
    CHECK("members that join before anything was pushed are on time", !a.late && !b.late);
    r.start(a);
    PaceRegistry::Membership c = r.join("p/mix", 300 * MS);
    CHECK("once a member pushed, a joiner is late", c.late && !a.late && !b.late);
    CHECK("... and its seed still raises the pace at once", r.view(a).pace_ns == 300 * MS);
    CHECK("another aggregator's group has not run", !r.join("p/other", -1).late);
    r.leave(&a);
    PaceRegistry::Membership d = r.join("p/mix", -1);
    CHECK("the group runs on while members stay, whoever pushed", d.late);
    r.leave(&b);
    r.leave(&c);
    r.leave(&d);
    CHECK("a group that lost its last member starts anew, not running",
          !r.join("p/mix", -1).late);
    PaceRegistry::Membership none;
    r.start(none);
    CHECK("an unjoined membership starts nothing", !r.join("p/x", -1).late);
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
    test_pace_bursts();
    test_pace_catch_ups();
    test_registry();
    test_late_join();
    test_gaps();
    return test_summary("align_watch");
}
