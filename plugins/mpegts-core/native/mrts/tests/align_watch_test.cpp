// ArrivalRhythm, PaceGroup, PaceRegistry and GapPlanner (plan ch. 6 WI-P2-6): W on synthetic
// rhythms, the pace's rules (seeds, the window, recomputed on leave, a lateness over wall time
// that a backlog's drain does not move, as the sort before a1b found it), the pace read lock-free
// (B-79), the slew (B-80), stale arrivals (B-81), the fall (B-82), a join into a running group
// and the gap stretches or pieces an absent input gets.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <map>
#include <thread>
#include <utility>
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

void test_pace_window() {
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
    CHECK("member 1 speeds up to 100 ms: the pace holds 1.5 s (in its window)",
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
    e.raise(1, 300 * MS);
    CHECK("raise (a late sparse cue): pace 300 ms", e.pace() == 300 * MS);
    e.raise(1, 100 * MS);
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

// --- the median, against the copy and sort it replaced (a1b, B-57) -------------------------

// The estimator before a1b (bbeb9b24), the reference: at every arrival the window's counting
// stretches copied and sorted, and the newer half's median taken whenever the window qualifies.
// The target (B-82): each member's largest entry per bucket index of the group's clock, kept
// while fewer than BUCKETS rotations passed since. `Reach` counts the branches it took.
class RefPace {
  public:
    struct Reach {
        long expired = 0, qualified = 0, taken = 0, none = 0, under = 0, edge = 0, held = 0,
             moved = 0, zero = 0, tie = 0, aged = 0;
    };
    Reach reach;

    explicit RefPace(int64_t fall_after = PaceGroup::FALL_AFTER_NS) : bucket_(fall_after / 2) {}
    void join(uint64_t m, int64_t seed) {
        members_[m] = State();
        if (seed >= 0) enter(members_[m], seed);
    }
    void leave(uint64_t m) { members_.erase(m); }
    void raise(uint64_t m, int64_t now, int64_t p) {
        auto it = members_.find(m);
        if (it == members_.end()) return;
        clock(now);
        enter(it->second,
              std::clamp(p, -PaceGroup::LATENESS_LIMIT_NS, PaceGroup::LATENESS_LIMIT_NS));
    }
    void observe(uint64_t m, int64_t now, int64_t lateness, bool fresh) {
        auto it = members_.find(m);
        if (it == members_.end()) return;
        clock(now);
        State& s = it->second;
        const int64_t l =
            std::clamp(lateness, -PaceGroup::LATENESS_LIMIT_NS, PaceGroup::LATENESS_LIMIT_NS);
        const int64_t len = now - s.last_at;
        if (s.has_last && !fresh && len > 0) {
            const bool counts = l >= s.last_lateness;
            s.window.push_back(Stretch{now, len, (s.last_lateness + l) / 2, counts});
            s.span += len;
            if (counts) s.len += len;
        }
        s.has_last = true;
        s.last_at = now;
        s.last_lateness = l;
        while (!s.window.empty() && s.window.front().end <= now - PaceGroup::WINDOW_NS) {
            s.span -= s.window.front().len;
            if (s.window.front().counts) s.len -= s.window.front().len;
            s.window.pop_front();
            reach.expired++;
        }
        if (!median(s.window, INT64_MIN, &s.level, true)) s.level = l;
        s.has_level = true;
        if (s.span >= PaceGroup::SPAN_NS && 3 * s.len >= s.span) {
            reach.qualified++;
            int64_t newer = 0;
            const bool found = median(s.window, now - s.span / 2, &newer, false);
            const bool falling = !found || newer < s.level - PaceGroup::FALL_NS;
            reach.none += !found;
            reach.under += found && falling;
            reach.edge += found && newer == s.level - PaceGroup::FALL_NS;
            reach.held += s.has_need && s.level == s.need;
            if (!falling) {
                reach.taken++;
                reach.moved += s.has_need && s.level != s.need;
                reach.zero += !s.has_need && s.level == 0;
                s.need = s.level;
                s.has_need = true;
                enter(s, s.need);
            }
        }
    }
    bool lateness(uint64_t m, int64_t* out) const {
        auto it = members_.find(m);
        if (it == members_.end() || !it->second.has_level) return false;
        *out = it->second.level;
        return true;
    }
    bool need(uint64_t m, int64_t* out) const {
        auto it = members_.find(m);
        if (it == members_.end() || !it->second.has_need) return false;
        *out = it->second.need;
        return true;
    }
    bool peak(uint64_t m, int64_t* out) const {
        auto it = members_.find(m);
        if (it == members_.end() || it->second.buckets.empty()) return false;
        *out = INT64_MIN;
        for (const auto& b : it->second.buckets) *out = std::max(*out, b.second);
        return true;
    }
    int64_t target() const {
        int64_t t = 0, p = 0;
        for (const auto& kv : members_)
            if (peak(kv.first, &p)) t = std::max(t, p);
        return t;
    }

  private:
    struct Stretch {
        int64_t end, len, mid;
        bool counts;
    };
    struct State {
        bool has_last = false;
        int64_t last_at = 0, last_lateness = 0;
        std::deque<Stretch> window;
        int64_t span = 0, len = 0;
        bool has_level = false;
        int64_t level = 0;
        bool has_need = false;
        int64_t need = 0;
        std::map<int64_t, int64_t> buckets;   // by rotation index: the largest entry
    };
    // The clock: rotations since its first time; a bucket BUCKETS rotations old is gone.
    void clock(int64_t now) {
        if (!has_clock_) {
            has_clock_ = true;
            origin_ = clock_ = now;
        }
        clock_ = std::max(clock_, now);
        rotations_ = (clock_ - origin_) / bucket_;
        for (auto& kv : members_) {
            auto& b = kv.second.buckets;
            while (!b.empty() && rotations_ - b.begin()->first >= PaceGroup::BUCKETS) {
                reach.aged += b.begin()->second > 0;
                b.erase(b.begin());
            }
        }
    }
    void enter(State& s, int64_t v) {
        auto ins = s.buckets.emplace(rotations_, v);
        if (!ins.second) ins.first->second = std::max(ins.first->second, v);
    }
    bool median(const std::deque<Stretch>& w, int64_t after, int64_t* out, bool whole) {
        scratch_.clear();
        int64_t len = 0;
        for (const Stretch& st : w) {
            if (!st.counts || st.end <= after) continue;
            scratch_.emplace_back(st.mid, st.len);
            len += st.len;
        }
        if (scratch_.empty()) return false;
        std::sort(scratch_.begin(), scratch_.end());
        int64_t acc = 0;
        for (size_t i = 0; i < scratch_.size(); i++) {
            acc += scratch_[i].second;
            if (2 * acc >= len) {
                // Exactly half, and the next mid differs: the boundary of the >= .
                reach.tie += whole && 2 * acc == len && i + 1 < scratch_.size() &&
                             scratch_[i + 1].first != scratch_[i].first;
                *out = scratch_[i].first;
                return true;
            }
        }
        *out = scratch_.back().first;
        return true;
    }
    std::map<uint64_t, State> members_;
    std::vector<std::pair<int64_t, int64_t>> scratch_;
    const int64_t bucket_;
    bool has_clock_ = false;
    int64_t origin_ = 0, clock_ = 0, rotations_ = 0;
};

// The sequences' randomness, the same on every platform.
struct Rand {
    uint64_t x;
    explicit Rand(uint64_t seed) : x(seed * 0x9E3779B97F4A7C15ull | 1) {}
    uint64_t next() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        return x;
    }
    int64_t in(int64_t lo, int64_t hi) { return lo + (int64_t)(next() % (uint64_t)(hi - lo + 1)); }
    bool odds(int per_10k) { return (int)(next() % 10000) < per_10k; }
};

// One member's input: buffers of `period` arriving `behind` their content plus 0..`jitter`, in
// segments that step up or down, catch up, come in bursts, stall, go absent or arrive shuffled.
struct Feed {
    uint64_t id = 0;
    int64_t period = 10 * MS, content = 0, behind = 0, jitter = 0, grid = 0;
    int64_t at = 0, prev = 0, late = 0;   // the next arrival and its lateness; the last one
    int64_t until = 0, drain = 0, target = 0, slot = -1, in_slot = 0;
    int burst = 0;
    bool fresh = true, shuffle = false;
};

int64_t snap(int64_t v, int64_t grid) { return grid ? v / grid * grid : v; }

// A new segment from `now`: jitter, grid, bursts, a step, a stall drained by a catch-up, or an
// absence after which the input rejoins, fresh or not.
void segment(Feed& f, Rand& r, int64_t now, bool shuffles) {
    static const int64_t jitters[] = {0, 0, 20000, 300000, MS, 5 * MS, 20 * MS};
    f.until = now + r.in(100 * MS, 2 * S);
    f.jitter = jitters[r.in(0, 6)];
    f.grid = r.odds(2500) ? MS : 0;
    f.burst = r.odds(1500) ? (int)r.in(2, 15) : 0;
    f.shuffle = shuffles && r.odds(1500);
    f.drain = 0;
    const int64_t kind = r.in(0, 99);
    if (kind < 25) {
        f.behind += r.in(-300 * MS, 300 * MS);   // a step: a rise or a fall
    } else if (kind < 35) {
        f.behind = 0;                            // on time: lateness exactly 0
        f.jitter = 0;
    } else if (kind < 50) {
        const int64_t stall = r.in(20 * MS, 2500 * MS);   // a stall, then its backlog drained
        f.target = f.behind;
        f.behind += stall;
        f.drain = std::max<int64_t>(f.period * r.in(1, 95) / 100, 1);
    } else if (kind < 58) {
        const int64_t gone = r.in(50 * MS, 3 * S);   // absent: no content, then a rejoin
        f.content += gone;
        f.fresh = r.odds(7000);
    } else if (kind < 62) {
        f.behind = r.in(-80 * MS, -MS);   // early: lateness below 0
    }
}

// The next buffer's arrival and lateness.
void plan(Feed& f, Rand& r) {
    f.content += f.period;
    if (f.drain && f.behind > f.target) f.behind = std::max(f.target, f.behind - f.drain);
    int64_t delay = f.behind + (f.jitter ? r.in(f.shuffle ? -f.jitter : 0, f.jitter) : 0);
    delay = snap(delay, f.grid);
    int64_t at = f.content + delay;
    if (f.burst) {
        const int64_t bp = f.burst * f.period, s = at / bp + 1;
        f.in_slot = s == f.slot ? f.in_slot + 1 : 0;
        f.slot = s;
        at = s * bp + f.in_slot * 100000;
    }
    if (!f.shuffle) at = std::max(at, f.prev);
    f.at = at;
    f.late = at - f.content;
    if (r.odds(5)) f.late = (r.odds(5000) ? 1 : -1) * PaceGroup::LATENESS_LIMIT_NS * r.in(1, 10);
}

struct Diff {
    long sequences = 0, members = 0, arrivals = 0, fresh = 0, back = 0, fast = 0, ops = 0,
         mismatches = 0;
    char first[256] = "";
};

// Both estimators agree on every member's level, need and window peak, and on the target (the
// lock-free read too), after every call; the groups never start, so the pace is the target.
bool same(const PaceGroup& g, const RefPace& ref, const std::vector<Feed>& feeds, Diff* d,
          long seq, long n) {
    uint64_t bad = 0;   // the member that differs; 0: the target
    bool h[6] = {false, false, false, false, false, false};
    int64_t v[6] = {0, 0, 0, 0, 0, 0};
    for (const Feed& f : feeds) {
        for (int64_t& x : v) x = 0;
        h[0] = g.lateness(f.id, &v[0]);
        h[1] = ref.lateness(f.id, &v[1]);
        h[2] = g.need(f.id, &v[2]);
        h[3] = ref.need(f.id, &v[3]);
        h[4] = g.peak(f.id, &v[4]);
        h[5] = ref.peak(f.id, &v[5]);
        if (h[0] != h[1] || v[0] != v[1] || h[2] != h[3] || v[2] != v[3] || h[4] != h[5] ||
            v[4] != v[5]) {
            bad = f.id;
            break;
        }
    }
    if (!bad && g.target() == ref.target() && g.pace() == g.target() &&
        g.snapshot().target == g.target())
        return true;
    if (!d->mismatches++)
        std::snprintf(d->first, sizeof d->first,
                      "sequence %ld call %ld member %llu: level %d/%lld vs %d/%lld, need %d/%lld vs"
                      " %d/%lld, peak %d/%lld vs %d/%lld, target %lld vs %lld",
                      seq, n, (unsigned long long)bad, h[0], (long long)v[0], h[1],
                      (long long)v[1], h[2], (long long)v[2], h[3], (long long)v[3], h[4],
                      (long long)v[4], h[5], (long long)v[5], (long long)g.target(),
                      (long long)ref.target());
    return false;
}

void test_pace_median_differential() {
    Diff d;
    RefPace::Reach reach;
    for (long seq = 1; seq <= 240; seq++) {
        Rand r((uint64_t)seq);
        // A third of the sequences with a 2 s window: their values age out (B-82).
        const int64_t fall_after = seq % 3 == 1 ? 2 * S : PaceGroup::FALL_AFTER_NS;
        PaceGroup g(fall_after);
        RefPace ref(fall_after);
        std::vector<Feed> feeds;
        uint64_t next_id = 1;
        const bool shuffles = seq % 8 == 0;   // time may go back for a member in these
        const bool fast = seq % 20 == 0;      // one member at 300 to 3,000 a second
        const int64_t t0 = r.odds(5000) ? 0 : r.in(1, 1000) * S;
        auto add = [&](int64_t now) {
            Feed f;
            f.id = next_id++;
            // 10 to 300 a second (300 to 3,000 for a fast sequence's first); a seed for some.
            const double u = (double)r.in(0, 1000) / 1000.0;
            f.period = (int64_t)(1e9 / (fast && f.id == 1 ? 300.0 * std::pow(10.0, u)
                                                          : 10.0 * std::pow(30.0, u)));
            if (r.odds(3000)) f.period = std::max<int64_t>(snap(f.period, MS), MS);
            f.content = now + r.in(0, 50 * MS);
            f.behind = r.in(0, 400 * MS);
            f.prev = now;
            const int64_t seed = r.odds(3000) ? r.in(0, 600 * MS) : -1;
            g.join(f.id, seed);
            ref.join(f.id, seed);
            segment(f, r, now, shuffles);
            plan(f, r);
            feeds.push_back(f);
            d.members++;
        };
        const int n0 = (int)r.in(1, 4);
        for (int k = 0; k < n0; k++) add(t0);
        const int64_t end = t0 + r.in(2, 7) * S;
        const long cap = fast ? 4000 : 7000;
        long calls = 0;
        bool ok = true;
        while (ok && calls < cap) {
            size_t k = 0;
            for (size_t i = 1; i < feeds.size(); i++)
                if (feeds[i].at < feeds[k].at) k = i;
            Feed& f = feeds[k];
            if (f.at >= end) break;
            const int64_t now = f.at;
            const bool fresh = f.fresh || r.odds(20);
            g.observe(f.id, now, f.late, fresh);
            ref.observe(f.id, now, f.late, fresh);
            d.arrivals++;
            d.fresh += fresh;
            d.back += now < f.prev;
            d.fast += f.period < MS;
            f.fresh = false;
            f.prev = std::max(f.prev, now);
            ok = same(g, ref, feeds, &d, seq, ++calls);
            if (now >= f.until) segment(f, r, now, shuffles);
            plan(f, r);
            // The group's other calls: a member's raise, a member that leaves (and one that joins).
            if (r.odds(5) && !feeds.empty()) {
                const size_t j = (size_t)r.in(0, (int64_t)feeds.size() - 1);
                const int64_t p = r.in(0, 2 * S);
                g.raise(feeds[j].id, p, now);
                ref.raise(feeds[j].id, now, p);
                d.ops++;
            } else if (r.odds(4) && !feeds.empty()) {
                const size_t j = (size_t)r.in(0, (int64_t)feeds.size() - 1);
                g.leave(feeds[j].id);
                ref.leave(feeds[j].id);
                feeds.erase(feeds.begin() + (long)j);
                if (feeds.empty() || r.odds(8000)) add(now);
                d.ops++;
            } else if (r.odds(2) && feeds.size() < 4) {
                add(now);
                d.ops++;
            }
            if (ok) ok = same(g, ref, feeds, &d, seq, calls);
        }
        d.sequences++;
        reach.expired += ref.reach.expired;
        reach.qualified += ref.reach.qualified;
        reach.taken += ref.reach.taken;
        reach.none += ref.reach.none;
        reach.under += ref.reach.under;
        reach.edge += ref.reach.edge;
        reach.held += ref.reach.held;
        reach.moved += ref.reach.moved;
        reach.zero += ref.reach.zero;
        reach.tie += ref.reach.tie;
        reach.aged += ref.reach.aged;
    }
    std::printf("  (%ld sequences, %ld members, %ld arrivals: %ld fresh, %ld back in time, %ld at"
                " over 1,000/s; %ld other calls; %ld stretches expired)\n",
                d.sequences, d.members, d.arrivals, d.fresh, d.back, d.fast, d.ops, reach.expired);
    std::printf("  (window qualified %ld: need taken %ld, moved %ld, held %ld, a first of 0 %ld;"
                " falling with none newer %ld, under %ld, at the edge %ld; level at half %ld;"
                " %ld bucket peaks aged out)\n",
                reach.qualified, reach.taken, reach.moved, reach.held, reach.zero, reach.none,
                reach.under, reach.edge, reach.tie, reach.aged);
    if (d.mismatches) std::printf("  %ld mismatches, the first: %s\n", d.mismatches, d.first);
    CHECK("the median against the copy and sort it replaced: level, need, window peak and target"
          " identical after every call",
          d.mismatches == 0 && d.arrivals > 100000);
    CHECK("... over runs that start fresh, go back in time, come over 1,000/s and expire; take,"
          " move and hold a need, a first of 0; fall with none newer and under the level (at its"
          " edge too); halve exactly; age a peak out of the window",
          d.fresh > 0 && d.back > 0 && d.fast > 0 && reach.expired > 0 && reach.taken > 0 &&
              reach.moved > 0 && reach.held > 0 && reach.zero > 0 && reach.none > 0 &&
              reach.under > 0 && reach.edge > 0 && reach.tie > 0 && reach.aged > 0);
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

// A member's task reads the pace through its group pointer, without the lock (B-79).
void test_registry_snapshot() {
    PaceRegistry s;
    PaceRegistry::Membership p = s.join("p/mix", 250 * MS);
    PaceRegistry::Membership q = s.join("p/mix", -1);
    PaceRegistry::Membership o = s.join("p/other", -1);
    CHECK("members of one key share a group, another key has its own",
          p.group && p.group == q.group && o.group && o.group != p.group);
    CHECK("the lock-free read is the seed's pace", p.pace_ns(0) == 250 * MS && q.pace_ns(0) == 250 * MS
                                                       && o.pace_ns(0) == 0);
    s.raise(q, 400 * MS);
    s.start(p);
    const PaceGroup::Snapshot v = p.snapshot();
    CHECK("the snapshot follows a raise and the start, as the locked view does",
          v.target == 400 * MS && v.pace_at(0) == 400 * MS && v.started
              && s.view(p).pace_ns == 400 * MS && s.view(p).target_ns == 400 * MS);
    for (int i = 0; i < 100; i++) s.observe(o, i * 10 * MS, 30 * MS);
    CHECK("... and an arrival that moves the pace", o.pace_ns(0) == 30 * MS
                                                     && !o.snapshot().started);
    s.raise(q, 500 * MS);
    s.leave(&q);
    CHECK("leave clears the group pointer; the one left reads the recomputed pace (the seed)",
          !q.group && q.member == 0 && q.pace_ns(0) == 0 && p.pace_ns(0) == 250 * MS);
    s.leave(&p);
    s.leave(&o);
    PaceRegistry::Membership none;
    CHECK("an unjoined membership reads 0 and has no group",
          !p.group && p.pace_ns(0) == 0 && !none.group && none.pace_ns(0) == 0
              && s.groups() == 0 && none.snapshot().target == 0);

    // Four tasks read while a fifth raises the target 10,000 times, 2 ms apart, and starts the
    // group after the 5,000th (the slew then moves the base each time): every read is a tuple
    // that was written, in order. The tuples come from the same history run on one thread.
    constexpr int N = 10000, FLIP = 5000;
    auto history = [](PaceRegistry& reg, const PaceRegistry::Membership& m, int i) {
        reg.raise(m, i * MS, 2 * i * MS);
    };
    auto eq = [](const PaceGroup::Snapshot& a, const PaceGroup::Snapshot& b) {
        return a.target == b.target && a.base == b.base && a.base_at == b.base_at
               && a.next_at == b.next_at && a.started == b.started;
    };
    std::vector<PaceGroup::Snapshot> want(N + 1);
    PaceGroup::Snapshot flip;   // the start's own, between raises FLIP and FLIP + 1
    {
        PaceRegistry t;
        const PaceRegistry::Membership m = t.join("p/sl", -1);
        want[0] = m.snapshot();
        for (int i = 1; i <= N; i++) {
            if (i == FLIP + 1) {
                t.start(m);
                flip = m.snapshot();
            }
            history(t, m, i);
            want[i] = m.snapshot();
        }
    }
    PaceRegistry u;
    PaceRegistry::Membership w = u.join("p/sl", -1);
    const PaceRegistry::Membership rd = u.join("p/sl", -1);
    std::atomic<int> ready{0}, bad{0};
    std::atomic<long> reads{0}, changes{0};
    std::atomic<bool> done{false};
    std::vector<std::thread> readers;
    for (int k = 0; k < 4; k++) {
        readers.emplace_back([&] {
            int64_t last = 0;
            long n = 0, c = 0;
            ready.fetch_add(1);
            while (!done.load(std::memory_order_acquire)) {
                const PaceGroup::Snapshot x = rd.group->snapshot();
                const int64_t i = x.target / MS;
                const bool ok = x.target % MS == 0 && i >= 0 && i <= N && i >= last
                                && (eq(x, want[i]) || (i == FLIP && eq(x, flip)));
                if (!ok) bad.fetch_add(1);
                if (i != last) c++;
                last = i;
                n++;
            }
            reads.fetch_add(n);
            changes.fetch_add(c);
        });
    }
    while (ready.load() < 4) std::this_thread::yield();
    for (int i = 1; i <= N; i++) {
        if (i == FLIP + 1) u.start(w);
        history(u, w, i);
    }
    done.store(true, std::memory_order_release);
    for (std::thread& x : readers) x.join();
    CHECK("4 readers, 1 writer, 10,000 raises and a start: every read a written tuple, in order",
          bad.load() == 0 && reads.load() > 4 && eq(rd.snapshot(), want[N])
              && want[N].started && want[N].base_at == 2 * N * MS);
    std::printf("  (%ld reads, %ld of them a new tuple: the readers ran beside the writer)\n",
                reads.load(), changes.load());
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

// --- the slew (B-80), stale arrivals (B-81), the fall (B-82) -------------------------------

// Once the group runs, a target over the pace is a slew, half a ns a ns; before, a step.
void test_slew() {
    PaceGroup g;
    g.join(1, -1);
    g.join(2, -1);
    g.raise(1, 10 * MS, 0);
    CHECK("slew: not started, a rise steps (10 ms at once)",
          g.pace_at(0) == 10 * MS && g.target() == 10 * MS);
    g.start();
    const int64_t t0 = S;
    g.raise(2, 310 * MS, t0);
    CHECK("slew: started, the target is 310 ms at once, the pace slews from 10",
          g.target() == 310 * MS && g.pace_at(t0) == 10 * MS);
    CHECK("slew: 160 ms 300 ms later", g.pace_at(t0 + 300 * MS) == 160 * MS);
    CHECK("slew: 310 ms 600 ms later, then flat",
          g.pace_at(t0 + 600 * MS) == 310 * MS && g.pace_at(t0 + 5 * S) == 310 * MS);
    const PaceGroup::Snapshot sn = g.snapshot();
    bool formula = true;
    for (int64_t dt = -2 * MS; dt <= 900 * MS; dt += 7 * MS)
        formula = formula && sn.pace_at(t0 + dt) == g.pace_at(t0 + dt);
    CHECK("slew: the snapshot's formula is pace_at", formula && sn.target == 310 * MS);
    g.raise(1, 510 * MS, t0 + 200 * MS);
    CHECK("slew: raised mid-slew (510 ms at 110): on from the pace it has, at the same rate",
          g.pace_at(t0 + 200 * MS) == 110 * MS && g.pace_at(t0 + 600 * MS) == 310 * MS
              && g.pace_at(t0 + S) == 510 * MS && g.pace_at(t0 + 2 * S) == 510 * MS);
    g.raise(2, 610 * MS, t0 + 3 * S);
    CHECK("slew: raised once it ended: from 510 at that time, not on the old line",
          g.pace_at(t0 + 3 * S) == 510 * MS && g.pace_at(t0 + 3 * S + 100 * MS) == 560 * MS
              && g.pace_at(t0 + 3 * S + 200 * MS) == 610 * MS);

    // A gapped member's lateness (a joiner or a rejoin catching up) slews as a seed or a cue
    // does; a present member's steps, its data being waited for anyway.
    PaceGroup o;
    o.join(1, -1);
    o.join(2, -1);
    o.start();
    int64_t when = -1;
    for (int i = 0; i < 200; i++) {
        o.observe(1, i * 10 * MS, 300 * MS, false, true);
        if (when < 0 && o.target() == 300 * MS) when = i * 10 * MS;
    }
    CHECK("slew: a gapped member's lateness counts at 0.5 s and the pace slews to it over 0.6 s",
          when == 500 * MS && o.pace_at(when) == 0 && o.pace_at(when + 300 * MS) == 150 * MS
              && o.pace_at(when + 600 * MS) == 300 * MS);
    int64_t stepped = -1;
    for (int i = 200; i < 300; i++) {
        o.observe(2, i * 10 * MS, 500 * MS);
        if (stepped < 0 && o.target() == 500 * MS) stepped = o.pace_at(i * 10 * MS);
    }
    CHECK("slew: a present member's lateness steps the pace at once (500 ms)", stepped == 500 * MS);
    PaceGroup sd;
    sd.join(1, -1);
    sd.start();
    sd.tick(10 * S);
    sd.join(2, 300 * MS, 10 * S);
    CHECK("slew: a seed into a running group slews from the join",
          sd.target() == 300 * MS && sd.pace_at(10 * S) == 0
              && sd.pace_at(10 * S + 300 * MS) == 150 * MS && sd.pace_at(10 * S + 600 * MS) == 300 * MS);
    sd.join(3, 500 * MS);
    CHECK("slew: ... and a seed without a time of its own from the group's clock, on the same line",
          sd.target() == 500 * MS && sd.pace_at(10 * S + 600 * MS) == 300 * MS
              && sd.pace_at(11 * S) == 500 * MS);

    // The slow member leaves mid-slew: at once to the target that remains, in one skip.
    PaceGroup l;
    l.join(1, -1);
    l.join(2, -1);
    l.raise(1, 20 * MS, 0);
    l.start();
    l.raise(2, 320 * MS, S);
    PaceGroup::Event ev;
    l.leave(2, S + 200 * MS);
    CHECK("slew: the slow member leaves mid-slew (at 120 ms): the pace at once the 20 ms left",
          l.target() == 20 * MS && l.pace_at(S + 200 * MS) == 20 * MS && l.pace_at(5 * S) == 20 * MS);
    l.raise(1, 30 * MS, S + 300 * MS, &ev);
    CHECK("slew: what remains rises by a slew again (20 -> 30 ms over 20 ms)",
          l.pace_at(S + 310 * MS) == 25 * MS && l.pace_at(S + 320 * MS) == 30 * MS && !ev.fell_ns);
    PaceGroup n;
    n.join(1, -1);
    n.raise(1, 700 * MS, 0);
    CHECK("slew: a group never started keeps stepping", n.pace_at(0) == 700 * MS
                                                           && n.pace() == 700 * MS);
}

// B-81: the element observes stale arrivals too. A joiner's steady lateness counts though every
// one of its buffers is discarded; a rejoin's backlog, drained at once, moves nothing.
void test_stale_observed() {
    PaceGroup g;
    g.join(1, -1);
    g.start();
    for (int i = 0; i < 300; i++) g.observe(1, i * 10 * MS, 20 * MS);
    g.join(2, -1, 3 * S);
    int64_t counted = -1;
    for (int i = 0; i < 100; i++) {
        const int64_t t = 3 * S + i * 10 * MS;
        g.observe(1, t, 20 * MS);
        g.observe(2, t + 5 * MS, 300 * MS, i == 0, true);
        if (counted < 0 && g.target() == 300 * MS) counted = t + 5 * MS - 3 * S;
    }
    CHECK("stale observed: a joiner's 300 ms counts 0.5 s after its first arrival, stale or kept",
          counted >= 500 * MS && counted <= 510 * MS);
    PaceGroup r;
    r.join(1, -1);
    for (int i = 0; i < 100; i++) r.observe(1, i * 10 * MS, 20 * MS);
    // Absent 2 s, then its 2 s backlog in 200 ms (stale, observed), then 20 ms again.
    for (int k = 0; k < 200; k++)
        r.observe(1, 3 * S + k * MS, 2 * S + 20 * MS - k * 9 * MS, k == 0, true);
    for (int k = 0; k < 150; k++) r.observe(1, 3200 * MS + k * 10 * MS, 20 * MS);
    CHECK("stale observed: a rejoin's 2 s backlog drained in 200 ms leaves the target at 20 ms",
          r.target() == 20 * MS);
}

// B-82: each member's peak over its window (three buckets of fall-after / 2); once the target
// is FALL_MIN under the pace, the pace falls to it by at most FALL_MAX a skip, 2 s apart.
struct FallRun {
    PaceGroup g;
    int64_t t = 0;
    std::vector<std::pair<int64_t, int64_t>> fell;   // (when, by)
    explicit FallRun(int64_t fall_after = PaceGroup::FALL_AFTER_NS) : g(fall_after) {}
    // Member m at `late` every 10 ms until `until`; the others say nothing.
    void feed(PaceGroup::Member m, int64_t until, int64_t late, bool gapped = false) {
        for (; t < until; t += 10 * MS) {
            PaceGroup::Event ev;
            g.observe(m, t, late, false, gapped, &ev);
            if (ev.fell_ns) fell.emplace_back(t, ev.fell_ns);
        }
    }
};

void test_fall() {
    const int64_t B = PaceGroup::FALL_AFTER_NS / 2;   // a bucket: 90 s
    FallRun a;
    a.g.join(1, -1);
    a.g.start();
    a.feed(1, 2 * S, 300 * MS);
    a.feed(1, 3 * B - 10 * MS, 20 * MS);
    CHECK("fall: a member at 300 ms for 2 s, then 20 ms: the pace holds 300 while its peak is in"
          " the window",
          a.g.pace_at(a.t) == 300 * MS && a.g.target() == 300 * MS && a.fell.empty());
    a.feed(1, 3 * B + 10 * MS, 20 * MS);
    CHECK("fall: ... and falls to 20 at the third rotation, 270 s (between 2 and 3 buckets after"
          " its last 300), in one skip, one event",
          a.fell.size() == 1 && a.fell[0] == std::make_pair(3 * B, 280 * MS)
              && a.g.pace_at(a.t) == 20 * MS);
    const PaceGroup::Snapshot sn = a.g.snapshot();
    CHECK("fall: the snapshot's next time is the next rotation, 360 s", sn.next_at == 4 * B);

    FallRun big;
    big.g.join(1, -1);
    big.g.start();
    big.feed(1, S, 2520 * MS);
    big.feed(1, 3 * B + 5 * S, 20 * MS);
    const std::vector<std::pair<int64_t, int64_t>> want = {
        {3 * B, 1000 * MS}, {3 * B + 2 * S, 1000 * MS}, {3 * B + 4 * S, 500 * MS}};
    CHECK("fall: 2.5 s comes as 1 s, 1 s and 0.5 s, two seconds apart, an event each",
          big.fell == want && big.g.pace_at(big.t) == 20 * MS);

    FallRun x;
    x.g.join(1, -1);
    x.g.start();
    x.feed(1, S, 25 * MS);
    x.feed(1, 4 * B, 20 * MS);
    CHECK("fall: a 5 ms excess never falls (FALL_MIN 10 ms)",
          x.fell.empty() && x.g.target() == 20 * MS && x.g.pace_at(x.t) == 25 * MS
              && x.g.snapshot().next_at == 4 * B);

    FallRun sd;
    sd.g.join(1, -1);
    sd.g.join(2, 400 * MS);
    sd.g.start();
    sd.feed(1, 3 * B + 10 * MS, 20 * MS);
    CHECK("fall: a seed ages out on another member's clock (400 -> 20 ms at 270 s)",
          sd.fell.size() == 1 && sd.fell[0].first == 3 * B && sd.g.pace_at(sd.t) == 20 * MS);

    FallRun ab;
    ab.g.join(1, -1);
    ab.g.join(2, -1);
    ab.g.start();
    for (; ab.t < S; ab.t += 10 * MS) {
        ab.g.observe(1, ab.t, 20 * MS);
        ab.g.observe(2, ab.t, 300 * MS);
    }
    ab.feed(1, 3 * B + 10 * MS, 20 * MS);
    CHECK("fall: an absent member's need ages out (its last arrival at 1 s; down at 270 s)",
          ab.fell.size() == 1 && ab.fell[0].first == 3 * B && ab.g.pace_at(ab.t) == 20 * MS);

    FallRun cue;
    cue.g.join(1, -1);
    cue.g.join(2, -1);
    cue.g.start();
    cue.feed(1, 10 * S, 20 * MS);
    cue.g.raise(2, 800 * MS, 10 * S);
    cue.feed(1, 2 * B + 5 * S, 20 * MS);
    CHECK("fall: a late cue's raise holds the pace while its member's window holds it",
          cue.fell.empty() && cue.g.pace_at(cue.t) == 800 * MS);
    cue.feed(1, 3 * B + 10 * MS, 20 * MS);
    CHECK("fall: ... and ages out (its member's bucket gone at 270 s)",
          cue.fell.size() == 1 && cue.g.pace_at(cue.t) == 20 * MS);

    // A leave falls at once, by at most FALL_MAX, and reports nothing; the rest follows 2 s apart.
    FallRun lv;
    lv.g.join(1, -1);
    lv.g.join(2, -1);
    lv.g.start();
    for (; lv.t < 7 * S; lv.t += 10 * MS) {
        lv.g.observe(1, lv.t, 20 * MS);
        lv.g.observe(2, lv.t, 2520 * MS);
    }
    const int64_t at = lv.t;
    lv.g.leave(2, at);
    CHECK("fall: a leave falls at once, bounded: 2520 -> 1520 ms",
          lv.g.pace_at(at) == 1520 * MS && lv.g.target() == 20 * MS);
    std::vector<int64_t> steps;
    for (const int64_t until : {at + 2 * S, at + 2 * S + 10 * MS, at + 4 * S + 10 * MS}) {
        lv.feed(1, until, 20 * MS);
        steps.push_back(lv.g.pace_at(lv.t - 10 * MS));
    }
    CHECK("fall: ... then 1 s and 0.5 s two seconds apart, all without an event (no member's"
          " steadiness)",
          lv.fell.empty() && steps == std::vector<int64_t>{1520 * MS, 520 * MS, 20 * MS});

    // Time alone: a group whose members say nothing falls at a tick.
    FallRun tk(4 * S);
    tk.g.join(1, 300 * MS);
    tk.g.start();
    tk.g.tick(0);
    PaceGroup::Event e1, e2;
    tk.g.tick(6 * S - MS, &e1);
    const bool held = tk.g.pace_at(6 * S - MS) == 300 * MS && !e1.fell_ns;
    tk.g.tick(6 * S, &e2);
    CHECK("fall: with fall-after 4 s (buckets of 2 s), a seed alone falls at the tick of its third"
          " rotation, 6 s",
          held && e2.fell_ns == 300 * MS && tk.g.pace_at(6 * S) == 0 && tk.g.fall_after() == 4 * S);

    // A rise and a fall never cross: a fall under way, then a member 1.8 s late: gapped, the pace
    // slews up from where it stands; present, it steps there.
    for (const bool gapped : {true, false}) {
        FallRun rf;
        rf.g.join(1, -1);
        rf.g.join(2, -1);
        rf.g.start();
        rf.feed(1, S, 2520 * MS);
        rf.feed(1, 3 * B + 10 * MS, 20 * MS);
        const int64_t mid = rf.g.pace_at(rf.t);
        rf.feed(2, 3 * B + 800 * MS, 1800 * MS, gapped);
        const int64_t rising = rf.g.pace_at(rf.t - 10 * MS);
        rf.feed(2, 3 * B + 2500 * MS, 1800 * MS, gapped);
        CHECK(gapped ? "fall: a fall under way (at 1520 ms), then a gapped member 1.8 s late: the pace"
                       " slews up from 1520 to it, no more skips"
                     : "fall: ... a present one: the pace steps to 1.8 s",
              mid == 1520 * MS && rf.fell.size() == 1 && rf.g.target() == 1800 * MS
                  && (gapped ? rising > 1520 * MS && rising < 1800 * MS : rising == 1800 * MS)
                  && rf.g.pace_at(rf.t) == 1800 * MS);
    }
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

// An audio aggregator's pieces (WI-P2-14 F1): each due when data of that length would leave.
void test_pieces() {
    GapPlanner p;
    GapPlanner::Gap g{};
    const int64_t pace = 1500 * MS, unit = 10 * MS;
    CHECK("pieces: now - pace before running time 0: none",
          !p.take_piece(MS, 50 * MS, unit, nullptr, &g) && !p.has_horizon());
    CHECK("pieces: no horizon: the first from now - pace, one piece long, at once",
          p.take_piece(10 * S, pace, unit, nullptr, &g) && g.start_ns == 8500 * MS
              && g.end_ns == 8510 * MS && p.horizon_ns() == 8510 * MS);
    CHECK("pieces: the next is not due before now - pace reaches its start",
          !p.take_piece(10 * S + 9 * MS, pace, unit, nullptr, &g));
    CHECK("pieces: ... and is due at its start + pace",
          p.take_piece(10 * S + 10 * MS, pace, unit, nullptr, &g) && g.start_ns == 8510 * MS
              && g.end_ns == 8520 * MS);
    p.emitted(8530 * MS);
    CHECK("pieces: after data, from where it ended, due at that end + pace",
          !p.take_piece(10 * S + 29 * MS, pace, unit, nullptr, &g)
              && p.take_piece(10 * S + 30 * MS, pace, unit, nullptr, &g)
              && g.start_ns == 8530 * MS && g.end_ns == 8540 * MS);
    std::vector<int64_t> starts;
    while (p.take_piece(10 * S + 65 * MS, pace, unit, nullptr, &g)) starts.push_back(g.start_ns);
    CHECK("pieces: a late wake-up takes every due one, one piece at a time",
          starts == std::vector<int64_t>{8540 * MS, 8550 * MS, 8560 * MS} && g.end_ns == 8570 * MS);
    const int64_t next = 8575 * MS;
    CHECK("pieces: never past a queued item",
          p.take_piece(10 * S + 100 * MS, pace, unit, &next, &g) && g.start_ns == 8570 * MS
              && g.end_ns == 8575 * MS);
    CHECK("pieces: ... nor from it", !p.take_piece(10 * S + 100 * MS, pace, unit, &next, &g));
    CHECK("pieces: a raised pace holds them",
          !p.take_piece(10 * S + 100 * MS, 2000 * MS, unit, nullptr, &g));
    CHECK("pieces: no length, none", !p.take_piece(20 * S, 0, 0, nullptr, &g));
}

}  // namespace

int main() {
    test_rhythm_cbr();
    test_rhythm_bursts();
    test_rhythm_window_and_rank();
    test_pace_window();
    test_pace_leave();
    test_pace_seeds();
    test_pace_bursts();
    test_pace_catch_ups();
    test_pace_median_differential();
    test_registry();
    test_registry_snapshot();
    test_late_join();
    test_slew();
    test_stale_observed();
    test_fall();
    test_gaps();
    test_pieces();
    return test_summary("align_watch");
}
