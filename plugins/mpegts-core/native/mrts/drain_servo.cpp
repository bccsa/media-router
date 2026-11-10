// mrts::DrainServo: ../../py/drain_servo.py line for line.
#include "drain_servo.h"

#include <algorithm>

namespace mrts {

namespace {

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) { return v < lo ? lo : v > hi ? hi : v; }

// a / b truncated toward 0 (b > 0): C++'s own, as the reference's tdiv.
int64_t tdiv(int64_t a, int64_t b) { return a / b; }

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

}  // namespace

const char* drain_event_name(DrainEvent::Kind k) {
    switch (k) {
        case DrainEvent::Kind::drain_start: return "drain-start";
        case DrainEvent::Kind::drain_done: return "drain-done";
        case DrainEvent::Kind::underrun: return "underrun";
        case DrainEvent::Kind::raise: return "raise";
        case DrainEvent::Kind::outage: return "outage";
    }
    return "";
}

const char* drain_state_name(DrainServo::State s) {
    switch (s) {
        case DrainServo::State::idle: return "idle";
        case DrainServo::State::draining: return "draining";
        case DrainServo::State::rising: return "rising";
        default: return "warm-up";
    }
}

void DrainWindow::clear(int64_t now) {
    open_at_ = now;
    n_ = 1;
    have_[0] = false;
}

void DrainWindow::rotate(int64_t now) {
    if (now - open_at_ < BUCKET_NS) return;
    const int64_t k = (now - open_at_) / BUCKET_NS;
    open_at_ += k * BUCKET_NS;
    if (k >= BUCKETS) {
        n_ = 1;
        have_[0] = false;
        return;
    }
    // The oldest go first: shift what stays to the front, the new buckets empty.
    const int keep = std::min<int>(n_, BUCKETS - (int)k);
    const int drop = n_ - keep;
    for (int i = 0; i < keep; i++) {
        mins_[i] = mins_[i + drop];
        have_[i] = have_[i + drop];
    }
    n_ = keep + (int)k;
    for (int i = keep; i < n_; i++) have_[i] = false;
}

void DrainWindow::add(int64_t now, int64_t v) {
    rotate(now);
    const int i = n_ - 1;
    if (!have_[i] || v < mins_[i]) {
        mins_[i] = v;
        have_[i] = true;
    }
}

bool DrainWindow::min(int64_t now, int64_t* out) {
    rotate(now);
    bool any = false;
    for (int i = 0; i < n_; i++) {
        if (!have_[i]) continue;
        if (!any || mins_[i] < *out) *out = mins_[i];
        any = true;
    }
    return any;
}

DrainServo::DrainServo(bool video, int64_t start_ns, int64_t floor_ns)
    : video_(video), floor_(floor_ns), margin_(start_ns) {}

void DrainServo::touch(int64_t now) {
    if (started_) return;
    started_ = true;
    warm_from_ = last_ = now;
    slack_.clear(now);
    queue_.clear(now);
    m_at_ = now + M_EVERY_NS;
}

int64_t DrainServo::bound() const {
    if (!have_learned_) return floor_;
    return std::min(CEILING_NS, std::max(floor_, learned_ + ABOVE_L_NS));
}

// The two decays in time order, L first at a tie.
void DrainServo::decay(int64_t now) {
    for (;;) {
        const bool l_due = have_learned_ && l_at_ <= now;
        const bool m_due = m_at_ <= now;
        if (l_due && (!m_due || l_at_ <= m_at_)) {
            learned_ = std::max(floor_ - UNDER_FLOOR_NS, learned_ - STEP_NS);
            l_at_ += L_EVERY_NS;
        } else if (m_due) {
            margin_ = std::max(bound(), margin_ - STEP_NS);
            m_at_ += M_EVERY_NS;
        } else {
            return;
        }
    }
}

void DrainServo::raise(int64_t now) {
    const int64_t mu = margin_;
    learned_ = mu;
    have_learned_ = true;
    margin_ = std::min(CEILING_NS, std::max(2 * mu, mu + RAISE_MIN_NS));
    raises_++;
    m_at_ = now + M_EVERY_NS;
    l_at_ = now + L_EVERY_NS;
    events_.push_back(DrainEvent{DrainEvent::Kind::raise, now, margin_});
}

void DrainServo::outage(int64_t now, int64_t length) {
    outages_++;
    have_hold_ = true;
    hold_until_ = now + WINDOW_NS;
    events_.push_back(DrainEvent{DrainEvent::Kind::outage, now, length});
}

void DrainServo::sample(int64_t now, int64_t slack_ns) {
    touch(now);
    slack_.add(now, std::max<int64_t>(slack_ns, 0));
}

void DrainServo::queue_level(int64_t now, int64_t level_ns) {
    touch(now);
    queue_.add(now, std::max<int64_t>(level_ns, 0));
}

