#include "align_watch.h"

#include <algorithm>
#include <cmath>

namespace mrts {

// --- ArrivalRhythm -----------------------------------------------------------------------

void ArrivalRhythm::arrive(int64_t now_ns) {
    if (arrivals_ > 0) {
        const int64_t gap = std::max<int64_t>(now_ns - last_ns_, 0);
        if (gaps_.size() < (size_t)WINDOW) gaps_.push_back(gap);
        else gaps_[next_] = gap;
        next_ = (next_ + 1) % WINDOW;
    }
    last_ns_ = now_ns;
    arrivals_++;
}

int64_t ArrivalRhythm::p95_ns() const {
    const size_t n = gaps_.size();
    if (n == 0) return 0;
    const size_t rank = (95 * n + 99) / 100;   // ceil(0.95 n), 1-based
    std::vector<int64_t> v(gaps_);
    std::nth_element(v.begin(), v.begin() + (rank - 1), v.end());
    return v[rank - 1];
}

int64_t ArrivalRhythm::limit_ns(const Config& cfg) const {
    if (arrivals_ < (uint64_t)MIN_ARRIVALS) return cfg.ceiling_ns;
    const double w = cfg.factor * (double)p95_ns();
    // The ceiling bounds W even below the floor, so a bad pair of settings cannot raise it.
    if (w >= (double)cfg.ceiling_ns) return cfg.ceiling_ns;
    int64_t out = (int64_t)std::llround(w);
    if (out < cfg.floor_ns) out = cfg.floor_ns;
    return std::min(out, cfg.ceiling_ns);
}

void ArrivalRhythm::reset() { *this = ArrivalRhythm(); }

// --- PaceGroup ---------------------------------------------------------------------------

// Before the group runs, the target; then a rise is a slew from (base, base_at), and once the
// target is at or under base the pace holds there until a skip lowers it.
int64_t PaceGroup::Snapshot::pace_at(int64_t now_ns) const {
    if (!started) return target;
    if (target <= base) return base;
    const int64_t rise = now_ns > base_at ? (now_ns - base_at) / RISE_DIV : 0;
    return std::min(target, base + rise);
}

PaceGroup::PaceGroup(int64_t fall_after_ns)
    : fall_after_ns_(fall_after_ns), bucket_ns_(std::max<int64_t>(fall_after_ns / 2, 1)) {}

int64_t PaceGroup::next_at() const {
    if (!has_clock_) return 0;   // the first time a member has starts the clock
    int64_t at = next_rotation_;
    if (started_ && target_ <= base_ - FALL_MIN_NS) at = std::min(at, next_skip_);
    return at;
}

// The writer side of the seqlock (Boehm 2012): odd while the fields change, relaxed stores
// between two fences. One writer at a time.
void PaceGroup::publish() {
    const int64_t next = next_at();
    if (pub_target_.load(std::memory_order_relaxed) == target_ &&
        pub_base_.load(std::memory_order_relaxed) == base_ &&
        pub_base_at_.load(std::memory_order_relaxed) == base_at_ &&
        pub_next_at_.load(std::memory_order_relaxed) == next &&
        pub_started_.load(std::memory_order_relaxed) == started_)
        return;
    const uint32_t s = seq_.load(std::memory_order_relaxed);
    seq_.store(s + 1, std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_release);
    pub_target_.store(target_, std::memory_order_relaxed);
    pub_base_.store(base_, std::memory_order_relaxed);
    pub_base_at_.store(base_at_, std::memory_order_relaxed);
    pub_next_at_.store(next, std::memory_order_relaxed);
    pub_started_.store(started_, std::memory_order_relaxed);
    seq_.store(s + 2, std::memory_order_release);
}

PaceGroup::Snapshot PaceGroup::snapshot() const {
    Snapshot v;
    for (;;) {
        const uint32_t s0 = seq_.load(std::memory_order_acquire);
        v.target = pub_target_.load(std::memory_order_relaxed);
        v.base = pub_base_.load(std::memory_order_relaxed);
        v.base_at = pub_base_at_.load(std::memory_order_relaxed);
        v.next_at = pub_next_at_.load(std::memory_order_relaxed);
        v.started = pub_started_.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        if (!(s0 & 1) && seq_.load(std::memory_order_relaxed) == s0) return v;
    }
}

int64_t PaceGroup::pace_at(int64_t now_ns) const {
    Snapshot s;
    s.target = target_;
    s.base = base_;
    s.base_at = base_at_;
    s.started = started_;
    return s.pace_at(now_ns);
}

int64_t PaceGroup::pace() const { return pace_at(has_clock_ ? clock_ : -1); }

// The clock never runs back: members' calls cross on the lock in any order.
int64_t PaceGroup::advance(int64_t now_ns) {
    if (now_ns >= 0) {
        if (!has_clock_) {
            has_clock_ = true;
            clock_ = now_ns;
            next_rotation_ = now_ns + bucket_ns_;
        } else if (now_ns > clock_) {
            clock_ = now_ns;
        }
    }
    return has_clock_ ? clock_ : -1;
}

// Each due rotation drops every member's oldest bucket and opens a new one; a value so ages
// out two to three buckets after it came.
void PaceGroup::rotate() {
    if (!has_clock_ || clock_ < next_rotation_) return;
    const int64_t n = (clock_ - next_rotation_) / bucket_ns_ + 1;
    next_rotation_ += n * bucket_ns_;
    for (auto& kv : members_) {
        int64_t* p = kv.second.peaks;
        for (int64_t k = 0; k < std::min<int64_t>(n, BUCKETS); k++) {
            for (int i = 0; i + 1 < BUCKETS; i++) p[i] = p[i + 1];
            p[BUCKETS - 1] = NONE;
        }
    }
    const int64_t was = target_;
    target_ = window_target();
    if (target_ < was) quiet_ = false;   // the window's own fall: reported
}

void PaceGroup::enter(State& s, int64_t v) {
    int64_t& open = s.peaks[BUCKETS - 1];
    open = std::max(open, v);
    target_ = std::max(target_, v);
}

int64_t PaceGroup::window_target() const {
    int64_t t = 0;
    for (const auto& kv : members_)
        for (const int64_t p : kv.second.peaks) t = std::max(t, p);
    return t;
}

void PaceGroup::settle(int64_t t, int64_t cur, int64_t was, Event* ev, bool skip, int64_t floor) {
    if (started_) {
        if (t < 0) {
            base_ = target_;   // no time yet: nothing is paced, it steps
        } else if (target_ > cur) {
            const int64_t to = std::max(cur, std::min(floor, target_));
            if (to > cur || was <= cur) {   // a step or a new rise; one under way keeps its line
                base_ = to;
                base_at_ = t;
            }
        } else {
            if (target_ != was) {   // a rise ends where it is
                base_ = cur;
                base_at_ = t;
            }
            if (skip && cur - target_ >= FALL_MIN_NS && t >= next_skip_) {
                base_ = std::max(target_, cur - FALL_MAX_NS);
                base_at_ = t;
                next_skip_ = t + FALL_SPACING_NS;
                if (ev && !quiet_) ev->fell_ns = cur - base_;
            }
        }
    }
    publish();
}

void PaceGroup::join(Member m, int64_t seed_ns, int64_t now_ns) {
    const int64_t t = advance(now_ns);
    const int64_t cur = pace_at(t), was = target_;
    rotate();
    State& s = members_[m];
    s = State();
    if (seed_ns >= 0) enter(s, seed_ns);
    // A fall a rotation made due waits for the members' next tick: the joiner reports none.
    settle(t, cur, was, nullptr, false);
}

void PaceGroup::leave(Member m, int64_t now_ns) {
    auto it = members_.find(m);
    if (it == members_.end()) return;
    const int64_t t = advance(now_ns);
    const int64_t cur = pace_at(t), was = target_;
    rotate();
    const int64_t kept = target_;
    members_.erase(it);
    target_ = window_target();
    if (target_ < kept) quiet_ = true;
    settle(t, cur, was, nullptr);
}

// Falling: over the newer half (the stretches that end after now - span / 2) nothing counts,
// or its median is more than FALL_NS under the level: half its counted length lies there.
bool PaceGroup::falling(const State& s, int64_t now_ns) {
    const int64_t after = now_ns - s.span / 2, under = s.level - FALL_NS;
    int64_t newer = 0, below = 0;
    for (const Counted& c : s.counted) {
        const int64_t len = c.end > after ? c.len : 0;
        newer += len;
        below += c.mid < under ? len : 0;
    }
    return newer == 0 || 2 * below >= newer;
}

void PaceGroup::observe(Member m, int64_t now_ns, int64_t lateness_ns, bool fresh, bool gapped,
                        Event* ev) {
    auto it = members_.find(m);
    if (it == members_.end()) return;
    const int64_t t = advance(now_ns);
    const int64_t cur = pace_at(t), was = target_;
    rotate();
    State& s = it->second;
    const int64_t l = std::clamp(lateness_ns, -LATENESS_LIMIT_NS, LATENESS_LIMIT_NS);
    const int64_t len = now_ns - s.last_at;
    // The stretch since the run's last arrival; it counts unless the lateness fell over it.
    if (s.has_last && !fresh && len > 0) {
        const bool counts = l >= s.last_lateness;
        const Stretch st{now_ns, len, (s.last_lateness + l) / 2, counts};
        s.window.push_back(st);
        s.span += len;
        if (counts) {
            s.len += len;
            const Counted c{st.mid, len, now_ns};
            s.counted.insert(std::upper_bound(s.counted.begin(), s.counted.end(), c), c);
        }
    }
    s.has_last = true;
    s.last_at = now_ns;
    s.last_lateness = l;
    while (!s.window.empty() && s.window.front().end <= now_ns - WINDOW_NS) {
        const Stretch& f = s.window.front();
        s.span -= f.len;
        if (f.counts) {
            s.len -= f.len;
            s.counted.erase(std::lower_bound(s.counted.begin(), s.counted.end(),
                                             Counted{f.mid, f.len, f.end}));
        }
        s.window.pop_front();
    }
    // The median: the smallest mid with at least half the counted length at or below it; the
    // arrival's own lateness while none counts.
    s.level = l;
    int64_t acc = 0;
    for (const Counted& c : s.counted) {
        acc += c.len;
        if (2 * acc >= s.len) {
            s.level = c.mid;
            break;
        }
    }
    s.has_level = true;
    // Taken once the stretches span half a second and a third of that counts (jitter counts
    // half of a steady input's, a catch-up much less); taking again the need the open bucket
    // holds changes nothing.
    const bool held = s.has_need && s.level == s.need && s.peaks[BUCKETS - 1] >= s.need;
    int64_t floor = NONE;
    if (s.span >= SPAN_NS && 3 * s.len >= s.span && !held && !falling(s, now_ns)) {
        s.need = s.level;
        s.has_need = true;
        enter(s, s.need);
        if (!gapped) floor = s.need;   // the aggregator waits on its data: a step stops nothing
    }
    settle(t, cur, was, ev, true, floor);
}

void PaceGroup::raise(Member m, int64_t pace_ns, int64_t now_ns, Event* ev) {
    auto it = members_.find(m);
    if (it == members_.end()) return;
    const int64_t t = advance(now_ns);
    const int64_t cur = pace_at(t), was = target_;
    rotate();
    enter(it->second, std::clamp(pace_ns, -LATENESS_LIMIT_NS, LATENESS_LIMIT_NS));
    settle(t, cur, was, ev);
}

void PaceGroup::tick(int64_t now_ns, Event* ev) {
    const int64_t t = advance(now_ns);
    const int64_t cur = pace_at(t), was = target_;
    rotate();
    settle(t, cur, was, ev);
}

void PaceGroup::start() {
    if (started_) return;
    started_ = true;
    base_ = target_;
    base_at_ = has_clock_ ? clock_ : 0;
    publish();
}

bool PaceGroup::lateness(Member m, int64_t* out) const {
    auto it = members_.find(m);
    if (it == members_.end() || !it->second.has_level) return false;
    *out = it->second.level;
    return true;
}

bool PaceGroup::need(Member m, int64_t* out) const {
    auto it = members_.find(m);
    if (it == members_.end() || !it->second.has_need) return false;
    *out = it->second.need;
    return true;
}

bool PaceGroup::peak(Member m, int64_t* out) const {
    auto it = members_.find(m);
    if (it == members_.end()) return false;
    int64_t p = NONE;
    for (const int64_t v : it->second.peaks) p = std::max(p, v);
    if (p == NONE) return false;
    *out = p;
    return true;
}

// --- PaceRegistry ------------------------------------------------------------------------

PaceRegistry& PaceRegistry::global() {
    // Never destroyed: a streaming thread may still reach it while the process exits.
    static PaceRegistry* r = new PaceRegistry();
    return *r;
}

// A map's node never moves: the pointer holds until the group is erased, at its last leave.
PaceRegistry::Membership PaceRegistry::join(const std::string& key, int64_t seed_ns,
                                            int64_t fall_after_ns, int64_t now_ns) {
    std::lock_guard<std::mutex> lk(mu_);
    Membership m;
    m.key = key;
    m.member = ++next_;
    PaceGroup& g = groups_.try_emplace(key, fall_after_ns).first->second;
    m.late = g.started();
    m.group = &g;
    g.join(m.member, seed_ns, now_ns);
    return m;
}

void PaceRegistry::leave(Membership* m, int64_t now_ns) {
    if (!m || !m->member) return;
    std::lock_guard<std::mutex> lk(mu_);
    if (m->group) {
        m->group->leave(m->member, now_ns);
        if (m->group->size() == 0) groups_.erase(m->key);
    }
    m->member = 0;
    m->group = nullptr;
}

void PaceRegistry::observe(const Membership& m, int64_t now_ns, int64_t lateness_ns, bool fresh,
                           bool gapped, PaceGroup::Event* ev) {
    std::lock_guard<std::mutex> lk(mu_);
    if (m.member && m.group) m.group->observe(m.member, now_ns, lateness_ns, fresh, gapped, ev);
}

void PaceRegistry::raise(const Membership& m, int64_t pace_ns, int64_t now_ns,
                         PaceGroup::Event* ev) {
    std::lock_guard<std::mutex> lk(mu_);
    if (m.member && m.group) m.group->raise(m.member, pace_ns, now_ns, ev);
}

void PaceRegistry::tick(const Membership& m, int64_t now_ns, PaceGroup::Event* ev) {
    std::lock_guard<std::mutex> lk(mu_);
    if (m.member && m.group) m.group->tick(now_ns, ev);
}

void PaceRegistry::start(const Membership& m) {
    std::lock_guard<std::mutex> lk(mu_);
    if (m.member && m.group) m.group->start();
}

int64_t PaceRegistry::Membership::pace_ns(int64_t now_ns) const {
    return member && group ? group->snapshot().pace_at(now_ns) : 0;
}

PaceGroup::Snapshot PaceRegistry::Membership::snapshot() const {
    return member && group ? group->snapshot() : PaceGroup::Snapshot();
}

PaceRegistry::View PaceRegistry::view(const Membership& m, int64_t now_ns) const {
    std::lock_guard<std::mutex> lk(mu_);
    View v;
    if (!m.member || !m.group) return v;
    const PaceGroup& g = *m.group;
    v.pace_ns = now_ns >= 0 ? g.pace_at(now_ns) : g.pace();
    v.target_ns = g.target();
    v.has_lateness = g.lateness(m.member, &v.lateness_ns);
    v.members = g.size();
    return v;
}

size_t PaceRegistry::groups() const {
    std::lock_guard<std::mutex> lk(mu_);
    return groups_.size();
}

// --- GapPlanner --------------------------------------------------------------------------

bool GapPlanner::stale(int64_t start_ns, int64_t end_ns) const {
    return has_ && (end_ns < horizon_ || (end_ns == horizon_ && start_ns < end_ns));
}

void GapPlanner::emitted(int64_t end_ns) {
    if (!has_ || end_ns > horizon_) {
        horizon_ = end_ns;
        has_ = true;
    }
}

bool GapPlanner::take(int64_t now_ns, int64_t pace_ns, const int64_t* next_ns, Gap* out) {
    int64_t target = now_ns - pace_ns;
    if (next_ns && *next_ns < target) target = *next_ns;
    if (target < 0) return false;   // running time cannot go there
    if (!has_) {
        has_ = true;
        horizon_ = target;
        *out = Gap{target, target};
        return true;
    }
    if (target <= horizon_) return false;
    *out = Gap{horizon_, target};
    horizon_ = target;
    return true;
}

bool GapPlanner::take_piece(int64_t now_ns, int64_t pace_ns, int64_t piece_ns,
                            const int64_t* next_ns, Gap* out) {
    const int64_t due = now_ns - pace_ns;
    if (due < 0 || piece_ns <= 0) return false;
    const int64_t start = has_ ? horizon_ : due;
    if (start > due) return false;
    int64_t end = start + piece_ns;
    if (next_ns) {
        if (*next_ns <= start) return false;
        end = std::min(end, *next_ns);
    }
    has_ = true;
    horizon_ = end;
    *out = Gap{start, end};
    return true;
}

void GapPlanner::reset() {
    has_ = false;
    horizon_ = 0;
}

}  // namespace mrts
