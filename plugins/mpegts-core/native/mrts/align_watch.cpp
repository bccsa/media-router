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

void PaceGroup::observe(Member m, int64_t now_ns, int64_t lateness_ns) {
    auto it = members_.find(m);
    if (it == members_.end()) return;
    State& s = it->second;
    const int64_t l = std::clamp(lateness_ns, -LATENESS_LIMIT_NS, LATENESS_LIMIT_NS);
    s.window.emplace_back(now_ns, l);
    s.sum += l;
    while (s.window.front().first <= now_ns - MEAN_NS) {
        s.sum -= s.window.front().second;
        s.window.pop_front();
    }
    s.mean = (int64_t)std::llround((double)s.sum / (double)s.window.size());
    s.has_mean = true;
    if (s.window.back().first - s.window.front().first >= MEAN_SPAN_NS) {
        s.need = s.mean;
        s.has_need = true;
        pace_ = std::max(pace_, s.need);
    }
}

void PaceGroup::raise(int64_t pace_ns) { pace_ = std::max(pace_, pace_ns); }

bool PaceGroup::lateness(Member m, int64_t* out) const {
    auto it = members_.find(m);
    if (it == members_.end() || !it->second.has_mean) return false;
    *out = it->second.mean;
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
    groups_[key].join(m.member, seed_ns);
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

void PaceRegistry::observe(const Membership& m, int64_t now_ns, int64_t lateness_ns) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m.key);
    if (m.member && it != groups_.end()) it->second.observe(m.member, now_ns, lateness_ns);
}

void PaceRegistry::raise(const Membership& m, int64_t pace_ns) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = groups_.find(m.key);
    if (m.member && it != groups_.end()) it->second.raise(pace_ns);
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