void DrainServo::starve(int64_t now, bool on) {
    touch(now);
    if (on && !in_episode_) {
        in_episode_ = true;
        episode_at_ = now;
    } else if (!on && in_episode_) {
        const int64_t length = now - episode_at_;
        in_episode_ = false;
        if (length <= SHORT_NS) {
            have_hold_ = true;
            hold_until_ = now + WINDOW_NS;
            underruns_++;
            events_.push_back(DrainEvent{DrainEvent::Kind::underrun, now, length});
            raise(now);
        } else {
            outage(now, length);
        }
    }
}

void DrainServo::late(int64_t now, int64_t by_ns) {
    touch(now);
    const bool joins = have_late_ && now - late_at_ <= JOIN_NS;
    have_late_ = true;
    late_at_ = now;
    if (by_ns > SHORT_NS) {
        outage(now, by_ns);
        return;
    }
    if (joins) return;
    underruns_++;
    events_.push_back(DrainEvent{DrainEvent::Kind::underrun, now, 0});
    const bool recent = have_positive_ && now - positive_at_ <= WINDOW_NS;
    if (ppb_ > 0 || recent) raise(now);
}

void DrainServo::clear(int64_t now) {
    touch(now);
    slack_.clear(now);
    queue_.clear(now);
    warm_from_ = now;
    ppb_ = 0;
    engaged_ = false;
    if (draining_) events_.push_back(DrainEvent{DrainEvent::Kind::drain_done, now, drained_});
    draining_ = false;
    in_episode_ = false;
    have_late_ = false;
    have_hold_ = false;
}

void DrainServo::set_group(int64_t now, int64_t target_ns) {
    touch(now);
    group_ = target_ns;
    group_at_ = now;
}

int64_t DrainServo::update(int64_t now, int64_t render_ns, bool can) {
    touch(now);
    decay(now);
    const int64_t dt = std::max<int64_t>(now - last_, 0);
    last_ = now;
    if (ppb_ > 0) {
        const __int128 acc = (__int128)ppb_ * dt + drained_rem_;
        drained_ += (int64_t)(acc / SEC);
        drained_rem_ = (int64_t)(acc % SEC);
    }
    int64_t trough = 0, q = 0;
    const bool have = slack_.min(now, &trough);
    if (have && queue_.min(now, &q)) trough += q;
    const bool warm = can && have && now - warm_from_ >= WINDOW_NS && (!have_hold_ || now >= hold_until_);
    trough_ = have ? trough : 0;
    const int64_t excess = warm ? trough - margin_ : 0;
    excess_ = excess;
    const int64_t t_now = render_ns - excess;
    if (ppb_ >= 0) held_ = t_now;
    target_ = ppb_ < 0 ? held_ : t_now;
    const bool grouped = group_ > 0 && now - group_at_ <= GROUP_STALE_NS;
    capped_ = false;
    int64_t cmd;
    if (!warm || in_episode_) {
        cmd = 0;
    } else if (grouped) {
        const int64_t goal = std::min(group_, target_ + RISE_CAP_NS);
        capped_ = group_ > target_ + RISE_CAP_NS;
        const int64_t eg = render_ns - goal;
        cmd = eg >= 0 ? std::max<int64_t>(0, std::min(excess, eg)) : eg;
    } else {
        cmd = std::max<int64_t>(0, excess);
    }
    if (engaged_ && iabs(cmd) <= LETGO_NS) engaged_ = false;
    else if (!engaged_ && iabs(cmd) >= ENGAGE_NS) engaged_ = true;
    // Saturated from 150 ms: a command past 1 s gives the same, and keeps cmd * 1e9 in 64 bits.
    int64_t want = 0;
    if (engaged_) want = clamp64(tdiv(clamp64(cmd, -SEC, SEC) * SEC, TAU_NS), -DMAX_PPB, DMAX_PPB);
    const bool draining = engaged_ && cmd > 0;
    if (draining && !draining_) events_.push_back(DrainEvent{DrainEvent::Kind::drain_start, now, cmd});
    else if (draining_ && !draining) events_.push_back(DrainEvent{DrainEvent::Kind::drain_done, now, drained_});
    draining_ = draining;
    if (brk_) {
        ppb_ = want;
        brk_ = false;
    } else {
        const int64_t step = dt / SLEW_DEN;
        ppb_ = clamp64(want, ppb_ - step, ppb_ + step);
    }
    if (ppb_ > 0) {
        have_positive_ = true;
        positive_at_ = now;
    }
    state_ = !warm ? State::warm_up : ppb_ > 0 ? State::draining : ppb_ < 0 ? State::rising : State::idle;
    return ppb_;
}

std::vector<DrainEvent> DrainServo::take_events() {
    std::vector<DrainEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
