// mrts::DrainServo (B-179, WI-P4-18): py/drain_servo_test.py's cases one for one, on the same model of a
// live source's arrivals into a queue before a device (the mutants are the reference's). Parity with the
// reference is py/drain_servo_parity_test.py's.
#include <cmath>
#include <cstdlib>
#include <functional>
#include <vector>

#include "../drain_servo.h"
#include "check.h"

using mrts::DrainEvent;
using mrts::DrainServo;
using mrts::UnderrunReason;

namespace {

constexpr int64_t SEC = DrainServo::SEC, MS = DrainServo::MS;
constexpr int64_t TICK = 100 * MS, MIN = 60 * SEC, HOUR = 3600 * SEC;
constexpr int64_t M60 = 60 * MS;   // the cases built on r3's 60 ms start (the default is the floor now)
constexpr int64_t SLEW_STEP = TICK / DrainServo::SLEW_DEN;

int64_t iabs64(int64_t v) { return v < 0 ? -v : v; }

struct Stall {
    int64_t at, len;
};

// The reference's source(): content up to t delivered at t every period(t); stalls hold arrivals to
// their end; every dip_every the next arrival comes dip_ns late.
struct Source {
    std::function<int64_t(int64_t)> period;
    std::vector<Stall> stalls;
    int64_t dip_every = 0, dip_ns = 0;
    int64_t t = 0, last = 0;
    int64_t ahead = 0;   // content this far past the arrival comes with it (a pace releasing early)
    bool next(int64_t* at_out, int64_t* avail) {
        const int64_t p = period(t);
        t += p;
        int64_t at = t;
        for (const Stall& s : stalls)
            if (s.at < at && at < s.at + s.len) at = s.at + s.len;
        if (dip_every && t / dip_every != (t - p) / dip_every) at += dip_ns;
        at = std::max(at, last);
        last = at;
        *at_out = at;
        *avail = t + ahead;
        return true;
    }
};

Source steady(int64_t p) { return Source{[p](int64_t) { return p; }, {}, 0, 0, 0, 0, 0}; }

struct Row {
    int64_t t, ppb, excess, margin, render, target;
    std::vector<DrainEvent> ev;
};

// The reference's Link: a queue before a device at (1 + device)(1 + delta).
struct Link {
    DrainServo s;
    Source src;
    int64_t nxt_at = 0, nxt_av = 0;
    int64_t now = 0, avail = 0, pos, base, dev;
    bool starved = false;
    int64_t starved_ns = 0;
    std::vector<Row> log;
    Link(DrainServo servo, Source source, int64_t fill, int64_t base_ns = 0, int64_t dev_ppb = 0)
        : s(servo), src(source), pos(-fill), base(base_ns), dev(dev_ppb) {
        src.next(&nxt_at, &nxt_av);
    }
    void play(int64_t t) {
        const int64_t dt = t - now;
        const int64_t want = (int64_t)((__int128)((__int128)dt * (SEC + dev) / SEC) * (SEC + s.ppb()) / SEC);
        const int64_t fill = avail - pos;
        if (want > fill) {
            starved = true;
            starved_ns += want - fill;
            pos = avail;
        } else {
            pos += want;
        }
        now = t;
    }
    int64_t render() const { return now - pos + base; }
    void tick(int64_t to) {
        bool have = false;
        int64_t lo = 0;
        while (nxt_at <= to) {
            play(nxt_at);
            const int64_t f = avail - pos;
            lo = have ? std::min(lo, f) : f;
            have = true;
            avail = std::max(avail, nxt_av);
            src.next(&nxt_at, &nxt_av);
        }
        play(to);
        const int64_t f = avail - pos;
        lo = have ? std::min(lo, f) : f;
        s.starve(to, starved);
        starved = false;
        s.sample(to, lo);
        s.update(to, render(), true);
    }
};

struct Run {
    std::vector<Link*> links;
    int64_t t = 0;
    bool slew_ok = true, cap_ok = true;
    void until(int64_t end, const std::function<void(int64_t)>& each = nullptr) {
        while (t < end) {
            t += TICK;
            for (Link* l : links) {
                const int64_t was = l->s.ppb();
                const bool brk = l->s.break_pending();
                l->tick(t);
                if (!brk && iabs64(l->s.ppb() - was) > SLEW_STEP) slew_ok = false;
                if (iabs64(l->s.ppb()) > DrainServo::DMAX_PPB) cap_ok = false;
                l->log.push_back(Row{t, l->s.ppb(), l->s.excess(), l->s.margin(), l->render(), l->s.target(),
                                     l->s.take_events()});
            }
            if (each) each(t);
        }
    }
};

std::vector<std::pair<int64_t, int64_t>> events(const Link& l, DrainEvent::Kind k) {
    std::vector<std::pair<int64_t, int64_t>> out;
    for (const Row& r : l.log)
        for (const DrainEvent& e : r.ev)
            if (e.kind == k) out.push_back({e.at, e.value});
    return out;
}

double predicted_ns(int64_t e0) { return (e0 - 150 * MS) / 5e6 * SEC + 30 * SEC * std::log(150.0 / 20); }

// The first time after `after` the excess was within 20 ms.
int64_t near_at(const Link& l, int64_t after) {
    for (const Row& r : l.log)
        if (r.t > after && r.excess <= 20 * MS) return r.t;
    return -1;
}

void case_backlog() {
    Link l(DrainServo(), steady(20 * MS), 2 * SEC);
    Run r{{&l}};
    r.until(15 * MIN);
    const auto st = events(l, DrainEvent::Kind::drain_start);
    const int64_t near = st.empty() ? -1 : near_at(l, st[0].first);
    const double pred = st.empty() ? 0 : predicted_ns(st[0].second);
    int64_t top = 0;
    for (const Row& row : l.log) top = std::max(top, row.ppb);
    CHECK("backlog: a drain starts after the 30 s warm-up", !st.empty() && st[0].first >= 30 * SEC);
    CHECK("backlog: within 20 ms of the target in part 5's time +-10 %",
          near > 0 && std::fabs((double)(near - st[0].first) - pred) <= pred / 10);
    CHECK("backlog: delta never over 0.5 %", r.cap_ok);
    CHECK("backlog: |d delta/dt| never over 500 ppm/s", r.slew_ok);
    CHECK("backlog: reaches 0.5 %", top == DrainServo::DMAX_PPB);
    CHECK("backlog: no underrun", l.s.underruns() == 0 && l.s.outages() == 0);
}

void case_steady() {
    Source src{[](int64_t t) { return (t / (150 * MS)) % 2 ? 100 * MS : 200 * MS; }, {}, 0, 0, 0, 0, 0};
    Link l(DrainServo(false, M60), src, 230 * MS);
    Run r{{&l}};
    int64_t floor_at = -1;
    r.until(2 * HOUR, [&](int64_t t) {
        if (floor_at < 0 && l.s.margin() == 20 * MS) floor_at = t;
    });
    int64_t low = 0;
    for (const Row& row : l.log) low = std::min(low, row.ppb);
    CHECK("steady: no underrun", l.s.underruns() == 0 && l.s.outages() == 0 && l.starved_ns == 0);
    CHECK("steady: the margin decays to 20 ms in about 80 min", floor_at >= 75 * MIN && floor_at <= 85 * MIN);
    CHECK("steady: alone, delta never negative", low >= 0);
}

void case_steady_raise() {
    Source src = steady(150 * MS);
    src.stalls = {{90 * MIN, 300 * MS}};
    Link l(DrainServo(), src, 300 * MS);
    Run r{{&l}};
    r.until(6 * HOUR);
    CHECK("steady+raise: one raise", l.s.raises() == 1);
    CHECK("steady+raise: the margin back at 20 ms by 6 h", l.s.margin() == 20 * MS);
}

void case_step() {
    Source src{[](int64_t t) { return t < 10 * MIN || t >= 4 * HOUR ? 150 * MS : 300 * MS; }, {}, 0, 0, 0, 0, 0};
    Link l(DrainServo(false, M60), src, 300 * MS);
    Run r{{&l}};
    int64_t back = -1;
    r.until(10 * HOUR, [&](int64_t t) {
        if (back < 0 && l.s.raises() && l.s.has_learned() && l.s.margin() == l.s.learned() + 10 * MS) back = t;
    });
    const auto ur = events(l, DrainEvent::Kind::underrun);
    const auto rs = events(l, DrainEvent::Kind::raise);
    int by1 = 0, by8 = 0;
    bool apart = true;
    for (size_t i = 0; i < ur.size(); i++) {
        by1 += ur[i].first <= HOUR;
        by8 += ur[i].first <= 8 * HOUR;
        if (i && ur[i].first - ur[i - 1].first < 105 * MIN) apart = false;
    }
    CHECK("step: exactly one underrun by 1 h", by1 == 1);
    CHECK("step: the margin back at L + 10 ms within 2 h of the raise",
          back > 0 && !rs.empty() && back - rs[0].first <= 2 * HOUR + 10 * MIN);
    CHECK("step: at most 4 underruns over 8 h, >= 1.75 h apart", by8 <= 4 && apart);
    CHECK("step: stepped back, the margin <= 30 ms by 10 h", l.s.margin() <= 30 * MS);
}

void case_starve() {
    const int64_t lens[] = {200 * MS, 2 * SEC};
    const uint64_t raises[] = {1, 0};
    for (int i = 0; i < 2; i++) {
        Source src = steady(20 * MS);
        src.stalls = {{40 * SEC, lens[i]}};
        Link l(DrainServo(), src, 30 * MS);
        Run r{{&l}};
        r.until(55 * SEC);
        bool at_tc = true;
        const int64_t tc = 40 * SEC + lens[i] + DrainServo::CONFIRM_NS;
        for (const auto& e : events(l, DrainEvent::Kind::raise))
            if (e.first < tc || e.first > tc + 2 * TICK) at_tc = false;
        int64_t top = 0;
        for (const Row& row : l.log) top = std::max(top, iabs64(row.ppb));
        CHECK(i ? "starve 2000 ms: 0 raise(s), at its end + 10 s" : "starve 200 ms: 1 raise(s), at its end + 10 s",
              l.s.raises() == raises[i] && at_tc && top == 0);
    }
}

void case_dip() {
    Source src = steady(20 * MS);
    src.dip_every = 5 * MIN;
    src.dip_ns = 70 * MS;
    Link l(DrainServo(false, M60), src, 120 * MS);
    Run r{{&l}};
    r.until(8 * HOUR);
    const auto ur = events(l, DrainEvent::Kind::underrun);
    const int64_t first = ur.empty() ? -1 : ur[0].first;
    bool quiet = true;
    for (const auto& u : ur)
        if (u.first > first && u.first <= first + 105 * MIN) quiet = false;
    CHECK("dip: a dropout after the drain", first >= 0 && first <= 15 * MIN);
    CHECK("dip: none in the 1.75 h after the first", first >= 0 && quiet);
    CHECK("dip: at most one per 2 h", ur.size() <= 8 * HOUR / (2 * HOUR) + 1);
    CHECK("dip: never one per dip", (int64_t)ur.size() < 8 * HOUR / (5 * MIN) / 4);
}

void case_creep() {
    Link l(DrainServo(false, M60), steady(20 * MS), 80 * MS, 0, -260000);
    Run r{{&l}};
    r.until(HOUR);
    int64_t worst = 0, held = 0;
    for (const Row& row : l.log) {
        worst = std::max(worst, row.excess);
        if (row.t >= 5 * MIN) held = std::max(held, row.excess);
    }
    CHECK("creep: the excess stays <= 20 ms from 5 min on, for 1 h", held <= 20 * MS);
    CHECK("creep: at most 25 ms at the first engage", worst <= 25 * MS);
    CHECK("creep: it drains (held by the servo)", !events(l, DrainEvent::Kind::drain_start).empty());
}

void case_outage() {
    Source src = steady(20 * MS);
    src.stalls = {{60 * SEC, 2 * SEC}};
    Link l(DrainServo(), src, 70 * MS);
    Run r{{&l}};
    r.until(12 * MIN);
    bool quiet = true, later = false;
    for (const auto& e : events(l, DrainEvent::Kind::drain_start)) {
        if (e.first >= 62 * SEC && e.first < 82 * SEC) quiet = false;
        if (e.first >= 82 * SEC) later = true;
    }
    CHECK("outage: no raise", l.s.raises() == 0 && l.s.outages() == 1);
    CHECK("outage: no drain for 20 s after", quiet);
    CHECK("outage: then it drains", later);
    CHECK("outage: back near its target", l.log.back().excess <= 20 * MS);
}

void case_discont() {
    Link l(DrainServo(), steady(20 * MS), SEC);
    Run r{{&l}};
    r.until(8 * MIN, [&](int64_t t) {
        if (t % (5 * SEC) == 0) l.s.epoch_break();
    });
    const auto st = events(l, DrainEvent::Kind::drain_start);
    const int64_t near = st.empty() ? -1 : near_at(l, st[0].first);
    const double pred = st.empty() ? 0 : predicted_ns(st[0].second);
    CHECK("discont: drains in part 5's time +-10 %",
          near > 0 && std::fabs((double)(near - st[0].first) - pred) <= pred / 10);
}

void case_paced() {
    // Released 10 ms before it is needed: each arrival at t carries content to t + 10 ms.
    Source src = steady(10 * MS);
    src.ahead = 10 * MS;
    Link l(DrainServo(), src, 10 * MS);
    Run r{{&l}};
    r.until(10 * MIN);
    int64_t top = 0;
    for (const Row& row : l.log) top = std::max(top, row.ppb);
    CHECK("paced: no drain", top == 0);
    CHECK("paced: no underrun", l.s.underruns() == 0 && l.starved_ns == 0);
}

// The engine's role: every 2 s, P = the max (or the min) of the published targets, to each.
struct Group {
    std::vector<Link*> links;
    int64_t p = 0;
    void operator()(int64_t t) {
        if (t % (2 * SEC)) return;
        p = links[0]->s.target();
        for (Link* l : links) p = std::max(p, l->s.target());
        for (Link* l : links) l->s.set_group(t, p);
    }
};

void case_group() {
    const Stall stall{8 * MIN, 2 * SEC};
    Source sv = steady(40 * MS), sa = steady(20 * MS), sb = steady(20 * MS);
    sv.stalls = {stall};
    sa.stalls = {stall, {3 * MIN, 300 * MS}};
    sb.stalls = {stall};
    Link v(DrainServo(true, 40 * MS, 20 * MS), sv, 200 * MS, 120 * MS);
    Link a(DrainServo(), sa, 150 * MS, 60 * MS);
    Link b(DrainServo(), sb, 300 * MS, 200 * MS);
    std::vector<Link*> links{&v, &a, &b};
    Group g{links};
    Run r{links};
    bool held_ok = true;
    std::vector<std::pair<int64_t, int64_t>> prev(3, {0, 0});
    std::vector<bool> have(3, false);
    auto each = [&](int64_t t) {
        g(t);
        for (int i = 0; i < 3; i++) {
            if (have[i] && prev[i].first < 0 && links[i]->s.ppb() < 0 && prev[i].second != links[i]->s.target())
                held_ok = false;
            prev[i] = {links[i]->s.ppb(), links[i]->s.target()};
            have[i] = true;
        }
    };
    r.until(20 * MIN, each);
    int64_t spread = 0, rose = 0;
    for (Link* l : links) {
        spread = std::max(spread, iabs64(l->render() - g.p));
        for (const Row& row : l->log) rose = std::min(rose, row.ppb);
    }
    b.s = DrainServo();
    b.pos += 250 * MS;
    r.until(32 * MIN, each);
    int64_t spread2 = 0;
    for (Link* l : links) spread2 = std::max(spread2, iabs64(l->render() - g.p));
    CHECK("group: a's starvation, grouped above its margin, does not raise (not-margin)",
          a.s.raises() == 0 && a.s.reason_count(UnderrunReason::not_margin) == 1);
    CHECK("group: all within 20 ms of P after the stall", spread <= 20 * MS);
    CHECK("group: a low member rose, at <= 0.5 %", -DrainServo::DMAX_PPB <= rose && rose < 0 && r.cap_ok);
    CHECK("group: a rising member's published T held", held_ok);
    CHECK("group: a member restarted low rises to P", spread2 <= 20 * MS);
}

void case_group_cap() {
    Link l(DrainServo(), steady(20 * MS), 80 * MS, 50 * MS);
    Run r{{&l}};
    int64_t own = -1;
    auto each = [&](int64_t t) {
        if (t == 60 * SEC) own = l.s.target();
        if (t >= 60 * SEC && t % (2 * SEC) == 0) l.s.set_group(t, own + 1200 * MS);
    };
    r.until(12 * MIN, each);
    int64_t t_at = -1;
    for (const Row& row : l.log)
        if (own >= 0 && row.render >= own + 980 * MS) {
            t_at = row.t;
            break;
        }
    bool pos = false, neg = false;
    for (const Row& row : l.log)
        if (t_at >= 0 && row.t >= t_at + 20 * SEC) {
            pos |= row.ppb > 0;
            neg |= row.ppb < 0;
        }
    r.until(24 * MIN, each);
    CHECK("cap: rises to T_own + 1 s", t_at >= 0);
    CHECK("cap: sits within 20 ms of T_own + 1 s", own >= 0 && iabs64(l.render() - own - SEC) <= 20 * MS);
    CHECK("cap: no sign change of delta in the 10 min after", !(pos && neg));
    CHECK("cap: held there", l.s.capped());
}

void case_video_late() {
    Link l(DrainServo(true, 40 * MS, 20 * MS), steady(40 * MS), 40 * MS, 100 * MS);
    Run r{{&l}};
    int64_t lo = INT64_MAX, hi = INT64_MIN;
    r.until(5 * MIN, [&](int64_t t) {
        if (t % (20 * SEC) == 0) l.s.late(t, 80 * MS);
        if (t > 40 * SEC) {
            lo = std::min(lo, l.s.target());
            hi = std::max(hi, l.s.target());
        }
    });
    CHECK("late: drain idle, no raise and P steady",
          l.s.raises() == 0 && l.s.underruns() >= 10 && hi - lo <= 40 * MS &&
              l.s.reason_count(UnderrunReason::video) == l.s.underruns());
    Link l2(DrainServo(true, 40 * MS, 20 * MS), steady(40 * MS), 400 * MS, 100 * MS);
    Run r2{{&l2}};
    while (events(l2, DrainEvent::Kind::drain_done).empty() && r2.t < 6 * MIN) r2.until(r2.t + TICK);
    const bool done = !events(l2, DrainEvent::Kind::drain_done).empty();
    r2.until(r2.t + 10 * SEC);
    l2.s.late(r2.t, 80 * MS);
    r2.until(r2.t + 2 * SEC);
    Link l3(DrainServo(true, 40 * MS, 20 * MS), steady(40 * MS), 400 * MS, 100 * MS);
    Run r3{{&l3}};
    while (l3.s.ppb() <= 0 && r3.t < 6 * MIN) r3.until(r3.t + TICK);
    l3.s.late(r3.t, 80 * MS);
    r3.until(r3.t + 2 * SEC);
    CHECK("late: 10 s after a drain let go, no raise (after-drain)",
          done && l2.s.raises() == 0 && l2.s.reason_count(UnderrunReason::after_drain) == 1);
    CHECK("late: while it drains, no raise (drain)",
          l3.s.ppb() > 0 && l3.s.raises() == 0 && l3.s.reason_count(UnderrunReason::drain) == 1);
}

void case_hysteresis() {
    Link l(DrainServo(false, M60), steady(10 * MS), 80 * MS);
    Run r{{&l}};
    r.until(9 * MIN);
    int64_t top = 0;
    for (const Row& row : l.log) top = std::max(top, row.ppb);
    Link l2(DrainServo(false, M60), steady(10 * MS), 200 * MS);
    Run r2{{&l2}};
    r2.until(9 * MIN);
    const auto st = events(l2, DrainEvent::Kind::drain_start);
    const auto done = events(l2, DrainEvent::Kind::drain_done);
    int64_t let = -1;
    for (const Row& row : l2.log)
        if (!done.empty() && row.t == done[0].first) let = row.excess;
    CHECK("hysteresis: 10 ms above the margin never engages", top == 0);
    CHECK("hysteresis: lets go at 5 ms", let >= 0 && let <= 5 * MS);
    CHECK("hysteresis: one engage only", st.size() == 1);
}

// B-179 fix 1: a trough under the margin publishes its render lateness, never more; the group ends at the higher.
void case_live() {
    Link a(DrainServo(), steady(20 * MS), 25 * MS, 40 * MS);
    Link b(DrainServo(), steady(20 * MS), 120 * MS, -140 * MS);
    std::vector<Link*> links{&a, &b};
    Group g{links};
    Run r{links};
    int64_t over = 0;
    r.until(10 * MIN, [&](int64_t t) {
        g(t);
        if (t >= 40 * SEC) over = std::max(over, g.p - std::max(a.render(), b.render()));
    });
    const int64_t top = std::max(a.render(), b.render());
    CHECK("live: the trough under the margin, no drain", a.s.excess() < 0 && a.s.ppb() == 0);
    CHECK("live: it publishes its render lateness", a.s.target() == a.render());
    CHECK("live: P never above the higher render", over <= MS);
    CHECK("live: both end at the higher render, none above it",
          iabs64(a.render() - top) <= 20 * MS && iabs64(b.render() - top) <= 20 * MS && top <= a.render() + MS);
    CHECK("live: no underrun",
          a.s.underruns() == 0 && b.s.underruns() == 0 && a.starved_ns == 0 && b.starved_ns == 0);
}

// B-177: a group of early members (render lateness below 0) is held together: the lower rises to the higher.
void case_group_early() {
    Link a(DrainServo(), steady(20 * MS), 60 * MS, -600 * MS);
    Link b(DrainServo(), steady(20 * MS), 60 * MS, -150 * MS);
    std::vector<Link*> links{&a, &b};
    Group g{links};
    Run r{links};
    r.until(10 * MIN, [&](int64_t t) { g(t); });
    const int64_t top = std::max(a.render(), b.render());
    CHECK("early: P below 0", g.p < 0);
    CHECK("early: both end within 20 ms of the higher",
          iabs64(a.render() - top) <= 20 * MS && iabs64(b.render() - top) <= 20 * MS);
    CHECK("early: no underrun",
          a.s.underruns() == 0 && b.s.underruns() == 0 && a.starved_ns == 0 && b.starved_ns == 0);
}

// B-179 fix 2: a 35 s hole in a video servo's samples empties its window; warm-up again, nothing drains for 30 s.
void case_hole() {
    DrainServo s(true, 40 * MS, 20 * MS);
    int64_t before = 0, quiet = 0, after = 0;
    for (int k = 1; k <= 1200; k++) {
        const int64_t t = k * TICK;
        if (t > 40 * SEC && t < 75 * SEC) continue;
        s.sample(t, 300 * MS);
        s.update(t, 500 * MS, true);
        int64_t& m = t <= 40 * SEC ? before : t < 105 * SEC ? quiet : after;
        m = std::max(m, s.ppb());
    }
    CHECK("hole: it drained before the hole", before > 0);
    CHECK("hole: warm-up again after it, nothing drains for 30 s", quiet == 0);
    CHECK("hole: then it drains", after > 0);
}

// The window: three buckets, the oldest leaving at each rotation, all of them after 30 s.
void case_window() {
    mrts::DrainWindow w;
    w.clear(0);
    int64_t m = 0;
    w.add(1 * SEC, 5);
    w.add(11 * SEC, 9);
    w.add(21 * SEC, 7);
    CHECK("window: min over three buckets", w.min(25 * SEC, &m) && m == 5);
    CHECK("window: the oldest leaves at 30 s", w.min(30 * SEC, &m) && m == 7);
    CHECK("window: empty 30 s after the last", !w.min(60 * SEC, &m));
}

// --- B-240: the raise rule (owner decision 2026-11-13) -------------------------------------------------------

// The reference's Drive: the servo alone on 100 ms ticks; a starvation of a tick or more feeds slack 0 while it
// runs, a shorter one is the sink's own skip; `hold`: a group target at its render lateness.
struct Drive {
    DrainServo& s;
    std::function<int64_t(int64_t)> slack, render;
    std::vector<Stall> eps;
    bool hold = false;
    int64_t t = 0;
    std::vector<DrainEvent> ev;
    Drive(DrainServo& servo, std::function<int64_t(int64_t)> sl,
          std::function<int64_t(int64_t)> rd = [](int64_t) { return 100 * MS; }, std::vector<Stall> e = {},
          bool h = false)
        : s(servo), slack(sl), render(rd), eps(e), hold(h) {}
    void until(int64_t end, const std::function<void(int64_t)>& each = nullptr) {
        while (t < end) {
            t += TICK;
            bool on = false;
            for (const Stall& e : eps)
                if (e.len >= TICK && e.at <= t && t < e.at + e.len) on = true;
            s.starve(t, on);
            for (const Stall& e : eps)
                if (e.len < TICK && t - TICK < e.at + e.len && e.at + e.len <= t) {
                    s.starve(t - e.len, true);
                    s.starve(t, false);
                }
            s.sample(t, on ? 0 : slack(t));
            if (hold) s.set_group(t, render(t));
            s.update(t, render(t), true);
            for (const DrainEvent& e : s.take_events()) ev.push_back(e);
            if (each) each(t);
        }
    }
    std::vector<UnderrunReason> reasons() const {
        std::vector<UnderrunReason> out;
        for (const DrainEvent& e : ev)
            if (e.kind == DrainEvent::Kind::underrun) out.push_back(e.reason);
        return out;
    }
    std::vector<DrainEvent> of(DrainEvent::Kind k) const {
        std::vector<DrainEvent> out;
        for (const DrainEvent& e : ev)
            if (e.kind == k) out.push_back(e);
        return out;
    }
};

using R = UnderrunReason;

void case_f1_pin() {
    DrainServo s(true, 260 * MS, 20 * MS);
    std::vector<int64_t> seams;
    for (int k = 1; k < 30; k++) seams.push_back(k * 40020 * MS);
    uint64_t lates = 0;
    Drive d(s, [](int64_t) { return 0; }, [&](int64_t t) {
        int64_t r = 120 * MS;
        for (size_t k = 0; k < seams.size(); k++)
            if (seams[k] <= t) r += 26 * MS + (int64_t)(k % 13) * MS;
        return r;
    });
    d.until(20 * MIN, [&](int64_t t) {
        s.queue_level(t, 100 * MS);
        for (int64_t at : seams)
            if (t - TICK < at && at <= t) {
                s.late(t, 30 * MS);
                lates++;
            }
    });
    CHECK("f1 pin: no raise", s.raises() == 0);
    CHECK("f1 pin: every late release counted `video`",
          s.reason_count(R::video) == lates && lates == s.underruns());
    CHECK("f1 pin: it never drains", d.of(DrainEvent::Kind::drain_start).empty());
}

void case_cpu() {
    Source src = steady(20 * MS);
    for (int k = 0; k < 20; k++) src.stalls.push_back({60 * SEC + k * 3 * SEC, 100 * MS * (k + 1) + 20 * MS});
    Link l(DrainServo(), src, 30 * MS);
    Run r{{&l}};
    r.until(15 * MIN);
    const auto st = events(l, DrainEvent::Kind::drain_start);
    const int64_t near = st.empty() ? -1 : near_at(l, st[0].first);
    const double pred = st.empty() ? 0 : predicted_ns(st[0].second);
    const double took = near < 0 ? -1e18 : (double)(near - st[0].first);
    DrainServo v(true, 20 * MS, 20 * MS);
    Drive d(v, [](int64_t) { return 20 * MS; });
    d.until(3 * MIN, [&](int64_t t) {
        if (t >= 60 * SEC && t < 120 * SEC && t % (1500 * MS) == 0) v.late(t, 30 * MS);
    });
    CHECK("cpu: audio, no raise during or after the load", l.s.raises() == 0 && l.s.margin() == 20 * MS);
    CHECK("cpu: audio, every underrun under `load` or `warm-up`",
          l.s.underruns() >= 10 && l.s.reason_count(R::load) >= 1 &&
              l.s.reason_count(R::load) + l.s.reason_count(R::warm_up) == l.s.underruns());
    CHECK("cpu: audio, back to its target in part 5's time +-10 %", std::fabs(took - pred) <= pred / 10);
    CHECK("cpu: video, the drain idle, no raise", v.raises() == 0 && v.underruns() == v.reason_count(R::video) && v.underruns() >= 30);
}

void case_stall_arm() {
    Source src = steady(20 * MS);
    src.stalls = {{60 * SEC, 2 * SEC}};
    Link l(DrainServo(), src, 30 * MS);
    Run r{{&l}};
    r.until(12 * MIN, [&](int64_t t) {
        if (t == 62 * SEC) l.s.epoch_break();
    });
    const auto st = events(l, DrainEvent::Kind::drain_start);
    const int64_t near = st.empty() ? -1 : near_at(l, st[0].first);
    const double pred = st.empty() ? 0 : predicted_ns(st[0].second);
    const double took = near < 0 ? -1e18 : (double)(near - st[0].first);
    CHECK("stall arm: an outage, no raise", l.s.raises() == 0 && l.s.outages() == 1 && l.s.margin() == 20 * MS);
    CHECK("stall arm: back on time", std::fabs(took - pred) <= pred / 10);
}

int64_t drain_slack(int64_t t) { return t < 60 * SEC ? 200 * MS : 20 * MS; }

void case_drain_timing() {
    {
        DrainServo s;
        Drive d(s, drain_slack, [](int64_t) { return 100 * MS; }, {{45 * SEC, 200 * MS}});
        d.until(80 * SEC);
        CHECK("drain timing: inside a drain, no raise (drain)",
              s.raises() == 0 && d.reasons() == std::vector<R>{R::drain});
    }
    const int64_t whens[] = {20 * SEC, 40 * SEC};
    const R want[] = {R::after_drain, R::raised};
    for (int i = 0; i < 2; i++) {
        DrainServo s;
        Drive d(s, drain_slack);
        d.until(60 * SEC);
        while (s.ppb()) d.until(d.t + TICK);
        const int64_t quiet = d.t;
        d.eps = {{quiet + whens[i], 200 * MS}};
        d.until(quiet + whens[i] + 15 * SEC);
        const int64_t tc = quiet + whens[i] + 200 * MS + DrainServo::CONFIRM_NS;
        bool at = true;
        for (const DrainEvent& e : d.of(DrainEvent::Kind::raise))
            if (e.at < tc || e.at > tc + TICK) at = false;
        CHECK(i ? "drain timing: 40 s after its end, 1 raise (raised)"
                : "drain timing: 20 s after its end, 0 raise (after-drain)",
              s.raises() == (uint64_t)i && d.reasons() == std::vector<R>{want[i]} && at);
    }
}

void case_keep_up() {
    const int64_t extras[] = {19 * MS, 21 * MS};
    for (int i = 0; i < 2; i++) {
        DrainServo s;
        const int64_t at = 60 * SEC, n = 200 * MS, x = extras[i];
        Drive d(s, [](int64_t) { return 20 * MS; },
                [=](int64_t t) { return 100 * MS + (t >= at + n + 2 * SEC ? n + x : 0); }, {{at, n}});
        d.until(80 * SEC);
        CHECK(i ? "keep up: + 21 ms, 0 raise" : "keep up: + 19 ms, 1 raise",
              s.raises() == (uint64_t)(1 - i) && d.reasons() == std::vector<R>{i ? R::load : R::raised});
    }
}

void case_spacing() {
    const int64_t gaps[] = {20 * SEC, 31 * SEC};
    for (int i = 0; i < 2; i++) {
        DrainServo s;
        Drive d(s, [](int64_t) { return 20 * MS; }, [](int64_t) { return 100 * MS; },
                {{65 * SEC, 30 * MS}, {65 * SEC + gaps[i], 30 * MS}});
        d.until(65 * SEC + gaps[i] + 15 * SEC);
        CHECK(i ? "spacing: 31 s apart, both raise" : "spacing: 20 s apart, the second warm-up",
              d.reasons() == (i ? std::vector<R>{R::raised, R::raised} : std::vector<R>{R::raised, R::warm_up}));
    }
}

void case_band() {
    struct Arm {
        int64_t start, slack;
        bool raises;
        const char* name;
    };
    const Arm arms[] = {{20 * MS, 40 * MS, true, "band: trough at margin +20 ms, 1 raise"},
                        {40 * MS, 20 * MS, true, "band: trough at margin -20 ms, 1 raise"},
                        {20 * MS, 41 * MS, false, "band: trough at margin +21 ms, 0 raise"},
                        {41 * MS, 20 * MS, false, "band: trough at margin -21 ms, 0 raise"},
                        {20 * MS, 45 * MS, false, "band: trough at margin +25 ms, 0 raise"},
                        {260 * MS, 100 * MS, false, "band: trough at margin -160 ms, 0 raise"}};
    for (const Arm& a : arms) {
        DrainServo s(false, a.start, 20 * MS);
        const int64_t v = a.slack;
        Drive d(s, [v](int64_t) { return v; }, [](int64_t) { return 100 * MS; }, {{60 * SEC, 30 * MS}}, true);
        d.until(75 * SEC);
        CHECK(a.name, s.raises() == (a.raises ? 1u : 0u) &&
                          d.reasons() == std::vector<R>{a.raises ? R::raised : R::not_margin});
    }
}

void case_hold_state() {
    const int64_t gaps[] = {25 * SEC, 31 * SEC};
    for (int i = 0; i < 2; i++) {
        DrainServo s;
        Drive d(s, [](int64_t) { return 20 * MS; }, [](int64_t) { return 100 * MS; },
                {{62 * SEC, 30 * MS}, {62 * SEC + gaps[i], 30 * MS}});
        d.until(62 * SEC + gaps[i] + 15 * SEC);
        const auto rs = d.reasons();
        CHECK(i ? "hold state: 31 s after another, raised" : "hold state: 25 s after another, warm-up",
              rs.size() == 2 && rs[1] == (i ? R::raised : R::warm_up));
    }
}

void case_dip_drain() {
    DrainServo s;
    Drive d(s, drain_slack, [](int64_t) { return 100 * MS; }, {{45 * SEC, 200 * MS}, {150 * SEC, 200 * MS}});
    d.until(3 * MIN);
    CHECK("dip+drain: the dip in the drain raises nothing, the first steady one raises",
          d.reasons() == (std::vector<R>{R::drain, R::raised}) && s.raises() == 1);
}

// A steady stream at its margin, one 200 ms starvation at 60 s, to 80 s; `each` after every tick.
Drive steady_at(DrainServo& s, const std::function<void(int64_t)>& each = nullptr,
                std::function<int64_t(int64_t)> slack = [](int64_t) { return 20 * MS; }) {
    Drive d(s, slack, [](int64_t) { return 100 * MS; }, {{60 * SEC, 200 * MS}});
    d.until(80 * SEC, each);
    return d;
}

uint64_t counted(const DrainServo& s) {
    uint64_t n = 0;
    for (int r = 0; r < mrts::UNDERRUN_REASONS; r++) n += s.reason_count((R)r);
    return n;
}

// 19. S3, and a clear with episodes pending (a drain after the end, unreachable through the API while the hold
// keeps delta at 0, is the reference's forced case).
void case_input() {
    const int64_t end = 60 * SEC + 200 * MS;
    struct Arm {
        int64_t when;
        R want;
        const char* name;
    };
    const Arm arms[] = {{50 * SEC, R::input, "input: a break 10 s before, input"},
                        {25 * SEC, R::raised, "input: a break 35 s before, raised"},
                        {end + 5 * SEC, R::input, "input: a break 5 s after the end, input"}};
    for (const Arm& a : arms) {
        DrainServo s;
        const int64_t w = a.when;
        Drive d = steady_at(s, [&](int64_t t) {
            if (t == w) s.epoch_break();
        });
        CHECK(a.name, d.reasons() == std::vector<R>{a.want});
    }
    {
        DrainServo s;
        Drive d = steady_at(s, [&](int64_t t) {
            if (t == end + 5 * SEC) s.clear(t);
        });
        const auto ev = d.of(DrainEvent::Kind::underrun);
        CHECK("input: a clear 5 s after the end counts it then, `input`",
              ev.size() == 1 && ev[0].reason == R::input && ev[0].at == end + 5 * SEC && s.raises() == 0 &&
                  counted(s) == 1 && s.underruns() == 1);
    }
    {
        DrainServo s;
        const int64_t e45 = 45 * SEC + 200 * MS;
        Drive d(s, drain_slack, [](int64_t) { return 100 * MS; }, {{45 * SEC, 200 * MS}});
        d.until(e45 + 5 * SEC, [&](int64_t t) {
            if (t == e45 + 3 * SEC) s.clear(t);
        });
        CHECK("input: a clear meeting a drain's episode counts `drain`",
              d.reasons() == std::vector<R>{R::drain} && counted(s) == 1 && s.underruns() == 1);
    }
}

// 20. S6 reads the trough 1-2 s before the start: margin 40 ms, the fill falling from it to empty over the 0.5 s
// before a steady starvation still raises.
void case_fall() {
    DrainServo s(false, 40 * MS, 20 * MS);
    const int64_t at = 60 * SEC;
    Drive d = steady_at(s, nullptr, [at](int64_t t) {
        return t <= at - 500 * MS ? 40 * MS : 40 * MS - (t - at + 500 * MS) * 80 / 1000;
    });
    CHECK("fall: a fill falling into the starvation, it raises",
          d.reasons() == std::vector<R>{R::raised} && s.raises() == 1);
}

// B-256: a 50p Video Player's chain, pull-through as FB1's seam diagnostic found it (the reference's PullChain).
struct PullChain {
    static constexpr int64_t P = 20 * MS;
    DrainServo& s;
    int64_t n;
    std::vector<int64_t> seams;   // frame numbers
    std::vector<std::pair<int64_t, int64_t>> renders;
    PullChain(DrainServo& servo, int64_t seam_ns = 40020 * MS, int64_t minutes = 60)
        : s(servo), n(minutes * MIN / P) {
        for (int64_t k = 1; k <= minutes * MIN / seam_ns; k++) seams.push_back(k * seam_ns / P);
    }
    static int64_t arrival(int64_t k) { return k * P + (k % 2 == 0 ? 20 * MS : 0) - 100 * MS; }
    void run() {
        bool have_prev = false, have_read = false;
        int64_t prev = 0, last_read = 0, j = 1;
        size_t next_seam = 0;
        for (int64_t k = 0; k < n; k++) {
            const int64_t start = have_prev ? std::max(prev, arrival(k)) : arrival(k);
            const bool seam = next_seam < seams.size() && seams[next_seam] == k;
            if (seam) next_seam++;
            const int64_t at = start + 3 * MS + (seam ? 30 * MS : 0);
            const int64_t slot =
                have_prev ? prev + (2 * P * SEC + SEC + s.ppb()) / (2 * (SEC + s.ppb())) : at;
            if (at > slot) {
                if (4 * (at - slot) >= P) s.late(at, at - slot);
            } else {
                s.sample(at, slot - at);
            }
            if (!have_read || at - last_read >= TICK) {
                j = std::max(j, k + 1);
                while (arrival(j) <= at) j++;
                s.queue_level(at, (j - k - 1) * P);
                last_read = at;
                have_read = true;
            }
            const int64_t rel = std::max(slot, at);
            s.update(at, rel - k * P, true);
            s.take_events();
            prev = rel;
            have_prev = true;
            renders.push_back({at, rel - k * P});
        }
    }
};

void case_seam_floor() {
    DrainServo s(true, 20 * MS, 20 * MS);
    PullChain c(s);
    c.run();
    int64_t first = 0;
    for (const auto& r : c.renders)
        if (r.first > 40 * SEC) {
            first = r.second;
            break;
        }
    int64_t worst = 0;
    for (const auto& r : c.renders)
        if (r.first > 30 * MIN) worst = std::max(worst, iabs64(r.second - first));
    CHECK("seam: no raise, the margin at the floor", s.raises() == 0 && s.margin() == 20 * MS);
    CHECK("seam: at most one late release per seam",
          s.underruns() > 0 && s.underruns() <= c.seams.size() && s.outages() == 0 &&
              s.reason_count(R::drain) + s.reason_count(R::after_drain) + s.reason_count(R::video) == s.underruns());
    CHECK("seam: no step accumulates",
          worst <= 60 * MS && iabs64(c.renders.back().second - first) <= 40 * MS);
    CHECK("seam: the drain took the steps back", s.drained() >= 500 * MS);
}

void case_video_never() {
    DrainServo s(true, 20 * MS, 20 * MS);
    Drive d(s, drain_slack);
    d.until(45 * SEC);
    s.late(d.t, 30 * MS);
    d.until(60 * SEC);
    while (s.ppb()) d.until(d.t + TICK);
    d.until(d.t + 10 * SEC);
    s.late(d.t, 30 * MS);
    d.until(d.t + 40 * SEC);
    s.late(d.t, 30 * MS);
    d.until(d.t + 15 * SEC);
    CHECK("video never: no raise", s.raises() == 0 && s.margin() == 20 * MS);
    CHECK("video never: drain, after-drain, video",
          s.reason_count(R::drain) == 1 && s.reason_count(R::after_drain) == 1 && s.reason_count(R::video) == 1);
}

}  // namespace

int main() {
    case_window();
    case_backlog();
    case_steady();
    case_steady_raise();
    case_step();
    case_starve();
    case_dip();
    case_creep();
    case_outage();
    case_discont();
    case_paced();
    case_group();
    case_group_cap();
    case_video_late();
    case_hysteresis();
    case_live();
    case_hole();
    case_group_early();
    case_dip_drain();
    case_f1_pin();
    case_cpu();
    case_stall_arm();
    case_drain_timing();
    case_keep_up();
    case_spacing();
    case_band();
    case_hold_state();
    case_input();
    case_fall();
    case_seam_floor();
    case_video_never();
    return test_summary("drain_servo");
}
