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

void PaceGroup::join(Member m, int64_t seed_ns) {
    State s;
    s.seed = seed_ns;
    members_[m] = s;
    if (seed_ns >= 0) pace_ = std::max(pace_, seed_ns);
}

void PaceGroup::leave(Member m) {
    if (!members_.erase(m)) return;
    // The only way down: what the members that remain need, an absent one's held need included.
    pace_ = 0;
    for (const auto& kv : members_) {
        const State& s = kv.second;
        if (s.seed >= 0) pace_ = std::max(pace_, s.seed);
        if (s.has_need) pace_ = std::max(pace_, s.need);
    }
}

// Of the stretches that count and end after `after`, the smallest mid with at least half their
// length at or below it; false when none counts.
bool PaceGroup::median(const std::deque<Stretch>& w, int64_t after, int64_t* out,
                       std::vector<std::pair<int64_t, int64_t>>* scratch) {
    scratch->clear();
    int64_t len = 0;
    for (const Stretch& st : w) {
        if (!st.counts || st.end <= after) continue;
        scratch->emplace_back(st.mid, st.len);
        len += st.len;
    }
    if (scratch->empty()) return false;
    std::sort(scratch->begin(), scratch->end());
    int64_t acc = 0;
    for (const auto& v : *scratch) {
        acc += v.second;
        if (2 * acc >= len) {
            *out = v.first;
            return true;
        }
    }
    *out = scratch->back().first;
    return true;
}

void PaceGroup::observe(Member m, int64_t now_ns, int64_t lateness_ns, bool fresh) {
    auto it = members_.find(m);
    if (it == members_.end()) return;
    State& s = it->second;
    const int64_t l = std::clamp(lateness_ns, -LATENESS_LIMIT_NS, LATENESS_LIMIT_NS);
    const int64_t len = now_ns - s.last_at;
    // The stretch since the run's last arrival; it counts unless the lateness fell over it.
    if (s.has_last && !fresh && len > 0) {
        const bool counts = l >= s.last_lateness;
        s.window.push_back(Stretch{now_ns, len, (s.last_lateness + l) / 2, counts});
        s.span += len;
        if (counts) s.len += len;
    }
    s.has_last = true;
    s.last_at = now_ns;
    s.last_lateness = l;
    while (!s.window.empty() && s.window.front().end <= now_ns - WINDOW_NS) {
        s.span -= s.window.front().len;
        if (s.window.front().counts) s.len -= s.window.front().len;
        s.window.pop_front();
    }
    if (!median(s.window, INT64_MIN, &s.level, &scratch_)) s.level = l;
    s.has_level = true;
    // Taken once the stretches span half a second and a third of that counts (jitter counts
    // half of a steady input's, a catch-up much less).
    if (s.span >= SPAN_NS && 3 * s.len >= s.span) {
        // Falling: over the newer half nothing counts, or what does sits under the whole.
        int64_t newer = 0;
        const bool falling = !median(s.window, now_ns - s.span / 2, &newer, &scratch_) ||
                             newer < s.level - FALL_NS;
        if (!falling) {
            s.need = s.level;
            s.has_need = true;
            pace_ = std::max(pace_, s.need);
        }
    }
}

void PaceGroup::raise(int64_t pace_ns) { pace_ = std::max(pace_, pace_ns); }

bool PaceGroup::lateness(Member m, int64_t* out) const {
    auto it = members_.find(m);
    if (it == members_.end() || !it->second.has_level) return false;
    *out = it->second.level;
    return true;
}

// --- PaceRegistry ------------------------------------------------------------------------

PaceRegistry& PaceRegistry::global() {
    // Never destroyed: a streaming thread may still reach it while the process exits.
    static PaceRegistry* r = new PaceRegistry();
    return *r;
}

PaceRegistry::Membership PaceRegistry::join(const std::string& key, int64_t seed_ns) {
    std::lock_guard<std::mutex> lk(mu_);
    Membership m;
    m.key = key;
    m.member = ++next_;
    PaceGroup& g = groups_[key];
    m.late = g.started();
    g.join(m.member, seed_ns);
    return m;
}

void PaceRegistry::leave(Membership* m) {
    if (!m || !m->member) return;
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m->key);
    if (it != groups_.end()) {
        it->second.leave(m->member);
        if (it->second.size() == 0) groups_.erase(it);
    }
    m->member = 0;
}

void PaceRegistry::observe(const Membership& m, int64_t now_ns, int64_t lateness_ns,
                           bool fresh) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m.key);
    if (m.member && it != groups_.end()) it->second.observe(m.member, now_ns, lateness_ns, fresh);
}

void PaceRegistry::raise(const Membership& m, int64_t pace_ns) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m.key);
    if (m.member && it != groups_.end()) it->second.raise(pace_ns);
}

void PaceRegistry::start(const Membership& m) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m.key);
    if (m.member && it != groups_.end()) it->second.start();
}

PaceRegistry::View PaceRegistry::view_locked(const Membership& m) const {
    View v;
    auto it = groups_.find(m.key);
    if (!m.member || it == groups_.end()) return v;
    const PaceGroup& g = it->second;
    v.pace_ns = g.pace();
    v.has_lateness = g.lateness(m.member, &v.lateness_ns);
    v.members = g.size();
    return v;
}

PaceRegistry::View PaceRegistry::view(const Membership& m) const {
    std::lock_guard<std::mutex> lk(mu_);
    return view_locked(m);
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

void GapPlanner::reset() {
    has_ = false;
    horizon_ = 0;
}

}  // namespace mrts
