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
        src.stalls = {{20 * SEC, lens[i]}};
        Link l(DrainServo(), src, 30 * MS);
        Run r{{&l}};
        r.until(25 * SEC);
        bool at_end = true;
        for (const auto& e : events(l, DrainEvent::Kind::raise))
            if (e.first < 20 * SEC + lens[i] || e.first > 20 * SEC + lens[i] + 2 * TICK) at_end = false;
        int64_t top = 0;
        for (const Row& row : l.log) top = std::max(top, iabs64(row.ppb));
        CHECK(i ? "starve 2000 ms: 0 raise(s), at its end" : "starve 200 ms: 1 raise(s), at its end",
              l.s.raises() == raises[i] && at_end && top == 0);
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
    CHECK("group: a's raise", a.s.raises() == 1);
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
          l.s.raises() == 0 && l.s.underruns() >= 10 && hi - lo <= 40 * MS);
    Link l2(DrainServo(true, 40 * MS, 20 * MS), steady(40 * MS), 400 * MS, 100 * MS);
    Run r2{{&l2}};
    while (events(l2, DrainEvent::Kind::drain_done).empty() && r2.t < 6 * MIN) r2.until(r2.t + TICK);
    const bool done = !events(l2, DrainEvent::Kind::drain_done).empty();
    r2.until(r2.t + 10 * SEC);
    l2.s.late(r2.t, 80 * MS);
    r2.until(r2.t + 2 * SEC);
    CHECK("late: 10 s after a drain let go, one raise", done && l2.s.raises() == 1);
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
    return test_summary("drain_servo");
}
